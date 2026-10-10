#!/usr/bin/env bash
# 发布前门禁：单测 + 语法 + ESLint no-undef（拦未定义引用，如 hasTime / saveToDir 断链）
# 用法：bash dev/lint.sh   （在仓库根目录执行）
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/4 单元测试 =="
node tests/lib.test.js
node tests/save-lib.test.js

echo "== 2/4 语法检查 =="
for f in lib.js save-lib.js content.js background.js popup.js saver.js; do
  node --check "$f"
done

echo "== 3/4 ESLint no-undef =="
npx --yes --registry="${NPM_REGISTRY:-https://registry.npmmirror.com}" eslint@8 --no-eslintrc \
  --env browser,es2022,webextensions \
  --global GIDL,GIDLS,importScripts,module \
  --rule '{"no-undef":"error"}' \
  lib.js save-lib.js content.js background.js popup.js saver.js

echo "== 4/4 done ✓ 全部通过 =="
