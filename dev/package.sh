#!/usr/bin/env bash
# 发布打包：统一正斜杠路径 + LF 换行 + 固定清单（修 P3-7 zip 反斜杠问题）
# 用法：bash dev/package.sh [版本号]  （默认取 manifest.json 的 version）
# 产物：dist/gemini-image-downloader-v<版本>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:-$(node -p "require('./manifest.json').version")}"
OUT="dist/gemini-image-downloader-v${VER}.zip"

node -e '
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const ver = process.argv[1], out = process.argv[2];
const FILES = ["manifest.json","lib.js","save-lib.js","content.js","background.js","popup.js","popup.html","popup.css","saver.js","saver.html","saver.css","icons/icon16.png","icons/icon48.png","icons/icon128.png"];

// —— 纯 node zip 写出（store 目录条目 + deflate 文件，正斜杠路径）——
function crc32(buf) {
  let t = crc32.table;
  if (!t) {
    t = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  }
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}
const chunks = [], central = [];
let offset = 0;
function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function add(name, data) {
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = compressed.length < data.length;
  const body = useDeflate ? compressed : data;
  const { time, date } = dosTime(new Date());
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); // UTF-8 flag
  h.writeUInt16LE(useDeflate ? 8 : 0, 8); h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12);
  h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  chunks.push(h, nameBuf, body);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
  c.writeUInt16LE(useDeflate ? 8 : 0, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14);
  c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
  central.push(c, nameBuf);
  offset += 30 + nameBuf.length + body.length;
}
for (const f of FILES) {
  if (!fs.existsSync(f)) { console.error("缺少文件: " + f); process.exit(1); }
  let data = fs.readFileSync(f);
  if (f.endsWith(".js") || f.endsWith(".json") || f.endsWith(".html") || f.endsWith(".css")) data = Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
  add(f, data);
}
const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(FILES.length, 8); eocd.writeUInt16LE(FILES.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([...chunks, centralBuf, eocd]));

// manifest 版本一致性断言
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
if (m.version !== ver) { console.error("manifest 版本 " + m.version + " 与 " + ver + " 不符"); process.exit(1); }
console.log("✓ " + out + " (" + Math.round(fs.statSync(out).size / 1024) + " KB, " + FILES.length + " files)");
' "$VER" "$OUT"

# 正斜杠路径验证（P3-7 断言）
if unzip -l "$OUT" 2>/dev/null | grep -q '\\'; then echo "✗ zip 内含反斜杠路径" >&2; exit 1; fi
echo "✓ 路径分隔符 / 验证通过"
unzip -l "$OUT" | tail -4
