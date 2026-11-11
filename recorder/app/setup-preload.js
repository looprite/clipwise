// The setup and recording notice window's preload (SAA-243 window hardening).
// setup.html runs with no Node: contextIsolation and sandbox on,
// nodeIntegration off. What it can reach of the main process is this: the
// channels below and no others. A channel not listed throws, so a page that
// asks for one fails where it can be seen.
//
// Sandboxed, a preload can require only 'electron', nothing from this folder,
// so each window's preload carries its own copy of these few lines.
//
// The page binds this as `ipcRenderer`, so its calls read as they did. Every
// call and message on these channels carries one payload after the channel
// name, so one is passed. A listener is called with (undefined, payload): the
// shape the page's handler had, without the event, which the page never gets.
// Nothing here is asked for with invoke.

const { contextBridge, ipcRenderer } = require('electron');

const SEND = ['setup:ready', 'setup:acknowledge', 'setup:later', 'setup:address', 'setup:change-address',
    'setup:signin', 'setup:permission-request', 'setup:permission-settings', 'setup:filevault-settings',
    'setup:done', 'setup:copy-claude-address', 'setup:voices'];
const ON = ['setup:state'];

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
