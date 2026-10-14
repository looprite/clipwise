// The signed-in member's own demo calls (SAA-198 step 6, demo/seed.ts), for
// /login: whether any is still live, and moving them to the trash. Mounted
// behind requireSession (app.ts); each acts on the member's own demo calls
// only, never another member's.

import { Router } from "express";
import { accessOf } from "../access/authenticate.js";
import { liveDemoCount, trashOwnDemos } from "../demo/seed.js";
import { asyncHandler } from "../lib/http.js";

export const demoRouter = Router();

demoRouter.get(
  "/demo/status",
  asyncHandler(async (req, res) => {
    const { accountId, memberId } = accessOf(req);
    res.json({ live: await liveDemoCount({ accountId, memberId }) });
  }),
);

demoRouter.post(
  "/demo/trash",
  asyncHandler(async (req, res) => {
    const { accountId, memberId } = accessOf(req);
    const trashed = await trashOwnDemos({ accountId, memberId });
    console.log(`demo: member=${memberId} moved ${trashed} demo call(s) to the trash`);
    res.json({ trashed });
  }),
);
