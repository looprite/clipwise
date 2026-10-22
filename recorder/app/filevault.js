// Whether FileVault is on, for the setup window's warning (SAA-243 item 7).
// Clipwise keeps call audio and transcripts on this Mac, and FileVault is what
// protects them if the Mac is lost. A warning only: nothing here blocks setup
// or recording.

const { execFile } = require('child_process');

const FDESETUP = '/usr/bin/fdesetup';
const READ_TIMEOUT_MS = 5000;
const SETTINGS_PANE = 'x-apple.systempreferences:com.apple.preference.security?FileVault';

const WARNING = {
    off: 'FileVault is off. Clipwise keeps call audio and transcripts on this Mac; '
        + 'turn on FileVault so they’re encrypted if the Mac is lost.',
    unrecognised: 'Clipwise couldn’t confirm FileVault is on. Clipwise keeps call audio and '
        + 'transcripts on this Mac; check FileVault in System Settings.',
};

// 'on' or 'off' only for fdesetup's exact sentence and a clean exit; anything
// else (encryption in progress, a restart pending, an error, no output) is
// 'unrecognised', which warns like 'off'.
function fileVaultState(stdout, exitCode) {
    if (exitCode !== 0) return 'unrecognised';
    const out = String(stdout || '').trim();
    if (out === 'FileVault is On.') return 'on';
    if (out === 'FileVault is Off.') return 'off';
    return 'unrecognised';
}

// The setup window's line, or null when there is nothing to warn about.
function fileVaultWarning(state) {
    if (state === 'on') return null;
    return state === 'off' ? WARNING.off : WARNING.unrecognised;
}

// fdesetup status, read without a prompt or sudo. A missing binary, a timeout
// or any other failure is 'unrecognised'. Never rejects.
function readFileVault(bin = FDESETUP) {
    return new Promise((resolve) => {
        try {
            execFile(bin, ['status'], { timeout: READ_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
                const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
                resolve(fileVaultState(stdout, code));
            });
        } catch {
            resolve('unrecognised');
        }
    });
}

module.exports = { SETTINGS_PANE, WARNING, fileVaultState, fileVaultWarning, readFileVault };
