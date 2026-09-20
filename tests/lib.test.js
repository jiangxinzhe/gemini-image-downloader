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

// —— pairPerfCandidates：网络记录候选按顺序配对，不足则不配 ——
const pairItems = [{ kind: 'generated' }, { kind: 'uploaded' }, { kind: 'generated' }];
const pairCands = [
  { url: 'https://lh3.googleusercontent.com/gg/A=s100', startTime: 20 },
  { url: 'https://lh3.googleusercontent.com/gg/B=s100', startTime: 10 }
];
const paired = G.pairPerfCandidates(pairItems, pairCands);
assert.strictEqual(paired[0], 'https://lh3.googleusercontent.com/gg/B=d'); // startTime 排序后 B 在前
assert.strictEqual(paired[1], '');                                          // 上传图不参与配对
assert.strictEqual(paired[2], 'https://lh3.googleusercontent.com/gg/A=d');
// 候选少于生成图时不配对（防止错位）
assert.deepStrictEqual(
  G.pairPerfCandidates([{ kind: 'generated' }, { kind: 'generated' }], [{ url: 'https://lh3.googleusercontent.com/gg/A=s100', startTime: 1 }]),
  ['', '']
);

console.log('all lib tests passed ✓');
