// The Recent meetings window's page script, moved out of meetings.html so the
// page's Content-Security-Policy allows scripts from the bundle's own files
// only (script-src 'self', SAA-243 window hardening). It runs with no Node:
// meetings-preload.js is all it reaches of the main process.

// No Node here (SAA-243 window hardening): meetings-preload.js's channels.
const ipcRenderer = window.clipwise;

// The All / Work / Personal switch. A row with no scope recorded matches
// neither Work nor Personal, so it shows under All only. The page's own, so it
// loads no module (SAA-243 window hardening); check-meetings.js runs this copy.
function filterRows(rows, filter) {
  return filter === 'work' || filter === 'personal' ? rows.filter((r) => r.scope === filter) : rows;
}
const listEl = document.getElementById('list');
const filterEl = document.getElementById('filter');
const viewEl = document.getElementById('view');
const selbarEl = document.getElementById('selbar');
const subEl = document.getElementById('sub');

// All / Work / Personal (filterRows: a row with no scope shows under All only).
const FILTERS = [['all', 'All'], ['work', 'Work'], ['personal', 'Personal']];
let filter = 'all';
let view = 'meetings'; // 'meetings' | 'trash'
let last = { rows: [], trashed: [], saving: false, busy: false };
// Checked rows, by stem. Kept across the 5-second refresh, and pruned to
// what the current view still lists.
const picked = new Set();
let openMenu = null; // stem whose ⋯ menu is open

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function dayLabel(ms) {
  const d = new Date(ms);
  const mid = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const ago = Math.round((mid(new Date()) - mid(d)) / 86400000);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (ago <= 0) return `Today · ${date}`;
  if (ago === 1) return `Yesterday · ${date}`;
  return date;
}

