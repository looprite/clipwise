// Lost-reply recovery for refresh tokens (SAA-251).
//
// The provider rotates a refresh token on every refresh. When the reply never
// reaches the client (a timeout, a Mac that sleeps with the request in flight),
// the client still holds the token it sent, and presents it again. Inside the
// token's reuse window (30 seconds, @better-auth/mcp index.mjs:170) the library
// answers with the reply it stored. After the window it deletes the whole
// family, client and user, as a stolen-token signal (oauth-provider
// introspect-CNR06Oy3.mjs:2160, invalidateRefreshFamily :1498-1527), and the
// member is signed out. That is what happened on 10-20 and 10-22.
//
// So before the library sees such a request, this hook looks at the presented
// token. When it was rotated, its window has passed, and nothing has used its
// successor since, the client lost the reply: the request's refresh_token is
// replaced with the successor, and the library rotates that as an ordinary
// refresh, with a fresh access token and a new refresh token. The successor is
// in the presented token's stored replay reply (encrypted with the auth secret,
// introspect :1707-1721, :1866-1882).
//
// The recovery follows a chain when its own replies were lost too: original →
// successor rotated by a recovery for that same original → that one's successor,
// and so on, as long as each link was rotated by a recovery for the original
// (refresh_token_recoveries says which). The first unused link is rotated.
// Anything else and the hook does nothing, so the library deletes the family as
// before:
//   - a link rotated by an ordinary refresh (someone used it: two holders);
//   - a link rotated by a recovery for a different token;
//   - a presented token that was itself rotated by a recovery (it is a link, not
//     an original, so a second holder of it is not recovered);
//   - a link revoked without being rotated, missing, expired, or of another
//     client or user, or a replay reply that cannot be read.
// Inside the window the hook does nothing either: the library's replay answers.
//
// The recovery is recorded by the after-hook, and only when the library's answer
// carries an access token, so a rotation the library refused leaves no row. The
// before-hook's decision reaches it through a WeakMap keyed by the request's
// context object, which nothing in the request can write.
//
// Depends on the provider's internals, not its API: the oauthRefreshToken
// columns, the stored-token hash (utils-D6Hp4Qd_.mjs:425-428) and the replay
// reply's shape. @better-auth/oauth-provider comes in through @better-auth/mcp's
// "^1.7.7"; package.json's overrides hold it at exactly 1.7.7, so a reinstall
// or a regenerated lock cannot move it. Changing that override needs
// check-access's recovery cases to pass first, which fail if any of this changes.

import { createHash } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { pool } from "../db/index.js";

// Links followed before giving up: each one is a lost recovery reply in a row.
const MAX_CHAIN = 10;

type RefreshRow = {
  id: string;
  clientId: string;
  userId: string;
  revoked: Date | null;
  rotatedAt: Date | null;
  until: Date | null;
  replay: string | null;
  expiresAt: Date;
};

type Pending = { clientId: string; userId: string; presentedId: string; rotatedId: string };
const pending = new WeakMap<object, Pending>();

