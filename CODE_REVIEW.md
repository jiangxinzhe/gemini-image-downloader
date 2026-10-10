# gemini-image-downloader (gemini-download) 只读代码审查报告

- **审查对象**：`gemini-download`（发布包名称为 `gemini-image-downloader`）
- **版本基线**：v1.9.3（Git commit `9a35ceb`）及 `dist/gemini-image-downloader-v1.9.3.zip`
- **审查日期**：2026-10-10
- **审查方式**：静态源码只读审查（未修改任何文件、未执行未授权代码）

---

## 审查背景与范围

1. **项目定位**：
   - 目标应用为用于 Chromium 内核浏览器的 MV3 扩展，用于从 `gemini.google.com` 批量提取并下载高清图片。
   - 仓库内对应目录为 `gemini-download/`。
   - 涉及核心文件：`lib.js`、`save-lib.js`、`content.js`、`background.js`、`popup.js`、`saver.js`、`manifest.json`。
2. **重点关注**：
   - 会导致错误行为的 Bug、边界条件与异常处理
   - 安全、权限、隐私与数据完整性
   - 兼容性、回归风险、并发与性能
   - 关键场景测试缺口

---

## 发现的问题

按严重程度排序。

### 1. `hasTime()` 从未定义，保存管线在主要场景下直接抛错
- **严重程度**：P1 高
- **位置**：`gemini-download/save-lib.js:262`（另涉及 276、292、306、318、340 行；第 225 行定义了 `deadline` 却未被使用）
- **问题**：
  - `save-lib.js` 在多处分支判断中使用了 `hasTime()`，但全项目（包括已打包的 `dist/gemini-image-downloader-v1.9.3.zip`）均未定义该函数。
  - 当第 1 层（弹窗直连）和第 2 层（后台 Service Worker 抓取）未获取到图片时，代码执行至 `if (!blob && !isBlobSrc && hasTime())` 或后续判断，会直接抛出未捕获的 `ReferenceError: hasTime is not defined`。
  - **实际影响**：
    1. **新版 Gemini 对话图片几乎全部受损**：根据 README 说明，新版 Gemini 图片多数为内存 `blob:` 地址。弹窗与后台环境均无法跨上下文直接 fetch 页面内部的 `blob:`，因而必将进入第 3~6 层逻辑；但因抛出未捕获异常，后续降级逻辑全部中断。
    2. **原生截获与浏览器下载兜底失效**：v1.9.0 引入的原生截获通道以及最后的浏览器下载兜底均被跳过。
    3. 每张受影响图片均被直接记入失败列表，首个报错显示为 `hasTime is not defined`。
- **建议**：
  在 `save-lib.js` 的 `deadline` 定义下方（约第 226 行）补充声明：
  ```javascript
  const hasTime = () => Date.now() < deadline;
  ```
  并在 CI/开发流中引入 `no-undef` 静态检查。

---

### 2. `saver.js` 调用裸 `saveToDir` 导致保存页全部失败，且会提前清除任务
- **严重程度**：P1 高
- **位置**：`gemini-download/saver.js:159`；`gemini-download/saver.js:46`
- **问题**：
  - `saveToDir` 仅作为 `GIDLS.saveToDir` 导出，`saver.js` 作用域内未定义裸 `saveToDir` 函数。
  - **实际影响**：
    1. 弹窗被系统意外关闭后的“一键续存”功能打开 `saver.html` 执行时，每张图片保存都会抛出 `ReferenceError: saveToDir is not defined`，全部保存失败。
    2. 页面内选图面板的“完成并下载”按钮（`content.js:280-285`）同样通过打开 `saver.html` 执行，也会导致 100% 失败。
    3. `saver.js:46` 在开始处理前就执行了 `await chrome.storage.session.remove('saveJob')`。一旦执行失败，已记录的任务丢失，用户重新打开弹窗也无法看到续存入口。“重试失败项”按钮调用的仍是该未定义函数，导致重试无效。
  - 这是 v1.9.0 提取 `save-lib.js` 共享模块时遗留的调用未同步问题。
