# Maintainers

Building, signing and publishing the Mac app, and running the server. What Clipwise is and how to use it are in the [README](../README.md) and the [member guide](member-setup.md).

## Architecture

```
┌────────────────────────────┐         ┌──────────────────────────────┐
│  Mac Desktop Recorder      │         │  Team server                 │
│  ────────────────────────  │         │  ──────────────────────────  │
│  • Shell: Electron         │ uploads │  • Transcript + moments      │
│  • Core Audio Taps         │────────▶│    storage                   │
│    (native macOS capture)  │         │  • Moment extraction         │
│  • Local Parakeet          │         │  • Moment DB (Postgres +     │
│    transcription           │         │    vector index)             │
│                            │         │  • MCP server interface      │
└────────────────────────────┘         └──────────────┬───────────────┘
                                                      │ MCP
                                                      ▼
                                       ┌──────────────────────────────┐
                                       │  Claude (Desktop / Code /    │
                                       │  API) via Clipwise MCP       │
                                       │  ──────────────────────────  │
                                       │  Query across every meeting  │
                                       │  in natural language         │
                                       └──────────────────────────────┘
```

### Components

1. **Mac desktop recorder** — an Electron menu bar app that spawns and manages the capture subprocesses. Capture is Clipwise's own Swift binaries using Core Audio Taps (macOS 14.2+) for system audio and Core Audio directly for the mic, recording both natively — no Recall.ai, no meeting-bot SDK, no third-party dependency in the capture path. Stopping a capture starts the rest on its own: the recorder spawns the capture pipeline, which on the Mac transcribes (with Parakeet through FluidAudio; whisper.cpp stays selectable), classifies the capture and separates voices. When it exits, the recorder uploads the capture to the server, which ingests it and extracts moments, without anyone driving it. From the menu bar, "Recent meetings…" lists the past week's captures — title, who was on it, when, how long — to save any one's transcript or fix its speaker names; it is for picking a meeting, not reading one. "Save transcript" there writes the meeting's transcript, with speaker names applied, to a text file; a voice that was never named is labelled "Unnamed voice N", and a line no voice clearly owns "Unattributed".
2. **Self-hosted server** — A long-running Node/TypeScript container that stores transcripts and the moments database, and serves it through a REST API and an MCP endpoint (below). It's a single Docker artifact from day one: the hosted deployment (Fly.io / Railway / Render) and any user-run self-hosted deployment run the same image. Persistence is standard Postgres (with `pgvector`); Neon is the currently-used managed provider, but the connection is plain `pg` so any Postgres works. It has a capture endpoint, `POST /captures`, that takes one finished capture: the transcript's segments, the capture's provenance, and the identity answer if there is one. It needs a capture token, which is separate from the MCP token (its audience is `<server>/capture`, its scope `clipwise:capture`) and is issued only to the recorder's OAuth client; an MCP token on it is a 403. The account and the owner come from the token, and the capture is stored as a private recording. It is idempotent on the capture id: the same capture sent again is a 200 with `created:false`, different segments under the same id, or another member's capture id, are a 409, and an identity answer that arrives on a repeat is applied once. Apart from the auth routes (signing in, refreshing its token and signing out, under `/api/auth/oauth2/`, and the `/.well-known/oauth-protected-resource` lookup), the recorder uses only the capture routes under `/captures`, never the rest of the REST API. It runs the database-free capture pipeline (`capture-cli`) on the Mac — from inside the app bundle in a built app, from the checkout when run from source — and uploads each capture to `POST /captures`; ingest and extraction run on the server.
3. **Clipwise MCP** — The server's own MCP endpoint, at `/mcp`, over Streamable HTTP with OAuth sign-in. Claude connects to it directly; there is no separate bridge to install or run. Two tools today: `search_moments`, which searches the extracted-moments database by text, by meaning, by moment kind, by recording, or by who was on the call; and `get_transcript`, which returns one recording's transcript with per-segment timestamps and speaker labels.

## Recorder setup

Covers the Mac recorder only; the server, which serves MCP itself, has its own setup.

**Prerequisites**

- macOS 14.2+ (Core Audio Taps floor)
- Swift and Node toolchains
- `meson` and `ninja` — `brew install meson ninja`. Build tools only, for `recorder/aec` (the echo
  canceller, below); nothing is installed on a user's machine.
- `ffmpeg` on `PATH` — `brew install ffmpeg`, for running from a checkout only. There it is not optional,
  but not for capture: `transcribe.py` uses it to downsample both tracks to the 16 kHz the transcription
  engines read. The built app carries its own LGPL-only ffmpeg (`recorder/ffmpeg/build.sh`) and never
  reads one from `PATH`. The mic is captured by Clipwise's own `miccap` binary, which replaced the ffmpeg
  mic path.

