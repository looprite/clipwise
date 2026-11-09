// The setup and recording notice window's page script, moved out of
// setup.html so the page's Content-Security-Policy allows scripts from the
// bundle's own files only (script-src 'self', SAA-243 window hardening). It
// runs with no Node: setup-preload.js is all it reaches of the main process.

// No Node here (SAA-243 window hardening): setup-preload.js's channels.
const ipcRenderer = window.clipwise;
const token = new URLSearchParams(location.search).get('token');
const $ = (id) => document.getElementById(id);
const send = (channel, extra) => ipcRenderer.send(channel, { token, ...(extra || {}) });

const STATE_TEXT = { granted: 'Allowed', denied: 'Off', notDetermined: 'Not yet asked' };
let view = null;

// The notice's text, as main.js sends it (consent.js readNotice): a title and
// blocks of three kinds only. Every string goes in as textContent; a block of
// any other kind is skipped, so nothing the file holds can become markup.
const NOTICE_TAGS = new Set(['h2', 'ul', 'p']);
function drawNotice(notice) {
  $('notice-title').textContent = notice ? notice.title : '';
  const box = $('notice-text');
  box.replaceChildren();
  for (const b of (notice && notice.blocks) || []) {
    if (!NOTICE_TAGS.has(b.tag)) continue;
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
}

// Any other state audiodevs reports (restricted, unavailable, unexpected) is
// "Not available" in the muted style: it does not hold setup open
// (setup.js permissionSettled), but it is not a grant either.
function drawPerm(which, state, asking) {
  const el = $(`${which}-state`);
  el.textContent = asking ? 'Waiting for your answer…' : (STATE_TEXT[state] || 'Not available');
  el.className = `state ${state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : ''}`;
  const button = $(`${which}-button`);
  button.style.visibility = state === 'notDetermined' || state === 'denied' ? 'visible' : 'hidden';
  button.textContent = state === 'denied' ? 'Open System Settings' : 'Allow…';
  button.disabled = !!asking;
}

function draw(v) {
  view = v;
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('shown', s.id === `screen-${v.screen}`);
  $('step').textContent = v.stepText || '';
  $('step').style.display = v.stepText ? 'block' : 'none';
  $('filevault-text').textContent = v.fileVaultWarning || '';
  $('filevault').style.display = v.fileVaultWarning ? 'block' : 'none';
  const primary = $('primary');
  const later = $('later');
  // A notice that could not be read (null) or is empty can't be agreed to.
  const agreeable = !!(v.notice && v.notice.title && Array.isArray(v.notice.blocks) && v.notice.blocks.length > 0);
  // A reread's Close writes nothing, so it stays usable either way.
  primary.disabled = !!v.busy || (v.screen === 'notice' && !agreeable && !v.rereading);
  later.textContent = v.screen === 'permissions' ? 'Finish later' : 'Not now';
  if (v.screen === 'notice') {
    drawNotice(v.notice);
    $('notice-error').textContent = agreeable ? '' : "The notice couldn't be loaded";
    primary.textContent = v.noticeLabel || 'I understand';
  } else if (v.screen === 'address') {
    primary.textContent = v.busy ? 'Checking…' : 'Continue';
    if (v.address !== undefined && document.activeElement !== $('address')) $('address').value = v.address;
    $('address').disabled = !!v.busy;
    $('address-error').textContent = v.error || '';
    if (!v.busy) $('address').focus();
  } else if (v.screen === 'signin') {
    $('signin-host').textContent = v.host || '';
    primary.textContent = 'Sign in with Google';
    $('signin-status').textContent = v.waiting ? 'Waiting for your browser…' : (v.error || '');
    $('signin-status').className = v.error && !v.waiting ? 'error' : 'muted';
  } else if (v.screen === 'permissions') {
    // The window moves on to the last screen by itself once both are settled.
    drawPerm('mic', v.mic, v.asking === 'mic');
    drawPerm('tap', v.tap, v.asking === 'tap');
    $('perm-error').textContent = v.error || '';
  } else if (v.screen === 'claude') {
    $('claude-address').textContent = v.claudeAddress || '';
    primary.textContent = 'Done';
  }
  primary.style.display = v.screen === 'permissions' ? 'none' : '';
  // A reread (opened from the menu bar once agreed) has one button, Close.
  later.style.display = v.screen === 'claude' || v.rereading ? 'none' : '';
}

ipcRenderer.on('setup:state', (_event, v) => draw(v));

$('primary').addEventListener('click', () => {
  if (!view || $('primary').disabled) return;
  $('primary').disabled = true;
  // Reread: Close only closes; nothing is sent that could write an answer.
  if (view.screen === 'notice' && view.rereading) send('setup:later');
  else if (view.screen === 'notice') send('setup:acknowledge');
  else if (view.screen === 'address') send('setup:address', { address: $('address').value });
  else if (view.screen === 'signin') send('setup:signin');
  else if (view.screen === 'claude') send('setup:done');
});
$('copy-address').addEventListener('click', () => {
  send('setup:copy-claude-address');
  $('copy-address').textContent = 'Copied';
  setTimeout(() => { $('copy-address').textContent = 'Copy'; }, 2000);
});
$('address').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('primary').click(); });
$('later').addEventListener('click', () => send('setup:later'));
$('change-address').addEventListener('click', () => send('setup:change-address'));
$('filevault-settings').addEventListener('click', () => send('setup:filevault-settings'));
for (const which of ['mic', 'tap']) {
  $(`${which}-button`).addEventListener('click', () => {
    if (!view) return;
    send(view[which] === 'denied' ? 'setup:permission-settings' : 'setup:permission-request', { which });
  });
}
send('setup:ready');
