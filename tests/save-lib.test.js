// saveToDir 集成测试：stub chrome / fetch / 目录句柄，覆盖 7 层降级的关键分支
// 运行：node tests/save-lib.test.js
'use strict';
const assert = require('assert');

// —— 测试基建：内存 Blob / 目录句柄 / chrome ——
const PNG_DATAURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HTML_DATAURL = 'data:text/html;base64,' + Buffer.from('<html>login</html>').toString('base64');

function makeBlob(type, size) {
  const data = Buffer.alloc(Math.max(1, size), 7);
  return { type, size: data.length, arrayBuffer: async () => data.buffer };
}

function makeDir(existing, written) {
  return {
    name: 'test',
    keys: async function* () { /* probe 成功即视为存在 */ },
    getFileHandle: async (name, opts) => {
      if (opts && opts.create) {
        written.push(name);
        return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
      }
      if (existing.has(name)) return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
      throw Object.assign(new Error("A file or folder with the specified name wasn't found — could not be found"), { name: 'NotFoundError' });
    }
  };
}

function stubChrome({ fetchImpl, msgReply, downloaded, geminiTabs } = {}) {
  const downloads = [];
  const runtimeMsgs = [];
  globalThis.chrome = {
    downloads: { download: async (o) => { downloads.push(o); return downloads.length; } },
    runtime: { sendMessage: async (m) => { runtimeMsgs.push(m); return msgReply ? msgReply(m) : null; } },
    scripting: { executeScript: async () => [] },
    tabs: {
      query: async () => geminiTabs || [],
      sendMessage: async () => { throw new Error('no receiver'); }
    }
  };
  globalThis.fetch = fetchImpl;
  return { downloads, runtimeMsgs };
}

// 每个用例独立加载 save-lib，避免相互污染
function freshLib() {
  delete require.cache[require.resolve('../save-lib.js')];
  delete require.cache[require.resolve('../lib.js')];
  globalThis.GIDL = require('../lib.js');
  return require('../save-lib.js');
}

const ITEM = { id: 'i1', url: 'https://lh3.googleusercontent.com/gg/abc=w640', blobUrl: '', perfUrl: '', w: 100, h: 100, name: 't_1' };

async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; }
}

