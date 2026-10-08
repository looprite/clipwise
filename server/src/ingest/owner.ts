// Whose recording a capture is. The pipeline runs on the person's own Mac
// against the database directly, with no token to say who is calling, so the
// owner comes from configuration: CLIPWISE_OWNER_EMAIL in server/.env names the
// member whose Mac this is. (When captures arrive over the network instead,
// the ingest token will say.)
//
// Misconfiguration fails the ingest step rather than storing a recording
// nobody can see: the capture's audio and transcript stay on disk, the tray
// shows the failure, and a retry works once the setting is fixed.
//
//   - CLIPWISE_OWNER_EMAIL set: it must be an active member of the account.
//   - unset, exactly one active member: that member.
//   - unset, no members yet (an instance that has not been provisioned): null.
//     The recording is stored with no owner, visible to no one until
//     `auth bootstrap-admin --claim-existing` gives it one.
//   - unset, several members: refused — the pipeline cannot guess whose Mac it is.

import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export async function resolveOwnerMemberId(accountId: string): Promise<string | null> {
  const members = await db
    .select()
    .from(schema.accountMembers)
    .where(and(eq(schema.accountMembers.accountId, accountId), isNull(schema.accountMembers.removedAt)));

  const configured = process.env.CLIPWISE_OWNER_EMAIL?.trim().toLowerCase();
  if (configured) {
    const match = members.find((m) => m.email === configured);
    if (!match) {
      throw new Error(
        `CLIPWISE_OWNER_EMAIL is ${configured}, which is not an active member of this account. ` +
          `Fix server/.env (members: ${members.map((m) => m.email).join(", ") || "none"}).`,
      );
    }
    return match.id;
  }
  if (members.length === 0) return null;
  if (members.length === 1) return members[0].id;
  throw new Error(
    `${members.length} active members and CLIPWISE_OWNER_EMAIL is not set; the capture pipeline cannot tell whose recording this is. ` +
      "Set CLIPWISE_OWNER_EMAIL in server/.env.",
  );
}
