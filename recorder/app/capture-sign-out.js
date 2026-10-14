// The tray's Sign out (SAA-198 step 5): the recorder's refresh token is revoked
// on the server, at the OAuth provider's revocation endpoint (RFC 7009), before
// the Mac's copy is removed. Without it, a signed-out recorder's refresh token
// stayed live on the server (seen on scratch 2026-10-13).
//
// The path is fixed (REVOKE_PATH), as the recorder's token and authorize paths
// already are in main.js; it is not read from the server's discovery document
// at sign-out. check-access asserts that the discovery document's
// revocation_endpoint is this same path, so the two cannot drift apart.
//
// main.js removes the Mac's copy whatever the outcome: a server that cannot be
// reached must not keep someone signed in. The outcome is a word and a status,
// never the token.
//
// Split out of main.js, like consent.js and setup.js, so it runs without
// Electron: the server's check-access calls this same function against a real
// server and then tries the token.

'use strict';

const REVOKE_PATH = '/api/auth/oauth2/revoke';
const REVOKE_TIMEOUT_MS = 10000;

// Resolves 'revoked (200)', 'refused (<status>)' or 'failed (<code>)'.
async function revokeRefreshToken(server, refreshToken, clientId) {
    try {
        const res = await fetch(`${server}${REVOKE_PATH}`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }),
            signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        });
        await res.arrayBuffer().catch(() => undefined);
        return res.ok ? `revoked (${res.status})` : `refused (${res.status})`;
    } catch (err) {
        return `failed (${(err && err.cause && err.cause.code) || (err && err.name) || 'error'})`;
    }
}

module.exports = { REVOKE_PATH, revokeRefreshToken };