**Build the binaries.** All of these are gitignored build outputs, so a fresh
clone has none of them.

```sh
(cd recorder && swiftc -O audiodevs.swift -o audiodevs)
(cd recorder/systemtap && swift build -c release)
(cd recorder/miccap && swift build -c release)
recorder/aec/build.sh
```

**Install the app shell.**

```sh
(cd recorder/app && npm install && npx install-electron)
```

`npx install-electron` is not optional. Electron 43's package manifest has no
`scripts` key at all, so nothing fetches the runtime binary during `npm install`
— the install exits clean and reports no vulnerabilities while leaving an app
that cannot launch. Verified from the installed package on disk 2026-08-09, with
`ignore-scripts` confirmed `false`.

**Package it as an app.** `recorder/app/build-app.sh` does everything above and
produces `recorder/app/dist/Clipwise.app` — a menu bar app you can double-click
and add to Login Items in System Settings. It signs with the Developer ID
identity; override with `CLIPWISE_SIGN_IDENTITY` if you have your own.

```sh
(cd recorder/app && ./build-app.sh)
```

It is signed with the hardened runtime but not notarized, and there is no disk
image: `notarize.sh` does both, after this. The app registers itself for launch
at login the first time it runs from Applications with setup finished; the
tray's "Open at login" turns that off.

The bundle carries the capture pipeline whole: its tools (systemtap, miccap,
audiodevs, micwatch, diarize, parakeet, aec and ffmpeg), their models, its own
Python, and the pipeline compiled to JavaScript. It reads nothing from the
checkout or PATH. It uploads each capture to the server named in
`capture-server.json`, which makes the moments.

The developer keys (the database URL and the API keys) are not in the checkout:
they are in `~/.config/clipwise/dev.env`, which only `server/scripts/scratch-db.sh`
and the schema push (`server/drizzle.config.ts`) load, by name. Nothing the app
runs reads it.

A packaged run has no terminal to print to, so everything it would have printed
(`console.log` and `console.error`, each line stamped with the time) goes to a
day log, one file per local date:
`~/Library/Application Support/clipwise/recordings/recorder-YYYY-MM-DD.log`.
Day logs more than 30 days old are deleted, at launch and once a day after.
Each capture's pipeline (transcription, classification, voice separation) writes
its own output to `recordings/pipeline-<stem>.log`, appended on each run. When
transcription or classification fails, `recordings/pipeline-<stem>.json` records
that step as failed, with its error; voice separation never fails a run.

**Capture output.** Each capture writes to
`~/Library/Application Support/clipwise/recordings/`, sharing one timestamp
stem: the two audio tracks, a log per child, and `manifest-<stem>.json`.

The manifest is written at capture start, before any child spawns, and is what
identifies a recording. Its `recording_id` is a generated UUID — the stem stays
the human-readable handle, but it is not an identifier: timestamps collide and
depend on a correct clock. Consumers key on `recording_id` (it is what the
normalized transcript contract carries as `source_recording_id`).

It also records the device and sample rate per track, which nothing else
preserves — a headset can put the mic at 24 kHz against a 48 kHz tap, and the
children only mention their rates in stderr logs. Both rates come from one
CoreAudio query at start rather than from the children, which report their
formats milliseconds later; `sample_rate_source` on each track names that
provenance, so a manifest recovered from a capture's own artifacts is
distinguishable from one written live.

**Transcription** — needed by anyone who records, not only by anyone calling
`transcribe.py` by hand: stopping a capture spawns the pipeline, and its first
step is transcription.

- Default engine: Parakeet TDT 0.6B v2 through FluidAudio. English only, and Apple Silicon only —
  on an Intel Mac, set `CLIPWISE_TRANSCRIBER=whisper`. Build the binary and fetch the model:

  ```sh
  (cd recorder/parakeet && swift build -c release && ./fetch-models.sh)
  ```

  The fetch is 443 MB, checksum-verified, and gitignored; `recorder/app/build-app.sh` runs both steps.
  Nothing touches the network at run time. `build-app.sh` copies the models into the app's
  `Resources/models`, and the built app reads them from there. Run from a checkout instead, the
  pipeline reads the checkout's copy, in `recorder/parakeet/models` and `recorder/diarize/models`.
  The first transcription on a machine is slower while Core ML compiles
  the model (about 12 s extra on the evaluation harness); later ones are not. Lines are built from
  word timings, breaking on pauses of 0.6 s or more, and end at the last word's end time.
- Whisper, selectable with `CLIPWISE_TRANSCRIBER=whisper`: `brew install whisper-cpp` for the
  `whisper-cli` binary, and the GGML model — `transcribe.py` prints the download command in its
  error message. Whisper output keeps its Silero VAD gating and its measured segment ends.
