// Every route and every MCP tool, and who may use it. check-access.ts builds
// the real app, lists its routes, and fails on any route that is not in
// this table (and on any entry here that no longer exists), then checks the
// behaviour of each class. Adding an endpoint therefore means deciding, here,
// who can call it.
//
//   public  Reachable without a token, by design. The note says what gates it.
//   member  Any active member of the account; what comes back is filtered to
//           what that member may see (access/visibility.ts).
//   owner   An active member, and the recording it acts on must be theirs;
//           anyone else gets the same 404 as for a recording that is not there.
//   admin   An active admin.

export type Access = "public" | "member" | "owner" | "admin";

export const ROUTES: Record<string, { access: Access; note: string }> = {
  "GET /live": { access: "public", note: "liveness; no database, no data" },
  "GET /health": { access: "public", note: "status only; no data" },
  "GET /favicon.svg": { access: "public", note: "the Clipwise tab icon, a static image; no data" },
  "GET /favicon.ico": { access: "public", note: "the same icon at the address browsers request on their own; no data" },
  "ALL /api/auth/*": {
    access: "public",
    note: "Better Auth: sign-in, OAuth and token endpoints, with their own checks and rate limits",
  },
  "GET /.well-known/oauth-protected-resource": { access: "public", note: "discovery document: names the MCP resource and its authorization server" },
  "GET /.well-known/oauth-protected-resource/mcp": { access: "public", note: "same document at the path-inserted location" },
  "GET /.well-known/oauth-authorization-server/api/auth": { access: "public", note: "Better Auth's server metadata at the RFC 8414 location" },
  "GET /login": { access: "public", note: "sign-in page for the OAuth flow; strict CSP, posts to Better Auth" },
  "GET /consent": { access: "public", note: "consent page for the OAuth flow; needs a session to do anything" },
  "POST /mcp": { access: "member", note: "the MCP endpoint; tools below run as the caller" },
  "GET /mcp": { access: "member", note: "405 after authentication (stateless server: no stream, no session)" },
  "DELETE /mcp": { access: "member", note: "405 after authentication (no session to end)" },
  "GET /oauth/google/callback": {
    access: "public",
    note: "Google's redirect carries no token; gated by the single-use state an admin's /connect issued",
  },
  "GET /oauth/google/connect": { access: "admin", note: "starts a calendar connection for the caller's own account" },

  "GET /accounts/me": { access: "member", note: "the caller's own account and membership" },

  "GET /accounts/:accountId/people": { access: "member", note: "people on recordings the caller can see, plus unattached ones" },
  "GET /accounts/:accountId/people/:id": { access: "member", note: "same filter as the list" },

  "POST /accounts/:accountId/recordings": { access: "member", note: "creates a recording owned by the caller" },
  "GET /accounts/:accountId/recordings": { access: "member", note: "recordings the caller can see" },
  "GET /accounts/:accountId/recordings/:id": { access: "member", note: "404 unless the caller can see it" },
  "POST /accounts/:accountId/recordings/:id/attendees": { access: "owner", note: "only the recording's owner" },
  "GET /accounts/:accountId/recordings/:id/attendees": { access: "member", note: "404 unless the caller can see it" },

  "POST /accounts/:accountId/moments": { access: "owner", note: "hand-curated moment; only the recording's owner" },
  "GET /accounts/:accountId/moments": { access: "member", note: "search and index, filtered to what the caller can see" },
  "GET /accounts/:accountId/moments/:id": { access: "member", note: "404 unless the caller can see it" },

  "GET /recordings/:id/transcript": { access: "member", note: "404 unless the caller can see the recording" },
  "POST /recordings/:id/transcript": { access: "owner", note: "only the recording's owner" },
};

// The tools Claude calls, served at /mcp. check-access.ts asks the running server
// for its actual tool list and fails if it differs from this table. Both are
// read-only and go through the same services as the routes above.
export const MCP_TOOLS: Record<string, { access: Access; note: string }> = {
  search_moments: { access: "member", note: "services/search-moments.ts, filtered like GET .../moments" },
  get_transcript: { access: "member", note: "services/transcript.ts getTranscriptPage: paged text; not found unless the caller can see the recording" },
};
