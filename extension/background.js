importScripts('config.js');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Install requests from the Web Store button go straight to the Marlin daemon.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'install') return;
  fetch(`http://127.0.0.1:${self.MARLIN.port}/tools/install_extension`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${self.MARLIN.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: msg.id }),
  })
    .then((r) => r.json())
    .then((j) => sendResponse({ ok: !j.error, text: j.error || j.text.split('\n')[0] }))
    .catch((e) => sendResponse({ ok: false, text: e.message }));
  return true;
});
