// Sign-in for the instance: Better Auth as the authorization server for
// claude.ai and Claude Code (the MCP plugin), with Google sign-in (when its
// client is configured) and password sign-in (when AUTH_PASSWORD_ENABLED is
// on: development, checks, self-hosting).
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
import { APIError, createAuthMiddleware, getOAuthState, getSessionFromCtx } from "better-auth/api";
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
import { CAPTURE_RESOURCE_SCOPES, CAPTURE_SCOPE, MCP_SCOPES } from "./scopes.js";
import { CALENDAR_READONLY_SCOPE, consentAfterSignIn, parkGoogleTokens, storeParkedGrant } from "./google-calendar-grant.js";

export type AuthConfig = {
  secret: string;
  // Public origin of this instance, no trailing slash.
  baseURL: string;
  // The exact URL of the MCP endpoint, as the user enters it in Claude. Tokens
  // are bound to it, and the resource server checks `aud` against it.
  mcpResource: string;
  // The audience of the recorder's tokens (SAA-244): <baseURL>/capture. Not a
  // route; an identifier that a capture token names and /mcp does not accept.
  captureResource: string;
  passwordEnabled: boolean;
  // Google sign-in, on only when both the client ID and secret are set. The
  // same OAuth client as the calendar connection (routes/oauth.ts).
  google: { clientId: string; clientSecret: string } | null;
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
  const googleClientId = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  return {
    secret,
    baseURL,
    mcpResource: env.MCP_RESOURCE_URL ?? `${baseURL}/mcp`,
    captureResource: `${baseURL}/capture`,
    passwordEnabled: env.AUTH_PASSWORD_ENABLED === "true",
    google:
      googleClientId && googleClientSecret ? { clientId: googleClientId, clientSecret: googleClientSecret } : null,
    allowedDomain: env.AUTH_ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase() || null,
    ipAddressHeader: env.AUTH_IP_HEADER?.trim().toLowerCase() || null,
    accessTokenSeconds: Number(env.AUTH_ACCESS_TOKEN_SECONDS ?? 600),
  };
}

// The refusal from the user and session hooks below. It carries a code because
// Better Auth's OAuth callback sends an error to the sign-in's error URL
// (/login) only when the error has one (better-auth api/routes/callback.mjs:192);
// without it a refused Google sign-in ends on raw JSON. The code and message
// reach the address bar, so neither names the reason.
const SIGN_IN_DENIED = "SIGN_IN_DENIED"; // pages.ts's /login and check-auth match this string
function signInDenied(): APIError {
  return new APIError("FORBIDDEN", { code: SIGN_IN_DENIED, message: "This account can't sign in to this Clipwise instance." });
}

