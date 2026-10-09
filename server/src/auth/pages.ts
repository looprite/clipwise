// The two pages Better Auth sends a person to while Claude is connecting:
// /login (prove who you are) and /consent (agree to let this client in). Plain
// HTML and a little script — no framework, and nothing loaded from another
// origin: the logo is inline SVG, the tab icon is /favicon.svg from this server
// (the CSP's img-src 'self'), and the font stack names Inter first, so it is used if
// the visitor has it installed and the system font is used if not (the landing
// page loads Inter from Google Fonts; these pages must not, and the CSP below
// would block it anyway). The look follows the landing page, index.html.
//
// Both arrive with the OAuth request in the query string (client, redirect,
// scopes, and a signature Better Auth checks), and both hand that string
// straight back to Better Auth rather than interpreting it.
//
// Hardening, each for a reason:
//  - A strict CSP with a per-response nonce: no other script can run here.
//  - The consent page only navigates to the URL Better Auth returns if it is
//    https (or http on a loopback address, which is how Claude Code connects).
//    A `javascript:` or other scheme there is the redirect-URI script-injection
//    advisory (GHSA-86j7), which would otherwise run in this origin.
//  - The consent page shows the redirect URI's host, as the MCP authorization
//    spec requires, so a client claiming to be one thing but sending the code
//    elsewhere is visible.
//  - Nothing from the query string is written into the page as HTML: it is
//    read by script and set with textContent.
//  - no-store, no referrer, no framing.

import { randomBytes } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { FAVICON_SVG } from "../lib/brand.js";
import { authConfigFromEnv } from "./auth.js";

