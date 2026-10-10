// 单元测试：node tests/lib.test.js
'use strict';
const assert = require('assert');
const G = require('../lib.js');

// —— toOriginalUrl：尺寸后缀 → =d 原图 ——
assert.strictEqual(
  G.toOriginalUrl('https://lh3.googleusercontent.com/gg/ABC123=w640-h640'),
  'https://lh3.googleusercontent.com/gg/ABC123=d'
);
assert.strictEqual(
  G.toOriginalUrl('https://lh3.googleusercontent.com/gg/ABC123=w640-h640?authuser=0'),
  'https://lh3.googleusercontent.com/gg/ABC123=d?authuser=0'
);
assert.strictEqual(
  G.toOriginalUrl('https://lh3.googleusercontent.com/gg/ABC123'),
  'https://lh3.googleusercontent.com/gg/ABC123=d'
);
assert.strictEqual(
  G.toOriginalUrl('https://lh3.googleusercontent.com/gg/ABC123=s0?x=1'),
  'https://lh3.googleusercontent.com/gg/ABC123=d?x=1'
);
// 非 googleusercontent 不动
assert.strictEqual(G.toOriginalUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
assert.strictEqual(G.toOriginalUrl(''), '');
assert.strictEqual(G.toOriginalUrl('data:image/png;base64,xxx'), 'data:image/png;base64,xxx');

// —— baseId：同一张图不同尺寸去重 ——
assert.strictEqual(
  G.baseId('https://lh3.googleusercontent.com/gg/ABC123=w800-h800'),
  'https://lh3.googleusercontent.com/gg/ABC123'
);
assert.strictEqual(
  G.baseId('https://lh3.googleusercontent.com/gg/ABC123=w800-h800'),
  G.baseId('https://lh3.googleusercontent.com/gg/ABC123=s320?authuser=0')
);

// —— extFromMime ——
assert.strictEqual(G.extFromMime('image/png'), '.png');
assert.strictEqual(G.extFromMime('IMAGE/JPEG; charset=binary'), '.jpg');
assert.strictEqual(G.extFromMime('image/webp'), '.webp');
assert.strictEqual(G.extFromMime('text/html'), '');

// —— sanitizeName / makePath：Windows 非法字符与保留名 ——
assert.strictEqual(G.makePath('Gemini图片/我的 对话?', 'ABC_1'), 'Gemini图片/我的 对话_/ABC_1');
assert.strictEqual(G.makePath('', 'x.png'), 'x.png');
assert.strictEqual(G.makePath('../etc/passwd', 'a'), 'etc/passwd/a'); // 防路径穿越（.. 段被过滤）
assert.strictEqual(G.makePath('a/b//c/', 'n'), 'a/b/c/n');
assert.strictEqual(G.sanitizeName('CON'), '_CON');
assert.strictEqual(G.sanitizeName('lpt1'), '_lpt1');
assert.strictEqual(G.sanitizeName('a<b>c:d"e|f?g*h'), 'a_b_c_d_e_f_g_h');
assert.strictEqual(G.sanitizeName('...'), '未命名');
assert.strictEqual(G.sanitizeName('  '), '未命名');
assert.strictEqual(G.sanitizeName('很长的标题'.repeat(30), 40).length, 40);

// —— isUgcUrl ——
assert.strictEqual(G.isUgcUrl('https://lh3.googleusercontent.com/gg/x=1'), true);
assert.strictEqual(G.isUgcUrl('https://jfk.objects.lifesciences.googleusercontent.com/x'), true);
assert.strictEqual(G.isUgcUrl('https://googleusercontent.com.evil.com/x'), false);
assert.strictEqual(G.isUgcUrl('https://www.gstatic.com/x'), false);

// —— checkImageBlob：MIME 白名单（非 image/* 或空内容判失败） ——
assert.strictEqual(G.checkImageBlob({ type: 'image/png', size: 100 }), true);
assert.strictEqual(G.checkImageBlob({ type: 'IMAGE/WEBP', size: 1 }), true);
assert.strictEqual(G.checkImageBlob({ type: 'text/html', size: 100 }), false);
assert.strictEqual(G.checkImageBlob({ type: '', size: 100 }), false);
assert.strictEqual(G.checkImageBlob({ type: 'image/png', size: 0 }), false);
assert.strictEqual(G.checkImageBlob(null), false);

// —— pairPerfCandidates：baseId 精确匹配优先，剩余按顺序配对（需已知 w/h），候选不足不配 ——
const pairItems = [
  { id: 'https://lh3.googleusercontent.com/gg/B', kind: 'generated', w: 100, h: 100 }, // 精确匹配 B
  { kind: 'uploaded', w: 100, h: 100 },                                              // 上传图不参与
  { kind: 'generated', w: 100, h: 100 },                                             // 顺序配对剩余候选
  { kind: 'generated' }                                                              // w/h 未知：不配对
];
const pairCands = [
  { url: 'https://lh3.googleusercontent.com/gg/B=s100', startTime: 20 },
  { url: 'https://lh3.googleusercontent.com/gg/A=s100', startTime: 10 },
  { url: 'https://lh3.googleusercontent.com/gg/C=s100', startTime: 30 }
];
const paired = G.pairPerfCandidates(pairItems, pairCands);
assert.strictEqual(paired[0], 'https://lh3.googleusercontent.com/gg/B=d'); // baseId 精确匹配（跨 startTime 顺序）
assert.strictEqual(paired[1], '');                                          // 上传图不参与配对
assert.strictEqual(paired[2], 'https://lh3.googleusercontent.com/gg/A=d'); // 剩余候选按 startTime 顺序（B 已被精确匹配占用）
assert.strictEqual(paired[3], '');                                          // w/h 未知不配对（无宽高比校验把关）
// 顺序配对候选不足时不配（防止错位）；精确匹配不受此限
assert.deepStrictEqual(
  G.pairPerfCandidates(
    [{ kind: 'generated', w: 1, h: 1 }, { kind: 'generated', w: 1, h: 1 }],
    [{ url: 'https://lh3.googleusercontent.com/gg/A=s100', startTime: 1 }]
  ),
  ['', '']
);
assert.strictEqual(
  G.pairPerfCandidates(
    [{ id: 'https://lh3.googleusercontent.com/gg/A', kind: 'generated' }],
    [{ url: 'https://lh3.googleusercontent.com/gg/A=s100', startTime: 1 }]
  )[0],
  'https://lh3.googleusercontent.com/gg/A=d' // w/h 未知但 baseId 精确匹配：允许
);

console.log('all lib tests passed ✓');
