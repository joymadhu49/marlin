// About page. Chromium's own "About" page has no updater behind it, so Marlin
// sends chrome://settings/help here. The platform updater does the work.
const $ = (s) => document.querySelector(s);
const ws = new WebSocket(`ws://127.0.0.1:${self.MARLIN.port}/ws?token=${self.MARLIN.token}`);
const mb = (n) => `${Math.round(n / 1048576)} MB`;

// GitHub release notes arrive as Markdown. Show the opening paragraph and the
// first list as plain text; tables, headings and the rest stay on GitHub.
function markdownSummary(notes) {
  const plain = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`]/g, '').trim();
  const items = [];
  let sub = '', listDone = false;
  for (const line of notes.split(/\r?\n/).map((l) => l.trim())) {
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet && !listDone) { if (plain(bullet[1])) items.push(plain(bullet[1])); continue; }
    if (items.length) listDone = true;
    if (!line || /^(#|\||<|```)/.test(line)) continue;
    if (!sub && !items.length) sub = plain(line);
  }
  return { sub, items: items.slice(0, 8) };
}

function render(u) {
  if (!u) return;
  const busy = ['checking', 'downloading', 'progress', 'extracting', 'installing', 'restarting'].includes(u.event);
  $('#check').disabled = busy;
  $('#update').hidden = !u.version || u.event === 'none';
  $('#install').hidden = !(u.version && u.event === 'available');
  if (u.version) {
    $('#updTitle').textContent = `Marlin ${u.version} is available`;
    $('#updSize').textContent = u.size ? mb(u.size) : '';
    // Release notes are untrusted content; render them as text only.
    const doc = new DOMParser().parseFromString(u.notes || '', 'text/html');
    let items = [...doc.querySelectorAll('li')].map((li) => li.textContent.trim()).filter(Boolean);
    let sub = doc.querySelector('p')?.textContent || '';
    if (!sub && !items.length) ({ sub, items } = markdownSummary(u.notes || ''));
    const notes = $('#updNotes');
    notes.replaceChildren();
    if (sub) notes.append(Object.assign(document.createElement('p'), { textContent: sub }));
    if (items.length) {
      const ul = document.createElement('ul');
      for (const t of items) ul.append(Object.assign(document.createElement('li'), { textContent: t }));
      notes.append(ul);
    }
    if (!sub && !items.length && u.notes) {
      notes.append(Object.assign(document.createElement('p'), { textContent: u.notes }));
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
