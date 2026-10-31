// Clipwise recorder — Electron menu bar shell.
// Main process only. Spawns tap + mic + poller directly (no bash wrapper),
// tracks a four-label state machine, and tears everything down on Stop or
// Quit. Filenames, timestamp format and output directory match what
// recorder/transcribe.py expects.
//
// On Stop it also spawns the capture→moments pipeline, which is what makes
// the loop unattended: nothing between a capture ending and moments existing
// is a human. The recorder is the trigger; the manifest it wrote at capture
// start is the record the pipeline keys on.

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, shell, dialog, clipboard, safeStorage, systemPreferences, powerMonitor, autoUpdater } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const { randomUUID, randomBytes, createHash } = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
    IDENTITY_WINDOW, contentHeightFor, knownGuestNames, mergeGuestNames,
    buildAnswerDoc, writeAnswer, readAnswer, correctsFor,
    CALENDAR_PREVIEW_WAIT_MS, calendarPrefillFrom, buildInviteeNamesDoc, writeInviteeNames,
    writeLaterMarker, readLaterMarker, deleteLaterMarker,
    recentPendingIdentityStems,
    buildVoiceNamesDoc, writeVoiceNamesAnswer, readNamingData, recentPendingVoiceNamingStems,
    readVoiceNamesAnswer, mostRecentNamedStem, mostRecentCaptureStem, assignVoice,
} = require('./identity-answer.js');
const { stopMessageFor } = require('./voice-naming-wait.js');
// Which meeting the tray's "Save transcript" item acts on (SAA-199).
const {
    lastMeeting, classifyCapture, stemTimeMs, isTrashed, writeCalendarMatchFile, jobPollStep, JOB_POLL_MS, JOB_POLL_LIMIT_MS, JOB_SETTLED,
    failureResolved,
} = require('./last-meeting.js');
// The recent-meetings window's rows (SAA-217).
const { listMeetings, listTrashed } = require('./meetings.js');
const { removeCaptureFiles } = require('./capture-files.js');
// The body of POST /captures (SAA-260 step 3 moved it out for its check).
const { buildCapturePayload: buildCapturePayloadIn } = require('./capture-payload.js');
// Voice prints on this Mac, watch only (SAA-260 step 3): the store, enrolment,
// deletion and the matcher's score log. Never uploaded.
const voicePrintsModule = require('./voice-prints.js');
const { matchCapture } = require('./voice-match.js');
// The day log's lines where call content is at hand: counts and kinds only.
const logLines = require('./log-lines.js');
// Day logs kept for 30 days (SAA-243 item 7).
const { pruneDayLogs } = require('./day-logs.js');
// Setup's FileVault warning (SAA-243 item 7).
const filevault = require('./filevault.js');
// The permission gate at start and its resume, and the system audio prompt's
// process (SAA-124).
const startGate = require('./start-gate.js');
const { createPromptChild } = require('./prompt-child.js');
const { loadAppScope, scopeForKey } = require('./app-scope.js');
// The auto-stop decision (SAA-184). Pure: it returns what should happen, and
// autostopFeed carries out the one effect that stops a capture.
const autostop = require('./autostop.js');
// Whether a downloaded update may be applied now (SAA-253). Pure, like
// autostop.js; updateIdle below gathers its inputs.
const updateGate = require('./update-gate.js');
// The "Still recording?" reminder: the decision only. This file reads the tap,
// shows the notification and carries out the one effect, a stop.
const silenceReminder = require('./silence-reminder.js');
// The first-run acknowledgement and the notice line (SAA-216). Pure; the gate
// that uses it is startRecording.
const consent = require('./consent.js');
// First-run setup, launch at login, the move to Applications and the recording
// time in the menu bar (SAA-198 step 4). Pure; the window is below.
const setup = require('./setup.js');
// The tray's Sign out revokes the refresh token on the server (SAA-198 step 5).
const { revokeRefreshToken } = require('./capture-sign-out.js');
// The capture token's form post to the token endpoint, and one refresh.
const { postCaptureTokenForm, refreshCaptureTokens } = require('./capture-refresh.js');

// --- constants ------------------------------------------------------------
// All measurements come from 5-second captures on 2026-08-09. A long
// recording may tear down or flush differently — these are provisional.

// SIGINT to all children, wait, then SIGKILL survivors. Observed exit:
// tap 5–15 ms, ffmpeg 10–30 ms. 750 ms is ~25× the observed max. miccap
// replaced ffmpeg on the mic (SAA-106); its stop path is the same shape —
// stop the IOProc, patch the WAV header, close — and has not been re-timed,
// so the same grace applies until it is.
const KILL_GRACE_MS = 750;

// Starting → Recording deadline. First-byte observed: tap ~100 ms,
// mic ~1700 ms (mic is the binding constraint). Generous deliberately —
// failing early refuses a recording that would have worked.
const STARTING_TIMEOUT_MS = 9000;

// File-size poll interval and per-child staleness windows.
// Observed growth cadence: tap ~50 ms, ffmpeg flushed every ~1550 ms —
// per-tick growth cannot be the test. A child counts as growing if it
// grew within its own window. miccap writes every IOProc callback (~10.7 ms
// at 48 kHz), so the mic is now far smoother than the window assumes; the
// window is left as-is because it is an upper bound and a smoother writer
// cannot trip it. Staleness switches the tray label to
// "Recording (stalled)" but does not kill children — losing the rest of
// a call to a possibly-wrong constant is worse than a misleading label.
const POLL_INTERVAL_MS = 250;
// "Still recording?" (silence-reminder.js). The tap is read in pieces of at
// most SILENCE_CHUNK_BYTES, up to SILENCE_MAX_CHUNKS_PER_TICK per poll, so a
// poll that finds a backlog catches up without holding the main process. An
// unanswered reminder is withdrawn after SILENCE_REMINDER_TTL_MS.
const SILENCE_CHUNK_BYTES = 262144;
const SILENCE_MAX_CHUNKS_PER_TICK = 8;
const SILENCE_REMINDER_TTL_MS = 5 * 60 * 1000;
const TAP_STALE_MS = 1000;
const MIC_STALE_MS = 3200;

// Manifest schema version. Bump on any change that is not purely additive.
const MANIFEST_VERSION = 1;

// Minimum gap between recording↔stalled notifications. Every other transition
// notifies unconditionally, but this pair can oscillate: staleness is evaluated
// every POLL_INTERVAL_MS against a 1 s window, so a marginal tap can cross the
// line several times a minute and would otherwise produce a notification each
// time. The tray label still flips immediately; only the notification is held.
const FLAP_NOTIFY_MIN_MS = 30000;

// How long a detection prompt stays answerable (SAA-113). A prompt that is
// never answered expires to "not now", which writes nothing — so this is the
// window in which a durable answer can be given, not a deadline on the call.
// Generous because the prompt arrives exactly when someone is joining a call
// and has other things to do for the first minute of it.
const DETECT_PROMPT_TTL_MS = 180000;

// Minimum gap between prompts for the same application. Without it an app
// that opens and closes the microphone repeatedly — a browser tab being
// reloaded — would queue a prompt each time. A declined app going quiet and
// noisy again inside this window is the same episode, not a new one.
const DETECT_REPROMPT_MS = 120000;

// Executable names belonging to Clipwise's own capture. miccap holds the
// microphone for the whole of a recording, so without this the detector sees
// its own capture and offers to record it — observed on the SAA-113 probe run
// as exactly what Fathom does when it auto-starts on a call. Matched on the
// executable name because these are bare SPM binaries with no bundle ID.
const DETECT_SELF_EXES = new Set(['miccap', 'systemtap', 'audiodevs', 'micwatch']);

// The tap is created with isMono=true, so its stream is one channel whatever
// the output device carries. Recorded here because the tap track is headerless
// PCM: a consumer cannot recover channel count from the file.
const TAP_CHANNELS = 1;

// --- paths ----------------------------------------------------------------

// Two layouts, told apart by one file. Run from a checkout (`npm start`),
// every path is relative to this one. Run from the .app that build-app.sh
// produces, everything the app and its capture pipeline run ships inside the
// bundle and is found relative to it (SAA-198): nothing is read from a checkout.
// build-app.sh writes build-info.json into the bundle, and the presence of that
// file is what says which layout this is.
//
// Presence of the file rather than app.isPackaged: isPackaged is derived from
// the name of the executable, which is a fact about how the bundle was
// assembled rather than a statement about where this app expects to find
// anything. A rename would silently move every path below.
const BUILD_INFO = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
    } catch {
        return null;
    }
})();

// The .app this process runs from (Contents/MacOS/Clipwise, three levels down).
// Meaningful only from a bundle. The launch line names it so a day log says which
// copy ran as well as which build: on 2026-10-26 a 274f52b build ran while
// cb8795d was installed, and nothing in the log said where it was.
const APP_BUNDLE_PATH = path.resolve(process.execPath, '..', '..', '..');

const RECORDER_DIR = path.resolve(__dirname, '..');
const BUNDLED_BIN = path.resolve(__dirname, '..', 'bin');
const SYSTEMTAP_BIN = BUILD_INFO
    ? path.join(BUNDLED_BIN, 'systemtap')
    : path.join(RECORDER_DIR, 'systemtap', '.build', 'release', 'systemtap');
const MICCAP_BIN = BUILD_INFO
    ? path.join(BUNDLED_BIN, 'miccap')
    : path.join(RECORDER_DIR, 'miccap', '.build', 'release', 'miccap');
const AUDIODEVS_BIN = BUILD_INFO
    ? path.join(BUNDLED_BIN, 'audiodevs')
    : path.join(RECORDER_DIR, 'audiodevs');
const MICWATCH_BIN = BUILD_INFO
    ? path.join(BUNDLED_BIN, 'micwatch')
    : path.join(RECORDER_DIR, 'micwatch');

// CLIPWISE_SUPPORT_DIR is for testing a fresh install without touching a real
// one (SAA-216): everything that is state — the acknowledgement, detected apps,
// the captures — hangs off this directory. Unset in normal use. When set, the
// launch log says so, so a stray value in an environment cannot go unnoticed.
const SUPPORT_DIR = process.env.CLIPWISE_SUPPORT_DIR
    ? path.resolve(process.env.CLIPWISE_SUPPORT_DIR)
    : path.join(os.homedir(), 'Library', 'Application Support', 'clipwise');
if (process.env.CLIPWISE_SUPPORT_DIR) {
    console.error(`[clipwise-recorder] SUPPORT_DIR overridden by CLIPWISE_SUPPORT_DIR: ${SUPPORT_DIR}`);
}
const OUTDIR = path.join(SUPPORT_DIR, 'recordings');

// Which applications may start a capture, learned one answer at a time
// (SAA-113). No list ships: this file does not exist until the first durable
// answer is given. It lives beside the recordings rather than in the bundle
// so it survives both an app restart and a rebuild — build-app.sh writes only
// recorder/app/dist, and never touches this directory.
const DETECT_STORE_PATH = path.join(SUPPORT_DIR, 'detected-apps.json');

// The capture pipeline. They need no database and no API key: the server ingests
// and extracts (SAA-227).
//
// From a checkout, its scripts run through the server's own tsx so the seam
// always executes current source. From the bundle (SAA-198), build-app.sh has
// compiled them into Resources/pipeline, and they run on this app's own
// executable as Node (ELECTRON_RUN_AS_NODE). Every tool they run is the bundle's
// copy, named in PIPELINE_TOOLS_ENV, so nothing comes from a checkout or PATH.
const SERVER_DIR = path.resolve(RECORDER_DIR, '..', 'server');
const RESOURCES_DIR = path.resolve(__dirname, '..');
const BUNDLED_PIPELINE_DIR = path.join(RESOURCES_DIR, 'pipeline');
const PIPELINE_TOOLS_ENV = BUILD_INFO ? {
    CLIPWISE_PYTHON: path.join(RESOURCES_DIR, 'python', 'bin', 'python3'),
    // The bundle's Python writes no compiled files: they would land inside the
    // signed bundle and break its signature. capture-cli also passes -B, because
    // it runs Python with -I, which ignores this variable; the variable covers a
    // Python started without -I.
    PYTHONDONTWRITEBYTECODE: '1',
    CLIPWISE_TRANSCRIBE_PY: path.join(BUNDLED_PIPELINE_DIR, 'transcribe.py'),
    FFMPEG_BIN: path.join(BUNDLED_BIN, 'ffmpeg'),
    PARAKEET_BIN: path.join(BUNDLED_BIN, 'parakeet'),
    PARAKEET_MODELS: path.join(RESOURCES_DIR, 'models', 'parakeet'),
    AEC_BIN: path.join(BUNDLED_BIN, 'aec'),
    DIARIZE_BIN: path.join(BUNDLED_BIN, 'diarize'),
    DIARIZE_MODELS: path.join(RESOURCES_DIR, 'models', 'diarize'),
} : null;

// --- log ------------------------------------------------------------------
//
// Everything this process reports about itself goes to stdout/stderr, and a
// double-clicked app has neither — launchd sends them nowhere a person can
// read. That is the whole diagnostic surface of the recorder disappearing at
// exactly the point it stops being launched from a terminal, which is what
// packaging is for. Every notification-delivery line, every child spawn
// failure and every pipeline error is in there — console.log too (SAA-197):
// a live run needs everything it printed to be diagnosable afterwards, not
// only the error-level half. (This replaced an error-only, single-ever-
// growing-file version of the same idea.)
//
// In the recordings folder, not SUPPORT_DIR's root: it sits beside the
// captures and sidecars it explains. One file per day (recorder-
// YYYY-MM-DD.log, local date, append) rather than one file that grows
// forever, so a single day's run is readable without external log rotation.
//
// Only when packaged. A terminal run already shows this, and writing a file
// nobody asked for would be a change to how development works.
function recorderLogPathFor(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return path.join(OUTDIR, `recorder-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
}
if (BUILD_INFO) {
    const toStdout = console.log.bind(console);
    const toStderr = console.error.bind(console);
    const appendToLogFile = (line) => {
        try {
            fs.mkdirSync(OUTDIR, { recursive: true });
            fs.appendFileSync(recorderLogPathFor(), `${new Date().toISOString()} ${line}\n`);
        } catch {
            // A log that cannot be written is not worth losing a capture over.
        }
    };
    console.log = (...args) => {
        toStdout(...args);
        appendToLogFile(args.map(a => String(a)).join(' '));
    };
    console.error = (...args) => {
        toStderr(...args);
        appendToLogFile(args.map(a => String(a)).join(' '));
    };
    console.error(
        `[clipwise-recorder] launched from bundle — built ${BUILD_INFO.built_at} ` +
        `commit ${BUILD_INFO.commit}${BUILD_INFO.dirty ? '+dirty' : ''} ` +
        `app ${APP_BUNDLE_PATH}`);
}

// One Clipwise at a time (SAA-198, Jon's call 6). A second launch quits here and
// the running one hears of it ('second-instance', in app boot). The capture
// pipeline runs this same executable as Node (ELECTRON_RUN_AS_NODE), which never
// loads this file, so the lock cannot turn the pipeline away.
const GOT_SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock();
if (!GOT_SINGLE_INSTANCE_LOCK) {
    console.error('[clipwise-recorder] another Clipwise is already running — this launch quits');
    app.quit();
}
const TSX_BIN = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx');
// The capture pipeline (SAA-227): transcribe, classify, diarize and naming data,
// on this Mac and from files only. The upload at its exit hands the rest to the server.
const CAPTURE_PIPELINE_ENTRY = BUILD_INFO
    ? path.join(BUNDLED_PIPELINE_DIR, 'pipeline', 'capture-cli.js')
    : path.join(SERVER_DIR, 'src', 'pipeline', 'capture-cli.ts');
// Finds captures whose pipeline never finished, or never started, and finishes
// them (SAA-136, SAA-227). Spawned on launch and after a pipeline run fails.
// Driven by the files in OUTDIR.
const CAPTURE_RECOVER_ENTRY = BUILD_INFO
    ? path.join(BUNDLED_PIPELINE_DIR, 'pipeline', 'capture-recover.js')
    : path.join(SERVER_DIR, 'src', 'pipeline', 'capture-recover.ts');
// How often the naming window polls for diarize's naming data while step 2
// is in its waiting state (SAA-195). Diarize itself is fast (single-digit
// seconds), but it runs after transcribe (transcribe and the old on-Mac ingest
// together took 37-82s on the two captures this was measured against) — so what
// this window actually waits through is the whole preceding pipeline, not
// just diarize. 3s keeps the wait itself cheap without polling pointlessly
// often.
const VOICE_NAMING_POLL_MS = 3000;
// Hard cap on step 2's wait (SAA-195 fix, 2026-09-25): past this, waiting
// stops being a reasonable thing to ask of an open window. Treated exactly
// as Later — silent, no message, since giving up is a patience limit, not
// a fact about the call. If diarize finishes after this, its naming-data
// file just sits on disk until the "Name N voices…" tray item picks it up.
const VOICE_NAMING_WAIT_CAP_MS = 15 * 60 * 1000;
// How long a stop message ("nothing to name" / "couldn't separate") stays
// on screen before the window closes itself.
const VOICE_NAMING_STOP_MESSAGE_MS = 5000;

// The identity prompt's page, and the file that remembers what the person
// answering is called. The name is asked for once and reused; it is never
// derived from the account — `id -F` on this machine answers "JD", which is
// what the OS knows and not what a person would type. Guessing it would put a
// name nobody chose on every recording.
const IDENTITY_HTML = path.join(__dirname, 'identity.html');
const SETUP_HTML = path.join(__dirname, 'setup.html');
const MEETINGS_HTML = path.join(__dirname, 'meetings.html');
const VOICE_PRINTS_HTML = path.join(__dirname, 'voice-prints.html');
// How long the prompt waits for the page to report its height before showing
// itself anyway. Short enough not to be noticed after a capture, long enough
// for a local file: the measurement is sent from the page's first script run.
const IDENTITY_REVEAL_GRACE_MS = 400;
const SELF_PATH = path.join(SUPPORT_DIR, 'identity-self.json');

// The Clipwise server each capture is sent to (SAA-227):
// {"url": "https://<team>.clipwiseapp.com"}. No file, or no usable URL in it,
// means no upload: the capture stays on this Mac.
const CAPTURE_SERVER_PATH = path.join(SUPPORT_DIR, 'capture-server.json');
// The recorder's OAuth client on every instance (server/src/auth/recorder-client.ts):
// public, PKCE S256, loopback redirect on any port. The capture token it gets is
// for <server>/capture with the capture scope, and a refresh token.
const CAPTURE_CLIENT_ID = 'clipwise-recorder';
const CAPTURE_SCOPES = 'openid offline_access clipwise:capture';
// The capture token and its refresh token, encrypted with Electron's safeStorage
// (a key the Keychain holds for this app). Never written in the clear.
const CAPTURE_TOKEN_PATH = path.join(SUPPORT_DIR, 'capture-token.bin');
// How long before the access token runs out (600 s on the server) it is refreshed.
const CAPTURE_REFRESH_EARLY_MS = 60 * 1000;
// After a refresh whose every request failed on the network, the next is tried
// after this delay, doubled after each such failure up to the cap.
const CAPTURE_RETRY_FIRST_MS = 60 * 1000;
const CAPTURE_RETRY_MAX_MS = 60 * 60 * 1000;

// From a checkout, a GUI-launched Electron inherits a minimal PATH with no
// Homebrew on it, and the pipeline shells out to python3 and ffmpeg by name, so
// Homebrew is added. From the bundle every tool is named by full path
// (PIPELINE_TOOLS_ENV), so PATH is left as the app received it.
const PIPELINE_PATH = BUILD_INFO ? (process.env.PATH || '') : [
    ...new Set([
        ...(process.env.PATH || '').split(':').filter(Boolean),
        '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    ]),
].join(':');

// How a pipeline script is started: the command, its arguments before the
// script's own, the working directory and the environment.
function pipelineSpawn(entry, args) {
    if (BUILD_INFO) {
        return {
            cmd: process.execPath,
            args: [entry, ...args],
            cwd: RESOURCES_DIR,
            env: withHostPrintFlag({ ...process.env, PATH: PIPELINE_PATH, ELECTRON_RUN_AS_NODE: '1', ...PIPELINE_TOOLS_ENV }),
        };
    }
    return { cmd: TSX_BIN, args: [entry, ...args], cwd: SERVER_DIR, env: withHostPrintFlag({ ...process.env, PATH: PIPELINE_PATH }) };
}

// diarize writes the member's own print (host-print-<stem>.json) only with
// this set, and it is set only while voice prints are on (SAA-260 step 3). A
// value inherited from this process's own environment is never passed on.
function withHostPrintFlag(env) {
    delete env.CLIPWISE_SAVE_HOST_PRINT;
    if (voicePrintsOn()) env.CLIPWISE_SAVE_HOST_PRINT = '1';
    return env;
}

// --- state ----------------------------------------------------------------

let tray = null;
// Set once quitApp has started tearing down, so anything that restarts
// itself on death — the detector — knows not to.
let isQuitting = false;
// 'stopped' | 'starting' | 'recording' | 'stalled'
let state = 'stopped';
let session = null;
// What caused the capture that is about to start, when it was not a person.
// Set immediately before the detection path calls startRecording() and
// consumed unconditionally there, so it can never survive to label a later,
// unrelated start. Carries the fact the removed "call detected" notification
// used to carry (SAA-151).
let pendingStartTrigger = null;
let teardownInFlight = false;

// Pipeline state is tracked separately from capture state, not folded into
// it. Transcription can take minutes and outlives the capture that
// triggered them; a single state variable would leave the tray claiming to be
// busy and refusing to start the next meeting's recording for no reason.
// { stem, state: 'running' | 'failed', proc }
let pipeline = null;

// Most recent permission finding, shown in the tray until dismissed.
// { denied: ['System Audio', …], blocked: bool, note: string|null }
let permissionIssue = null;

// Last time a recording↔stalled transition was allowed to notify.
let lastFlapNotifyMs = 0;

// Call detection (SAA-113). `detectApps` is the learned list, mirrored from
// DETECT_STORE_PATH; `detectProc` is the micwatch subprocess; `detectPending`
// is the prompt currently awaiting an answer, if any; `detectLastPrompt` maps
// a bundle ID to when it was last asked about, for DETECT_REPROMPT_MS.
//
// detectPending is deliberately in memory only. It is the whole of the
// "not now" answer: if this process dies, or the prompt is never answered, it
// disappears and nothing was written. { key, name, pid, at, timer }
let detectApps = null;
let detectProc = null;
let detectPending = null;
const detectLastPrompt = new Map();

// App -> scope inference (SAA-170). Logic lives in app-scope.js (no
// Electron in it, same reason identity-answer.js is split out); this is
// just the lazy load and the lookup main.js's capture path calls.
let appScope = null;
function scopeForDetectedKey(key) {
    if (!key) return null;
    if (!appScope) appScope = loadAppScope(SUPPORT_DIR);
    return scopeForKey(key, appScope);
}

// The human-recognisable name for a detected-apps entry, preferring the
// app-scope store's `label` (e.g. "FaceTime" for the avconferenced daemon)
// over the process-derived `name` detectApps itself carries, and falling
// back to the raw key when neither is set. Read path only — the label lives
// in app-scope.js's store, not duplicated into detected-apps.json.
function displayNameForDetectedKey(key, entry) {
    if (!appScope) appScope = loadAppScope(SUPPORT_DIR);
    const scoped = appScope[key];
    return (scoped && scoped.label) || (entry && entry.name) || key;
}

// Which application keys are using the microphone right now, maintained from
// micwatch's in_start/in_stop pairs: key -> Map(pid -> { name, path }). A key
// is present only while at least one of its processes holds the microphone.
//
// A pid set rather than one entry per key (SAA-184): Chrome can run more than
// one helper process under the same bundle ID, and one entry per key let a
// second helper overwrite the first, so either one releasing emptied the key.
// Read for two questions: is a late-answered prompt's call still going, and
// which pids held the trigger's microphone when a capture started.
const detectActive = new Map();

function detectActiveName(key) {
    const pids = detectActive.get(key);
    if (!pids) return null;
    for (const v of pids.values()) return v.name;
    return null;
}

// Identity prompts waiting to be shown, and the one on screen (SAA-114).
// A queue rather than a single slot: two captures can stop before either is
// answered, and replacing the open window would silently drop the first
// answer. { stem, recordingId, token }
const identityQueue = [];
let identityWindow = null;
// The calendar's guests for a capture waiting on step 1 (SAA-221), by window
// token: calendarPrefillFrom's { title, named, unnamed }. Kept here and never on
// the capture object, because the later-marker is written from that object and
// a preview holds invitee addresses. Dropped when the window closes.
const calendarPreviews = new Map();

const LABEL = {
    stopped:   'Stopped',
    starting:  'Starting',
    recording: 'Recording',
    stalled:   'Recording (stalled)',
};

// Menu-item text, not title text — see renderTray. These were tray-title
// suffixes and were the same overflow hazard as the permission suffix that
// actually triggered it.
// Functions rather than strings because the failed line names a file, and a
// file name that is not built from the stem is a literal `<stem>` on screen —
// which is what it read as, while the Retry item directly below it carried the
// real one (SAA-150).
const PIPELINE_NOTE = {
    running: () => 'Processing capture…',
    failed:  stem => `Processing failed — see pipeline-${stem}.json`,
};

// --- helpers --------------------------------------------------------------

function utcStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
           `T${p(d.getUTCHours())}-${p(d.getUTCMinutes())}-${p(d.getUTCSeconds())}Z`;
}

function fileSize(p) {
    try { return fs.statSync(p).size; } catch { return 0; }
}

// One pre-flight CoreAudio snapshot: the device identity and nominal rate that
// seed the manifest. Taken before the children spawn, because neither child has
// reported its own format yet at the moment the manifest is written — see
// writeManifest. Since SAA-106 the mic entry is no longer final at that point:
// finalizeMicFormat overwrites it at teardown with the device and format miccap
// read back off the written file. These values remain what the manifest carries
// if that readback is unavailable.
function readDevices() {
    const out = execFileSync(AUDIODEVS_BIN, ['--once'], { encoding: 'utf8' });
    const field = (re, label) => {
        const m = out.match(re);
        if (!m) throw new Error(`audiodevs --once: could not parse ${label} from: ${out}`);
        return m[1];
    };
    // audiodevs reports 0 when the rate query fails. Unknown is null in the
    // manifest, never a plausible-looking number.
    const rate = (re, label) => {
        const n = Number(field(re, label));
        return Number.isFinite(n) && n > 0 ? n : null;
    };
    return {
        inName:  field(/\bin_name="([^"]*)"/, 'in_name'),
        inUid:   field(/\bin_uid="([^"]*)"/, 'in_uid'),
        inRate:  rate(/\bin_rate=(\S+)/, 'in_rate'),
        outName: field(/\bout_name="([^"]*)"/, 'out_name'),
        outUid:  field(/\bout_uid="([^"]*)"/, 'out_uid'),
        outRate: rate(/\bout_rate=(\S+)/, 'out_rate'),
        micPerm: field(/\bmic_perm=(\S+)/, 'mic_perm'),
        tapPerm: field(/\btap_perm=(\S+)/, 'tap_perm'),
    };
}

// Settings panes, for the affordance offered when a grant is missing. Telling
// someone permission is off without a way to fix it is only half an answer.
const SETTINGS_PANE = {
    'System Audio': 'x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture',
    'Microphone':   'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};

// Only an explicit denial counts. notDetermined resolves with a click (the
// prompt fires on first use, and SAA-90's start gate covers a non-answer), and
// unavailable/restricted are not statements about this user's grant.
function deniedServices(dev) {
    const out = [];
    if (dev.micPerm === 'denied') out.push('Microphone');
    if (dev.tapPerm === 'denied') out.push('System Audio');
    return out;
}

// The tray's and the notification's line for the services deniedServices found.
function deniedNote(denied) {
    return denied.length === 2
        ? 'Both audio permissions are off — capture would record nothing'
        : `${denied[0]} permission is off — fix it to record`;
}

// The manifest is what makes a capture a thing rather than a naming
// convention: an opaque id that does not depend on a correct clock, and the
// per-track device and rate that are otherwise recoverable only from child
// stderr that nothing preserves.
//
// Rates come from the CoreAudio query above, not from the children. systemtap
// and miccap both report their real format milliseconds after they start;
// waiting for that would make this a post-hoc artifact rather than something
// written at capture start. sample_rate_source records that provenance in the
// file so a consumer never has to guess which it is holding — and for the mic
// track it is rewritten to wav_fmt_chunk_readback once the file is finished.
function buildManifest(stamp, startedAt, dev, paths, trigger) {
    return {
        manifest_version: MANIFEST_VERSION,
        recording_id: randomUUID().toUpperCase(),
        started_at: startedAt,
        // The filename stem stays the human-readable handle. It is recorded,
        // not derived from — recording_id is the identifier.
        stem: stamp,
        // Which application's microphone use started this capture, or null
        // for a manual start (SAA-170). This is step one of that issue:
        // nothing downstream can be verified about app-inferred scope until
        // the app that triggered a capture is on the record somewhere other
        // than a variable that dies with the process.
        trigger_app: trigger ? { key: trigger.key, name: trigger.name } : null,
        // The recording-notice acknowledgement in force when this capture started
        // (SAA-227 part I), copied from consent.json. startRecording's gate has
        // already passed, so it is never null for a capture made by this build.
        notice: consent.noticeStamp(SUPPORT_DIR),
        tracks: [
            {
                track: 'system',
                file: path.basename(paths.tap),
                encoding: 'f32le',
                container: 'raw',
                channels: TAP_CHANNELS,
                sample_rate: dev.outRate,
                sample_rate_source: 'coreaudio_nominal_output',
                // The tap captures the default output device, so that is the
                // device this track belongs to.
                device_name: dev.outName,
                device_uid: dev.outUid,
            },
            {
                track: 'mic',
                file: path.basename(paths.mic),
                encoding: 'f32le',
                container: 'wav',
                sample_rate: dev.inRate,
                sample_rate_source: 'coreaudio_nominal_input',
                device_name: dev.inName,
                device_uid: dev.inUid,
            },
        ],
        logs: [paths.tapLog, paths.micLog, paths.pollLog].map(p => path.basename(p)),
        // Permission state at capture start. This is the only thing that can
        // tell a denied tap from a tap with nothing playing — the two are
        // bitwise identical in the audio itself (SAA-87). The classifier
        // downstream reads these; without them a silent tap is indeterminate.
        permissions: {
            mic: dev.micPerm,
            tap: dev.tapPerm,
            mic_source: 'avcapturedevice_authorization_status',
            tap_source: 'tcc_access_preflight_kTCCServiceAudioCapture',
        },
    };
}

// Rewrite the manifest's mic track from the format miccap read back off the
// finished WAV, replacing the CoreAudio nominal rate captured at start.
//
// The two are not always the same. A 2026-08-14 capture shipped a manifest
// declaring 24000 Hz for a track written at 48000 — anything trusting it read
// that timeline at half speed. The nominal rate is what the device said it
// would do; the fmt chunk is what it did. Only the second is a fact about the
// file, so it becomes authoritative and the first is kept alongside it under
// requested_sample_rate rather than discarded.
//
// Runs after the children are gone, because the readback line is written by
// miccap's SIGINT handler once the header has been patched. A failure here is
// logged and swallowed: the audio is already on disk and refusing to finish
// the capture over a metadata rewrite would be a worse outcome than a manifest
// that still carries the requested value.
function finalizeMicFormat(paths) {
    try {
        const log = fs.readFileSync(paths.micLog, 'utf8');
        const m = [...log.matchAll(
            /^readback format_tag=0x([0-9a-fA-F]+) channels=(\d+) sample_rate=(\d+) bits=(\d+) block_align=(\d+) data_bytes=(\d+) frames=(\d+) duration_s=([\d.]+)/gm,
        )].pop();
        if (!m) {
            console.error(`manifest: no readback line in ${paths.micLog} — mic format left as requested`);
            return;
        }
        const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
        const track = (manifest.tracks || []).find(t => t.track === 'mic');
        if (!track) {
            console.error('manifest: no mic track to update');
            return;
        }
        // The device, from the same source, for the same reason. miccap
        // resolves kAudioHardwarePropertyDefaultInputDevice itself, so the name
        // readDevices() saw at start is a prediction — and the default input
        // can change between the two. A manifest naming a device that was not
        // the one recorded is the same class of lie as a wrong sample rate.
        // Last match, not first: logs are opened in append mode, so a reused
        // stem leaves earlier captures in the same file. Taking the first
        // device line and the last format line would describe two different
        // captures in one manifest entry.
        const d = [...log.matchAll(/^device=(.*) uid=(\S+) id=(\d+)$/gm)].pop();
        if (d) {
            track.requested_device_name = track.device_name;
            track.requested_device_uid = track.device_uid;
            track.device_name = d[1];
            track.device_uid = d[2];
            track.device_id = Number(d[3]);
            track.device_source = 'miccap_resolved_default_input';
            if (track.requested_device_uid !== track.device_uid) {
                console.error(
                    `manifest: mic device corrected ${track.requested_device_uid} -> ${track.device_uid} (default input changed between start and spawn)`);
            }
        } else {
            console.error(`manifest: no device line in ${paths.micLog} — mic device left as requested`);
        }

        track.requested_sample_rate = track.sample_rate;
        track.requested_sample_rate_source = track.sample_rate_source;
        track.sample_rate = Number(m[3]);
        track.sample_rate_source = 'wav_fmt_chunk_readback';
        track.format_tag = `0x${m[1].toLowerCase().padStart(4, '0')}`;
        track.channels = Number(m[2]);
        track.bits = Number(m[4]);
        track.block_align = Number(m[5]);
        track.data_bytes = Number(m[6]);
        track.frames = Number(m[7]);
        track.duration_s = Number(m[8]);
        fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + '\n');
        if (track.requested_sample_rate !== track.sample_rate) {
            console.error(
                `manifest: mic rate corrected ${track.requested_sample_rate} -> ${track.sample_rate} from the written file`);
        }
    } catch (err) {
        console.error(`manifest: mic format readback failed: ${String(err)}`);
    }
}

// The same treatment for the tap track, and the more urgent half of it: the
// 2026-08-14 capture that declared 24000 Hz for a track written at 48000 was
// this field, not the mic's. coreaudio_nominal_output is what the output device
// said its rate was at capture start; systemtap reports the format of the tap
// stream it actually opened (kAudioTapPropertyFormat), which is what the bytes
// on disk are in.
//
// The tap file is headerless, so there is no fmt chunk to re-read — the format
// comes from systemtap's log and the byte count comes from the file itself,
// which is the part no log can be wrong about. If the two disagree the file
// wins and the discrepancy is logged.
//
// The tap's device is not read back: systemtap logs no device identity, so
// device_name/device_uid stay as readDevices() saw them. Noted rather than
// silently implied to be verified.
function finalizeTapFormat(paths) {
    try {
        const log = fs.readFileSync(paths.tapLog, 'utf8');
        const m = [...log.matchAll(
            /^format sample_rate=(\d+) channels=(\d+) bits=(\d+) is_float=(\w+) is_packed=(\w+)/gm,
        )].pop();
        if (!m) {
            console.error(`manifest: no format line in ${paths.tapLog} — tap format left as requested`);
            return;
        }
        const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
        const track = (manifest.tracks || []).find(t => t.track === 'system');
        if (!track) {
            console.error('manifest: no system track to update');
            return;
        }
        const rate = Number(m[1]);
        const channels = Number(m[2]);
        const bits = Number(m[3]);

        // Ground truth for length. bytes_written is also logged, but a log line
        // is a claim about the file and the file is the file.
        let dataBytes = null;
        try { dataBytes = fs.statSync(paths.tap).size; } catch {}
        const claimed = [...log.matchAll(/^system_tap_stopped wall_ns=\d+ bytes_written=(\d+)/gm)].pop();
        if (claimed && dataBytes !== null && Number(claimed[1]) !== dataBytes) {
            console.error(
                `manifest: tap bytes_written=${claimed[1]} but file is ${dataBytes} — using the file`);
        }

        track.requested_sample_rate = track.sample_rate;
        track.requested_sample_rate_source = track.sample_rate_source;
        track.sample_rate = rate;
        track.sample_rate_source = 'systemtap_reported_tap_format';
        track.requested_channels = track.channels;
        track.channels = channels;
        track.bits = bits;
        track.is_float = m[4] === 'true';
        track.is_packed = m[5] === 'true';
        track.device_source = 'coreaudio_default_output_at_start';
        if (dataBytes !== null) {
            const blockAlign = (bits / 8) * channels;
            track.data_bytes = dataBytes;
            track.frames = blockAlign > 0 ? Math.floor(dataBytes / blockAlign) : null;
            track.duration_s = (rate > 0 && track.frames !== null)
                ? Number((track.frames / rate).toFixed(3))
                : null;
        }
        fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + '\n');
        if (track.requested_sample_rate !== track.sample_rate) {
            console.error(
                `manifest: tap rate corrected ${track.requested_sample_rate} -> ${track.sample_rate} from systemtap's reported format`);
        }
    } catch (err) {
        console.error(`manifest: tap format readback failed: ${String(err)}`);
    }
}