// The form the provider stores a refresh token in (storeTokens "hashed"):
// SHA-256, base64url without padding.
function storedForm(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

async function findByToken(token: string): Promise<RefreshRow | null> {
  const { rows } = await pool.query<RefreshRow>(
    `select id, "clientId", "userId", revoked, "rotatedAt", "rotationReplayExpiresAt" as until,
            "rotationReplayResponse" as replay, "expiresAt"
       from "oauthRefreshToken" where token = $1`,
    [storedForm(token)],
  );
  return rows[0] ?? null;
}

// The refresh token the row's rotation handed out, from its stored replay
// reply; null when there is none or it cannot be read.
async function successorToken(row: RefreshRow, secretConfig: unknown): Promise<string | null> {
  if (!row.replay) return null;
  try {
    const replay = JSON.parse(await symmetricDecrypt({ key: secretConfig as Parameters<typeof symmetricDecrypt>[0]["key"], data: row.replay }));
    const token = replay?.response?.refresh_token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

// Whether a recovery rotated this row, and for which presented token.
async function rotatedByRecoveryFor(rowId: string): Promise<string | null> {
  const { rows } = await pool.query<{ presented: string }>(
    `select presented_token_id as presented from refresh_token_recoveries where rotated_token_id = $1`,
    [rowId],
  );
  return rows[0]?.presented ?? null;
}

type HookCtx = {
  path?: string;
  body?: any;
  context: { secretConfig?: unknown; returned?: unknown } & object;
};

// Before /oauth2/token. Returns the rewritten body for a recovery, or nothing.
export async function recoverLostRefreshReply(ctx: HookCtx): Promise<{ context: { body: Record<string, unknown> } } | undefined> {
  if (ctx.path !== "/oauth2/token") return;
  const body = ctx.body;
  if (body?.grant_type !== "refresh_token" || typeof body.refresh_token !== "string" || !body.refresh_token) return;
  const now = new Date();

  const presented = await findByToken(body.refresh_token);
  if (!presented || !presented.revoked || !presented.rotatedAt || !presented.until) return;
  // Inside the window (the library's own test, introspect :1723): its replay.
  if (presented.until >= now) return;
  if (typeof body.client_id === "string" && body.client_id && body.client_id !== presented.clientId) return;
  if (presented.expiresAt < now) return;
  // A token a recovery rotated is a link, never an original.
  if (await rotatedByRecoveryFor(presented.id)) return;

  let row = presented;
  for (let link = 1; link <= MAX_CHAIN; link++) {
    const token = await successorToken(row, ctx.context.secretConfig);
    if (!token) return;
    const next = await findByToken(token);
    if (!next || next.clientId !== presented.clientId || next.userId !== presented.userId) return;
    if (!next.revoked) {
      if (next.expiresAt < now) return;
      pending.set(ctx.context, { clientId: presented.clientId, userId: presented.userId, presentedId: presented.id, rotatedId: next.id });
      const ago = Math.round((now.getTime() - presented.rotatedAt.getTime()) / 1000);
      console.log(
        `auth: refresh recovery: client=${presented.clientId} user=${presented.userId}: a token rotated ${ago} s ago presented again; ` +
          `its successor${link > 1 ? ` (link ${link}, after ${link - 1} recovered)` : ""} was never used and is rotated in its place`,
      );
      return { context: { body: { ...body, refresh_token: token } } };
    }
    // Used: only a recovery for this same original lets the chain go on.
    if (!next.rotatedAt || (await rotatedByRecoveryFor(next.id)) !== presented.id) return;
    row = next;
  }
}

// After /oauth2/token. Records the recovery the before-hook made, once the
// library has answered it with tokens.
export async function recordRefreshRecovery(ctx: HookCtx): Promise<void> {
  if (ctx.path !== "/oauth2/token") return;
  const p = pending.get(ctx.context);
  if (!p) return;
  pending.delete(ctx.context);
  const returned = ctx.context.returned as { access_token?: unknown } | undefined;
  if (!returned || typeof returned !== "object" || typeof returned.access_token !== "string") return;
  // Two recoveries of the same original at once: the library lets one rotate
  // and answers the other from the stored replay, both with tokens; the row is
  // the same either way. Not closed: an ordinary refresh of the same successor
  // landing in the same instant can win the rotation, and this request is then
  // answered from its replay and recorded as the recovery that rotated it.
  // Both holders then hold the same tokens, as the library's own replay window
  // already allows.
  await pool.query(
    `insert into refresh_token_recoveries (client_id, user_id, presented_token_id, rotated_token_id)
     values ($1, $2, $3, $4) on conflict (rotated_token_id) do nothing`,
    [p.clientId, p.userId, p.presentedId, p.rotatedId],
  );
}
