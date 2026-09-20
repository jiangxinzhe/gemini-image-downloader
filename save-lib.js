// GIDLS — 保存管线共享库（popup 与 saver 共用，消除双份维护）
// 依赖：lib.js（GIDL）需先加载
// 职责：文件夹句柄管理、Gemini 标签页定位、单张保存完整管线、原生下载截获
(function () {
  'use strict';

  const G = globalThis.GIDL;

  const GEMINI_MATCHES = [
    'https://gemini.google.com/*',
    'https://gemini.googleworkspace.com/*'
  ];

  // —— IndexedDB：记住保存文件夹句柄（扩展内所有页面共享） ——
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('gidl-db', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const r = db.transaction('kv', 'readonly').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function getGrantedDir() {
    try {
      const dir = await idbGet('dir');
      if (!dir) return null;
      const perm = await dir.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return null;
      // 探测目录是否仍然存在（句柄可能指向已删除/移动的目录）
      const it = dir.keys();
      await it.next();
      return dir;
    } catch (e) {
      return null; // 权限不足或句柄失效
    }
  }

  // —— Gemini 标签页定位 ——
  async function geminiTabs() {
    return chrome.tabs.query({ url: GEMINI_MATCHES });
  }
  async function sendToGemini(msg) {
    for (const t of await geminiTabs()) {
      try {
        return await chrome.tabs.sendMessage(t.id, msg);
      } catch (e) { /* 下一个 */ }
    }
    return null;
  }
  async function firstGeminiTabId() {
    const tabs = await geminiTabs();
    return tabs.length ? tabs[0].id : null;
  }

  // —— 主世界取字节（内容脚本环境被拒时的兜底） ——
  async function blobViaMainWorld(tabId, url) {
    let tid = tabId;
    if (!tid) tid = await firstGeminiTabId();
    if (!tid) return null;
    const results = await chrome.scripting.executeScript({
      target: { tabId: tid },
      world: 'MAIN',
      func: async (u) => {
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 90000);
          const resp = await fetch(u, { signal: ctrl.signal });
          clearTimeout(timer);
          if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
          const b = await resp.blob();
          if (b.size > 40 * 1024 * 1024) return { ok: false, error: '文件超过 40MB' };
          const reader = new FileReader();
          const dataUrl = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(b);
          });
          return { ok: true, dataUrl, type: b.type };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
      args: [url]
    });
    return results && results[0] && results[0].result;
  }

  // —— 主世界 hook：包装 fetch / createObjectURL，截获 Gemini 自己抓取的原图字节 ——
  let hookInstalled = false;
  async function installNativeHook() {
    if (hookInstalled) return;
    const tid = await firstGeminiTabId();
    if (!tid) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tid },
        world: 'MAIN',
        func: () => {
          if (window.__gidlHook) return;
          const state = { blobs: [] };
          const push = (rec) => {
            state.blobs.push(rec);
            if (state.blobs.length > 40) state.blobs.shift();
            try {
              document.dispatchEvent(new CustomEvent('__gidl_capture', {
                detail: JSON.stringify({ url: rec.url, size: rec.size, time: rec.time })
              }));
            } catch (e) { /* ignore */ }
          };
          const origFetch = window.fetch;
          window.fetch = async function (...args) {
            const resp = await origFetch.apply(this, args);
            try {
              const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
              const ct = (resp.headers && resp.headers.get('content-type')) || '';
              if (resp.ok && (ct.indexOf('image/') === 0 || /googleusercontent\.com\/gg\//.test(u))) {
                resp.clone().blob().then((b) => {
                  push({ url: u, size: b.size, time: Date.now(), blob: b });
                }).catch(() => {});
              }
            } catch (e) { /* ignore */ }
            return resp;
          };
          const origCOBU = URL.createObjectURL.bind(URL);
          URL.createObjectURL = function (obj) {
            const u = origCOBU(obj);
            try {
              if (obj && typeof obj.size === 'number' && obj.size > 200000) {
                push({ url: u, size: obj.size, time: Date.now(), blob: obj });
              }
            } catch (e) { /* ignore */ }
            return u;
          };
          document.addEventListener('__gidl_request', (e) => {
            let token = '';
            try {
              const d = JSON.parse(e.detail);
              token = d.token;
              const rec = state.blobs.find((b) => b.time === d.time)
                || state.blobs.filter((b) => b.time >= d.time).sort((a, b) => b.size - a.size)[0];
              if (!rec) {
                document.dispatchEvent(new CustomEvent('__gidl_data', { detail: JSON.stringify({ token, ok: false, error: 'not-found' }) }));
                return;
              }
              const reader = new FileReader();
              reader.onload = () => document.dispatchEvent(new CustomEvent('__gidl_data', { detail: JSON.stringify({ token, ok: true, dataUrl: reader.result }) }));
              reader.onerror = () => document.dispatchEvent(new CustomEvent('__gidl_data', { detail: JSON.stringify({ token, ok: false, error: 'read-error' }) }));
              reader.readAsDataURL(rec.blob);
            } catch (err) {
              document.dispatchEvent(new CustomEvent('__gidl_data', { detail: JSON.stringify({ token, ok: false, error: String(err) }) }));
            }
          }, true);
          window.__gidlHook = state;
        }
      });
      hookInstalled = true;
    } catch (e) { /* 标签页不可注入 */ }
  }

  // —— 与目录内已有文件、本批已用名去重：base.ext → base (1).ext → … ——
  async function uniqueInDir(dir, baseName, ext, taken) {
    for (let i = 0; i < 300; i++) {
      const candidate = i === 0 ? baseName + ext : `${baseName} (${i})${ext}`;
      if (taken.has(candidate)) continue;
      try {
        await dir.getFileHandle(candidate, { create: false });
        // 已存在，继续尝试下一个名字
      } catch (e) {
        taken.add(candidate);
        return candidate;
      }
    }
    const fallback = `${baseName}_${Date.now()}${ext}`;
    taken.add(fallback);
    return fallback;
  }

  // —— 原生下载截获（串行队列：多图并发点击会导致字节错配） ——
  let nativeChain = Promise.resolve();

  async function nativeCapture(item) {
    await installNativeHook();
    const res = await sendToGemini({
      type: 'GIDL_NATIVE_DOWNLOAD',
      id: item.id,
      minSize: 100000,
      timeoutMs: 20000
    });
    if (res && res.ok && res.dataUrl) {
      return { blob: await (await fetch(res.dataUrl)).blob(), via: 'native' };
    }
    return null;
  }

  // —— 单张保存完整管线 ——
  // item: { url, blobUrl, perfUrl, id, w, h, name }
  // 返回：{ via: 'direct', orig } 或 { via: 'browser' }
  async function saveToDir(dir, item, taken) {
    const url = item.url;
    const blobUrl = item.blobUrl || '';
    const isBlobSrc = /^blob:/i.test(url);
    let blob = null;
    let viaOriginal = false;
    let viaNative = false;
    let err = '';
    const attempts = [];
    const note = (layer, error) => { if (error) attempts.push({ layer, error: String(error).slice(0, 80) }); };
    const deadline = Date.now() + 110000; // 单张总时限，防止个别图卡死整批

    const fetchAsBlob = async (u) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 90000);
      const resp = await fetch(u, { credentials: 'include', signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return await resp.blob();
    };

    // 1) 本页直接抓取（服务器原图地址）
    if (!blob) {
      try {
        blob = await fetchAsBlob(url);
      } catch (e) {
        blob = null;
        err = String((e && e.message) || e);
        note('弹窗直连', err);
      }
    }

    // 2) 后台 Service Worker 抓取（独立网络上下文）
    if (!blob) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'GIDL_FETCH', url });
        if (res && res.dataUrl) {
          blob = await (await fetch(res.dataUrl)).blob();
          err = '';
        } else if (res && res.error && !err) {
          err = res.error;
          note('后台抓取', res.error);
        }
      } catch (e) { /* keep err */ }
    }

    // 3) Gemini 页面上下文抓取服务器原图地址
    if (!blob && !isBlobSrc && hasTime()) {
      try {
        const res = await sendToGemini({ type: 'GIDL_BLOB_DATA', url });
        if (res && res.ok && res.dataUrl) {
          blob = await (await fetch(res.dataUrl)).blob();
          err = '';
        } else if (res && res.error && !err) {
          err = res.error;
          note('页面抓取服务器原图', res.error);
        }
      } catch (e) { /* ignore */ }
    }

    // 4) 网络记录中的原图（宽高比校验通过才采用）
    if (!blob && item.perfUrl && hasTime()) {
      try {
        const ratio = item.w && item.h ? item.w / item.h : 0;
        const res = await sendToGemini({ type: 'GIDL_FETCH_BEST', urls: [item.perfUrl], ratio });
        if (res && res.ok && res.dataUrl) {
          blob = await (await fetch(res.dataUrl)).blob();
          viaOriginal = true;
          err = '';
        } else if (res && res.error && !err) {
          err = res.error;
          note('网络痕迹原图', res.error);
        }
      } catch (e) { /* ignore */ }
    }

    // 5) 原生下载截获：触发 Gemini 自己的下载按钮，hook 拦截它抓取的原图字节
    if (!blob && hasTime() && item.blobUrl && item.id) {
      try {
        const r = (nativeChain = nativeChain.then(() => nativeCapture(item), () => nativeCapture(item)));
        const got = await r;
        if (got && got.blob) {
          blob = got.blob;
          viaOriginal = true;
          viaNative = true;
          err = '';
        }
      } catch (e) { /* ignore */ }
    }

    // 6) 页面内存预览图（blob，最后兜底）
    if (!blob && blobUrl && hasTime()) {
      try {
        const res = await sendToGemini({ type: 'GIDL_BLOB_DATA', url: blobUrl });
        if (res && res.ok && res.dataUrl) {
          blob = await (await fetch(res.dataUrl)).blob();
          err = '';
        } else if (res && res.error && !err) {
          err = res.error;
          note('页面预览', res.error);
        }
      } catch (e) { /* ignore */ }
    }
    if (!blob && blobUrl && hasTime()) {
      try {
        const res = await blobViaMainWorld(null, blobUrl);
        if (res && res.ok && res.dataUrl) {
          blob = await (await fetch(res.dataUrl)).blob();
          err = '';
        } else if (res && res.error && !err) {
          err = res.error;
          note('layer4', res.error);
        }
      } catch (e) { /* ignore */ }
    }

    // 7) 浏览器下载兜底（后台队列，不受本页生命周期影响）
    if (!blob) {
      const extGuess = isBlobSrc ? '' : '.png'; // blob 交由 Chrome 按类型补扩展名
      const dlPath = G.makePath(dir.name || 'Gemini图片', item.name + extGuess);
      await chrome.downloads.download({ url, filename: dlPath, conflictAction: 'uniquify' });
      return { via: 'browser', orig: false, native: false, err, attempts: attempts.slice(0, 6) };
    }

    // 双保险：疑似原图与页面预览比字节大小，写更大的那份（防配对错或原图反而更小）
    if (viaOriginal && !viaNative && blobUrl && hasTime()) {
      try {
        const res = await sendToGemini({ type: 'GIDL_BLOB_DATA', url: blobUrl });
        if (res && res.ok && res.dataUrl) {
          const preview = await (await fetch(res.dataUrl)).blob();
          if (preview.size > blob.size) {
            blob = preview;
            viaOriginal = false;
          }
        }
      } catch (e) { /* ignore */ }
    }

    const ext = G.extFromMime(blob.type) || '.png';
    const finalName = await uniqueInDir(dir, item.name, ext, taken);
    try {
      const fh = await dir.getFileHandle(finalName, { create: true });
      const ws = await fh.createWritable();
      await ws.write(blob);
      await ws.close();
    } catch (e) {
      // 所选目录已不存在（被删/移动）或句柄失效：清除记忆，下次重新选择
      if (e && (e.name === 'NotFoundError' || /could not be found/i.test(String((e && e.message) || e)))) {
        await idbSet('dir', null).catch(() => {});
        throw new Error('保存位置已失效，请重新下载并选择一次文件夹');
      }
      throw e;
    }
    return { via: 'direct', orig: viaOriginal, native: viaNative, err, attempts: attempts.slice(0, 6) };
  }

  globalThis.GIDLS = {
    idbGet,
    idbSet,
    getGrantedDir,
    saveToDir,
    uniqueInDir,
    installNativeHook,
    firstGeminiTabId
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.GIDLS;
})();