- Echo removal: when the capture's output device was the built-in speakers, the mic also records the
  call, so other people's speech would be stored as the user's. After downsampling and before
  transcription, `recorder/aec` (WebRTC AEC3, echo cancellation only, the tap as the reference) writes
  `mic-<stem>.16k.aec.wav` and both engines transcribe that. The raw `mic-<stem>.16k.wav` is kept.
  The rule is one manifest field: the system track's `device_uid` is `BuiltInSpeakerDevice`. Any other
  output device, a missing manifest, or `CLIPWISE_AEC=off` leaves the mic untouched. The transcript's
  `aec` block records whether it ran and why or why not, and ingest stores it in
  `recordings.metadata.aec`. Build it with `recorder/aec/build.sh` (`build-app.sh` runs it); if a
  capture needs it and it isn't built, transcription stops rather than transcribe the echo. The device
  is the one the manifest recorded at capture start, so an output switch mid-call isn't seen.
- A selected engine that isn't installed is an error, not a fallback to the other one. The capture's
  audio is kept and re-transcribes once the engine is present. Each transcript records which engine
  wrote it in its `engine` key, and ingest stores that as the transcript's `provider`.

## Building, notarizing and installing the Mac app

The commands that built, notarized and installed the app from a fresh worktree on 2026-10-25, run
from the repo root.

**Prerequisites.** The app shell's packages and Electron runtime, and the server's packages:
`build-app.sh` compiles the capture pipeline with the server's own `tsc`
(`server/node_modules/.bin/tsc`), and fails without them.

```sh
(cd recorder/app && npm install && npx install-electron)
(cd server && npm ci)
```

**Build and sign.** Produces `recorder/app/dist/Clipwise.app`, and ends with `built …` naming the
commit.

```sh
(cd recorder/app && ./build-app.sh)
```

**Notarize.** `notarize.sh` needs `CLIPWISE_NOTARY_PROFILE`, the notarytool keychain profile name,
exported from `~/.zprofile`; the command below runs under a login shell so it picks that up. It
notarizes and staples the app, then packs, signs, notarizes and staples
`recorder/app/dist/Clipwise.dmg`. Both submissions print `status=Accepted`, and Gatekeeper prints
`source=Notarized Developer ID` for each.

```sh
zsh -l -c 'cd recorder/app && ./notarize.sh'
```

**Install from the disk image.** Quit the running app and confirm it has quit (`pgrep` prints
nothing), move the installed copy aside, copy the app out of the disk image, then launch it.

```sh
osascript -e 'quit app "Clipwise"'
pgrep -fl Clipwise
mv /Applications/Clipwise.app <backup folder>/Clipwise.app.prev
hdiutil attach -nobrowse -readonly -mountpoint <mount folder> recorder/app/dist/Clipwise.dmg
ditto <mount folder>/Clipwise.app /Applications/Clipwise.app
hdiutil detach <mount folder>
xcrun stapler validate /Applications/Clipwise.app
spctl --assess --type execute --verbose=2 /Applications/Clipwise.app
open /Applications/Clipwise.app
```

## Publishing a release

Written from one release, v0.1.202611101156 on 2026-11-10: these are the steps that release
took, in order, and nothing else. `gh release list` shows earlier releases: the three before it
(from v0.1.202611032040) carry the same three assets, and the seven before those carry the zip and
`ffmpeg-9.0.2.tar.xz` only. How the earlier ones were published was not written down.

A release is a GitHub Release whose tag is `v<version>`, holding three files from
`recorder/app/dist/`: `Clipwise-darwin-arm64-<version>.zip` (what installed copies update to: the
app asks update.electronjs.org, which serves the newest release's zip), `Clipwise.dmg` (the disk
image `notarize.sh` makes; `docs/member-setup.md` and "Installing the app" in the README have a new member
open the .dmg from a link their admin sends) and `ffmpeg-9.0.2.tar.xz` (the ffmpeg source,
THIRD_PARTY_NOTICES). `dist/` can also hold zips of earlier builds; only `<version>`'s goes up.

**The build.** Built and notarized with the two steps above, in a worktree at the release commit.
Its `build-info.json` gave the release commit and `dirty: false`. The release commit was put on
`main` by a fast-forward, pushed by hash from that worktree, and confirmed by reading the remote
ref:

```sh
git push origin <release commit, full hash>:refs/heads/main
git ls-remote origin refs/heads/main          # <release commit>
```

**Checks before publishing,** each with its exit code:

```sh
xcrun stapler validate recorder/app/dist/Clipwise.app
xcrun stapler validate recorder/app/dist/Clipwise.dmg
codesign --verify --deep --strict --verbose=2 recorder/app/dist/Clipwise.app
spctl --assess --type execute --verbose=2 recorder/app/dist/Clipwise.app                                  # source=Notarized Developer ID
spctl --assess --type open --context context:primary-signature --verbose=2 recorder/app/dist/Clipwise.dmg # source=Notarized Developer ID
```

