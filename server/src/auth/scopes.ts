// The scopes and resources this instance issues tokens for (SAA-244).
//
// Two kinds of token, told apart by their audience:
//   - "mcp": audience <BETTER_AUTH_URL>/mcp. What claude.ai and Claude Code get
//     by registering themselves. Scopes: the four below. Unchanged by SAA-244.
//   - "capture": audience <BETTER_AUTH_URL>/capture, scope clipwise:capture.
//     Only the recorder's client can obtain one (auth/recorder-client.ts): the
//     scope is left out of what a dynamically registered client may have, and
//     only that client is linked to the capture resource.
//
// What the discovery documents advertise stays the four MCP scopes; the capture
// scope is never published, so claude.ai has no reason to ask for it.

export const MCP_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

export const CAPTURE_SCOPE = "clipwise:capture";

// What a token for the capture resource may carry: an identity, a refresh token,
// and the capture scope. Anything else asked for alongside it is refused.
export const CAPTURE_RESOURCE_SCOPES = ["openid", "offline_access", CAPTURE_SCOPE] as const;

export type ExpectedResource = "mcp" | "capture";
