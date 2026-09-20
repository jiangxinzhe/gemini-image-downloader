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

// downloadId -> { url, filename }
const inflight = new Map();

async function saveState() {
  try {
    await chrome.storage.session.set({
      dl: {
        running: state.running,
        total: state.total,
        settled: state.settled,
        failed: state.failed.slice(-20)
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

async function downloadOne(item, folder) {
  const ext = await fetchExt(item.url);
  const name = `${item.name || 'gemini_image'}${ext || '.png'}`;
  const path = G.makePath(folder, name);
  try {
    const dlId = await chrome.downloads.download({
      url: item.url,
      filename: path,
      conflictAction: 'uniquify'
    });
    inflight.set(dlId, { url: item.url, filename: path, retries: 0 });
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

  // 等 onChanged 事件收尾
  await new Promise((r) => setTimeout(r, 800));

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

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'gidl-download-original' || !info.srcUrl) return;
  const url = G.toOriginalUrl(info.srcUrl);
  if (!G.isUgcUrl(url)) return;
  const cfg = await chrome.storage.sync.get({ folder: 'Gemini图片' });
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
