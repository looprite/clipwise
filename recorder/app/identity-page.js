// The "Who was on this call?" window's page script, moved out of
// identity.html so the page's Content-Security-Policy allows scripts from the
// bundle's own files only (script-src 'self', SAA-243 window hardening). It
// runs with no Node: identity-preload.js is all it reaches of the main process.

// No Node here (SAA-243 window hardening): identity-preload.js's channels,
// and the rules as page scripts, people-name.js first.
const ipcRenderer = window.clipwise;
const ia = window.identityRules;
const params = new URLSearchParams(window.location.search);
const token = params.get('token');
const MODES = ['stop', 'later', 'correct', 'voices'];
const mode = MODES.includes(params.get('mode')) ? params.get('mode') : 'stop';
const $ = (id) => document.getElementById(id);
const input = $('people-input');

// --- the call line --------------------------------------------------------
function formatDurationCompact(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  const totalSeconds = Math.round(n / 1000);
  if (totalSeconds < 60) return `${totalSeconds} sec`;
  return `${Math.round(totalSeconds / 60)} min`;
}
function formatCaptureStem(stem, durationRaw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(stem || '');
  if (!m) return stem || '';
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  if (Number.isNaN(d.getTime())) return stem;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const daysAgo = Math.round((midnight(now) - midnight(d)) / 86400000);
  let dateForm;
  if (daysAgo <= 0) {
    dateForm = time;
  } else if (daysAgo === 1) {
    dateForm = `Yesterday ${time}`;
  } else if (daysAgo <= 6) {
    dateForm = `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  } else {
    const sameYear = d.getFullYear() === now.getFullYear();
    const dateStr = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
    dateForm = `${dateStr}, ${time}`;
  }
  const duration = formatDurationCompact(durationRaw);
  return `Started ${duration ? `${dateForm} · ${duration}` : dateForm}`;
}
const stem = params.get('stem') || '';
const callLine = $('call-line');
callLine.textContent = formatCaptureStem(stem, params.get('duration'));
callLine.title = stem;

// --- state ----------------------------------------------------------------
let field = null;              // built once identity:init and identity:me answer
let pendingPrefill = null;     // a calendar preview that came before that
let calendarApplied = false;
let hostName = null;
let recentPeople = [];         // the Recent row's people, as the server sent them
let largeShown = false;
let addressBox = null;         // { chipId, text } while an address chip is being named
let voices = null;             // { namingData, diarize } once diarize has split the call
let voicesMessage = null;      // why there will be none
let voicesExpanded = false;
let addingFor = null;          // { voiceIndex, text } while "Add someone…" is open on a row
let savedVoiceNames = [];      // names a rename starts from (voice-names-<stem>.json)
const choices = new Map();     // voiceIndex -> name | null
let saving = false;

// --- search ---------------------------------------------------------------
// The last answered search, so Enter uses what the member just saw. A search
// that could not be answered comes back as { searched: false }.
let lastSearch = { q: null, result: null };
async function runSearch(text) {
  const q = String(text || '').trim();
  let result = null;
  try { result = await ipcRenderer.invoke('identity:search', { token, q }); } catch { result = null; }
  if (!result || !Array.isArray(result.results)) result = { searched: false, results: [] };
  lastSearch = { q, result };
  return result;
}
async function searchFor(text) {
  const q = String(text || '').trim();
  if (lastSearch.q === q && lastSearch.result) return lastSearch.result;
  return runSearch(q);
}
let searchTimer = null;
function searchSoon(text, show) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const result = await runSearch(text);
    show(text, result);
  }, 150);
}

function hint(text, warn) {
  $('field-hint').textContent = text || '';
  $('field-hint').classList.toggle('warn', !!warn);
}
const REFUSED = {
  host: "That's you — you're already on this call.",
  duplicate: 'That name is already on this call.',
  at: "A name can't contain @: type the person's name, not their address.",
};

// --- adding people --------------------------------------------------------
function pick(person) {
  if (!field) return;
  const r = addressBox ? ia.nameAddress(field, addressBox.chipId, person) : ia.addPerson(field, person);
  hint(r.refused ? REFUSED[r.refused] : '', !!r.refused);
  if (!r.refused) {
    if (addressBox) addressBox = null;
    input.value = '';
  }
  render();
}
async function addTypedText(text) {
  if (!field || !String(text).trim()) return true;
  if (ia.saveBlocked([text])) { updateAtBlock(); return false; }
  const result = await searchFor(text);
  const r = ia.addTyped(field, text, result);
  hint(r.refused ? REFUSED[r.refused] : '', !!r.refused);
  if (!r.refused || r.refused === 'host') input.value = '';
  render();
  return !r.refused || r.refused === 'host';
}
async function nameAddressTyped() {
  if (!field || !addressBox) return true;
  const text = addressBox.text || '';
  if (!text.trim()) { addressBox = null; render(); return true; }
  if (ia.saveBlocked([text])) { updateAtBlock(); return false; }
  const result = await searchFor(text);
  const r = ia.nameAddress(field, addressBox.chipId, text, result);
  hint(r.refused ? REFUSED[r.refused] : '', !!r.refused);
  if (!r.refused) addressBox = null;
  render();
  return !r.refused;
}

input.addEventListener('input', () => {
  hint('');
  updateAtBlock();
  const text = input.value;
  if (!text.trim()) { clearTimeout(searchTimer); renderResults(null); renderRecent(); return; }
  searchSoon(text, (q, result) => { if (input.value === q) renderResults(result); });
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // Clears the box and its results; never Skip.
    e.preventDefault();
    e.stopPropagation();
    clearTimeout(searchTimer);
    input.value = '';
    hint('');
    renderResults(null);
    renderRecent();
    updateAtBlock();
    resizeSoon();
    return;
  }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  e.stopPropagation();
  if (input.value.trim()) addTypedText(input.value);
  else save();
});

// --- rendering ------------------------------------------------------------
function el(tag, props = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node[k] = v;
  }
  for (const kid of kids) if (kid) node.appendChild(kid);
  return node;
}

function renderChips() {
  const box = $('chips');
  box.innerHTML = '';
  for (const chip of field.chips) {
    const node = el('span', { className: 'chip', dataset: { tag: chip.tag || '', personId: chip.personId || '' } });
    if (chip.email) node.dataset.email = chip.email;
    if (chip.name) node.dataset.named = '1';
    if (addressBox && addressBox.chipId === chip.id) {
      node.appendChild(el('span', { className: 'name', text: chip.email }));
      const box2 = el('input', { type: 'text', spellcheck: false, placeholder: 'Their name', value: addressBox.text || '' });
      box2.addEventListener('input', () => {
        addressBox.text = box2.value;
        hint('');
        updateAtBlock();
        if (!box2.value.trim()) { renderResults(null); return; }
        searchSoon(box2.value, (q, result) => { if (addressBox && addressBox.text === q) renderResults(result); });
      });
      box2.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); nameAddressTyped(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearTimeout(searchTimer); addressBox = null; renderResults(null); render(); }
      });
      node.appendChild(box2);
      setTimeout(() => box2.focus(), 0);
    } else {
      node.appendChild(el('span', { className: 'name', text: chip.name || chip.email }));
      if (chip.tag) node.appendChild(el('span', { className: 'tag', text: chip.tag }));
      if (chip.email && !chip.name) {
        node.title = 'Click to name them';
        node.addEventListener('click', (e) => {
          if (e.target.closest('.remove')) return;
          addressBox = { chipId: chip.id, text: '' };
          render();
        });
      }
    }
    const remove = el('button', { type: 'button', className: 'remove', text: '×', title: 'Remove' });
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      ia.removeChip(field, chip.id);
      if (addressBox && addressBox.chipId === chip.id) addressBox = null;
      render();
    });
    node.appendChild(remove);
    box.appendChild(node);
  }
}

function renderLarge() {
  const row = $('large');
  const list = $('large-suggestions');
  row.innerHTML = '';
  list.innerHTML = '';
  const label = ia.largeCallLabel(field);
  if (!label) return;
  row.appendChild(el('span', { id: 'large-chip', className: 'large-chip', text: label }));
  const show = el('button', { type: 'button', id: 'show-large', className: 'link', text: largeShown ? 'Hide' : `Show the ${field.large.count}` });
  show.addEventListener('click', () => { largeShown = !largeShown; render(); });
  row.appendChild(show);
  if (!largeShown) return;
  for (const s of ia.largeCallSuggestions(field)) {
    const b = el('button', { type: 'button', text: `+ ${s.name || s.email}` });
    b.addEventListener('click', () => { ia.addSuggestion(field, s); render(); });
    list.appendChild(b);
  }
}

function personButton(p) {
  const b = el('button', { type: 'button', text: p.name, dataset: { personId: p.id } });
  b.addEventListener('click', () => pick(p));
  return b;
}
function renderResults(result) {
  const box = $('results');
  box.innerHTML = '';
  if (!field || !result || !result.searched) return;
  for (const p of ia.filterSuggestions(field, result.results, 4)) box.appendChild(personButton(p));
  resizeSoon();
}
function renderRecent() {
  const box = $('recent');
  box.innerHTML = '';
  if (!field || input.value.trim() || addressBox) return;
  const people = ia.filterSuggestions(field, recentPeople, 4);
  if (people.length === 0) return;
  box.appendChild(el('span', { className: 'label', text: 'Recent:' }));
  for (const p of people) box.appendChild(personButton(p));
}

// The voices part shows on a group call (two or more people named, or a large
// call), and whenever diarize has found two or more voices.
function voicesReady() {
  return !!voices && ia.showVoicesPart(voices.namingData);
}
function groupCall() {
  return field.chips.filter((c) => c.name).length >= 2 || !!field.large;
}
function validVoiceNames() {
  return new Set([...field.chips.filter((c) => c.name).map((c) => c.name), ...savedVoiceNames]);
}
function renderVoices() {
  const part = $('voices-part');
  const finding = $('voices-finding');
  const rowsBox = $('voice-rows');
  const links = $('voices-links');
  rowsBox.innerHTML = '';
  links.innerHTML = '';
  const ready = voicesReady();
  part.hidden = !(ready || groupCall());
  if (!ready) {
    finding.hidden = false;
    finding.textContent = voicesMessage
      || (voices ? 'Only one other voice on this call — nothing to name.' : 'Finding voices…');
    return;
  }
  finding.hidden = true;
  // A chosen name that is no longer on a chip (and was not saved before) is
  // unnamed again.
  const valid = validVoiceNames();
  for (const [i, name] of choices) if (name && !valid.has(name)) choices.set(i, null);
  const { rows, hidden } = ia.voiceRows(voices.namingData, voices.diarize, voicesExpanded ? Infinity : 2);
  for (const row of rows) rowsBox.appendChild(voiceRow(row));
  if (hidden > 0) {
    const more = el('button', { type: 'button', id: 'voices-more', className: 'link', text: `Show them (${hidden} more)` });
    more.addEventListener('click', () => { voicesExpanded = true; render(); });
    links.appendChild(more);
  }
  const leave = el('button', { type: 'button', id: 'leave-all', className: 'link', text: 'Leave all unnamed' });
  leave.addEventListener('click', () => { for (const k of choices.keys()) choices.set(k, null); addingFor = null; render(); });
  links.appendChild(leave);
}

const LINE_WORDS = 20;
function shortLine(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  return words.length > LINE_WORDS ? words.slice(0, LINE_WORDS).join(' ') + '…' : words.join(' ');
}
const clipIndexByVoice = new Map();
let currentAudio = null;
function playClip(voiceIndex, clipPaths) {
  if (currentAudio) { try { currentAudio.pause(); } catch {} currentAudio = null; }
  const i = clipIndexByVoice.get(voiceIndex) || 0;
  currentAudio = new Audio('file://' + clipPaths[i % clipPaths.length]);
  currentAudio.play().catch((err) => console.error('identity: clip playback failed', err));
  clipIndexByVoice.set(voiceIndex, i + 1);
}

const ADD_VALUE = '__add__';
function voiceRow(row) {
  const idx = row.voiceIndex;
  const node = el('div', { className: 'voice-row', dataset: { voice: String(idx) } });
  const top = el('div', { className: 'top' });
  const play = el('button', { type: 'button', className: 'play', text: '▶', title: 'Play a clip' });
  play.disabled = row.clipPaths.length === 0;
  play.addEventListener('click', () => playClip(idx, row.clipPaths));
  top.appendChild(play);
  top.appendChild(el('span', { className: 'label', text: `Voice ${idx}` }));
  top.appendChild(el('span', { className: 'talk', text: row.talk }));

  const select = el('select');
  const current = choices.get(idx) || null;
  const names = ia.voiceOptions(field).filter((o) => o !== ia.LEAVE_UNNAMED && o !== ia.ADD_SOMEONE);
  if (current && !names.includes(current)) names.push(current);
  for (const name of names) select.appendChild(el('option', { value: name, text: name }));
  select.appendChild(el('option', { value: '', text: ia.LEAVE_UNNAMED }));
  select.appendChild(el('option', { value: ADD_VALUE, text: ia.ADD_SOMEONE }));
  select.value = addingFor && addingFor.voiceIndex === idx ? ADD_VALUE : (current || '');
  select.addEventListener('change', () => {
    if (select.value === ADD_VALUE) {
      addingFor = { voiceIndex: idx, text: '' };
    } else {
      if (addingFor && addingFor.voiceIndex === idx) addingFor = null;
      ia.chooseVoice(choices, idx, select.value || null);
    }
    render();
  });
  top.appendChild(select);
  node.appendChild(top);

  const line = (row.lines || [])[0];
  if (line && typeof line.text === 'string' && line.text.trim()) {
    node.appendChild(el('div', { className: 'quote', text: '“' + shortLine(line.text) + '”' }));
  }
  if (addingFor && addingFor.voiceIndex === idx) {
    const box = el('input', { type: 'text', spellcheck: false, placeholder: 'Their name', value: addingFor.text || '' });
    box.addEventListener('input', () => { addingFor.text = box.value; hint(''); updateAtBlock(); });
    box.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); addingFor = null; renderResults(null); render(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      await addSomeoneForVoice();
    });
    node.appendChild(el('div', { className: 'add' }, [box]));
    setTimeout(() => box.focus(), 0);
  }
  return node;
}
async function addSomeoneForVoice() {
  if (!addingFor) return true;
  const text = addingFor.text || '';
  if (!text.trim()) { addingFor = null; render(); return true; }
  if (ia.saveBlocked([text])) { updateAtBlock(); return false; }
  const idx = addingFor.voiceIndex;
  const result = await searchFor(text);
  const r = ia.addTyped(field, text, result);
  hint(r.refused ? REFUSED[r.refused] : '', !!r.refused);
  if (r.refused) { render(); return false; }
  addingFor = null;
  ia.chooseVoice(choices, idx, r.chip.name);
  render();
  return true;
}

// Any text that would carry an @ blocks Save (SAA-221).
function updateAtBlock() {
  const texts = [input.value, addressBox ? addressBox.text : '', addingFor ? addingFor.text : ''];
  const blocked = ia.saveBlocked(texts);
  $('save').disabled = blocked || !field;
  $('at-hint').textContent = blocked ? REFUSED.at : '';
}

function render() {
  if (!field) return;
  renderChips();
  renderLarge();
  if (!input.value.trim() && !(addressBox && addressBox.text)) renderResults(null);
  renderRecent();
  $('new-line').textContent = ia.newNameLine(field) || '';
  renderVoices();
  $('recorded-by').textContent = ia.recordedByLine(hostName);
  updateAtBlock();
  resizeSoon();
}

// --- scope ----------------------------------------------------------------
const scopeEl = $('scope');
function setScope(value) {
  for (const b of scopeEl.querySelectorAll('button')) b.classList.toggle('active', b.dataset.value === value);
}
scopeEl.addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  setScope(button.dataset.value);
  $('scope-label').textContent = 'Personal or work?';
  resizeSoon();
});
// SAA-170: only a button actually active counts; nothing is assumed.
function selectedScope() {
  const active = scopeEl.querySelector('button.active');
  if (!active) return null;
  return active.dataset.value === 'personal' ? 'personal' : 'work';
}

// --- size -----------------------------------------------------------------
// The page's whole height, sent to main.js, which sizes the window to it
// between IDENTITY_WINDOW's bounds.
function measuredHeight() {
  return Math.ceil(document.body.getBoundingClientRect().height);
}
window.measuredHeight = measuredHeight;
let lastSent = null;
let resizeQueued = false;
function resizeSoon() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    const h = measuredHeight();
    if (h === lastSent) return;
    lastSent = h;
    ipcRenderer.send('identity:resize', { token, height: h });
  });
}

// --- what main.js sends ---------------------------------------------------
// The calendar preview (stop only, at most once): the title onto the call
// line, the invitees as chips.
function applyCalendar(prefill) {
  if (!prefill) return;
  if (!field) { pendingPrefill = prefill; return; }
  if (calendarApplied) return;
  calendarApplied = true;
  if (prefill.title) callLine.textContent = `${callLine.textContent} · ${prefill.title}`;
  ia.applyInvitees(field, prefill);
  render();
}
ipcRenderer.on('identity:calendar', (_event, prefill) => applyCalendar(prefill));

ipcRenderer.on('identity:voices', (_event, payload) => {
  if (!payload || !payload.namingData) return;
  voices = { namingData: payload.namingData, diarize: payload.diarize || { voices: [] } };
  voicesMessage = null;
  for (const v of voices.namingData.voices || []) {
    if (!choices.has(v.voiceIndex)) choices.set(v.voiceIndex, null);
  }
  applySavedVoiceNames();
  render();
});
ipcRenderer.on('identity:voices-stopped', (_event, payload) => {
  voicesMessage = (payload && payload.message) || "Couldn't separate the voices on this call.";
  render();
});

// A rename starts from the names saved before (voice-names-<stem>.json).
let voiceNamesDoc = null;
function applySavedVoiceNames() {
  if (!voiceNamesDoc || !Array.isArray(voiceNamesDoc.voices)) return;
  for (const v of voiceNamesDoc.voices) {
    if (!v || !Number.isInteger(v.voiceIndex)) continue;
    const name = typeof v.name === 'string' && v.name.trim() ? v.name : null;
    if (name && !savedVoiceNames.includes(name)) savedVoiceNames.push(name);
    if (!choices.get(v.voiceIndex)) choices.set(v.voiceIndex, name);
  }
}

// --- Save, Skip -----------------------------------------------------------
function voicesForSave() {
  if (!voicesReady()) return [];
  return voices.namingData.voices.map((v) => v.voiceIndex).sort((a, b) => a - b)
    .map((voiceIndex) => ({ voiceIndex, name: choices.get(voiceIndex) || null }));
}
async function save() {
  if (saving || !field || $('save').disabled) return;
  // Text typed but not yet added goes in first, as Enter would add it.
  if (input.value.trim() && !(await addTypedText(input.value))) return;
  if (addressBox && !(await nameAddressTyped())) return;
  if (addingFor && !(await addSomeoneForVoice())) return;
  saving = true;
  ipcRenderer.send('identity:submit', {
    token,
    guests: ia.answerGuests(field),
    inviteeNames: ia.inviteePairs(field),
    scope: selectedScope(),
    voices: voicesForSave(),
  });
}
function skip() {
  ipcRenderer.send('identity:skip', { token });
}
$('save').addEventListener('click', save);
$('skip').addEventListener('click', skip);
$('skip').textContent = mode === 'correct' ? 'Cancel' : mode === 'voices' ? 'Later' : 'Skip';
// Escape skips only with focus on nothing editable: a text box clears itself
// instead (its own handler), and a menu closes itself.
function editableFocused() {
  const a = document.activeElement;
  return !!a && (['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName) || a.isContentEditable);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!editableFocused()) skip();
    return;
  }
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (e.key === 'Enter' && !['INPUT', 'SELECT', 'BUTTON', 'TEXTAREA'].includes(tag)) { e.preventDefault(); save(); }
});
updateAtBlock();

// --- start ----------------------------------------------------------------
(async () => {
  let init = null;
  let me = null;
  try {
    [init, me] = await Promise.all([
      ipcRenderer.invoke('identity:init', { token }),
      ipcRenderer.invoke('identity:me', { token }),
    ]);
  } catch {}
  hostName = (me && me.displayName) || null;
  const saved = init && init.saved;
  // Change attendees… with no saved answer to start from (it could not be
  // read, or init failed): nothing to correct. The field is replaced by the
  // reason, Save stays disabled (field is never built), and nothing is sent.
  // Name voices with no saved answer is a skipped call, and opens empty.
  if (mode === 'correct' && !saved) {
    $('field-box').replaceWith(el('p', { id: 'load-failed', className: 'note warn', text: "Couldn't load this call's attendees. Close and try again." }));
    for (const id of ['results', 'recent', 'new-line', 'field-hint']) $(id).remove();
    $('scope').closest('.section').remove();
    $('recorded-by').textContent = ia.recordedByLine(hostName);
    updateAtBlock();
    resizeSoon();
    return;
  }
  const hostNames = [hostName, init && init.cachedSelf, saved && saved.self && saved.self.name].filter((n) => typeof n === 'string' && n);
  field = (mode === 'correct' || mode === 'voices') && saved
    ? ia.peopleFieldFromAnswer(saved, { hostNames })
    : ia.peopleField({ hostNames });
  voiceNamesDoc = init && init.voiceNames;
  applySavedVoiceNames();
  const savedScope = saved && (saved.scope === 'work' || saved.scope === 'personal') ? saved.scope : null;
  const inferred = params.get('inferredScope');
  if ((mode === 'correct' || mode === 'voices') && savedScope) {
    setScope(savedScope);
  } else if (inferred === 'work' || inferred === 'personal') {
    setScope(inferred);
    $('scope-label').textContent = 'Personal or work? (guessed from the app — change if wrong)';
  }
  if (pendingPrefill) applyCalendar(pendingPrefill);
  render();
  input.focus();
  const recent = await runSearch('');
  recentPeople = recent.searched ? recent.results : [];
  render();
})();
