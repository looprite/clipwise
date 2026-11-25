# Running your team's Clipwise

This guide is for your team's Clipwise admin. You run the team from the Clipwise Mac app, in one window, **Team members**. There you add people, remove people, and see who has accepted the recording notice. You don't need the server, the database or a terminal. Whoever runs your team's instance (Looprite, for a team it hosts) handles those.

## Set up with Claude

Open [this guide as plain text](https://raw.githubusercontent.com/looprite/clipwise/main/docs/admin-guide.md). Press Command-A, then Command-C. Open a new chat in Claude, press Command-V, and send.

```
I'm the Clipwise admin for my team. The admin guide is pasted with
this message.

Rules:
- If the guide isn't in this message, say so and stop.
- Use only the guide. Don't add steps, settings names or button
  names from anywhere else.
- When I ask how to do something, give me the guide's steps for it,
  one at a time. Wait for me to say a step is done before the next.
- If what I see doesn't match the guide, or the step is marked
  [CHECK], ask me for a screenshot before telling me what to click.
  If the screenshot still doesn't match, say so and tell me to ask
  whoever runs our Clipwise instance. Don't guess.
- Never ask me for server or database access, and never suggest a
  terminal command. Everything I do is in the Mac app.
- Never invent a member's address. Use only the addresses I give you,
  exactly as I type them.
- Our team's address and the download link come from the guide or
  from whoever runs our instance. Don't make them up.
- Never ask me for a password, code or key.
```

To screenshot one window: press Shift-Command-4, then Space, then click the window. The screenshot saves to your Desktop. Drag it into the chat.

## 1. What you need

- **The Clipwise Mac app, installed and signed in** with your work Google account. If it isn't yet, set it up first with [member-setup.md](member-setup.md). Admins are members too.
- **Admin rights on your team.** Whoever set up the instance made you an admin.

**If a member's Google sign-in is blocked.** Your company's Google Workspace admin can block outside apps from signing in. If a member sees a message that Clipwise is blocked by their organization, ask your Workspace admin to allow Clipwise. [CHECK: the exact Google message and the Workspace Admin console steps. Settle with screenshots if it happens.]

When both are true, the Clipwise menu bar shows **Team members…**. If you were made an admin after signing in and don't see it, quit Clipwise and open it again: the app checks your role when it starts and when you sign in.

## 2. The Team members window

Click **Team members…** in the menu bar. The window is titled **Team members**. From top to bottom it shows:

1. **Add a member:** an **Email address** box, a menu with **Member** and **Admin**, and an **Add** button.
2. A line where the result of your last Add or Remove appears.
3. **Current notice: updated <date>**: the day the current recording notice was published.
4. One line per member, each with a **Remove…** button.

The list reloads after every Add or Remove.

If the list can't be shown, the window says one of these instead, and the Add box is hidden:

- *"Sign in to Clipwise to see this."* Sign in from the menu bar.
- *"Only an admin of your team can see this."* You aren't an admin, or no longer are. **Team members…** also disappears from the menu bar. Ask your team's other admin.
- *"The list couldn’t be loaded. Try again in a moment."* Close the window and open it again. If it keeps happening, ask whoever runs your instance.

If your team has no members yet, the window says *"No members yet."*

[CHECK: screenshots of the window, the Remove confirmation and a removal report from the current release, to match this text.]

## 3. Who has accepted the recording notice

Every member must accept the recording notice in the app before they can record. Each member's line says where they are, by name (or by email if no name is on record) and role:

- **`<name> (<role>) — accepted <date>`**: they've accepted the current notice.
- **`<name> (<role>) — hasn't accepted yet; will be asked at next start`**: they haven't accepted any notice yet. This is also what a member you've just added shows.
- **`<name> (<role>) — accepted an earlier notice; will be asked again at next start`**: the notice has changed since they accepted it. The app asks them again.
- **`<name> (<role>) — accepted a newer notice`**: they accepted a notice from a newer version of the app than yours. Update your app to see it as current.

Dates are the day the member's Mac recorded their answer, by UTC, so every admin sees the same day.

## 4. Add a member

1. Type their work email in **Email address**.
2. Leave the menu on **Member**, or choose **Admin** to make them an admin too.
3. Click **Add**, or press Return.

The window says **Added `<email>` as a member.** (or **as an admin.**). The box clears and the menu goes back to **Member**. Their line appears in the list as *"hasn't accepted yet; will be asked at next start"*.

Each new member gets two made-up demo calls that only they can see, so they can try Clipwise in Claude before their first real call.

> **Warning: only addresses on your team's email domain (`<domain>`) can sign in.** The window accepts any address, but someone added with an address outside `<domain>` (a personal Gmail, say) can never sign in. Check the address before you click **Add**. If you added a wrong address, remove it (section 6) and add the right one. A removed address can't be added again.

If the add doesn't go through, the window says why:

| The window says | What to do |
|---|---|
| *"Type an email address first."* | Type the address, then click Add. |
| *"`<email>` isn't an email address."* | Check the address for typos. |
| *"That address is too long."* | Check what you pasted. |
| *"`<email>` is already on your team."* | Nothing. They're already in the list. |
| *"`<email>` was removed from your team earlier and can't be added again."* | A removed address can't be added back today. |
| *"Only an admin of your team can do this."* | You're no longer an admin. Ask your team's other admin. |
| *"Sign in to Clipwise to do this."* | Sign in from the menu bar, then try again. |
| *"That couldn’t be sent. Check the address and try again."* | Check the address and try again. |
| *"No answer from the server. Check the list to see whether it went through."* | Look at the list. If they're not in it, try again. |
| *"Something went wrong (server `<number>`). Check the list to see whether it went through."* | Look at the list. If it keeps happening, ask whoever runs your instance. |

## 5. Invite them

Adding someone doesn't send them anything. Send them an invitation yourself. Copy this, fill in the two places marked `<…>`, and send it:

```
Hi <name>,

I've added you to our team's Clipwise. It records your calls on your
Mac and lets you ask Claude about them.

1. Open the setup guide as plain text and follow its first section,
   "Set up with Claude":
   https://raw.githubusercontent.com/looprite/clipwise/main/docs/member-setup.md
2. Download Clipwise:
   https://github.com/looprite/clipwise/releases/latest/download/Clipwise.dmg
3. When the app asks for our team's Clipwise address, type exactly:
   https://<subdomain>.clipwiseapp.com
4. Sign in with Google using <their email>.

You need an Apple silicon Mac with macOS 14.2 or later.
```

Your team's address is `https://<subdomain>.clipwiseapp.com`. Always send it in full, starting with `https://`.

## 6. Remove a member

Use this when someone leaves the team.

1. Click **Remove…** on their line.
2. Clipwise asks **Remove `<email>` from your team?** and explains:

   > This changes your live team now, and it can't be undone.
   >
   > Deleted: their sign-ins on every Mac and in Claude; their personal calls, the calls in their trash and their demo calls; and their calendar connection. Clipwise also asks Google to end its calendar access.
   >
   > Kept: their work calls and their calls not yet labelled, which stay with the team.
   >
   > This address can't be added to the team again.

3. Click **Remove** to go ahead. **Cancel** is the default, and the window then says *"Nothing was changed."*

When the removal is done, the window reports what happened:

- **Removed `<email>`.**
- **Deleted `<n>` calls: `<n>` personal, `<n>` in the trash, `<n>` demo.**
- **Kept `<n>` calls for the team: `<n>` work, `<n>` not labelled.**
- **Signed out of Clipwise everywhere.**, or **They weren't signed in anywhere.** if they never signed in.
- What happened at Google, one of:
  - **Clipwise's calendar access ended at Google.**
  - **Clipwise's calendar access had already ended at Google.**
  - **Google refused to end Clipwise's calendar access.**
  - **Google couldn't be reached to end Clipwise's calendar access.**
  - **Clipwise's calendar access couldn't be ended from here.**
  - **Google didn't confirm that Clipwise's calendar access ended.**
  - **No calendar was connected.**

  If they had more than one calendar connection, each line starts **Calendar 1:**, **Calendar 2:** and so on.
- If Google didn't confirm the end of calendar access, a last line says: **Google did not confirm that Clipwise's calendar access ended for every connection: ask the member to remove Clipwise at myaccount.google.com → Third-party apps.** Pass that on to them.

Google's answer never undoes the removal. Their access to Clipwise has already ended either way.

The member then drops out of the list.

If the removal doesn't go through, the window says why:

| The window says | What to do |
|---|---|
| *"You can't remove yourself. Another admin can."* | Ask your team's other admin. |
| *"`<email>` is your team's only admin. Add another admin first."* | Add another admin (section 4), then remove them. |
| *"`<email>` isn't on your team."* | Check the list. |
| *"`<email>` has already been removed."* | Nothing to do. |
| *"Only an admin of your team can do this."* | You're no longer an admin. Ask your team's other admin. |
| *"Sign in to Clipwise to do this."* | Sign in from the menu bar, then try again. |
| *"No answer from the server. Check the list to see whether it went through."* | Look at the list. If they're still in it, try again. |
| *"Something went wrong (server `<number>`). Check the list to see whether it went through."* | Look at the list. If it keeps happening, ask whoever runs your instance. |

## 7. What happens to a removed member's calls

- **Deleted for good:** their personal calls, every call in their trash, and their two demo calls, with everything taken from them.
- **Kept:** their work calls, and any call that was never labelled personal or work.

**Today, nobody can see the kept calls once their owner is removed.** Every call is visible only to the member who recorded it (see section 8), so a removed member's work calls stay in the team's instance but no one can open them, you included.

If your team agrees that a removed member's kept calls should be deleted too, ask whoever runs your instance. They have a tool for that. You can't do it from the app.

## 8. Sharing

**Sharing isn't built for your team.** Every call, work or personal, is visible only to the member who recorded it, not to you or another admin. When a member asks Claude about their calls, Claude sees only their own.

## 9. When to ask whoever runs your instance

- The window keeps saying *"The list couldn’t be loaded. Try again in a moment."* or *"Something went wrong (server `<number>`)…"*
- Your team agrees to delete a removed member's kept calls.
- Anything this guide doesn't cover.