function spawnChild(cmd, args, env, logPath) {
    const fd = fs.openSync(logPath, 'a');
    const proc = spawn(cmd, args, {
        env,
        stdio: ['ignore', 'ignore', fd],
    });
    fs.closeSync(fd);
    return proc;
}

// --- tray icon ------------------------------------------------------------
//
// The tray was title-only, and a title-only item is sized by its text. When
// the status string grew from "Starting" to "Starting · Partial capture" the
// item silently disappeared from a full menu bar — macOS drops what does not
// fit, with no error and the app still running. An icon gives the item a fixed
// width it can never outgrow, so the failure cannot recur however the status
// vocabulary changes later. Status detail lives in the menu; the title stays
// down to a few characters.
//
// The icon is generated rather than shipped as an asset: a coloured dot is a
// few lines of PNG encoding, and that beats a binary file in the repo that
// nothing can diff.

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

// 32x32 RGBA dot, rendered at 16pt via scaleFactor 2.
function dotIcon(hex) {
    const size = 32, radius = 10, centre = (size - 1) / 2;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const raw = Buffer.alloc(size * (size * 4 + 1));
    let o = 0;
    for (let y = 0; y < size; y++) {
        raw[o++] = 0; // filter: none
        for (let x = 0; x < size; x++) {
            const d = Math.hypot(x - centre, y - centre);
            // One pixel of feather at the edge, so it does not look jagged.
            const a = Math.max(0, Math.min(1, radius + 0.5 - d));
            raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = Math.round(a * 255);
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type: RGBA
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
    return nativeImage.createFromBuffer(png, { scaleFactor: 2 });
}

// Still here, and still the state palette — the drawn assets below use these
// same four hex values, and dotIcon remains the fallback when an asset cannot
// be read.
const DOT = {
    stopped:   '#8E8E93',
    starting:  '#FF9F0A',
    recording: '#FF453A',
    stalled:   '#FFD60A',
};

// --- the drawn marks (SAA-130) --------------------------------------------
//
// A hybrid, not a single variant, and the split is deliberate:
//
//   stopped    template   the resting state, and the one the icon spends
//   starting   template   almost all its life in. Its neighbours in the menu
//                         bar are all monochrome, so it should sit among them
//                         quietly and follow the bar from light to dark.
//   recording  colour     colour means "this needs you". Red while recording
//   stalled    colour     is macOS's own idiom, and yellow says attention.
//
// The colour variant was measured as nearly invisible in the stopped state —
// grey bars on a grey bar — and that is exactly the state in which finding
// Clipwise in the menu bar is already a known problem (SAA-105).
//
// Mixing the two on one Tray is only possible because template-ness is a
// property of each NativeImage rather than of the Tray. Confirmed rather than
// assumed, on both layers: AppKit redraws the same status item's button as
// colour -> template -> colour with no latching, and Electron preserves each
// image's flag across four alternating setImage calls. Tray exposes no
// template API at all, which is the structural reason there is nothing to
// latch.
//
// Both full variants stay on disk. Switching to all-template or all-colour is
// this table, and nothing else.
const TRAY_VARIANT = {
    stopped:   'template',
    starting:  'template',
    recording: 'colour',
    stalled:   'colour',
};

const TRAY_ASSET_DIR = BUILD_INFO
    ? path.resolve(__dirname, '..', 'tray')
    : path.join(__dirname, 'assets', 'tray');

// createFromPath picks up the @2x sibling on its own — verified, the loaded
// image reports scaleFactors [1,2] where a file with no sibling reports [1].
// So only the base name is ever named here.
function loadTrayIcon(s) {
    const template = TRAY_VARIANT[s] === 'template';
    const file = path.join(TRAY_ASSET_DIR, `${s}${template ? 'Template' : ''}.png`);
    let img = null;
    try {
        img = nativeImage.createFromPath(file);
    } catch (err) {
        console.error(`tray: ${file} failed to load: ${String(err)}`);
    }
    // createFromPath does NOT throw on a missing or unreadable file: it returns
    // an EMPTY image, and an empty image renders as no menu bar icon at all.
    // That is the same shape of silent failure this whole area keeps producing,
    // so it is checked rather than trusted, and the generated dot is still here
    // to fall back to. A plain icon beats an invisible one.
    if (!img || img.isEmpty()) {
        console.error(`tray: ${file} missing or empty — falling back to the generated dot`);
        return dotIcon(DOT[s]);
    }
    img.setTemplateImage(template);
    return img;
}

const ICON = {};
function iconFor(s) {
    if (!ICON[s]) ICON[s] = loadTrayIcon(s);
    return ICON[s];
}

// --- tray -----------------------------------------------------------------

// The learned list, and the way back from any answer given to it. This is what
// makes "never ask" reversible rather than a trap, so it is not optional
// decoration — a durable decline with no visible way to undo it would be the
// worst outcome of the whole design.
//
// A control surface only: which applications may start a capture, and nothing
// about meetings, recordings or transcripts. That is the line the milestone
// guardrail draws, and it is the reason this is allowed to exist at all.
function detectedAppsMenu() {
    if (!detectApps) detectApps = loadDetectApps();
    const displayName = key => displayNameForDetectedKey(key, detectApps[key]);
    const keys = Object.keys(detectApps).sort((a, b) =>
        displayName(a).localeCompare(displayName(b)));
    if (keys.length === 0) {
        return {
            label: 'Detected applications',
            submenu: [{ label: 'None yet — Clipwise asks the first time', enabled: false }],
        };
    }
    return {
        label: 'Detected applications',
        submenu: keys.map(key => {
            const entry = detectApps[key];
            const decisionLabel = entry.decision === 'record' ? 'Always record' : 'Never ask';
            return {
                label: `${displayName(key)} — ${decisionLabel}`,
                submenu: [
                    { label: 'Always record', type: 'radio', checked: entry.decision === 'record',
                      click: () => setAppDecision(key, 'record', entry.name) },
                    { label: 'Never ask', type: 'radio', checked: entry.decision === 'never',
                      click: () => setAppDecision(key, 'never', entry.name) },
                    { type: 'separator' },
                    // Back to unknown: the next time it uses the microphone
                    // Clipwise asks again, as if it had never been answered.
                    { label: 'Forget this app', click: () => setAppDecision(key, null) },
                ],
            };
        }),
    };
}

// Compact relative time for a stem, for the tray item's label — same
// escalating precision as identity.html's own formatCaptureStem, kept
// separate rather than shared: that one runs in the renderer and measures
// duration too, this one is main-process-only and just needs "when."
function stemRelativeTime(stem) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(stem || '');
    if (!m) return stem || '';
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    if (Number.isNaN(d.getTime())) return stem;
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const now = new Date();
    const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const daysAgo = Math.round((midnight(now) - midnight(d)) / 86400000);
    if (daysAgo <= 0) return time;
    if (daysAgo === 1) return `Yesterday ${time}`;
    if (daysAgo <= 6) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
    return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

// "<Mon> <day>" for a stem, e.g. "Sep 14" — the "Fix speaker names…" tray
// item names the call by date only (SAA-195), not time: it identifies which
// call is being corrected, and a call has at most one named-voices answer,
// so the date alone is unambiguous.
function stemDateLabel(stem) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/.exec(stem || '');
    if (!m) return stem || '';
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
    if (Number.isNaN(d.getTime())) return stem;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// --- save transcript (SAA-199) --------------------------------------------

let savingTranscript = false;

// "Mon 1:00 PM", in the local time zone, from the capture's own start.
function stemWeekdayTime(stem) {
    const ms = stemTimeMs(stem);
    if (!Number.isFinite(ms)) return stem || '';
    const d = new Date(ms);
    const day = d.toLocaleDateString(undefined, { weekday: 'short' });
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${day} ${time}`;
}

function saveTranscriptLabel(meeting) {
    let title = meeting.title || 'Untitled';
    if (title.length > 48) title = title.slice(0, 47) + '…';
    const base = `Save transcript — ${title}, ${stemWeekdayTime(meeting.stem)}`;
    return meeting.state === 'ready' ? base : `${base} (not ready yet)`;
}

// The file is built by the server, into a temporary path; the person then picks
// where it goes, in a Save dialog opening on Downloads.
function saveTranscript(meeting) {
    if (savingTranscript || meeting.state !== 'ready') return;
    savingTranscript = true;
    renderTray();
    sendMeetingsData();
    const tmp = path.join(os.tmpdir(), `clipwise-transcript-${randomUUID()}.txt`);
    const done = () => {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        savingTranscript = false;
        renderTray();
        sendMeetingsData();
    };
    // The day log gets the error's code only: an fs error's message names the
    // file, and the file is named after the meeting. The notification keeps it.
    const failed = (err) => {
        console.error(logLines.saveTranscriptFailedLine(meeting.stem, err));
        notify('transcript-not-built', 'Clipwise: transcript not saved', `Couldn't build the transcript for ${meeting.stem}: ${(err && err.message) || String(err)}`);
    };
    buildTranscriptFromServer(meeting.stem, tmp)
        .then((meta) => offerTranscriptSave(meeting, tmp, meta), (err) => failed(err))
        .catch((e) => {
            console.error(logLines.saveTranscriptFailedLine(meeting.stem, e));
            notify('transcript-not-saved', 'Clipwise: transcript not saved', String(e.message || e));
        })
        .finally(done);
}

// The file the server builds for this capture (GET /captures/:captureId/transcript,
// the same builder get_transcript reads through), in this Mac's time zone, written
// to `tmp`. Resolves the file's fields (suggestedFileName, turns,
// unattributedTurns); only the text's SHA-256 is logged.
async function buildTranscriptFromServer(stem, tmp) {
    const server = signedInServer();
    // Each with a code, since the code is all the day log keeps of it.
    const fail = (code, message) => Object.assign(new Error(message), { code });
    if (!server) throw fail('not_signed_in', 'not signed in to the capture server');
    const captureId = captureIdFor(stem);
    if (!captureId) throw fail('no_recording_id', `manifest-${stem}.json has no recording_id`);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const reply = await captureServerRequest(server, 'GET', `/captures/${captureId}/transcript?tz=${encodeURIComponent(tz)}`);
    if (reply.status !== 200 || typeof reply.json.text !== 'string') {
        throw fail(`server_${reply.status ?? 'no_reply'}${reply.json.error ? `_${reply.json.error}` : ''}`,
            `server ${reply.status ?? 'no reply'} ${reply.json.error || ''}`.trim());
    }
    const hash = createHash('sha256').update(Buffer.from(reply.json.text, 'utf8')).digest('hex');
    console.error(`[clipwise-recorder] save-transcript ${stem}: server 200 sha256=${hash}`);
    fs.writeFileSync(tmp, reply.json.text, 'utf8');
    return reply.json;
}

// The Save dialog for a transcript file built at `tmp`, and the copy to where the
// person picks.
async function offerTranscriptSave(meeting, tmp, meta) {
    app.focus({ steal: true });
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Save transcript',
        defaultPath: path.join(app.getPath('downloads'), meta.suggestedFileName),
        filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return;
    fs.copyFileSync(tmp, filePath);
    console.error(logLines.saveTranscriptSavedLine(meeting.stem, meta.turns, meta.unattributedTurns));
    notify('transcript-saved', 'Clipwise: transcript saved', path.basename(filePath));
}

// --- recent meetings window (SAA-217) -------------------------------------
//
// The past week's captures, to pick the right meeting before acting on it
// (Architecture Decision 18). Rows come from meetings.js — files only, no
// transcript is read. The window offers the two actions that need a chosen
// meeting: save its transcript (the same path as the tray item) and fix its
// speaker names (the naming window, reopened for that recording).

let meetingsWindow = null;
let meetingsTimer = null;
const STEM_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

function sendMeetingsData() {
    if (!meetingsWindow || meetingsWindow.isDestroyed()) return;
    meetingsWindow.webContents.send('meetings:data', {
        rows: listMeetings(OUTDIR, undefined, undefined, captureStateOpts()),
        trashed: listTrashed(OUTDIR),
        saving: savingTranscript,
        busy: trashBusy,
    });
}

// --- trash (SAA-154) --------------------------------------------------------
// Move to trash, Restore and Delete permanently, one or several at once. The
// server decides (runTrashOnServer): this asks, sends it, and reports what it
// said. One batch at a time.

let trashBusy = false;

// One line of the delete confirmation: title, who was on the call, when. Most
// are "Untitled", and calls minutes apart look alike without the names.
function meetingLine(r) {
    const when = new Date(r.startedAtMs).toLocaleString(undefined, {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    const who = r.participants && r.participants.length ? r.participants.join(', ') : 'No one named';
    return `\u2022 ${r.title || 'Untitled'} \u00b7 ${who} \u2014 ${when}`;
}

async function changeTrash(action, rawStems) {
    if (trashBusy) return;
    if (!Array.isArray(rawStems)) return;
    const unique = Array.from(new Set(rawStems.filter((s) => typeof s === 'string' && STEM_PATTERN.test(s)))).slice(0, 100);
    // Re-checked at click time: what the window showed may be stale.
    let stems;
    if (action === 'trash') {
        stems = unique.filter((s) => !isTrashed(OUTDIR, s) && classifyCapture(OUTDIR, s, undefined, captureStateOpts()).state !== 'pending');
    } else {
        stems = unique.filter((s) => isTrashed(OUTDIR, s));
    }
    if (stems.length === 0) { sendMeetingsData(); return; }

    if (action === 'delete') {
        // The confirmation names each meeting, from what is on disk, not from
        // what the window sent. Cancel is the default and deletes nothing.
        const byStem = new Map(listTrashed(OUTDIR).map((r) => [r.stem, r]));
        const lines = stems.map((s) => meetingLine(byStem.get(s) || { startedAtMs: stemTimeMs(s), title: null, participants: [] }));
        try { app.focus({ steal: true }); } catch {}
        const { response } = await dialog.showMessageBox(meetingsWindow && !meetingsWindow.isDestroyed() ? meetingsWindow : undefined, {
            type: 'warning',
            buttons: ['Cancel', 'Delete permanently'],
            defaultId: 0,
            cancelId: 0,
            message: stems.length === 1 ? 'Permanently delete this meeting?' : `Permanently delete these ${stems.length} meetings?`,
            detail: `${lines.join('\n')}\n\nThe audio, the transcript and everything taken from it are deleted. This can't be undone.`,
        });
        if (response !== 1) return;
        // Restored while the dialog was open? Only what is still in the trash.
        stems = stems.filter((s) => isTrashed(OUTDIR, s));
        if (stems.length === 0) { sendMeetingsData(); return; }
    }

    // The server decides and this Mac follows it (SAA-227 part L decision 8).
    trashBusy = true;
    sendMeetingsData();
    let results;
    try {
        results = await runTrashOnServer(action, stems);
    } finally {
        trashBusy = false;
    }
    const failed = results.filter((r) => !r.ok);
    for (const r of results) {
        console.error(`[clipwise-recorder] trash ${action} ${r.stem}: ${r.ok ? 'ok' : `failed (${r.code}) ${r.message}`}`);
    }
    if (failed.length > 0) {
        const verb = { trash: 'moved to trash', restore: 'restored', delete: 'deleted' }[action];
        if (failed.every((r) => r.code === 'server_unreachable')) {
            notify('trash-unreachable', `Clipwise: not ${verb}`, `Couldn't reach the Clipwise server. Nothing was ${verb}.`);
        } else {
            notify('trash-refused', `Clipwise: ${failed.length} not ${verb}`, `${failed[0].message || failed[0].code}`);
        }
    }
    renderTray();
    sendMeetingsData();
}

function openMeetingsWindow() {
    // A row whose status is unknown gets its answer while the window is open.
    askJobsAgain('Recent meetings opened');
    if (meetingsWindow && !meetingsWindow.isDestroyed()) {
        meetingsWindow.show();
        try { app.focus({ steal: true }); } catch {}
        return;
    }
    meetingsWindow = new BrowserWindow({
        width: 640,
        height: 560,
        minWidth: 520,
        minHeight: 320,
        title: 'Recent meetings',
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    const win = meetingsWindow;
    win.once('ready-to-show', () => {
        win.show();
        try { app.focus({ steal: true }); } catch {}
    });
    win.on('closed', () => {
        if (meetingsTimer) { clearInterval(meetingsTimer); meetingsTimer = null; }
        if (meetingsWindow === win) meetingsWindow = null;
    });
    // A capture still being processed becomes ready on its own.
    meetingsTimer = setInterval(sendMeetingsData, 5000);
    win.loadFile(MEETINGS_HTML).catch((err) => {
        console.error(`meetings: window failed to load: ${String(err)}`);
        try { win.close(); } catch {}
    });
}

function registerMeetingsIpc() {
    ipcMain.on('meetings:ready', () => sendMeetingsData());
    ipcMain.on('meetings:save', (_event, payload) => {
        const stem = payload && payload.stem;
        if (typeof stem !== 'string' || !STEM_PATTERN.test(stem)) return;
        // Re-classified at click time: what the row showed may be stale.
        const c = classifyCapture(OUTDIR, stem, undefined, captureStateOpts());
        if (c.state !== 'ready' || isTrashed(OUTDIR, stem)) {
            notify('transcript-not-ready', 'Clipwise: nothing to save', `The capture ${stem} has no transcript to save yet.`);
            sendMeetingsData();
            return;
        }
        saveTranscript(c);
    });
    ipcMain.on('meetings:trash', (_event, payload) => { changeTrash('trash', payload && payload.stems); });
    ipcMain.on('meetings:restore', (_event, payload) => { changeTrash('restore', payload && payload.stems); });
    ipcMain.on('meetings:delete', (_event, payload) => { changeTrash('delete', payload && payload.stems); });
    ipcMain.on('meetings:fix', (_event, payload) => {
        const stem = payload && payload.stem;
        if (typeof stem !== 'string' || !STEM_PATTERN.test(stem)) return;
        if (isTrashed(OUTDIR, stem)) return; // in the trash: not acted on (SAA-154)
        // A rename only when names were already saved; otherwise it is the
        // first naming of this call's voices.
        reopenVoiceNaming(stem, { rename: readVoiceNamesAnswer(OUTDIR, stem) !== null });
    });
    ipcMain.on('meetings:change-identity', (_event, payload) => {
        const stem = payload && payload.stem;
        if (typeof stem !== 'string' || !STEM_PATTERN.test(stem)) return;
        if (isTrashed(OUTDIR, stem)) return; // in the trash: not acted on (SAA-154)
        reopenIdentityForCorrection(stem);
    });
}

// --- voice prints, watch only (SAA-260 step 3) ------------------------------
//
// Off by default; the tray's "Recognise voices…" opens the opt-in screen. While
// on: after a capture's pipeline, the member's own print diarize wrote is taken
// into the store and every voice is scored against the prints (voice-match.js,
// logged only, nobody named); after each send, the server's person ids enrol
// the confirmed voices (voice-prints.js). The store is encrypted with
// safeStorage, as the capture token is. Nothing in it is ever uploaded. The
// day log gets counts and words only.
let voicePrintsStore = null;
let voicePrintsWindow = null;

function voicePrints() {
    if (!voicePrintsStore) {
        voicePrintsStore = voicePrintsModule.createVoicePrints({
            supportDir: SUPPORT_DIR,
            outdir: OUTDIR,
            encrypt: (s) => safeStorage.encryptString(s),
            decrypt: (b) => safeStorage.decryptString(b),
        });
    }
    return voicePrintsStore;
}

function voicePrintsOn() {
    try { return voicePrints().isEnabled(); } catch { return false; }
}

// After a capture's pipeline (or a recovery pass) finished it.
function voicePrintsAfterPipeline(stem) {
    try {
        const vp = voicePrints();
        const host = vp.ingestHostPrint(stem);
        const m = matchCapture(vp, OUTDIR, stem);
        if (host !== 'none' || !m.skipped) {
            console.error(`[clipwise-recorder] voice prints ${stem}: host print ${host}, ${m.skipped ? `match skipped (${m.skipped})` : `matched ${m.voices} voice(s) against ${m.profiles} print(s)`}`);
        }
    } catch (err) {
        console.error(`[clipwise-recorder] voice prints ${stem}: after pipeline failed (${err.code || err.name})`);
    }
}

// After a send the server answered 200 or 201: its person ids for the voices.
function voicePrintsAfterSend(stem, people) {
    try {
        const r = voicePrints().enrolFromMapping(stem, people);
        if (!r.skipped) console.error(`[clipwise-recorder] voice prints ${stem}: enrolled ${r.enrolled}, refused ${r.refused}, replaced ${r.removed}`);
        sendVoicePrintsData();
    } catch (err) {
        console.error(`[clipwise-recorder] voice prints ${stem}: enrolment failed (${err.code || err.name})`);
    }
}

// Before a capture's files are deleted from the trash.
function voicePrintsRemoveRecording(stem) {
    try {
        const r = voicePrints().removeRecording(stem);
        if (r.contributions || r.scoreLines) console.error(`[clipwise-recorder] voice prints ${stem}: removed ${r.contributions} contribution(s), ${r.scoreLines} score line(s)`);
        sendVoicePrintsData();
    } catch (err) {
        console.error(`[clipwise-recorder] voice prints ${stem}: removal failed (${err.code || err.name})`);
    }
}

function sendVoicePrintsData() {
    if (!voicePrintsWindow || voicePrintsWindow.isDestroyed()) return;
    let data = { enabled: false, profiles: null };
    try {
        const vp = voicePrints();
        data = { enabled: vp.isEnabled(), profiles: vp.isEnabled() ? vp.listProfiles() : null };
    } catch (err) {
        console.error(`[clipwise-recorder] voice prints: could not read the store (${err.code || err.name})`);
    }
    voicePrintsWindow.webContents.send('voice-prints:data', data);
}

function openVoicePrintsWindow() {
    if (voicePrintsWindow && !voicePrintsWindow.isDestroyed()) {
        voicePrintsWindow.show();
        try { app.focus({ steal: true }); } catch {}
        return;
    }
    voicePrintsWindow = new BrowserWindow({
        width: 520,
        height: 470,
        minWidth: 440,
        minHeight: 360,
        title: 'Recognise voices',
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    const win = voicePrintsWindow;
    win.once('ready-to-show', () => {
        win.show();
        try { app.focus({ steal: true }); } catch {}
    });
    win.on('closed', () => {
        if (voicePrintsWindow === win) voicePrintsWindow = null;
    });
    win.loadFile(VOICE_PRINTS_HTML).catch((err) => {
        console.error(`voice prints: window failed to load: ${String(err)}`);
        try { win.close(); } catch {}
    });
}

function registerVoicePrintsIpc() {
    const parent = () => (voicePrintsWindow && !voicePrintsWindow.isDestroyed() ? voicePrintsWindow : undefined);
    ipcMain.on('voice-prints:ready', () => sendVoicePrintsData());
    ipcMain.on('voice-prints:enable', async (_event, payload) => {
        const version = payload && payload.statementVersion;
        if (!safeStorage.isEncryptionAvailable()) {
            await dialog.showMessageBox(parent(), {
                type: 'warning', buttons: ['OK'],
                message: 'Voice recognition can’t be turned on',
                detail: 'This Mac can’t encrypt the prints right now, so none will be kept.',
            });
            return;
        }
        try {
            voicePrints().enable(version);
            console.error(`[clipwise-recorder] voice prints: turned on (statement ${version})`);
        } catch (err) {
            console.error(`[clipwise-recorder] voice prints: not turned on (${err.code || err.name})`);
        }
        sendVoicePrintsData();
    });
    ipcMain.on('voice-prints:delete', async (_event, payload) => {
        const personId = payload && typeof payload.personId === 'string' ? payload.personId : null;
        if (!personId) return;
        let shown = null;
        try {
            const p = voicePrints().listProfiles().people.find((x) => x.personId === personId);
            if (!p) { sendVoicePrintsData(); return; }
            shown = p.name;
        } catch { return; }
        const { response } = await dialog.showMessageBox(parent(), {
            type: 'warning', buttons: ['Cancel', 'Delete'], defaultId: 0, cancelId: 0,
            message: shown ? `Delete ${shown}’s voice print?` : 'Delete this voice print?',
            detail: 'Clipwise stops comparing new calls against it. A new print is kept the next time you name this person on a call.',
        });
        if (response !== 1) return;
        try {
            voicePrints().deleteProfile(personId);
            console.error('[clipwise-recorder] voice prints: one print deleted');
        } catch (err) {
            console.error(`[clipwise-recorder] voice prints: delete failed (${err.code || err.name})`);
        }
        sendVoicePrintsData();
    });
    ipcMain.on('voice-prints:disable', async () => {
        const { response } = await dialog.showMessageBox(parent(), {
            type: 'warning', buttons: ['Cancel', 'Turn off and delete prints'], defaultId: 0, cancelId: 0,
            message: 'Turn off voice recognition?',
            detail: 'Every voice print Clipwise has kept for recognising people is deleted. Each recording keeps its own voice measurements until you delete that recording.',
        });
        if (response !== 1) return;
        try {
            const gone = voicePrints().disable();
            console.error(`[clipwise-recorder] voice prints: turned off (prints ${gone.profiles ? 'deleted' : 'none'}, scores ${gone.scores ? 'deleted' : 'none'}, host prints ${gone.hostPrints})`);
        } catch (err) {
            console.error(`[clipwise-recorder] voice prints: turn off failed (${err.code || err.name})`);
        }
        sendVoicePrintsData();
    });
}

// "Change attendees…" in Recent meetings (SAA-258): the identity
// window again, filled from the saved answer: its own name, its guests checked,
// its scope. Saving writes a correction (identity:submit, capture.correcting)
// and sends it through the upload queue; Cancel or closing the window writes
// nothing, and leaves no Later marker, since the call was answered.
function reopenIdentityForCorrection(stem) {
    if (identityWindow) {
        try { identityWindow.win.show(); app.focus({ steal: true }); } catch {}
        return;
    }
    const saved = readAnswer(OUTDIR, stem);
    if (!saved) {
        console.error(`identity: no saved answer for ${stem} — nothing to change`);
        notify('identity-change-missing', 'Clipwise: could not change who was on this call',
            `The saved answer for ${stem} could not be read.`);
        return;
    }
    const guests = (Array.isArray(saved.guests) ? saved.guests : [])
        .map((g) => (g && typeof g.name === 'string' ? g.name.trim() : ''))
        .filter(Boolean);
    const known = knownGuestNames(OUTDIR);
    const knownKeys = new Set(known.map((n) => n.toLowerCase()));
    const capture = { stem, recordingId: saved.recording_id || null, correcting: true, token: randomUUID() };

    let win;
    try {
        win = new BrowserWindow({
            useContentSize: true,
            width: IDENTITY_WINDOW.width,
            height: IDENTITY_WINDOW.maxHeight,
            show: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            title: 'Who was on this call?',
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
    } catch (err) {
        console.error(`identity: could not open the correction: ${String(err)}`);
        notify('identity-change-failed', 'Clipwise: could not change who was on this call', `${stem} could not be opened.`);
        return;
    }
    identityWindow = { win, capture, shown: false, step: 1, resolved: false, fromQueue: false, pollTimer: null };
    const reveal = () => {
        if (!identityWindow || identityWindow.win !== win || identityWindow.shown) return;
        identityWindow.shown = true;
        win.show();
        try { app.focus({ steal: true }); } catch {}
    };
    identityWindow.reveal = reveal;
    win.once('ready-to-show', () => setTimeout(reveal, IDENTITY_REVEAL_GRACE_MS));
    win.once('closed', () => {
        if (identityWindow && identityWindow.win === win && !identityWindow.resolved) {
            console.error(`[clipwise-recorder] identity ${stem}: correction closed — saved answer kept`);
            resolveIdentityWindow();
        }
        identityWindow = null;
        pumpIdentityQueue();
    });
    win.loadFile(IDENTITY_HTML, {
        query: {
            token: capture.token,
            stem,
            self: saved.self && typeof saved.self.name === 'string' ? saved.self.name : '',
            knownNames: JSON.stringify([...known, ...guests.filter((n) => !knownKeys.has(n.toLowerCase()))]),
            checkedNames: JSON.stringify(guests),
            savedScope: saved.scope === 'work' || saved.scope === 'personal' ? saved.scope : '',
            correcting: '1',
        },
    }).catch((err) => {
        console.error(`identity: correction failed to open: ${String(err)}`);
        notify('identity-change-load-failed', 'Clipwise: could not change who was on this call', `${stem} could not be opened.`);
        identityWindow = null;
        try { win.close(); } catch {}
    });
}

// Reopens step 2 directly for a capture whose naming was left for later
// (SAA-195, tray click). Outside identityQueue entirely — that queue is for
// captures whose pipeline just finished, and this one's already has; the
// data it needs (the guest roster from step 1, the naming data from
// diarize) is already sitting on disk, so there is no waiting state to
// show.
// opts.rename: true reopens the most recent named call's answer for
// correction (SAA-195's "Rename voices…" item) rather than a first-time
// naming — pre-fills each voice's current name and tags the eventual save
// so applyVoiceNames knows it may overwrite (see voice-names.ts).
//
// A menu bar item must never be a dead end (SAA-195 fix, 2026-09-25):
// every failure path below now either proceeds with a safe fallback (no
// identity-<stem>.json — an empty guest list, so only "Someone else…" and
// "Not sure" are offered) or shows a notification. None fail silently.
// Reopens step 1 directly for a capture whose identity prompt was deferred
// by closing the window (SAA-197's "Who was on the <date> call…" tray item).
// Built as its own prompt from the later-marker's saved fields, exactly the
// window promptForIdentity would have shown at stop — not a special reduced
// path, since self/known-names/etc. are read fresh from disk the same way.
// Answering it goes through the ordinary identity:submit handler unchanged,
// which is what gives this its step 1 -> step 2 continuity for free: if
// voices-<stem>.json already exists by the time this is answered, the
// existing beginNamingDataWait poll picks it up on its very first tick and
// shows step 2 in the same window, same as it would have at stop.
//
// A menu bar item must never be a dead end (SAA-195's rule, applied here
// too): a missing or unreadable marker notifies rather than doing nothing.
function reopenIdentityPrompt(stem) {
    if (identityWindow) {
        try { identityWindow.win.show(); app.focus({ steal: true }); } catch {}
        return;
    }
    const marker = readLaterMarker(OUTDIR, stem);
    if (!marker) {
        console.error(`identity: no later-marker for ${stem} — nothing to reopen`);
        notify('identity-reopen-answer-missing', 'Clipwise: could not reopen prompt',
            `Who was on ${stem} could not be reopened — the deferred answer is missing.`);
        return;
    }
    const capture = { ...marker, stem, token: randomUUID() };

    let win;
    try {
        win = new BrowserWindow({
            useContentSize: true,
            width: IDENTITY_WINDOW.width,
            height: IDENTITY_WINDOW.maxHeight,
            show: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            title: 'Who was on this call?',
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
    } catch (err) {
        console.error(`identity: could not reopen the prompt: ${String(err)}`);
        notify('identity-reopen-failed', 'Clipwise: could not reopen prompt', `Who was on ${stem} could not be reopened.`);
        return;
    }
    identityWindow = { win, capture, shown: false, step: 1, resolved: false, fromQueue: false, pollTimer: null };
    const reveal = () => {
        if (!identityWindow || identityWindow.win !== win || identityWindow.shown) return;
        identityWindow.shown = true;
        win.show();
        try { app.focus({ steal: true }); } catch {}
    };
    identityWindow.reveal = reveal;
    win.once('ready-to-show', () => setTimeout(reveal, IDENTITY_REVEAL_GRACE_MS));
    win.once('closed', () => {
        // Same treatment as the original prompt's own close handler — still
        // Later, not Skip, and re-deferrable indefinitely: the marker this
        // reopen read is simply rewritten (deferIdentityPrompt is a plain
        // overwrite), not consumed. Unlike that handler this window was
        // never on identityQueue, but a genuinely queued capture that has
        // been waiting behind this one should still get its turn now.
        if (identityWindow && identityWindow.win === win && !identityWindow.resolved) {
            console.error(`[clipwise-recorder] identity ${stem}: closed during step 1 — treated as Later`);
            deferIdentityPrompt(identityWindow.capture);
            resolveIdentityWindow();
        }
        identityWindow = null;
        pumpIdentityQueue();
    });
    win.loadFile(IDENTITY_HTML, {
        query: {
            token: capture.token,
            stem,
            self: readSelfName() || '',
            knownNames: JSON.stringify(knownGuestNames(OUTDIR)),
            inferredScope: capture.inferredScope === 'work' || capture.inferredScope === 'personal'
                ? capture.inferredScope : '',
            duration: Number.isFinite(capture.durationMs) ? String(capture.durationMs) : '',
        },
    }).catch((err) => {
        console.error(`identity: prompt failed to reopen: ${String(err)}`);
        notify('identity-reopen-load-failed', 'Clipwise: could not reopen prompt', `Who was on ${stem} could not be reopened.`);
        identityWindow = null;
        try { win.close(); } catch {}
    });
}

function reopenVoiceNaming(stem, opts = {}) {
    if (identityWindow) {
        // Only one identity window is ever shown at a time today. Bringing
        // the existing one forward is a plainer answer than queueing a
        // second concurrent window would be.
        try { identityWindow.win.show(); app.focus({ steal: true }); } catch {}
        return;
    }
    let recordingId = null;
    let guestNames = [];
    const identityPath = path.join(OUTDIR, `identity-${stem}.json`);
    if (fs.existsSync(identityPath)) {
        try {
            const doc = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
            recordingId = doc.recording_id || null;
            guestNames = (doc.guests || []).map((g) => g.name).filter(Boolean);
        } catch (err) {
            console.error(`voice-names: identity-${stem}.json exists but could not be read: ${String(err)}`);
            notify('naming-reopen-answer-unreadable', 'Clipwise: could not reopen naming',
                `Naming the voices on ${stem} could not be reopened — the identity answer is unreadable.`);
            return;
        }
    }
    // else: identity was skipped for this capture. Proceeds with an empty
    // guestNames rather than failing — step 2 still works, just with no
    // roster to pick from.

    const namingData = readNamingData(OUTDIR, stem);
    if (!namingData) {
        console.error(`voice-names: no naming data for ${stem} — nothing to reopen`);
        notify('naming-reopen-data-missing', 'Clipwise: could not reopen naming',
            `Naming the voices on ${stem} could not be reopened — the naming data is missing.`);
        return;
    }

    let currentNames = {};
    if (opts.rename) {
        const existing = readVoiceNamesAnswer(OUTDIR, stem);
        if (existing && Array.isArray(existing.voices)) {
            for (const v of existing.voices) currentNames[v.voiceIndex] = v.name || null;
        }
    }

    let win;
    try {
        win = new BrowserWindow({
            useContentSize: true,
            width: IDENTITY_WINDOW.width,
            height: IDENTITY_WINDOW.maxHeight,
            show: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            alwaysOnTop: true,
            title: "Who's speaking?",
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
    } catch (err) {
        console.error(`voice-names: could not reopen the naming window: ${String(err)}`);
        notify('naming-reopen-failed', 'Clipwise: could not reopen naming', `Naming the voices on ${stem} could not be reopened.`);
        return;
    }
    identityWindow = {
        win, capture: { stem, token: randomUUID(), recordingId },
        step: 2, resolved: false, fromQueue: false, pollTimer: null, shown: false,
        isRename: Boolean(opts.rename),
    };
    const reveal = () => {
        if (!identityWindow || identityWindow.win !== win || identityWindow.shown) return;
        identityWindow.shown = true;
        win.show();
        try { app.focus({ steal: true }); } catch {}
    };
    identityWindow.reveal = reveal;
    win.once('ready-to-show', () => setTimeout(reveal, IDENTITY_REVEAL_GRACE_MS));
    win.once('closed', () => {
        // SAA-197 applies here too: a native close is Later, never a
        // silent reopen. No pumpIdentityQueue() call — this window was
        // never on that queue.
        if (identityWindow && identityWindow.win === win && !identityWindow.resolved) {
            console.error(`[clipwise-recorder] identity ${stem}: closed during step 2 — treated as Later`);
            resolveIdentityWindow();
        }
        identityWindow = null;
    });
    win.loadFile(IDENTITY_HTML, {
        query: {
            token: identityWindow.capture.token,
            stem,
            startStep: '2',
            startNames: JSON.stringify(guestNames),
            namingData: JSON.stringify(namingData),
            currentNames: JSON.stringify(currentNames),
        },
    }).catch((err) => {
        console.error(`voice-names: naming window failed to load: ${String(err)}`);
        notify('naming-reopen-load-failed', 'Clipwise: could not reopen naming', `Naming the voices on ${stem} could not be reopened.`);
        identityWindow = null;
        try { win.close(); } catch {}
    });
}

// Opens the THIRD_PARTY_NOTICES file bundled inside the packaged app
// (Contents/Resources/THIRD_PARTY_NOTICES, copied there by build-app.sh —
// see that script's THIRD_PARTY_NOTICES line), not the repo's copy: the
// running app should point at the file it actually shipped with, which for
// an unbuilt/unpackaged run is process.resourcesPath itself. A menu bar
// item must never be a dead end (SAA-195's rule, applied here too) — a
// missing file notifies rather than doing nothing.
function openAcknowledgements() {
    const noticesPath = path.join(process.resourcesPath, 'THIRD_PARTY_NOTICES');
    shell.openPath(noticesPath).then((err) => {
        if (err) {
            notify('acknowledgements-open-failed', 'Clipwise: could not open acknowledgements', `${noticesPath}: ${err}`);
        }
    });
}

// Title stays down to a few characters whatever the state vocabulary grows
// into: the recording time while a capture runs ("Rec 3:52", Jon's call 8,
// counting up from the spawn), and single glyphs for anything wanting
// attention. Everything wordy is a menu item, which has room for it.
function trayTitle() {
    const attention = permissionIssue || (pipeline && pipeline.state === 'failed');
    const rec = state === 'stopped'
        ? ''
        : (session && session.startedAtMs ? `Rec ${setup.formatElapsed(Date.now() - session.startedAtMs)}` : 'Rec');
    const title = [
        rec,
        pipeline && pipeline.state === 'running' ? '⚙' : '',
        // A live detection prompt is visible in the menu bar itself, so a
        // notification that never appeared is still recoverable (Decision #17).
        detectPending ? '?' : '',
        attention ? '⚠' : '',
    ].filter(Boolean).join(' ');
    return title ? ` ${title}` : '';
}

// Redraws only the title, once a second while a capture runs, so the time
// counts up. The menu is left alone: rebuilding it every second would close it
// under the person reading it.
let trayClock = null;
function syncTrayClock() {
    if (state !== 'stopped' && !trayClock) {
        trayClock = setInterval(() => { if (tray) tray.setTitle(trayTitle()); }, 1000);
    } else if (state === 'stopped' && trayClock) {
        clearInterval(trayClock);
        trayClock = null;
    }
}

// Set once at launch (whenReady) from setup.locationWarning: the tray's line for
// a built app running from outside Applications, or from a copy this account
// can't replace, null otherwise.
let locationNote = null;

function renderTray() {
    const label = LABEL[state];
    const pipelineNote = pipeline && PIPELINE_NOTE[pipeline.state]
        ? PIPELINE_NOTE[pipeline.state](pipeline.stem)
        : null;
    const permNote = permissionIssue ? permissionIssue.note : null;

    tray.setImage(iconFor(state));
    tray.setTitle(trayTitle());

    const active = state !== 'stopped';
    const items = [
        { label: `Status: ${label}`, enabled: false },
    ];
    if (locationNote) items.push({ label: locationNote.tray, enabled: false });
    if (updateReady) items.push({ label: `Restart to update to ${updateReady}`, click: restartToUpdate });
    if (pipelineNote) items.push({ label: pipelineNote, enabled: false });
    if (permNote) items.push({ label: permNote, enabled: false });
    // The three most recent uploads, while a server is set.
    if (readCaptureServerUrl()) {
        for (const entry of listUploadQueue().slice(-3).reverse()) items.push({ label: uploadTrayLabel(entry), enabled: false });
    }
    // The live prompt, carried here as well as in the notification. These are
    // the same three answers; only the last one writes anything durable.
    if (detectPending) {
        const { key, name } = detectPending;
        items.push(
            { type: 'separator' },
            { label: `${name} is using the microphone`, enabled: false },
            { label: 'Always record this app', click: () => answerDetectPrompt(key, 'record') },
            { label: 'Not now', click: () => answerDetectPrompt(key, 'not_now') },
            { label: `Never ask about ${name}`, click: () => answerDetectPrompt(key, 'never') },
        );
    }
    // The account items (setup.js trayAccountItems). Until setup has been
    // finished once, one item leads back into the setup window, which can be
    // closed at any screen, and a menu bar item must never be a dead end
    // (SAA-195's rule). After that: the recording notice while it is not agreed
    // to, the sign-in (SAA-227 part B) while a server is set and this app holds
    // no capture token for it, and Sign out while it does.
    const accountItems = setup.trayAccountItems({ setupCompleted: setupCompleted(), ...setupStatus() });
    if (accountItems.length) items.push({ type: 'separator' });
    for (const item of accountItems) {
        if (item === 'finish-setup') {
            items.push({ label: 'Finish setting up Clipwise…', click: () => showSetupWindow(blockedStartFresh() ? 'blocked' : 'launch') });
        } else if (item === 'recording-notice') {
            items.push({ label: 'Recording notice…', click: () => showSetupWindow(blockedStartFresh() ? 'blocked' : 'launch') });
        } else if (item === 'sign-in') {
            items.push({ label: 'Sign in to Clipwise…', click: signInToCaptureServer });
        } else if (item === 'sign-out') {
            items.push({ label: 'Sign out', click: signOutFromTray });
        }
    }
    items.push(
        { type: 'separator' },
        { label: 'Start', enabled: !active, click: startRecording },
        { label: 'Stop',  enabled:  active, click: () => stopRecording('manual') },
    );
    // During a capture only: a line to paste into the meeting chat, since
    // nothing in the meeting shows that Clipwise is recording (SAA-216).
    if (active) items.push({ label: 'Copy recording notice', click: copyRecordingNotice });
    items.push({ type: 'separator' }, detectedAppsMenu());
    if (permissionIssue) {
        items.push({ type: 'separator' });
        for (const svc of permissionIssue.denied) {
            items.push({
                label: `Open ${svc} settings…`,
                click: () => shell.openExternal(SETTINGS_PANE[svc]),
            });
        }
        items.push({ label: 'Dismiss warning', click: () => { permissionIssue = null; renderTray(); } });
    }
    // A failed run is a menu item, not just a line in a log. Retry re-enters
    // the pipeline for that stem; it resumes from the first incomplete step.
    if (pipeline && pipeline.state === 'failed') {
        items.push(
            { type: 'separator' },
            { label: `Retry processing (${pipeline.stem})`, click: retryPipeline },
            { label: 'Dismiss failure', click: dismissPipelineFailure },
        );
    }
    // Identity step left for later (SAA-197) by closing the window — one
    // item per capture, same file-on-disk derivation as the voice-naming
    // block below. Capped to the 3 most recent calls from the last 7 days
    // (recentPendingIdentityStems): a call prompted for weeks ago and never
    // answered is not a "who was on this call" question worth asking today.
    // Older markers are untouched on disk — recovery can still apply a late
    // identity-<stem>.json answer whenever one arrives; this only bounds
    // what the tray lists.
    const recentPendingIdentity = recentPendingIdentityStems(OUTDIR);
    if (recentPendingIdentity.length > 0) {
        items.push({ type: 'separator' });
        for (const stem of recentPendingIdentity) {
            const marker = readLaterMarker(OUTDIR, stem);
            const autoStopped = !!marker && marker.stopped_by === 'auto';
            items.push({
                label: `Who was on the ${stemDateLabel(stem)} call…${autoStopped ? ' (auto-stopped)' : ''}`,
                click: () => reopenIdentityPrompt(stem),
            });
        }
    }
    // Naming step left for later (SAA-195), one item per capture — derived
    // from files on disk (pendingVoiceNamingStems), the same way the failed-
    // pipeline block above is derived from `pipeline` rather than a
    // separate store, and for the same reason: this has to survive a quit
    // and relaunch, not just live in memory.
    //
    // Excludes any stem still pending on identity (the block above): naming
    // voices before knowing who was on the call isn't useful, and the two
    // items together would be confusing about which to answer first (SAA-197
    // decision). It becomes visible again once identity is answered or
    // explicitly skipped — both clear the identity pending marker.
    //
    // Capped like the identity block: the 3 most recent calls from the last
    // 7 days (recentPendingVoiceNamingStems, SAA-255). Older ones stay in
    // Recent meetings only.
    const pendingVoiceNaming = recentPendingVoiceNamingStems(OUTDIR);
    if (pendingVoiceNaming.length > 0) {
        items.push({ type: 'separator' });
        for (const stem of pendingVoiceNaming) {
            const data = readNamingData(OUTDIR, stem);
            const count = data && Array.isArray(data.voices) ? data.voices.length : 0;
            items.push({
                label: `Name ${count} voice${count === 1 ? '' : 's'}… — ${stemRelativeTime(stem)}`,
                click: () => reopenVoiceNaming(stem),
            });
        }
    }
    // "Fix speaker names…" (SAA-195): the most recent named call only, never
    // a list of past ones. Independent of the pending block above — a call
    // can only appear in one or the other, never both, since
    // mostRecentNamedStem requires a saved voice-names answer and
    // pendingVoiceNamingStems excludes any stem that has one.
    //
    // Shown only while that named call is also the most recent recording —
    // hidden once any newer capture exists. The item corrects one specific
    // recording's speaker names and re-extracts its moments; once a newer
    // call has been captured, "Fix speaker names…" with no call named in
    // the item itself would be ambiguous about which recording it acts on.
    const renameStem = mostRecentNamedStem(OUTDIR);
    if (renameStem && renameStem === mostRecentCaptureStem(OUTDIR)) {
        items.push({ type: 'separator' });
        items.push({
            label: `Fix speaker names — ${stemDateLabel(renameStem)} call`,
            click: () => reopenVoiceNaming(renameStem, { rename: true }),
        });
    }
    // "Save transcript — <meeting>, <weekday time>" (SAA-199): the most recent
    // meeting with a transcript, named in the label so it is visible which one
    // will be saved. See last-meeting.js for which captures count.
    const meeting = lastMeeting(OUTDIR, undefined, captureStateOpts());
    items.push({ type: 'separator' });
    items.push({ label: 'Recent meetings…', click: openMeetingsWindow });
    items.push({ label: 'Recognise voices…', click: openVoicePrintsWindow });
    if (meeting) {
        items.push({
            label: saveTranscriptLabel(meeting),
            enabled: meeting.state === 'ready' && !savingTranscript,
            click: () => saveTranscript(meeting),
        });
    }
    items.push(
        { type: 'separator' },
        // On by default from the first run in Applications (applyLoginDefault),
        // and only offered there: launch at login needs a path that stays put.
        { label: 'Open at login', type: 'checkbox', checked: openAtLogin(),
          enabled: app.isInApplicationsFolder(), click: (item) => setOpenAtLogin(item.checked) },
        { label: 'About Clipwise', click: () => app.showAboutPanel() },
        { label: 'Acknowledgements…', click: openAcknowledgements },
        { label: 'Quit…', click: confirmQuit },
    );
    tray.setContextMenu(Menu.buildFromTemplate(items));
}

// --- notifications --------------------------------------------------------
//
// With the tray item evicted there is no permanent readout, so a notification
// is the only thing that says whether a capture started or stopped. Every
// notification here is therefore load-bearing rather than decorative, and
// every path that declines to start a capture has to fire one too — this is
// SAA-105's actual subject, and it is still open.
//
// Delivery is checked, not assumed. show() is fire-and-forget and returns
// nothing, so the obvious version of this function cannot tell a notification
// that appeared from one macOS dropped — which would be the same silent
// failure one layer further down. Measured on macOS 15 /
// Electron 43.3.0: with the signature the electron package ships, every single
// notification failed with UNErrorDomain error 1 and nothing was displayed
// while isSupported() still answered true. isSupported() is therefore not
// evidence of anything; the 'show' and 'failed' events are.
//
// fix-electron-signature.sh removes that cause at install time. The fallback
// below is for when it has not run, or when authorization is off for some other
// reason: osascript posts through a signed Apple binary that does not depend on
// how this app is signed. It is a worse notification — attributed to Script
// Editor rather than Clipwise — and it is still far better than silence, which
// is the only other option at that point.
//
// A failure of the fallback too is logged and swallowed. It is never worth
// losing a capture over.
function notifyFallback(title, body, why) {
    console.error(`notify: falling back to osascript (${why})`);
    // AppleScript has only double-quoted strings, and the status report is
    // multi-line. Backslash first, then the characters whose escapes are
    // backslashes, so the escaping is not itself re-escaped.
    const esc = s => String(s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
    const script =
        `display notification "${esc(body)}" with title "${esc(title)}"`;
    try {
        const proc = spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' });
        proc.once('error', err => console.error(`notify fallback spawn failed: ${String(err)}`));
        proc.once('exit', code => {
            if (code !== 0) console.error(`notify fallback exited code=${code}`);
        });
    } catch (err) {
        console.error(`notify fallback failed: ${String(err)}`);
    }
}

// Notifications that have a click handler, held until they are clicked, closed
// or fail: a Notification with no reference can be collected before the click
// arrives, and the handler would never run.
const clickableNotifications = new Set();

// onClick is optional and only reachable through a real Electron notification;
// the osascript fallback cannot report a click.
// kind is a fixed identifier for the call site, and the only part logged: a
// title or body can carry a meeting title or an app's name (SAA-243 item 7).
function notify(kind, title, body, onClick) {
    console.error(logLines.notifyLine(kind));
    if (!Notification.isSupported()) {
        notifyFallback(title, body, 'Notification.isSupported() is false');
        return;
    }
    try {
        const n = new Notification({ title, body });
        if (typeof onClick === 'function') {
            clickableNotifications.add(n);
            const release = () => clickableNotifications.delete(n);
            n.once('click', () => {
                release();
                try { onClick(); } catch (err) { console.error(`notify: click handler threw ${String(err)}`); }
            });
            n.once('close', release);
        }
        n.once('failed', (_event, err) => {
            clickableNotifications.delete(n);
            notifyFallback(title, body, String(err));
        });
        // The positive half of the same rule. No 'failed' line in the log is
        // absence of evidence — it reads identically to a notify() that was
        // never reached. 'show' is the event that says delivered, and once
        // this runs from a bundle the log is the only place anyone can see
        // either of them.
        n.once('show', () => console.error(logLines.notifyDeliveredLine(kind)));
        n.show();
    } catch (err) {
        notifyFallback(title, body, String(err));
    }
}

// Natural-language duration for the stopped notification (SAA-187). Not
// reused by the identity prompt, which needs its own compact form ("23
// min") — this one spells the unit out because the notification has the
// room and nothing else on the line competing for it.
function formatDurationWords(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    if (totalSeconds < 60) {
        return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
    }
    const minutes = Math.round(totalSeconds / 60);
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Both halves of the started/stopped distinction the issue asks for, plus the
// two states in between. Reads `session` directly: every setState call happens
// while the session it describes is still assigned (teardown clears it only
// after stopRecording has already flipped the state).
function notifyStateChange(prev, next) {
    // 'starting' is deliberately silent (SAA-151). It fired roughly a second
    // before 'recording started' and said less: the useful fact is that both
    // tracks are writing, and until they are there is nothing to report that
    // the next notification does not report better. The tray already shows the
    // starting state, and a start that never reaches 'recording' still gets a
    // notification — the stopped branch below says nothing was saved.
    if (next === 'starting') return;
    if (next === 'recording' && prev === 'starting') {
        // Neither the stem nor a stop-style duration belongs here (SAA-187):
        // this fires while the person is sitting at the call being announced,
        // so it identifies nothing and doesn't need to — the recorder's
        // internal filename is not a fact about the call worth reading aloud
        // at the moment it starts.
        //
        // "Both tracks are writing" was Clipwise's internal model (mic +
        // system-audio tap), not what a user standing at the call wants to
        // know — which is whether it's getting the other side or only them.
        // That is exactly what the both-tracks check guarantees, so say that
        // instead. Not "the meeting" or "everyone on the call": there is
        // only ever one mixed far-side stream, not per-person audio
        // (SAA-94), and it only covers from this moment on (SAA-105) — both
        // would be over-claims in a notification the user is trusting.
        //
        // SAA-216: nothing in the meeting shows that Clipwise is recording, so
        // this is also where the host is handed the line to say aloud (Jon,
        // 2026-10-07). The body is the notice itself, the same line "Copy
        // recording notice" puts on the clipboard. What this used to say — which
        // app triggered the capture and that both tracks are going — is no longer
        // in this notification; the triggering app is recorded in the capture's
        // autostop-<stem>.log (capture_start).
        notify('recording-started-notice', 'Recording \u2014 let everyone know', consent.NOTICE_LINE);
        return;
    }
    // The flapping pair.
    if (next === 'recording' || next === 'stalled') {
        const now = Date.now();
        if (now - lastFlapNotifyMs < FLAP_NOTIFY_MIN_MS) return;
        lastFlapNotifyMs = now;
        if (next === 'stalled') {
            notify('recording-stalled', 'Clipwise: recording stalled',
                'A track stopped growing. The capture is still running.');
        } else {
            notify('recording-resumed', 'Clipwise: recording resumed', 'Both tracks are writing again.');
        }
        return;
    }
    if (next === 'stopped') {
        // reachedRecording is what decides whether the pipeline runs, so it is
        // the honest thing to report: a capture that never got both tracks
        // going produced nothing and will not be processed. Unchanged by
        // SAA-187 — the stem is dropped from the branch above it, but a
        // duration on a capture that produced nothing would be its own kind
        // of wrong answer, so this stays its own branch rather than folding
        // a zero into the same sentence.
        const kept = session && session.reachedRecording;
        if (kept && session.stopCause === 'auto') {
            // The only notification for an auto-stop: it says why the capture
            // ended and what is being asked, instead of two within a second.
            // Clicking raises the question: the window opens behind everything
            // else after an auto-stop (showInactive, and this is an accessory
            // app), so the notification is how a person finds it.
            const stem = session.stem;
            notify('auto-stopped', 'Auto-stopped — who was on this call?',
                `Recorded ${formatDurationWords(Date.now() - session.startedAtMs)}. Processing now.`,
                () => {
                    if (identityWindow && identityWindow.capture && identityWindow.capture.stem === stem) {
                        try { identityWindow.win.show(); app.focus({ steal: true }); } catch {}
                    } else {
                        reopenIdentityPrompt(stem);
                    }
                });
        } else {
            notify('recording-stopped', 'Clipwise: recording stopped', kept
                ? `Recorded ${formatDurationWords(Date.now() - session.startedAtMs)}. Processing now.`
                : 'The capture never started — nothing was saved.');
        }
    }
}

function setState(next) {
    const prev = state;
    state = next;
    renderTray();
    syncTrayClock();
    if (prev !== next) notifyStateChange(prev, next);
}

// --- call detection (SAA-113) ---------------------------------------------
//
// A process starts using the microphone; if it is an application we have been
// told to record, a capture starts; if we have never seen it, we ask. The
// signal comes from micwatch, which holds no policy — everything below is the
// policy, and all of it lives here rather than in the detector so that a
// change to it does not mean rebuilding a Swift binary.
//
// The sequence is detect -> ask -> capture -> ask who was on it at stop. It is
// deliberately not auto-record: a false positive costs a dismissable prompt
// rather than a wrong recording, which is what makes a bundle-ID filter
// adequate. Chrome cannot be distinguished from Chrome, so a browser voice
// message looks exactly like a Meet call and always will.

// A bundle ID where there is one, and the executable name where there is not.
// miccap and the other bare binaries have no bundle ID, and two different
// unbundled tools must not collapse onto the same empty key.
function detectKey(ev) {
    return ev.bundle ? ev.bundle : (ev.exe ? `exe:${ev.exe}` : null);
}

// The name a person would recognise, derived from the executable path rather
// than guessed from a table. Audio runs in helper processes, so both the
// bundle ID and the executable name describe the helper: Chrome's microphone
// is "Google Chrome Helper" / com.google.Chrome.helper, and Fathom's is
// "Fathom Helper". The parent application is the FIRST .app component of the
// path, which is exactly what those two nest inside:
//
//   /Applications/Google Chrome.app/Contents/Frameworks/…/Google Chrome Helper.app/…
//   /Applications/Fathom.app/Contents/Frameworks/Fathom Helper.app/…
//
// A process in no bundle at all — ffmpeg from Homebrew — has no .app in its
// path and keeps its own name, which is the honest answer for it. Only the
// displayed name changes; the bundle ID remains the matching key, so nothing
// about which process matched is affected by this.
function detectName(ev) {
    const full = ev.path || '';
    for (const part of full.split('/')) {
        if (part.endsWith('.app')) return part.slice(0, -4);
    }
    return ev.exe || ev.bundle || 'Unknown application';
}

function loadDetectApps() {
    try {
        const raw = JSON.parse(fs.readFileSync(DETECT_STORE_PATH, 'utf8'));
        if (raw && typeof raw === 'object' && raw.apps && typeof raw.apps === 'object') {
            return raw.apps;
        }
        console.error('detect: store has no apps object — starting empty');
    } catch (err) {
        // ENOENT is the normal first-run state: no list ships, so the file
        // does not exist until the first durable answer.
        if (err.code !== 'ENOENT') console.error(`detect: store unreadable (${String(err)}) — starting empty`);
    }
    return {};
}

// Written whole and only on a deliberate answer. Nothing on this path is
// reachable from a dismissed, ignored or expired prompt.
function saveDetectApps() {
    try {
        fs.mkdirSync(SUPPORT_DIR, { recursive: true });
        fs.writeFileSync(DETECT_STORE_PATH,
            JSON.stringify({ version: 1, apps: detectApps }, null, 2) + '\n');
        return true;
    } catch (err) {
        console.error(`detect: could not write store: ${String(err)}`);
        return false;
    }
}

function setAppDecision(key, decision, name) {
    if (!detectApps) detectApps = loadDetectApps();
    if (decision === null) delete detectApps[key];
    else detectApps[key] = { decision, name: name || (detectApps[key] && detectApps[key].name) || key,
                             updated_at: new Date().toISOString() };
    saveDetectApps();
    console.error(`detect: ${key} -> ${decision === null ? 'forgotten' : decision}`);
    renderTray();
}

function appDecision(key) {
    if (!detectApps) detectApps = loadDetectApps();
    const e = detectApps[key];
    return e ? e.decision : null;
}

// Clipwise's own capture, which holds the microphone for the whole recording.
// Checked by executable name and by the PIDs of the children this process
// spawned — the name alone would miss a renamed build, and the PIDs alone
// would miss a capture left running by a previous instance.
function isSelfCapture(ev) {
    if (ev.exe && DETECT_SELF_EXES.has(ev.exe)) return true;
    if (ev.pid === process.pid) return true;
    if (session) {
        for (const k of ['tap', 'mic', 'poller']) {
            const child = session[k];
            if (child && child.pid === ev.pid) return true;
        }
    }
    return false;
}

// Take the notification off the screen. An alert-style notification stays up
// until it is acted on, so without this an expired prompt leaves a clickable
// thing on screen whose backing state is gone — observed: prompted 15:34:22,
// expired 15:37:22, "record" clicked 15:40:02 and silently discarded.
//
// close() is the first line of defence and not the only one, for the same
// reason notify() has a fallback: nothing here can prove the notification
// actually went away. answerDetectPrompt therefore also handles an answer
// that arrives with no live prompt, rather than assuming this worked.
function withdrawPrompt(p) {
    if (!p || !p.notification) return;
    try { p.notification.close(); } catch (err) {
        console.error(`detect: could not withdraw notification: ${String(err)}`);
    }
}

// The prompt. Two surfaces on purpose.
//
// Architecture Decision #17 records that notification delivery is not reliably
// observable: show() returning is not evidence anything appeared, and two
// notifications during SAA-112 logged neither delivered nor failed. This
// prompt is the only thing standing between a detected call and no recording,
// so it cannot be the only surface.
//
// So the tray carries the same three choices for as long as the prompt is
// live, and the tray title shows a marker. If the notification never appears,
// the prompt is still there in the menu bar. If neither is noticed, the prompt
// expires to "not now" — which writes nothing, so the next call asks again.
// A missed prompt and a declined one are different states and only one of them
// is durable.
function promptForApp(ev, key) {
    const name = detectName(ev);
    detectLastPrompt.set(key, Date.now());
    detectPending = {
        key, name, pid: ev.pid, at: Date.now(),
        timer: setTimeout(() => {
            if (detectPending && detectPending.key === key) {
                console.error(`detect: prompt for ${key} expired — treated as "not now", nothing written`);
                withdrawPrompt(detectPending);
                detectPending = null;
                renderTray();
            }
        }, DETECT_PROMPT_TTL_MS),
    };
    renderTray();
    console.error(`detect: prompting for ${key} (pid ${ev.pid})`);

    // The buttons say what they do. Both write a durable rule for the
    // application, so neither is labelled as being about this one call —
    // "Record" over a rule that means "always record" is the same mismatch
    // as a decline that silently becomes permanent. Recording a single call
    // without deciding anything is what "Not now" is for — start it manually
    // from the tray if this one call should still be recorded.
    const title = `Clipwise: ${displayNameForDetectedKey(key, { name })} is using the microphone`;
    const body = 'Record calls from this app?';
    if (!Notification.isSupported()) {
        notifyFallback(title, `${body} Choose from the Clipwise menu bar icon.`,
            'Notification.isSupported() is false');
        return;
    }
    try {
        const n = new Notification({
            title, body,
            // macOS shows the first action as the button and the rest on the
            // expanded alert. "Never" is last deliberately: it is the only
            // durable decline and must not be the easy thing to hit.
            actions: [
                { type: 'button', text: 'Always record' },
                { type: 'button', text: 'Never ask about this app' },
            ],
            closeButtonText: 'Not now',
        });
        n.once('failed', (_e, err) => notifyFallback(title,
            `${body} Choose from the Clipwise menu bar icon.`, String(err)));
        n.once('show', () => console.error(logLines.notifyDeliveredLine('detect-prompt')));
        n.on('action', (_e, index) => {
            if (index === 0) answerDetectPrompt(key, 'record');
            else if (index === 1) answerDetectPrompt(key, 'never');
        });
        // Closing, ignoring or letting it time out are all the same answer,
        // and that answer writes nothing. There is no 'close' handler here on
        // purpose: there is nothing to do.
        n.show();
        // Kept so the prompt can be taken down again when it lapses.
        if (detectPending && detectPending.key === key) detectPending.notification = n;
    } catch (err) {
        notifyFallback(title, `${body} Choose from the Clipwise menu bar icon.`, String(err));
    }
}

// The only path that writes durable state, and it is only ever reached from a
// notification button or a tray click.
//
// An answer can arrive after its prompt has lapsed, because withdrawPrompt
// cannot prove the notification left the screen. Discarding it silently is
// what lost a capture: a person clicked a visible button and nothing
// happened, with no way to tell that from a recording that had started.
//
// So a late answer is honoured rather than dropped. Both durable answers are
// about the application rather than about one call, so neither is made wrong
// by arriving three minutes later — "never ask about this app" means the same
// thing whenever it is clicked. What lateness changes is only whether there is
// still a call to record, and that is checked rather than assumed.
//
// This does not alter what the expiry itself does. Expiry is still "not now"
// and still writes nothing; it is a subsequent deliberate click that writes,
// exactly as it would have inside the window.
function answerDetectPrompt(key, choice) {
    const live = !!(detectPending && detectPending.key === key);
    let name;
    if (live) {
        name = detectPending.name;
        clearTimeout(detectPending.timer);
        withdrawPrompt(detectPending);
        detectPending = null;
    } else {
        const known = detectApps && detectApps[key];
        name = detectActiveName(key) || (known && known.name) || key;
        console.error(`detect: answer "${choice}" for ${key} arrived after its prompt lapsed`);
    }
    // name is what gets stored (setAppDecision, below) — the raw process-
    // derived name, matching what detectApps itself carries. displayName is
    // what the user reads: the same label preference as the tray (SAA-135).
    const displayName = displayNameForDetectedKey(key, { name });

    if (choice === 'not_now') {
        console.error(`detect: "not now" for ${key} — nothing written`);
        renderTray();
        return;
    }
    if (choice === 'never') {
        setAppDecision(key, 'never', name);
        // The one line of explanation the design allows, and it belongs here
        // rather than in the prompt: the prompt fires as a call is starting,
        // which is the worst moment to ask anyone to read anything.
        notify('detect-never', 'Clipwise: will not ask about this app',
            `${displayName} will no longer offer to record. Turn it back on from the Clipwise menu bar.`);
        return;
    }
    if (choice === 'record') {
        setAppDecision(key, 'record', name);
        if (live) {
            startRecording();
            return;
        }
        // Late. If the application is still holding the microphone the call is
        // still going, so the click means what it said and the capture starts.
        if (detectActive.has(key)) {
            notify('detect-lapsed-started', 'Clipwise: starting now',
                `That prompt had lapsed, but ${displayName} is still using the microphone — recording now.`);
            startRecording();
            return;
        }
        // The call is genuinely over, which is the case the expiry exists for.
        // Nothing is recorded — there is nothing left to record — and the one
        // thing that must not happen is silence about it.
        notify('detect-lapsed-nothing', 'Clipwise: that prompt had lapsed',
            `${displayName} is no longer using the microphone, so nothing was recorded. `
            + 'Clipwise will record it automatically from now on.');
    }
}

function handleDetectEvent(ev) {
    if (ev.event === 'ready') {
        // A restarted detector has no memory of what was running, and neither
        // should this: anything still holding the microphone reports again on
        // its first poll.
        detectActive.clear();
        console.error(`detect: micwatch ready (poll ${ev.poll_ms}ms)`);
        autostopFeed(session && session.autostop, { type: 'detector_ready', t: Date.now() });
        return;
    }
    if (ev.event === 'in_stop') {
        const stopKey = detectKey(ev);
        if (stopKey) {
            const pids = detectActive.get(stopKey);
            if (pids) {
                pids.delete(ev.pid);
                if (pids.size === 0) detectActive.delete(stopKey);
            }
            autostopFeed(session && session.autostop, { type: 'in_stop', t: Date.now(),
                key: stopKey, pid: ev.pid, path: ev.path || null, mw_t: ev.t || null });
        }
        return;
    }
    if (ev.event !== 'in_start') return;
    if (isSelfCapture(ev)) {
        console.error(`detect: ignoring own capture — ${ev.exe || ev.bundle} pid ${ev.pid}`);
        return;
    }
    const key = detectKey(ev);
    if (!key) return;
    const name = detectName(ev);
    if (!detectActive.has(key)) detectActive.set(key, new Map());
    detectActive.get(key).set(ev.pid, { name, path: ev.path || null });
    autostopFeed(session && session.autostop, { type: 'in_start', t: Date.now(),
        key, pid: ev.pid, path: ev.path || null, mw_t: ev.t || null });

    const decision = appDecision(key);
    // Refresh a stored display name once a better one can be derived. Entries
    // written before the name came from the bundle path still read "Google
    // Chrome Helper", and the tray would go on showing that forever because an
    // application that is not running offers no path to derive from. Display
    // only: the key, the decision and everything matched on are untouched.
    const known = detectApps && detectApps[key];
    if (known && known.name !== name) {
        console.error(`detect: display name for ${key} refreshed "${known.name}" -> "${name}"`);
        known.name = name;
        saveDetectApps();
        renderTray();
    }
    if (decision === 'never') {
        console.error(`detect: ${key} is set to never ask — ignored`);
        return;
    }
    // A capture already running is the answer to "should we record this".
    if (state !== 'stopped' || session) {
        console.error(`detect: ${key} started input while already ${state} — no action`);
        return;
    }
    if (decision === 'record') {
        console.error(`detect: ${key} is allowed — starting capture`);
        // No notification here (SAA-151). This fired, then 'capture starting',
        // then 'recording started' — three for one event, all within about a
        // second. The one fact this carried that the others did not is the
        // application name, which now rides on 'recording started'.
        //
        // Carries the key alongside the name (SAA-170): the name is what a
        // person reads, the key is what the scope mapping matches on — the
        // same distinction detectApps already draws, for the same reason
        // (a display name can be refreshed later; the bundle ID cannot).
        pendingStartTrigger = { key, name: detectName(ev) };
        startRecording();
        return;
    }
    if (detectPending) {
        console.error(`detect: ${key} seen while a prompt for ${detectPending.key} is live — skipped`);
        return;
    }
    const last = detectLastPrompt.get(key);
    if (last && Date.now() - last < DETECT_REPROMPT_MS) {
        console.error(`detect: ${key} asked about ${Math.round((Date.now() - last) / 1000)}s ago — not re-asking`);
        return;
    }
    promptForApp(ev, key);
}

// Long-lived, and restarted if it dies: a detector that quietly stopped is the
// same shape of silent failure this file works to avoid elsewhere. Its death
// never touches a capture in progress.
let detectRestartTimer = null;
function startDetector() {
    if (detectProc || detectRestartTimer) return;
    if (!fs.existsSync(MICWATCH_BIN)) {
        console.error(`detect: ${MICWATCH_BIN} missing — call detection disabled`);
        return;
    }
    let proc;
    try {
        proc = spawn(MICWATCH_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
        console.error(`detect: could not spawn micwatch: ${String(err)}`);
        return;
    }
    detectProc = proc;
    console.error(`detect: micwatch spawned pid=${proc.pid}`);
    let buf = '';
    proc.stdout.on('data', chunk => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line); } catch { console.error(`detect: unparsed line ${line}`); continue; }
            try { handleDetectEvent(ev); } catch (err) { console.error(`detect: handler threw ${String(err)}`); }
        }
    });
    proc.stderr.on('data', d => console.error(`micwatch: ${d.toString('utf8').trim()}`));
    proc.once('error', err => console.error(`detect: micwatch error ${String(err)}`));
    proc.once('exit', (code, signal) => {
        console.error(`detect: micwatch exited code=${code} signal=${signal}`);
        if (detectProc === proc) detectProc = null;
        autostopFeed(session && session.autostop, { type: 'detector_exit', t: Date.now(), code, signal });
        if (isQuitting) return;
        detectRestartTimer = setTimeout(() => { detectRestartTimer = null; startDetector(); }, 3000);
    });
}

function stopDetector() {
    if (detectRestartTimer) { clearTimeout(detectRestartTimer); detectRestartTimer = null; }
    if (detectProc) { try { detectProc.kill('SIGTERM'); } catch {} detectProc = null; }
}

// --- auto-stop (SAA-184) ---------------------------------------------------
//
// Carries out what autostop.step() asks for: append its log lines, run the
// grace timer, run the fresh holder check, and — only after the grace period
// and the expiry re-check, never at the first release — stop the capture.
// Live for every app that triggered a capture; a hand-started capture has no
// trigger and never auto-stops.
//
// Each capture gets its own tracker object, and callbacks (timer, holder
// check, stop) are bound to that object rather than read from `session`, so a
// late callback can never land on the next capture.
//
// stopRecording('auto') ends the way every stop does, in the identity prompt,
// but with nobody necessarily at the machine: see promptForIdentity (marker
// written at queue time) and pumpIdentityQueue (no always-on-top, no focus).

function autostopLogLine(a, entry) {
    try { fs.appendFileSync(a.logPath, JSON.stringify(entry) + '\n'); } catch (err) {
        console.error(`autostop: could not write ${a.logPath}: ${String(err)}`);
    }
}

function autostopFeed(a, ev) {
    if (!a) return;
    const r = autostop.step(a.state, ev);
    a.state = r.state;
    for (const o of r.out) {
        if (o.kind === 'log') autostopLogLine(a, o.entry);
        else if (o.kind === 'schedule') {
            if (a.timer) clearTimeout(a.timer);
            a.timer = setTimeout(() => {
                a.timer = null;
                autostopFeed(a, { type: 'expiry', t: Date.now(), token: o.token });
            }, Math.max(0, o.at - Date.now()));
        } else if (o.kind === 'cancel_timer') {
            if (a.timer) { clearTimeout(a.timer); a.timer = null; }
        } else if (o.kind === 'check_holders') {
            autostopCheckHolders(a, o.token);
        } else if (o.kind === 'stop') {
            // Deferred a tick so the stop does not re-enter this loop, and
            // checked against the tracker rather than `session` alone: a manual
            // Stop in between nulls session.autostop, and a later capture has a
            // different tracker, so neither can be stopped by this callback.
            setImmediate(() => {
                if (session && session.autostop === a && state !== 'stopped') {
                    console.error(`[clipwise-recorder] auto-stop: ${a.logPath}`);
                    stopRecording(o.cause);
                }
            });
        }
    }
}

// The fresh check at expiry: micwatch's own one-shot dump of every process
// running input right now, keyed the same way as the stream. A failed or
// unreadable check reports null keys, which the rule treats as "do not stop".
function autostopCheckHolders(a, token) {
    execFile(MICWATCH_BIN, ['--once'], { timeout: 5000 }, (err, stdout) => {
        let keys = null;
        let error = null;
        if (err) error = String(err);
        else {
            const r = autostop.parseHoldersOnce(stdout, detectKey);
            keys = r.keys;
            error = r.error;
        }
        autostopFeed(a, { type: 'holders', t: Date.now(), token, keys, error });
    });
}

function autostopBegin(stem, trigger) {
    const a = {
        logPath: path.join(OUTDIR, `autostop-${stem}.log`),
        state: autostop.initialState(),
        timer: null,
    };
    const held = trigger && detectActive.get(trigger.key);
    const pids = held ? [...held.keys()] : [];
    // Which processes the trigger is, as micwatch reported them (SAA-184 item
    // 4): the first real call in an untested app shows here whether it was
    // recognised. exe is the path's last component, as micwatch derives it.
    const pidInfo = held ? [...held.entries()].map(([pid, info]) => ({
        pid, name: info.name || null, path: info.path || null,
        exe: info.path ? path.basename(info.path) : null,
    })) : [];
    const first = pidInfo[0] || null;
    const detail = trigger
        ? { ...trigger, exe: first ? first.exe : null, path: first ? first.path : null }
        : null;
    autostopFeed(a, { type: 'capture_start', t: Date.now(), trigger: detail, pids, pidInfo });
    // Everything else holding the microphone right now, as its own log line and
    // asynchronous, so it can neither delay the start nor change a decision.
    if (trigger) {
        execFile(MICWATCH_BIN, ['--once'], { timeout: 5000 }, (err, stdout) => {
            // Nothing here may throw inside the main process.
            try {
                const r = err ? { holders: [], error: String(err) } : autostop.parseHoldersOnce(stdout, detectKey);
                autostopLogLine(a, { event: 'holders_at_start', t: new Date().toISOString(),
                    holders: r.holders || [], error: r.error });
            } catch (cbErr) {
                console.error(`autostop: holders_at_start failed: ${String(cbErr)}`);
            }
        });
    }
    return a;
}

// --- "Still recording?" (silence-reminder.js) ---------------------------------
//
// If the tap has had no sound for 60s of audio time, ask. The tap file is the
// only source: systemtap reports no levels (its log carries lifecycle and byte
// counts only), but the file grows continuously and pollTick already stats it.
// So each poll reads the bytes appended since the last one and hands them to
// silence-reminder.js, which decides. Nothing here can stop a capture except
// the reminder's own Stop button, and a failure anywhere in this section turns
// the detector off for that capture rather than affecting it.

function silenceBegin(s) {
    return {
        st: silenceReminder.initialState(s.startedAtMs),
        fd: null, offset: 0, bytesPerSecond: null, formatTries: 0,
        off: null,           // why the detector is off for this capture, if it is
        notification: null, ttl: null,
    };
}

// The format systemtap says it is writing, from its own log. The tap has been
// 48000 Hz mono float32 in all 108 logs on record; read here rather than
// assumed, so a different format turns the detector off instead of being
// misread as audio.
function silenceTapFormat(tapLogPath) {
    let text;
    try { text = fs.readFileSync(tapLogPath, 'utf8'); } catch { return null; }
    const m = text.match(/^format sample_rate=(\d+) channels=(\d+) bits=(\d+) is_float=(true|false)/m);
    if (!m) return null;
    return {
        ok: m[3] === '32' && m[4] === 'true' && Number(m[1]) > 0 && Number(m[2]) > 0,
        rate: Number(m[1]), channels: Number(m[2]), line: m[0],
    };
}

function silenceLog(s, entry) {
    if (s && s.autostop) autostopLogLine(s.autostop, entry);
}

function silenceDisable(s, why) {
    const z = s.silence;
    if (!z || z.off) return;
    z.off = why;
    console.error(`silence: reminder off for this capture — ${why}`);
    silenceLog(s, { event: 'silence_detector_off', t: new Date().toISOString(), why });
    if (z.fd !== null) { try { fs.closeSync(z.fd); } catch {} z.fd = null; }
}

function silenceWithdraw(s) {
    const z = s.silence;
    if (z.ttl) { clearTimeout(z.ttl); z.ttl = null; }
    if (z.notification) {
        try { z.notification.close(); } catch (err) {
            console.error(`silence: could not withdraw notification: ${String(err)}`);
        }
        z.notification = null;
    }
}

function silenceShow(s) {
    const z = s.silence;
    const title = 'Still recording?';
    const body = 'No call audio for a minute. Recording continues unless you press Stop.';
    console.error(logLines.notifyLine('silence-reminder'));
    z.ttl = setTimeout(() => silenceFeed(s, { type: 'expire', t: Date.now() }), SILENCE_REMINDER_TTL_MS);
    if (!Notification.isSupported()) {
        console.error('silence: Notification.isSupported() is false — reminder cannot be shown');
        return;
    }
    try {
        // silent: the tap hears everything the Mac plays, so the reminder's own
        // sound would count as sound and reset the very count it came from. Keep
        // is first: it is the button macOS shows, and a stray click on it costs
        // nothing, where a stray Stop ends a call's recording. There is no
        // osascript fallback for this one: it cannot carry buttons and it plays
        // a sound.
        const n = new Notification({
            title, body, silent: true,
            actions: [
                { type: 'button', text: 'Keep' },
                { type: 'button', text: 'Stop' },
            ],
        });
        n.on('action', (_e, index) => {
            // An answer for a capture that has since ended does nothing.
            if (session !== s) return;
            silenceFeed(s, { type: 'response', t: Date.now(), response: index === 0 ? 'keep' : 'stop' });
        });
        n.once('failed', (_e, err) => console.error(`silence: notification failed: ${String(err)}`));
        n.once('show', () => console.error(logLines.notifyDeliveredLine('silence-reminder')));
        z.notification = n;
        n.show();
    } catch (err) {
        console.error(`silence: could not show the reminder: ${String(err)}`);
    }
}

function silenceFeed(s, ev) {
    const z = s && s.silence;
    if (!z) return;
    const r = silenceReminder.step(z.st, ev);
    silenceApply(s, r);
}

function silenceApply(s, r) {
    const z = s.silence;
    z.st = r.state;
    for (const o of r.out) {
        if (o.kind === 'log') silenceLog(s, o.entry);
        else if (o.kind === 'show') silenceShow(s);
        else if (o.kind === 'withdraw') silenceWithdraw(s);
        else if (o.kind === 'stop') stopRecording(o.cause);
    }
}

// Called by pollTick while the state is 'recording'. tapSize is the size
// pollTick has just read.
function silenceTick(s, tapSize) {
    const z = s.silence;
    if (!z || z.off) return;
    try {
        if (!z.bytesPerSecond) {
            const fmt = silenceTapFormat(s.paths.tapLog);
            if (!fmt) {
                if (++z.formatTries > 20) silenceDisable(s, 'no format line in the systemtap log');
                return;
            }
            if (!fmt.ok) { silenceDisable(s, `tap is not 32-bit float (${fmt.line})`); return; }
            z.bytesPerSecond = fmt.rate * fmt.channels * 4;
        }
        if (z.fd === null) z.fd = fs.openSync(s.paths.tap, 'r');
        for (let i = 0; i < SILENCE_MAX_CHUNKS_PER_TICK; i++) {
            const whole = Math.floor((tapSize - z.offset) / 4) * 4;
            if (whole <= 0) break;
            const n = Math.min(whole, SILENCE_CHUNK_BYTES);
            const buf = Buffer.alloc(n);
            const got = fs.readSync(z.fd, buf, 0, n, z.offset);
            if (got <= 0) break;
            const usable = got - (got % 4);
            z.offset += usable;
            silenceApply(s, silenceReminder.feedBytes(z.st, buf.subarray(0, usable), Date.now(), z.bytesPerSecond));
            // A stop from the reminder ends the session; nothing more to read.
            if (session !== s) break;
        }
    } catch (err) {
        silenceDisable(s, String(err));
    }
}

// At every stop (autostopFinish calls this first): close the tracker, which
// withdraws a pending reminder and makes any later click inert.
function silenceEnd(s, cause) {
    const z = s && s.silence;
    if (!z) return;
    silenceFeed(s, { type: 'end', t: Date.now(), cause });
    silenceWithdraw(s);
    if (z.fd !== null) { try { fs.closeSync(z.fd); } catch {} z.fd = null; }
}

// At stop: close the tracker and write its record into the manifest, which
// transcribe.py carries into the transcript and ingest into
// recordings.metadata.autostop — the same route as the aec block. Runs before
// teardown, whose manifest rewrites read-modify-write and keep this key.
function autostopFinish(s, cause) {
    // First, so a pending reminder is withdrawn and its entry closed before the
    // block is written, whichever way the capture is ending.
    silenceEnd(s, cause);
    const a = s && s.autostop;
    if (!a) return;
    autostopFeed(a, { type: 'stop', t: Date.now(), cause });
    if (a.timer) { clearTimeout(a.timer); a.timer = null; }
    const block = autostop.autostopBlock(a.state);
    // The reminders ride in the same block, so they reach the transcript and
    // recordings.metadata.autostop with no change to either.
    if (s.silence) Object.assign(block, silenceReminder.silenceBlock(s.silence.st, s.silence.off));
    autostopLogLine(a, { event: 'block', ...block });
    try {
        const manifest = JSON.parse(fs.readFileSync(s.paths.manifest, 'utf8'));
        manifest.autostop = block;
        fs.writeFileSync(s.paths.manifest, JSON.stringify(manifest, null, 2) + '\n');
    } catch (err) {
        console.error(`autostop: could not write block to manifest: ${String(err)}`);
        autostopLogLine(a, { event: 'manifest_write_failed', error: String(err) });
    }
    s.autostop = null;
}

// --- pipeline -------------------------------------------------------------

// Spawned detached and unref'd so it survives the app quitting: a capture
// that has already ended should still become moments even if the user quits
// while it is being transcribed. The exit listener still fires for as long as
// this process is alive, which is what drives the tray.
//
// It is the database-free pipeline (capture-cli.ts), which needs no database and
// no API key; the upload at its exit hands the rest to the server.
function startPipeline(stem) {
    if (!stem) return;
    const logPath = path.join(OUTDIR, `pipeline-${stem}.log`);
    const run = pipelineSpawn(CAPTURE_PIPELINE_ENTRY, [OUTDIR, '--stem', stem]);
    let fd;
    try {
        fd = fs.openSync(logPath, 'a');
        fs.writeSync(
            fd,
            `\n[clipwise-recorder] ${new Date().toISOString()} pipeline start stem=${stem}\n`,
        );
    } catch (err) {
        console.error(`pipeline log ${logPath}: ${String(err)}`);
        return;
    }
    const proc = spawn(run.cmd, run.args, {
        cwd: run.cwd,
        env: run.env,
        stdio: ['ignore', fd, fd],
        detached: true,
    });
    fs.closeSync(fd);
    proc.unref();
    pipeline = { stem, state: 'running', proc };
    // Queued now, not at exit, so that a quit right after Stop still sends it.
    enqueueUpload(stem);
    renderTray();

    proc.once('error', (err) => {
        try {
            fs.appendFileSync(logPath, `[clipwise-recorder] spawn failed: ${String(err)}\n`);
        } catch {}
        if (pipeline && pipeline.proc === proc) {
            pipeline = { stem, state: 'failed', proc: null };
            renderTray();
        }
    });
    proc.once('exit', (code, signal) => {
        // The upload queue (SAA-227), whatever the exit code: the drain sends a
        // capture only once its record shows its steps settled. Drained after
        // `pipeline` is updated below, so this capture counts as settled.
        setImmediate(() => drainUploadQueue('pipeline exit'));
        if (!pipeline || pipeline.proc !== proc) return;
        if (code === 0) {
            pipeline = null;
            // Before the drain above runs (setImmediate), so a capture is
            // matched before its first send can enrol it (SAA-260 step 3).
            voicePrintsAfterPipeline(stem);
        } else {
            try {
                fs.appendFileSync(
                    logPath,
                    `[clipwise-recorder] pipeline exited code=${code} signal=${signal} — ` +
                    `see pipeline-${stem}.json for the failing step\n`,
                );
            } catch {}
            pipeline = { stem, state: 'failed', proc: null };
            // The unattended retry (SAA-136). The tray still shows the failure
            // and still offers Retry, but neither is now the only way back:
            // this capture's record shows a step that did not finish, so the
            // recovery pass will pick it up and finish it. Bounded at
            // three attempts per capture with a cooldown between them, so a
            // capture that fails for a reason retrying cannot fix stops on its
            // own rather than spinning.
            //
            // watchStem is what withdraws the failure once recovery actually
            // lands it (SAA-183) — see startRecovery's own comment for the
            // exact condition. Recovery running, or even completing without
            // reporting this stem complete, changes nothing here.
            startRecovery(`pipeline failed stem=${stem}`, { watchStem: stem });
        }
        renderTray();
    });
}

// --- recovery (SAA-136) ---------------------------------------------------
//
// The unattended half of processing. Runs on launch and after a pipeline run
// fails, works out what is outstanding from the capture records on disk
// (capture-recover.ts), and finishes it. Nothing here touches the tray: the point is that a capture whose
// processing died gets finished without the user learning it ever happened.
//
// Detached and unref'd for the same reason the pipeline is — a recovery that
// started should not be killed by the user quitting a minute later. No exit
// listener: nothing in the UI depends on the outcome, and the pass reports
// itself into recovery.log.
//
// Deliberately never spawned from the recovery pass's own result. It runs the
// pipeline in-process rather than through startPipeline, so a failure inside
// it cannot re-enter here; the only triggers are launch and a foreground
// pipeline run failing.
let recoveryProc = null;

function startRecovery(reason, opts = {}) {
    // One at a time. The pass is sequential and can take minutes on a backlog;
    // a second one would race it for the same captures.
    if (recoveryProc) {
        console.error(`[clipwise-recorder] recovery already running — skipping trigger (${reason})`);
        return;
    }
    const logPath = path.join(OUTDIR, 'recovery.log');
    const entry = CAPTURE_RECOVER_ENTRY;
    let fd;
    try {
        fd = fs.openSync(logPath, 'a');
        fs.writeSync(fd, `\n[clipwise-recorder] ${new Date().toISOString()} recovery start (${reason}) ${path.basename(entry)}\n`);
    } catch (err) {
        console.error(`recovery log ${logPath}: ${String(err)}`);
        return;
    }
    // Recorded here, before spawn, not read from the recovery file's own
    // last_action_at: a pass that aborts before reaching this stem at all
    // leaves the file holding whatever a PREVIOUS pass wrote. Comparing against this instant
    // is what stops that stale value from being read as "this pass cleared
    // it" (SAA-183).
    const triggeredAtMs = Date.now();
    // stdout and stderr both go straight to the log fd, as before recovery
    // was ever watched for anything: recovery is spawned detached specifically
    // so it survives the app quitting mid-pass, and a piped stdout would leave
    // it writing to a closed pipe (EPIPE) if that happens — a mid-write crash
    // in exactly the process this exists to make crashes safe from. The
    // withdrawal check below reads a file after the fact instead (SAA-183).
    const run = pipelineSpawn(entry, [OUTDIR]);
    const proc = spawn(run.cmd, run.args, {
        cwd: run.cwd,
        env: run.env,
        stdio: ['ignore', fd, fd],
        detached: true,
    });
    fs.closeSync(fd);
    proc.unref();
    recoveryProc = proc;
    proc.once('error', (err) => {
        try {
            fs.appendFileSync(logPath, `[clipwise-recorder] recovery spawn failed: ${String(err)}\n`);
        } catch {}
        if (recoveryProc === proc) recoveryProc = null;
    });
    proc.once('exit', (code, signal) => {
        try {
            fs.appendFileSync(
                logPath,
                `[clipwise-recorder] recovery exited code=${code} signal=${signal}\n`,
            );
        } catch {}
        if (recoveryProc === proc) recoveryProc = null;
        // The captures this pass finished are sent, whether or not their own
        // pipeline ever queued them: only those whose record says "recovered"
        // at or after this pass began, never every capture recovery looked at
        // ("complete" is written for each one already done, on every pass).
        // Matched before the drain sends them, as at a pipeline exit (SAA-260 step 3).
        for (const recovered of queueRecoveredCaptures(triggeredAtMs)) voicePrintsAfterPipeline(recovered);
        drainUploadQueue('recovery exit');
        // Read after the process is gone, not during — recovery.ts writes
        // recovery-<stem>.json and the capture's record before this exits, so
        // there is no race. Only withdraw a failure that is still this exact
        // stem: Retry, a new capture, or a later recovery pass could have
        // replaced `pipeline` with something else in the meantime. Withdrawn
        // when the record shows every step finished, or this pass reports the
        // capture complete (last-meeting.js failureResolved, SAA-238).
        if (opts.watchStem && pipeline && pipeline.stem === opts.watchStem && pipeline.state === 'failed') {
            if (failureResolved(OUTDIR, opts.watchStem, triggeredAtMs)) {
                console.error(`[clipwise-recorder] recovery: pipeline failure withdrawn (${opts.watchStem})`);
                pipeline = null;
                renderTray();
            }
        }
    });
}

function retryPipeline() {
    if (!pipeline || pipeline.state !== 'failed') return;
    startPipeline(pipeline.stem);
}

// Clears the tray badge only. The sidecar keeps the failure — dismissing is
// about the menu bar, not about deciding the capture was fine.
function dismissPipelineFailure() {
    if (!pipeline || pipeline.state !== 'failed') return;
    pipeline = null;
    renderTray();
}

// --- the capture server (SAA-227) -------------------------------------------
//
// Each finished capture is sent to POST /captures on the server named in
// capture-server.json, which ingests and extracts it. With no server set,
// captures stay on this Mac and nothing is sent.

// The server's origin, or null when none is set. Read on each use, so writing or
// removing the file takes effect without a restart. Any other key in the file
// (an older `mode`) is ignored.
function readCaptureServerUrl() {
    try {
        const doc = JSON.parse(fs.readFileSync(CAPTURE_SERVER_PATH, 'utf8'));
        const url = new URL(doc.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.origin;
    } catch {
        return null;
    }
}

// The capture token, once signed in: { server, access, refresh, expiresAt }.
let captureTokens = null;
// The loopback listener of a sign-in in progress, if any.
let captureSignIn = null;

// Sign-in, the way a native app does it (RFC 8252): a listener on 127.0.0.1 at
// a port the OS picks, the browser to the server's authorize page, then the code
// it redirects back with exchanged for tokens. The person signs in on the
// server's own login page; this process never sees a password.
function signInToCaptureServer() {
    const server = readCaptureServerUrl();
    if (!server) return;
    // A second click starts over rather than leaving the first listener open.
    if (captureSignIn) captureSignIn.close();
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    let redirectUri = null;
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
        if (captureSignIn === listener) captureSignIn = null;
        if (!code) {
            console.error(`[clipwise-recorder] sign-in: ${url.searchParams.get('error') || 'no_code'}`);
            setupSignInFinished(false);
            return;
        }
        exchangeCaptureCode(server, code, redirectUri, verifier);
    });
    listener.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${listener.address().port}/callback`;
        const query = new URLSearchParams({
            response_type: 'code',
            client_id: CAPTURE_CLIENT_ID,
            redirect_uri: redirectUri,
            scope: CAPTURE_SCOPES,
            state,
            code_challenge: createHash('sha256').update(verifier).digest('base64url'),
            code_challenge_method: 'S256',
            resource: `${server}/capture`,
        });
        shell.openExternal(`${server}/api/auth/oauth2/authorize?${query}`);
    });
    captureSignIn = listener;
}

async function exchangeCaptureCode(server, code, redirectUri, verifier) {
    try {
        const { status, body } = await postCaptureTokenForm(server, {
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            client_id: CAPTURE_CLIENT_ID,
            code_verifier: verifier,
            resource: `${server}/capture`,
        });
        if (!body.access_token || !body.refresh_token) {
            console.error(`[clipwise-recorder] sign-in: token ${status} ${body.error || 'no_token'}`);
            setupSignInFinished(false);
            return;
        }
        setCaptureTokens({
            server,
            access: body.access_token,
            refresh: body.refresh_token,
            expiresAt: Date.now() + Number(body.expires_in) * 1000,
        });
        console.error(`[clipwise-recorder] sign-in: signed in to ${server}`);
        sendUploadsWaitingOnSignIn();
        setupSignInFinished(true);
    } catch (err) {
        console.error(`[clipwise-recorder] sign-in: failed: ${err.cause?.code || err.name}`);
        setupSignInFinished(false);
    }
    renderTray();
}

// Stored first, then used: a token this process holds is always one the file
// also holds, so a quit at any moment never leaves only a rotated-away refresh
// token on disk. Throws when it cannot store, and then nothing changes.
function setCaptureTokens(tokens) {
    fs.mkdirSync(SUPPORT_DIR, { recursive: true });
    const tmp = `${CAPTURE_TOKEN_PATH}.tmp`;
    fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(tokens)), { mode: 0o600 });
    fs.renameSync(tmp, CAPTURE_TOKEN_PATH);
    captureTokens = tokens;
    scheduleCaptureRefresh();
}

// At launch. No file is the ordinary signed-out state.
function loadCaptureTokens() {
    try {
        captureTokens = JSON.parse(safeStorage.decryptString(fs.readFileSync(CAPTURE_TOKEN_PATH)));
        scheduleCaptureRefresh();
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`[clipwise-recorder] capture token: could not read it: ${err.name}`);
    }
}

// The tray's Sign out: the refresh token is revoked on the server first
// (capture-sign-out.js), then the Mac's copy goes whatever the outcome, which is
// logged as a word and a status, never the token (SAA-198 step 5).
async function signOutFromTray() {
    const held = captureTokens;
    if (held && held.refresh && held.server) {
        const outcome = await revokeRefreshToken(held.server, held.refresh, CAPTURE_CLIENT_ID);
        console.error(`[clipwise-recorder] capture token: revoke on the server: ${outcome}`);
    }
    signOutOfCaptureServer('tray');
}

function signOutOfCaptureServer(reason) {
    captureTokens = null;
    clearTimeout(captureRefreshTimer);
    captureRetryMs = CAPTURE_RETRY_FIRST_MS;
    try { fs.unlinkSync(CAPTURE_TOKEN_PATH); } catch {}
    console.error(`[clipwise-recorder] capture token: signed out (${reason})`);
    renderTray();
}

// Signed out by a refresh (the grant refused, or the new tokens not stored):
// one notification, whose click starts the same sign-in as the tray's item.
function signOutAfterRefresh(reason) {
    signOutOfCaptureServer(reason);
    notify('signed-out', 'Clipwise is signed out', 'Recordings are kept and will upload after you sign in.', signInToCaptureServer);
}

let captureRefreshTimer = null;
let captureRetryMs = CAPTURE_RETRY_FIRST_MS;
// How long until the held capture token's refresh is due, from the clock.
function captureRefreshDelay() {
    return Math.max(0, captureTokens.expiresAt - CAPTURE_REFRESH_EARLY_MS - Date.now());
}
function scheduleCaptureRefresh() {
    clearTimeout(captureRefreshTimer);
    if (!captureTokens) return;
    captureRefreshTimer = setTimeout(refreshCaptureToken, captureRefreshDelay());
}

// One refresh at a time: the server rotates refresh tokens, and a second request
// with the one the first just used would invalidate the whole family. A caller
// that arrives during a refresh gets that refresh's outcome. Resolves true when
// a new access token is stored.
let captureRefreshing = null;
function refreshCaptureToken() {
    if (!captureRefreshing) {
        captureRefreshing = refreshCaptureTokenOnce().finally(() => { captureRefreshing = null; });
    }
    return captureRefreshing;
}

// One refresh with the tokens held now (capture-refresh.js). After one that
// ends kept on a network failure, the next is scheduled after captureRetryMs,
// which then doubles up to its cap; one that stores new tokens resets it, and
// setCaptureTokens schedules the next refresh as before.
async function refreshCaptureTokenOnce() {
    const tokens = captureTokens;
    if (!tokens) return false;
    // With no server set, no server is called, this one included; the stored
    // tokens are kept.
    if (!readCaptureServerUrl()) return false;
    const outcome = await refreshCaptureTokens(tokens, CAPTURE_CLIENT_ID, { signOut: signOutAfterRefresh, store: setCaptureTokens });
    if (outcome === 'refreshed') captureRetryMs = CAPTURE_RETRY_FIRST_MS;
    if (outcome === 'kept-network') {
        clearTimeout(captureRefreshTimer);
        captureRefreshTimer = setTimeout(refreshCaptureToken, captureRetryMs);
        captureRetryMs = Math.min(captureRetryMs * 2, CAPTURE_RETRY_MAX_MS);
    }
    return outcome === 'refreshed';
}

// The body of POST /captures, from the capture's files in OUTDIR
// (capture-payload.js, moved there for its check; SAA-260 step 3).
function buildCapturePayload(stem) {
    return buildCapturePayloadIn(OUTDIR, stem);
}

// One POST /captures with the token held now. Resolves { status, error }, with
// status null when the request never got a reply.
async function postCapture(server, body) {
    try {
        const res = await fetch(`${server}/captures`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${captureTokens ? captureTokens.access : ''}`,
            },
            body,
        });
        const reply = await res.json().catch(() => ({}));
        // people: each voice's person id, for the voice prints on this Mac
        // (SAA-260 step 3). Ids only; absent from a server before step 3.
        const people = reply.people && typeof reply.people === 'object' ? reply.people : null;
        return { status: res.status, error: reply.error || null, recordingId: reply.recordingId || null, people };
    } catch (err) {
        return { status: null, error: err.cause?.code || err.name, recordingId: null, people: null };
    }
}

// --- upload queue (SAA-227 decision 9) ------------------------------------
//
// One file per capture in SUPPORT_DIR/upload-queue/<stem>.json, sent oldest
// first. A capture goes in when its pipeline starts, so a quit right after Stop
// still leaves it queued; it goes when that pipeline has settled (in this
// process or, after a relaunch, a detached one that has exited), whether the
// pipeline or the recovery pass finished it. The queue is drained at launch,
// after each pipeline, after recovery, and on a backoff from 1 minute doubling
// to 1 hour. A 401 refreshes the token and tries once more. A 409 or 422 is
// marked failed and never sent again; any other outcome is tried again later.
// Nothing expires. Each entry:
//   { stem, state: queued | sent | failed, queuedAt, attempts, nextAttemptAt,
//     lastStatus, lastError, recordingId, sentAt }
// Every log line is the stem, a status and an error code, never call content.

const UPLOAD_QUEUE_DIR = path.join(SUPPORT_DIR, 'upload-queue');
const UPLOAD_BACKOFF_FIRST_MS = 60 * 1000;
const UPLOAD_BACKOFF_MAX_MS = 60 * 60 * 1000;
// A pipeline still running gets looked at again after this, with no attempt counted.
const UPLOAD_WAIT_FOR_PIPELINE_MS = 60 * 1000;

// What last-meeting.js needs to classify a capture the database-free pipeline
// handled: where its queue entry, with its server job state, is.
function captureStateOpts() {
    return { uploadQueueDir: UPLOAD_QUEUE_DIR };
}

function uploadQueuePathFor(stem) {
    return path.join(UPLOAD_QUEUE_DIR, `${stem}.json`);
}

function readUploadEntry(stem) {
    try {
        return JSON.parse(fs.readFileSync(uploadQueuePathFor(stem), 'utf8'));
    } catch {
        return null;
    }
}

function writeUploadEntry(entry) {
    fs.mkdirSync(UPLOAD_QUEUE_DIR, { recursive: true });
    const finalPath = uploadQueuePathFor(entry.stem);
    fs.writeFileSync(`${finalPath}.tmp`, JSON.stringify(entry, null, 2) + '\n');
    fs.renameSync(`${finalPath}.tmp`, finalPath);
}

// Oldest first, by when each capture was first queued.
function listUploadQueue() {
    let names = [];
    try { names = fs.readdirSync(UPLOAD_QUEUE_DIR); } catch { return []; }
    return names
        .filter((n) => n.endsWith('.json'))
        .map((n) => readUploadEntry(n.slice(0, -'.json'.length)))
        .filter(Boolean)
        .sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
}

// Into the queue, or back into it: a new answer sends the whole capture again
// (the server applies it once). A failed capture stays failed, since a 409 or
// 422 would be the same again. Only while a server is set.
function enqueueUpload(stem) {
    if (!readCaptureServerUrl()) return;
    const prior = readUploadEntry(stem);
    if (prior && prior.state === 'failed') return;
    const now = new Date().toISOString();
    try {
        writeUploadEntry({
            stem,
            state: 'queued',
            queuedAt: prior ? prior.queuedAt : now,
            attempts: 0,
            nextAttemptAt: now,
            lastStatus: prior ? prior.lastStatus : null,
            lastError: null,
            recordingId: prior ? prior.recordingId : null,
            sentAt: prior ? prior.sentAt : null,
            // The identity answer the server last accepted (sendQueuedCapture),
            // which a correction corrects (identity-answer.js correctsFor).
            identityAcceptedAt: prior ? prior.identityAcceptedAt || null : null,
        });
        console.error(`[clipwise-recorder] upload ${stem}: queued`);
    } catch (err) {
        console.error(`[clipwise-recorder] upload ${stem}: could not queue: ${err.code || err.name}`);
    }
}

// Whether a capture's pipeline has finished with it: not running in this
// process, and its record shows no step running, or one whose process is gone
// (killed mid-step). No record yet means it has not started.
function pipelineSettled(stem) {
    if (pipeline && pipeline.stem === stem && pipeline.state === 'running') return false;
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(path.join(OUTDIR, `pipeline-${stem}.json`), 'utf8'));
    } catch {
        return false;
    }
    const running = Object.values(doc.steps || {}).some((st) => st && st.state === 'running');
    if (!running) return true;
    try {
        process.kill(doc.pid, 0);
        return false;
    } catch {
        return true;
    }
}

function uploadBackoffMs(attempts) {
    return Math.min(UPLOAD_BACKOFF_MAX_MS, UPLOAD_BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1));
}

// One try for one queued capture. Returns the entry as it now stands.
async function sendQueuedCapture(server, entry) {
    const stem = entry.stem;
    const retryLater = (status, error) => {
        const attempts = entry.attempts + 1;
        const wait = uploadBackoffMs(attempts);
        console.error(`[clipwise-recorder] upload ${stem}: ${status ?? 'no reply'}${error ? ` ${error}` : ''} (attempt ${attempts}, next in ${Math.round(wait / 1000)} s)`);
        return { ...entry, attempts, lastStatus: status, lastError: error, nextAttemptAt: new Date(Date.now() + wait).toISOString() };
    };
    if (!captureTokens || captureTokens.server !== server) return retryLater(null, 'not_signed_in');
    let body;
    let sentAnsweredAt = null;
    try {
        const payload = buildCapturePayload(stem);
        sentAnsweredAt = (payload.identity && payload.identity.answered_at) || null;
        body = JSON.stringify(payload);
    } catch (err) {
        return retryLater(null, `not_built ${err.message}`);
    }
    let reply = await postCapture(server, body);
    if (reply.status === 401 && await refreshCaptureToken()) {
        reply = await postCapture(server, body);
    }
    // Asked again from the start: a new send makes the job state unknown.
    const jobStateReset = { jobState: null, jobAnsweredMs: 0, jobPolledAt: null, jobUnanswered: 0, nextJobPollAt: null };
    if (reply.status === 200 || reply.status === 201) {
        console.error(`[clipwise-recorder] upload ${stem}: ${reply.status}`);
        if (reply.people) voicePrintsAfterSend(stem, reply.people);
        return {
            ...entry, state: 'sent', lastStatus: reply.status, lastError: null, recordingId: reply.recordingId || entry.recordingId, sentAt: new Date().toISOString(),
            identityAcceptedAt: sentAnsweredAt || entry.identityAcceptedAt || null,
            ...jobStateReset,
        };
    }
    // A correction of an answer the server no longer holds (SAA-258). The
    // capture itself is stored, so this is not a failed upload: the entry stays
    // sent, and only the correction is refused. Not retried, since it would be
    // refused the same way.
    if (reply.status === 409 && reply.error === 'identity_correction_stale') {
        console.error(`[clipwise-recorder] upload ${stem}: 409 identity_correction_stale (correction refused, capture still sent)`);
        notify('identity-correction-refused', 'Clipwise: change not saved',
            `Who was on the ${stemDateLabel(stem)} call wasn't changed: the server holds a different answer than the one this change replaced.`);
        return { ...entry, state: 'sent', lastStatus: 409, lastError: 'identity_correction_stale', ...jobStateReset };
    }
    if (reply.status === 409 || reply.status === 422) {
        console.error(`[clipwise-recorder] upload ${stem}: ${reply.status} ${reply.error || ''} (failed, not retried)`);
        return { ...entry, state: 'failed', lastStatus: reply.status, lastError: reply.error };
    }
    return retryLater(reply.status, reply.error);
}

let uploadDraining = null;
let uploadDrainAgain = false;
let uploadTimer = null;

// Sends every queued capture that is due, oldest first, one at a time. A call
// while a drain runs makes that drain go round once more.
function drainUploadQueue(reason) {
    if (uploadDraining) {
        uploadDrainAgain = true;
        return uploadDraining;
    }
    uploadDraining = (async () => {
        do {
            uploadDrainAgain = false;
            const server = readCaptureServerUrl();
            if (!server) return;
            for (const entry of listUploadQueue()) {
                if (entry.state !== 'queued' || Date.parse(entry.nextAttemptAt) > Date.now()) continue;
                let next;
                if (!pipelineSettled(entry.stem)) {
                    next = { ...entry, nextAttemptAt: new Date(Date.now() + UPLOAD_WAIT_FOR_PIPELINE_MS).toISOString() };
                    console.error(`[clipwise-recorder] upload ${entry.stem}: waiting for its pipeline`);
                } else {
                    next = await sendQueuedCapture(server, entry);
                }
                // A newer answer may have queued it again while this was sending,
                // or a delete from the trash removed it: gone stays gone.
                if (!fs.existsSync(uploadQueuePathFor(entry.stem))) continue;
                const current = readUploadEntry(entry.stem);
                if (current && current.nextAttemptAt !== entry.nextAttemptAt && current.state === 'queued') {
                    uploadDrainAgain = true;
                    continue;
                }
                try { writeUploadEntry(next); } catch (err) {
                    console.error(`[clipwise-recorder] upload ${entry.stem}: could not record the outcome: ${err.code || err.name}`);
                }
            }
        } while (uploadDrainAgain);
    })()
        .catch((err) => console.error(`[clipwise-recorder] upload queue (${reason}): ${err.name}`))
        .finally(() => {
            uploadDraining = null;
            scheduleUploadTimer();
            scheduleJobPoll(0);
            renderTray();
            // Each pipeline and recovery exit ends here (SAA-253).
            maybeApplyUpdate('upload queue drained');
        });
    return uploadDraining;
}

// --- job status in the tray (SAA-227 decision 11) ---------------------------
//
// Each sent capture's jobs on the server (GET /captures/:captureId/jobs), folded
// into one state on its queue entry by last-meeting.js jobStateOf, which counts
// the extraction jobs only (part F decision 18): running while any is queued or
// running, failed when none is and one failed, done when all are done. Asked only
// while some sent capture's state is not settled (unknown or running), or its
// calendar match is still to finish (matchPending), each when its entry says it
// is next due (last-meeting.js jobPollStep: JOB_POLL_MS while the server answers,
// backing off to an hour while it does not); with none, no timer and no request,
// so an idle Mac never wakes the server's database. A finished match's title and
// invitees come back in the same reply and are written to
// calendar-match-<stem>.json for Recent Meetings (decision 15). jobPollStep has
// the limit: past JOB_POLL_LIMIT_MS of answers, a state still unsettled is
// "stale" (status unknown) and is asked about again only by askJobsAgain, at
// launch, on wake and when Recent meetings opens (SAA-183). That pass also asks
// about a failed capture from the last JOB_FAILED_ASK_MS, since a server retry
// can finish it later; a reply that still says failed leaves it failed. A new
// send of a capture (an answer) makes its state unknown again, which starts the
// asking, and the limit, again.

const JOB_FAILED_ASK_MS = 7 * 24 * 60 * 60 * 1000;

let jobPollTimer = null;
let jobPolling = false;
// Set by askJobsAgain: the next pass asks about every sent capture whose state
// is unsettled or stale, or failed within JOB_FAILED_ASK_MS, due or not.
let jobAskAll = false;

function unsettledUploads() {
    return listUploadQueue().filter((e) => e.state === 'sent' && (!JOB_SETTLED.has(e.jobState) || e.matchPending === true));
}

function scheduleJobPoll(delayMs) {
    if (jobPollTimer || jobPolling) return;
    let waitMs = delayMs;
    if (!jobAskAll) {
        const due = unsettledUploads().map((e) => Date.parse(e.nextJobPollAt));
        if (due.length === 0) return;
        waitMs = Math.max(delayMs, Math.min(...due.map((t) => (Number.isFinite(t) ? t : 0))) - Date.now());
    }
    jobPollTimer = setTimeout(() => { jobPollTimer = null; pollJobStates(); }, waitMs);
}

// Asks once about every sent capture not known to be finished, stale ones and
// failed ones from the last JOB_FAILED_ASK_MS included, without waiting for any
// backoff (SAA-183). A pass already running leaves it to the next one.
function askJobsAgain(reason) {
    jobAskAll = true;
    console.error(`[clipwise-recorder] jobs: asking again (${reason})`);
    clearTimeout(jobPollTimer);
    jobPollTimer = null;
    scheduleJobPoll(0);
}

async function pollJobStates() {
    const server = signedInServer();
    if (!server) return;
    jobPolling = true;
    const askAll = jobAskAll;
    jobAskAll = false;
    try {
        const now = Date.now();
        const asking = listUploadQueue().filter((e) => e.state === 'sent' && (
            (askAll && (e.jobState === 'stale' || (e.jobState === 'failed' && stemTimeMs(e.stem) >= now - JOB_FAILED_ASK_MS))) ||
            ((!JOB_SETTLED.has(e.jobState) || e.matchPending === true) && (askAll || !(Date.parse(e.nextJobPollAt) > now)))));
        for (const entry of asking) {
            const captureId = captureIdFor(entry.stem);
            if (!captureId) continue;
            const reply = await captureServerRequest(server, 'GET', `/captures/${captureId}/jobs`);
            const { gaveUp, ...next } = jobPollStep(entry, reply, Date.now());
            let wroteMatch = false;
            if (reply.status === 200 && reply.json && Array.isArray(reply.json.jobs)) {
                try {
                    wroteMatch = writeCalendarMatchFile(OUTDIR, entry.stem, reply.json.calendar);
                } catch (err) {
                    console.error(`[clipwise-recorder] upload ${entry.stem}: calendar match not written: ${err.code || err.name}`);
                }
            }
            // Ids, states and whether a match was written; never the title or a name.
            const retry = reply.status == null ? ` (next in ${Math.round((Date.parse(next.nextJobPollAt) - Date.now()) / 1000)} s)` : '';
            console.error(`[clipwise-recorder] upload ${entry.stem}: jobs ${reply.status ?? 'no reply'} ${next.jobState ?? 'unknown'}${next.matchPending ? ', match pending' : ''}${wroteMatch ? ', calendar match written' : ''}${retry}`);
            if (gaveUp === 'jobs') console.error(`[clipwise-recorder] upload ${entry.stem}: jobs unsettled after ${JOB_POLL_LIMIT_MS / 60000} min of replies, status unknown (asked again at launch, on wake and when Recent meetings opens)`);
            if (gaveUp === 'match') console.error(`[clipwise-recorder] upload ${entry.stem}: calendar match not asked any more (${JOB_POLL_LIMIT_MS / 60000} min of replies)`);
            // A send that happened meanwhile wins: its state starts unknown again.
            const current = readUploadEntry(entry.stem);
            if (!current || current.state !== 'sent' || current.sentAt !== entry.sentAt) continue;
            writeUploadEntry({
                ...current,
                jobState: next.jobState,
                matchPending: next.matchPending,
                jobAnsweredMs: next.jobAnsweredMs,
                jobPolledAt: next.jobPolledAt,
                jobUnanswered: next.jobUnanswered,
                nextJobPollAt: next.nextJobPollAt,
            });
        }
    } finally {
        jobPolling = false;
        renderTray();
        scheduleJobPoll(JOB_POLL_MS);
    }
}

// The tray's line for one queued capture: upload state from the queue, job state
// from the server.
function uploadTrayLabel(entry) {
    const when = stemRelativeTime(entry.stem);
    if (entry.state === 'queued') return `${entry.attempts > 0 ? 'Upload waiting to retry' : 'Upload queued'} — ${when}`;
    if (entry.state === 'failed') return `Upload refused (${entry.lastStatus}) — ${when}`;
    const job = {
        done: 'Uploaded, ready',
        failed: 'Uploaded, processing failed',
        none: 'Uploaded',
        gone: 'Uploaded, no longer on the server',
        stale: 'Uploaded, status unknown',
    }[entry.jobState] || 'Uploaded, processing';
    return `${job} — ${when}`;
}

// Wakes the queue when its earliest queued capture is next due. None queued, no timer.
function scheduleUploadTimer() {
    clearTimeout(uploadTimer);
    uploadTimer = null;
    const due = listUploadQueue().filter((e) => e.state === 'queued').map((e) => Date.parse(e.nextAttemptAt)).filter(Number.isFinite);
    if (due.length === 0) return;
    uploadTimer = setTimeout(() => drainUploadQueue('backoff'), Math.max(0, Math.min(...due) - Date.now()));
}

// After a sign-in: the queued captures that waited because no one was signed in
// are made due now with their attempts reset, each logged, and the queue is
// drained. The others keep their backoff.
function sendUploadsWaitingOnSignIn() {
    for (const entry of listUploadQueue()) {
        if (entry.state !== 'queued' || entry.lastError !== 'not_signed_in') continue;
        try {
            writeUploadEntry({ ...entry, attempts: 0, nextAttemptAt: new Date().toISOString() });
            console.error(`[clipwise-recorder] upload ${entry.stem}: due now (signed in)`);
        } catch (err) {
            console.error(`[clipwise-recorder] upload ${entry.stem}: could not make it due: ${err.code || err.name}`);
        }
    }
    drainUploadQueue('sign-in');
}

// Queues the captures one recovery pass ran to the end (capture-recover.ts writes
// last_action "recovered" in recovery-<stem>.json when it does).
// -> the stems queued.
function queueRecoveredCaptures(passStartedAtMs) {
    const queued = [];
    let names = [];
    try { names = fs.readdirSync(OUTDIR); } catch { return queued; }
    for (const name of names) {
        const m = /^recovery-(.+)\.json$/.exec(name);
        if (!m) continue;
        let record;
        try { record = JSON.parse(fs.readFileSync(path.join(OUTDIR, name), 'utf8')); } catch { continue; }
        if (record.last_action === 'recovered' && Date.parse(record.last_action_at) >= passStartedAtMs) {
            enqueueUpload(m[1]);
            queued.push(m[1]);
        }
    }
    return queued;
}

// --- the capture-scope routes (SAA-227) --------------------------------------
//
// Save transcript and trash, restore, delete permanently, over the server's
// routes for the owner's own captures (routes/capture-scope.ts). The log holds
// the stem, a status and, for a transcript, the SHA-256 of the server's file,
// never its text.

// The capture's id on the server: the manifest's recording_id, as sent.
function captureIdFor(stem) {
    try {
        return JSON.parse(fs.readFileSync(path.join(OUTDIR, `manifest-${stem}.json`), 'utf8')).recording_id || null;
    } catch {
        return null;
    }
}

// One request to a capture-scope route with the token held now; a 401 refreshes
// the token and tries once more. Resolves { status, json }, status null with no reply.
async function captureServerRequest(server, method, route, json) {
    const once = async () => {
        try {
            const res = await fetch(`${server}${route}`, {
                method,
                headers: {
                    ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
                    authorization: `Bearer ${captureTokens ? captureTokens.access : ''}`,
                },
                body: json !== undefined ? JSON.stringify(json) : undefined,
            });
            return { status: res.status, json: await res.json().catch(() => ({})) };
        } catch (err) {
            return { status: null, json: { error: err.cause?.code || err.name } };
        }
    };
    let reply = await once();
    if (reply.status === 401 && await refreshCaptureToken()) reply = await once();
    return reply;
}

// The server, when calls to it should go (a server set and this app signed in to
// it); null otherwise.
function signedInServer() {
    const server = readCaptureServerUrl();
    return server && captureTokens && captureTokens.server === server ? server : null;
}

// The server owns trash state (SAA-227 part L decision 8), and this Mac's marker
// (trashed-<stem>.json, server/src/lib/trash-marker.ts's format) and files follow
// what it answered. One result per stem: { action, stem, ok, code?, message? }.
//   trash    POST …/trash, then the marker, holding the server's trashedAt
//   restore  POST …/restore, then the marker goes
//   delete   DELETE, then the files, the manifest last, then the marker: a crash
//            part way leaves a capture still in the trash, and deleting it again
//            finishes it
// A 404 means the server has no such capture of this member's (never uploaded,
// or already deleted), and the Mac side still follows. Anything else changes
// nothing on this Mac.
async function runTrashOnServer(action, stems) {
    const server = signedInServer();
    const results = [];
    for (const stem of stems) {
        const fail = (code, message) => results.push({ action, stem, ok: false, code, message });
        if (!server) { fail('not_signed_in', 'not signed in to the Clipwise server'); continue; }
        const captureId = captureIdFor(stem);
        if (!captureId) { fail('no_manifest', `no readable manifest for ${stem}`); continue; }
        const reply = action === 'trash'
            ? await captureServerRequest(server, 'POST', `/captures/${captureId}/trash`, {})
            : action === 'restore'
                ? await captureServerRequest(server, 'POST', `/captures/${captureId}/restore`, {})
                : await captureServerRequest(server, 'DELETE', `/captures/${captureId}`);
        console.error(`[clipwise-recorder] trash ${action} ${stem}: server ${reply.status ?? 'no reply'}${reply.json.error ? ` ${reply.json.error}` : ''}`);
        if (reply.status === null) { fail('server_unreachable', `couldn't reach the Clipwise server (${reply.json.error || 'no reply'})`); continue; }
        if (reply.status !== 200 && reply.status !== 404) { fail('server_refused', `the server answered ${reply.status} ${reply.json.error || ''}`.trim()); continue; }
        try {
            if (action === 'trash') {
                const trashedAt = reply.status === 200 && typeof reply.json.trashedAt === 'string' ? reply.json.trashedAt : new Date().toISOString();
                writeTrashMarker(stem, { stem, source_id: captureId, trashed_at: trashedAt });
                results.push({ action, stem, ok: true });
            } else if (action === 'restore') {
                fs.rmSync(trashMarkerPath(stem), { force: true });
                results.push({ action, stem, ok: true });
            } else {
                // Its voice prints' contributions and score lines go first, while
                // nothing else is gone (SAA-260 step 3).
                voicePrintsRemoveRecording(stem);
                const files = removeCaptureFiles(OUTDIR, UPLOAD_QUEUE_DIR, stem);
                results.push({ action, stem, ok: true, files });
            }
        } catch (err) {
            fail('error', `the server ${action === 'delete' ? 'deleted' : action === 'trash' ? 'trashed' : 'restored'} it, but this Mac could not follow: ${err.code || err.name}`);
        }
    }
    return results;
}

function trashMarkerPath(stem) {
    return path.join(OUTDIR, `trashed-${stem}.json`);
}

// Written whole or not at all, as trash-marker.ts writes it.
function writeTrashMarker(stem, marker) {
    const finalPath = trashMarkerPath(stem);
    fs.writeFileSync(`${finalPath}.tmp`, JSON.stringify(marker, null, 2) + '\n');
    fs.renameSync(`${finalPath}.tmp`, finalPath);
}

// An identity answer or voice names just written. The capture is queued again
// with its answer; while its pipeline is still running, the send at its exit
// carries the answer in the first POST. Otherwise the whole capture goes again
// and the server applies the answer once (captures.ts).
function uploadAnswer(stem) {
    enqueueUpload(stem);
    if (pipeline && pipeline.stem === stem && pipeline.state === 'running') return;
    drainUploadQueue('answer');
}

// --- identity (SAA-114) ---------------------------------------------------
//
// The prompt is strictly downstream of the audio. It is created from
// teardown's completion callback, after the children are gone, after the
// manifest has been finalised and after the pipeline has been spawned — so
// there is no path by which answering it, ignoring it, or failing to draw it
// can stop, delay, shorten or discard a capture. Dismissed or ignored, the
// recording is unidentified and otherwise intact.
//
// The trigger is the capture stopping, whatever stopped it: the tray item, a
// child dying, the start deadline expiring. All three already funnel through
// stopRecording, and nothing here detects anything on its own.
//
// Quit is the one stop that cannot prompt — the process is on its way out and
// a window cannot outlive it. That capture is unidentified, which is the
// tolerated outcome rather than a special case worth blocking a quit over.

// Writing the answer is identity-answer.js's job — see the note there on why
// the file is where it is and why a rename is what puts it in place. This is
// the reporting half: what was written, for the log a packaged app leaves
// behind.
function writeIdentityAnswer(capture, answer) {
    const doc = buildAnswerDoc({
        stem: capture.stem,
        recordingId: capture.recordingId,
        names: answer.names,
        selfName: answer.selfName,
        scope: answer.scope,
        corrects: answer.corrects,
    });
    const finalPath = writeAnswer(OUTDIR, doc);
    console.error(logLines.identityLine(capture.stem, !!doc.self.name, doc.guests.length, doc.scope, finalPath));
    return finalPath;
}

// Asked once, then reused. Kept beside the recordings rather than in the
// capture directory: it is a fact about the person, not about one capture.
function readSelfName() {
    try {
        const doc = JSON.parse(fs.readFileSync(SELF_PATH, 'utf8'));
        return typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : null;
    } catch {
        return null;
    }
}

function writeSelfName(name) {
    if (!name) return;
    try {
        fs.mkdirSync(SUPPORT_DIR, { recursive: true });
        fs.writeFileSync(
            SELF_PATH,
            JSON.stringify({ name, set_at: new Date().toISOString() }, null, 2) + '\n');
    } catch (err) {
        console.error(`identity: could not remember your name: ${String(err)}`);
    }
}

function promptForIdentity(capture) {
    if (!capture || !capture.stem) return;
    const queued = { ...capture, token: randomUUID() };
    identityQueue.push(queued);
    // The later-marker is written now, when the capture is queued, not when the
    // window is closed. An unanswered window, a quit, a crash, or a window that
    // could not be drawn at all then leaves the capture as a menu bar item
    // instead of silently unidentified. Save and Skip delete it as before. This
    // is what makes an auto-stop with nobody at the Mac safe, and it closes the
    // same gap for a manual stop.
    deferIdentityPrompt(queued);
    requestCalendarPreview(queued);
    pumpIdentityQueue();
}

// Who the calendar says a capture that just stopped was with (SAA-221). Asked
// once, here at stop, and never for a window reopened from the tray or a
// correction. A reply is applied only if it comes within
// CALENDAR_PREVIEW_WAIT_MS of the request and the capture's window has not
// closed meanwhile; the page gets it now if it is loaded, or when it loads.
// The log is the outcome and counts only.
function requestCalendarPreview(capture) {
    const server = signedInServer();
    let startedAt = null;
    try {
        startedAt = JSON.parse(fs.readFileSync(path.join(OUTDIR, `manifest-${capture.stem}.json`), 'utf8')).started_at || null;
    } catch {}
    if (!server || !startedAt) {
        console.error(logLines.calendarPreviewLine(capture.stem, server ? 'no_start_time' : 'not_signed_in'));
        return;
    }
    const askedAt = Date.now();
    captureServerRequest(server, 'POST', '/captures/calendar-preview', { startedAt }).then((reply) => {
        const ms = Date.now() - askedAt;
        const line = (outcome, prefill) => console.error(logLines.calendarPreviewLine(capture.stem, outcome, ms, prefill));
        if (ms > CALENDAR_PREVIEW_WAIT_MS) return line('late');
        if (reply.status === null) return line('no_reply');
        if (reply.status !== 200) return line(`status_${reply.status}`);
        const prefill = calendarPrefillFrom(reply.json);
        if (!prefill) return line('no_match');
        if (!identityQueue.some((c) => c.token === capture.token)) return line('window_gone');
        calendarPreviews.set(capture.token, prefill);
        line('applied', prefill);
        sendCalendarPreview(capture.token);
    });
}

// To the page, if this token's window is on screen at step 1 with its page
// loaded. Sent at most once per window: the page also ignores a second one.
function sendCalendarPreview(token) {
    const prefill = calendarPreviews.get(token);
    if (!prefill || !identityWindow || identityWindow.capture.token !== token) return;
    if (!identityWindow.loaded || identityWindow.step !== 1 || identityWindow.calendarSent) return;
    identityWindow.calendarSent = true;
    identityWindow.win.webContents.send('identity:calendar', prefill);
}

// Records that step 1 is unanswered (SAA-197; also written when the capture is
// queued, see promptForIdentity). `capture`
// carries exactly the fields promptForIdentity itself needs to reopen the
// same prompt later — everything else (self, known names) is read fresh
// from disk when it does. Failure just means the tray item won't appear;
// the capture is unaffected either way, so this only logs.
function deferIdentityPrompt(capture) {
    try {
        // `auto` only shapes how the window is shown and must not outlive it;
        // what is kept, as stopped_by, is the fact that explains the tray item.
        const { auto, ...fields } = capture;
        writeLaterMarker(OUTDIR, auto ? { ...fields, stopped_by: 'auto' } : fields);
        // Without this the tray item only appears at the next unrelated
        // refresh (SAA-197 fix, 2026-09-25) — observed live: it didn't show
        // until the pipeline's extract step happened to trigger one.
        renderTray();
    } catch (err) {
        console.error(`identity: could not defer ${capture.stem}: ${String(err)}`);
    }
}

// Ends this window's turn for good: stops its naming-data poll if one is
// running, and — only when it came off identityQueue — advances past it, so
// the queue can offer the next different capture. A window reopened from
// the tray (reopenVoiceNaming) never touched the queue and must not shift
// it; that path's own `fromQueue: false` is what this checks.
function resolveIdentityWindow() {
    if (!identityWindow) return;
    identityWindow.resolved = true;
    if (identityWindow.pollTimer) {
        clearInterval(identityWindow.pollTimer);
        identityWindow.pollTimer = null;
    }
    if (identityWindow.fromQueue) identityQueue.shift();
}

// The pipeline's own per-step record (pipeline-<stem>.json, capture-cli.ts's, or
// the direct pipeline's before the cut-over)
// — read directly, no database access, same reason every other file this
// process reads is a file.
function readPipelineSidecar(dir, stem) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, `pipeline-${stem}.json`), 'utf8'));
    } catch {
        return null;
    }
}

