// The prompt panel's page script (SAA-291). It runs with no Node:
// prompt-panel-preload.js is all it reaches of the main process. main.js sends
// what to show (prompt-panel.js panelView); this draws it with textContent
// only, so nothing in an app's name can become markup, says when it is drawn
// (main.js shows the panel then, never empty), and sends back the button
// pressed with this panel's token. One answer per panel: every button is
// disabled once one is pressed.

const ipc = window.clipwise;
const token = new URLSearchParams(location.search).get('token') || '';
const $ = (id) => document.getElementById(id);

function render(view) {
  const v = view || {};
  $('title').textContent = v.title || '';
  $('title').title = v.title || '';
  $('body').textContent = v.body || '';
  const row = $('buttons');
  row.replaceChildren();
  for (const b of Array.isArray(v.buttons) ? v.buttons : []) {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = String(b.label || '');
    el.dataset.choice = String(b.choice || '');
    // "Never ask about this app" sits on the left, set apart and quiet; the
    // others on the right, the main answer last.
    if (b.choice === 'never') el.className = 'quiet';
    else if (b.primary) el.className = 'primary';
    el.addEventListener('click', () => answer(el.dataset.choice));
    row.appendChild(el);
    if (b.choice === 'never') {
      const gap = document.createElement('span');
      gap.className = 'spacer';
      row.appendChild(gap);
    }
  }
  if (!row.querySelector('.spacer')) row.prepend(Object.assign(document.createElement('span'), { className: 'spacer' }));
}

function answer(choice) {
  for (const el of document.querySelectorAll('#buttons button')) el.disabled = true;
  ipc.send('prompt-panel:answer', { token, choice });
}

ipc.on('prompt-panel:data', (_event, view) => {
  render(view);
  ipc.send('prompt-panel:drawn', { token });
});
ipc.send('prompt-panel:ready', { token });
