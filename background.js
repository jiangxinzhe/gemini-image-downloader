// 后台 Service Worker：批量下载队列、右键菜单、角标进度
'use strict';
importScripts('lib.js');

const G = globalThis.GIDL;

// 允许内容脚本读写 storage.session（页面内选图结果经此传递）
try {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch (e) { /* ignore */ }

const state = {
  running: false,
  total: 0,
  settled: 0,
  failed: [] // { url, filename, error }
};

const GEMINI_MATCHES = [
  'https://gemini.google.com/*',
  'https://gemini.googleworkspace.com/*'
];

// downloadId -> { url, filename, retries }
const inflight = new Map();

// SW 冷启动恢复：上一批进行中 SW 被回收时，从 session 读回状态与未完结队列。
// 恢复的 inflight 拿不到后续 onChanged 事件，由 finishRecovered() 兜底结算
async function restoreState() {
  try {
    const { dl } = await chrome.storage.session.get('dl');
    if (!dl || !dl.running) return;
    state.running = true;
    state.total = dl.total;
    state.settled = dl.settled;
    state.failed = (dl.failed || []).slice();
    (dl.pending || []).forEach((p) => inflight.set(p.id, p));
    setBadge();
    if (inflight.size) setTimeout(finishRecovered, 30000); // 30s 无事件即视为已死
  } catch (e) { /* ignore */ }
}

async function finishRecovered() {
  if (!state.running) return;
  if (inflight.size) {
    for (const rec of inflight.values()) {
      state.settled++;
      state.failed.push({ url: rec.url, filename: rec.filename, error: '浏览器重启/SW 回收导致中断' });
    }
    inflight.clear();
  }
  // inflight 已被 onChanged 清空（恢复的下载其实都完成了）也走这里收尾，
  // 否则 running 永远为 true，新批次会被"已有任务进行中"拒绝
  state.running = false;
  setBadge();
  await saveState();
  broadcast({ type: 'GIDL_DL_DONE', total: state.total, failed: state.failed.length });
}

async function saveState() {
  try {
    await chrome.storage.session.set({
      dl: {
        running: state.running,
        total: state.total,
        settled: state.settled,
        failed: state.failed.slice(-20),
        pending: Array.from(inflight.values()) // SW 回收后冷启动恢复队列
      }
    });
  } catch (e) { /* ignore */ }
}

function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* 无接收方（弹窗已关闭） */ }
}

function setBadge() {
  const remain = Math.max(0, state.total - state.settled);
  const text = state.running && remain > 0 ? String(remain) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });
}

// HEAD 请求探测文件扩展名（失败则返回空串，后续用 .png 兜底）
async function fetchExt(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const resp = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return '';
    return G.extFromMime(resp.headers.get('content-type'));
  } catch (e) {
    return '';
  }
}

// 经 Gemini 页面内容脚本把 blob: 地址转成 dataUrl（downloads 无法访问页面源 blob）
async function blobViaTab(url) {
  try {
    const tabs = await chrome.tabs.query({ url: GEMINI_MATCHES });
    if (!tabs || !tabs.length) return { ok: false, error: '无 Gemini 标签页' };
    return await chrome.tabs.sendMessage(tabs[0].id, { type: 'GIDL_BLOB_DATA', url });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function downloadOne(item, folder) {
  // blob: 地址属于 Gemini 页面源，downloads 无法访问；先经页面取字节转 dataUrl 再下载
  let dlUrl = item.url;
  if (/^blob:/i.test(dlUrl)) {
    const res = await blobViaTab(dlUrl);
    if (res && res.ok && res.dataUrl) {
      dlUrl = res.dataUrl;
    } else {
      state.settled++;
      state.failed.push({
        url: item.url,
        filename: '',
        error: '页面图取字节失败：' + ((res && res.error) || '无法访问 Gemini 页面')
      });
      setBadge();
      broadcast({ type: 'GIDL_DL_PROGRESS', total: state.total, settled: state.settled, failed: state.failed.length });
      await saveState();
      return;
    }
  }
  const ext = await fetchExt(dlUrl);
  const name = `${item.name || 'gemini_image'}${ext || '.png'}`;
  const path = G.makePath(folder, name);
  try {
    const dlId = await chrome.downloads.download({
      url: dlUrl,
      filename: path,
      conflictAction: 'uniquify'
    });
    inflight.set(dlId, { url: item.url, filename: path, retries: 0 });
    await saveState();
  } catch (e) {
    state.settled++;
    state.failed.push({ url: item.url, filename: path, error: String((e && e.message) || e) });
    setBadge();
    broadcast({ type: 'GIDL_DL_PROGRESS', total: state.total, settled: state.settled, failed: state.failed.length });
    await saveState();
  }
}

async function startBatch(items, folder) {
  state.running = true;
  state.total = items.length;
  state.settled = 0;
  state.failed = [];
  inflight.clear();
  setBadge();
  await saveState();
  broadcast({ type: 'GIDL_DL_PROGRESS', total: state.total, settled: 0, failed: 0 });

  const CONCURRENCY = 4;
  let idx = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      await downloadOne(items[i], folder);
    }
  });
  await Promise.all(workers);

  // 完成判定：等 onChanged 事件把 inflight 清空（真实完成），带总超时兜底。
  // 不再用固定 800ms——大图慢网下会提前广播"完成"，后续中断丢统计
  const deadline = Date.now() + 10 * 60 * 1000;
  while (state.running && inflight.size && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (inflight.size) await finishRecovered(); // 超时兜底结算

  if (!state.running) return; // 已被 finishRecovered 等路径结算过
  state.running = false;
  setBadge();
  await saveState();
  broadcast({ type: 'GIDL_DL_DONE', total: state.total, failed: state.failed.length });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const rec = inflight.get(delta.id);
  if (!rec) return;
  const st = delta.state && delta.state.current;
  if (st !== 'complete' && st !== 'interrupted') return;

  // '=d' 下载失败时，退回 '=s0' 原尺寸内联地址重试一次
  if (st === 'interrupted' && rec.retries < 1) {
    rec.retries++;
    const alt = G.withSizeParam(rec.url, 's0');
    if (alt && alt !== rec.url) {
      try {
        const nid = await chrome.downloads.download({
          url: alt,
          filename: rec.filename,
          conflictAction: 'uniquify'
        });
        inflight.set(nid, { ...rec });
        inflight.delete(delta.id);
        await saveState();
        return;
      } catch (e) { /* 落入失败统计 */ }
    }
  }

  inflight.delete(delta.id);
  state.settled++;
  if (st === 'interrupted') {
    state.failed.push({
      url: rec.url,
      filename: rec.filename,
      error: (delta.error && delta.error.current) || '下载失败'
    });
  }
  setBadge();
  broadcast({ type: 'GIDL_DL_PROGRESS', total: state.total, settled: state.settled, failed: state.failed.length });
  await saveState();
});