function send(res: Response, body: (nonce: string) => string): void {
  const nonce = randomBytes(16).toString("base64");
  res
    .status(200)
    .type("html")
    .set({
      "Content-Security-Policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
        // img-src is what governs the tab icon (<link rel="icon">); same origin only.
        "img-src 'self'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    })
    .send(body(nonce));
}

// The palette is the landing page's (index.html :root); --muted is a step
// lighter than its #6B6B6B because these pages carry small body text, which
// that grey does not keep readable on the near-black.
const STYLE = `
  :root { color-scheme: dark; --bg: #0D0D0D; --surface: #151515; --orange: #F4620A; --yellow: #F5C842; --white: #F5F0EB; --muted: #8F8F8F; --border: #222222; --err: #ff8d8f; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--white); font: 16px/1.5 'Inter', system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  .wrap { width: 100%; max-width: 400px; }
  .brand { display: flex; align-items: center; gap: 10px; margin: 0 0 20px 4px; }
  .brand svg { width: 32px; height: 32px; flex-shrink: 0; }
  .brand span { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
  main { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px 24px; }
  h1 { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 4px; }
  p { margin: 8px 0; }
  .muted { color: var(--muted); font-size: 14px; }
  label { display: block; font-size: 14px; margin: 16px 0 4px; }
  input { width: 100%; padding: 12px 14px; font: inherit; color: var(--white); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; transition: border-color .15s; }
  input:focus { border-color: var(--orange); }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--orange); outline-offset: 2px; }
  .row { display: flex; gap: 10px; margin-top: 22px; }
  button { flex: 1; padding: 12px 16px; font: inherit; font-weight: 600; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--white); cursor: pointer; transition: opacity .15s; }
  button:hover { opacity: .85; }
  button.primary { background: var(--orange); color: var(--bg); border-color: var(--orange); }
  button[disabled] { opacity: .6; cursor: default; }
  #msg { min-height: 1.4em; margin-top: 14px; font-size: 14px; color: var(--err); }
  ul { padding-left: 20px; margin: 8px 0; }
  li::marker { color: var(--orange); }
  .host { font-weight: 700; overflow-wrap: anywhere; }
`;

// The Clipwise mark, inline: the same shapes as the tab icon (lib/brand.ts), with
// no xmlns (inline SVG in HTML does not need it, and leaving it out keeps every
// "http" in these pages a real address or none at all) and hidden from screen
// readers, since the wordmark beside it says the name.
const LOGO = FAVICON_SVG.replace(' xmlns="http://www.w3.org/2000/svg"', ' aria-hidden="true"').trim();

function shell(nonce: string, title: string, inner: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div class="wrap">
<header class="brand">${LOGO}<span>Clipwise</span></header>
<main>
${inner}
</main>
</div>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

export const loginPage: RequestHandler = (_req, res) => {
  const passwordEnabled = authConfigFromEnv().passwordEnabled;
  send(res, (nonce) =>
    shell(
      nonce,
      "Sign in to Clipwise",
      passwordEnabled
        ? `<h1>Sign in to Clipwise</h1>
<p class="muted">Sign in to continue connecting.</p>
<form id="f" novalidate>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="username" required autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <div class="row"><button class="primary" id="go" type="submit">Sign in</button></div>
</form>
<div id="msg" role="alert" aria-live="polite"></div>`
        : `<h1>Sign in to Clipwise</h1>
<p>Password sign-in is turned off for this instance.</p>
<p class="muted">Ask the person who runs it how to sign in.</p>`,
      passwordEnabled
        ? `
const f = document.getElementById('f'), msg = document.getElementById('msg'), go = document.getElementById('go');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '';
  go.disabled = true;
  try {
    const res = await fetch('/api/auth/sign-in/email', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: f.email.value.trim(), password: f.password.value }),
    });
    if (res.ok) {
      // Back into the OAuth request this page was sent from.
      if (location.search) { location.assign('/api/auth/oauth2/authorize' + location.search); return; }
      msg.style.color = 'inherit'; msg.textContent = 'Signed in. You can close this tab.'; return;
    }
    if (res.status === 429) {
      const s = Number(res.headers.get('x-retry-after') || 0);
      msg.textContent = 'Too many attempts. Try again in ' + Math.max(1, Math.ceil(s / 60)) + ' minute(s).';
    } else {
      msg.textContent = 'That email and password did not work.';
    }
  } catch { msg.textContent = 'Could not reach the server. Try again.'; }
  go.disabled = false;
});`
        : "",
    ),
  );
};

export const consentPage: RequestHandler = (_req, res) => {
  send(res, (nonce) =>
    shell(
      nonce,
      "Allow access to Clipwise",
      `<h1>Allow access?</h1>
<p><span id="client" class="host">An application</span> wants to connect to Clipwise.</p>
<p class="muted">It will send you back to <span id="host" class="host"></span> once you decide. Only continue if you started this from a Claude app you trust.</p>
<p>It will be able to:</p>
<ul>
  <li>search the moments of the calls you recorded and the calls your team has shared,</li>
  <li>read those calls' transcripts.</li>
</ul>
<p class="muted">It cannot change anything, and it cannot see other people's private calls.</p>
<div class="row"><button id="no" type="button">Deny</button><button class="primary" id="yes" type="button">Allow</button></div>
<div id="msg" role="alert" aria-live="polite"></div>`,
      `
const q = new URLSearchParams(location.search);
const msg = document.getElementById('msg'), yes = document.getElementById('yes'), no = document.getElementById('no');
try { document.getElementById('host').textContent = new URL(q.get('redirect_uri')).host; }
catch { document.getElementById('host').textContent = '(unknown)'; yes.disabled = true; msg.textContent = 'This request is missing its redirect address.'; }
fetch('/api/auth/oauth2/public-client?client_id=' + encodeURIComponent(q.get('client_id') || ''), { credentials: 'same-origin' })
  .then((r) => (r.ok ? r.json() : null))
  .then((c) => { if (c && c.client_name) document.getElementById('client').textContent = String(c.client_name); })
  .catch(() => {});
// Only ever navigate somewhere that is safe to leave this page for.
function safe(u) {
  try {
    const x = new URL(u);
    if (x.protocol === 'https:') return true;
    return x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1' || x.hostname === '[::1]');
  } catch { return false; }
}
async function answer(accept) {
  yes.disabled = no.disabled = true; msg.textContent = '';
  try {
    const res = await fetch('/api/auth/oauth2/consent', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }),
    });
    const body = await res.json().catch(() => null);
    const url = body && (body.url || body.redirect_uri);
    if (res.ok && typeof url === 'string' && safe(url)) { location.assign(url); return; }
    msg.textContent = res.ok ? 'The server sent back an address this page will not open.' : 'That did not work. Start again from Claude.';
  } catch { msg.textContent = 'Could not reach the server. Try again.'; }
  yes.disabled = no.disabled = false;
}
yes.addEventListener('click', () => answer(true));
no.addEventListener('click', () => answer(false));`,
    ),
  );
};
