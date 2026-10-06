// About page. Chromium's own "About" page has no updater behind it, so Marlin
// sends chrome://settings/help here and updates through Sparkle instead.
const $ = (s) => document.querySelector(s);
const ws = new WebSocket(`ws://127.0.0.1:${self.MARLIN.port}/ws?token=${self.MARLIN.token}`);
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'status') {
    $('#ver').textContent = m.version || 'unknown';
    $('#chromium').textContent = m.chromium || 'unknown';
  }
  if (m.type === 'update_check') $('#status').textContent = m.text;
};
ws.onclose = () => { $('#status').textContent = 'Marlin is not running.'; };
$('#check').onclick = () => {
  $('#status').textContent = 'Checking';
  ws.send(JSON.stringify({ type: 'check_update' }));
};
