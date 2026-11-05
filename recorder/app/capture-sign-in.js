// The sign-in's loopback listener (RFC 8252): main.js opens the browser at the
// server's authorize page with this listener's address as the redirect, and the
// browser comes back here with the code. Moved out of main.js unchanged
// (SAA-268) so it runs without Electron: check-capture-sign-in.js drives it with
// real HTTP requests to 127.0.0.1.
//
// It answers only /callback with this sign-in's state; anything else is a 404.
// onCode gets the code, onNoCode the error the server sent back ('no_code' when
// there was none). main.js does the listening, the token exchange and the log.
//
// One answer per sign-in (SAA-268). The browser can come back more than once:
// on a connection kept open after the first reply, or on a second connection
// opened before close() — close() only stops new ones. A code exchanged twice
// makes the server delete the tokens the first exchange got. So the first
// request with this state, with or without a code, is the only one acted on;
// a later one gets the first one's page, and onRepeat is called with nothing.
// A wrong state is still a 404 and does not count.

'use strict';

const http = require('http');

const SIGNED_IN_PAGE = 'Signed in to Clipwise. You can close this tab.';
const NOT_FINISHED_PAGE = 'Sign-in did not finish. You can close this tab.';

function createSignInListener({ state, onCode, onNoCode, onRepeat }) {
    let answered = false;
    let firstPage = null;
    const listener = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
            res.writeHead(404).end();
            return;
        }
        if (answered) {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(firstPage);
            onRepeat();
            return;
        }
        answered = true;
        const code = url.searchParams.get('code');
        firstPage = code ? SIGNED_IN_PAGE : NOT_FINISHED_PAGE;
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
            .end(firstPage);
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
