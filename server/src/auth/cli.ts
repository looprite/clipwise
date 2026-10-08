// Provisioning and membership for one instance. There is no sign-up page and
// no admin UI yet; an instance's team is managed here, by whoever runs it.
//
//   tsx src/auth/cli.ts init-account --name "Looprite" [--slug looprite]
//   tsx src/auth/cli.ts bootstrap-admin --email <email> [--name <name>]
//                         [--password-env VAR] [--claim-existing]
//   tsx src/auth/cli.ts add-member --email <email> [--role member|admin] [--name <name>]
//   tsx src/auth/cli.ts remove-member --email <email>
//   tsx src/auth/cli.ts list-members
//
// A password is only ever read from the environment variable named by
// --password-env, never from argv (which lands in shell history and `ps`).
// Without one the member has no password login and signs in another way
// (Google, once it is enabled).
//
// Exit code 0 on success, 1 on a refusal or failure; messages say which.

import { parseArgs } from "node:util";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db, pool, schema } from "../db/index.js";
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

async function listMembers(): Promise<void> {
  const account = await requireAccount();
  const rows = await db
    .select()
    .from(schema.accountMembers)
    .where(eq(schema.accountMembers.accountId, account.id))
    .orderBy(asc(schema.accountMembers.createdAt));
  say(`${account.name} (${account.slug}) — ${rows.length} member(s)`);
  for (const m of rows) {
    const state = m.removedAt ? "removed" : m.joinedAt ? "active" : "invited (not signed in yet)";
    process.stdout.write(`  ${m.email.padEnd(36)} ${m.role.padEnd(7)} ${state}\n`);
  }
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
    default:
      throw new Refusal(
        "usage: init-account | bootstrap-admin | add-member | remove-member | list-members (see the header of src/auth/cli.ts)",
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
  .finally(async () => {
    await pool.end();
  });