- **建议**：
  1. 将 `saver.js:159` 的 `saveToDir(dir, it, taken)` 修改为 `GIDLS.saveToDir(dir, it, taken)`。
  2. 调整 `saveJob` 生命周期：保存成功完成后再清除，或在保存过程中实时更新已完成集合。

---

### 3. 发布 Zip 内文件路径使用反斜杠 `\`，macOS 环境可能无法正常解压使用（推测）
- **严重程度**：P2 中（推测）
- **位置**：`gemini-download/dist/gemini-image-downloader-v1.9.3.zip`（归档条目如 `icons\icon128.png`）
- **问题**：
  - ZIP 文件规范要求路径分隔符统一使用正斜杠 `/`。当前发布的 zip 包在 Windows 环境下打包，内部使用了 Windows 风格的反斜杠 `\`。
  - 在 macOS 系统下，默认的“归档实用工具”（Archive Utility）解压此类 zip 时，往往会将 `icons\icon16.png` 识别为单个包含反斜杠的文件名放置在根目录下，而不会自动创建 `icons` 目录。
  - 这将导致 `manifest.json` 引用的图标路径失效，Chromium 浏览器加载已解压扩展程序时会报错阻断。README 中明确声明支持 macOS 并推荐下载 Releases zip，存在跨平台安装失败风险。
- **建议**：
  规范打包流程，使用跨平台工具（如 Node.js 脚本、`git archive` 或 7-Zip 并配置统一正斜杠路径）生成发布包。

---

### 4. 原生下载截获（v1.9.0 核心特性）因 Payload 缺失 `id` 从未被激活
- **严重程度**：P2 中
- **位置**：
  - `gemini-download/popup.js:381-388`
  - `gemini-download/content.js:271-278`
  - `gemini-download/save-lib.js:292`
- **问题**：
  - `save-lib.js:292` 中原生下载截获的准入条件为：
    ```javascript
    if (!blob && hasTime() && item.blobUrl && item.id)
    ```
  - 但在 `popup.js` 和 `content.js` 组装下载数据时：
    ```javascript
    const payload = chosen.map((it, k) => ({
      url: it.origUrl,
      blobUrl: /^(blob:|data:image\/)/i.test(it.src || '') ? it.src : '',
      perfUrl: it.perfUrl || '',
      w: it.w || 0,
      h: it.h || 0,
      name: `${base}_${String(k + 1).padStart(digits, '0')}`
      // 遗漏了 id
    }));
    ```
  - 传入的 `item` 对象中均缺少 `id` 属性，导致 `item.id` 始终为 `undefined`。
  - **实际影响**：
    即使第 1 个问题（`hasTime`）修复，第 5 级原生下载截获通道也会被静默跳过，沦为无法执行的死代码。用户在处理 blob 图片时只能依赖低分辨率的页面预览图。
- **建议**：
  在 `popup.js:387` 及 `content.js:277` 的映射对象中补充属性：`id: it.id`。

---

### 5. 原生截获逻辑存在并发错配风险，且缺少承诺的宽高比校验
- **严重程度**：P2 中
- **位置**：
  - `gemini-download/content.js:345-356`
  - `gemini-download/save-lib.js:156-157`
  - `gemini-download/save-lib.js:340`
- **问题**：
  1. 内容脚本通过监听 `__gidl_capture` 事件获取主世界 hook 截获的图片，判别依据为“捕获时间在点击之后，且大小大于等于 100KB”。但主世界 hook 拦截了全局所有 `image/*` fetch 及大于 200KB 的 `createObjectURL`。若页面在后台并发懒加载或渲染其他消息图片，极易将其他图片误判为当前截获项。
  2. `save-lib.js:340` 明确跳过了原生截获与预览图的对比判断（`viaNative` 条件），且整个截获链路缺少对获取图像真实分辨率或宽高比的校验。CHANGES.md 中声明的“宽高比与字节大小双重校验”在原生截获链路中并未落地。
  3. 点击 Gemini 原生下载按钮（`btn.click()`）会同时触发浏览器默认下载行为，可能导致用户默认下载目录中多出一份重复下载的文件。
- **建议**：
  1. 对截获获取的 Blob 通过 `createImageBitmap` 提取宽高比，与原图元数据进行比对校验。
  2. 结合 URL 特征或上下文信息进一步约束匹配规则，避免单纯依靠时间戳过滤。

---

### 6. 续存逻辑会重复写入已下载的文件，与文档承诺不符
- **严重程度**：P2 中
- **位置**：
  - `gemini-download/popup.js:405`、`popup.js:478`
  - `gemini-download/saver.js:153-159`
  - `gemini-download/save-lib.js:178-193`
- **问题**：
  - `saveJob` 中存储的是整批图片的初始列表，任务执行过程中从未剔除已完成项。
  - 当任务中断后再次触发续存时，会从第 1 张图片重新执行。
  - `uniqueInDir` 遇到已存在的目标文件名时，会自动重命名为 `xxx (1).png` 继续写入，不会判定为“已保存则跳过”。
  - README 中声明的“已保存的文件不会重复下载，中断后可一键续存”在当前代码实现中并不成立，会导致磁盘生成大量重复命名文件。
- **建议**：
  在单张图片保存成功后，实时从 `storage.session` 的 `saveJob.items` 中移除该项，或维护一个 `completedItemIds` 列表。续存时仅调度未完成项。

---

### 7. 异常响应或重定向 HTML 存在被误当做图片写入磁盘的风险（推测）
- **严重程度**：P2 中（推测）
- **位置**：
  - `gemini-download/save-lib.js:227-234`
  - `gemini-download/content.js:700-708`
  - `gemini-download/save-lib.js:353`
- **问题**：
  - `content.js` 处理 `GIDL_BLOB_DATA` 时，直接执行 `const blob = await resp.blob()`，未校验 `resp.ok` 与响应状态码，403/404 等错误页面内容会被当作图片数据返回。
  - `save-lib.js` 第 1 层 `fetchAsBlob` 与第 2 层仅检查了 `resp.ok`，未校验 `Content-Type` 是否为合法图片。若原图请求经过重定向最终返回 200 状态码的 HTML 登录页，会被作为 Blob 接收。
  - 接收非图片内容后，`G.extFromMime('text/html')` 返回空，进而兜底追加 `.png` 后缀写入磁盘。写入后该图被判定为保存成功，阻断了后续降级尝试。
- **建议**：
  在获取 Blob 之后统一校验 `blob.type.startsWith('image/')` 与 `blob.size > 0`。若不满足，则判定当前层失败，继续降级。

---

### 8. 后台下载队列模式提前广播“完成”，后续中断无法感知
- **严重程度**：P2 中
- **位置**：`gemini-download/background.js:104-110`
- **问题**：
  - `chrome.downloads.download` 仅表示下载任务已成功派发至浏览器下载管理器，并非下载完成。
  - `background.js` 在所有任务派发后仅等待固定的 800ms，便直接将 `state.running` 设为 `false`，并广播 `GIDL_DL_DONE`。
  - 若部分大图下载耗时较长或后续因网络中断失败，用户界面已提前显示“完成”，后续失败状态无法正确反馈。
  - 同时，如果此时开启新批次，`inflight.clear()` 会直接清空上一批次未完结任务的追踪记录。
- **建议**：
  监听 `chrome.downloads.onChanged` 事件，当且仅当 `state.settled === state.total` 时再发送 `GIDL_DL_DONE` 事件，并设置合理超时作为安全兜底。

---

### 9. 页面 `blob:` 内存地址交由 `chrome.downloads` 处理大概率失败（推测）
- **严重程度**：P2 中（推测，基于 Chrome 跨环境 Blob URL 权限机制）
- **位置**：
  - `gemini-download/content.js:623`
  - `gemini-download/background.js:63-72`
  - `gemini-download/save-lib.js:332-335`
- **问题**：
  - 新版 Gemini 页面生成的图片地址为属于 `gemini.google.com` 来源的 `blob:` URL。
  - 扩展背景 Service Worker 及 `chrome.downloads` API 无法跨源直接访问网页主上下文创建的 Blob URL。
  - 在选择“浏览器下载”模式或进入第 7 级兜底时，直接将该 `blob:` 传给 `chrome.downloads.download` 会导致下载直接失败。
- **建议**：
  对属于 `blob:` 协议的图片，必须先由内容脚本读取字节并转为 data URL，或通过扩展自身上下文重新构建 Blob URL，再交由下载管理器处理。

---

### 10. 多 Gemini 标签页并存时，消息可能被派发至非目标标签页
- **严重程度**：P2 中
- **位置**：`gemini-download/save-lib.js:56-70`、`save-lib.js:107-110`
- **问题**：
  - `save-lib.js` 中的 `sendToGemini` 与 `installNativeHook` 采用 `chrome.tabs.query` 查询匹配的标签页，并默认取第 1 个（`tabs[0]`）或循环发送。
  - 如果用户同时打开了多个 Gemini 页面（例如一个用于提问、一个用于查看旧历史），保存操作可能会将请求发至未执行图片扫描的标签页。
  - 由于 `imgMap` 仅缓存在执行过扫描的那个标签页的 `content.js` 中，发往其他标签页会导致查找不到图片，原生截获及上下文抓取均会失败。
- **建议**：
  在弹窗启动保存时，将当前激活标签页的 `tabId` 固化并随 `payload` 传递至保存方法中，所有通信均定向发给指定的 `tabId`。

---

### 11. Performance API 网络记录配对存在跨会话错配风险（推测）
- **严重程度**：P2 中（推测）
- **位置**：
  - `gemini-download/content.js:297-321`
  - `gemini-download/lib.js:66-76`
- **问题**：
  - Gemini 为 SPA（单页应用），切换对话会话时浏览器的 Performance 资源条目不会自动清空。
  - 若候选图片数量大于当前对话生成的图片数量，算法会按抓取时间取前 N 个候选进行配对，极易匹配到上一个对话残留的资源。
  - 宽高比校验对常见的 1:1 图片缺乏区分能力，而后续大小对比逻辑又倾向于字节更大的原图，可能导致保存下来的图片实际上是另一会话的内容。
- **建议**：
  增加会话切换时间戳过滤，或仅在候选数量与生成图数量完全一致时启用配对；优先使用 DOM 中的实际地址，避免纯顺序配对。

---

### 12. 主世界 Hook 内存驻留及全局污染
- **严重程度**：P3 低
- **位置**：`gemini-download/save-lib.js:117-150`
- **问题**：
  - 注入主世界的 Hook 全局改写了 `window.fetch` 与 `URL.createObjectURL`，并在 `state.blobs` 中长期缓存最多 40 个 Blob 引用。
  - 原图 Blob 体积较大（通常每张数兆字节），即使页面内部已调用 `revokeObjectURL`，由于扩展 Hook 内部引用未释放，会导致内存无法被垃圾回收，长会话下存在内存泄漏风险。
- **建议**：
  仅在执行截获的短时间内激活捕获逻辑，截获完成后及时清空引用。

---

### 13. 保存页未对已选目录进行有效性探测
- **严重程度**：P3 低（修好第 2 个问题后暴露）
- **位置**：`gemini-download/saver.js:57-68`、`saver.js:169`
- **问题**：
  - `saver.js` 初始化时直接读取 IndexedDB 句柄并仅检查 `queryPermission`，未同步引入 v1.9.1 中新增的目录遍历探测逻辑。
  - 若所选目录在外部被删除或移动，无法在启动时拦截，且抛出的异常未能引导用户重新触发目录选择。
- **建议**：
  统一调用 `GIDLS.getGrantedDir()` 进行目录可用性验证。

---

### 14. 右键菜单对 `blob:` 图片静默失效
- **严重程度**：P3 低
- **位置**：`gemini-download/background.js:277-280`
- **问题**：
  - 右键菜单下载在点击时通过 `G.isUgcUrl` 进行校验。
  - 新版 Gemini 页面的 `blob:` 图片无法通过该校验，函数直接 `return`，用户点击菜单后无任何提示与响应。
- **建议**：
  若遇到 `blob:` 图片，通过消息通信通知内容脚本在页面上下文中完成提取与保存，或弹出明确提示。

---

## 关键场景测试缺口与建议验证命令

### 现有测试覆盖情况
- 仓库当前仅有 `tests/lib.test.js`，且仅覆盖了 `lib.js` 的部分纯函数（URL 转换、路径清洗、基础配对）。
- `save-lib.js`、`saver.js`、`content.js` 及 `background.js` 均没有任何自动化测试，导致严重影响核心保存流程的 `hasTime is not defined` 与 `saveToDir is not defined` 两个 P1 缺陷未能被及时发现。

### 建议执行的验证与检查命令（只读/检查）

1. **运行现有纯函数单元测试**：
   ```bash
   node tests/lib.test.js
   ```

2. **使用 ESLint 检查未定义变量（可直接捕获两个 P1 问题）**：
   ```bash
   npx eslint --no-eslintrc --env browser,es2022,webextensions \
     --global GIDL,GIDLS,importScripts \
     --rule '{"no-undef":"error"}' \
     save-lib.js saver.js popup.js content.js background.js
   ```

3. **检查 Release ZIP 的目录分隔符格式**：
   ```bash
   unzip -l dist/gemini-image-downloader-v1.9.3.zip
   ```

4. **关键人工验证场景建议**：
   - 在包含新版 `blob:` 图片的 Gemini 对话中使用“选文件夹”模式保存。
   - 打开“页面内选图”浮层面板，勾选后点击“完成并下载”。
   - 在弹窗保存过程中主动关闭弹窗，重新打开并点击“一键续存”。
   - 在浏览器中同时打开两个不同的 Gemini 会话标签页，分别执行扫描与下载。
   - 在 macOS 环境下解压发布的 zip 包并尝试加载为已解压扩展。

---

## 改进建议

1. **发布前强制集成静态语法与未定义变量检查（优先级：高）**
   - **收益**：以极低成本阻断 `hasTime`、`saveToDir` 等由于重构提取模块遗漏引入的运行时致命错误。
2. **为核心保存管线增加带 Mock 的轻量测试（优先级：高）**
   - **收益**：`saveToDir` 逻辑复杂（7 层降级），改动频繁。通过 Mock `chrome.*`、`fetch` 与 FileSystem API，覆盖多层降级、目录失效与文件去重分支，保障核心功能稳定性。
3. **统一封装“网络资源获取与校验”底层方法（优先级：中）**
   - **收益**：消除 7 层降级中重复的 fetch、AbortController 与 data URL 转换代码，统一收口 `resp.ok` 与 MIME 类型白名单检查，避免非图片内容落盘。
4. **完善保存任务状态存储与目标标签页绑定（优先级：中）**
   - **收益**：记录正在执行的 `tabId` 和已完成项集合，彻底解决多标签页串扰问题，并保证续存时真正做到“跳过已保存文件”。
5. **规范自动化打包构建脚本（优先级：中）**
   - **收益**：统一 Zip 包路径分隔符为正斜杠 `/`，确保 Windows 与 macOS 跨平台兼容性，避免发布流程出现低级打包瑕疵。
6. **修订文档中与实现不一致的表述（优先级：低）**
   - **收益**：修正 README 与 CHANGES 中关于“已保存文件自动跳过”、“双重校验”等与代码现状脱节的描述，降低后续维护和排查成本。
