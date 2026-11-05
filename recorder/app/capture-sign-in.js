// The sign-in's loopback listener (RFC 8252): main.js opens the browser at the
// server's authorize page with this listener's address as the redirect, and the
// browser comes back here with the code. Moved out of main.js unchanged
// (SAA-268) so it runs without Electron: check-capture-sign-in.js drives it with
// real HTTP requests to 127.0.0.1.
//
// It answers only /callback with this sign-in's state; anything else is a 404.
// onCode gets the code, onNoCode the error the server sent back ('no_code' when
// there was none). main.js does the listening, the token exchange and the log.

'use strict';

const http = require('http');

function createSignInListener({ state, onCode, onNoCode }) {
    const listener = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
            res.writeHead(404).end();
            return;
        }
        const code = url.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
            .end(code ? 'Signed in to Clipwise. You can close this tab.' : 'Sign-in did not finish. You can close this tab.');
        listener.close();
        if (!code) {
            onNoCode(url.searchParams.get('error') || 'no_code');
            return;
        }
        onCode(code);
    });
    return listener;
}

module.exports = { createSignInListener };
