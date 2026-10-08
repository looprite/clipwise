// Regression check for decideSignIn: who may become a user. Pure — no
// database, no network. Same plain-script/exit-code shape as
// check-assign-voice.ts.
//
// Usage:
//   tsx src/auth/check-membership.ts

import { decideSignIn, normalizeEmail, type MemberRow } from "./membership.js";

function member(over: Partial<MemberRow> = {}): MemberRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    accountId: "00000000-0000-0000-0000-0000000000aa",
    email: "pat@example.test",
    displayName: null,
    role: "member",
    authUserId: null,
    joinedAt: null,
    removedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

type Case = {
  name: string;
  input: Parameters<typeof decideSignIn>[0];
  expect: "allowed" | "domain_not_allowed" | "not_a_member" | "member_removed" | "email_not_verified";
};

const CASES: Case[] = [
  {
    name: "an active, verified member is allowed",
    input: { email: "pat@example.test", emailVerified: true, allowedDomain: null, member: member() },
    expect: "allowed",
  },
  {
    name: "an invited member who has never signed in is allowed (joined_at is not required)",
    input: { email: "pat@example.test", emailVerified: true, allowedDomain: null, member: member({ joinedAt: null }) },
    expect: "allowed",
  },
  {
    name: "an email that is not on the list is refused — there is no sign-up",
    input: { email: "stranger@example.test", emailVerified: true, allowedDomain: null, member: null },
    expect: "not_a_member",
  },
  {
    name: "a removed member is refused even with a verified email",
    input: {
      email: "pat@example.test",
      emailVerified: true,
      allowedDomain: null,
      member: member({ removedAt: new Date(1) }),
    },
    expect: "member_removed",
  },
  {
    name: "an unverified email is refused even for a member",
    input: { email: "pat@example.test", emailVerified: false, allowedDomain: null, member: member() },
    expect: "email_not_verified",
  },
  {
    name: "wrong domain is refused before membership is consulted (a member row does not rescue it)",
    input: {
      email: "pat@example.test",
      emailVerified: true,
      allowedDomain: "looprite.ai",
      member: member(),
    },
    expect: "domain_not_allowed",
  },
  {
    name: "wrong domain with no member row reports the domain, not membership — nothing is revealed about the list",
    input: { email: "x@gmail.test", emailVerified: true, allowedDomain: "looprite.ai", member: null },
    expect: "domain_not_allowed",
  },
  {
    name: "matching domain and an active member is allowed; domain case and whitespace do not matter",
    input: {
      email: "Pat@Looprite.AI",
      emailVerified: true,
      allowedDomain: " LOOPRITE.ai ",
      member: member({ email: "pat@looprite.ai" }),
    },
    expect: "allowed",
  },
  {
    name: "a look-alike domain is not the allowed domain (suffix, subdomain, prefix)",
    input: { email: "pat@evil-looprite.ai", emailVerified: true, allowedDomain: "looprite.ai", member: member() },
    expect: "domain_not_allowed",
  },
  {
    name: "a subdomain is not the allowed domain",
    input: { email: "pat@mail.looprite.ai", emailVerified: true, allowedDomain: "looprite.ai", member: member() },
    expect: "domain_not_allowed",
  },
];

let failed = 0;
for (const c of CASES) {
  const got = decideSignIn(c.input);
  const actual = got.allowed ? "allowed" : got.reason;
  const ok = actual === c.expect;
  if (!ok) failed++;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${c.name}${ok ? "" : ` — expected ${c.expect}, got ${actual}`}\n`);
}

const emailOk = normalizeEmail("  Pat@Example.TEST ") === "pat@example.test";
if (!emailOk) failed++;
process.stdout.write(`${emailOk ? "ok  " : "FAIL"} normalizeEmail trims and lowercases\n`);

process.stdout.write(`\n${CASES.length + 1 - failed}/${CASES.length + 1} passed\n`);
process.exit(failed === 0 ? 0 : 1);
