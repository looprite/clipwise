import { Router } from "express";
import { accessOf } from "../access/authenticate.js";
import { logAccess } from "../lib/access-line.js";
import { asyncHandler, uuidParam } from "../lib/http.js";
import { getTranscriptFor } from "../services/transcript.js";

// Reading a transcript. Writing one is POST /captures (routes/captures.ts).
export const transcriptRouter = Router();
transcriptRouter.param("id", uuidParam("recording_not_found"));

transcriptRouter.get(
  "/recordings/:id/transcript",
  asyncHandler(async (req, res) => {
    const ctx = accessOf(req);
    const transcript = await getTranscriptFor(ctx, req.params.id);
    logAccess(ctx.memberId, "transcript", req.params.id);
    res.json(transcript);
  }),
);
