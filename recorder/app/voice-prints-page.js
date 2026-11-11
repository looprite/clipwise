// The Recognize voices window's page script, moved out of voice-prints.html so
// the page's Content-Security-Policy allows scripts from the bundle's own
// files only (script-src 'self', SAA-243 window hardening). It runs with no
// Node: voice-prints-preload.js is all it reaches of the main process.

// No Node here (SAA-243 window hardening): voice-prints-preload.js's channels.
const ipcRenderer = window.clipwise;
const $ = (id) => document.getElementById(id);

// The statement and the advice above it, as main.js sends them (voice-prints.js
// readStatement and ADVICE): blocks of two kinds only, every string put in as
// textContent, so nothing the file holds can become markup. A statement that
// could not be read (null) is said so, and "Turn on" is off.
const STATEMENT_TAGS = new Set(['p', 'ul']);
function drawStatement(statement, advice) {
  $('advice').textContent = typeof advice === 'string' ? advice : '';
  const box = $('statement');
  box.replaceChildren();
  for (const b of (statement && statement.blocks) || []) {
    if (!STATEMENT_TAGS.has(b.tag)) continue;
    const el = document.createElement(b.tag);
    if (b.tag === 'ul') {
      for (const item of b.items || []) {
        const li = document.createElement('li');
        li.textContent = item;
        el.appendChild(li);
      }
    } else {
      el.textContent = b.text;
    }
    box.appendChild(el);
  }
  const shown = box.childElementCount > 0;
  $('statement-error').textContent = shown ? '' : "The statement couldn't be loaded";
  $('on').disabled = !shown;
}

// Checked rows, by person id (SAA-275 part 1). Kept across redraws, and
// pruned to the prints the store still lists.
const picked = new Set();
let lastData = null;

// What the selection bar shows, in order, from how many prints are checked:
// nothing with none, as Recent meetings does. The page's own, so it loads no
// module; check-voice-prints.js runs this copy.
function selbarItems(pickedCount) {
  return pickedCount > 0 ? ['count', 'delete', 'clear'] : [];
}

function deletePrints(personIds) {
  ipcRenderer.send('voice-prints:delete', { personIds: Array.from(personIds) });
}

// The bottom button (SAA-275, the 11-10 finding): while any print is checked
// it is "Delete N…", the selection bar's action, so it can't be read as acting
// on the checked prints while it turns everything off. With none checked it is
// "Turn off and delete prints" again. check-voice-prints.js runs this copy.
function offButton(pickedCount) {
  return pickedCount > 0
    ? { label: `Delete ${pickedCount}…`, action: 'delete' }
    : { label: 'Turn off and delete prints', action: 'disable' };
}

// Also run on each checkbox change, so the bottom button follows the checks.
function renderSelbar() {
  $('off').textContent = offButton(picked.size).label;
  const bar = $('selbar');
  bar.textContent = '';
  const items = selbarItems(picked.size);
  bar.hidden = items.length === 0;
  for (const item of items) {
    if (item === 'count') {
      const s = document.createElement('span');
      s.textContent = `${picked.size} selected`;
      bar.appendChild(s);
    } else if (item === 'delete') {
      const d = document.createElement('button');
      d.className = 'small danger';
      d.textContent = `Delete ${picked.size}…`;
      d.addEventListener('click', () => deletePrints(picked));
      bar.appendChild(d);
    } else if (item === 'clear') {
      const c = document.createElement('button');
      c.className = 'small';
      c.textContent = 'Clear';
      c.addEventListener('click', () => { picked.clear(); render(lastData); });
      bar.appendChild(c);
    }
  }
}

function render(data) {
  lastData = data;
  drawStatement(data && data.statement, data && data.advice);
  const on = !!(data && data.enabled);
  $('prints').hidden = !on;
  $('on').hidden = on;
  $('later').hidden = on;
  $('off').hidden = !on;
  $('done').hidden = !on;
  const list = $('list');
  list.textContent = '';
  if (!on) { picked.clear(); renderSelbar(); return; }
  const people = (data.profiles && data.profiles.people) || [];
  const self = data.profiles && data.profiles.self;
  const listed = new Set(people.map((p) => p.personId));
  for (const id of Array.from(picked)) if (!listed.has(id)) picked.delete(id);
  const row = (label, count, personId) => {
    const r = document.createElement('div');
    r.className = 'row';
    // A person's print can be checked; "You" has no checkbox and no Delete.
    if (personId) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'pick';
      box.checked = picked.has(personId);
      box.setAttribute('aria-label', 'Select this voice print');
      box.addEventListener('change', () => { if (box.checked) picked.add(personId); else picked.delete(personId); renderSelbar(); });
      r.appendChild(box);
    }
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
      del.addEventListener('click', () => deletePrints([personId]));
      r.appendChild(del);
    }
    list.appendChild(r);
  };
  if (self) row('You', self.count, null);
  for (const p of people) row(p.name || 'Someone (no name kept)', p.count, p.personId);
  if (!self && people.length === 0) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'None yet. A print is kept once you name someone on two calls.';
    list.appendChild(e);
  }
  renderSelbar();
}

// The version of the statement this page showed, never one of its own.
$('on').addEventListener('click', () => {
  const statement = lastData && lastData.statement;
  if (!statement || $('on').disabled) return;
  ipcRenderer.send('voice-prints:enable', { statementVersion: statement.version });
});
$('off').addEventListener('click', () => { if (offButton(picked.size).action === 'delete') deletePrints(picked); else ipcRenderer.send('voice-prints:disable'); });
$('later').addEventListener('click', () => window.close());
$('done').addEventListener('click', () => window.close());
ipcRenderer.on('voice-prints:data', (_e, data) => render(data));
ipcRenderer.send('voice-prints:ready');
