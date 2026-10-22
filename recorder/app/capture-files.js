// Every file a capture leaves on this Mac, for a delete from the trash (SAA-243
// item 7). main.js runs this once the server has deleted the capture.

const fs = require('fs');
const path = require('path');

// Every file of the capture in `outdir` (trash-marker.ts captureFiles: "-<stem>"
// followed by ".", "-" or the end of the name), the manifest after the rest and
// its upload-queue entry in `queueDir`, and the marker last. Returns how many
// went from `outdir`, the marker not counted.
function removeCaptureFiles(outdir, queueDir, stem) {
    const needle = `-${stem}`;
    const manifest = `manifest-${stem}.json`;
    const marker = `trashed-${stem}.json`;
    const files = fs.readdirSync(outdir).filter((name) => {
        const i = name.indexOf(needle);
        if (i < 0) return false;
        const next = name[i + needle.length];
        return next === '.' || next === '-' || next === undefined;
    });
    let removed = 0;
    for (const name of files) {
        if (name === manifest || name === marker) continue;
        fs.rmSync(path.join(outdir, name), { force: true });
        removed++;
    }
    if (files.includes(manifest)) {
        fs.rmSync(path.join(outdir, manifest), { force: true });
        removed++;
    }
    // The queue entry names the capture and its server state; with the capture
    // gone it could only be retried and refused forever. Before the marker, so
    // a delete cut short leaves the marker, not an entry, as what is left.
    fs.rmSync(path.join(queueDir, `${stem}.json`), { force: true });
    fs.rmSync(path.join(outdir, marker), { force: true });
    return removed;
}

module.exports = { removeCaptureFiles };
