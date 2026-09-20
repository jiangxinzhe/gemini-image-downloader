// GIDL — 纯函数工具库，被 content.js / background.js / popup.js 共用
// 也可在 node 中 require 用于单元测试（tests/lib.test.js）
(function () {
  'use strict';

  const UGC_HOST_RE = /(^|\.)googleusercontent\.com$/i;
  // 谷歌账号头像路径，如 /a/ACg... 或 /a-/ACg...
  const AVATAR_PATH_RE = /^\/a(-|\/|$)/;
  const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  function isUgcUrl(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    try {
      const u = new URL(url);
      return UGC_HOST_RE.test(u.hostname);
    } catch (e) {
      return false;
    }
  }

  // 去掉末尾尺寸后缀（=w640-h640 / =s160 等）与 ?query/#hash，得到同一张图的稳定 id（用于去重）
  function baseId(url) {
    let s = String(url || '');
    const cut = s.search(/[?#]/);
    if (cut !== -1) s = s.slice(0, cut);
    const eq = s.lastIndexOf('=');
    const slash = s.lastIndexOf('/');
    if (eq > slash + 1) s = s.slice(0, eq);
    return s;
  }

  // 把尺寸后缀替换为指定参数；'d' = 下载原图，'s<数字>' = 限定最长边
  function withSizeParam(url, param) {
    if (!isUgcUrl(url)) return url;
    let body = url;
    let tail = '';
    const cut = url.search(/[?#]/);
    if (cut !== -1) {
      tail = url.slice(cut);
      body = url.slice(0, cut);
    }
    const eq = body.lastIndexOf('=');
    const slash = body.lastIndexOf('/');
    if (eq > slash + 1) body = body.slice(0, eq);
    return body + '=' + param + tail;
  }

  const toOriginalUrl = (url) => withSizeParam(url, 'd');

  function extFromMime(mime) {
    const m = String(mime || '').toLowerCase().split(';')[0].trim();
    const map = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/avif': '.avif',
      'image/heic': '.heic',
      'image/bmp': '.bmp'
    };
    return map[m] || '';
  }

  // 网络记录候选与生成图按抓取时间/文档顺序配对（候选不足则不配对，防止错配）
  // 返回与 items 等长的 perfUrl 数组
  function pairPerfCandidates(items, cands) {
    const out = new Array(items.length).fill('');
    const gen = [];
    items.forEach((it, idx) => { if (it && it.kind === 'generated') gen.push(idx); });
    if (!cands || !cands.length || gen.length > cands.length) return out;
    const sorted = cands.slice().sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    gen.forEach((itemIdx, k) => {
      out[itemIdx] = withSizeParam(sorted[k].url, 'd');
    });
    return out;
  }

  // 清洗单个文件/文件夹名：替换 Windows 非法字符、去首尾空白和点
  function sanitizeName(name, maxLen) {
    let s = String(name || '').replace(/[\u0000-\u001f]/g, ' ');
    s = s.replace(/[\\/:*?"<>|]/g, '_');
    s = s.replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
    if (maxLen) s = s.slice(0, maxLen).replace(/[. ]+$/g, '');
    if (RESERVED_NAME_RE.test(s)) s = '_' + s;
    return s || '未命名';
  }

  // 组装 "文件夹/子文件夹/文件名" 下载路径（每段都清洗，防路径穿越）
  function makePath(folder, name) {
    const segs = String(folder || '')
      .split('/')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const t = sanitizeName(x, 40);
        return t === '未命名' && x !== '未命名' ? '' : t; // 纯点/空段（如 ".."）直接丢弃
      })
      .filter(Boolean);
    return [...segs, sanitizeName(name, 80)].join('/');
  }

  const GIDL = {
    isUgcUrl,
    baseId,
    withSizeParam,
    toOriginalUrl,
    extFromMime,
    sanitizeName,
    makePath,
    pairPerfCandidates
  };

  if (typeof globalThis !== 'undefined') globalThis.GIDL = GIDL;
  if (typeof module !== 'undefined' && module.exports) module.exports = GIDL;
})();