function durationLabel(sec) {
  if (!sec) return '';
  if (sec < 60) return '<1 min';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

// Why a button is off, shown when hovering it.
const SAVE_OFF = {
  nospeech: 'Nothing to save: no speech was captured.',
  failed: "This capture couldn't be processed.",
  pending: 'Still being processed.',
  unknown: "The server hasn't said how processing ended. It will be asked again.",
};

function renderView() {
  viewEl.textContent = '';
  const trashCount = last.trashed.length;
  for (const [key, label] of [['meetings', 'Meetings'], ['trash', trashCount ? `Trash (${trashCount})` : 'Trash']]) {
    const b = el('button', null, label);
    b.dataset.view = key;
    b.setAttribute('aria-pressed', String(key === view));
    b.addEventListener('click', () => { view = key; picked.clear(); openMenu = null; renderView(); render(); });
    viewEl.appendChild(b);
  }
}

function renderFilter() {
  filterEl.textContent = '';
  filterEl.style.display = view === 'meetings' ? '' : 'none';
  for (const [key, label] of FILTERS) {
    const b = el('button', null, label);
    b.dataset.filter = key;
    b.setAttribute('aria-pressed', String(key === filter));
    b.addEventListener('click', () => { filter = key; picked.clear(); renderFilter(); render(); });
    filterEl.appendChild(b);
  }
}

function send(channel, stems) { ipcRenderer.send(channel, { stems: Array.from(stems) }); picked.clear(); openMenu = null; }

// What the selection bar shows, in order, from the view and how many rows are
// picked and listed. The Trash view offers Select all whenever it lists one
// not yet picked, even with none picked (SAA-262); Meetings is as before. The
// page's own, so it loads no module; check-meetings.js runs this copy.
function selbarItems(view, pickedCount, listedCount) {
  const all = view === 'trash' && listedCount > 0 && pickedCount < listedCount ? ['select-all'] : [];
  if (pickedCount === 0) return all;
  const acts = view === 'meetings' ? ['move'] : ['restore', 'delete'];
  return ['count', ...all, ...acts, 'clear'];
}

function renderSelbar(listed) {
  for (const s of Array.from(picked)) if (!listed.has(s)) picked.delete(s);
  selbarEl.textContent = '';
  const items = selbarItems(view, picked.size, listed.size);
  selbarEl.classList.toggle('on', items.length > 0);
  const busy = last.busy;
  for (const item of items) {
    if (item === 'count') {
      selbarEl.appendChild(el('span', null, `${picked.size} selected`));
    } else if (item === 'select-all') {
      // Every row the Trash lists, not only those on screen: Delete then goes
      // through the same confirmation (the first 10 named, the rest counted).
      const a = el('button', null, 'Select all');
      a.disabled = busy;
      a.addEventListener('click', () => { for (const s of listed) picked.add(s); render(); });
      selbarEl.appendChild(a);
    } else if (item === 'move') {
      const t = el('button', null, `Move ${picked.size} to trash`);
      t.disabled = busy;
      t.addEventListener('click', () => send('meetings:trash', picked));
      selbarEl.appendChild(t);
    } else if (item === 'restore') {
      const r = el('button', null, `Restore ${picked.size}`);
      r.disabled = busy;
      r.addEventListener('click', () => send('meetings:restore', picked));
      selbarEl.appendChild(r);
    } else if (item === 'delete') {
      const d = el('button', 'danger', `Delete ${picked.size} permanently…`);
      d.disabled = busy;
      d.addEventListener('click', () => send('meetings:delete', picked));
      selbarEl.appendChild(d);
    } else if (item === 'clear') {
      const c = el('button', null, 'Clear');
      c.addEventListener('click', () => { picked.clear(); render(); });
      selbarEl.appendChild(c);
    }
  }
}

function checkbox(stem, enabled) {
  const box = el('input', 'pick');
  box.type = 'checkbox';
  box.checked = picked.has(stem);
  box.disabled = !enabled;
  box.setAttribute('aria-label', 'Select this meeting');
  box.addEventListener('change', () => { if (box.checked) picked.add(stem); else picked.delete(stem); renderSelbar(listedNow); });
  return box;
}

let listedNow = new Set();

function render() {
  const { saving, busy } = last;
  listEl.textContent = '';
  subEl.textContent = view === 'meetings'
    ? 'The past 7 days. Pick a meeting to save its transcript or fix who said what.'
    : 'Moved to trash. Claude no longer finds these. Restore one, or delete it permanently.';
  renderFilter();
  if (view === 'trash') return renderTrash(busy);

  const rows = filterRows(last.rows, filter);
  listedNow = new Set(rows.filter((r) => r.canTrash).map((r) => r.stem));
  renderSelbar(listedNow);
  if (rows.length === 0) {
    const msg = last.rows.length === 0
      ? 'No meetings in the past 7 days.'
      : `No ${filter} meetings in the past 7 days.`;
    listEl.appendChild(el('div', null, msg)).id = 'empty';
    return;
  }
  let lastDay = null;
  for (const r of rows) {
    const day = dayLabel(r.startedAtMs);
    if (day !== lastDay) { listEl.appendChild(el('div', 'day', day)); lastDay = day; }
    const d = new Date(r.startedAtMs);
    const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const dur = durationLabel(r.durationSec);

    const row = el('div', r.canSave ? 'row' : 'row dim');
    row.dataset.stem = r.stem;
    row.appendChild(checkbox(r.stem, r.canTrash && !busy));
    const main = el('div', 'main');
    const top = el('div', 'top');
    top.appendChild(el('span', 'title', r.title || 'Untitled'));
    top.appendChild(el('span', 'when', [date, time, dur].filter(Boolean).join(' · ')));
    main.appendChild(top);
    main.appendChild(r.participants.length
      ? el('div', 'people', r.participants.join(', '))
      : el('div', 'people none', 'No one named'));
    if (r.line) main.appendChild(el('div', 'line', r.line));
    row.appendChild(main);

    const acts = el('div', 'acts');
    const save = el('button', null, 'Save transcript');
    save.disabled = !r.canSave || saving;
    save.title = r.canSave ? '' : SAVE_OFF[r.state] || '';
    save.addEventListener('click', () => ipcRenderer.send('meetings:save', { stem: r.stem }));
    acts.appendChild(save);
    // Only a call with several voices has names to fix; otherwise no button.
    if (r.canFix) {
      const fix = el('button', null, 'Fix names');
      fix.addEventListener('click', () => ipcRenderer.send('meetings:fix', { stem: r.stem }));
      acts.appendChild(fix);
    }
    // ⋯ menu: Change attendees (when it has a saved answer), and
    // Move to trash (not while the capture is still processing).
    const wrap = el('div', 'menuwrap');
    const more = el('button', null, '⋯');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', String(openMenu === r.stem));
    more.setAttribute('aria-label', 'More actions');
    more.disabled = !r.canTrash || busy;
    more.title = r.canTrash ? '' : 'Still being processed.';
    more.addEventListener('click', (e) => { e.stopPropagation(); openMenu = openMenu === r.stem ? null : r.stem; render(); });
    wrap.appendChild(more);
    if (openMenu === r.stem) {
      const menu = el('div', 'menu');
      menu.setAttribute('role', 'menu');
      if (r.canChangeIdentity) {
        const c = el('button', null, 'Change attendees…');
        c.setAttribute('role', 'menuitem');
        c.addEventListener('click', () => { openMenu = null; render(); ipcRenderer.send('meetings:change-identity', { stem: r.stem }); });
        menu.appendChild(c);
      }
      const t = el('button', null, 'Move to trash');
      t.setAttribute('role', 'menuitem');
      t.addEventListener('click', () => send('meetings:trash', [r.stem]));
      menu.appendChild(t);
      wrap.appendChild(menu);
    }
    acts.appendChild(wrap);
    row.appendChild(acts);
    listEl.appendChild(row);
  }
}

function renderTrash(busy) {
  const rows = last.trashed;
  listedNow = new Set(rows.map((r) => r.stem));
  renderSelbar(listedNow);
  if (rows.length === 0) {
    listEl.appendChild(el('div', null, 'The trash is empty.')).id = 'empty';
    return;
  }
  for (const r of rows) {
    const d = new Date(r.startedAtMs);
    const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const dur = durationLabel(r.durationSec);
    const row = el('div', 'row dim');
    row.dataset.stem = r.stem;
    row.appendChild(checkbox(r.stem, !busy));
    const main = el('div', 'main');
    const top = el('div', 'top');
    top.appendChild(el('span', 'title', r.title || 'Untitled'));
    top.appendChild(el('span', 'when', [date, time, dur].filter(Boolean).join(' · ')));
    main.appendChild(top);
    main.appendChild(r.participants.length
      ? el('div', 'people', r.participants.join(', '))
      : el('div', 'people none', 'No one named'));
    if (r.partial) main.appendChild(el('div', 'line', 'A permanent delete was interrupted — delete it again to finish.'));
    row.appendChild(main);
    const acts = el('div', 'acts');
    const restore = el('button', null, 'Restore');
    restore.disabled = busy || r.partial;
    restore.title = r.partial ? 'Its files are already deleted.' : '';
    restore.addEventListener('click', () => send('meetings:restore', [r.stem]));
    acts.appendChild(restore);
    const del = el('button', 'danger', 'Delete permanently…');
    del.disabled = busy;
    del.addEventListener('click', () => send('meetings:delete', [r.stem]));
    acts.appendChild(del);
    row.appendChild(acts);
    listEl.appendChild(row);
  }
}

// Click anywhere else, or Escape, closes an open ⋯ menu.
document.addEventListener('click', () => { if (openMenu) { openMenu = null; render(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenu) { openMenu = null; render(); } });

renderView();
renderFilter();
ipcRenderer.on('meetings:data', (_e, payload) => {
  last = { rows: payload.rows, trashed: payload.trashed || [], saving: payload.saving, busy: !!payload.busy };
  renderView();
  render();
});
ipcRenderer.send('meetings:ready');