The zip, unpacked into a new empty folder outside the repo:

```sh
mkdir <new folder>
ditto -x -k recorder/app/dist/Clipwise-darwin-arm64-<version>.zip <new folder>
cat <new folder>/Clipwise.app/Contents/Resources/app/build-info.json      # the release commit, dirty false
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' <new folder>/Clipwise.app/Contents/Info.plist   # <version>
xcrun stapler validate <new folder>/Clipwise.app
codesign --verify --deep --strict <new folder>/Clipwise.app
```

And `release-zip.sh`'s own check, on copies in a folder outside the repo that it empties first
(`all cases as expected`):

```sh
recorder/app/check-release-zip.sh recorder/app/dist/Clipwise.app <scratch folder>
```

**Notes.** A file outside the repo, in the shape of the previous release's notes: a first line
`Clipwise <version>`, then one short user-facing line per change, each starting `- `.

**A draft first,** so the update feed does not see it yet:

```sh
gh release create v<version> --repo looprite/clipwise \
  --target <release commit, full hash> \
  --title <version> \
  --notes-file <notes file> \
  --draft \
  recorder/app/dist/Clipwise-darwin-arm64-<version>.zip \
  recorder/app/dist/Clipwise.dmg \
  recorder/app/dist/ffmpeg-9.0.2.tar.xz
gh release view v<version> --repo looprite/clipwise --json isDraft,tagName,name,body,assets
git ls-remote origin refs/tags/v<version>     # nothing yet: the tag is made when it is published
```

The view was compared with the local files: each asset's name, its `size` against the file's
bytes, its `digest` against the file's SHA-256, and the body byte for byte against the notes file.

**Publish, then read back.** The publish command's output is not the confirmation:

```sh
gh release edit v<version> --repo looprite/clipwise --draft=false
git ls-remote origin refs/tags/v<version>     # <release commit>
gh release list --repo looprite/clipwise --limit 3     # <version> marked Latest
curl -s -w '\nhttp=%{http_code}\n' https://update.electronjs.org/looprite/clipwise/darwin-arm64/<previous version>
# http=200, and its "url" ends in Clipwise-darwin-arm64-<version>.zip
```

Not part of that release: installing it by hand on this Mac (installed copies update through the
feed), and a server deploy (it changed nothing under `server/`).

## Server database login

The server connects as its own login, which can read and write rows in every table in schema
`public` and do nothing else: no creating, altering, dropping or truncating tables, and no creating
logins or databases. Everything that changes the schema keeps using the owner.

1. As the owner, create the login with SQL (on Neon, in the SQL editor, not the console's role
   page, which makes roles administrators):

   ```sql
   CREATE ROLE clipwise_server LOGIN PASSWORD '<a long generated password>';
   ```

2. With `DATABASE_URL` set to the owner, run `npm run db:grant-server-login -- clipwise_server` in
   `server/` (`-- clipwise_server --dry` prints the statements without running them). It grants
   `SELECT, INSERT, UPDATE, DELETE` on every table in `public`, `USAGE` on `public`, and the same
   row rights on tables the owner creates later. It refuses a login that doesn't exist or holds
   more than a login should, never creates one, never touches a password, and can be run again.
3. Point the server's `DATABASE_URL` (on Fly, `fly secrets set`) at the new login.

`db:push`, `db:sync`, `db:provision`, `db:checks`, `auth:migrate` and the `auth` CLI keep using
the owner.

## Deploying the server

From `server/`, on a clean `main` that has been pushed (`git status --porcelain` prints nothing):

```sh
fly deploy --label org.opencontainers.image.revision=$(git rev-parse HEAD)
```

`fly.toml` supplies the app, the Dockerfile and its `prod` target. The label is passed by hand
because the Dockerfile doesn't set it yet; without it, nothing on Fly says which commit an image
was built from.

After the deploy:

- `fly releases`: the new version is at the top, `complete`.
- `fly image show`: `LABELS` reads `org.opencontainers.image.revision=<the full hash of HEAD>`.
- `curl https://clipwise-looprite.fly.dev/live` answers `{"status":"ok"}` (the Fly health check;
  it never touches the database).
- `curl https://clipwise-looprite.fly.dev/health` answers `{"status":"ok","db":"ok"}`.

To roll back, find the previous release's image with `fly releases --image` and deploy it as it
is, without building:

```sh
fly deploy --image registry.fly.io/clipwise-looprite:<that release's deployment tag>
```

Then run the same checks; `fly image show` reads the old image's own revision label, or none if
it was deployed without one. A rollback swaps the image only: it does not undo a schema push to
the database.
