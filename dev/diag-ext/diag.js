'use strict';
const $ = (id) => document.getElementById(id);
const out = $('out');
const DEFAULT_URL = 'https://lh3.googleusercontent.com/a/default-user=s64';
$('u').value = DEFAULT_URL;

function line(cls, txt) {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = txt + '\n';
  out.appendChild(span);
}

function tImg(u, cors) {
  return new Promise((resolve) => {
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve('TIMEOUT(15s)'), 15000);
    img.onload = () => { clearTimeout(timer); resolve(`OK ${img.naturalWidth}x${img.naturalHeight}`); };
    img.onerror = () => { clearTimeout(timer); resolve('FAIL(onerror)'); };
    img.src = u;
  });
}

async function tFetch(u, opts) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(u, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    const buf = new Uint8Array(await r.arrayBuffer());
    return `HTTP ${r.status} ct=${r.headers.get('content-type') || '-'} acao=${r.headers.get('access-control-allow-origin') || '-'} bytes=${buf.length}`;
  } catch (e) {
    return 'ERR ' + String((e && e.message) || e);
  }
}

async function tSwFetch(u) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT(25s)'), 25000);
    chrome.runtime.sendMessage({ type: 'GIDL_DIAG_FETCH', url: u }, (r) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) return resolve('ERR ' + chrome.runtime.lastError.message);
      if (!r) return resolve('无响应');
      if (r.ok) return resolve(`HTTP ${r.status} ct=${r.type} acao=${r.acao} bytes=${r.bytes}`);
      resolve(r.error ? 'ERR ' + r.error : `HTTP ${r.status}`);
    });
  });
}

async function tFsAccess() {
  const has = typeof window.showDirectoryPicker === 'function';
  const results = [`showDirectoryPicker: ${has ? '可用' : '不可用'}`];
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('diag-test.txt', { create: true });
    const ws = await fh.createWritable();
    await ws.write(new Blob(['hello']));
    await ws.close();
    results.push('createWritable 写入(OPFS): OK');
  } catch (e) {
    results.push('createWritable 写入(OPFS): ERR ' + String((e && e.message) || e));
  }
  return results.join('；');
}

async function run() {
  out.textContent = '';
  const u = $('u').value.trim();
  const dUrl = u.includes('=') ? u.slice(0, u.lastIndexOf('=')) + '=d' : u + '=d';
  line('dim', `location: ${location.origin}`);
  line('dim', `UA: ${navigator.userAgent}`);
  line('dim', `online: ${navigator.onLine}`);
  line('', `1) <img> 直接加载: ${await tImg(u, false)}`);
  line('', `2) <img crossorigin=anonymous>: ${await tImg(u, true)}`);
  line('', `3) fetch 默认: ${await tFetch(u, {})}`);
  line('', `4) fetch credentials=include: ${await tFetch(u, { credentials: 'include' })}`);
  line('', `5) SW fetch credentials=include: ${await tSwFetch(u)}`);
  line('', `6) <img> =d 变体 (${dUrl.split('/').pop()}): ${await tImg(dUrl, false)}`);
  line('', `7) fetch =d 变体: ${await tFetch(dUrl, {})}`);
  line('', `8) 文件系统访问: ${await tFsAccess()}`);
  line('dim', '—— 完成 ——');
}

$('run').addEventListener('click', run);
run();

// 完整流程：选文件夹 → fetch 图片 → createWritable 写盘
$('runSave').addEventListener('click', async () => {
  line('dim', '—— 完整保存流程测试 ——');
  try {
    if (typeof window.showDirectoryPicker !== 'function') {
      line('bad', 'showDirectoryPicker 不可用');
      return;
    }
    line('dim', '打开目录选择对话框…');
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    line('ok', `已选择目录: ${dir.name}`);

    const u = $('u').value.trim();
    line('dim', `抓取 ${u}`);
    const resp = await fetch(u, { credentials: 'include' });
    if (!resp.ok) { line('bad', `HTTP ${resp.status}`); return; }
    const blob = await resp.blob();
    line('ok', `抓取成功: ${blob.type} ${blob.size} bytes`);

    const name = `diag-test-${Date.now()}.png`;
    const fh = await dir.getFileHandle(name, { create: true });
    const ws = await fh.createWritable();
    await ws.write(blob);
    await ws.close();
    line('ok', `已写入文件: ${dir.name}/${name}`);
    line('dim', '—— 若资源管理器中能看到该文件即完整链路通过 ——');
  } catch (e) {
    line('bad', 'ERR ' + String((e && e.message) || e) + ' name=' + (e && e.name));
  }
});