// Step 2's wait, with a stop (SAA-195 fix, 2026-09-25). Every tick: naming
// data found -> show it. Otherwise, stopMessageFor (voice-naming-wait.js —
// see its own comment for exactly which pipeline-record fields it reads)
// decides whether to give up and why.
function beginNamingDataWait(capture) {
    const startedAt = Date.now();
    identityWindow.pollTimer = setInterval(() => {
        if (!identityWindow || identityWindow.capture.token !== capture.token) return;

        const data = readNamingData(OUTDIR, capture.stem);
        if (data) {
            clearInterval(identityWindow.pollTimer);
            identityWindow.pollTimer = null;
            identityWindow.win.webContents.send('identity:step2-ready', data);
            return;
        }

        const sidecar = readPipelineSidecar(OUTDIR, capture.stem);
        const stopMessage = stopMessageFor(sidecar);

        if (stopMessage) {
            clearInterval(identityWindow.pollTimer);
            identityWindow.pollTimer = null;
            identityWindow.win.webContents.send('identity:step2-stopped', { message: stopMessage });
            setTimeout(() => {
                if (identityWindow && identityWindow.capture.token === capture.token) finishIdentityWindow();
            }, VOICE_NAMING_STOP_MESSAGE_MS);
            return;
        }

        if (Date.now() - startedAt > VOICE_NAMING_WAIT_CAP_MS) {
            clearInterval(identityWindow.pollTimer);
            identityWindow.pollTimer = null;
            finishIdentityWindow();
        }
    }, VOICE_NAMING_POLL_MS);
}

