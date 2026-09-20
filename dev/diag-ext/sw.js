'use strict';

chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('diag.html') });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'GIDL_DIAG_FETCH' && msg.url) {
    (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        const r = await fetch(msg.url, { credentials: 'include', signal: ctrl.signal });
        clearTimeout(t);
        const buf = new Uint8Array(await r.arrayBuffer());
        sendResponse({
          ok: r.ok,
          status: r.status,
          type: r.headers.get('content-type') || '',
          acao: r.headers.get('access-control-allow-origin') || '',
          disposition: r.headers.get('content-disposition') || '',
          bytes: buf.length
        });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
});
