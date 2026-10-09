## Linear
Read from Linear freely — issues, comments, docs. Don't write to it: no
comments, no issue state changes, no new issues. When work is done, report
the commit hash and the exact verification output. The chat session records
it in Linear.

## Recorder app (recorder/app/)
The packaged app at `recorder/app/dist/Clipwise.app` runs a copy of `main.js`,
`identity.html` and `identity-answer.js`, not the files in the checkout. After
any change to those, run `recorder/app/build-app.sh` AND relaunch the app —
the running bundle keeps the code it was built from. Symptom of skipping it is
an edit that changes nothing: the prompt, the stop path or the hotkeys behave
exactly as they did before.