function pumpIdentityQueue() {
    if (identityWindow || identityQueue.length === 0) return;
    const capture = identityQueue[0];
    let win;
    try {
        win = new BrowserWindow({
            // Content box, not frame: the page measures its own content and
            // asks for a height (identity:resize), and a frame-sized window
            // would apply that measurement to the wrong box and clip by the
            // height of the title bar.
            useContentSize: true,
            width: IDENTITY_WINDOW.width,
            // Created at the full height from the start, then shrunk once
            // the page reports its real size (SAA-186). Starting small and
            // growing after load — the previous behaviour — corrupted the
            // known-names checklist whenever the grow crossed into territory
            // the hidden window had never painted: created at 220px, resized
            // to a clamped 560px, the newly-exposed 220-560 band showed a
            // stale/torn composite on first show(), reproducibly, on both
            // the dev Electron binary and the signed packaged app. Creating
            // at maxHeight and only ever shrinking from here never exposes
            // unpainted territory — confirmed by the same repro with the
            // creation height flipped and nothing else changed. The window
            // is still hidden until reveal(), so a short dialog never
            // visibly flashes the taller size.
            height: IDENTITY_WINDOW.maxHeight,
            show: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            // Not on top after an auto-stop: nobody asked for this window, and the
            // person may be in the middle of something else.
            alwaysOnTop: !capture.auto,
            title: 'Who was on this call?',
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
    } catch (err) {
        // A prompt that cannot be drawn leaves the recording unidentified. The
        // capture is already on disk and already in the pipeline.
        console.error(`identity: could not open the prompt: ${String(err)}`);
        calendarPreviews.delete(identityQueue.shift().token);
        return;
    }
    identityWindow = { win, capture, shown: false, step: 1, resolved: false, fromQueue: true, pollTimer: null, loaded: false, calendarSent: false };
    // Shown once, by whichever comes first: the page's own height message, or
    // a deadline. The deadline is what stops a broken measurement from leaving
    // the prompt invisible — a window nobody can see is worse than one sized
    // to the minimum, and the layout keeps the buttons reachable either way.
    const reveal = () => {
        if (!identityWindow || identityWindow.win !== win || identityWindow.shown) return;
        identityWindow.shown = true;
        // After an auto-stop the window appears without taking focus.
        if (capture.auto) win.showInactive(); else win.show();
        // An accessory app's window opens behind whatever is in front. The
        // question is about the call that just ended, so it is asked now or
        // not at all.
        if (!capture.auto) { try { app.focus({ steal: true }); } catch {} }
    };
    identityWindow.reveal = reveal;
    win.once('ready-to-show', () => setTimeout(reveal, IDENTITY_REVEAL_GRACE_MS));
    // A calendar preview that came before the page could receive it (SAA-221).
    win.webContents.once('did-finish-load', () => {
        if (!identityWindow || identityWindow.win !== win) return;
        identityWindow.loaded = true;
        sendCalendarPreview(capture.token);
    });
    win.once('closed', () => {
        // SAA-197: closing via the window's own controls used to reopen the
        // same capture immediately — this queue never advanced, because
        // only Save/Skip/Later did that. Treated now as Later, both at step
        // 1 (a marker written so a tray item can offer it again — see
        // deferIdentityPrompt) and step 2 (unchanged: driven entirely by
        // voices-<stem>.json existing without voice-names-<stem>.json,
        // nothing to write) — a native close is a real, resumable answer,
        // never a silent reopen and never Skip's permanence.
        if (identityWindow && identityWindow.win === win && !identityWindow.resolved) {
            const capture = identityWindow.capture;
            if (identityWindow.step === 2) {
                console.error(
                    `[clipwise-recorder] identity ${capture.stem}: closed during step 2 — treated as Later`);
            } else {
                console.error(
                    `[clipwise-recorder] identity ${capture.stem}: closed during step 1 — treated as Later`);
                deferIdentityPrompt(capture);
            }
            resolveIdentityWindow();
        }
        calendarPreviews.delete(capture.token);
        identityWindow = null;
        pumpIdentityQueue();
    });
    win.loadFile(IDENTITY_HTML, {
        query: {
            token: capture.token,
            stem: capture.stem,
            self: readSelfName() || '',
            // SAA-169: names from every previous answer on this machine, so
            // the page can offer them as a pick-list instead of requiring
            // them to be retyped. Small (JSON array of strings) and local —
            // a directory scan, not a network or DB call — so this stays
            // synchronous with the rest of window setup.
            knownNames: JSON.stringify(knownGuestNames(OUTDIR)),
            // SAA-170: which scope the triggering app implies, or '' for no
            // inference (a manual start, or an app with no entry) — the page
            // pre-selects this and nothing else, never defaulting on its own.
            inferredScope: capture.inferredScope === 'work' || capture.inferredScope === 'personal'
                ? capture.inferredScope : '',
            // SAA-187: milliseconds, as a string — '' when unavailable rather
            // than omitted, matching inferredScope's convention so the page
            // can tell "not provided" from "provided as zero".
            duration: Number.isFinite(capture.durationMs) ? String(capture.durationMs) : '',
        },
    }).catch((err) => {
        console.error(`identity: prompt failed to load: ${String(err)}`);
        try { win.close(); } catch {}
    });
}

// Validates that `token` names the window currently on screen and returns
// its capture, without resolving anything — unlike the old
// claimIdentityPrompt, a step 1 submission with more than one guest must
// leave the window and the queue exactly where they are while step 2 takes
// over the same window.
function currentCapture(token) {
    if (!identityWindow || identityWindow.capture.token !== token) return null;
    return identityWindow.capture;
}

// Terminal for this capture: resolves the queue/poll bookkeeping, then
// closes the window. Every path that ends this capture's turn — the
// one-guest short-circuit, a step 2 save, Skip, Later — goes through this,
// so exactly one thing ever advances the queue for it.
function finishIdentityWindow() {
    resolveIdentityWindow();
    try { identityWindow.win.close(); } catch {}
}

function registerIdentityIpc() {
    // The page reporting how tall it needs to be. Sized before it is shown, so
    // the prompt never appears at one height and jumps to another.
    ipcMain.on('identity:resize', (_event, payload) => {
        if (!identityWindow || !payload || identityWindow.capture.token !== payload.token) return;
        const height = contentHeightFor(payload.height);
        try {
            identityWindow.win.setContentSize(IDENTITY_WINDOW.width, height);
        } catch (err) {
            console.error(`identity: could not size the prompt: ${String(err)}`);
        }
        console.error(
            `[clipwise-recorder] identity ${identityWindow.capture.stem}: ` +
            `prompt content ${IDENTITY_WINDOW.width}x${height} (page asked for ${payload.height})`);
        identityWindow.reveal();
    });

    ipcMain.on('identity:submit', (_event, payload) => {
        const capture = currentCapture(payload && payload.token);
        if (!capture) return;
        // SAA-169: guests are known names the person checked off, plus
        // anyone typed into the "someone new" field — merged and deduped in
        // identity-answer.js so a known name checked AND (redundantly)
        // retyped still only counts once.
        const names = mergeGuestNames(payload.selectedNames, payload.newNames);
        const selfName = String(payload.self || '').trim() || null;
        // SAA-170: no default here. 'work' used to be assumed whenever
        // nothing else was chosen — but now that an actual signal exists for
        // the common case (the detected app), assuming a value indistinguishable
        // from a deliberate one is worse than leaving scope unset when there
        // truly is no basis for either. identity.html only sends 'work' or
        // 'personal' when a button is actually active (inferred or clicked);
        // anything else means neither was, and null is the honest answer.
        const scope = payload.scope === 'personal' || payload.scope === 'work' ? payload.scope : null;
        // A correction (SAA-258) corrects the answer the server holds, which is
        // not always the one on disk (correctsFor). It doesn't change the name
        // remembered for the next call: it is about this call only.
        const corrects = capture.correcting
            ? correctsFor(readAnswer(OUTDIR, capture.stem), (readUploadEntry(capture.stem) || {}).identityAcceptedAt || null)
            : undefined;
        // A name with an @ is an address (SAA-221): the page blocks Save on one,
        // and it is never remembered as the member's name. buildAnswerDoc drops
        // it from the answer too.
        if (!capture.correcting && selfName && !selfName.includes('@')) writeSelfName(selfName);
        // Names typed for invitees the calendar could not name (SAA-221): their
        // own file, and only for addresses this window's preview offered. A
        // failure loses those names, not the answer; it is logged and the
        // answer is still written.
        const prefill = calendarPreviews.get(capture.token);
        if (prefill && !capture.correcting) {
            const doc = buildInviteeNamesDoc({
                stem: capture.stem,
                recordingId: capture.recordingId,
                pairs: Array.isArray(payload.inviteeNames) ? payload.inviteeNames : [],
                allowed: prefill.unnamed,
            });
            if (doc.invitees.length > 0) {
                try {
                    console.error(logLines.inviteeNamesLine(capture.stem, doc.invitees.length, writeInviteeNames(OUTDIR, doc)));
                } catch (err) {
                    console.error(logLines.inviteeNamesFailedLine(capture.stem, err));
                }
            }
        }
        try {
            writeIdentityAnswer(capture, { names, selfName, scope, corrects });
        } catch (err) {
            // The answer is lost; the capture is not. Say so where it can be
            // read rather than pretending it was written.
            console.error(`identity: could not write the answer for ${capture.stem}: ${String(err)}`);
            notify('identity-not-saved', 'Clipwise: identity not saved',
                `Who was on ${capture.stem} could not be written — the recording is unidentified.`);
            finishIdentityWindow();
            return;
        }
        // The answer goes with the capture; the server applies it (SAA-227).
        uploadAnswer(capture.stem);
        // Answered now, deferred or not (SAA-197) — a marker left from an
        // earlier close no longer describes this capture's state. No-op
        // when there was never one.
        deleteLaterMarker(OUTDIR, capture.stem);
        renderTray();

        if (capture.correcting) {
            // Step 1 only: the server unnames a voice it no longer has a guest
            // for, and Fix names in Recent meetings names voices again.
            console.error(`[clipwise-recorder] identity ${capture.stem}: corrected, sent with the upload queue`);
            finishIdentityWindow();
            return;
        }

        if (names.length === 1) {
            // One-guest rule (SAA-194 §5, SAA-195): the one guest is the other
            // side of the call, so there is no step 2. Diarize can still leave
            // naming data for the call; identity-answer.js namingSettled counts
            // this answer as settling the naming, so neither the tray nor
            // Recent meetings asks for it (SAA-255).
            finishIdentityWindow();
            return;
        }

        // Step 2: the window stays open. identity.html switches itself to
        // the waiting view; this starts polling for the naming data diarize
        // (after transcribe) will eventually produce.
        identityWindow.step = 2;
        identityWindow.win.webContents.send('identity:show-step2', { guestNames: names });
        beginNamingDataWait(capture);
    });

    ipcMain.on('identity:submit-voices', (_event, payload) => {
        const capture = currentCapture(payload && payload.token);
        if (!capture) return;
        const voices = Array.isArray(payload.voices) ? payload.voices : [];
        // An empty list names nothing but still writes voice-names-<stem>.json,
        // which is what takes a call out of the naming reminder. No legitimate
        // path sends one: "Not sure" for every voice is a non-empty list of
        // null names, and Later / the stopped auto-close / the wait cap never
        // submit. Ignored, window left as it is.
        if (voices.length === 0) {
            console.error(
                `[clipwise-recorder] voice-names ${capture.stem}: empty voice list ignored, nothing written`);
            return;
        }
        const doc = buildVoiceNamesDoc({
            stem: capture.stem,
            recordingId: capture.recordingId,
            voices,
            // A new answered_at every save (buildVoiceNamesDoc's default),
            // even on a rename of the same stem — that's what lets
            // voiceNamesAlreadyApplied's guard see this as a new answer to
            // apply rather than the one already on record.
            rename: identityWindow && identityWindow.isRename === true,
        });
        try {
            const finalPath = writeVoiceNamesAnswer(OUTDIR, doc);
            console.error(logLines.voiceNamesLine(capture.stem, doc.voices.length,
                doc.voices.filter((v) => v.name).length, finalPath));
        } catch (err) {
            console.error(`voice-names: could not write the answer for ${capture.stem}: ${String(err)}`);
            notify('voice-names-not-saved', 'Clipwise: voice names not saved',
                `Naming the voices on ${capture.stem} could not be written.`);
            finishIdentityWindow();
            return;
        }
        uploadAnswer(capture.stem);
        finishIdentityWindow();
        // The tray's "Name N voices…" item for this stem should disappear
        // now, not at the next unrelated tray refresh.
        renderTray();
    });

    ipcMain.on('identity:skip', (_event, payload) => {
        const capture = currentCapture(payload && payload.token);
        if (!capture) return;
        if (capture.correcting) {
            // Cancel on a correction: the saved answer stands, nothing is written.
            console.error(`[clipwise-recorder] identity ${capture.stem}: correction cancelled — saved answer kept`);
            finishIdentityWindow();
            return;
        }
        console.error(`[clipwise-recorder] identity ${capture.stem}: skipped — recording is unidentified`);
        // Skip's own meaning is unchanged (SAA-197) — nothing is written
        // here, same as before. This only clears a marker a previous close
        // may have left, so a reopened-then-skipped capture stops showing
        // as pending rather than lingering in the tray forever.
        deleteLaterMarker(OUTDIR, capture.stem);
        renderTray();
        finishIdentityWindow();
    });

    ipcMain.on('identity:later', (_event, payload) => {
        const capture = currentCapture(payload && payload.token);
        if (!capture) return;
        console.error(`[clipwise-recorder] identity ${capture.stem}: voice naming left for later`);
        finishIdentityWindow();
    });
}

// --- first-run setup (SAA-198 step 4) and the recording notice (SAA-216) ------
//
// setup.js and consent.js hold the rules; this is the window, the gate's memory
// and the clipboard. The gate itself is at the top of startRecording.
//
// One window, setup.html. Until setup has been finished once it is "Set up
// Clipwise": the notice, the team's address, sign-in and the two audio
// permissions, opening at the first screen not yet done. After that it only
// ever shows the notice, when the notice is not agreed to (a raised version).

// What a gate last turned away: { trigger, at, reason }, trigger null for a
// manual start, reason 'notice' (the recording notice) or 'permissions' (an
// unanswered audio grant, SAA-124). Kept for a while, not forever: a start
// refused long ago is not something agreeing or answering now should quietly
// carry out. One expiry for both, start-gate.js's.
let blockedStart = null;
const { BLOCKED_START_TTL_MS } = startGate;
// { win, token, mode, noticeOnly, override, busy, waiting, error, asking, address }
//   mode       'launch' or 'blocked' (consent.buttonLabel)
//   noticeOnly setup was finished before this window opened
//   override   a screen asked for by name ("Use a different address")
//   busy       the address is being checked
//   waiting    a sign-in is open in the browser
//   asking     'mic' or 'tap' while macOS's prompt is up
let setupWindow = null;
// How long the team's address has to answer.
const TEAM_ADDRESS_TIMEOUT_MS = 10000;
// How long the system audio prompt is waited on before the probe gives up.
const SYSTEM_AUDIO_PROMPT_WAIT_MS = 120000;

function blockedStartFresh() {
    if (blockedStart && Date.now() - blockedStart.at > BLOCKED_START_TTL_MS) blockedStart = null;
    return blockedStart;
}

// The two grants as audiodevs reports them (granted, denied, notDetermined, …),
// for the setup window and setup.settleSetup. Read at launch, whenever the setup
// window comes to the front and after each request; a failed read keeps the
// last answer.
let lastPermissions = { mic: 'notDetermined', tap: 'notDetermined' };
function readPermissions() {
    try {
        const dev = readDevices();
        lastPermissions = { mic: dev.micPerm, tap: dev.tapPerm };
    } catch (err) {
        console.error(`setup: could not read the permissions: ${String(err)}`);
    }
    return lastPermissions;
}

function setupStatus() {
    const server = readCaptureServerUrl();
    return {
        acknowledged: consent.isAcknowledged(SUPPORT_DIR),
        server,
        signedIn: !!(server && captureTokens && captureTokens.server === server),
        mic: lastPermissions.mic,
        tap: lastPermissions.tap,
    };
}

// Finished once, or all four done now (and then recorded as finished).
function setupCompleted() {
    const before = setup.isSetupCompleted(SUPPORT_DIR);
    const now = setup.settleSetup(SUPPORT_DIR, setupStatus());
    if (!before && now) console.error('[clipwise-recorder] setup: all four done — recorded as finished');
    return now;
}

// mode 'permissions' (SAA-124): a start is waiting on an unanswered audio grant,
// so the full window opens at the permissions screen, even when setup was
// finished before; it is drawn as a 'launch' window from there on.
function showSetupWindow(mode = 'launch') {
    const forPermissions = mode === 'permissions';
    if (forPermissions) mode = 'launch';
    const noticeOnly = setupCompleted() && !forPermissions;
    if (noticeOnly && consent.isAcknowledged(SUPPORT_DIR)) return;
    // The notice alone has no permissions screen: replaced by the full window.
    if (forPermissions && setupWindow && setupWindow.noticeOnly) closeSetupWindow();
    // Already open: bring it forward, and if a start has been blocked since it
    // opened by itself, say so on the notice's button.
    if (setupWindow) {
        if (forPermissions) setupWindow.override = 'permissions';
        if (forPermissions && setup.isSetupCompleted(SUPPORT_DIR)) setupWindow.permissionsOnly = true;
        if (mode === 'blocked') setupWindow.mode = 'blocked';
        sendSetupState();
        try {
            setupWindow.win.show();
            app.focus({ steal: true });
        } catch {}
        return;
    }
    const token = randomUUID();
    let win;
    try {
        win = new BrowserWindow({
            useContentSize: true,
            width: 460,
            // Setup's last screen (Use Clipwise in Claude) is the longest; the
            // notice alone keeps its size.
            height: noticeOnly ? 360 : 520,
            show: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            // The notice alone stays on top, as it always has. Setup does not:
            // the browser's sign-in page and macOS's prompts have to come in front.
            alwaysOnTop: noticeOnly,
            title: noticeOnly ? 'Before you record' : 'Set up Clipwise',
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
    } catch (err) {
        // Nothing records while the gate is shut, so a window that cannot be
        // drawn has to be said out loud rather than leave a button that does nothing.
        console.error(`setup: could not open the window: ${String(err)}`);
        notify('setup-window-failed', 'Clipwise: could not show the setup window',
            'Recording stays off until the recording notice is agreed to. Try the Clipwise menu bar item.');
        return;
    }
    // permissionsOnly: opened for a blocked start after setup was finished, so it
    // ends once both grants are answered (startGate.permissionsWindowNext).
    setupWindow = { win, token, mode, noticeOnly, override: forPermissions ? 'permissions' : null, busy: false, waiting: false, error: '', asking: null, address: undefined, fileVault: null,
        permissionsOnly: forPermissions && setup.isSetupCompleted(SUPPORT_DIR) };
    // Setup only, not the notice alone. A warning, never a step: read in the
    // background and drawn when it answers.
    if (!noticeOnly) {
        const w = setupWindow;
        filevault.readFileVault().then((state) => {
            console.error(`[clipwise-recorder] setup: filevault ${state}`);
            if (setupWindow !== w) return;
            w.fileVault = state;
            sendSetupState();
        });
    }
    console.error(`[clipwise-recorder] setup: window opened (${noticeOnly ? 'notice only' : `setup, at "${setupView().screen}"`}, as "${mode}")`);
    win.once('ready-to-show', () => {
        win.show();
        // An accessory app's window opens behind whatever is in front.
        try { app.focus({ steal: true }); } catch {}
    });
    // Back from System Settings or the browser: what is done may have changed.
    win.on('focus', () => {
        if (!setupWindow || setupWindow.win !== win || setupWindow.noticeOnly) return;
        readPermissions();
        sendSetupState();
        // An answer given in System Settings. Waits while the prompt's child is
        // still running; its exit resumes instead.
        resumePermissionBlockedStart('focus');
    });
    // Closing the window is "Not now": nothing is written, and the gate stays shut
    // if the notice was not agreed to.
    win.once('closed', () => {
        if (setupWindow && setupWindow.win === win) setupWindow = null;
        renderTray();
    });
    win.loadFile(SETUP_HTML, { query: { token } }).catch((err) => {
        console.error(`setup: window failed to load: ${String(err)}`);
        try { win.close(); } catch {}
    });
}

// What the page draws: the screen, and everything on it.
function setupView() {
    const w = setupWindow;
    const status = setupStatus();
    // With the four done, the last screen: Use Clipwise in Claude (SAA-198 step 6).
    const screen = w.noticeOnly
        ? 'notice'
        : (w.override || setup.firstIncompleteScreen(status) || 'claude');
    const host = status.server ? new URL(status.server).host : '';
    return {
        screen,
        stepText: w.noticeOnly ? '' : `Step ${setup.SCREENS.indexOf(screen) + 1} of ${setup.SCREENS.length}`,
        noticeLabel: consent.buttonLabel(w.mode),
        address: w.address !== undefined ? w.address : host,
        host,
        busy: w.busy,
        waiting: w.waiting,
        error: w.error,
        asking: w.asking,
        mic: status.mic,
        tap: status.tap,
        permissionsSettled: setup.permissionSettled(status.mic) && setup.permissionSettled(status.tap),
        claudeAddress: setup.claudeAddress(status.server),
        // Null until fdesetup has answered, and for the notice alone.
        fileVaultWarning: w.noticeOnly || !w.fileVault ? null : filevault.fileVaultWarning(w.fileVault),
    };
}

function sendSetupState() {
    if (!setupWindow) return;
    try { setupWindow.win.webContents.send('setup:state', setupView()); } catch {}
}

function closeSetupWindow() {
    if (!setupWindow) return;
    const { win } = setupWindow;
    setupWindow = null;
    try { win.close(); } catch {}
}

// Screen 2. The address is kept only once it answers as Clipwise
// (setup.isClipwiseDiscovery); what was typed is logged as the origin it became,
// and the reply only as a verdict and a status.
async function checkTeamAddress(input) {
    const w = setupWindow;
    w.error = '';
    w.address = input;
    const parsed = setup.normalizeTeamAddress(input);
    if (!parsed.ok) {
        w.error = parsed.error;
        sendSetupState();
        return;
    }
    w.busy = true;
    sendSetupState();
    let verdict;
    try {
        const res = await fetch(`${parsed.origin}/.well-known/oauth-protected-resource`, {
            signal: AbortSignal.timeout(TEAM_ADDRESS_TIMEOUT_MS),
            redirect: 'error',
        });
        const body = await res.json().catch(() => null);
        verdict = setup.isClipwiseDiscovery(parsed.origin, res.status, body) ? 'clipwise' : `not Clipwise (${res.status})`;
    } catch (err) {
        verdict = `unreachable (${err.cause?.code || err.name})`;
    }
    console.error(`[clipwise-recorder] setup: team address ${parsed.origin}: ${verdict}`);
    if (setupWindow !== w) return;
    w.busy = false;
    if (verdict === 'clipwise') {
        try {
            writeCaptureServer(parsed.origin);
            w.override = null;
            w.address = undefined;
        } catch (err) {
            console.error(`setup: could not save the address: ${String(err)}`);
            w.error = 'Couldn’t save the address. Try again.';
        }
        renderTray();
    } else if (verdict.startsWith('not Clipwise')) {
        w.error = `${parsed.host} answered, but it isn’t a Clipwise server.`;
    } else {
        w.error = `Couldn’t reach ${parsed.host}. Check the address and your connection.`;
    }
    sendSetupState();
}

// capture-server.json, as readCaptureServerUrl reads it. Atomic, like the others.
function writeCaptureServer(origin) {
    fs.mkdirSync(SUPPORT_DIR, { recursive: true });
    const tmp = `${CAPTURE_SERVER_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ url: origin }) + '\n');
    fs.renameSync(tmp, CAPTURE_SERVER_PATH);
}

// Screen 3's answer, from the sign-in's loopback listener or token exchange.
function setupSignInFinished(ok) {
    if (!setupWindow || !setupWindow.waiting) return;
    setupWindow.waiting = false;
    setupWindow.error = ok ? '' : 'Sign-in didn’t finish. Try again.';
    sendSetupState();
    if (ok) {
        try {
            setupWindow.win.show();
            app.focus({ steal: true });
        } catch {}
    }
}

// Screen 4. macOS's own prompt, asked for while the person is on this screen and
// nothing is recording, so the 9 s start timer never races it (SAA-124).
async function requestPermission(which) {
    const w = setupWindow;
    w.error = '';
    w.asking = which;
    sendSetupState();
    console.error(`[clipwise-recorder] setup: asking for ${which === 'mic' ? 'the microphone' : 'system audio'}`);
    try {
        if (which === 'mic') await systemPreferences.askForMediaAccess('microphone');
        else await promptForSystemAudio();
    } catch (err) {
        console.error(`setup: asking for ${which} failed: ${String(err)}`);
    }
    readPermissions();
    console.error(`[clipwise-recorder] setup: permissions now mic=${lastPermissions.mic} tap=${lastPermissions.tap}`);
    resumePermissionBlockedStart('request');
    if (setupWindow !== w) return;
    w.asking = null;
    sendSetupState();
}

// There is no call that asks for system audio: macOS asks when a process of this
// app first opens a tap. So the bundled systemtap runs until the answer is in
// (at most SYSTEM_AUDIO_PROMPT_WAIT_MS), writing to /dev/null, so nothing it
// hears is kept anywhere. The person is on the setup screen, not on a call.
// prompt-child.js runs it and knows until it has exited; no capture starts
// while it runs (SAA-124), and its exit is one of the places a start waiting on
// the grants is resumed from.
const systemAudioPrompt = createPromptChild();
function promptForSystemAudio() {
    return systemAudioPrompt.run(
        SYSTEMTAP_BIN, [], { ...process.env, SYSTEMTAP_OUT: '/dev/null' },
        () => readPermissions().tap !== 'notDetermined',
        {
            pollMs: 1000,
            waitMs: SYSTEM_AUDIO_PROMPT_WAIT_MS,
            graceMs: KILL_GRACE_MS,
            onExit: () => {
                readPermissions();
                resumePermissionBlockedStart('prompt exit');
            },
        },
    );
}

// "Done": setup is recorded as finished, launch at login gets its default, and
// one notification says the app is ready.
function finishSetup() {
    if (setup.firstIncompleteScreen(setupStatus()) !== null) {
        sendSetupState();
        return;
    }
    try {
        setup.recordSetupCompleted(SUPPORT_DIR);
    } catch (err) {
        console.error(`setup: could not record it as finished: ${String(err)}`);
    }
    console.error('[clipwise-recorder] setup: finished');
    closeSetupWindow();
    applyLoginDefault();
    renderTray();
    notify('setup-finished', 'Clipwise is ready', 'Start a recording from the menu bar.');
}

// After "I understand" has been saved. Whether a capture starts is
// consent.shouldStartAfterAcknowledgement's decision; this carries it out.
function resumeBlockedStart(mode) {
    const blocked = blockedStartFresh();
    // A start waiting on the audio grants is resumePermissionBlockedStart's.
    if (blocked && blocked.reason === 'permissions') return;
    blockedStart = null;
    const holds = (key) => detectActive.has(key);
    if (!consent.shouldStartAfterAcknowledgement(mode, blocked, holds)) {
        // The call that asked for a capture is over: the one thing that must
        // not happen is silence about it.
        if (mode === 'blocked' && blocked && blocked.trigger) {
            notify('blocked-start-call-ended', 'Clipwise: nothing to record',
                'The call that tried to start recording has ended.');
        }
        return;
    }
    // Restores what startRecording consumed when it was turned away, so the
    // capture is attributed to its trigger app exactly as it would have been.
    pendingStartTrigger = blocked.trigger || null;
    startRecording();
}

// The setup window opened for a blocked start, once the grants have been read
// again: kept while one is unanswered; then, if setup was finished before it
// opened, closed, and otherwise sent on to setup's next unfinished screen.
function settlePermissionsWindow() {
    const w = setupWindow;
    if (!w || w.override !== 'permissions') return;
    const next = startGate.permissionsWindowNext(w.permissionsOnly, lastPermissions.mic, lastPermissions.tap);
    if (next === 'stay') return;
    console.error(`[clipwise-recorder] setup: permissions answered — window ${next === 'close' ? 'closed (setup was finished)' : 'goes on with setup'}`);
    if (next === 'close') {
        closeSetupWindow();
        renderTray();
        return;
    }
    w.override = null;
    sendSetupState();
}

// A start the permission gate turned away (SAA-124), after the grants were read
// again: from requestPermission, the setup window's focus, or the system audio
// prompt's exit. Whether it starts is startGate.resumeAfterPermissions's
// decision; never while the prompt's child is running.
function resumePermissionBlockedStart(source) {
    settlePermissionsWindow();
    const blocked = blockedStartFresh();
    const decision = startGate.resumeAfterPermissions(blocked, lastPermissions.mic, lastPermissions.tap,
        (key) => detectActive.has(key), { promptRunning: systemAudioPrompt.running() });
    if (decision === 'none') return;
    if (decision === 'wait') {
        if (systemAudioPrompt.running()) console.error(`[clipwise-recorder] permissions: blocked start waits for the prompt's child (${source})`);
        return;
    }
    blockedStart = null;
    console.error(`[clipwise-recorder] permissions: blocked start — ${decision} (${source})`);
    if (decision === 'drop-denied') {
        const denied = deniedServices({ micPerm: lastPermissions.mic, tapPerm: lastPermissions.tap });
        permissionIssue = { denied, blocked: true, note: deniedNote(denied) };
        renderTray();
        notify('permissions-denied-dropped', 'Clipwise: capture not started',
            `${permissionIssue.note}. Open System Settings from the Clipwise menu bar.`);
        return;
    }
    if (decision === 'call-ended') {
        notify('permissions-blocked-call-ended', 'Clipwise: nothing to record',
            'The call that tried to start recording has ended.');
        return;
    }
    // As resumeBlockedStart: the capture is attributed to its trigger app exactly
    // as it would have been, and startRecording reads the grants again.
    pendingStartTrigger = blocked.trigger || null;
    startRecording();
}

function registerSetupIpc() {
    const fromWindow = (payload) => !!setupWindow && !!payload && payload.token === setupWindow.token;
    ipcMain.on('setup:ready', (_event, payload) => {
        if (fromWindow(payload)) sendSetupState();
    });
    ipcMain.on('setup:acknowledge', (_event, payload) => {
        if (!fromWindow(payload)) return;
        try {
            consent.recordAcknowledgement(SUPPORT_DIR);
        } catch (err) {
            // Not saved means not agreed to, as far as the gate is concerned. Say
            // so, and give the person their button back.
            console.error(`consent: could not save the acknowledgement: ${String(err)}`);
            notify('notice-not-saved', 'Clipwise: could not save your answer',
                'Nothing was recorded. Try again.');
            sendSetupState();
            return;
        }
        const mode = setupWindow.mode;
        console.error(`[clipwise-recorder] consent: recording notice agreed to (opened as "${mode}")`);
        if (setupWindow.noticeOnly) closeSetupWindow();
        else {
            setupWindow.mode = 'launch';
            sendSetupState();
        }
        renderTray();
        resumeBlockedStart(mode);
    });
    ipcMain.on('setup:later', (_event, payload) => {
        if (!fromWindow(payload)) return;
        const screen = setupView().screen;
        console.error(screen === 'notice'
            ? '[clipwise-recorder] consent: "Not now" — gate stays shut'
            : `[clipwise-recorder] setup: "Not now" at "${screen}"`);
        closeSetupWindow();
        renderTray();
    });
    ipcMain.on('setup:address', (_event, payload) => {
        if (!fromWindow(payload) || setupWindow.busy) return;
        checkTeamAddress(String(payload.address || ''));
    });
    ipcMain.on('setup:change-address', (_event, payload) => {
        if (!fromWindow(payload)) return;
        Object.assign(setupWindow, { override: 'address', address: undefined, error: '', waiting: false });
        sendSetupState();
    });
    ipcMain.on('setup:signin', (_event, payload) => {
        if (!fromWindow(payload)) return;
        if (!readCaptureServerUrl()) {
            setupWindow.override = 'address';
            sendSetupState();
            return;
        }
        Object.assign(setupWindow, { error: '', waiting: true });
        signInToCaptureServer();
        sendSetupState();
    });
    ipcMain.on('setup:permission-request', (_event, payload) => {
        // Never before the notice is agreed to: the system audio prompt runs a tap.
        if (!fromWindow(payload) || setupWindow.asking || !consent.isAcknowledged(SUPPORT_DIR)) return;
        if (payload.which === 'mic' || payload.which === 'tap') requestPermission(payload.which);
    });
    ipcMain.on('setup:permission-settings', (_event, payload) => {
        if (!fromWindow(payload)) return;
        const pane = SETTINGS_PANE[payload.which === 'mic' ? 'Microphone' : 'System Audio'];
        if (!pane) return;
        console.error(`[clipwise-recorder] setup: opening System Settings for ${payload.which}`);
        shell.openExternal(pane);
    });
    ipcMain.on('setup:filevault-settings', (_event, payload) => {
        if (!fromWindow(payload)) return;
        console.error('[clipwise-recorder] setup: opening System Settings for FileVault');
        shell.openExternal(filevault.SETTINGS_PANE);
    });
    ipcMain.on('setup:done', (_event, payload) => {
        if (fromWindow(payload)) finishSetup();
    });
    // The last screen's Copy: the team's Claude address, to paste into Claude's
    // custom connector. Nothing checks the connection.
    ipcMain.on('setup:copy-claude-address', (_event, payload) => {
        if (!fromWindow(payload)) return;
        const address = setup.claudeAddress(readCaptureServerUrl());
        if (!address) return;
        clipboard.writeText(address);
        console.error('[clipwise-recorder] setup: Claude address copied to the clipboard');
    });
}

// --- launch at login and the move to Applications (SAA-198 step 4) ----------

function openAtLogin() {
    try { return !!app.getLoginItemSettings().openAtLogin; } catch { return false; }
}

// The tray's "Open at login". Once the person has chosen either way, the
// default is never applied over it (login-item.json).
function setOpenAtLogin(on) {
    try {
        app.setLoginItemSettings({ openAtLogin: !!on });
    } catch (err) {
        console.error(`login item: could not change it: ${String(err)}`);
    }
    try { setup.recordLoginDefaultApplied(SUPPORT_DIR); } catch {}
    console.error(`[clipwise-recorder] login item: ${on ? 'on' : 'off'} (tray)`);
    renderTray();
}

// On by default (Jon's call 6): once, the first time this app runs from
// Applications with setup finished (setup.shouldApplyLoginDefault).
function applyLoginDefault() {
    const decision = {
        inApplications: app.isInApplicationsFolder(),
        setupCompleted: setupCompleted(),
        defaultApplied: setup.loginDefaultApplied(SUPPORT_DIR),
    };
    if (!setup.shouldApplyLoginDefault(decision)) return;
    try {
        app.setLoginItemSettings({ openAtLogin: true });
        setup.recordLoginDefaultApplied(SUPPORT_DIR);
        console.error('[clipwise-recorder] login item: on by default (first run from Applications with setup finished)');
    } catch (err) {
        console.error(`login item: could not turn it on: ${String(err)}`);
    }
}

// The copy an install puts in Applications, read only when this app runs from
// somewhere else (offerMoveToApplications). Its path rather than this app's own,
// which outside Applications is by definition another bundle.
const INSTALLED_APP = '/Applications/Clipwise.app';
function readInstalledBuildInfo() {
    const file = path.join(INSTALLED_APP, 'Contents', 'Resources', 'app', 'build-info.json');
    try {
        const info = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.error(`[clipwise-recorder] move: installed app read from ${file} — built ${info.built_at} commit ${info.commit}`);
        return info;
    } catch (err) {
        console.error(`[clipwise-recorder] move: installed app not read from ${file} — ${err.code || err.name}`);
        return null;
    }
}

// Run from anywhere but Applications (straight from the .dmg, or translocated),
// the built app offers to move itself there and relaunch, since launch at login
// needs a path that stays put. Not when the installed copy is this build or a
// newer one (setup.shouldOfferMove): the move would replace it. Resolves true
// when the move has started and this process is about to quit, so nothing else
// should start.
async function offerMoveToApplications() {
    const bundled = !!BUILD_INFO;
    const inApplications = app.isInApplicationsFolder();
    if (!bundled || inApplications) return false;
    const installed = readInstalledBuildInfo();
    if (!setup.shouldOfferMove({ bundled, inApplications, running: BUILD_INFO, installed })) {
        console.error('[clipwise-recorder] move: not offered — the installed app is this build or newer');
        return false;
    }
    console.error(`[clipwise-recorder] move: running from ${app.getPath('exe')}, not Applications — offering to move`);
    try { app.focus({ steal: true }); } catch {}
    const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Move and relaunch', 'Not now'],
        defaultId: 0,
        cancelId: 1,
        message: 'Move Clipwise to Applications?',
        detail: 'Clipwise needs to run from your Applications folder to start when you log in.',
    });
    if (response !== 0) {
        console.error('[clipwise-recorder] move: "Not now"');
        return false;
    }
    try {
        if (app.moveToApplicationsFolder()) {
            console.error('[clipwise-recorder] move: moved to Applications, relaunching');
            return true;
        }
        console.error('[clipwise-recorder] move: not moved');
    } catch (err) {
        console.error(`move: failed: ${String(err)}`);
        notify('move-to-applications-failed', 'Clipwise: could not move to Applications', 'Drag Clipwise into your Applications folder instead.');
    }
    return false;
}

function copyRecordingNotice() {
    clipboard.writeText(consent.NOTICE_LINE);
    console.error('[clipwise-recorder] consent: recording notice copied to the clipboard');
    notify('notice-copied', 'Recording notice copied', 'Paste it into the meeting chat.');
}

// --- lifecycle ------------------------------------------------------------

function startRecording() {
    // Consumed before the guard, not after: a trigger describes the start
    // attempt being made now. Leaving it set when this returns early would
    // label some later manual start with an application that had nothing to
    // do with it.
    const trigger = pendingStartTrigger;
    pendingStartTrigger = null;
    // SAA-170: computed once, here, from whichever app (if any) triggered
    // this specific start — never re-derived later from a stale global, for
    // the same reason `trigger` itself is consumed immediately above.
    const inferredScope = trigger ? scopeForDetectedKey(trigger.key) : null;
    if (state !== 'stopped' || session) return;
    // SAA-216: nothing records until the person has agreed to the recording
    // notice. Every way of starting a capture comes through here, so this is the
    // only place the gate needs to be. What was turned away is remembered so
    // that agreeing can start it (resumeBlockedStart).
    if (!consent.isAcknowledged(SUPPORT_DIR)) {
        blockedStart = { trigger, at: Date.now(), reason: 'notice' };
        console.error(`[clipwise-recorder] consent: start blocked until the recording notice is agreed to `
            + `(${trigger ? `triggered by ${trigger.key}` : 'manual start'})`);
        showSetupWindow('blocked');
        // A capture an app asked for would otherwise just not happen, silently.
        if (trigger) {
            notify('notice-start-blocked', 'Clipwise: agree to the recording notice',
                'Recording starts when you do, if the call is still going.');
        }
        return;
    }
    fs.mkdirSync(OUTDIR, { recursive: true });
    const stamp = utcStamp();
    const startedAt = new Date().toISOString();
    const paths = {
        tap:      path.join(OUTDIR, `system-${stamp}.f32le.pcm`),
        tapLog:   path.join(OUTDIR, `systemtap-${stamp}.log`),
        mic:      path.join(OUTDIR, `mic-${stamp}.wav`),
        micLog:   path.join(OUTDIR, `mic-${stamp}.log`),
        pollLog:  path.join(OUTDIR, `poller-${stamp}.log`),
        manifest: path.join(OUTDIR, `manifest-${stamp}.json`),
    };
    let dev, manifest;
    try {
        dev = readDevices();
    } catch (err) {
        console.error(String(err));
        notify('start-no-devices', 'Clipwise: capture not started',
            'Could not read the audio devices — see the recorder log.');
        return;
    }

    // Any denied grant refuses the capture.
    //
    // The earlier policy started anyway on one denial, reasoning that half a
    // conversation beats none. A denied microphone cannot produce a half:
    // avfoundation refuses the device outright — "Failed to create AV capture
    // input device" — so no mic file is ever created, the start gate never
    // sees both tracks grow, and the capture is torn down at the timeout
    // having discarded the real system audio it did capture. Measured: 8.9s,
    // 99.3% nonzero, thrown away while the tray said the capture never
    // started. Making that half reachable means changing the start gate, the
    // timeout, the child-death teardown and the transcribe step, for a
    // one-sided track of low standalone value.
    //
    // Start is always a manual click, so someone is present to act: one toggle
    // buys a whole recording rather than half of one. This is only about
    // START — a track dying mid-capture is a different case, and the
    // classifier's keep-with-flag path still exists for it.
    //
    // startGate.permissionGate decides (SAA-124): refuse on a denial, as above;
    // wait for a grant nobody has answered; and start without the gate when the
    // system audio grant cannot be read at all.
    const gate = startGate.permissionGate(dev.micPerm, dev.tapPerm);
    if (gate === 'refuse') {
        const denied = deniedServices(dev);
        permissionIssue = { denied, blocked: true, note: deniedNote(denied) };
        renderTray();
        console.error(`start refused: denied permissions: ${denied.join(', ')}`);
        notify('start-permission-denied', 'Clipwise: capture not started', permissionIssue.note);
        return;
    }
    // Unanswered: nothing is started, so the 9 s start timeout cannot run while
    // macOS's prompt is up. Setup opens at the permissions screen, and answering
    // there starts this capture (resumePermissionBlockedStart).
    if (gate === 'block') {
        blockedStart = { trigger, at: Date.now(), reason: 'permissions' };
        console.error(`[clipwise-recorder] start blocked until the audio permissions are answered `
            + `(mic_perm=${dev.micPerm} tap_perm=${dev.tapPerm}, ${trigger ? `triggered by ${trigger.key}` : 'manual start'})`);
        showSetupWindow('permissions');
        // A capture an app asked for would otherwise just not happen, silently.
        if (trigger) {
            notify('permissions-start-blocked', 'Clipwise: allow audio access',
                'Recording starts when you answer, if the call is still going.');
        }
        return;
    }
    // A private API that vanished must never stop every capture: today's path,
    // with the start timeout's blocked-in-setup detection, and a line saying so.
    if (gate === 'fallback') {
        console.error(`start: system audio permission unreadable (tap_perm=${dev.tapPerm}) — starting without the permission gate`);
    }
    permissionIssue = null;

    try {
        manifest = buildManifest(stamp, startedAt, dev, paths, trigger);
        // Written before the children spawn, so no audio file can exist
        // without one. OUTDIR was just created, so a failure here means the
        // directory is unwritable and the capture would have been lost
        // anyway — refusing is honest, and leaves nothing half-formed.
        fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + '\n');
    } catch (err) {
        console.error(String(err));
        notify('start-no-manifest', 'Clipwise: capture not started',
            'Could not write the capture manifest — see the recorder log.');
        return;
    }
    const tapProc = spawnChild(
        SYSTEMTAP_BIN, [],
        { ...process.env, SYSTEMTAP_OUT: paths.tap },
        paths.tapLog,
    );
    // miccap, not ffmpeg (SAA-106). ffmpeg's avfoundation input delivered a
    // rate-independent ~42,000 samples/s ceiling, losing 10.7–12.0% of every
    // built-in-mic capture and silently compressing the mic timeline against
    // the tap. miccap reads the default input device off the Core Audio HAL
    // directly — same API family as systemtap — and measured +0.029% over 60 s
    // against ffmpeg's +11.72% on the same test.
    //
    // It takes the device from kAudioHardwarePropertyDefaultInputDevice itself
    // rather than being handed a name, so dev.inName is no longer passed. The
    // two can only disagree if the default input changes between readDevices()
    // and the spawn, which the poller already watches for.
    const micProc = spawnChild(
        MICCAP_BIN, [paths.mic],
        process.env,
        paths.micLog,
    );
    const pollProc = spawnChild(
        AUDIODEVS_BIN, ['--poll'],
        process.env,
        paths.pollLog,
    );
    session = {
        tap: tapProc, mic: micProc, poller: pollProc,
        paths,
        stem: stamp,
        recordingId: manifest.recording_id,
        // Which application's microphone use started this, or null when a
        // person did. Read by the 'recording started' notification (.name)
        // and, at stop, carried onto the identity prompt (SAA-170).
        trigger,
        inferredScope,
        // Wall clock at spawn, for the elapsed figure the stop notification
        // reports. Separate from the manifest's started_at, which is an ISO
        // string for consumers downstream.
        startedAtMs: Date.now(),
        perms: { mic: dev.micPerm, tap: dev.tapPerm },
        // Set once both tracks have produced bytes. A capture that never got
        // there has nothing worth transcribing, so it does not trigger the
        // pipeline — see stopRecording.
        reachedRecording: false,
        growth: { tap: { size: 0, ts: 0 }, mic: { size: 0, ts: 0 } },
        timers: {},
    };
    // Per-capture would-stop tracker and its autostop-<stem>.log (SAA-184).
    // Logging only.
    session.autostop = autostopBegin(stamp, trigger);
    session.silence = silenceBegin(session);
    // Only capture-child exits drive state. Poller death is not fatal.
    tapProc.once('exit', () => onCaptureChildExit('tap'));
    micProc.once('exit', () => onCaptureChildExit('mic'));
    session.timers.starting = setTimeout(onStartingTimeout, STARTING_TIMEOUT_MS);
    session.timers.poll = setInterval(pollTick, POLL_INTERVAL_MS);
    setState('starting');
}

