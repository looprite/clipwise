// Sign-in for the instance: Better Auth as the authorization server for
// claude.ai and Claude Code (the MCP plugin), plus password sign-in for
// development and the personal instance. Google sign-in is the next step.
//
// What this file deliberately does not turn on, each tied to a published
// Better Auth advisory (checked 2026-10-08, all fixed in the pinned 1.7.7):
//   - no Magic Link, OAuth Proxy, SSO or SCIM plugins (GHSA-965c, -r4xp);
//   - implicit account linking is off, so a login can only be attached to an
//     existing user by that user, signed in (GHSA-g38m);
//   - rate-limit counters are in memory, not in Postgres (GHSA-44jh);
//   - sessions stay in the database, not secondary storage (GHSA-2vg6).
// Dynamic client registration IS on, because claude.ai registers itself
// without a session; /oauth2/register is therefore anonymous and is
// rate-limited below.
//
// Everything is configured from the environment (authConfigFromEnv) so the
// same code runs the CLI, the server and the checks.

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { pool } from "../db/index.js";
import { logError } from "../lib/safe-error.js";
import {
  decideSignIn,
  findMemberByAuthUserId,
  findMemberByEmail,
  linkMemberToUser,
} from "./membership.js";

export type AuthConfig = {
  secret: string;
  // Public origin of this instance, no trailing slash.
  baseURL: string;
  // The exact URL of the MCP endpoint, as the user enters it in Claude. Tokens
  // are bound to it, and the resource server checks `aud` against it.
  mcpResource: string;
  passwordEnabled: boolean;
  // When set, only emails on this domain may sign in (in addition to being
  // members). Null leaves the member list as the only gate.
  allowedDomain: string | null;
  // Header carrying the real client address behind a proxy (e.g. fly-client-ip).
  // Unset uses Better Auth's default, x-forwarded-for.
  ipAddressHeader: string | null;
  // Access-token lifetime in seconds.
  accessTokenSeconds: number;
};

export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be set to at least 32 characters (openssl rand -base64 32)");
  }
  const baseURL = (env.BETTER_AUTH_URL ?? "").replace(/\/$/, "");
  if (!baseURL) throw new Error("BETTER_AUTH_URL is required (the public origin of this instance)");
  return {
    secret,
    baseURL,
    mcpResource: env.MCP_RESOURCE_URL ?? `${baseURL}/mcp`,
    passwordEnabled: env.AUTH_PASSWORD_ENABLED === "true",
    allowedDomain: env.AUTH_ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase() || null,
    ipAddressHeader: env.AUTH_IP_HEADER?.trim().toLowerCase() || null,
    accessTokenSeconds: Number(env.AUTH_ACCESS_TOKEN_SECONDS ?? 600),
  };
}

export function createAuth(cfg: AuthConfig) {
  return betterAuth({
    appName: "Clipwise",
    baseURL: cfg.baseURL,
    secret: cfg.secret,
    database: pool,

    // Prefixed so these are recognisable in a SQL console and cannot be
    // mistaken for (or collide with) our own `accounts` table.
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session" },
    account: {
      modelName: "auth_account",
      accountLinking: { enabled: true, disableImplicitLinking: true },
    },
    verification: { modelName: "auth_verification" },

    emailAndPassword: {
      enabled: cfg.passwordEnabled,
      // Logins are created by an admin (src/auth/cli.ts), never by a visitor.
      disableSignUp: true,
      minPasswordLength: 12,
    },

    // Off in development by default in Better Auth; on here always. In-memory
    // counters are per process, which is right for one instance.
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: 60,
      max: 100,
      customRules: {
        // Slower and stricter than the built-in 3 per 10 s, which is a burst
        // limit and not a guess limit.
        "/sign-in/email": { window: 300, max: 10 },
        // Anonymous by design (claude.ai registers without a session).
        "/oauth2/register": { window: 3600, max: 20 },
      },
    },
    advanced: {
      ...(cfg.ipAddressHeader
        ? { ipAddress: { ipAddressHeaders: [cfg.ipAddressHeader] } }
        : {}),
    },

    databaseHooks: {
      user: {
        create: {
          // The one gate on becoming a user: the email must already be an active
          // member, on the allowed domain, and verified.
          before: async (user) => {
            const member = await findMemberByEmail(user.email);
            const decision = decideSignIn({
              email: user.email,
              emailVerified: user.emailVerified === true,
              allowedDomain: cfg.allowedDomain,
              member,
            });
            if (!decision.allowed) {
              throw new APIError("FORBIDDEN", { message: `sign_in_denied:${decision.reason}` });
            }
          },
          after: async (user) => {
            const member = await findMemberByEmail(user.email);
            if (member) await linkMemberToUser(member.id, { authUserId: user.id, displayName: user.name });
          },
        },
      },
      session: {
        create: {
          // A removed member's existing login must not mint new sessions.
          before: async (session) => {
            const member = await findMemberByAuthUserId(session.userId);
            if (!member || member.removedAt) {
              throw new APIError("FORBIDDEN", { message: "sign_in_denied:not_an_active_member" });
            }
          },
        },
      },
    },

    plugins: [
      jwt(),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: cfg.mcpResource,
        accessTokenExpiresIn: cfg.accessTokenSeconds,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

// Better Auth starts initialising (including a database read) the moment it is
// created and keeps the promise (better-auth/dist/auth/base.mjs), and nothing
// waits on it until a request arrives. With the database unreachable at that
// moment the rejection is unhandled and Node exits; and a rejected promise
// stays rejected, so every later sign-in would fail until a restart. So a
// failed init is handled here and the cached instance is dropped: the next
// getAuth() builds a fresh one, which retries the database.
let cached: Auth | null = null;
export function getAuth(): Auth {
  if (!cached) {
    const auth = createAuth(authConfigFromEnv());
    cached = auth;
    auth.$context.catch((err: unknown) => {
      logError("auth: initialisation failed, will retry on the next request", err);
      if (cached === auth) cached = null;
    });
  }
  return cached;
}