// SW 冷启动恢复上一批进行中的状态与队列
restoreState();

// —— 缩略图兜底：弹窗里 <img> 加载失败时，后台抓图转 data URL 返回 ——
const thumbCache = new Map(); // id -> dataUrl

async function fetchThumb(id, url) {
  const cached = thumbCache.get(id);
  if (cached) {
    broadcast({ type: 'GIDL_THUMB', id, dataUrl: cached });
    return;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return;
    const blob = await resp.blob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    const dataUrl = `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}`;
    if (thumbCache.size > 300) thumbCache.clear();
    thumbCache.set(id, dataUrl);
    broadcast({ type: 'GIDL_THUMB', id, dataUrl });
  } catch (e) { /* 静默失败，弹窗保持占位样式 */ }
}

function fetchThumbs(items) {
  const CONC = 6;
  let idx = 0;
  const workers = Array.from({ length: Math.min(CONC, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      const it = items[i];
      if (it && it.id && it.url) await fetchThumb(it.id, it.url);
    }
  });
  return Promise.all(workers);
}

// 后台抓原图并转 data URL（弹窗 fetch 失败时的第二级兜底）
async function fetchAsDataUrl(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    const resp = await fetch(url, { credentials: 'include', signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return { error: 'HTTP ' + resp.status };
    const blob = await resp.blob();
    if (blob.size > 30 * 1024 * 1024) return { error: '文件超过 30MB' };
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return {
      dataUrl: `data:${blob.type || 'image/png'};base64,${btoa(bin)}`,
      type: blob.type
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'GIDL_THUMBS') {
    fetchThumbs(Array.isArray(msg.items) ? msg.items : []);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'GIDL_FETCH') {
    fetchAsDataUrl(msg.url).then(sendResponse);
    return true; // 异步响应
  }
  if (msg.type === 'GIDL_OPEN_SAVER') {
    // 页面内选图面板「完成并下载」：打开批量保存页执行
    chrome.tabs.create({ url: chrome.runtime.getURL('saver.html') });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'GIDL_DOWNLOAD') {
    if (state.running) {
      sendResponse({ ok: false, error: '已有下载任务进行中，请等它完成' });
      return;
    }
    const items = Array.isArray(msg.items) ? msg.items : [];
    if (!items.length) {
      sendResponse({ ok: false, error: '下载列表为空' });
      return;
    }
    sendResponse({ ok: true });
    startBatch(items, msg.folder || '');
    return;
  }
  if (msg.type === 'GIDL_STATE') {
    sendResponse({
      ok: true,
      state: {
        running: state.running,
        total: state.total,
        settled: state.settled,
        failed: state.failed.slice(-10)
      }
    });
    return;
  }
});

// —— 右键菜单：单张图片下载原图 ——
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'gidl-download-original',
      title: '下载 Gemini 图片原图',
      contexts: ['image'],
      documentUrlPatterns: [
        'https://gemini.google.com/*',
        'https://gemini.googleworkspace.com/*'
      ]
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'gidl-download-original' || !info.srcUrl) return;
  const cfg = await chrome.storage.sync.get({ folder: 'Gemini图片' });
  // blob: 属于页面源，扩展与 downloads 均无法访问——在页面上下文里取字节：
  // 优先 Gemini 自带下载链接（原图），退回右键图片自身的 blob 字节
  if (/^blob:/i.test(info.srcUrl)) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: 'GIDL_DL_LINK_DATA',
        id: '',
        link: info.srcUrl
      });
      const r2 = (res && res.ok && res.dataUrl)
        ? res
        : await chrome.tabs.sendMessage(tab.id, { type: 'GIDL_BLOB_DATA', url: info.srcUrl });
      if (r2 && r2.ok && r2.dataUrl) {
        const ext = G.extFromMime(r2.type || '') || '.png';
        const tail = String(Date.now()).slice(-6);
        await chrome.downloads.download({
          url: r2.dataUrl,
          filename: G.makePath(cfg.folder, `gemini_blob_${tail}${ext}`),
          conflictAction: 'uniquify'
        });
        return;
      }
    } catch (e) { /* 页面不可达：静默 */ }
    return;
  }
  const url = G.toOriginalUrl(info.srcUrl);
  if (!G.isUgcUrl(url)) return;
  const ext = await fetchExt(url);
  const tail = G.baseId(url).split('/').pop().slice(-10) || String(Date.now());
  const name = `gemini_${tail}${ext || '.png'}`;
  try {
    await chrome.downloads.download({
      url,
      filename: G.makePath(cfg.folder, name),
      conflictAction: 'uniquify'
    });
  } catch (e) { /* ignore */ }
});