function onCaptureChildExit(which) {
    if (state === 'stopped' || teardownInFlight) return;
    // Record the unexpected exit in the child's own log — otherwise the
    // teardown that follows leaves no trace of who died.
    if (session) {
        const proc    = which === 'tap' ? session.tap    : session.mic;
        const logPath = which === 'tap' ? session.paths.tapLog : session.paths.micLog;
        const line = `[clipwise-recorder] ${new Date().toISOString()} ` +
                     `recording_id=${session.recordingId} ` +
                     `child=${which} exited unexpectedly ` +
                     `code=${proc.exitCode} signal=${proc.signalCode}\n`;
        try { fs.appendFileSync(logPath, line); } catch {}
    }
    stopRecording('child_exit');
}

// A capture that never produced a byte on both tracks. SAA-90 already catches
// and tears this down; all that is added here is saying why it probably
// happened. A tap blocked inside Core Audio setup waiting on an unanswered
// prompt looks exactly like this, and the permission state read at start is
// the evidence that distinguishes it from a plain failure to start.
function onStartingTimeout() {
    if (state !== 'starting') return;
    const perms = session ? session.perms : null;
    const pending = perms
        ? ['mic', 'tap'].filter(k => perms[k] === 'notDetermined')
        : [];
    const why = pending.length
        ? `a permission prompt may be waiting (${pending.map(k => `${k}_perm=notDetermined`).join(' ')})`
        : 'no bytes on either track before the deadline';
    if (session) {
        const line = `[clipwise-recorder] ${new Date().toISOString()} ` +
                     `capture never started — ${why}\n`;
        try { fs.appendFileSync(session.paths.tapLog, line); } catch {}
    }
    if (pending.length) {
        permissionIssue = {
            denied: [],
            blocked: false,
            note: 'Capture never started — a permission prompt may be waiting',
        };
    }
    stopRecording('start_timeout');
}

