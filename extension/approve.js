// Fallback approval screen used when the sidebar is closed.
const id = location.hash.slice(1);
const slot = document.getElementById('slot');
const ws = new WebSocket(`ws://127.0.0.1:${self.MARLIN.port}/ws?token=${self.MARLIN.token}`);
ws.onopen = () => ws.send(JSON.stringify({ type: 'approval_get', id }));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== id) return;
  if (m.type === 'approval') render(m);
  if (m.type === 'approval_done') {
    slot.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = m.ok === null ? 'This request is no longer pending.' : m.ok ? 'Approved. You can close this tab.' : 'Declined. You can close this tab.';
    slot.append(p);
    setTimeout(() => window.close(), 1500);
  }
};
function render(m) {
  slot.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'approval';
  const h = document.createElement('h4');
  h.textContent = `${m.extension} wants you to approve "${m.action}"`;
  const u = document.createElement('p');
  u.textContent = m.url;
  card.append(h, u);
  if (m.screenshot) { const img = new Image(); img.src = `data:image/jpeg;base64,${m.screenshot}`; card.append(img); }
  const row = document.createElement('div');
  row.className = 'row';
  for (const [label, ok, cls] of [['Approve', true, 'btn primary'], ['Decline', false, 'btn']]) {
    const b = document.createElement('button');
    b.className = cls; b.textContent = label;
    b.onclick = () => ws.send(JSON.stringify({ type: 'approval_answer', id, ok }));
    row.append(b);
  }
  card.append(row);
  slot.append(card);
}
