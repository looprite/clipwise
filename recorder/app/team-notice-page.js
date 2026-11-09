// The "Team: who accepted the notice…" window's page script (Gate 1, item 2).
// It runs with no Node: team-notice-preload.js is all it reaches of the main
// process. main.js sends the heading and one line per member, already written
// (team-notice.js), or an error; this draws them as text, with textContent only,
// so nothing in a name or an address can become markup.

const ipc = window.clipwise;
const $ = (id) => document.getElementById(id);

function render(data) {
  const d = data || {};
  $('heading').textContent = d.heading || '';
  $('error').textContent = d.error || '';
  const list = $('list');
  list.replaceChildren();
  for (const line of Array.isArray(d.lines) ? d.lines : []) {
    const li = document.createElement('li');
    li.textContent = String(line);
    list.appendChild(li);
  }
  $('empty').textContent = !d.error && Array.isArray(d.lines) && d.lines.length === 0 ? 'No members yet.' : '';
}

ipc.on('team-notice:data', (_event, data) => render(data));
ipc.send('team-notice:ready');