function pollTick() {
    if (!session) return;
    const now = Date.now();
    const s = session;
    const tapSize = fileSize(s.paths.tap);
    const micSize = fileSize(s.paths.mic);
    if (tapSize > s.growth.tap.size) s.growth.tap = { size: tapSize, ts: now };
    if (micSize > s.growth.mic.size) s.growth.mic = { size: micSize, ts: now };

    if (state === 'starting') {
        if (s.growth.tap.size > 0 && s.growth.mic.size > 0) {
            clearTimeout(s.timers.starting);
            s.reachedRecording = true;
            setState('recording');
        }
    } else if (state === 'recording' || state === 'stalled') {
        const tapStale = (now - s.growth.tap.ts) > TAP_STALE_MS;
        const micStale = (now - s.growth.mic.ts) > MIC_STALE_MS;
        const isStalled = tapStale || micStale;
        if (state === 'recording' && isStalled)      setState('stalled');
        else if (state === 'stalled' && !isStalled)  setState('recording');
        // Only while both tracks are writing: a stalled capture has its own
        // notification, and its audio time is not trustworthy.
        if (state === 'recording') silenceTick(s, tapSize);
    }
}

function teardown(cb) {
    if (!session) { if (cb) cb(); return; }
    teardownInFlight = true;
    const s = session;
    session = null;
    if (s.timers.poll) clearInterval(s.timers.poll);
    if (s.timers.starting) clearTimeout(s.timers.starting);
    const kids = [s.tap, s.mic, s.poller].filter(Boolean);
    for (const k of kids) {
        try { k.kill('SIGINT'); } catch {}
    }
    setTimeout(() => {
        for (const k of kids) {
            if (k.exitCode === null && k.signalCode === null) {
                try { k.kill('SIGKILL'); } catch {}
            }
        }
        // After the children are gone and before the callback, which is what
        // starts the pipeline — the pipeline keys off the manifest, so the
        // manifest has to be true by the time it reads it.
        finalizeMicFormat(s.paths);
        finalizeTapFormat(s.paths);
        teardownInFlight = false;
        if (cb) cb();
    }, KILL_GRACE_MS);
}

