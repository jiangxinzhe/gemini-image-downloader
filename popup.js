// 弹窗逻辑：扫描当前对话页 → 勾选 → 直接在弹窗内完成保存
// 选文件夹直存：文件夹记住后零对话框；首次弹一次系统目录框；
// 若弹窗中途被系统关闭（弹窗是焦点敏感窗口），任务保留在 storage.session，
// 下次打开弹窗可一键续存（走 saver.html 保存页）
(() => {
  'use strict';
  const G = globalThis.GIDL;
  const $ = (id) => document.getElementById(id);

  const els = {
    state: $('pageState'),
    grid: $('grid'),
    empty: $('empty'),
    count: $('count'),
    dl: $('btnDownload'),
    deep: $('btnDeep'),
    rescan: $('btnRescan'),
    mode: $('saveMode'),
    folderLabel: $('folderLabel'),
    folder: $('folder'),
    prog: $('prog'),
    bar: $('barFill'),
    progText: $('progText'),
    status: $('statusText'),
    settingsHint: $('settingsHint'),
    changeDir: $('changeDir'),
    resume: $('resume'),
    pickInPage: $('pickInPage'),
    selAll: $('btnSelectAll'),
    selNone: $('btnSelectNone')
  };

  const KIND_MARK = { generated: '✦', uploaded: '↑', other: '•' };
  const KIND_NAME = { generated: '生成图', uploaded: '上传图', other: '图片' };

  let tab = null;
  let items = [];
  let selected = new Set();
  let title = '';
  let scanning = false;
  let dlBusy = false;
  let hasStoredDir = false;

  // 缩略图状态：扫描文案 + 加载失败计数（三级降级后仍失败的）
  let scanStateText = '';
  let thumbFailedCount = 0;
  const thumbRequested = new Set();
  let thumbPending = [];
  let thumbTimer = null;

  init();

  async function init() {
    const cfg = await chrome.storage.sync.get({
      folder: 'Gemini图片',
      saveMode: 'picker'
    });
    els.folder.value = cfg.folder || 'Gemini图片';
    els.mode.value = cfg.saveMode === 'downloads' ? 'downloads' : 'picker';

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs && tabs[0];
    } catch (e) {
      tab = null;
    }

    const u = (tab && tab.url) || '';
    if (u && !/^https:\/\/gemini\.google(\.com|workspace\.com)\//.test(u)) {
      els.state.textContent = '请先打开 gemini.google.com 的对话页面';
      els.empty.hidden = false;
      return;
    }

    bindEvents();
    restoreDlState();
    await refreshStoredDir();
    showResumeEntry();
    scan(false);
    chrome.runtime.onMessage.addListener(onMessage);
  }

  function bindEvents() {
    els.rescan.addEventListener('click', () => scan(false));
    els.deep.addEventListener('click', () => scan(true));
    els.mode.addEventListener('change', async () => {
      await chrome.storage.sync.set({ saveMode: els.mode.value });
      updateModeUi();
    });
    els.folder.addEventListener('change', async () => {
      await chrome.storage.sync.set({ folder: els.folder.value.trim() || 'Gemini图片' });
    });
    els.settingsHint.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://settings/downloads' });
    });
    els.changeDir.addEventListener('click', async () => {
      await GIDLS.idbSet('dir', null);
      hasStoredDir = false;
      updateModeUi();
      els.status.textContent = '已清除保存文件夹，下次下载将重新选择';
    });
    els.pickInPage.addEventListener('click', async () => {
      if (!tab || !items.length) return;
      try {
        await sendToTab(tab.id, {
          type: 'GIDL_PANEL_SHOW',
          items: items.map((i) => ({ id: i.id, src: i.src, origUrl: i.origUrl, kind: i.kind, perfUrl: i.perfUrl || '', w: i.w || 0, h: i.h || 0 })),
          selectedIds: [...selected],
          title
        });
        window.close();
      } catch (e) {
        els.status.textContent = '无法打开页面内选图面板：' + e.message;
      }
    });
    els.selAll.addEventListener('click', () => {
      selected = new Set(items.map((i) => i.id));
      syncSelection();
    });
    els.selNone.addEventListener('click', () => {
      selected.clear();
      syncSelection();
    });
    els.dl.addEventListener('click', startDownload);
  }

  // —— 保存方式 ——
  async function updateModeUi() {
    const picker = els.mode.value === 'picker';
    els.folderLabel.hidden = picker;
    els.settingsHint.hidden = picker;
    els.changeDir.hidden = !(picker && hasStoredDir);
    els.mode.disabled = dlBusy || scanning;
  }

  async function refreshStoredDir() {
    const dir = await GIDLS.getGrantedDir();
    hasStoredDir = !!dir;
    if (dir) els.changeDir.title = `当前保存到「${dir.name}」，点击后下次重新选择`;
    updateModeUi();
  }

  // IndexedDB / 文件夹句柄 / 保存管线均在 save-lib.js（GIDLS）

  // 上次未完成的任务（弹窗被系统关闭等），提供一键续存
  async function showResumeEntry() {
    try {
      const { saveJob } = await chrome.storage.session.get('saveJob');
      if (saveJob && Array.isArray(saveJob.items) && saveJob.items.length) {
        els.resume.hidden = false;
        els.resume.textContent = `上次有 ${saveJob.items.length} 张未保存完，点此继续`;
        els.resume.addEventListener('click', () => {
          chrome.tabs.create({ url: chrome.runtime.getURL('saver.html') });
          window.close();
        }, { once: true });
      }
    } catch (e) { /* ignore */ }
  }

  // —— 扫描 ——
  function setScanState(t) {
    scanStateText = t;
    updateStateText();
  }
  function updateStateText() {
    els.state.textContent = scanStateText +
      (thumbFailedCount ? `；⚠ ${thumbFailedCount} 张缩略图未能加载（卡片显示序号，不影响下载）` : '');
  }

  async function scan(deep, isAutoRetry) {
    if (scanning || !tab) return;
    scanning = true;
    setBusy(true);
    thumbFailedCount = 0;
    thumbRequested.clear();
    thumbPending = [];
    let scanOk = true;
    setScanState(deep ? '正在滚动加载全部图片…' : '正在扫描…');
    try {
      const res = await sendToTab(tab.id, { type: 'GIDL_COLLECT', deep });
      if (!res || !res.ok) throw new Error((res && res.error) || '无法连接页面，请刷新 Gemini 页面后重试');
      items = res.images || [];
      title = res.title || '';
      selected = new Set(items.filter((i) => i.kind === 'generated').map((i) => i.id));
      const kinds = { generated: 0, uploaded: 0, other: 0 };
      items.forEach((i) => { kinds[i.kind] = (kinds[i.kind] || 0) + 1; });
      const withOrig = items.filter((i) => i.serverUrl).length;
      setScanState(items.length
        ? `共 ${items.length} 张：生成 ${kinds.generated} · 上传 ${kinds.uploaded} · 其他 ${kinds.other} · 原始地址 ${withOrig} · 网络痕迹 ${res.debug ? res.debug.perfCandidates : '?'}`
        : `未发现图片（页面 img ${res.debug ? res.debug.totalImgs : '?'} 个 / Google 图 ${res.debug ? res.debug.ugcImgs : '?'} 个 / 模型区 ${res.debug ? res.debug.modelImgs : '?'} 个）`);
      render();

      // 应用「页面内选图」同步过来的勾选结果
      try {
        const { panelSelection } = await chrome.storage.session.get('panelSelection');
        if (Array.isArray(panelSelection) && panelSelection.length) {
          const s = new Set(panelSelection);
          const picked = items.filter((i) => s.has(i.id)).map((i) => i.id);
          if (picked.length) {
            selected = new Set(picked);
            syncSelection();
            setScanState(`${scanStateText}；已同步页面中选择的 ${picked.length} 张`);
          }
          await chrome.storage.session.remove('panelSelection').catch(() => {});
        }
      } catch (e) { /* ignore */ }
    } catch (e) {
      scanOk = false;
      items = [];
      selected.clear();
      render();
      setScanState('扫描失败：' + e.message);
    } finally {
      scanning = false;
      setBusy(false);
    }
    // 当前视野一无所获时，自动深度扫描整个对话（只自动补一次）
    if (scanOk && !items.length && !deep && !isAutoRetry) {
      setScanState('当前视野未发现图片，正在自动深度扫描整个对话…');
      await scan(true, true);
    }
  }

  function setBusy(b) {
    els.rescan.disabled = b;
    els.deep.disabled = b;
    els.mode.disabled = b || dlBusy;
  }

  async function sendToTab(tabId, msg) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e) {
      // 内容脚本未注入（扩展刚安装/更新）时注入后重试
      await chrome.scripting.executeScript({ target: { tabId }, files: ['lib.js', 'content.js'] });
      return await chrome.tabs.sendMessage(tabId, msg);
    }
  }

  // —— 缩略图列表 ——
  function render() {
    els.grid.textContent = '';
    const frag = document.createDocumentFragment();
    items.forEach((it, k) => {
      const card = document.createElement('div');
      card.className = 'card' + (selected.has(it.id) ? ' sel' : '');
      card.dataset.id = it.id;
      card.dataset.idx = String(k + 1); // 缩略图加载失败时显示序号占位

      const img = document.createElement('img');
      // 弹窗里不要用 loading=lazy：特殊小窗口中懒加载可能永不触发，导致缩略图空白
      img.decoding = 'async';
      // 直接用页面上已成功加载的缩略图地址，避免尺寸参数改动导致 CDN 拒绝
      img.src = it.src;
      img.title = `${KIND_NAME[it.kind] || '图片'} ${k + 1}${it.w ? ` · ${it.w}×${it.h}` : ''}${it.alt ? `\n${it.alt}` : ''}`;
      img.addEventListener('load', () => card.classList.remove('broken'));
      img.onerror = () => {
        card.classList.add('broken');
        queueThumbFallback(it);
      };
      card.appendChild(img);

      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = KIND_MARK[it.kind] || '•';
      card.appendChild(mark);

      const open = document.createElement('a');
      open.className = 'open';
      open.textContent = '↗';
      open.title = '新标签页打开原图';
      open.href = it.origUrl;
      open.target = '_blank';
      open.rel = 'noreferrer noopener';
      card.appendChild(open);

      card.addEventListener('click', (ev) => {
        if (ev.target.closest('a')) return;
        if (selected.has(it.id)) selected.delete(it.id);
        else selected.add(it.id);
        card.classList.toggle('sel', selected.has(it.id));
        updateFooter();
      });
      frag.appendChild(card);
    });
    els.grid.appendChild(frag);
    els.empty.hidden = items.length > 0;
    updateFooter();

    // 兜底：个别环境下 img.onerror 不触发，3 秒后检查仍未加载出来的卡片
    setTimeout(() => {
      for (const it of items) {
        const card = els.grid.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
        if (!card || card.classList.contains('broken')) continue;
        const img = card.querySelector('img');
        if (!img || !img.complete || img.naturalWidth === 0) {
          card.classList.add('broken');
          queueThumbFallback(it);
        }
      }
    }, 3000);
  }

  // 缩略图加载失败 → 三级降级：
  // 1) 后台 Service Worker 抓取  2) 内容脚本在 Gemini 页面上下文抓取（同来源/Cookie/Referer）
  // 仍失败的卡片显示序号占位（不影响勾选和下载）
  function queueThumbFallback(item) {
    if (thumbRequested.has(item.id)) return;
    thumbRequested.add(item.id);
    thumbPending.push(item);
    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      const batch = thumbPending;
      thumbPending = [];
      if (batch.length) runThumbFallback(batch);
    }, 250);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


  async function runThumbFallback(batch) {
    // 1) 后台抓取
    try {
      await chrome.runtime.sendMessage({
        type: 'GIDL_THUMBS',
        items: batch.map((i) => ({ id: i.id, url: i.src }))
      });
    } catch (e) { /* 后台不可用 */ }
    await sleep(1000);

    let rest = batch.filter((it) => isCardBroken(it.id));
    if (!rest.length) return;

    // 2) 页面上下文抓取
    if (tab) {
      try {
        await sendToTab(tab.id, { type: 'GIDL_PAGE_THUMBS', items: rest.map((i) => ({ id: i.id, url: i.src })) });
      } catch (e) { /* ignore */ }
      await sleep(2500);
      rest = rest.filter((it) => isCardBroken(it.id));
    }

    if (rest.length) {
      thumbFailedCount += rest.length;
      els.pickInPage.hidden = false;
      updateStateText();
    }
  }

  function isCardBroken(id) {
    const card = els.grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
    return !card || card.classList.contains('broken');
  }

  function syncSelection() {
    for (const el of els.grid.children) {
      el.classList.toggle('sel', selected.has(el.dataset.id));
    }
    updateFooter();
  }

  function updateFooter() {
    els.count.textContent = items.length ? `已选 ${selected.size} / ${items.length}` : '';
    els.dl.disabled = dlBusy || selected.size === 0;
    els.dl.textContent = dlBusy ? '处理中…' : `下载选中（${selected.size}）`;
    els.mode.disabled = dlBusy || scanning;
  }

  // —— 下载入口 ——
  async function startDownload() {
    const chosen = items.filter((i) => selected.has(i.id));
    if (!chosen.length || dlBusy) return;
    await chrome.storage.sync.set({
      folder: els.folder.value.trim() || 'Gemini图片',
      saveMode: els.mode.value
    });

    const base = G.sanitizeName(title || 'gemini', 40);
    const digits = String(chosen.length).length;
    const payload = chosen.map((it, k) => ({
      id: it.id,
      url: it.origUrl,
      blobUrl: /^(blob:|data:image\/)/i.test(it.src || '') ? it.src : '',
      perfUrl: it.perfUrl || '',
      w: it.w || 0,
      h: it.h || 0,
      name: `${base}_${String(k + 1).padStart(digits, '0')}`
    }));

    if (els.mode.value === 'picker') {
      await startPickerSave(payload);
    } else {
      startBrowserDownloads(payload);
    }
  }

  // —— 选文件夹直存：全部在弹窗内完成 ——
  async function startPickerSave(payload) {
    dlBusy = true;
    updateFooter();
    showProgress(0, payload.length);
    els.status.textContent = '准备保存…';

    // 先登记任务：若弹窗中途被系统关闭，下次打开可一键续存
    await chrome.storage.session.set({ saveJob: { items: payload, title, mode: 'picker', runner: 'popup' } }).catch(() => {});

    let dir = await GIDLS.getGrantedDir();
    if (!dir) {
      els.status.textContent = '首次使用：请在弹出的对话框中选择保存文件夹（只需一次）…';
      try {
        dir = await window.showDirectoryPicker({
          id: 'gidl-images',
          mode: 'readwrite',
          startIn: 'downloads'
        });
        await GIDLS.idbSet('dir', dir);
        hasStoredDir = true;
        updateModeUi();
      } catch (e) {
        await chrome.storage.session.remove('saveJob').catch(() => {});
        dlBusy = false;
        updateFooter();
        hideProgress();
        els.status.textContent = (e && e.name === 'AbortError')
          ? '已取消。可再次点击「下载选中」并选择文件夹。'
          : '选择文件夹失败：' + String((e && e.message) || e);
        return;
      }
    }
    await runSaveLoop(dir, payload);
  }

  async function runSaveLoop(dir, payload) {
    // saveJob 只记剩余未完成项：每张完结即回写，弹窗中途被关闭后续存只跑剩余的；
    // runner 标记供 saver 判断任务归属（弹窗为单实例，标记残留即意味着弹窗已死、任务成孤儿）
    let remaining = payload.slice();
    const persistJob = () => {
      const p = chrome.storage.session.set({ saveJob: { items: remaining, title, mode: 'picker', runner: 'popup' } });
      if (p && p.catch) p.catch(() => {});
    };
    const taken = new Set();
    let done = 0;
    let viaBrowser = 0;
    let origCount = 0;
    let failed = 0;
    let firstError = '';
    let firstAttempts = null;
    let idx = 0;
    const CONCURRENCY = 3;

    els.status.textContent = dir.name
      ? `正在保存到「${dir.name}」…（请保持本弹窗打开）`
      : '正在保存…（请保持本弹窗打开）';

    const workers = Array.from({ length: Math.min(CONCURRENCY, payload.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= payload.length) return;
        const it = payload[i];
        try {
          const r = await GIDLS.saveToDir(dir, it, taken);
          remaining = remaining.filter((x) => x !== it);
          if (!r || r.via === 'browser') viaBrowser++;
          else {
            done++;
            if (r.orig) origCount++;
            if (!firstAttempts && r.attempts) firstAttempts = r.attempts;
          }
        } catch (e) {
          failed++;
          if (!firstError) firstError = String((e && e.message) || e);
          if (e && (e.name === 'NotFoundError' || /保存位置已失效/.test(firstError))) {
            hasStoredDir = false;
            await GIDLS.idbSet('dir', null).catch(() => {});
            updateModeUi();
          }
        }
        persistJob();
        showProgress(done + viaBrowser + failed, payload.length);
        if (failed) els.status.textContent = `已保存 ${done + viaBrowser}，失败 ${failed}…`;
      }
    });
    await Promise.all(workers);

    // 正常跑完（含失败项，弹窗无重试入口）：清除任务；中断场景由上面的增量回写兜住
    await chrome.storage.session.remove('saveJob').catch(() => {});
    dlBusy = false;
    updateFooter();
    hideProgress();

    const parts = [];
    if (done) parts.push(`✔ 已保存 ${done} 张到「${dir.name || '所选文件夹'}」（原图 ${origCount} · 页面图 ${done - origCount}）`);
    if (viaBrowser) parts.push(`${viaBrowser} 张改走浏览器下载（位于「下载/${dir.name}」）`);
    if (failed) parts.push(`✘ 失败 ${failed} 张`);
    if (done > 0 && origCount === 0 && firstAttempts) {
      const chain = firstAttempts.map((x) => `${x.layer}:${x.error}`).join(' → ');
      if (chain) parts.push(`⚠ 原因链：${chain}`);
    }
    els.status.textContent = parts.join('，') + (firstError ? `。首个错误：${firstError}` : '');
  }



  function startBrowserDownloads(payload) {
    dlBusy = true;
    updateFooter();
    showProgress(0, payload.length);
    els.status.textContent = '开始下载…';
    chrome.runtime.sendMessage(
      { type: 'GIDL_DOWNLOAD', items: payload, folder: els.folder.value.trim() || 'Gemini图片' },
      (res) => {
        if (!res || !res.ok) {
          dlBusy = false;
          updateFooter();
          hideProgress();
          els.status.textContent = (res && res.error) || '下载任务启动失败';
        }
      }
    );
  }

  function onMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'GIDL_DL_PROGRESS') {
      showProgress(msg.settled || 0, msg.total || 0);
      if (msg.failed) {
        els.status.textContent = `已下载 ${Math.max(0, (msg.settled || 0) - (msg.failed || 0))}，失败 ${msg.failed}`;
      }
    } else if (msg.type === 'GIDL_DL_DONE') {
      dlBusy = false;
      updateFooter();
      hideProgress();
      els.status.textContent = msg.failed
        ? `完成：成功 ${msg.total - msg.failed}，失败 ${msg.failed}`
        : `完成，已下载 ${msg.total} 张图片 ✓`;
    } else if (msg.type === 'GIDL_SCAN_PROGRESS') {
      setScanState(`正在滚动加载全部图片… ${Math.round((msg.pct || 0) * 100)}%`);
    } else if (msg.type === 'GIDL_PAGE_THUMB' && msg.id) {
      // 内容脚本在页面上下文抓到的缩略图
      if (msg.dataUrl) fillThumb(msg.id, msg.dataUrl);
    } else if (msg.type === 'GIDL_PANEL_DONE' && Array.isArray(msg.ids)) {
      // 页面内选图面板确认：应用勾选结果
      const s = new Set(msg.ids);
      const picked = items.filter((i) => s.has(i.id)).map((i) => i.id);
      if (picked.length) {
        selected = new Set(picked);
        syncSelection();
        els.pickInPage.hidden = false;
        els.status.textContent = `已在页面中选择 ${picked.length} 张，点「下载选中」完成下载`;
      }
    } else if (msg.type === 'GIDL_THUMB' && msg.id && msg.dataUrl) {
      fillThumb(msg.id, msg.dataUrl);
    }
  }

  function fillThumb(id, dataUrl) {
    const card = els.grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    const img = card.querySelector('img');
    img.onerror = null;
    img.src = dataUrl;
    card.classList.remove('broken');
  }

  // 弹窗重新打开时，恢复后台正在进行的下载状态
  async function restoreDlState() {
    let st;
    try {
      st = await chrome.runtime.sendMessage({ type: 'GIDL_STATE' });
    } catch (e) {
      return;
    }
    const s = st && st.state;
    if (!s || !s.total) return;
    if (s.running) {
      dlBusy = true;
      updateFooter();
      showProgress(s.settled, s.total);
      els.status.textContent = '正在下载…';
    } else {
      const ok = Math.max(0, s.settled - s.failed.length);
      els.status.textContent = `上次下载：成功 ${ok}，失败 ${s.failed.length}`;
    }
  }

  function showProgress(settled, total) {
    els.prog.hidden = false;
    const pct = total ? Math.round((settled / total) * 100) : 0;
    els.bar.style.width = pct + '%';
    els.progText.textContent = `${settled}/${total}`;
  }

  function hideProgress() {
    els.prog.hidden = true;
  }
})();
