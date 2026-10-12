// Every route and every MCP tool, and who may use it. check-access.ts builds
// the real app, lists its routes, and fails on any route that is not in
// this table (and on any entry here that no longer exists), then checks the
// behaviour of each class. Adding an endpoint therefore means deciding, here,
// who can call it, and with which kind of token.
//
//   public  Reachable without a token, by design. The note says what gates it.
//   member  Any active member of the account; what comes back is filtered to
//           what that member may see (access/visibility.ts).
//   owner   An active member, and the recording it acts on must be theirs;
//           anyone else gets the same 404 as for a recording that is not there.
//   admin   An active admin.
//
// `access` is who; `requires` is which token (SAA-244), and is stated for every
// entry rather than defaulted:
//
//   public   No token.
//   mcp      An MCP token: audience …/mcp (claude.ai, Claude Code). A capture
//            token is refused with the same 401 as any token for another resource.
//   capture  A capture token: audience …/capture and scope clipwise:capture
//            (the recorder). A valid MCP token is refused with 403
//            insufficient_scope.
//   session  A signed-in browser session (Better Auth's cookie), no token: a
//            page a person opens themselves. Either kind of token is refused
//            with 401.
//
// check-access gives every non-public entry a token of each kind and fails on
// any entry whose behaviour differs from what it says here.

export type Access = "public" | "member" | "owner" | "admin";
export type Requires = "public" | "mcp" | "capture" | "session";

export const ROUTES: Record<string, { access: Access; requires: Requires; note: string }> = {
  "GET /live": { access: "public", requires: "public", note: "liveness; no database, no data" },
  "GET /health": { access: "public", requires: "public", note: "status only; no data" },
  "GET /favicon.svg": { access: "public", requires: "public", note: "the Clipwise tab icon, a static image; no data" },
  "GET /favicon.ico": { access: "public", requires: "public", note: "the same icon at the address browsers request on their own; no data" },
  "ALL /api/auth/*": {
    access: "public",
    requires: "public",
    note: "Better Auth: sign-in, OAuth and token endpoints, with their own checks and rate limits",
  },
  "GET /.well-known/oauth-protected-resource": { access: "public", requires: "public", note: "discovery document: names the MCP resource and its authorization server" },
  "GET /.well-known/oauth-protected-resource/mcp": { access: "public", requires: "public", note: "same document at the path-inserted location" },
  "GET /.well-known/oauth-authorization-server/api/auth": { access: "public", requires: "public", note: "Better Auth's server metadata at the RFC 8414 location" },
  "GET /login": { access: "public", requires: "public", note: "sign-in page for the OAuth flow; strict CSP, posts to Better Auth" },
  "GET /consent": { access: "public", requires: "public", note: "consent page for the OAuth flow; needs a session to do anything" },
  "POST /mcp": { access: "member", requires: "mcp", note: "the MCP endpoint; tools below run as the caller" },
  "GET /mcp": { access: "member", requires: "mcp", note: "405 after authentication (stateless server: no stream, no session)" },
  "DELETE /mcp": { access: "member", requires: "mcp", note: "405 after authentication (no session to end)" },
  "GET /oauth/google/callback": {
    access: "public",
    requires: "public",
    note: "Google's redirect carries no token; gated by the single-use state /connect issued and the session of the member who started it",
  },
  "GET /oauth/google/connect": { access: "member", requires: "session", note: "starts a calendar connection for the signed-in member's own calendar" },

  "POST /captures": {
    access: "member",
    requires: "capture",
    note: "stores a finished capture as a recording owned by the caller (account and owner from the token); a repeat of the caller's own capture is idempotent, another member's capture id is 409",
  },

  // The recorder's own captures (SAA-227, 10-11): a capture token for reads too,
  // and only the caller's own capture; anyone else's is the same 404 as one that
  // is not there.
  "GET /captures/:captureId/transcript": { access: "owner", requires: "capture", note: "the saved transcript file of the caller's own capture, dated in ?tz= (IANA) when given; a trashed one is 404" },
  "POST /captures/:captureId/trash": { access: "owner", requires: "capture", note: "sets trashed_at on the caller's own capture" },
  "POST /captures/:captureId/restore": { access: "owner", requires: "capture", note: "clears trashed_at on the caller's own capture" },
  "DELETE /captures/:captureId": { access: "owner", requires: "capture", note: "deletes the caller's own capture, only from the trash (409 otherwise)" },
  "GET /captures/:captureId/jobs": { access: "owner", requires: "capture", note: "kind, state and attempts of the caller's own capture's jobs, no error text; and its calendar match once one is done: title and invitee names (an address when there is no name)" },

  "GET /accounts/me": { access: "member", requires: "mcp", note: "the caller's own account and membership" },

  "GET /accounts/:accountId/people": { access: "member", requires: "mcp", note: "people on recordings the caller can see, plus unattached ones" },
  "GET /accounts/:accountId/people/:id": { access: "member", requires: "mcp", note: "same filter as the list" },

  "POST /accounts/:accountId/recordings": { access: "member", requires: "capture", note: "creates a recording owned by the caller" },
  "GET /accounts/:accountId/recordings": { access: "member", requires: "mcp", note: "recordings the caller can see" },
  "GET /accounts/:accountId/recordings/:id": { access: "member", requires: "mcp", note: "404 unless the caller can see it" },
  "POST /accounts/:accountId/recordings/:id/attendees": { access: "owner", requires: "capture", note: "only the recording's owner" },
  "GET /accounts/:accountId/recordings/:id/attendees": { access: "member", requires: "mcp", note: "404 unless the caller can see it" },

  // No caller exists; capture closes it to MCP tokens; a curation requirement is named when a caller exists.
  "POST /accounts/:accountId/moments": { access: "owner", requires: "capture", note: "hand-curated moment; only the recording's owner" },
  "GET /accounts/:accountId/moments": { access: "member", requires: "mcp", note: "search and index, filtered to what the caller can see" },
  "GET /accounts/:accountId/moments/:id": { access: "member", requires: "mcp", note: "404 unless the caller can see it" },

  "GET /recordings/:id/transcript": { access: "member", requires: "mcp", note: "404 unless the caller can see the recording" },
};

// The tools Claude calls, served at /mcp. check-access.ts asks the running server
// for its actual tool list and fails if it differs from this table. Both are
// read-only and go through the same services as the routes above.
export const MCP_TOOLS: Record<string, { access: Access; requires: Requires; note: string }> = {
  search_moments: { access: "member", requires: "mcp", note: "services/search-moments.ts, filtered like GET .../moments" },
  get_transcript: { access: "member", requires: "mcp", note: "services/transcript.ts getTranscriptPage: paged text; not found unless the caller can see the recording" },
};
