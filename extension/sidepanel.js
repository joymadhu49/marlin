const $ = (s) => document.querySelector(s);
const feed = $('#feed');
const state = { ws: null, busy: false, status: null, tools: new Map(), retry: 0 };

// ---------- connection ----------
function connect() {
  const { port, token } = self.MARLIN || {};
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  state.ws = ws;
  ws.onopen = () => { state.retry = 0; setConn(true); send({ type: 'models' }); };
  ws.onclose = () => { setConn(false); setTimeout(connect, Math.min(5000, 500 * 2 ** state.retry++)); };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}
const send = (msg) => state.ws?.readyState === 1 && state.ws.send(JSON.stringify(msg));
function setConn(on) {
  $('#conn').classList.toggle('on', on);
  $('#conn').title = on ? 'Connected' : 'Offline';
}

// ---------- feed rendering ----------
function add(el) {
  $('#empty')?.remove();
  feed.append(el);
  feed.scrollTop = feed.scrollHeight;
  return el;
}
function div(cls, text) { const d = document.createElement('div'); d.className = cls; if (text != null) d.textContent = text; return d; }

function summarize(name, a = {}) {
  if (a.url) return a.url;
  if (name === 'type') return `${a.ref} "${String(a.text || '').slice(0, 40)}"`;
  if (name === 'fill_secret') return `${a.ref} with ${a.name}`;
  if (name === 'unlock_extension') return `${a.extension} with ${a.secret}`;
  if (a.extension) return a.extension;
  if (a.ref) return a.ref;
  if (a.source) return a.source;
  if (a.key) return a.key;
  if (a.match) return a.match;
  if (a.expression) return a.expression.slice(0, 60);
  if (a.x != null) return `${a.x}, ${a.y}`;
  return Object.keys(a).length ? JSON.stringify(a).slice(0, 60) : '';
}

function toolRow(id, name, args, via) {
  const el = div('tool');
  const head = document.createElement('button');
  head.className = 'tool-head';
  head.append(div('state'), Object.assign(div('name'), { textContent: name }));
  if (via) head.append(Object.assign(div('via'), { textContent: via }));
  head.append(Object.assign(div('args'), { textContent: summarize(name, args) }));
  const pre = document.createElement('pre');
  pre.hidden = true;
  head.onclick = () => { pre.hidden = !pre.hidden; };
  el.append(head, pre);
  if (id) state.tools.set(id, el);
  return add(el);
}

function finishTool(id, ok, text, image) {
  const el = state.tools.get(id);
  if (!el) return;
  el.classList.add(ok ? 'ok' : 'fail');
  el.querySelector('pre').textContent = text || '';
  if (image) {
    const img = new Image();
    img.src = `data:image/png;base64,${image}`;
    img.onclick = () => openLightbox(img.src);
    el.append(img);
    feed.scrollTop = feed.scrollHeight;
  }
}

