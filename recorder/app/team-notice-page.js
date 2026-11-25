// The "Team members…" window's page script (Gate 1, item 2; SAA-348).
// It runs with no Node: team-notice-preload.js is all it reaches of the main
// process. main.js sends the heading and one row per member, already written
// (team-notice.js), or an error, and after each Add or Remove a result; this
// draws them as text, with textContent only, so nothing in a name or an
// address can become markup. Add sends what was typed and the role picked;
// Remove sends the row's address. main.js checks both and asks before any
// removal; nothing here changes anything by itself.

const ipc = window.clipwise;
const $ = (id) => document.getElementById(id);
let busy = false;

function setBusy(on) {
  busy = on;
  for (const el of [$('email'), $('role'), $('add-button'), ...document.querySelectorAll('#list button')]) el.disabled = on;
}

function start() {
  $('result').replaceChildren();
  $('result').className = '';
  setBusy(true);
}

function render(data) {
  const d = data || {};
  $('heading').textContent = d.heading || '';
  $('error').textContent = d.error || '';
  // No Add while the list could not be loaded: signed out, not an admin, or no answer.
  $('add').hidden = !!d.error;
  const rows = Array.isArray(d.rows) ? d.rows : Array.isArray(d.lines) ? d.lines.map((line) => ({ line, email: '' })) : [];
  const list = $('list');
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = String(row.line);
    li.appendChild(text);
    if (row.email) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove…';
      remove.disabled = busy;
      remove.addEventListener('click', () => {
        if (busy) return;
        start();
        ipc.send('team-notice:remove', { email: row.email });
      });
      li.appendChild(remove);
    }
    list.appendChild(li);
  }
  $('empty').textContent = !d.error && rows.length === 0 ? 'No members yet.' : '';
}

function showResult(result) {
  const r = result || {};
  const box = $('result');
  box.replaceChildren();
  box.className = r.ok === false ? 'error' : '';
  for (const line of Array.isArray(r.lines) ? r.lines : []) {
    const p = document.createElement('p');
    p.textContent = String(line);
    box.appendChild(p);
  }
  // A successful Add starts the next one fresh: no address, and Member again.
  if (r.ok && r.clear) {
    $('email').value = '';
    $('role').value = 'member';
  }
  setBusy(false);
}

function add() {
  if (busy) return;
  const email = $('email').value.trim();
  if (!email) { showResult({ ok: false, lines: ['Type an email address first.'] }); return; }
  start();
  ipc.send('team-notice:add', { email, role: $('role').value });
}

$('add-button').addEventListener('click', add);
$('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
ipc.on('team-notice:data', (_event, data) => render(data));
ipc.on('team-notice:result', (_event, result) => showResult(result));
ipc.send('team-notice:ready');
