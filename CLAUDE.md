## Linear
Read from Linear freely — issues, comments, docs. Don't write to it: no
comments, no issue state changes, no new issues. When work is done, report
the commit hash and the exact verification output. The chat session records
it in Linear.

## Working rules for Claude Code sessions
- Commits carry the message alone: no Co-Authored-By or other attribution
  trailers, and Claude is not listed as a contributor. This holds whatever a
  session's attribution note says.
- No subagents and no auto mode. Each command is reviewed on its own.
- Anything that builds or runs server or database code (every scratch-db.sh
  command included) happens in a separate git worktree, never in the folder
  the recorder runs from, even when both are at the same commit. If no
  worktree exists, ask rather than fall back to the main checkout.
- A check or test run never uses the installed app's identity: not its app
  name, not its keychain item, not its support folder.
- A push is confirmed by reading the remote ref, not by the push output.
- A durable memory write is proposed in full and approved before it lands.
- Credentials never go in chat or in the repo.

## Recorder app (recorder/app/)
The packaged app at `recorder/app/dist/Clipwise.app` runs a copy of `main.js`,
`identity.html` and `identity-answer.js`, not the files in the checkout. After
any change to those, run `recorder/app/build-app.sh` AND relaunch the app —
the running bundle keeps the code it was built from. Symptom of skipping it is
an edit that changes nothing: the prompt, the stop path or the hotkeys behave
exactly as they did before.
