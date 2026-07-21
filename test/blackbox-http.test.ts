/**
 * Black-box test of the MCP server's own request layer.
 *
 * Spawns the BUILT server (dist/index.js) in HTTP transport mode with a fake
 * MADEONSOL_API_KEY and BASE_URL pointed at a LOCAL mock upstream. It then drives
 * real MCP JSON-RPC traffic (initialize -> tools/call) over the StreamableHTTP
 * endpoint and asserts what the mock upstream actually received.
 *
 * Proves end-to-end, through the server's real query() path:
 *   - rhc_kol_feed hits /api/v1/rhc/kol/feed (the real RHC route) with the query.
 *   - The Authorization: Bearer <key> header is attached.
 *
 * Fully offline / no real money: the upstream is a localhost mock and there are
 * no payments in this key-mode-only server.
 *
 * Run: npm test (from packages/mcp-server-robinhood-chain)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = path.resolve(__dirname, "../dist/index.js");
const TEST_KEY = "msk_test_blackbox_0123456789";

type CapturedRequest = { url: string; auth: string | undefined };

let mockUpstream: Server;
let mockPort: number;
let captured: CapturedRequest[] = [];

let mcpProc: ChildProcess;
let mcpPort: number;
let mcpSessionId: string | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const p = addr.port;
        s.close(() => resolve(p));
      } else {
        s.close(() => reject(new Error("no port")));
      }
    });
    s.on("error", reject);
  });
}

function startMockUpstream(port: number): Promise<void> {
  return new Promise((resolve) => {
    mockUpstream = createServer((req: IncomingMessage, res) => {
      captured.push({
        url: req.url || "",
        auth: req.headers["authorization"] as string | undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ chain: "robinhood", trades: [], count: 0, note: "mock-feed" }));
    });
    mockUpstream.listen(port, "127.0.0.1", () => resolve());
  });
}

function waitForServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 15000);
    proc.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      if (process.env.MCP_TEST_DEBUG) console.error("[rhc-mcp]", s.trimEnd());
      if (s.includes("HTTP server listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
}

const MCP_HEADERS = (): Record<string, string> => {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2024-11-05",
  };
  if (mcpSessionId) h["mcp-session-id"] = mcpSessionId;
  return h;
};

async function parseMcpResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    if (dataLines.length === 0) return null;
    return JSON.parse(dataLines[dataLines.length - 1]);
  }
  return text ? JSON.parse(text) : null;
}

async function mcpPost(body: unknown): Promise<{ res: Response; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${mcpPort}/`, {
    method: "POST",
    headers: MCP_HEADERS(),
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpSessionId = sid;
  const json = await parseMcpResponse(res);
  return { res, json };
}

beforeAll(async () => {
  mockPort = await freePort();
  mcpPort = await freePort();
  await startMockUpstream(mockPort);

  mcpProc = spawn(process.execPath, [DIST_ENTRY], {
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      PORT: String(mcpPort),
      HOST: "127.0.0.1",
      MADEONSOL_API_KEY: TEST_KEY,
      MADEONSOL_API_URL: `http://127.0.0.1:${mockPort}`,
      RHC_MCP_NO_AUTORUN: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForServer(mcpProc);

  const init = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "blackbox-test", version: "0.0.0" },
    },
  });
  expect(init.res.status).toBe(200);

  await fetch(`http://127.0.0.1:${mcpPort}/`, {
    method: "POST",
    headers: MCP_HEADERS(),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});
});

afterAll(async () => {
  if (mcpProc && !mcpProc.killed) mcpProc.kill("SIGKILL");
  await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
});

describe("RHC MCP server black-box request layer (API-key mode)", () => {
  it("rhc_kol_feed hits /api/v1/rhc/kol/feed with Bearer auth + query params", async () => {
    captured = [];
    const { res, json } = await mcpPost({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "rhc_kol_feed", arguments: { limit: 5, action: "buy" } },
    });
    expect(res.status).toBe(200);
    expect((json as { error?: unknown })?.error).toBeUndefined();

    const feedReq = captured.find((c) => c.url.startsWith("/api/v1/rhc/kol/feed"));
    expect(feedReq, `captured: ${JSON.stringify(captured)}`).toBeTruthy();
    expect(feedReq!.url).toContain("limit=5");
    expect(feedReq!.url).toContain("action=buy");
    expect(feedReq!.auth).toBe(`Bearer ${TEST_KEY}`);
  });

  it("rhc_token_bundle interpolates the address into the RHC route", async () => {
    captured = [];
    const addr = "0x00000000000000000000000000000000deadbeef";
    const { res } = await mcpPost({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "rhc_token_bundle", arguments: { address: addr } },
    });
    expect(res.status).toBe(200);
    const bundleReq = captured.find((c) => c.url.startsWith(`/api/v1/rhc/tokens/${addr}/bundle`));
    expect(bundleReq, `captured: ${JSON.stringify(captured)}`).toBeTruthy();
    expect(bundleReq!.auth).toBe(`Bearer ${TEST_KEY}`);
  });
});
