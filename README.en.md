# Gemini Image Batch Downloader (Chrome Extension)

English | [中文](README.md)

Batch-download images from [gemini.google.com](https://gemini.google.com) conversations as original files. Works on **Windows and macOS** with Chromium-based browsers such as Chrome / Edge / Brave (Chrome 102+).

## Features

- 📦 **Batch download**: automatically scans all images in the current conversation (✦ AI-generated / ↑ user-uploaded / • other), pick them and save with one click
- 📁 **Pick a folder once, save the whole batch**: the default "choose folder" mode pops the directory picker only once, writes all images of the batch directly into it, and remembers it (no prompts again within the same browser session)
- 🖼️ **Multi-channel original recovery**: converts page thumbnail URLs to original URLs (`=d`) and uses several channels (network-record pairing, page-side byte conversion, native download interception) to get the best available quality
- 🖱️ **In-page selection**: when popup thumbnails are blocked, select images directly on a floating panel inside the Gemini page (uses the images already displayed, always visible)
- 📜 **Scroll & collect**: for long conversations the extension sweeps the whole conversation screen by screen
- 🖱️ **Context-menu download**: right-click any image → "Download original Gemini image"
- 📝 **Auto naming**: named as `Conversation_Title_01`, deduplicated against existing files
- 👁️ **Progress & diagnostics**: progress bar, per-kind counters, failure reason chain, and one-click resume after interruption

## Installation

### Option 1: Download from Releases (recommended)

1. Open the [Releases](../../releases) page of this repository and download the latest `gemini-image-downloader-vX.X.X.zip`
2. Extract it to any directory (keep the extracted folder, don't delete it)
3. Open `chrome://extensions` (or `edge://extensions` on Edge)
4. Turn on the **Developer mode** toggle in the top-right corner
5. Click **Load unpacked** and select the extracted folder
6. (Optional) Pin the extension icon to the toolbar

### Option 2: Load from source (developers)

Clone this repository and load the repository root directory via "Load unpacked".

> After installing or updating the extension, **refresh any open Gemini tabs**.

## Usage

1. Open a Gemini conversation that contains generated images
2. Click the extension icon in the toolbar — the popup scans the conversation and lists **all images** (generated ones are pre-selected)
3. For long conversations, click "**⬇ Scroll & scan**" to sweep the whole conversation
4. Pick the images you want (click a card to toggle; ↗ previews the original in a new tab); "select in page" is also available
5. Click "**Download selected**" — everything happens inside the popup:
   - **Choose folder (default)**: the directory picker pops once; the whole batch is written directly into it and the folder is remembered; switch anytime via "Change folder"
   - **Browser download**: uses the regular Chrome download flow into `Downloads/GeminiImages/`

Keep the popup open while saving (clicking elsewhere closes it and interrupts the batch); already-saved files are skipped on retry, and a "resume" entry appears after an interruption.

## How it works

- **Classic pages**: generated images are `https://lh3.googleusercontent.com/gg/…=w640-h640` URLs; the `=w…h…` suffix is only a display-size hint — replacing it with `=d` fetches the original-resolution file
- **New pages**: some conversations serve images as in-memory `blob:` URLs; the extension routes bytes through the Gemini page itself
- **Original recovery**: a fallback chain — server original URL → network-record pairing → native download interception → page preview image — with aspect-ratio validation and byte-size comparison so the best available quality always wins

Everything runs locally: image URLs are only used to download directly from Google's image servers. No data is collected, uploaded, or tracked — no analytics of any kind.

## Known limitations

- **Original resolution**: on current Gemini pages, conversation images are in-memory previews and original URLs are not exposed in the DOM. The extension tries hard to recover originals, but in some environments only the preview (~few hundred KB) can be saved. Known issue, channels keep improving
- Veo-generated **videos** are not downloaded (images only)
- The page auto-scrolls once during deep scan, then restores your position
- Scanning is capped at 500 images per pass
- Chromium-based browsers only (Chrome / Edge / Brave, etc.); **Firefox and Safari are not supported**

## FAQ

- **"No images found"**: make sure the active tab is a gemini.google.com conversation with images visible; use "Scroll & scan" for long conversations
- **Scan fails after updating the extension**: refresh the Gemini tab (content scripts need re-injection)
- **No directory picker pops up**: a previously chosen folder is still remembered and authorized, so saving starts directly; click "Change folder" to switch
- **Popup closed mid-save**: the batch is interrupted, already-saved files are skipped; a "resume" entry appears the next time you open the popup
- **Scan breaks after a Gemini redesign**: the content script relies on custom element tags such as `<model-response>`; update `MODEL_TAGS` at the top of `content.js` to adapt

## Repository layout

```
gemini-downloader/
├── manifest.json       # MV3 manifest
├── lib.js              # Shared helpers (URL transforms, filename sanitizing, original pairing)
├── save-lib.js         # Save pipeline library (multi-channel byte fetching, dedup naming)
├── content.js          # Content script: scanning, deep sweep, in-page panel
├── background.js       # Service worker: download queue, context menu, badge
├── popup.html/css/js   # Popup UI: scan, select, save in place
├── saver.html/css/js   # Batch save page (fallback): used for resuming interrupted batches
├── icons/
├── dev/                # Dev helpers (previews, icon generator, diagnostic extension)
└── tests/              # node unit tests (node tests/lib.test.js)
```

## Development

```bash
node tests/lib.test.js     # unit tests
node dev/make_icons.js     # regenerate icons
```

`dev/preview.html` and `dev/panel-preview.html` can be opened directly in a browser to preview the popup and the in-page selection panel.

## License

[MIT](LICENSE)