// `cause` is what stopped it, recorded on the capture's autostop block:
// 'manual' (the tray), 'auto' (the trigger app released the mic and stayed
// gone, SAA-184), 'silence-reminder' (Stop on the "Still recording?"
// notification), 'child_exit', 'start_timeout'.
function stopRecording(cause) {
    if (state === 'stopped') return;
    const stopCause = typeof cause === 'string' ? cause : 'manual';
    // Read by notifyStateChange, which runs inside setState('stopped') below.
    if (session) session.stopCause = stopCause;
    autostopFinish(session, stopCause);
    // Tray flips to Stopped up to KILL_GRACE_MS before children actually
    // exit. Accepted: Stop is user-initiated and nobody is watching the
    // gap. Record the gap here so it isn't rediscovered as a bug later.
    const capture = session && session.reachedRecording
        ? {
            stem: session.stem,
            recordingId: session.recordingId,
            inferredScope: session.inferredScope,
            // True only for an auto-stop: the identity window then opens
            // without taking focus or sitting on top (see pumpIdentityQueue).
            auto: stopCause === 'auto',
            // SAA-187: computed here, where startedAtMs already lives for the
            // stop notification, and carried through to the identity prompt
            // rather than having the page re-derive it — the page has no
            // access to session state and answering late must not change
            // what a capture's own duration was.
            durationMs: session.startedAtMs ? Date.now() - session.startedAtMs : null,
          }
        : null;
    const stem = capture ? capture.stem : null;
    setState('stopped');
    // The pipeline starts from teardown's completion callback, never from
    // this click. miccap patches the WAV header when it handles SIGINT, so a
    // transcribe kicked off before it exits reads a file whose RIFF and data
    // sizes are still zero — and teardown is also where the manifest gets its
    // mic format, which the pipeline reads.
    //
    // The identity prompt goes last, after the audio is finalised and the
    // pipeline is already running. Everything a capture needs has happened by
    // the time the question is asked, which is what makes the answer optional.
    teardown(() => {
        startPipeline(stem);
        promptForIdentity(capture);
    });
}

