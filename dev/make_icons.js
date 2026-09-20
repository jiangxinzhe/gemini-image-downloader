// 生成扩展图标（16/48/128）：蓝色渐变圆角底 + 白色下载箭头 + 托盘，4x 超采样抗锯齿
// 运行：node dev/make_icons.js（需 Node >= 22.2，用到内置 zlib.crc32）
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 4; // 超采样倍数

function chunk(type, data) {
  const head = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head, data])) >>> 0);
  return Buffer.concat([len, head, data, crc]);
}

function encodePng(width, height, rows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.concat(rows.map((r) => Buffer.concat([Buffer.from([0]), r])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// 圆角矩形内含测试
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// 三角形内含测试（用于箭头头部）
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const sign = (x1, y1, x2, y2) => (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const d1 = sign(ax, ay, bx, by);
  const d2 = sign(bx, by, cx, cy);
  const d3 = sign(cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function makeIcon(size) {
  const W = size * S;
  const c0 = [77, 145, 246];
  const c1 = [11, 87, 208];
  const R = 0.225 * W;

  // 白色前景覆盖层
  const cov = Buffer.alloc(W * W);
  const ax = 0.5 * W, ay = 0.70 * W, bx = 0.26 * W, by = 0.44 * W, cx2 = 0.74 * W, cy2 = 0.44 * W;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      let white = false;
      if (x >= 0.455 * W && x <= 0.545 * W && y >= 0.16 * W && y <= 0.46 * W) white = true;       // 箭杆
      else if (inTri(x, y, ax, ay, bx, by, cx2, cy2)) white = true;                                // 箭头
      else if (inRoundRect(x, y, 0.20 * W, 0.76 * W, 0.80 * W, 0.87 * W, 0.045 * W)) white = true; // 托盘
      if (white) cov[y * W + x] = 1;
    }
  }

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const X = x * S + sx;
          const Y = y * S + sy;
          let rr = 0, gg = 0, bb = 0, aa = 0;
          if (inRoundRect(X, Y, 0, 0, W - 1, W - 1, R)) {
            const t = (X + Y) / (2 * W);
            rr = lerp(c0, c1, t)[0];
            gg = lerp(c0, c1, t)[1];
            bb = lerp(c0, c1, t)[2];
            aa = 255;
          }
          if (cov[Y * W + X]) {
            rr = 255; gg = 255; bb = 255; aa = 255;
          }
          r += rr; g += gg; b += bb; a += aa;
        }
      }
      const n = S * S;
      row[x * 4] = Math.round(r / n);
      row[x * 4 + 1] = Math.round(g / n);
      row[x * 4 + 2] = Math.round(b / n);
      row[x * 4 + 3] = Math.round(a / n);
    }
    rows.push(row);
  }
  return encodePng(size, size, rows);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), makeIcon(s));
  console.log(`icon${s}.png written`);
}
