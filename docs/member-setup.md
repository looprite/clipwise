# Setting up Clipwise

Clipwise records your calls on your Mac and sends the transcript to your team's Clipwise server, so you can ask Claude about them. It lives in your menu bar. This guide takes you from nothing to your first recorded call.

## 1. What you need from your admin

Before you start, ask whoever runs Clipwise for your team for:

1. **The download link** for the Clipwise .dmg file.
2. **Your team's Clipwise address**, for example `clipwise.yourcompany.com`. You type it in during setup.
3. **An account.** Your admin adds your email to the team first. You sign in with Google using that email. If you try before you've been added, the sign-in page says *"This account isn't a member of this Clipwise instance. Ask the person who runs it to add you."*

You also need an Apple silicon Mac with macOS 14.2 or later. Clipwise doesn't open on an Intel Mac.

## 2. Download and install

1. Open the .dmg from the link your admin sent.
2. Drag Clipwise into Applications.
3. Open Clipwise from Applications. [CHECK: the exact macOS message on first open of a downloaded app]
4. If you opened it from somewhere else, Clipwise asks **Move Clipwise to Applications?** Click **Move and relaunch**. It has to run from Applications to start when you log in.
5. The **Set up Clipwise** window opens. It shows **Step 1 of 5** and walks you through the next steps. You can click **Not now** at any screen and come back later with **Finish setting up Clipwise…** in the menu bar.

Step 1 of 5 is the recording notice, **Before you record**. Read it and click **I understand**. Section 11 covers it.

## 3. Your team's address and signing in

1. On **Your team's Clipwise address**, type the address your admin gave you and click **Continue**.
2. On **Sign in**, click **Sign in with Google**. Your browser opens your team's sign-in page. Sign in with the Google account your admin added.
3. Google asks once for read-only access to your calendar. That lets your recordings pick up the meeting's title and who was invited.
4. Come back to the Clipwise window when your browser says you're signed in. If you typed the wrong address, click **Use a different address**.

## 4. Allow audio recording

Clipwise records two tracks of every call: your microphone, and the sound your Mac plays (the other people on the call). macOS asks you once for each.

