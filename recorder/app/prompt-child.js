// The process that brings up macOS's system audio prompt (SAA-124). There is no
// call that asks for system audio: macOS asks when a process of this app first
// opens a tap, so a tap runs until the answer is in. While it runs, no capture
// may start beside it, so whether it is running is tracked until it has exited,
// not until it has been signalled.

const { spawn: realSpawn } = require('child_process');

// spawn and log are replaceable for the check.
function createPromptChild({ spawn = realSpawn, log = (line) => console.error(line) } = {}) {
    let child = null;

    // From spawn until the child has exited (or is treated as gone).
    function running() {
        return child !== null;
    }

    // Runs cmd until isAnswered() says so, the child exits, or waitMs passes,
    // polling every pollMs. Then SIGINT, then SIGKILL graceMs later if it is
    // still there. Resolves once it has exited; if no exit comes within
    // 2 × graceMs of the SIGKILL, it is treated as gone. onExit runs once, after
    // running() has gone false. Never rejects.
    function run(cmd, args, env, isAnswered, { pollMs, waitMs, graceMs, onExit } = {}) {
        return new Promise((resolve) => {
            let c;
            try {
                c = spawn(cmd, args, { env, stdio: 'ignore' });
            } catch (err) {
                log(`prompt child: could not run it: ${err.code || err.name}`);
                resolve();
                return;
            }
            child = c;
            let gone = false;
            let poll = null;
            let killTimer = null;
            let capTimer = null;
            const finish = (why) => {
                if (gone) return;
                gone = true;
                clearInterval(poll);
                clearTimeout(killTimer);
                clearTimeout(capTimer);
                if (child === c) child = null;
                if (why) log(`prompt child: ${why}`);
                if (typeof onExit === 'function') {
                    try { onExit(); } catch (err) { log(`prompt child: onExit threw ${err.name}`); }
                }
                resolve();
            };
            c.once('exit', () => finish());
            c.once('error', (err) => {
                log(`prompt child: ${err.code || err.name}`);
                finish();
            });
            const started = Date.now();
            poll = setInterval(() => {
                if (gone) return;
                let answered = false;
                try { answered = !!isAnswered(); } catch {}
                if (!answered && Date.now() - started < waitMs) return;
                clearInterval(poll);
                try { c.kill('SIGINT'); } catch {}
                killTimer = setTimeout(() => {
                    if (gone) return;
                    try { c.kill('SIGKILL'); } catch {}
                    capTimer = setTimeout(() => finish('no exit after SIGKILL, treated as gone'), graceMs * 2);
                }, graceMs);
            }, pollMs);
        });
    }

    return { running, run };
}

module.exports = { createPromptChild };
