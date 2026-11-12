# Clipwise

**Team-owned meeting intelligence. Captured on your Mac, surfaced through Claude.**

Clipwise records your calls on your Mac, transcribes them there, and pulls out the moments that matter — decisions, commitments and open questions — so you can ask about them in Claude.

Website: [clipwiseapp.com](https://clipwiseapp.com)

## How it works

- **Mac app.** A menu bar app records the call from your microphone and your computer's sound output, and transcribes it on your Mac. No bot joins the call.
- **Team server.** When a call ends, the app sends the transcript to your team's Clipwise server, which extracts the moments and keeps them searchable. The audio stays on your Mac.
- **Claude, via MCP.** Connect Claude to your team's server and ask across your calls: what was decided, who took what on, what's still open. Answers point back to the transcript.

## Installing the app

Clipwise needs an Apple silicon Mac with macOS 14.2 or later. It doesn't open on an Intel Mac.

Open the Clipwise .dmg from the link you were sent, drag Clipwise to Applications, and open it from there. The [member guide](docs/member-setup.md) walks through setup, your first call, and fixing or deleting a call.

## Privacy

- Call audio is recorded and transcribed on your Mac and is never uploaded. Voice prints, if you turn them on, stay on your Mac.
- Your team's server keeps the transcript, its moments and who was on the call, with call text encrypted where it's stored. Anthropic and Voyage AI process call text to run Clipwise and may not train on it.
- Every call is private to the person who recorded it. We don't sell your data or use your calls to train AI models.

The [Privacy Policy](https://clipwiseapp.com/privacy) has the details.

## Links

- Website: [clipwiseapp.com](https://clipwiseapp.com)
- [Privacy Policy](https://clipwiseapp.com/privacy) · [Terms of Use](https://clipwiseapp.com/terms)
- [Member guide](docs/member-setup.md)
- [Maintainers](docs/maintainers.md): building, notarizing and publishing the app, and running the server
- Licence: [Apache License 2.0](LICENSE)