// `control` is for check-access's SAA-244 control only: it builds its own
// instance without clientRegistrationDefaultScopes, to show that the assertion
// about dynamic clients and the capture scope fails without it. getAuth() never
// passes it.
export function createAuth(cfg: AuthConfig, control: { omitRegistrationDefaultScopes?: boolean } = {}) {
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

    // Google sign-in is one screen for identity and the calendar (SAA-198 step 5,
    // Jon's call 5, reversing K decision 5): the provider's default scopes
    // (openid, email, profile) plus calendar.readonly, with offline access so a
    // first grant brings a refresh token. No prompt is forced, so a returning
    // member is not asked again (engineering call 12), unless they have no
    // calendar connection (the after-hook below, Jon's call 12). The tokens never reach
    // auth_account: the account hooks below hand them to google-calendar-grant.ts,
    // which stores them encrypted in calendar_connections. hd asks Google for the
    // allowed domain and is checked against the id token's hd claim
    // (@better-auth/core social-providers/google.mjs:114, :120-123); the domain
    // rule at user creation below still applies on top of it. A user created by a
    // password login gains Google only through the explicit link call while
    // signed in, because implicit linking is off. includeGrantedScopes stays off:
    // the request names every scope it wants.
    socialProviders: cfg.google
      ? {
          google: {
            clientId: cfg.google.clientId,
            clientSecret: cfg.google.clientSecret,
            scope: [CALENDAR_READONLY_SCOPE],
            accessType: "offline",
            includeGrantedScopes: false,
            ...(cfg.allowedDomain ? { hd: cfg.allowedDomain } : {}),
          },
        }
      : {},

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
            if (!decision.allowed) throw signInDenied();
          },
          after: async (user) => {
            const member = await findMemberByEmail(user.email);
            if (member) await linkMemberToUser(member.id, { authUserId: user.id, displayName: user.name });
          },
        },
      },
      // Google's tokens go to calendar_connections, encrypted, and never into
      // auth_account (google-calendar-grant.ts). Every path that writes a Google
      // account passes one of these.
      account: {
        create: {
          before: async (account) => parkGoogleTokens(account),
          after: async (account, context) => {
            await storeParkedGrant(account, context);
          },
        },
        update: {
          before: async (account) => parkGoogleTokens(account),
          after: async (account, context) => {
            await storeParkedGrant(account, context);
          },
        },
      },
      session: {
        create: {
          // A removed member's existing login must not mint new sessions.
          before: async (session) => {
            const member = await findMemberByAuthUserId(session.userId);
            if (!member || member.removedAt) throw signInDenied();
          },
        },
      },
    },

    // Google's callback, where every Google sign-in ends (/login, the
    // recorder's and claude.ai's OAuth requests, and Link Google). When this
    // request's grant came without a refresh token and the member has no
    // calendar connection, the browser goes on to Google's consent screen
    // instead, and from there to the sign-in's own destination
    // (google-calendar-grant.ts consentAfterSignIn), for the session this
    // sign-in made (a sign-in) or already had (Link Google). Anything else,
    // including an error redirect, keeps Better Auth's redirect.
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/callback/:id") return;
        const destination = ctx.context.responseHeaders?.get("location");
        const state = await getOAuthState();
        if (!destination || destination !== state?.callbackURL) return;
        const session = ctx.context.newSession ?? (await getSessionFromCtx(ctx));
        if (!session) return;
        const consent = await consentAfterSignIn(ctx, destination, new URL(ctx.context.baseURL).origin, {
          sessionId: session.session.id,
          secret: cfg.secret,
        });
        if (consent) throw ctx.redirect(consent);
      }),
    },

    plugins: [
      jwt(),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: cfg.mcpResource,
        // SAA-244. The capture scope exists, but only the recorder's client can
        // have it:
        //  - `scopes` must name it for a token to carry it;
        //  - clientRegistrationDefaultScopes pins what a dynamically registered
        //    client gets (and may ask for) to the four it always had. Without it
        //    the default is `scopes`, and every such client would be registered
        //    with the capture scope (oauth-provider authorize:1615-1616, 1917-1919);
        //  - advertisedMetadata keeps the published scopes_supported the four, so
        //    nothing a client reads from discovery changes;
        //  - the capture resource is not among the resources a dynamic client may
        //    register for (the mcp plugin adds only the MCP resource to those), and
        //    per-client resource enforcement (on by default) refuses any client not
        //    linked to it. allowedScopes limits what a token for it can carry.
        scopes: [...MCP_SCOPES, CAPTURE_SCOPE],
        ...(control.omitRegistrationDefaultScopes ? {} : { clientRegistrationDefaultScopes: [...MCP_SCOPES] }),
        advertisedMetadata: { scopes_supported: [...MCP_SCOPES] },
        // The resources are seeded insert-only: an existing oauthResource row keeps
        // its allowedScopes when this option changes, so a scope change needs the
        // row updated too (on every instance), not only this line.
        resources: [{ identifier: cfg.captureResource, allowedScopes: [...CAPTURE_RESOURCE_SCOPES] }],
        accessTokenExpiresIn: cfg.accessTokenSeconds,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        // The provider's default adds client_credentials, a machine-to-machine
        // grant with no user in it. Nothing here uses it (Claude does not
        // support it either, claude.com/docs/connectors/building/authentication),
        // and the access layer needs a member behind every token.
        grantTypes: ["authorization_code", "refresh_token"],
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

// For a script's last step. getAuth() starts Better Auth's initialisation (a
// database read, and seeding the OAuth resources) and nothing waits on it, so
// ending the pool right after leaves that work running against a closed pool:
// "Cannot use a pool after calling end on the pool". So: wait for the init that
// is in flight to settle (either way; a failure was already logged by getAuth),
// then end the pool. A script that never called getAuth() just ends the pool.
// This is for the end only: a script must not await the init BEFORE its own
// work, which may be what creates the tables the init reads (migrate.ts).
export async function endPoolWhenAuthSettled(): Promise<void> {
  const auth = cached;
  if (auth) await auth.$context.then(() => undefined, () => undefined);
  await pool.end();
}
