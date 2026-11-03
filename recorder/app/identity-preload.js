// The "Who was on this call?" window's preload (SAA-243 window hardening).
// identity.html runs with no Node: contextIsolation and sandbox on,
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
// shape the page's handlers had, without the event, which the page never gets.

const { contextBridge, ipcRenderer } = require('electron');

const SEND = ['identity:resize', 'identity:submit', 'identity:skip'];
const INVOKE = ['identity:init', 'identity:me', 'identity:search'];
const ON = ['identity:calendar', 'identity:voices', 'identity:voices-stopped'];

function allowed(list, how, channel) {
    if (!list.includes(channel)) throw new Error(`${how} ${channel}: not a channel of this window`);
}

contextBridge.exposeInMainWorld('clipwise', {
    send(channel, payload) {
        allowed(SEND, 'send', channel);
        ipcRenderer.send(channel, payload);
    },
    invoke(channel, payload) {
        allowed(INVOKE, 'invoke', channel);
        return ipcRenderer.invoke(channel, payload);
    },
    on(channel, listener) {
        allowed(ON, 'on', channel);
        ipcRenderer.on(channel, (_event, payload) => listener(undefined, payload));
    },
});
