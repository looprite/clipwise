// Check for the brand assets the server carries. No database, no network.
//
//   BETTER_AUTH_SECRET=<32+ chars> BETTER_AUTH_URL=http://localhost:3000 \
//     DATABASE_URL=postgres://u:p@127.0.0.1:1/none npx tsx src/lib/check-brand.ts
// (the pages read the auth config and importing them opens a lazy pool; nothing
// connects.)
//
// The mark exists twice, favicon.svg at the repo root (the landing page uses it)
// and FAVICON_SVG in lib/brand.ts (the production image holds only the compiled
// server). This fails if they drift, and checks what the sign-in and consent
// pages say about the icon and what they may load.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FAVICON_SVG } from "./brand.js";
import { consentPage, loginPage } from "../auth/pages.js";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
  if (!ok) failures++;
}

const repoFavicon = readFileSync(resolve(import.meta.dirname, "..", "..", "..", "favicon.svg"), "utf8");
check("the server's copy of the mark is byte-for-byte the repo's favicon.svg", FAVICON_SVG === repoFavicon, `server ${FAVICON_SVG.length} bytes, repo ${repoFavicon.length} bytes`);
// Control: the comparison can fail.
check("control: the comparison notices a one-character difference", FAVICON_SVG.replace("#F4620A", "#F4620B") !== repoFavicon);

check("the icon is a plain image: no script, event handler, link, image or style element", !/<script|\son[a-z]+=|<a[\s>]|href=|<image|<style|<foreignObject|<use/i.test(FAVICON_SVG));
check("the only address in the icon is the SVG namespace", (FAVICON_SVG.match(/https?:\/\/[^"' )<]*/g) ?? []).join(",") === "http://www.w3.org/2000/svg");

type Captured = { status: number; headers: Record<string, string>; body: string };
function render(handler: (req: any, res: any, next: any) => void): Captured {
  const out: Captured = { status: 0, headers: {}, body: "" };
  const res = {
    status(s: number) { out.status = s; return res; },
    type() { return res; },
    set(h: Record<string, string>) { Object.assign(out.headers, h); return res; },
    send(b: string) { out.body = b; return res; },
  };
  handler({}, res, () => {});
  return out;
}

for (const [name, handler] of [["/login", loginPage], ["/consent", consentPage]] as const) {
  const page = render(handler);
  const csp = page.headers["Content-Security-Policy"] ?? "";
  check(`${name}: links the tab icon from this origin`, page.body.includes('<link rel="icon" type="image/svg+xml" href="/favicon.svg">'));
  check(`${name}: the CSP lets images load from this origin only (img-src 'self')`, /(^|; )img-src 'self'(;|$)/.test(csp), csp);
  check(`${name}: the CSP still starts from default-src 'none' and names no host or data: scheme`, csp.startsWith("default-src 'none'") && !/https?:|data:|\*/.test(csp), csp);
  check(`${name}: the inline logo is the same mark (the icon's shapes, no xmlns)`, FAVICON_SVG.match(/<(rect|circle)[^>]*>/g)!.every((shape) => page.body.includes(shape.trim())) && !page.body.includes("xmlns"));
  check(`${name}: nothing in the page text names another origin`, !/https?:\/\//i.test(page.body), (page.body.match(/https?:\/\/[^"' )<]*/gi) ?? []).join(" "));
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
