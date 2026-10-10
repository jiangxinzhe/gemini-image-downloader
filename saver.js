// 批量保存页（独立标签页）：弹窗只负责勾选，这里负责选文件夹、抓图、写盘
// 之所以用标签页而不是弹窗：弹窗是焦点敏感的特殊窗口，系统文件对话框一抢焦点
// 弹窗就可能被关闭，导致整个保存流程中断
(() => {
  'use strict';
  const G = globalThis.GIDL;
  const $ = (id) => document.getElementById(id);

  const els = {
    jobInfo: $('jobInfo'),
    startCard: $('startCard'),
    startDesc: $('startDesc'),
    btnStart: $('btnStart'),
    btnForget: $('btnForget'),
    startHint: $('startHint'),
    progCard: $('progCard'),
    bar: $('barFill'),
    progText: $('progText'),
    status: $('status'),
    doneCard: $('doneCard'),
    doneText: $('doneText'),
    btnClose: $('btnClose'),
    btnDownloads: $('btnDownloads'),
    btnRetry: $('btnRetry'),
    emptyCard: $('emptyCard')
  };

  init();

  async function init() {
    els.btnClose.addEventListener('click', () => window.close());
    els.btnDownloads.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://downloads' }));
    els.btnForget.addEventListener('click', async () => {
      await GIDLS.idbSet('dir', null);
      els.btnForget.hidden = true;
      els.startHint.textContent = '已清除记住的文件夹，点击按钮重新选择。';
    });

    const { saveJob: job } = await chrome.storage.session.get('saveJob');
    if (!job || !Array.isArray(job.items)) {
      els.emptyCard.hidden = false;
      els.jobInfo.textContent = '没有任务';
      return;
    }
    if (job.runner === 'saver') {
      // 有其他保存页标签页存活 → 任务可能仍在执行，禁止双跑（防止两个 taken 集合撞名）。
      // 标签页已关闭则视为孤儿任务，安全接管续存。
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL('saver.html') }).catch(() => []);
      let cur;
      try { cur = await chrome.tabs.getCurrent(); } catch (e) { cur = undefined; }
      const otherAlive = (tabs || []).some((t) => !cur || t.id !== cur.id);
      if (otherAlive) {
        els.emptyCard.hidden = false;
        els.jobInfo.textContent = '任务正在保存页进行中，请勿重复打开。';
        return;
      }
    }
    // runner === 'popup' 的任务视为孤儿：弹窗是单实例窗口，本页能打开即旧弹窗已关闭
    if (job.items.length === 0) {
      els.emptyCard.hidden = false;
      els.jobInfo.textContent = `${job.title || 'Gemini 对话'} · 上次任务已全部处理完。`;
      return;
    }
    // 占位：标记任务已被本页接手（跑批期间 runSave 会持续回写剩余项）
    await chrome.storage.session.set({
      saveJob: { items: job.items, title: job.title || '', mode: job.mode, folder: job.folder, runner: 'saver' }
    }).catch(() => {});

    els.jobInfo.textContent = `${job.title || 'Gemini 对话'} · 共 ${job.items.length} 张图片`;

    if (job.mode === 'downloads') {
      // 浏览器下载模式：直接走后台队列
      startBrowserDownloads(job);
      return;
    }

    // 选文件夹直存模式：已记住且仍授权、目录仍存在的文件夹 → 免交互直接开始
    // （getGrantedDir 带 keys() 存在性探测：目录被删/移时引导重新选择，而不是逐张失败）
    const dir = await GIDLS.getGrantedDir();

    if (dir) {
      // 已记住且授权的文件夹：免交互直接开始
      runSave(job, dir);
    } else {
      els.startCard.hidden = false;
      els.startDesc.textContent = `点击下方按钮选择保存位置，本批 ${job.items.length} 张图片将全部直接写入该文件夹（只需选择一次）。`;
      els.btnStart.addEventListener('click', async () => {
        const picked = await pickDir();
        if (picked) runSave(job, picked);
      }, { once: true });
    }
  }


  async function pickDir() {
    let dir = await GIDLS.getGrantedDir().catch(() => null);
    if (dir) {
      try {
        let perm = await dir.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await dir.requestPermission({ mode: 'readwrite' }); // 按钮点击提供用户手势
        if (perm === 'granted') return dir;
      } catch (e) { /* 句柄失效，重新选择 */ }
    }
    try {
      dir = await window.showDirectoryPicker({
        id: 'gidl-images',
        mode: 'readwrite',
        startIn: 'downloads'
      });
      await GIDLS.idbSet('dir', dir);
      return dir;
    } catch (e) {
      showStatus('已取消选择文件夹。可关闭此页后重新发起下载。');
      return null;
    }
  }

  function showProgress(done, total) {
    els.progCard.hidden = false;
    els.startCard.hidden = true;
    const pct = total ? Math.round((done / total) * 100) : 0;
    els.bar.style.width = pct + '%';
    els.progText.textContent = `${done}/${total}`;
  }

  function showStatus(text) {
    els.progCard.hidden = false;
    els.status.textContent = text;
  }

  function showDone(text, showDownloadsLink, failedCount, retryJob) {
    els.progCard.hidden = true;
    els.doneCard.hidden = false;
    els.doneText.textContent = text;
    els.btnDownloads.hidden = !showDownloadsLink;
    els.btnRetry.hidden = !(failedCount > 0 && retryJob);
    if (failedCount > 0 && retryJob) {
      els.btnRetry.addEventListener('click', () => {
        els.doneCard.hidden = true;
        els.btnRetry.hidden = true;
        retryJob();
      }, { once: true });
    }
  }

  async function runSave(job, dir) {
    showProgress(0, job.items.length);
    showStatus('开始保存…');

    // 剩余项实时回写（runner 标记防双跑）：页面中途关闭后，下次打开 saver 仍能续存剩余项
    const persistJob = (rest) => {
      const p = chrome.storage.session.set({ saveJob: { items: rest, title: job.title || '', mode: 'picker', runner: 'saver' } });
      if (p && p.catch) p.catch(() => {});
    };
    let remaining = job.items.slice();
    const taken = new Set();
    let done = 0;
    let viaBrowser = 0;
    let origCount = 0;
    let failed = 0;
    let firstError = '';
    let firstAttempts = null;
    const failedItems = [];
    let idx = 0;
    const CONCURRENCY = 3;

    const workers = Array.from({ length: Math.min(CONCURRENCY, job.items.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= job.items.length) return;
        const it = job.items[i];
        try {
          const r = await GIDLS.saveToDir(dir, it, taken);
          remaining = remaining.filter((x) => x !== it);
          if (!r || r.via === 'browser') viaBrowser++;
          else {
            done++;
            if (r.orig) origCount++;
          }
        } catch (e) {
          failed++;
          failedItems.push(it);
          if (!firstError) firstError = String((e && e.message) || e);
          if (e && e.name === 'NotFoundError') {
            await GIDLS.idbSet('dir', null).catch(() => {});
          }
        }
        persistJob(remaining);
        showProgress(done + viaBrowser + failed, job.items.length);
        if (failed) showStatus(`已保存 ${done + viaBrowser}，失败 ${failed}…`);
      }
    });
    await Promise.all(workers);

    // 跑完全清；有失败项时 saver 自己有「重试失败项」按钮，无需保留任务
    await chrome.storage.session.remove('saveJob').catch(() => {});

    const parts = [];
    if (done) parts.push(`✔ 直存 ${done} 张到「${dir.name || '所选文件夹'}」（原图 ${origCount} · 页面图 ${done - origCount}）`);
    if (viaBrowser) parts.push(`${viaBrowser} 张改走浏览器下载，位于「下载/${dir.name}」文件夹`);
    if (failed) parts.push(`✘ 失败 ${failed} 张`);
    const chain = firstAttempts && firstAttempts.length
      ? firstAttempts.map((x) => `${x.layer}:${x.error}`).join(' → ') : '';
    const summary = parts.join('\n')
      + (chain && done > 0 && origCount === 0 ? `\n⚠ 原因链：${chain}` : '')
      + (firstError ? `\n\n首个错误：${firstError}` : '');

    showDone(
      failed ? `保存完成（部分失败）\n${summary}` : `保存完成！\n${summary}`,
      viaBrowser > 0,
      failed,
      failedItems.length ? () => runSave({ items: failedItems, title: job.title }, dir) : null
    );
  }





  // 浏览器下载模式：交给后台队列，本页显示进度
  function startBrowserDownloads(job) {
    els.startCard.hidden = true;
    showProgress(0, job.items.length);
    showStatus('已交给浏览器后台下载…');
    chrome.runtime.sendMessage({ type: 'GIDL_DOWNLOAD', items: job.items, folder: job.folder || 'Gemini图片' }, (res) => {
      if (!res || !res.ok) {
        showDone(`下载任务启动失败：${(res && res.error) || '未知错误'}`, false, 0, null);
        return;
      }
    });
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'GIDL_DL_PROGRESS') {
        showProgress(msg.settled || 0, msg.total || 0);
        showStatus(`已下载 ${Math.max(0, (msg.settled || 0) - (msg.failed || 0))}，失败 ${msg.failed || 0}`);
      } else if (msg.type === 'GIDL_DL_DONE') {
        showDone(
          msg.failed
            ? `下载完成：成功 ${msg.total - msg.failed}，失败 ${msg.failed}。已保存到「下载/${job.folder || 'Gemini图片'}」`
            : `下载完成，共 ${msg.total} 张 ✓ 已保存到「下载/${job.folder || 'Gemini图片'}」`,
          true,
          0,
          null
        );
      }
    });
  }
})();
