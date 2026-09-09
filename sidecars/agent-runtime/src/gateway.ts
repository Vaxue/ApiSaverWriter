#!/usr/bin/env node
/** HTTP/SSE bridge used by Android and iOS clients. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type RpcRequest = { method?: string; params?: Record<string, unknown> };
type Pending = { response: ServerResponse; runId: string };
const host = process.env.AGENT_GATEWAY_HOST || "127.0.0.1";
const port = Number(process.env.AGENT_GATEWAY_PORT || 8787);
const allowedOrigin = process.env.AGENT_GATEWAY_ORIGIN || "*";
const runtimeEntry = join(dirname(fileURLToPath(import.meta.url)), "main.js");
let runtime: ChildProcessWithoutNullStreams | undefined;
// NDJSON 分帧必须在 Buffer 层完成：若先把 chunk 转成字符串，多字节 UTF-8 字符
// 恰好被切在两个 chunk 边界时会产生乱码，导致 JSON.parse 失败。
let lineBuffer = Buffer.alloc(0);
const pending = new Map<string, Pending>();

const writeEvent = (response: ServerResponse, event: string, payload: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
const ensureRuntime = () => {
  if (runtime && runtime.exitCode === null && !runtime.killed) return runtime;
  runtime = spawn(process.execPath, [runtimeEntry], { stdio: ["pipe", "pipe", "pipe"] });
  runtime.stderr.on("data", chunk => console.error(`[agent-runtime] ${String(chunk).trim()}`));
  runtime.stdout.on("data", chunk => {
    lineBuffer = Buffer.concat([lineBuffer, chunk]);
    const lines: string[] = [];
    for (let index = lineBuffer.indexOf("\n"); index >= 0; index = lineBuffer.indexOf("\n")) {
      lines.push(lineBuffer.subarray(0, index).toString("utf8"));
      lineBuffer = lineBuffer.subarray(index + 1);
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const payload = JSON.parse(line) as Record<string, unknown>;
        if (payload.type === "agent_stream") {
          const runId = String(payload.runId || "");
          for (const request of pending.values()) if (request.runId === runId) writeEvent(request.response, "agent-progress", payload.event);
          continue;
        }
        const request = pending.get(String(payload.id || ""));
        if (!request) continue;
        pending.delete(String(payload.id || ""));
        writeEvent(request.response, "result", payload);
        request.response.end();
      } catch (error) { console.error("[agent-gateway] ignored invalid runtime message", error); }
    }
  });
  runtime.on("exit", () => {
    for (const request of pending.values()) { writeEvent(request.response, "error", { message: "Agent Gateway runtime stopped; retry the request." }); request.response.end(); }
    pending.clear();
    runtime = undefined;
  });
  return runtime;
};
const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};
const setCors = (response: ServerResponse) => {
  response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
};
createServer(async (request, response) => {
  setCors(response);
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
  if (request.method === "GET" && request.url === "/health") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ok: true, runtime: Boolean(runtime) })); return; }
  if (request.method !== "POST" || request.url !== "/rpc") { response.writeHead(404, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "Not found" })); return; }
  try {
    const input = JSON.parse(await readBody(request)) as RpcRequest;
    if (!input.method) throw new Error("Missing RPC method");
    const id = randomUUID();
    const runId = typeof input.params?.runId === "string" ? input.params.runId : "";
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    pending.set(id, { response, runId });
    response.on("close", () => pending.delete(id));
    ensureRuntime().stdin.write(`${JSON.stringify({ id, method: input.method, params: input.params || {} })}\n`);
  } catch (error) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
}).listen(port, host, () => console.log(`ApiSaverWriter Agent Gateway listening on http://${host}:${port}`));
