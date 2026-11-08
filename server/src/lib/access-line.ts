// The access line (SAA-277): one line to stdout, which the host keeps (on Fly,
// the app log), for every read of call content. Who read, through which route,
// and which recordings:
//
//   access: member=<member id> route=<name> recording=<recording id>
//   access: member=<member id> route=<name> recordings=<n> ids=<id>,<id>,…   (a search)
//
// A search writes one line per call, listing each recording that appears in what
// was returned once, in result order, with the count; ids=none when it returned
// nothing. Ids rather than only a count, so that the log can answer who read a
// given call; an id is not call content.
//
// It holds nothing of the call: no text, no title, not the search words. The
// route is one of the fixed names below, and every id is checked to be a UUID
// (anything else is written as "invalid"), so nothing a caller sends or a row
// holds can reach the line. Written once the read has succeeded and before the
// response is sent; a read that finds nothing writes no line.

export const ACCESS_ROUTES = [
  "transcript", //          GET /recordings/:id/transcript
  "moment", //              GET /accounts/:accountId/moments/:id
  "moments.search", //      GET /accounts/:accountId/moments
  "capture.transcript", //  GET /captures/:captureId/transcript (the saved file)
  "mcp.search_moments",
  "mcp.get_transcript",
] as const;
export type AccessRoute = (typeof ACCESS_ROUTES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeId = (v: unknown): string => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : "invalid");
const safeRoute = (r: AccessRoute): string => ((ACCESS_ROUTES as readonly string[]).includes(r) ? r : "invalid");

export function accessLine(memberId: string, route: AccessRoute, recordingId: string): string {
  return `access: member=${safeId(memberId)} route=${safeRoute(route)} recording=${safeId(recordingId)}`;
}

export function searchAccessLine(memberId: string, route: AccessRoute, recordingIds: readonly unknown[]): string {
  const ids = [...new Set(recordingIds.map(safeId))];
  return `access: member=${safeId(memberId)} route=${safeRoute(route)} recordings=${ids.length} ids=${ids.length > 0 ? ids.join(",") : "none"}`;
}

// The recordings in a search result as returned: moments[].recordingId for a
// moment search, recordings[].id for the index.
export function recordingIdsOf(result: unknown): unknown[] {
  const r = (result ?? {}) as { moments?: Array<{ recordingId?: unknown }>; recordings?: Array<{ id?: unknown }> };
  if (Array.isArray(r.moments)) return r.moments.map((m) => m?.recordingId);
  if (Array.isArray(r.recordings)) return r.recordings.map((x) => x?.id);
  return [];
}

export function logAccess(memberId: string, route: AccessRoute, recordingId: string): void {
  console.log(accessLine(memberId, route, recordingId));
}

export function logSearchAccess(memberId: string, route: AccessRoute, result: unknown): void {
  console.log(searchAccessLine(memberId, route, recordingIdsOf(result)));
}
