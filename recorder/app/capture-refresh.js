// The recorder's capture-token refresh: the form post to the token endpoint,
// and one refresh with a refresh token. The caller passes the tokens it holds,
// the client id, and what to do on a refused grant (signOut) and with new
// tokens (store). It requires nothing from Electron.

'use strict';

// The token endpoint's reply, read for its status, its error code and the
// tokens; nothing from it is logged but the first two. A signal, when passed,
// ends the request. A body that can't be read is {}, with the error that
// reading it threw in bodyError (null when it was read).
async function postCaptureTokenForm(server, form, signal) {
    const res = await fetch(`${server}/api/auth/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
        signal,
    });
    let body = {};
    let bodyError = null;
    try {
        body = await res.json();
    } catch (err) {
        bodyError = err;
    }
    return { status: res.status, body, bodyError };
}

const REFRESH_TIMEOUT_MS = 8000;
const REFRESH_ATTEMPTS = 3;

// Each request ends after REFRESH_TIMEOUT_MS. A thrown error (the network or
// the timeout), or a 2xx reply whose body can't be read, is retried at once, up
// to REFRESH_ATTEMPTS requests in all; any other HTTP reply ends the retries.
// Signed out only when the token endpoint refuses the grant (400 or 401).
// Resolves 'refreshed', 'signed-out', 'kept-network' (every request failed so)
// or 'kept-reply' (another status, or a reply with no token); both 'kept-'
// outcomes keep the stored tokens.
async function refreshCaptureTokens(tokens, clientId, { signOut, store }) {
    let reply = null;
    for (let attempt = 1; !reply && attempt <= REFRESH_ATTEMPTS; attempt++) {
        try {
            const sent = await postCaptureTokenForm(tokens.server, {
                grant_type: 'refresh_token',
                refresh_token: tokens.refresh,
                client_id: clientId,
                resource: `${tokens.server}/capture`,
            }, AbortSignal.timeout(REFRESH_TIMEOUT_MS));
            if (sent.status >= 200 && sent.status < 300 && sent.bodyError) throw sent.bodyError;
            reply = sent;
        } catch (err) {
            console.error(`[clipwise-recorder] capture token: refresh failed, kept: ${err.cause?.code || err.name} (attempt ${attempt} of ${REFRESH_ATTEMPTS})`);
        }
    }
    if (!reply) return 'kept-network';
    const { status, body } = reply;
    if (!body.access_token) {
        if (status === 400 || status === 401) {
            signOut(`refresh ${status} ${body.error || 'no_token'}`);
            return 'signed-out';
        }
        console.error(`[clipwise-recorder] capture token: refresh ${status} ${body.error || 'no_token'}, kept`);
        return 'kept-reply';
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
        return 'signed-out';
    }
    console.error(`[clipwise-recorder] capture token: refreshed (${status})`);
    return 'refreshed';
}

module.exports = { postCaptureTokenForm, refreshCaptureTokens };
