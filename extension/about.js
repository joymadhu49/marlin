// About page. Chromium's own "About" page has no updater behind it, so Marlin
// sends chrome://settings/help here. Sparkle does the work; this page shows it.
const $ = (s) => document.querySelector(s);
const ws = new WebSocket(`ws://127.0.0.1:${self.MARLIN.port}/ws?token=${self.MARLIN.token}`);
const mb = (n) => `${Math.round(n / 1048576)} MB`;

function render(u) {
  if (!u) return;
  const busy = ['checking', 'downloading', 'progress', 'extracting', 'installing', 'restarting'].includes(u.event);
  $('#check').disabled = busy;
  $('#update').hidden = !u.version || u.event === 'none';
  $('#install').hidden = !(u.version && u.event === 'available');
  if (u.version) {
    $('#updTitle').textContent = `Marlin ${u.version} is available`;
    $('#updSize').textContent = u.size ? mb(u.size) : '';
    // Release notes come from our own signed appcast; render them as text lists only.
    const doc = new DOMParser().parseFromString(u.notes || '', 'text/html');
    const items = [...doc.querySelectorAll('li')].map((li) => li.textContent.trim()).filter(Boolean);
    const sub = doc.querySelector('p')?.textContent || '';
    const notes = $('#updNotes');
    notes.replaceChildren();
    if (sub) notes.append(Object.assign(document.createElement('p'), { textContent: sub }));
    if (items.length) {
      const ul = document.createElement('ul');
      for (const t of items) ul.append(Object.assign(document.createElement('li'), { textContent: t }));
      notes.append(ul);
    }
  }
  const showBar = ['downloading', 'progress', 'extracting', 'installing', 'restarting'].includes(u.event);
  $('#bar').hidden = !showBar;
  $('#barFill').style.width = `${u.event === 'progress' ? u.percent : ['extracting', 'installing', 'restarting'].includes(u.event) ? 100 : 2}%`;
  $('#status').textContent = {
    checking: 'Checking for updates',
    none: 'Marlin is up to date.',
    error: u.message || 'Update check failed.',
    downloading: 'Downloading',
    progress: `Downloading ${u.percent || 0}%`,
    extracting: 'Verifying and unpacking',
    installing: 'Installing',
    restarting: 'Marlin will close and reopen in a moment.',
  }[u.event] || '';
}

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'status') {
    $('#ver').textContent = m.version || 'unknown';
    $('#chromium').textContent = m.chromium || 'unknown';
    render(m.update);
  }
  if (m.type === 'update_status') render(m);
};
ws.onclose = () => { if (!$('#status').textContent.includes('reopen')) $('#status').textContent = 'Marlin is not running.'; };
$('#check').onclick = () => ws.send(JSON.stringify({ type: 'check_update' }));
$('#install').onclick = () => ws.send(JSON.stringify({ type: 'install_update' }));
