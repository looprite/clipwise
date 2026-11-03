// The Recognize voices window's page script, moved out of voice-prints.html so
// the page's Content-Security-Policy allows scripts from the bundle's own
// files only (script-src 'self', SAA-243 window hardening). It runs with no
// Node: voice-prints-preload.js is all it reaches of the main process.

// No Node here (SAA-243 window hardening): voice-prints-preload.js's channels.
const ipcRenderer = window.clipwise;
// The statement on this page (see the comment at the top).
const STATEMENT_VERSION = 1;
const $ = (id) => document.getElementById(id);

function render(data) {
  const on = !!(data && data.enabled);
  $('prints').hidden = !on;
  $('on').hidden = on;
  $('later').hidden = on;
  $('off').hidden = !on;
  $('done').hidden = !on;
  const list = $('list');
  list.textContent = '';
  if (!on) return;
  const people = (data.profiles && data.profiles.people) || [];
  const self = data.profiles && data.profiles.self;
  const row = (label, count, personId) => {
    const r = document.createElement('div');
    r.className = 'row';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = label;
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = `${count} ${count === 1 ? 'call' : 'calls'}`;
    who.appendChild(c);
    r.appendChild(who);
    if (personId) {
      const del = document.createElement('button');
      del.className = 'small danger';
      del.textContent = 'Delete';
      del.addEventListener('click', () => ipcRenderer.send('voice-prints:delete', { personId }));
      r.appendChild(del);
    }
    list.appendChild(r);
  };
  if (self) row('You', self.count, null);
  for (const p of people) row(p.name || 'Someone (no name kept)', p.count, p.personId);
  if (!self && people.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'None yet. A print is kept once you name someone on a call.';
    list.appendChild(e);
  }
}

$('on').addEventListener('click', () => ipcRenderer.send('voice-prints:enable', { statementVersion: STATEMENT_VERSION }));
$('off').addEventListener('click', () => ipcRenderer.send('voice-prints:disable'));
$('later').addEventListener('click', () => window.close());
$('done').addEventListener('click', () => window.close());
ipcRenderer.on('voice-prints:data', (_e, data) => render(data));
ipcRenderer.send('voice-prints:ready');
