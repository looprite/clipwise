// The MCP endpoint: Streamable HTTP, stateless. Every request gets its own
// server and transport, bound to the caller found by requireMember, and torn
// down when the response closes — no session to hold, nothing to expire, and no
// way for one caller's state to reach another's. (Datameter's server uses the
// same shape: datameter/src/server.js.)
//
// Responses are plain JSON rather than an event stream: the tools answer in one
// shot, and Claude's client accepts either.
//
// A tool that refuses (a recording that is not yours, a bad argument) answers
// with an error RESULT, as the protocol intends; only a missing or revoked
// login is an HTTP 401, and that is decided before this runs (access/authenticate.ts).

import type { Request, RequestHandler, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { accessOf } from "../access/authenticate.js";
import type { AccessContext } from "../access/context.js";
import { asyncHandler } from "../lib/http.js";
import { TOOLS, toolErrorText } from "./tools.js";

const INSTRUCTIONS =
  "Clipwise holds the moments (decisions, commitments, questions, objections) and transcripts of the team's recorded calls. " +
  "Use search_moments to find what was said or decided, and its index mode to list which calls happened; use get_transcript to read a call. " +
  "You can only see calls you recorded and calls teammates shared with the team. " +
  "Results can be partial: check `truncated` on searches and the page notice on transcripts before concluding something is absent.";

export function createMcpServer(ctx: AccessContext): Server {
  const server = new Server(
    { name: "clipwise", version: "0.2.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { isError: true, content: [{ type: "text", text: `unknown_tool: ${name}` }] };
    const started = Date.now();
    try {
      const text = await tool.run(ctx, args);
      // Name, caller and timing only — never arguments or content.
      console.log(`mcp: ${name} member=${ctx.memberId} ok ${Date.now() - started}ms ${text.length}ch`);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      const text = toolErrorText(err);
      console.log(`mcp: ${name} member=${ctx.memberId} error=${text.split(":")[0]} ${Date.now() - started}ms`);
      return { isError: true, content: [{ type: "text", text }] };
    }
  });

  return server;
}

export const mcpPost: RequestHandler = asyncHandler(async (req: Request, res: Response) => {
  const server = createMcpServer(accessOf(req));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// There is no server-initiated stream and no session to end, so GET and DELETE
// are refused (after authentication) the way the protocol allows.
export const mcpMethodNotAllowed: RequestHandler = (_req, res) => {
  res
    .status(405)
    .set("Allow", "POST")
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
