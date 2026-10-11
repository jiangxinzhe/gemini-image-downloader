// 内容脚本：扫描 gemini.google.com 对话页里的图片，可深度滚动加载后收集
(() => {
  'use strict';
  // 扩展重载后，旧脚本的 chrome.runtime 会失效；此时要允许重新注入新版脚本
  let ctxAlive = false;
  try {
    ctxAlive = !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  } catch (e) {
    ctxAlive = false;
  }
  if (globalThis.__GIDL_CONTENT__ && ctxAlive) return; // 正常的重复注入，跳过
  globalThis.__GIDL_CONTENT__ = true;

  const G = globalThis.GIDL;

  // 模型回复侧的容器标签（Gemini 用自定义元素组织 DOM）
  const MODEL_TAGS = new Set([
    'MODEL-RESPONSE',
    'RESPONSE-CONTAINER',
    'MESSAGE-CONTENT',
    'EXTENDED-RESPONSE-PANEL',
    'IMMERSIVE-ARTIFACT'
  ]);
  const USER_TAGS = new Set(['USER-QUERY']);
  const MIN_SIZE = 96;    // 过滤头像/图标等小图
  const MAX_ITEMS = 500;  // 单次扫描上限，防止极端情况

  // 在页面上下文抓取缩略图并转 data URL，逐张回报给弹窗
  async function fetchPageThumbs(items) {
    let idx = 0;
    const CONC = 3;
    const workers = Array.from({ length: Math.min(CONC, items.length) }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) return;
        const it = items[i];
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 15000);
          const resp = await fetch(it.url, { credentials: 'include', signal: ctrl.signal });
          clearTimeout(timer);
          if (!resp.ok) {
            postPageThumb({ id: it.id, error: 'HTTP ' + resp.status });
            continue;
          }
          const blob = await resp.blob();
          const dataUrl = await blobToDataUrl(blob);
          postPageThumb({ id: it.id, dataUrl });
        } catch (e) {
          postPageThumb({ id: it.id, error: String((e && e.message) || e) });
        }
      }
    });
    await Promise.all(workers);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // 在页面里加载图片并返回其原始尺寸（用于宽高比校验）
  function probeImage(u) {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve(null), 20000);
      img.onload = () => { clearTimeout(timer); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { clearTimeout(timer); resolve(null); };
      img.src = u;
    });
  }

  function postPageThumb(m) {
    try {
      const p = chrome.runtime.sendMessage({ type: 'GIDL_PAGE_THUMB', ...m });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 弹窗可能已关闭 */ }
  }

  // —— 页面内选图面板：克隆页面里已渲染的 <img>，不发起任何网络请求 ——
  let panelState = null;
  let panelSheet = null;
  const PANEL_CSS = `
    #gidl-panel-root{position:fixed;top:64px;right:16px;width:372px;max-height:calc(100vh - 88px);background:#fff;border:1px solid #dadce0;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.28);z-index:2147483647;display:flex;flex-direction:column;font:13px/1.5 "Segoe UI","Microsoft YaHei",Roboto,sans-serif;color:#202124}
    .gidl-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eceff1}
    .gidl-title{flex:1;font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .gidl-btn{border:1px solid #dadce0;background:#fff;border-radius:999px;padding:3px 10px;cursor:pointer;font-size:12px;color:#202124}
    .gidl-btn:hover{background:#f1f3f4}
    .gidl-btn.primary{background:#1a73e8;border-color:#1a73e8;color:#fff;font-weight:600}
    .gidl-btn.primary:hover{background:#0b57d0}
    .gidl-x{border:none;background:none;font-size:15px;color:#5f6368;cursor:pointer;padding:2px 6px;border-radius:6px}
    .gidl-x:hover{background:#f1f3f4}
    .gidl-grid{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px;align-content:start;min-height:120px}
    .gidl-cell{position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;cursor:pointer;border:2px solid transparent;background:#f1f3f4}
    .gidl-cell img{width:100%;height:100%;object-fit:cover;display:block}
    .gidl-cell.gidl-sel{border-color:#1a73e8}
    .gidl-cell.gidl-sel::after{content:"✓";position:absolute;right:4px;bottom:4px;width:16px;height:16px;background:#1a73e8;color:#fff;border-radius:50%;font-size:11px;line-height:16px;text-align:center}
    .gidl-cell.gidl-broken img{visibility:hidden}
    .gidl-cell.gidl-broken::before{content:attr(data-idx);position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:18px;color:#9aa0a6;font-weight:600}
    .gidl-n{position:absolute;left:4px;top:4px;background:rgba(0,0,0,.55);color:#fff;border-radius:4px;padding:0 5px;font-size:10px;line-height:16px;z-index:1}
    .gidl-k{position:absolute;left:4px;bottom:4px;background:rgba(0,0,0,.55);color:#fff;border-radius:4px;padding:0 4px;font-size:10px;line-height:15px}
    .gidl-ft{display:flex;align-items:center;gap:10px;padding:10px 12px;border-top:1px solid #eceff1}
    .gidl-count{flex:1;color:#5f6368;font-size:12px}
    .gidl-link{color:#1a73e8;cursor:pointer;font-size:12px;text-decoration:none}
    .gidl-link:hover{text-decoration:underline}
  `;

  function ensurePanelStyles() {
    if (panelSheet) return;
    try {
      panelSheet = new CSSStyleSheet();
      panelSheet.replaceSync(PANEL_CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, panelSheet];
    } catch (e) {
      panelSheet = null;
    }
  }

  function hidePanel() {
    const old = document.getElementById('gidl-panel-root');
    if (old) old.remove();
    document.removeEventListener('keydown', onPanelKey, true);
    panelState = null;
  }

  function onPanelKey(e) {
    if (e.key === 'Escape') hidePanel();
  }

  function showPanel(items, selectedIds, title) {
    hidePanel();
    ensurePanelStyles();

    const root = document.createElement('div');
    root.id = 'gidl-panel-root';

    // 头部
    const hd = document.createElement('div');
    hd.className = 'gidl-hd';
    const t = document.createElement('div');
    t.className = 'gidl-title';
    t.textContent = `选择要下载的图片 · ${title || 'Gemini'}`;
    const btnAll = document.createElement('button');
    btnAll.className = 'gidl-btn';
    btnAll.textContent = '全选';
    const btnNone = document.createElement('button');
    btnNone.className = 'gidl-btn';
    btnNone.textContent = '清空';
    const btnX = document.createElement('button');
    btnX.className = 'gidl-x';
    btnX.textContent = '✕';
    btnX.title = '关闭';
    hd.append(t, btnAll, btnNone, btnX);

    // 图片网格
    const grid = document.createElement('div');
    grid.className = 'gidl-grid';
    const selected = new Set(selectedIds);
    const KIND_MARK2 = { generated: '✦', uploaded: '↑', other: '•' };

    items.forEach((it, k) => {
      const cell = document.createElement('div');
      cell.className = 'gidl-cell' + (selected.has(it.id) ? ' gidl-sel' : '');
      cell.dataset.id = it.id;
      cell.dataset.idx = String(k + 1);

      let img = null;
      const orig = imgMap.get(it.id);
      if (orig) {
        img = orig.cloneNode(true);
        img.removeAttribute('class');
        img.removeAttribute('sizes');
      } else {
        img = document.createElement('img');
        img.src = it.src || '';
      }
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      img.style.display = 'block';
      img.addEventListener('error', () => cell.classList.add('gidl-broken'), { once: true });
      img.addEventListener('load', () => cell.classList.remove('gidl-broken'));
      cell.appendChild(img);

      const n = document.createElement('span');
      n.className = 'gidl-n';
      n.textContent = String(k + 1);
      cell.appendChild(n);

      const mk = document.createElement('span');
      mk.className = 'gidl-k';
      mk.textContent = KIND_MARK2[it.kind] || '•';
      cell.appendChild(mk);

      cell.addEventListener('click', () => {
        if (selected.has(it.id)) selected.delete(it.id);
        else selected.add(it.id);
        cell.classList.toggle('gidl-sel', selected.has(it.id));
        countEl.textContent = `已选 ${selected.size} / ${items.length}`;
      });
      grid.appendChild(cell);
    });

    // 底部
    const ft = document.createElement('div');
    ft.className = 'gidl-ft';
    const countEl = document.createElement('span');
    countEl.className = 'gidl-count';
    countEl.textContent = `已选 ${selected.size} / ${items.length}`;
    const btnDone = document.createElement('button');
    btnDone.className = 'gidl-btn primary';
    btnDone.textContent = '完成并下载';
    const btnSync = document.createElement('a');
    btnSync.className = 'gidl-link';
    btnSync.textContent = '仅同步到弹窗';
    btnSync.title = '只同步勾选结果到扩展弹窗，不立即下载';
    ft.append(countEl, btnSync, btnDone);

    root.append(hd, grid, ft);
    document.documentElement.appendChild(root);

    const updateCount = () => { countEl.textContent = `已选 ${selected.size} / ${items.length}`; };
    btnAll.addEventListener('click', () => {
      items.forEach((it) => selected.add(it.id));
      grid.querySelectorAll('.gidl-cell').forEach((c) => c.classList.add('gidl-sel'));
      updateCount();
    });
    btnNone.addEventListener('click', () => {
      selected.clear();
      grid.querySelectorAll('.gidl-cell').forEach((c) => c.classList.remove('gidl-sel'));
      updateCount();
    });
    btnX.addEventListener('click', hidePanel);
    document.addEventListener('keydown', onPanelKey, true);

    panelState = { items, selected, title };

    btnSync.addEventListener('click', () => finishPanel(false));
    btnDone.addEventListener('click', () => finishPanel(true));
  }

  // 确认选择：同步到弹窗；downloadNow 时组装任务并打开保存页
  async function finishPanel(downloadNow) {
    if (!panelState) return;
    const { items, selected, title } = panelState;
    const ids = items.filter((it) => selected.has(it.id)).map((it) => it.id);
    panelState = null;

    // 选择结果登记（弹窗下次打开也会应用）
    try {
      const p = chrome.storage.session.set({ panelSelection: ids });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }

    // 通知弹窗实时应用（若弹窗开着）
    try {
      const p = chrome.runtime.sendMessage({ type: 'GIDL_PANEL_DONE', ids });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }

    if (downloadNow && ids.length) {
      const base = globalThis.GIDL.sanitizeName(title || 'gemini', 40);
      const digits = String(ids.length).length;
      let k = 0;
      // 画质档与弹窗一致（storage.sync，默认网页图快档）
      let quality = 'page';
      try {
        const cfg = await new Promise((resolve) => {
          try {
            chrome.storage.sync.get({ quality: 'page' }, (r) => resolve(r || { quality: 'page' }));
          } catch (e) { resolve({ quality: 'page' }); }
        });
        quality = cfg.quality === 'orig' ? 'orig' : 'page';
      } catch (e) { /* 默认 page */ }
      const picked = items
        .filter((it) => selected.has(it.id))
        .map((it) => ({
          id: it.id,
          tabId: 0, // 由面板所在页发起，接收方 save-lib 无 tabId 时会退回首个 Gemini 标签页
          quality,
          url: it.origUrl,
          blobUrl: /^(blob:|data:image\/)/i.test(it.src || '') ? it.src : '',
          dlLink: it.dlLink || '',
          perfUrl: it.perfUrl || '',
          w: it.w || 0,
          h: it.h || 0,
          name: `${base}_${String(++k).padStart(digits, '0')}`
        }));
      try {
        const p = chrome.storage.session.set({ saveJob: { items: picked, title, mode: 'picker' } });
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* ignore */ }
      try {
        const p = chrome.runtime.sendMessage({ type: 'GIDL_OPEN_SAVER' });
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* ignore */ }
    }
    hidePanel();
  }

  // 谷歌账号头像路径，如 /a/ACg... 或 /a-/ACg...
  const AVATAR_RE = /^\/a(-|\/|$)/;

  // —— 原始图片地址：从页面网络请求记录（Performance API）里找 Gemini 渲染时抓取过的高清图 ——
  let perfStats = { candidates: 0, paired: 0 };

  function perfImageCandidates() {
    let entries = [];
    try {
      entries = performance.getEntriesByType('resource') || [];
    } catch (e) {
      return [];
    }
    const seen = new Set();
    const out = [];
    for (const en of entries) {
      const u = en.name || '';
      if (!/^https:/i.test(u)) continue;
      if (!/googleusercontent\.com\//i.test(u)) continue;
      try {
        if (/\/a(-|\/)/i.test(new URL(u).pathname)) continue; // 头像
      } catch (e) { /* ignore */ }
      if (!/\/gg\//i.test(u)) continue; // 只认生成图特征路径，避免与上传图混淆
      const id = G.baseId(u);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ url: u, startTime: en.startTime || 0 });
    }
    out.sort((a, b) => a.startTime - b.startTime);
    return out;
  }

  // 候选原图数量 ≥ 生成图数量时，按抓取时间顺序与文档顺序一一配对；
  // 配对结果在保存时会经宽高比校验 + 字节大小对比双重确认，配错也不会写错文件
  function attachPerfCandidates(list) {
    perfStats = { candidates: 0, paired: 0 };
    try {
      const cands = perfImageCandidates();
      perfStats.candidates = cands.length;
      const urls = GIDL.pairPerfCandidates(list, cands);
      let n = 0;
      list.forEach((it, idx) => {
        if (urls[idx]) {
          it.perfUrl = urls[idx];
          n++;
        }
      });
      perfStats.paired = n;
    } catch (e) { /* ignore */ }
  }

  // —— 原生下载截获：接收主世界 hook 的捕获事件，并支持按时间请求字节 ——
  const nativeCaptures = [];
  const nativeWaiters = [];
  document.addEventListener('__gidl_capture', (e) => {
    try {
      const d = JSON.parse(e.detail);
      nativeCaptures.push(d);
      if (nativeCaptures.length > 60) nativeCaptures.shift();
      for (let i = nativeWaiters.length - 1; i >= 0; i--) {
        const w = nativeWaiters[i];
        if (d.time >= w.t0 && d.size >= w.minSize) {
          nativeWaiters.splice(i, 1);
          w.resolve(d);
        }
      }
    } catch (err) { /* ignore */ }
  }, true);

  function waitNativeCapture(t0, minSize, timeoutMs) {
    return new Promise((resolve) => {
      const w = { t0, minSize, resolve };
      nativeWaiters.push(w);
      setTimeout(() => {
        const i = nativeWaiters.indexOf(w);
        if (i !== -1) {
          nativeWaiters.splice(i, 1);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  // 向主世界 hook 请求某次捕获的字节（data URL），经 CustomEvent 往返
  function requestNativeBytes(time) {
    return new Promise((resolve) => {
      const token = 't' + Math.random().toString(36).slice(2);
      const onData = (e) => {
        try {
          const d = JSON.parse(e.detail);
          if (d.token === token) {
            document.removeEventListener('__gidl_data', onData, true);
            resolve(d);
          }
        } catch (err) { /* ignore */ }
      };
      document.addEventListener('__gidl_data', onData, true);
      try {
        document.dispatchEvent(new CustomEvent('__gidl_request', { detail: JSON.stringify({ token, time }) }));
      } catch (e) {
        document.removeEventListener('__gidl_data', onData, true);
        resolve({ ok: false, error: 'dispatch-failed' });
      }
      setTimeout(() => {
        document.removeEventListener('__gidl_data', onData, true);
        resolve({ ok: false, error: 'bytes-timeout' });
      }, 30000);
    });
  }

  // 开/关下载抑制窗口：截获期间 Gemini 自己会发起 <a download> 下载，
  // 系统另存为对话框会抢焦点关闭扩展弹窗，还会在下载目录留重复文件
  function suppressNativeDownload(ms) {
    try {
      document.dispatchEvent(new CustomEvent('__gidl_suppress', { detail: JSON.stringify({ ms }) }));
    } catch (e) { /* ignore */ }
  }

  // 在图片周边寻找 Gemini 原生的下载按钮（先模拟悬停触发工具栏渲染）
  function findNativeDownloadButton(imgEl) {
    let container = imgEl;
    for (let depth = 0; container && depth < 6; depth++) {
      try {
        container.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        container.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      } catch (e) { /* ignore */ }
      const btns = deepQueryAll('button, [role="button"], a[download]', container).filter((b) => b !== imgEl);
      const hit = btns.find((b) => {
        const label = ((b.getAttribute && (b.getAttribute('aria-label') || b.getAttribute('title'))) || b.textContent || '').toString().toLowerCase();
        return /下载|download/.test(label);
      });
      if (hit) return hit;
      let next = container.parentElement;
      if (!next) {
        const r = container.getRootNode && container.getRootNode();
        next = r && r.host ? r.host : null;
      }
      container = next;
    }
    return null;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let collecting = false;
  // id -> 页面里已渲染的 <img>（页面内选图面板直接克隆它们，保证能显示）
  let imgMap = new Map();

  // —— DOM 收集：穿透 open shadow root（80ms 缓存，避免深度扫描时高频全量遍历） ——
  let dqCache = { sel: '', time: 0, out: [] };
  function deepQueryAll(selector, root) {
    const scoped = root || document;
    if (!root) {
      const now = Date.now();
      if (dqCache.sel === selector && now - dqCache.time < 80) return dqCache.out;
    }
    const out = [];
    const stack = [scoped];
    while (stack.length) {
      const cur = stack.pop();
      try {
        for (const el of cur.querySelectorAll(selector)) out.push(el);
        for (const el of cur.querySelectorAll('*')) {
          if (el.shadowRoot) stack.push(el.shadowRoot);
        }
      } catch (e) { /* 个别节点不可查询时跳过 */ }
    }
    if (!root) dqCache = { sel: selector, time: Date.now(), out };
    return out;
  }

  // 判断图片是否位于模型回复 / 用户提问内部（向上遍历并跨 shadow 边界）
  function classify(imgEl) {
    let inModel = false;
    let inUser = false;
    let node = imgEl;
    while (node) {
      const tag = node.tagName;
      if (MODEL_TAGS.has(tag)) inModel = true;
      if (USER_TAGS.has(tag)) inUser = true;
      let next = node.parentElement;
      if (!next) {
        const root = node.getRootNode && node.getRootNode();
        next = root && root.host ? root.host : null;
      }
      node = next;
    }
    return { inModel, inUser };
  }

  function convTitle() {
    let t = (document.title || '').trim();
    t = t.replace(/\s*[-–—|]\s*Gemini\s*$/i, '').trim();
    return t;
  }

  function postScanProgress(pct) {
    try {
      const p = chrome.runtime.sendMessage({ type: 'GIDL_SCAN_PROGRESS', pct });
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 弹窗可能已关闭 */ }
  }

  // 等待视口附近的图片加载完（离屏的懒加载图不会触发，不必等它们）
  async function waitChatImages(timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const vh = window.innerHeight || 800;
      const pending = deepQueryAll('img').some((i) => {
        const s = i.currentSrc || i.src || '';
        if (!G.isUgcUrl(s) || i.complete) return false;
        const r = i.getBoundingClientRect();
        return r.bottom > -300 && r.top < vh + 300;
      });
      if (!pending) return;
      await sleep(150);
    }
  }

  function findScrollContainer() {
    const imgs = deepQueryAll('img');
    let anchor = imgs.find((i) => G.isUgcUrl(i.currentSrc || i.src)) || imgs[0] || null;
    if (!anchor) anchor = document.querySelector('model-response, main, [role="main"]');
    for (let el = anchor; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 100) return el;
    }
    // 兜底：取页面里最大的纵向滚动容器
    let best = null;
    for (const el of document.querySelectorAll('div, main, section')) {
      if (el === document.body || el === document.documentElement) continue;
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight * 2 && el.clientHeight > 300) {
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
    }
    return best || document.scrollingElement || document.documentElement;
  }

  // 深度扫描：从顶部到中部、从中部到底部双向逐屏扫掠，
  // 边滚边收集（应对懒加载与虚拟化），完成后恢复原位置
  async function deepScanCollect() {
    const sc = findScrollContainer();
    if (!sc) return collect();
    const origTop = sc.scrollTop;
    const acc = new Map();
    const span = Math.max(1, sc.scrollHeight - sc.clientHeight);
    const step = Math.max(240, Math.floor(sc.clientHeight * 0.9));
    imgMap = new Map(); // 深扫开始时重建，边扫边填（覆盖到的图会重新 set）

    for (let sweep = 0; sweep < 2; sweep++) {
      const down = sweep === 0;
      sc.scrollTop = down ? 0 : sc.scrollHeight;
      await sleep(250);
      let last = -1;
      const started = Date.now();
      for (let i = 0; i < 300; i++) {
        collectInto(acc, deepQueryAll('img'));
        if (acc.size >= MAX_ITEMS) break;

        const frac = Math.min(1, Math.max(0, sc.scrollTop / span));
        postScanProgress((sweep + (down ? frac : 1 - frac)) / 2);

        await sleep(120);
        await waitChatImages(500);

        const before = sc.scrollTop;
        sc.scrollTop = down ? before + step : before - step;
        await sleep(40);
        const after = sc.scrollTop;
        if (after === last) break; // 已到头
        last = after;
        if (down && after >= sc.scrollHeight - sc.clientHeight - 2) { collectInto(acc, deepQueryAll('img')); break; }
        if (!down && after <= 1) { collectInto(acc, deepQueryAll('img')); break; }
        if (Date.now() - started > 25000) break; // 单轮超时保护
      }
    }

    collectInto(acc, deepQueryAll('img'));
    sc.scrollTop = origTop;
    const list = Array.from(acc.values());
    attachPerfCandidates(list);
    return list;
  }

  // 围绕图片找 Gemini 自带下载按钮背后的下载链接（<a href> / [download]）。
  // 该链接（多为 blob:）就是页面"下载"按钮的数据源，很可能是原图
  function findDownloadLink(imgEl) {
    let el = imgEl;
    for (let depth = 0; el && depth < 8; depth++) {
      try {
        for (const a of el.querySelectorAll('a[href]')) {
          const h = a.getAttribute('href') || '';
          if (/^(blob:|data:image\/)/i.test(h)) return h;
        }
        for (const d of el.querySelectorAll('[download]')) {
          const h = d.getAttribute('href') || (d.tagName === 'A' ? '' : (d.querySelector && d.querySelector('a[href]') ? d.querySelector('a[href]').getAttribute('href') : ''));
          if (h && /^(blob:|data:image\/)/i.test(h)) return h;
        }
      } catch (e) { /* ignore */ }
      let next = el.parentElement;
      if (!next) {
        const root = el.getRootNode && el.getRootNode();
        next = root && root.host ? root.host : null;
      }
      el = next;
    }
    return '';
  }

  // 在图片周边 DOM 里寻找原始图片的服务器地址（Gemini 下载按钮所用的来源）。
  // 从图片自身往外逐层查找：第一层只出现 1 个地址的直接采用；多个时优先带 /gg/ 路径的。
  function findServerUrl(imgEl) {
    const RE = /https:\/\/[a-z0-9.-]+googleusercontent\.com\/[^"'\\\s<>)]+/gi;
    let el = imgEl;
    let fallback = '';
    for (let depth = 0; el && depth < 8; depth++) {
      const html = el.outerHTML || '';
      if (html.indexOf('googleusercontent.com') !== -1) {
        const urls = (html.match(RE) || []).map((u) => u.replace(/&amp;/g, '&'));
        const gg = urls.find((u) => /\/gg\//.test(u));
        if (urls.length === 1) return G.withSizeParam(urls[0], 'd');
        if (gg) return G.withSizeParam(gg, 'd');
        if (!fallback && urls[0]) fallback = G.withSizeParam(urls[0], 'd');
      }
      let next = el.parentElement;
      if (!next) {
        const root = el.getRootNode && el.getRootNode();
        next = root && root.host ? root.host : null;
      }
      el = next;
    }
    return fallback;
  }

  // 把当前 DOM 里的图片收集进 acc（按 id 去重，保留首次出现顺序）。
  // 每轮收集前重建 imgMap：虚拟化列表换走的 detached <img> 不再被长期持有
  function collectInto(acc, imgEls) {
    for (const img of imgEls) {
      const src = img.currentSrc || img.src || '';
      if (!src) continue;
      const id = G.baseId(src);
      const isUgc = G.isUgcUrl(src);
      const isBlob = /^blob:/i.test(src);
      const isData = /^data:image\//i.test(src);
      const { inModel, inUser } = classify(img);
      // 候选：Google 图片、/gg/ 特征、blob/data 内联图、模型回复区域内的任意图片
      if (!isUgc && !isBlob && !isData && !/\/gg\//.test(id) && !inModel) continue;
      if (acc.has(id)) continue;

      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w && h && Math.max(w, h) < MIN_SIZE) continue; // 小图标
      try {
        if (isUgc && AVATAR_RE.test(new URL(src).pathname)) continue; // 谷歌头像
      } catch (e) { /* ignore */ }

      const isGg = /\/gg\//.test(id);
      let kind;
      if (inUser && !inModel && !isGg && !isBlob) kind = 'uploaded';
      else if (inModel || isGg) kind = 'generated';
      else kind = 'other';

      imgMap.set(id, img);
      const serverUrl = findServerUrl(img); // 页面中留存的原始图片地址（可能为空）
      const dlLink = isBlob || isData ? findDownloadLink(img) : ''; // blob 图专属：页面下载按钮的链接
      acc.set(id, {
        id,
        src,
        origUrl: serverUrl || (isBlob || isData ? src : G.toOriginalUrl(src)),
        serverUrl,
        dlLink,
        kind,
        w,
        h,
        alt: (img.alt || '').slice(0, 120)
      });
      if (acc.size >= MAX_ITEMS) return;
    }
  }

  // 全部列出（生成/上传/其他），弹窗里默认只勾选生成图
  function collect() {
    const acc = new Map();
    const imgEls = deepQueryAll('img');
    imgMap = new Map(); // 每轮扫描重建，丢弃 detached 节点
    collectInto(acc, imgEls);
    const list = Array.from(acc.values());
    attachPerfCandidates(list);
    return list;
  }

  // 自诊断统计：页面 <img> 总数、Google 图片数、模型回复区图片数
  function scanStats() {
    const imgs = deepQueryAll('img');
    let ugc = 0;
    let modelImgs = 0;
    for (const i of imgs) {
      const s = i.currentSrc || i.src || '';
      if (G.isUgcUrl(s) || /\/gg\//.test(G.baseId(s))) ugc++;
      if (classify(i).inModel) modelImgs++;
    }
    return { totalImgs: imgs.length, ugcImgs: ugc, modelImgs };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    // 页面上下文抓缩略图：与 Gemini 页面相同的来源/Cookie/Referer，
    // 用于图片服务器拒绝扩展环境直接加载时的兜底
    if (msg.type === 'GIDL_PAGE_THUMBS') {
      fetchPageThumbs(Array.isArray(msg.items) ? msg.items : []);
      sendResponse({ ok: true });
      return;
    }
    // 从候选地址取原图字节：先在页面里加载校验宽高比，匹配才取字节
    if (msg.type === 'GIDL_FETCH_BEST' && Array.isArray(msg.urls) && msg.urls.length) {
      (async () => {
        const ratio = msg.ratio || 0;
        let lastErr = '';
        for (const u of msg.urls) {
          try {
            const dim = await probeImage(u);
            if (!dim || !dim.w || !dim.h) { lastErr = '原图地址无法加载'; continue; }
            if (ratio && Math.abs(dim.w / dim.h - ratio) > Math.max(0.06, ratio * 0.06)) {
              lastErr = `宽高比不匹配(${dim.w}x${dim.h})`;
              continue;
            }
            let resp;
            try {
              resp = await fetch(u, { credentials: 'include' });
            } catch (fe) {
              lastErr = '跨域拦截: ' + String((fe && fe.message) || fe);
              continue;
            }
            if (!resp.ok) { lastErr = 'HTTP ' + resp.status; continue; }
            const blob = await resp.blob();
            if (blob.size > 40 * 1024 * 1024) { lastErr = '文件超过 40MB'; continue; }
            const dataUrl = await blobToDataUrl(blob);
            sendResponse({ ok: true, dataUrl, type: blob.type, w: dim.w, h: dim.h, url: u });
            return;
          } catch (e) { /* 试下一个候选 */ }
        }
        sendResponse({ ok: false, error: lastErr || 'no-match' });
      })();
      return true; // 异步响应
    }
    // 取 Gemini 自带下载链接（多为 blob:）的字节——页面"下载"按钮的数据源，很可能是原图
    if (msg.type === 'GIDL_DL_LINK_DATA' && msg.id) {
      (async () => {
        try {
          const img = imgMap.get(msg.id);
          let link = msg.link || '';
          if (!link && img) link = findDownloadLink(img);
          if (!link) { sendResponse({ ok: false, error: 'no-dl-link' }); return; }
          const resp = await fetch(link);
          if (!resp.ok) { sendResponse({ ok: false, error: 'HTTP ' + resp.status }); return; }
          const blob = await resp.blob();
          if (blob.size > 40 * 1024 * 1024) { sendResponse({ ok: false, error: '文件超过 40MB' }); return; }
          const dataUrl = await blobToDataUrl(blob);
          sendResponse({ ok: true, dataUrl, type: blob.type, size: blob.size });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      })();
      return true; // 异步响应
    }
    // 把页面内存中的 blob 图片转成 data URL（供弹窗直接写盘）
    if (msg.type === 'GIDL_BLOB_DATA' && msg.url) {
      (async () => {
        try {
          const resp = await fetch(msg.url);
          if (!resp.ok) { sendResponse({ ok: false, error: 'HTTP ' + resp.status }); return; }
          const blob = await resp.blob();
          if (blob.size > 25 * 1024 * 1024) {
            sendResponse({ ok: false, error: '文件超过 25MB' });
            return;
          }
          const dataUrl = await blobToDataUrl(blob);
          sendResponse({ ok: true, dataUrl, type: blob.type });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      })();
      return true; // 异步响应
    }
    // 页面内选图面板
    if (msg.type === 'GIDL_PANEL_SHOW') {
      try {
        showPanel(msg.items || [], msg.selectedIds || [], msg.title || '');
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return;
    }
    // 原生下载截获：点击 Gemini 自己的下载按钮，等待主世界 hook 捕获原图字节。
    // 校验：捕获须发生在点击之后、且解码出的宽高比与目标图一致——
    // 不一致（并发加载了别的图）就继续等下一次捕获，直到超时
    if (msg.type === 'GIDL_NATIVE_DOWNLOAD' && msg.id) {
      (async () => {
        try {
          const img = imgMap.get(msg.id);
          if (!img) { sendResponse({ ok: false, error: 'img-not-found' }); return; }
          const btn = findNativeDownloadButton(img);
          if (!btn) { sendResponse({ ok: false, error: 'no-button' }); return; }
          const t0 = Date.now() - 1000; // 时钟余量
          const timeoutMs = msg.timeoutMs || 20000;
          const endAt = Date.now() + timeoutMs;
          suppressNativeDownload(timeoutMs + 5000); // 点击前开启：吞掉 Gemini 自身触发的另存为
          btn.click();
          while (Date.now() < endAt) {
            const cap = await waitNativeCapture(t0, msg.minSize || 100000, Math.max(500, endAt - Date.now()));
            if (!cap) break;
            const bytes = await requestNativeBytes(cap.time);
            if (!bytes || !bytes.ok || !bytes.dataUrl) continue; // 读字节失败：等下一次捕获
            // 宽高比校验（w/h 未知时跳过，由字节大小门槛把关）
            if (img.naturalWidth && img.naturalHeight) {
              try {
                const blob = await (await fetch(bytes.dataUrl)).blob();
                const bmp = await createImageBitmap(blob);
                const ratio = img.naturalWidth / img.naturalHeight;
                const capRatio = bmp.width / bmp.height;
                bmp.close();
                if (Math.abs(capRatio - ratio) > Math.max(0.06, ratio * 0.06)) continue; // 错配：别的图
              } catch (e) { /* 解码失败：按候选继续 */ }
            }
            sendResponse({ ok: true, dataUrl: bytes.dataUrl, size: cap.size, url: cap.url });
            return;
          }
          suppressNativeDownload(0); // 超时未截获：解除抑制，避免吞掉用户后续手动下载
          sendResponse({ ok: false, error: 'capture-timeout' });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
      })();
      return true; // 异步响应
    }
    if (msg.type !== 'GIDL_COLLECT') return;
    if (collecting) {
      sendResponse({ ok: false, error: '扫描进行中，请稍候' });
      return;
    }
    collecting = true;
    (async () => {
      try {
        const images = msg.deep ? await deepScanCollect() : collect();
        sendResponse({
          ok: true,
          images,
          title: convTitle(),
          url: location.href,
          debug: Object.assign(scanStats(), {
            perfCandidates: perfStats.candidates,
            perfPaired: perfStats.paired
          })
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      } finally {
        collecting = false;
      }
    })();
    return true; // 异步响应
  });
})();
