// Provisioning and membership for one instance. There is no sign-up page and
// no admin UI yet; an instance's team is managed here, by whoever runs it.
//
//   tsx src/auth/cli.ts init-account --name "Looprite" [--slug looprite]
//   tsx src/auth/cli.ts bootstrap-admin --email <email> [--name <name>]
//                         [--password-env VAR] [--claim-existing]
//   tsx src/auth/cli.ts add-member --email <email> [--role member|admin] [--name <name>]
//   tsx src/auth/cli.ts remove-member --email <email>
//   tsx src/auth/cli.ts list-members
//   tsx src/auth/cli.ts register-recorder
//   tsx src/auth/cli.ts clear-google-tokens [--apply]
//
// list-members prints each member's email, role and state, and under it every
// recording-notice version they acknowledged, or "none".
//
// register-recorder creates (or repairs) the recorder's OAuth client, the only
// client that can obtain a capture token (SAA-244). It is a step for every
// instance, after the server has started once (so the capture resource exists).
//
// clear-google-tokens counts the Google accounts that still hold Google's tokens
// in auth_account, written before sign-in moved them to calendar_connections
// (SAA-198 step 5); with --apply it sets those columns to null. Run once per
// instance, at the deploy that brings the change. The count is all it prints.
//
// A password is only ever read from the environment variable named by
// --password-env, never from argv (which lands in shell history and `ps`).
// Without one the member has no password login and signs in with Google (when
// the instance has GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set); their
// first Google sign-in creates the login.
//
// Exit code 0 on success, 1 on a refusal or failure; messages say which.

import { parseArgs } from "node:util";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { slugify } from "../lib/slug.js";
import {
  Refusal,
  addMember,
  createPasswordLogin,
  insertMember,
  removeMember,
  requireAccount,
  requireEmail,
  type Role,
} from "./members.js";
import { endPoolWhenAuthSettled } from "./auth.js";
import { ensureRecorderClient } from "./recorder-client.js";
import { clearGoogleTokens } from "./google-calendar-grant.js";

const say = (s: string) => process.stdout.write(`auth: ${s}\n`);

function readPassword(envName: string | undefined): string | null {
  if (!envName) return null;
  const pw = process.env[envName];
  if (!pw) throw new Refusal(`environment variable ${envName} is not set`);
  if (pw.length < 12) throw new Refusal(`the password in ${envName} is shorter than 12 characters`);
  return pw;
}

async function initAccount(values: { name?: string; slug?: string }): Promise<void> {
  if (!values.name) throw new Refusal("--name is required");
  const existing = await db.select().from(schema.accounts);
  if (existing.length > 0) {
    throw new Refusal(`an account already exists (${existing[0].slug}); an instance has exactly one`);
  }
  const slug = values.slug ? slugify(values.slug) : slugify(values.name);
  const [account] = await db.insert(schema.accounts).values({ name: values.name, slug }).returning();
  say(`account created: ${account.name} (${account.slug}) ${account.id}`);
}

async function bootstrapAdmin(values: {
  email?: string;
  name?: string;
  "password-env"?: string;
  "claim-existing"?: boolean;
}): Promise<void> {
  const email = requireEmail(values.email);
  const password = readPassword(values["password-env"]);
  const account = await requireAccount();

  const members = await db
    .select()
    .from(schema.accountMembers)
    .where(eq(schema.accountMembers.accountId, account.id));
  let member = members.find((m) => m.email === email);
  if (!member) {
    if (members.length > 0) {
      throw new Refusal("members already exist; bootstrap-admin is only for the first admin — use add-member");
    }
    member = await insertMember(account.id, email, "admin", values.name ?? null);
    say(`admin added: ${email}`);
  } else if (member.role !== "admin") {
    throw new Refusal(`${email} is already a member but not an admin`);
  } else {
    say(`${email} is already the admin`);
  }

  if (password && !member.authUserId) {
    await createPasswordLogin(email, values.name ?? member.displayName ?? email, password);
    say("password login created");
  } else if (password) {
    say("a login already exists for this member; password left unchanged");
  }

  if (values["claim-existing"]) {
    const claimed = await db
      .update(schema.recordings)
      .set({ ownerMemberId: member.id })
      .where(and(eq(schema.recordings.accountId, account.id), isNull(schema.recordings.ownerMemberId)))
      .returning({ id: schema.recordings.id });
    say(`recordings with no owner now owned by ${email}: ${claimed.length}`);
  }
}

