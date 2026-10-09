// Who is asking. Built once per request by access/authenticate.ts from a
// verified token plus a lookup of the member row, and handed to every service
// that reads recording content. A function that takes an AccessContext cannot
// be called without an answer to "who is asking", which is the point.

export type Role = "admin" | "member";

export type AccessContext = {
  accountId: string;
  // account_members.id — the identity inside the instance, and what
  // recordings.owner_member_id refers to.
  memberId: string;
  role: Role;
  // Better Auth's user id (the token's `sub`).
  authUserId: string;
  email: string;
  // The scopes on the token this request came with (SAA-244). Which kind of
  // token a route accepts is decided before a handler runs (authenticate.ts);
  // this is here so a service can see what the caller was granted.
  scope: string[];
};
