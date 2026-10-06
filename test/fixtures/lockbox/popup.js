const go = () => { if (document.getElementById('pw').value === 'hunter2-test') { document.getElementById('locked').hidden = true; document.getElementById('open').hidden = false; } };
document.getElementById('unlock').onclick = go;
document.getElementById('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
document.getElementById('confirm').onclick = () => { document.getElementById('status').textContent = 'Signed'; };
