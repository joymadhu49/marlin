// Adds an "Add to Marlin" button on Chrome Web Store item pages.
(() => {
  const ID_RE = /\/detail\/(?:[^/]+\/)?([a-p]{32})/;
  let shownFor = null;

  function render() {
    const m = location.pathname.match(ID_RE);
    const old = document.getElementById('marlin-install');
    if (!m) { old?.remove(); shownFor = null; return; }
    if (shownFor === m[1] && old) return;
    old?.remove();
    shownFor = m[1];
    const btn = document.createElement('button');
    btn.id = 'marlin-install';
    btn.textContent = 'Add to Marlin';
    btn.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:2147483647;font:500 14px/1 system-ui,sans-serif;padding:12px 18px;border-radius:10px;border:1px solid #2a2a2e;background:#0b0b0c;color:#fafafa;cursor:pointer;box-shadow:0 8px 30px rgba(0,0,0,.35)';
    btn.onclick = () => {
      btn.disabled = true;
      btn.textContent = 'Installing';
      chrome.runtime.sendMessage({ type: 'install', id: m[1] }, (res) => {
        btn.textContent = res?.ok ? 'Installed in Marlin' : 'Install failed';
        btn.title = res?.text || '';
        setTimeout(() => { btn.disabled = false; if (!res?.ok) btn.textContent = 'Add to Marlin'; }, 4000);
      });
    };
    document.body.appendChild(btn);
  }

  render();
  let last = location.href;
  setInterval(() => { if (location.href !== last) { last = location.href; render(); } }, 500);
})();
