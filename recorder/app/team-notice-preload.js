// The "Team: who accepted the notice…" window's preload (Gate 1, item 2), on
// the pattern of SAA-243's window hardening. team-notice.html runs with no Node:
// contextIsolation and sandbox on, nodeIntegration off. What it can reach of the
// main process is this: the channels below and no others. A channel not listed
// throws, so a page that asks for one fails where it can be seen.
//
// Sandboxed, a preload can require only 'electron', nothing from this folder,
// so each window's preload carries its own copy of these few lines.

const { contextBridge, ipcRenderer } = require('electron');

const SEND = ['team-notice:ready'];
const ON = ['team-notice:data'];

function allowed(list, how, channel) {
    if (!list.includes(channel)) throw new Error(`${how} ${channel}: not a channel of this window`);
}

contextBridge.exposeInMainWorld('clipwise', {
    send(channel, payload) {
        allowed(SEND, 'send', channel);
        ipcRenderer.send(channel, payload);
    },
    on(channel, listener) {
        allowed(ON, 'on', channel);
        ipcRenderer.on(channel, (_event, payload) => listener(undefined, payload));
    },
});