function approvalCard(m) {
  const card = div('approval');
  card.id = `ap-${m.id}`;
  const h = document.createElement('h4');
  h.textContent = `${m.extension} wants you to approve "${m.action}"`;
  card.append(h, Object.assign(document.createElement('p'), { textContent: m.url }));
  if (m.screenshot) {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${m.screenshot}`;
    img.onclick = () => openLightbox(img.src);
    card.append(img);
  }
  const row = div('row');
  const yes = Object.assign(document.createElement('button'), { className: 'btn primary', textContent: 'Approve' });
  const no = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Decline' });
  yes.onclick = () => send({ type: 'approval_answer', id: m.id, ok: true });
  no.onclick = () => send({ type: 'approval_answer', id: m.id, ok: false });
  row.append(yes, no);
  card.append(row);
  return add(card);
}

function setBusy(b) {
  state.busy = b;
  document.body.classList.toggle('busy', b);
}

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function openLightbox(src) {
  $('#lightbox img').src = src;
  $('#lightbox').hidden = false;
}
$('#lightbox').onclick = () => { $('#lightbox').hidden = true; };

// ---------- messages from the daemon ----------
function handle(m) {
  switch (m.type) {
    case 'status': state.status = m; renderSettings(); setBusy(m.busy); break;
    case 'models': renderModels(m.models); break;
    case 'run_start': setBusy(true); break;
    case 'run_end': setBusy(false); if (m.error) add(div('msg-err', m.error)); break;
    case 'assistant': add(div('msg-ai', m.text)); break;
    case 'tool_start': toolRow(m.id, m.name, m.args); break;
    case 'tool_end': finishTool(m.id, m.ok, m.text, m.image); break;
    case 'external_tool': {
      const el = toolRow(null, m.name, m.args, 'external');
      el.classList.add('ok');
      break;
    }
    case 'approval': if (!document.getElementById(`ap-${m.id}`)) approvalCard(m); break;
    case 'approval_done': {
      const c = document.getElementById(`ap-${m.id}`);
      if (c) {
        c.classList.add('done');
        c.querySelector('.row').replaceWith(Object.assign(div('muted'), { textContent: m.ok ? 'Approved' : 'Declined' }));
      }
      break;
    }
    case 'browser_event': if (!state.busy) add(div('msg-event', m.text)); break;
    case 'toast': toast(m.text); break;
    case 'error': toast(m.text); break;
    case 'reset_done': feed.replaceChildren(); break;
    case 'update_check': toast(m.text); break;
  }
}

// ---------- composer ----------
const input = $('#input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chatForm').requestSubmit(); }
});
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.busy) { send({ type: 'stop' }); return; }
  const text = input.value.trim();
  if (!text) return;
  add(div('msg-user', text));
  send({ type: 'chat', text, model: $('#model').value });
  input.value = '';
  input.style.height = 'auto';
  setBusy(true);
});
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { input.value = c.textContent; $('#chatForm').requestSubmit(); }));
$('#newChat').onclick = () => { send({ type: 'reset' }); };

function renderModels(models) {
  const sel = $('#model');
  const current = state.status?.model;
  const groups = new Map();
  for (const m of models.filter((x) => x.vision)) {
    const p = m.id.split('/')[0];
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(m);
  }
  sel.replaceChildren();
  const order = ['anthropic', 'openai', 'google', 'x-ai', 'qwen', 'meta-llama', 'mistralai'];
  const keys = [...groups.keys()].sort((a, b) => ((order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  for (const k of keys) {
    const og = document.createElement('optgroup');
    og.label = k;
    for (const m of groups.get(k)) og.append(new Option(m.name.replace(/^[^:]+:\s*/, ''), m.id));
    sel.append(og);
  }
  if (current) {
    if (![...sel.options].some((o) => o.value === current)) sel.prepend(new Option(current, current));
    sel.value = current;
  }
}
$('#model').addEventListener('change', (e) => send({ type: 'set_model', model: e.target.value }));

// ---------- settings ----------
$('#openSettings').onclick = () => { $('#settings').hidden = false; send({ type: 'status' }); };
$('#closeSettings').onclick = () => { $('#settings').hidden = true; };

function renderSettings() {
  const s = state.status;
  if (!s) return;
  $('#keyStatus').textContent = s.hasKey ? 'OpenRouter key found. Any model with tool calling works.' : 'No OpenRouter key yet. Paste one below.';
  document.querySelectorAll('#policy button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.signPolicy));
  $('#policyHint').textContent = {
    ask: 'Every wallet confirmation waits for you.',
    smart: 'Agents sign in to sites and sign plain messages alone. Transactions, token approvals and typed data wait for you.',
    allow: 'Agents confirm everything, including transactions. Use only with a test wallet.',
  }[s.signPolicy] || '';

  const sl = $('#secretList');
  sl.replaceChildren();
  if (!s.secrets.length) sl.append(Object.assign(document.createElement('li'), { className: 'empty-row', textContent: 'No secrets stored' }));
  for (const name of s.secrets) {
    const li = document.createElement('li');
    li.append(Object.assign(div('grow'), { textContent: name }));
    const rm = Object.assign(document.createElement('button'), { className: 'link', textContent: 'Remove' });
    rm.onclick = () => send({ type: 'remove_secret', name });
    li.append(rm);
    sl.append(li);
  }

  const el = $('#extList');
  el.replaceChildren();
  if (!s.extensions.length) el.append(Object.assign(document.createElement('li'), { className: 'empty-row', textContent: 'No extensions installed' }));
  for (const x of s.extensions) {
    const li = document.createElement('li');
    const g = div('grow');
    g.append(Object.assign(div(''), { textContent: x.name }), Object.assign(div('sub'), { textContent: x.id }));
    const open = Object.assign(document.createElement('button'), { className: 'link', textContent: 'Open' });
    open.onclick = () => send({ type: 'open_extension', id: x.id });
    const rm = Object.assign(document.createElement('button'), { className: 'link', textContent: 'Remove' });
    rm.onclick = () => send({ type: 'uninstall', id: x.id });
    li.append(g, open, rm);
    el.append(li);
  }

  $('#aboutLine').textContent = `Marlin ${s.version || ''} on Chromium ${s.chromium || ''}`;
  $('#mcpCmd').textContent = s.mcpCommand || '';
  $('#cdpUrl').textContent = s.cdp || '';
  if (s.model && $('#model').value !== s.model && [...$('#model').options].some((o) => o.value === s.model)) $('#model').value = s.model;
}

document.querySelectorAll('#policy button').forEach((b) => b.addEventListener('click', () => send({ type: 'set_policy', policy: b.dataset.v })));
$('#keyForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#keyInput').value.trim(); if (v) { send({ type: 'set_key', key: v }); $('#keyInput').value = ''; toast('Key saved'); } });
$('#secretForm').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ type: 'set_secret', name: $('#secretName').value.trim(), value: $('#secretValue').value });
  $('#secretName').value = ''; $('#secretValue').value = '';
  toast('Secret saved to Keychain');
});
$('#checkUpdate').onclick = () => send({ type: 'check_update' });
$('#installForm').addEventListener('submit', (e) => { e.preventDefault(); send({ type: 'install', source: $('#installInput').value.trim() }); $('#installInput').value = ''; });
document.querySelectorAll('.copy').forEach((b) => b.addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent);
  b.textContent = 'Copied';
  setTimeout(() => { b.textContent = 'Copy'; }, 1200);
}));

connect();