(async () => {
  // —— 1. 第 1 层直连成功 → 直存写盘，via=direct ——
  await t('L1 直连成功：写盘 via=direct', async () => {
    stubChrome({ fetchImpl: async (u) => ({ ok: true, blob: async () => makeBlob('image/png', 500) }) });
    const written = [];
    const r = await freshLib().saveToDir(makeDir(new Set(), written), { ...ITEM }, new Set());
    assert.strictEqual(r.via, 'direct');
    assert.strictEqual(r.orig, false);
    assert.strictEqual(written.length, 1);
    assert.ok(written[0].startsWith('t_1'));
  });

  // —— 2. 全链失败 + 服务器地址 → 第 7 层浏览器下载兜底 ——
  await t('L1-L6 全失败（服务器地址）：回落浏览器下载 via=browser', async () => {
    stubChrome({ fetchImpl: async () => { throw new Error('fetch failed'); }, msgReply: () => ({ error: 'stub' }) });
    const r = await freshLib().saveToDir(makeDir(new Set(), []), { ...ITEM }, new Set());
    assert.strictEqual(r.via, 'browser');
  });

  // —— 3. blob 型图全链失败 → 明确抛错，不再把 blob: 交给 downloads ——
  await t('blob 图全失败：抛错且不调 downloads（P2-10）', async () => {
    const { downloads } = stubChrome({
      fetchImpl: async () => { throw new Error('fetch failed'); },
      msgReply: (m) => (m.type === 'GIDL_FETCH' ? { error: 'stub' } : null)
    });
    const blobItem = { ...ITEM, url: 'blob:https://gemini.google.com/x', blobUrl: 'blob:https://gemini.google.com/x' };
    await assert.rejects(
      () => freshLib().saveToDir(makeDir(new Set(), []), blobItem, new Set()),
      /页面内存图取字节失败/
    );
    assert.strictEqual(downloads.length, 0);
  });

  // —— 4. MIME 校验：200 的 text/html 不再被当图片（P2-5）——
  await t('L1 返回 200 text/html：判失败，降级到 L2 dataUrl 成功', async () => {
    stubChrome({
      fetchImpl: async (u) => {
        if (String(u).startsWith('data:')) {
          const isHtml = String(u).startsWith('data:text/html');
          return { ok: true, blob: async () => (isHtml ? makeBlob('text/html', 100) : makeBlob('image/png', 900)) };
        }
        return { ok: true, blob: async () => makeBlob('text/html', 100) }; // L1 返回登录页
      },
      msgReply: () => ({ ok: true, dataUrl: HTML_DATAURL }) // L2 后台也返回 HTML
    });
    const r = await freshLib().saveToDir(makeDir(new Set(), []), { ...ITEM }, new Set());
    assert.strictEqual(r.via, 'browser'); // L1/L2 都被判非图片 → 走兜底
  });

  // —— 5. L2 dataUrl 返回真图片 → 直存成功 ——
  await t('L2 后台 dataUrl（image/png）：直存成功', async () => {
    stubChrome({
      fetchImpl: async (u) => ({ ok: true, blob: async () => makeBlob(String(u).startsWith('data:image') ? 'image/png' : 'text/html', 900) }),
      msgReply: (m) => (m.type === 'GIDL_FETCH' ? { ok: true, dataUrl: PNG_DATAURL } : { error: 'no' })
    });
    const written = [];
    const r = await freshLib().saveToDir(makeDir(new Set(), written), { ...ITEM }, new Set());
    assert.strictEqual(r.via, 'direct');
    assert.strictEqual(written.length, 1);
  });

  // —— 6. 目录失效（NotFoundError）→ 清除记忆并抛引导错误 ——
  await t('写盘 NotFoundError：抛「保存位置已失效」引导重选（v1.9.1 行为保持）', async () => {
    stubChrome({ fetchImpl: async () => ({ ok: true, blob: async () => makeBlob('image/png', 500) }) });
    const lib = freshLib();
    const dir = makeDir(new Set(), []);
    dir.getFileHandle = async () => { throw Object.assign(new Error('not found'), { name: 'NotFoundError' }); };
    await assert.rejects(
      () => lib.saveToDir(dir, { ...ITEM }, new Set()),
      /保存位置已失效/
    );
  });

  // —— 7. 去重：已存在同名文件 → base (1).ext ——
  await t('uniqueInDir：同名文件自动加 (1)', async () => {
    stubChrome({ fetchImpl: async () => ({ ok: true, blob: async () => makeBlob('image/png', 500) }) });
    const lib = freshLib();
    const existing = new Set(['t_1.png']);
    const written = [];
    const r = await lib.saveToDir(makeDir(existing, written), { ...ITEM }, new Set());
    assert.strictEqual(r.via, 'direct');
    assert.strictEqual(written[0], 't_1 (1).png');
  });

  // —— 8. saveJob 语义（纯逻辑）：persistJob 剩余项过滤 ——
  await t('剩余项过滤：完结一张少一张', async () => {
    stubChrome({ fetchImpl: async () => ({ ok: true, blob: async () => makeBlob('image/png', 500) }) });
    const payload = [{ ...ITEM }, { ...ITEM, name: 't_2' }];
    let remaining = payload.slice();
    for (const it of payload) {
      await freshLib().saveToDir(makeDir(new Set(), []), it, new Set());
      remaining = remaining.filter((x) => x !== it);
    }
    assert.strictEqual(remaining.length, 0);
  });

  if (process.exitCode) console.error('\nsave-lib tests FAILED');
  else console.log('all save-lib tests passed ✓');
})();