1. On **Allow audio recording**, click **Allow…** next to **Microphone**. macOS asks for permission and shows Clipwise's reason: *"Clipwise records your microphone as one track of the meetings you capture."* Allow it. [CHECK: the exact wording of macOS's own prompt around that line]
2. Click **Allow…** next to **System audio**. macOS shows: *"Clipwise records system audio as the other track of the meetings you capture."* Allow it. [CHECK: the exact wording of macOS's prompt]
3. Each line then reads **Allowed**, and the window moves on by itself.

**If you clicked Don't Allow:** the line reads **Off** and the button changes to **Open System Settings**. Click it, turn Clipwise on in the list that opens, and come back. You can also open the same page any time from the menu bar with **Open Microphone settings…** or **Open System Audio settings…**, which appear when a permission is off. [CHECK: the names of those System Settings pages in macOS 14 and 15, and whether Clipwise has to be quit and reopened afterwards]

To finish this step later, click **Finish later**. The menu bar then offers **Allow audio access…**.

## 5. FileVault

Clipwise keeps call audio and transcripts on your Mac. FileVault encrypts your disk, so they're protected if the Mac is lost or stolen.

If FileVault is off, the setup window shows a red line: *"FileVault is off. Clipwise keeps call audio and transcripts on this Mac; turn on FileVault so they're encrypted if the Mac is lost."* If Clipwise can't tell, it says it couldn't confirm FileVault is on. It's a warning only; setup carries on either way.

To turn it on:

1. Click **Open System Settings** in that red line. It opens FileVault's page.
2. Click to turn FileVault on and follow macOS's steps.

You can also turn it on at any time, during setup or after: open System Settings, choose **Privacy & Security**, scroll to **FileVault** and click **Turn On**. [CHECK: macOS's button and step names]

## 6. Connect Claude

The last screen, **Use Clipwise in Claude**, shows your connector address (your team's address followed by `/mcp`) with a **Copy** button. In Claude:

1. Go to Customize, then Connectors, and click Add.
2. Hover over Custom, then choose Web.
3. Name it Clipwise, paste the address, and click Continue.
4. Under Authentication, choose Sign in now, then click Add. Sign in with Google when Clipwise asks.
5. In a chat, click **+** (or type **/**), hover over Connectors, and turn Clipwise on.

[CHECK: that claude.ai's menu names still match these steps]

Click **Done** in Clipwise. To try it, ask Claude: *"What changed in the Panfold project between the two calls, and is anyone behind on what they committed to?"* Those two calls are made-up demo calls that only you can see. To remove them, open your team's sign-in page and click **Move the demo calls to the trash**.

## 7. Your first call

**Starting.** The first time a calling app uses your microphone, Clipwise asks *"Clipwise: [app] is using the microphone. Record calls from this app?"* You can choose:

- **Always record**: record this call, and future calls from this app, without asking.
- **Not now**: don't record this time. You can still start by hand with **Start recording** in the menu bar.
- **Never ask about this app**: Clipwise won't ask again.

You can change your choice later under **Detected applications** in the menu bar.

When recording starts, a notification says **Recording — let everyone know** and shows a line you can say. On calls with a chat, **Copy recording notice** in the menu bar copies it for you to paste.

**Stopping.** Click **Stop recording** in the menu bar (the same item, which changes while you record), or let Clipwise stop by itself when the call ends. You'll then see **Auto-stopped — who was on this call?**

**"Who was on this call?"** This window opens after every call.

1. **People.** Type in **Add people — type a name**. Name only the people on the other end of the call. You don't need to add yourself. Names from your calendar and **Recent:** suggestions may already be filled in. Remove anyone who wasn't there.
2. **Personal or work?** Pick **Work** or **Personal**. Clipwise sometimes guesses from the app, and then says so; change it if it's wrong. Your personal calls are never shared with your team, and Claude leaves them out unless you ask for them.
3. **Someone else spoke into my mic.** Tick this if someone beside you talked during the call, for example someone in the same room. Clipwise then won't credit your mic's words to you, and won't learn anyone's voice from that call. Don't add that person under People. Name only the people on the other end.
4. **Voices on the call.** On calls with several people, Clipwise may still be finding the voices. You can save now; Clipwise asks you to name the voices later from the menu bar (**Name N voices…**).
5. Click **Save**.

**If you don't answer:**

- **Closing the window** with its own close button counts as "later". The menu bar offers **Who was on the [date] call…**, but only for your three most recent unanswered calls from the past seven days.
- **Skip** means you'll never answer: the call stays unnamed, and you can't add people to it later from Recent meetings.
- Either way, a call nobody answers is treated as if you were alone at your mic. Nobody on it is named, and your own lines aren't named either.

## 8. Fixing a call later

Open **Recent meetings…** from the menu bar. It lists the past seven days; older calls can't be changed here. You can filter by **All**, **Work** or **Personal**. On each meeting:

- **Save transcript** saves it as a file.
- **Fix names** appears on calls with several voices and lets you name or rename them.
- **⋯** (More actions) opens a menu:
  - **Change attendees…** reopens the "Who was on this call?" window with your saved answer. Change the people, Work or Personal, or the **Someone else spoke into my mic** box, then click **Save**. **Cancel** changes nothing. It only appears on calls you answered.
  - **Move to trash**.

## 9. Recognize voices (optional)

Clipwise can learn the voices of people you talk to, so that one day it can tell you who was on a call. It's off unless you turn it on. Today it only learns; it doesn't name anyone yet.

1. Open **Recognize voices…** from the menu bar (the "Who was on this call?" window also offers it).
2. Read what it does. It keeps a voice print for you, and for each person you name once you've named them on two calls, on this Mac only, and never uploads them. Some locations require the other person's consent; that's your responsibility.
3. Click **Turn on**, or **Not now**.

Once it's on, **Voice prints on this Mac** lists **You** and each person, with the number of calls they're learned from. A print is kept once you've named someone on two calls. Keep prints only for people you talk to often: click **Delete** next to anyone else. To delete several at once, tick them and click **Delete N…**. **Turn off and delete prints** removes every print. Your recordings aren't affected.

## 10. Trash, deleting, and signing out

**Trash.** In **Recent meetings**, use ⋯ → **Move to trash**, or tick several meetings and click **Move N to trash**. Trashed calls move to the **Trash** tab, and Claude no longer finds them. Nothing is deleted yet. The trash doesn't empty itself.

**Delete permanently.** In **Trash**, click **Delete permanently…** (or tick several and use **Delete N permanently…**). Clipwise asks *"Permanently delete this meeting?"* and warns that the audio, the transcript and everything taken from it are deleted, and that this can't be undone. Click **Delete permanently** to go ahead, or **Cancel**. **Restore** brings a call back from the trash. You must be signed in, and the server reachable, to trash or delete.

**Signing out.** **Sign out** in the menu bar signs this Mac out of your team's server. Your recordings and any voice prints stay on this Mac. Anything recorded while signed out uploads after you sign in again with **Sign in to Clipwise…**. To remove voice prints, use **Turn off and delete prints**.

## 11. The recording notice

The recording notice is the first setup screen, **Before you record**. It's short: Clipwise records your calls on your Mac and no bot joins the meeting, your Mac turns the audio into a transcript, and you use the Clipwise connector in Claude to ask about your calls. You're responsible for telling the people on your calls that you're recording, and for following the law where you and they are. Until you agree, the menu bar shows **Recording notice…**.

The full notice covers what's stored, where, for how long, who can see it, and which outside services handle your calls. To read it before you agree, click **Read the full notice** on the Before you record screen; **Back** returns you to the short one, and reading it doesn't count as agreeing. Once you've agreed, read it again any time with **Read the recording notice…** in the menu bar.

When the notice changes, Clipwise shows **Before you record** again and asks you to agree to the new version.