// Each member, and under each the recording-notice versions they acknowledged
// (SAA-227 part I): when the Mac recorded it and when the server learned of it,
// read from notice_acknowledgements. "none" when there is no row.
async function listMembers(): Promise<void> {
  const account = await requireAccount();
  const rows = await db
    .select()
    .from(schema.accountMembers)
    .where(eq(schema.accountMembers.accountId, account.id))
    .orderBy(asc(schema.accountMembers.createdAt));
  const acks =
    rows.length === 0
      ? []
      : await db
          .select()
          .from(schema.noticeAcknowledgements)
          .where(inArray(schema.noticeAcknowledgements.memberId, rows.map((m) => m.id)))
          .orderBy(asc(schema.noticeAcknowledgements.noticeVersion));
  say(`${account.name} (${account.slug}) — ${rows.length} member(s)`);
  for (const m of rows) {
    const state = m.removedAt ? "removed" : m.joinedAt ? "active" : "invited (not signed in yet)";
    process.stdout.write(`  ${m.email.padEnd(36)} ${m.role.padEnd(7)} ${state}\n`);
    const own = acks.filter((a) => a.memberId === m.id);
    if (own.length === 0) process.stdout.write("      notice: none\n");
    for (const a of own) {
      process.stdout.write(
        `      notice v${a.noticeVersion}: acknowledged ${a.acknowledgedAt.toISOString()} on the Mac, recorded ${a.recordedAt.toISOString()} by the server\n`,
      );
    }
  }
  // The server records an acknowledgement from the capture that carries it
  // (routes/captures.ts), and from nothing else.
  say(`notice: the server learns of an acknowledgement only from a capture that carries it, so "none" can mean the member agreed on their Mac but no capture of theirs has reached the server since`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      email: { type: "string" },
      name: { type: "string" },
      slug: { type: "string" },
      role: { type: "string" },
      "password-env": { type: "string" },
      "claim-existing": { type: "boolean" },
      apply: { type: "boolean" },
    },
  });
  switch (command) {
    case "init-account":
      return initAccount(values);
    case "bootstrap-admin":
      return bootstrapAdmin(values);
    case "add-member": {
      const email = requireEmail(values.email);
      const role = values.role ?? "member";
      if (role !== "member" && role !== "admin") throw new Refusal("--role must be member or admin");
      await addMember({ email, role: role as Role, name: values.name });
      say(`${role} added: ${email} (their first verified sign-in with that address links the login)`);
      return;
    }
    case "remove-member": {
      const email = requireEmail(values.email);
      const { revoked } = await removeMember(email);
      say(`removed: ${email}`);
      if (revoked) say("sessions and OAuth tokens revoked");
      return;
    }
    case "list-members":
      return listMembers();
    case "clear-google-tokens": {
      const r = await clearGoogleTokens(values.apply === true);
      say(`Google accounts still holding tokens in auth_account: ${r.holding}`);
      if (values.apply === true) say(`cleared: ${r.cleared}`);
      else if (r.holding > 0) say("nothing changed; run again with --apply to clear them");
      return;
    }
    case "register-recorder": {
      const r = await ensureRecorderClient();
      say(`recorder client ${r.created ? "created" : "already existed; set back to its definition"}`);
      process.stdout.write(
        `  client_id  ${r.clientId}\n  redirect   ${r.redirectUri} (any port)\n  resource   ${r.resource}\n  scopes     ${r.scopes.join(" ")}\n`,
      );
      return;
    }
    default:
      throw new Refusal(
        "usage: init-account | bootstrap-admin | add-member | remove-member | list-members | register-recorder | clear-google-tokens (see the header of src/auth/cli.ts)",
      );
  }
}

main()
  .catch((err) => {
    process.stderr.write(
      `auth: ${err instanceof Refusal ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(endPoolWhenAuthSettled);
