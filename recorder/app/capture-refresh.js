// The recorder's capture-token refresh: the form post to the token endpoint,
// and one refresh with a refresh token. The caller passes the tokens it holds,
// the client id, and what to do on a refused grant (signOut) and with new
// tokens (store). It requires nothing from Electron.

'use strict';

// The token endpoint's reply, read for its status, its error code and the
// tokens; nothing from it is logged but the first two.
async function postCaptureTokenForm(server, form) {
    const res = await fetch(`${server}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
}

// Signed out only when the token endpoint refuses the grant (400 or 401). A
// network error or any other status keeps the stored tokens; the next use (an
// upload's 401) tries again.
async function refreshCaptureTokens(tokens, clientId, { signOut, store }) {
    let reply;
    try {
        reply = await postCaptureTokenForm(tokens.server, {
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh,
            client_id: clientId,
            resource: `${tokens.server}/capture`,
        });
    } catch (err) {
        console.error(`[clipwise-recorder] capture token: refresh failed, kept: ${err.cause?.code || err.name}`);
        return false;
    }
    const { status, body } = reply;
    if (!body.access_token) {
        if (status === 400 || status === 401) {
            signOut(`refresh ${status} ${body.error || 'no_token'}`);
        } else {
            console.error(`[clipwise-recorder] capture token: refresh ${status} ${body.error || 'no_token'}, kept`);
        }
        return false;
    }
    try {
        store({
            server: tokens.server,
            access: body.access_token,
            refresh: body.refresh_token || tokens.refresh,
            expiresAt: Date.now() + Number(body.expires_in) * 1000,
        });
    } catch (err) {
        signOut(`could not store the refreshed token: ${err.name}`);
        return false;
    }
    console.error(`[clipwise-recorder] capture token: refreshed (${status})`);
    return true;
}

module.exports = { postCaptureTokenForm, refreshCaptureTokens };
