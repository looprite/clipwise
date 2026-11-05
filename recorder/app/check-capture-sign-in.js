// Checks the sign-in's loopback listener (capture-sign-in.js, SAA-268): one
// sign-in hands its code to the token exchange once, however many times the
// browser comes back with it. A second exchange of the same code makes the
// server delete the tokens the first one got (oauth-provider
// revokeTokensIssuedForAuthorizationCode), which signed a new Mac out nine
// minutes after its first sign-in.
//
// Real HTTP to 127.0.0.1, at a port the OS picks, against the real module. No
// Electron, no app name, no keychain, no support folder.
//
// Usage (the Node the app ships, then any Node):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron check-capture-sign-in.js
//   node check-capture-sign-in.js
//
// Exit 0 when every case passes, 1 otherwise.

'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const { createSignInListener } = require(path.join(__dirname, 'capture-sign-in.js'));

const STATE = 'check-state-0123456789';
const WAIT_MS = 1500;

let passed = 0;
let failed = 0;
function result(ok, name, detail) {
    if (ok) passed++; else failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// A fresh listener on 127.0.0.1, counting onCode runs and accepted connections.
async function start() {
    const codes = [];
    const noCodes = [];
    const listener = createSignInListener({
        state: STATE,
        onCode: (code) => codes.push(code),
        onNoCode: (error) => noCodes.push(error),
    });
    let connections = 0;
    listener.on('connection', () => { connections++; });
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    return { listener, port, codes, noCodes, connections: () => connections };
}

// Each case destroys its own agent or sockets first, so close() leaves nothing open.
function stop(listener) {
    try { listener.close(); } catch {}
}

// One GET through an agent; resolves { status, body, reused } or { error }.
function get(port, pathAndQuery, agent) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathAndQuery, agent }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve({ status: res.statusCode, body, reused: req.reusedSocket }));
        });
        req.on('error', (err) => resolve({ error: err.code || err.name }));
        req.setTimeout(WAIT_MS, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    });
}

// A raw connection, opened and waited on; send() writes one GET and resolves
// the status line's code, or 'closed' / an error code if none came.
function openRaw(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}
function sendRaw(socket, pathAndQuery) {
    return new Promise((resolve) => {
        let data = '';
        let done = false;
        const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
        const timer = setTimeout(() => finish(data ? statusOf(data) : 'timeout'), WAIT_MS);
        socket.setEncoding('utf8');
        socket.on('data', (d) => { data += d; if (/\r\n\r\n/.test(data)) finish(statusOf(data)); });
        socket.on('end', () => finish(data ? statusOf(data) : 'closed'));
        socket.on('error', (err) => finish(err.code || err.name));
        socket.write(`GET ${pathAndQuery} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`);
    });
}
function statusOf(data) {
    const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
    return m ? Number(m[1]) : 'garbled';
}

const callback = (code, state = STATE) => `/callback?code=${code}&state=${state}`;
const settle = () => new Promise((r) => setTimeout(r, 100));

async function main() {
    console.log(`node ${process.versions.node}${process.versions.electron ? `, electron ${process.versions.electron}` : ''}`);

    // 1. One request: the code reaches onCode exactly once (positive control).
    {
        const s = await start();
        const agent = new http.Agent({ keepAlive: false });
        const r = await get(s.port, callback('code-one'), agent);
        await settle();
        result(r.status === 200 && /Signed in to Clipwise/.test(r.body) && s.codes.length === 1 && s.codes[0] === 'code-one',
            'one matching request: 200, the page says signed in, onCode ran exactly once with its code',
            `status ${r.status ?? r.error}, onCode ran ${s.codes.length} time(s)`);
        agent.destroy();
        stop(s.listener);
    }

    // 2. Wrong state: 404, and onCode never runs (control).
    {
        const s = await start();
        const agent = new http.Agent({ keepAlive: false });
        const r = await get(s.port, callback('code-wrong', 'not-this-state'), agent);
        await settle();
        result(r.status === 404 && s.codes.length === 0 && s.noCodes.length === 0,
            'wrong state: 404, and neither onCode nor onNoCode runs',
            `status ${r.status ?? r.error}, onCode ran ${s.codes.length} time(s)`);
        agent.destroy();
        stop(s.listener);
    }

    // 3. Two matching GETs on one keep-alive connection, the second after the
    //    first's reply, as a browser that comes back twice would send them.
    {
        const s = await start();
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        const first = await get(s.port, callback('code-ka'), agent);
        const second = await get(s.port, callback('code-ka'), agent);
        await settle();
        const shape = `first ${first.status ?? first.error}, second ${second.status ?? second.error}` +
            `${second.reused !== undefined ? ` (socket reused: ${second.reused})` : ''}, connections ${s.connections()}`;
        const pages = [first, second].every((r) => r.status === 200 && /Signed in to Clipwise/.test(r.body));
        result(s.codes.length === 1 && pages,
            'two matching GETs on one keep-alive connection: onCode runs once, and both replies are 200 with the signed-in page',
            `onCode ran ${s.codes.length} time(s); both signed-in pages: ${pages}; ${shape}`);
        agent.destroy();
        stop(s.listener);
    }

    // 4. Two matching GETs on two connections, both open before either is sent,
    //    then sent in the same tick.
    {
        const s = await start();
        const [a, b] = await Promise.all([openRaw(s.port), openRaw(s.port)]);
        const [ra, rb] = await Promise.all([sendRaw(a, callback('code-two')), sendRaw(b, callback('code-two'))]);
        await settle();
        result(s.codes.length === 1 && ra === 200 && rb === 200,
            'two matching GETs on two connections opened together: onCode runs once, and both replies are 200',
            `onCode ran ${s.codes.length} time(s); replies ${ra} and ${rb}, connections ${s.connections()}`);
        a.destroy();
        b.destroy();
        stop(s.listener);
    }

    console.log(`\ncheck-capture-sign-in: ${passed} passed, ${failed} failed`);
    process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
    console.error(`check-capture-sign-in: crashed: ${err && err.stack || err}`);
    process.exitCode = 1;
});
