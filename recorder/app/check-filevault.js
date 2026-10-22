#!/usr/bin/env node
// Setup warns when FileVault is off or its state can't be read, and only warns
// (SAA-243 item 7).
//
//   node check-filevault.js
//   CLIPWISE_CHECK_SOURCE=c5b1408 node check-filevault.js
//
// Cases 1-8 run filevault.js's readFileVault and fileVaultWarning: 1-7 against
// small scripts standing in for fdesetup, each printing one output with one exit
// code, and 8 against this Mac's real /usr/bin/fdesetup. c5b1408 has no FileVault
// check, so with CLIPWISE_CHECK_SOURCE set a STAND-IN that never warns is checked
// in its place. Cases 9-13 read main.js, setup.html, setup.js and build-app.sh as
// text: they show the warning is wired into the setup window and nowhere that
// could block, not that the window draws it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REV = process.env.CLIPWISE_CHECK_SOURCE || '';
const fromRev = (file) => execFileSync('git', ['show', `${REV}:recorder/app/${file}`], { cwd: __dirname, encoding: 'utf8' });
const read = (file) => (REV ? fromRev(file) : fs.readFileSync(path.join(__dirname, file), 'utf8'));
const SRC = read('main.js');
const HTML = read('setup.html');
const SETUP_JS = read('setup.js');
const BUILD = read('build-app.sh');
const fv = REV
    ? { readFileVault: async () => null, fileVaultWarning: () => null }
    : require('./filevault.js');

// The two texts as approved (Jon, 2026-10-22).
const APPROVED_OFF = 'FileVault is off. Clipwise keeps call audio and transcripts on this Mac; turn on FileVault so they\u2019re encrypted if the Mac is lost.';
const APPROVED_UNRECOGNISED = 'Clipwise couldn\u2019t confirm FileVault is on. Clipwise keeps call audio and transcripts on this Mac; check FileVault in System Settings.';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipwise-check-filevault-'));
function fakeFdesetup(name, output, exitCode) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\nprintf '%s' '${output.replace(/'/g, "'\\''")}'\nexit ${exitCode}\n`);
    fs.chmodSync(p, 0o755);
    return p;
}

const FIXTURES = [
    ['on', 'FileVault is On.\n', 0, 'none'],
    ['off', 'FileVault is Off.\n', 0, 'off'],
    ['encrypting', 'Encryption in progress: Percent completed = 34\n', 0, 'unrecognised'],
    ['on-but-exit-1', 'FileVault is On.\n', 1, 'unrecognised'],
    ['empty', '', 0, 'unrecognised'],
    ['garbage', 'fdesetup: something unexpected\n', 0, 'unrecognised'],
];

(async () => {
    const results = {};
    for (const [name, output, code] of FIXTURES) {
        const state = await fv.readFileVault(fakeFdesetup(name, output, code));
        results[name] = { state, warning: fv.fileVaultWarning(state) };
    }
    const missingState = await fv.readFileVault(path.join(dir, 'no-such-fdesetup'));
    results.missing = { state: missingState, warning: fv.fileVaultWarning(missingState) };

    // This Mac: what fdesetup prints, and what the module makes of it.
    let realOut = '', realCode = 0;
    try { realOut = execFileSync('/usr/bin/fdesetup', ['status'], { encoding: 'utf8' }); } catch (err) { realOut = String(err.stdout || ''); realCode = err.status; }
    const realState = await fv.readFileVault();
    const realExpected = realCode === 0 && realOut.trim() === 'FileVault is On.' ? 'on'
        : realCode === 0 && realOut.trim() === 'FileVault is Off.' ? 'off' : 'unrecognised';

    const expectWarning = { none: null, off: APPROVED_OFF, unrecognised: APPROVED_UNRECOGNISED };
    const fixtureCase = (name, kind) => () => results[name].warning === expectWarning[kind];
    const body = (name) => (new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm').exec(SRC) || [''])[0];

    const CASES = [
        ['On ("FileVault is On.", exit 0): no warning', fixtureCase('on', 'none')],
        ['Off ("FileVault is Off.", exit 0): the approved off warning', fixtureCase('off', 'off')],
        ['unrecognised ("Encryption in progress: Percent completed = 34"): the approved unrecognised warning', fixtureCase('encrypting', 'unrecognised')],
        ['unrecognised ("FileVault is On." but exit 1): the approved unrecognised warning', fixtureCase('on-but-exit-1', 'unrecognised')],
        ['unrecognised (no output): the approved unrecognised warning', fixtureCase('empty', 'unrecognised')],
        ['unrecognised (other text): the approved unrecognised warning', fixtureCase('garbage', 'unrecognised')],
        ['unrecognised (no fdesetup at that path): the approved unrecognised warning, and nothing throws', fixtureCase('missing', 'unrecognised')],
        [`this Mac: the real fdesetup reads as what it printed (${JSON.stringify(realOut.trim())}, exit ${realCode} -> ${realExpected})`, () =>
            realState === realExpected],
        ['main.js (text): the view carries fileVaultWarning, null for the notice alone and until fdesetup answers', () =>
            body('setupView').includes('fileVaultWarning: w.noticeOnly || !w.fileVault ? null : filevault.fileVaultWarning(w.fileVault),')],
        ['main.js (text): the setup window reads FileVault only when it is not the notice alone, and logs the state only', () =>
            /if \(!noticeOnly\) \{\s*const w = setupWindow;\s*filevault\.readFileVault\(\)\.then\(\(state\) => \{\s*console\.error\(`\[clipwise-recorder\] setup: filevault \$\{state\}`\);/.test(body('showSetupWindow'))],
        ['setup.html and main.js (text): the page shows the warning with a link, and the link opens FileVault\'s settings', () =>
            HTML.includes("$('filevault-text').textContent = v.fileVaultWarning || '';")
            && HTML.includes("$('filevault').style.display = v.fileVaultWarning ? 'block' : 'none';")
            && HTML.includes("send('setup:filevault-settings')")
            && /ipcMain\.on\('setup:filevault-settings'[\s\S]{0,250}shell\.openExternal\(filevault\.SETTINGS_PANE\)/.test(SRC)],
        ['never blocking (text): setup.js, finishSetup and startRecording say nothing about FileVault', () =>
            !/filevault/i.test(SETUP_JS) && !/filevault/i.test(body('finishSetup')) && !/filevault/i.test(body('startRecording'))],
        ['build-app.sh (text): copies filevault.js into the bundle (main.js requires it)', () =>
            BUILD.includes('cp "$APP_SRC/filevault.js" "$C/Resources/app/filevault.js"')],
    ];

    console.log(`source: ${REV ? `${REV} main.js, setup.html, setup.js and build-app.sh; FileVault check: STAND-IN that never warns (c5b1408 has none)` : 'filevault.js, main.js, setup.html, setup.js and build-app.sh in the checkout'}`);
    console.log('expected to fail on c5b1408: cases 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 13, and nothing else');
    for (const [name, r] of Object.entries(results)) console.log(`fixture ${name}: state ${r.state} warning ${JSON.stringify(r.warning)}`);
    console.log(`this Mac: /usr/bin/fdesetup status -> ${JSON.stringify(realOut)} exit ${realCode}; readFileVault() -> ${realState}`);
    let fails = 0;
    CASES.forEach(([name, fn], i) => {
        let ok = false;
        try { ok = !!fn(); } catch { ok = false; }
        if (!ok) fails++;
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${i + 1}. ${name}`);
    });
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${CASES.length - fails}/${CASES.length} as expected`);
    process.exit(fails ? 1 : 0);
})();
