// The recorder's OAuth client (SAA-244): the only client that can obtain a
// capture token.
//
// One public client per instance, created here and not by dynamic registration,
// which is open to anyone and is deliberately kept from the capture scope and
// the capture resource (auth/auth.ts). There is no secret to keep: it is a
// native app, so it proves itself with PKCE (S256) and a loopback redirect. The
// library matches a loopback redirect with the port ignored (RFC 8252 §8.3;
// oauth-provider authorize:5427-5446), so the one registered address serves
// whatever port the recorder listens on.
//
// What makes it the only one: it is registered with the capture scope (a
// dynamic client's scopes are pinned to the MCP four), and it is the only
// client linked to the capture resource (oauthClientResource), which the
// provider enforces per client by default (introspect:481-482, 538-553, 618-627).
//
// Each member signs in once from the recorder and the token's subject says who
// they are; there is no per-member client. Re-running is safe: it puts the
// client back to what is written here.

import { authConfigFromEnv, getAuth } from "./auth.js";
import { CAPTURE_RESOURCE_SCOPES } from "./scopes.js";
import { Refusal } from "./members.js";

export const RECORDER_CLIENT_ID = "clipwise-recorder";
export const RECORDER_CLIENT_NAME = "Clipwise Recorder";
export const RECORDER_REDIRECT_URI = "http://127.0.0.1/callback";

export type RecorderClientResult = {
  created: boolean;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
};

export async function ensureRecorderClient(): Promise<RecorderClientResult> {
  const cfg = authConfigFromEnv();
  const ctx = await getAuth().$context;
  const adapter = ctx.adapter;

  // The capture resource is seeded from the provider's options (insertOnly: a
  // row that exists is never changed, introspect:781-783, 860). If it is not
  // there yet, the link below would have nothing to point at.
  const resource = await adapter.findOne({
    model: "oauthResource",
    where: [{ field: "identifier", value: cfg.captureResource }],
  });
  if (!resource) {
    throw new Refusal(
      `the capture resource ${cfg.captureResource} has no row in oauthResource. Start the server once, or run ` +
        "`npm run auth:migrate`, so the provider seeds it, then run this again.",
    );
  }

  const now = new Date();
  const scopes = [...CAPTURE_RESOURCE_SCOPES];
  const fields = {
    name: RECORDER_CLIENT_NAME,
    disabled: false,
    scopes,
    redirectUris: [RECORDER_REDIRECT_URI],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    applicationType: "native",
    subjectType: "public",
    requirePKCE: true,
    updatedAt: now,
  };

  const existing = await adapter.findOne({
    model: "oauthClient",
    where: [{ field: "clientId", value: RECORDER_CLIENT_ID }],
  });
  if (existing) {
    await adapter.update({
      model: "oauthClient",
      where: [{ field: "clientId", value: RECORDER_CLIENT_ID }],
      update: fields,
    });
  } else {
    await adapter.create({
      model: "oauthClient",
      data: { clientId: RECORDER_CLIENT_ID, createdAt: now, ...fields },
    });
  }

  const link = await adapter.findOne({
    model: "oauthClientResource",
    where: [
      { field: "clientId", value: RECORDER_CLIENT_ID },
      { field: "resourceId", value: cfg.captureResource },
    ],
  });
  if (!link) {
    await adapter.create({
      model: "oauthClientResource",
      data: { clientId: RECORDER_CLIENT_ID, resourceId: cfg.captureResource },
    });
  }

  return {
    created: !existing,
    clientId: RECORDER_CLIENT_ID,
    redirectUri: RECORDER_REDIRECT_URI,
    resource: cfg.captureResource,
    scopes,
  };
}