// The application menu, which shows while one of Clipwise's windows is in front.
// Electron's default has Quit (Cmd+Q) as role 'quit', which calls app.quit() and
// skips both the question and quitApp: on 2026-10-28 Cmd+Q from Recent meetings
// quit with no dialog and no quit: line. This is that default with Quit sent
// through confirmQuit. Edit stays, for paste into setup's team address.
function installAppMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: app.name, submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
            { type: 'separator' },
            { label: 'Quit Clipwise…', accelerator: 'Command+Q', click: confirmQuit },
        ] },
        { role: 'fileMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
    ]));
}

// The tray's Quit… and Cmd+Q (installAppMenu) ask first: a quit stops all
// recording until Clipwise is opened again, and nothing else says so. While a
// capture is starting or running the message says so. Only those two come
// through here; a logout or restart still quits through Electron's own quit
// events and never comes through here, though macOS refuses that quit while
// this dialog is open (errn -128, live check 2026-10-28).
//
// The tray's Restart to update comes through here too while a capture is on
// (restartToUpdate, SAA-253), with opts.install: the same question, worded as a
// restart, and a yes installs the downloaded update as the app quits. A menu
// click passes its menu item as opts, which has no install.
let quitConfirmOpen = false;
async function confirmQuit(opts = {}) {
    if (quitConfirmOpen) return;
    quitConfirmOpen = true;
    const install = !!opts.install && !!updateReady;
    // starting: the capture children are up but no track has written yet, so a
    // quit now hands nothing to the pipeline (quitApp passes it no stem).
    const phase = state === 'stopped' ? 'stopped' : state === 'starting' ? 'starting' : 'capture';
    const quitTexts = {
        stopped:  { message: "Clipwise won't record meetings until you open it again", detail: '' },
        starting: { message: 'Clipwise is about to record this call',
                    detail: "Quitting now stops it before anything is recorded, so nothing from this call is processed. Clipwise won't record meetings until you open it again." },
        capture:  { message: 'Clipwise is recording this call',
                    detail: "Quitting stops the recording now. What's been recorded so far is still processed. Clipwise won't record meetings until you open it again." },
    };
    const restartTexts = {
        stopped:  { message: 'Clipwise restarts to update', detail: 'Clipwise opens again once it has updated.' },
        starting: { message: 'Clipwise is about to record this call',
                    detail: 'Restarting now stops it before anything is recorded, so nothing from this call is processed. Clipwise opens again once it has updated.' },
        capture:  { message: 'Clipwise is recording this call',
                    detail: "Restarting stops the recording now. What's been recorded so far is still processed. Clipwise opens again once it has updated." },
    };
    const text = (install ? restartTexts : quitTexts)[phase];
    try { app.focus({ steal: true }); } catch {}
    let response;
    try {
        ({ response } = await dialog.showMessageBox({
            type: 'warning', buttons: [install ? 'Restart' : 'Quit', 'Cancel'], defaultId: 1, cancelId: 1,
            message: text.message, detail: text.detail,
        }));
    } finally {
        // A failed dialog must not leave Quit… doing nothing until a relaunch.
        quitConfirmOpen = false;
    }
    const during = { stopped: '', starting: ' (while starting)', capture: ' (during a capture)' }[phase];
    console.error(`[clipwise-recorder] quit: ${response === 0 ? 'confirmed' : 'cancelled'}${during}${install ? ' to update' : ''}`);
    if (response === 0) quitApp({ install });
}

// opts.install (SAA-253): install the downloaded update as the app quits, and
// relaunch on it. Only from a Restart answered yes, or from applyUpdateNow once
// the idle gate has passed. Any other quit exits; Squirrel still installs a
// downloaded update on that exit, without relaunching.
function quitApp(opts = {}) {
    // A capture that already happened should still become moments, so quitting
    // mid-recording hands off rather than discards. The child is detached, so
    // it outlives this process.
    //
    // No identity prompt on this path: the window would be destroyed with the
    // process before anyone could type into it, and holding the quit open
    // until it was answered would make the prompt something a person has to
    // get past. That capture is unidentified — the same outcome as dismissing
    // the prompt, and correctable the same way.
    isQuitting = true;
    autostopFinish(session, 'quit');
    stopDetector();
    const stem = session && session.reachedRecording ? session.stem : null;
    if (state !== 'stopped') setState('stopped');
    teardown(() => {
        startPipeline(stem);
        // After the handoff, so a capture stopped by Restart is still handed
        // on. The pipeline is detached and runs from this bundle, which the
        // install replaces under it; whether it or the relaunch's recovery
        // finishes the capture is what the Restart-mid-capture run reads.
        if (opts.install && updateReady) {
            updateLog(`installing ${updateReady} and relaunching`);
            try {
                autoUpdater.quitAndInstall();
                return;
            } catch (err) {
                updateLog(`install failed — ${err.message}; quitting instead`);
            }
        }
        app.exit(0);
    });
}

// --- launch sweep (SAA-152) -------------------------------------------------
//
// Parent-death detection in systemtap/miccap/micwatch/audiodevs only protects
// a stray created after that fix ships. Anything orphaned earlier — or by a
// binary built before the fix — is still sitting on disk at the next launch,
// so this finds and ends those too. audiodevs was not one of the three named
// when this issue was written — the three were only the ones observed, and
// the scope is "ending the recorder ends its children," which audiodevs is
// one of (spawned as the --poll stall detector alongside tap/mic — see
// startRecording) and orphans exactly the same way, confirmed 2026-09-24.
//
// Two paths per binary, dev checkout and packaged bundle, because a stray can
// predate a layout switch as easily as a rebuild — RECORDER_DIR/BUNDLED_BIN
// are both already computed above regardless of which layout this instance
// is running under.
//
// PPID 1 is the whole safety property: a child of a currently running
// recorder has that recorder's own live pid as its parent, never 1, so this
// can never reach into a running instance's own children. It runs before
// anything below spawns its own children, so there is no race with those
// either.
const STRAY_BIN_PATHS = new Set([
    path.join(RECORDER_DIR, 'systemtap', '.build', 'release', 'systemtap'),
    path.join(BUNDLED_BIN, 'systemtap'),
    path.join(RECORDER_DIR, 'miccap', '.build', 'release', 'miccap'),
    path.join(BUNDLED_BIN, 'miccap'),
    path.join(RECORDER_DIR, 'micwatch'),
    path.join(BUNDLED_BIN, 'micwatch'),
    path.join(RECORDER_DIR, 'audiodevs'),
    path.join(BUNDLED_BIN, 'audiodevs'),
]);

function sweepStrayChildren() {
    let out;
    try {
        out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' });
    } catch (err) {
        console.error(`launch sweep: ps failed: ${String(err)}`);
        return;
    }
    for (const line of out.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        if (ppid !== 1) continue;
        const exe = m[3].split(' ')[0];
        if (!STRAY_BIN_PATHS.has(exe)) continue;
        console.error(`launch sweep: killing stray pid=${pid} ppid=${ppid} exe=${exe}`);
        try { process.kill(pid, 'SIGKILL'); } catch (err) {
            console.error(`launch sweep: kill ${pid} failed: ${String(err)}`);
        }
    }
}

// --- auto-update (SAA-253) ------------------------------------------------
//
// Squirrel.Mac, through Electron's autoUpdater, against update.electronjs.org,
// which serves the newest GitHub Release of looprite/clipwise whose zip is
// newer than this build's version. Only a built app in Applications that this
// account can replace asks (setup.updateBlocker); anything else logs why not.
//
// Checks run only while idle (update-gate.js), every 4 hours, and a check
// that comes due while busy waits for the minute tick to find it idle. Once a
// download has landed it is applied at the first idle moment: when the
// download lands, after each upload drain, and on the minute tick. The tray
// then offers Restart to update; during a capture that asks first, and
// otherwise it is one more try through the same gate.
const UPDATE_FEED_BASE = 'https://update.electronjs.org/looprite/clipwise/darwin-arm64';
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const UPDATE_TICK_MS = 60 * 1000;

// The downloaded release's name, once Squirrel has it staged; null before.
let updateReady = null;
let updateChecking = false;
let updateCheckDue = false;
let updateLastCheckAt = 0;
// The last deferral logged, so a busy minute tick logs a reason once.
let updateDeferredReason = null;

function updateLog(msg) { console.error(`[clipwise-recorder] update: ${msg}`); }

function folderWritable(dir) {
    try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

// EPERM is a process that exists under another user: alive.
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

// Every pipeline record in OUTDIR, doc null when it can't be read or parsed.
function readPipelineRecords() {
    let names;
    try { names = fs.readdirSync(OUTDIR); } catch { return []; }
    const out = [];
    for (const name of names) {
        const m = name.match(/^pipeline-(.+)\.json$/);
        if (!m) continue;
        let doc = null;
        try { doc = JSON.parse(fs.readFileSync(path.join(OUTDIR, name), 'utf8')); } catch {}
        out.push({ stem: m[1], doc });
    }
    return out;
}

// Gathered and decided in one synchronous tick, so nothing can start between
// the answer and what is done with it. A ps that fails passes null: busy.
function updateIdle() {
    let psOut = null;
    try { psOut = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' }); } catch {}
    return updateGate.idleState({
        state, session, teardownInFlight,
        anyWindowOpen: BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible()),
        pipelineRunning: !!(pipeline && pipeline.state === 'running'),
        recoveryRunning: !!recoveryProc,
        pipelineRecords: readPipelineRecords(),
        isAlive,
        psOut,
        entries: [CAPTURE_PIPELINE_ENTRY, CAPTURE_RECOVER_ENTRY],
        uploadDraining: !!uploadDraining,
    });
}

function requestUpdateCheck(reason) {
    if (updateReady || updateChecking) return;
    const g = updateIdle();
    if (!g.idle) {
        if (!updateCheckDue) updateLog(`check deferred (${reason}) — ${g.reason}`);
        updateCheckDue = true;
        return;
    }
    updateCheckDue = false;
    updateChecking = true;
    updateLastCheckAt = Date.now();
    try {
        autoUpdater.checkForUpdates();
    } catch (err) {
        updateChecking = false;
        updateLog(`check failed — ${err.message}`);
    }
}

function maybeApplyUpdate(trigger) {
    if (!updateReady || isQuitting) return;
    const g = updateIdle();
    if (!g.idle) {
        if (g.reason !== updateDeferredReason || trigger === 'tray') updateLog(`apply deferred (${trigger}) — ${g.reason}`);
        updateDeferredReason = g.reason;
        return;
    }
    updateLog(`idle (${trigger}), applying ${updateReady}`);
    applyUpdateNow();
}

// The one place an update is applied, and only maybeApplyUpdate calls it.
function applyUpdateNow() {
    quitApp({ install: true });
}

function updateTick() {
    if (updateReady) { maybeApplyUpdate('minute tick'); return; }
    if (updateCheckDue) requestUpdateCheck('due');
    else if (Date.now() - updateLastCheckAt >= UPDATE_CHECK_INTERVAL_MS) requestUpdateCheck('every 4 hours');
}

// The tray's Restart to update. During a capture it asks, as Quit… does;
// otherwise it waits for idle like any other try, and the log says what for.
function restartToUpdate() {
    if (state !== 'stopped' || session) { confirmQuit({ install: true }); return; }
    maybeApplyUpdate('tray');
}

function startUpdates(parentWritable) {
    if (!BUILD_INFO) { updateLog('not checked — not a built app'); return; }
    const blocker = setup.updateBlocker({
        bundled: true, inApplications: app.isInApplicationsFolder(),
        appPath: APP_BUNDLE_PATH, parentWritable,
    });
    if (blocker) { updateLog(`not checked — ${blocker}: ${APP_BUNDLE_PATH}`); return; }
    const url = `${UPDATE_FEED_BASE}/${app.getVersion()}`;
    autoUpdater.on('checking-for-update', () => updateLog(`checking ${url}`));
    autoUpdater.on('update-available', () => updateLog('newer version found, downloading'));
    autoUpdater.on('update-not-available', () => { updateChecking = false; updateLog(`up to date at ${app.getVersion()}`); });
    autoUpdater.on('update-downloaded', (_event, _notes, releaseName) => { updateLog(`downloaded ${releaseName}`);
        updateChecking = false;
        updateReady = releaseName || 'a new version';
        renderTray();
        maybeApplyUpdate('update-downloaded');
    });
    autoUpdater.on('error', (err) => { updateChecking = false; updateLog(`error — ${err.message}`); });
    autoUpdater.on('before-quit-for-update', () => updateLog('quitting to install'));
    try {
        autoUpdater.setFeedURL({ url });
    } catch (err) {
        updateLog(`not checked — feed refused: ${err.message}`);
        return;
    }
    requestUpdateCheck('launch');
    setInterval(updateTick, UPDATE_TICK_MS);
}

// --- app boot -------------------------------------------------------------

// The standard macOS About window, opened by the tray's "About Clipwise"
// item. Third-party model credits (SAA-194 §7) moved out of here and into
// their own "Acknowledgements…" item below, which opens the bundled
// THIRD_PARTY_NOTICES file directly — full attribution text belongs in that
// file, not crammed into the About panel's one-line description.
// The bundle's build number: CFBundleVersion in its Info.plist (build-app.sh),
// which is XML as Electron ships it and PlistBuddy keeps it. Null from a
// checkout, or when it cannot be read; About then shows the version alone.
const BUNDLE_VERSION = (() => {
    if (!BUILD_INFO) return null;
    try {
        const plist = fs.readFileSync(path.join(RESOURCES_DIR, '..', 'Info.plist'), 'utf8');
        const m = plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
})();
app.setAboutPanelOptions({
    applicationName: 'Clipwise',
    applicationVersion: app.getVersion(),
    ...(BUNDLE_VERSION ? { version: BUNDLE_VERSION } : {}),
    credits: 'Meeting recordings captured on your Mac, intelligence surfaced through Claude.',
});

const DAY_LOG_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// day-logs.js does the pruning. Nothing it does may stop the app or the timer,
// so any failure is logged by its code and the next run tries again. No
// recordings folder yet means no day logs.
function pruneDayLogsNow() {
    try {
        if (!fs.existsSync(OUTDIR)) return;
        const { removed, failed } = pruneDayLogs(OUTDIR);
        if (removed > 0) console.error(`[clipwise-recorder] day logs: pruned ${removed}`);
        for (const code of failed) console.error(`[clipwise-recorder] day logs: prune failed — ${code}`);
    } catch (err) {
        console.error(`[clipwise-recorder] day logs: prune failed — ${err.code || err.name}`);
    }
}

app.whenReady().then(async () => {
    // A second launch has already quit (the single-instance lock, above).
    if (!GOT_SINGLE_INSTANCE_LOCK) return;
    // Menu bar only, no Dock icon (Jon's call 6). LSUIElement in build-app.sh
    // keeps a launch from showing one at all; this is the runtime half, and the
    // two only mean something together (SAA-105).
    if (app.dock) app.dock.hide();
    installAppMenu();
    // First, before the tray or any child exists: a move relaunches the app from
    // Applications, and this process quits.
    if (await offerMoveToApplications()) return;
    // Outside Applications, a copy still records (a stale build beats none) and
    // says where it runs from: a line in the tray, and once in a notification.
    // So does one in Applications that this account can't replace, since it
    // can't update itself (SAA-253). Read once; the updater gets the same answer.
    const parentWritable = folderWritable(path.dirname(APP_BUNDLE_PATH));
    locationNote = setup.locationWarning({
        bundled: !!BUILD_INFO, inApplications: app.isInApplicationsFolder(),
        appPath: APP_BUNDLE_PATH, home: os.homedir(), parentWritable,
    });
    if (locationNote) notify('not-in-applications', locationNote.title, locationNote.body);
    tray = new Tray(iconFor('stopped'));
    {
        const server = readCaptureServerUrl();
        console.error(`[clipwise-recorder] capture server: ${server || 'none (no usable capture-server.json; captures stay on this Mac)'}`);
    }
    // Before the first render, so the tray knows whether to offer sign-in, and
    // whether setup is done (setupCompleted needs the token and the grants).
    loadCaptureTokens();
    // On wake from sleep, with capture tokens held, the refresh is logged and
    // rescheduled from the clock: one that came due during sleep runs at once.
    powerMonitor.on('resume', () => {
        if (!captureTokens) return;
        console.error(`[clipwise-recorder] capture token: resumed from sleep, refresh in ${captureRefreshDelay()} ms`);
        scheduleCaptureRefresh();
    });
    // And every sent capture not known to be finished, stale ones included, is
    // asked about again (SAA-183).
    powerMonitor.on('resume', () => askJobsAgain('resume'));
    readPermissions();
    setState('stopped');
    // Whatever was queued before this launch, including a capture whose app quit
    // right after Stop.
    drainUploadQueue('launch');
    askJobsAgain('launch');
    // At launch and then once a day: an app left running for weeks prunes too.
    pruneDayLogsNow();
    setInterval(pruneDayLogsNow, DAY_LOG_PRUNE_INTERVAL_MS);
    registerIdentityIpc();
    registerMeetingsIpc();
    registerVoicePrintsIpc();
    registerSetupIpc();
    // Before any call can start a capture, so that a new person has read the
    // notice by the time their first one is turned away (SAA-216). Opens setup
    // if it was never finished, the notice alone if setup was finished and the
    // notice is not agreed to, and nothing otherwise.
    showSetupWindow('launch');
    // At launch as well as from Done, so an install that finished setup before
    // it was in Applications gets the default the first time it runs there.
    applyLoginDefault();
    // Before anything spawns its own children (SAA-152) — see
    // sweepStrayChildren's comment for why that ordering matters.
    sweepStrayChildren();
    // Last, and after the tray exists: a launch that has to recover a backlog
    // should still show a working menu bar immediately. Spawning is cheap —
    // the pass itself runs in another process — but ordering it here means a
    // throw from it can never cost the user their tray icon.
    // A fresh install has no recordings directory yet, and the recovery log
    // lives in it: without this the pass was skipped with an ENOENT line (seen
    // 2026-10-07 on a fresh CLIPWISE_SUPPORT_DIR). A packaged app only escaped
    // by accident, because its log file writer creates the directory first.
    try { fs.mkdirSync(OUTDIR, { recursive: true }); } catch (err) {
        console.error(`launch: could not create ${OUTDIR}: ${String(err)}`);
    }
    startRecovery('app launch');
    // After the tray, for the same reason: call detection must never be able
    // to cost someone their menu bar icon. A missing or crashing micwatch
    // disables detection and changes nothing else.
    startDetector();
    // Last of all: its idle gate reads the capture state, the pipeline,
    // recovery and the upload drain, all set up above (SAA-253).
    startUpdates(parentWritable);
});

// A second launch was turned away by the lock: an unfinished setup is the one
// thing it could have been for, so the window comes forward.
app.on('second-instance', () => {
    console.error('[clipwise-recorder] a second launch was turned away');
    if (tray && !setupCompleted()) showSetupWindow('launch');
});

app.on('will-quit', () => { isQuitting = true; stopDetector(); });

app.on('window-all-closed', (e) => { e.preventDefault?.(); });
