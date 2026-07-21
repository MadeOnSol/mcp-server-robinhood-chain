#!/usr/bin/env node

/**
 * mcp-server-robinhood-chain — Model Context Protocol server for the MadeOnSol
 * Robinhood Chain (chain id 4663) API. EVM-native on-chain trading intelligence
 * for AI agents: live KOL trades, the DEX trade tape, token discovery / bundles
 * / candles, deployer reputation, and smart-money wallets.
 *
 * Key-mode only: authenticate with an `msk_` Bearer API key (get a free key at
 * https://madeonsol.com/pricing — RHC coverage is bundled into every tier). The
 * x402 pay-per-call rail is Solana-native and is not part of this server. All 14
 * tools map 1:1 to GET /api/v1/rhc/… routes.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { VERSION } from "./version.js";
import { createServer } from "node:http";

const BASE_URL = process.env.MADEONSOL_API_URL || "https://madeonsol.com";
const MADEONSOL_API_KEY = process.env.MADEONSOL_API_KEY; // Native key from madeonsol.com/pricing
const PORT = parseInt(process.env.PORT || "3100", 10);
const MODE = process.env.MCP_TRANSPORT || "stdio"; // "stdio" or "http"

export type AuthMode = "madeonsol" | "none";

/**
 * Pure selection of the auth mode from environment. This server is key-mode
 * only: an `msk_` API key (Bearer) or nothing. Extracted so it is unit-testable
 * without network. Empty-string env vars are treated as unset.
 */
export function resolveAuthMode(
  env: { MADEONSOL_API_KEY?: string } = process.env,
): AuthMode {
  return env.MADEONSOL_API_KEY ? "madeonsol" : "none";
}

let authMode: AuthMode = "none";

const UA = `mcp-server-robinhood-chain/${VERSION}`;

function apiKeyHeaders(): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": UA };
  if (authMode === "madeonsol") h.Authorization = `Bearer ${MADEONSOL_API_KEY}`;
  return h;
}

function initAuth() {
  authMode = resolveAuthMode({ MADEONSOL_API_KEY });
  if (authMode === "madeonsol") {
    console.error("[rhc-mcp] Using MadeOnSol API key (Bearer auth) for Robinhood Chain (chain 4663)");
    return;
  }
  console.error(
    "\n[rhc-mcp] No MADEONSOL_API_KEY set — every tool call will fail.\n" +
    "  → Get a free API key (200 req/day, no card) at https://madeonsol.com/pricing\n" +
    "  → Robinhood Chain coverage is bundled into every tier at no extra cost.\n",
  );
}

/**
 * Perform a GET against a Robinhood Chain route. `path` is a full /api/v1/rhc/…
 * path (params already interpolated). Returns the pretty-printed JSON body, or a
 * human-readable error string the model can relay.
 */
async function query(path: string, params?: Record<string, string | number>): Promise<string> {
  if (authMode !== "madeonsol") {
    return "Robinhood Chain tools require MADEONSOL_API_KEY (msk_) — get one free at https://madeonsol.com/pricing (RHC is bundled into every tier).";
  }
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), { headers: apiKeyHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `Error ${res.status}: ${body}`;
  }
  return JSON.stringify(await res.json(), null, 2);
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function registerTools(server: McpServer) {
  /* ── KOL intelligence ── */

  server.tool(
    "rhc_kol_feed",
    "Robinhood Chain (chain id 4663) real-time KOL trade feed — every buy/sell from tracked Solana KOLs' verified EVM wallets, attributed via tx.from from our self-hosted node. EVM-native: token_address (0x), eth_amount, tx_hash, block_number. Each row is enriched with deployer_tier, current/peak MC, and mc_multiple_since_trade ('did the call run'). Tier: BASIC (any valid key).",
    {
      limit: z.number().min(1).max(100).default(50).describe("Number of trades to return (1-100)"),
      before: z.string().optional().describe("Cursor — ISO 8601 timestamp; returns trades strictly older than this. Pass next_before to page back."),
      action: z.enum(["buy", "sell"]).optional().describe("Only buys or only sells"),
      kol: z.string().optional().describe("Filter to a single KOL by their EVM wallet (0x, 40 hex)"),
      min_eth: z.number().min(0).optional().describe("Minimum trade size in ETH"),
    },
    readOnly,
    async ({ limit, before, action, kol, min_eth }) => {
      const params: Record<string, string | number> = { limit };
      if (before) params.before = before;
      if (action) params.action = action;
      if (kol) params.kol = kol;
      if (min_eth !== undefined) params.min_eth = min_eth;
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/kol/feed", params) }] };
    }
  );

  server.tool(
    "rhc_kol_leaderboard",
    "Robinhood Chain KOL activity leaderboard — KOLs ranked by trade count, then net ETH flow, over the chosen window. net_eth is buy−sell flow (not realized PnL). Tier: BASIC.",
    {
      period: z.enum(["24h", "7d", "30d"]).default("24h").describe("Rolling window"),
      limit: z.number().min(1).max(100).default(50).describe("Number of KOLs to return (1-100)"),
    },
    readOnly,
    async ({ period, limit }) => ({
      content: [{ type: "text" as const, text: await query("/api/v1/rhc/kol/leaderboard", { period, limit }) }],
    })
  );

  server.tool(
    "rhc_kol_hot_tokens",
    "Robinhood Chain consensus tokens — bought by 2+ distinct tracked KOLs inside the window, ranked by KOL-buyer count then buy volume. Enriched with launchpad, deployer_tier, graduation status and current MC. Tier: BASIC.",
    {
      window: z.enum(["5m", "15m", "1h", "6h", "24h"]).default("1h").describe("Rolling consensus window"),
    },
    readOnly,
    async ({ window }) => ({
      content: [{ type: "text" as const, text: await query("/api/v1/rhc/kol/hot-tokens", { window }) }],
    })
  );

  server.tool(
    "rhc_kol_profile",
    "Robinhood Chain single KOL profile — aggregate stats over one KOL's last 200 RHC trades plus their 50 most recent trades. Tier: BASIC.",
    {
      wallet: z.string().describe("KOL EVM wallet address (0x, 40 hex)"),
    },
    readOnly,
    async ({ wallet }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/kol/${encodeURIComponent(wallet)}`) }],
    })
  );

  /* ── DEX trade tape ── */

  server.tool(
    "rhc_trades",
    "Robinhood Chain DEX trade tape — every Uniswap v2/v3/v4 swap on chain 4663, ~sub-second from execution. Each row carries the REAL trader wallet (trader_eoa = tx.from, not the router), gas/ordering for MEV analysis, pool state, and is_kol / deployer_tier flags. Cursor via next_before. Tier: PRO+.",
    {
      limit: z.number().min(1).max(100).default(50).describe("Number of trades (1-100)"),
      token: z.string().optional().describe("Filter to one token address (0x, 40 hex)"),
      dex: z.enum(["uniswap-v2", "uniswap-v3", "uniswap-v4"]).optional().describe("Filter by DEX version"),
      action: z.enum(["buy", "sell"]).optional().describe("Only buys or only sells"),
      min_eth: z.number().min(0).optional().describe("Minimum trade size in ETH"),
      before: z.string().optional().describe("Cursor — trades strictly older than this block_time (ISO)"),
    },
    readOnly,
    async ({ limit, token, dex, action, min_eth, before }) => {
      const params: Record<string, string | number> = { limit };
      if (token) params.token = token;
      if (dex) params.dex = dex;
      if (action) params.action = action;
      if (min_eth !== undefined) params.min_eth = min_eth;
      if (before) params.before = before;
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/trades", params) }] };
    }
  );

  /* ── Token discovery + intelligence ── */

  server.tool(
    "rhc_tokens",
    "Robinhood Chain token discovery — live-priced tokens with market cap, liquidity, peak MC + drawdown, launchpad, and deployer reputation tier. Sortable and filterable. Tier: PRO+.",
    {
      limit: z.number().min(1).max(100).default(50).describe("Page size (1-100)"),
      sort: z.enum(["last_trade", "market_cap", "liquidity", "peak_mc"]).optional().describe("Ordering (all descending, default last_trade)"),
      min_mc_usd: z.number().min(0).optional().describe("Minimum current market cap (USD)"),
      min_liquidity_usd: z.number().min(0).optional().describe("Minimum current liquidity (USD)"),
      launchpad: z.string().optional().describe("Filter by launchpad: pons, flap, clanker, hood.fun, noxa, virtuals"),
    },
    readOnly,
    async ({ limit, sort, min_mc_usd, min_liquidity_usd, launchpad }) => {
      const params: Record<string, string | number> = { limit };
      if (sort) params.sort = sort;
      if (min_mc_usd !== undefined) params.min_mc_usd = min_mc_usd;
      if (min_liquidity_usd !== undefined) params.min_liquidity_usd = min_liquidity_usd;
      if (launchpad) params.launchpad = launchpad;
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/tokens", params) }] };
    }
  );

  server.tool(
    "rhc_token",
    "Robinhood Chain token snapshot — metadata, live price/MC/FDV, peak MC + drawdown, graduation status, deployer reputation block (+ other tokens by the same deployer), KOL activity summary, and pool inventory with reserves. Tier: BASIC.",
    {
      address: z.string().describe("Token address (0x, 40 hex)"),
    },
    readOnly,
    async ({ address }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/tokens/${encodeURIComponent(address)}`) }],
    })
  );

  server.tool(
    "rhc_token_candles",
    "Robinhood Chain 1-minute OHLC candles — price + market-cap OHLC, close liquidity, volume with buy/sell split, and trade/buy/sell counts, ordered oldest→newest. Tier: PRO+.",
    {
      address: z.string().describe("Token address (0x, 40 hex)"),
      limit: z.number().min(1).max(1000).default(240).describe("Number of candles (1-1000, default 240)"),
      from: z.string().optional().describe("Lower bound on bucket_start (ISO)"),
      to: z.string().optional().describe("Upper bound on bucket_start (ISO)"),
    },
    readOnly,
    async ({ address, limit, from, to }) => {
      const params: Record<string, string | number> = { limit };
      if (from) params.from = from;
      if (to) params.to = to;
      return { content: [{ type: "text" as const, text: await query(`/api/v1/rhc/tokens/${encodeURIComponent(address)}/candles`, params) }] };
    }
  );

  server.tool(
    "rhc_token_kol_consensus",
    "Robinhood Chain KOL consensus on a token — distinct KOL buyers vs sellers, exit rate (bought AND sold), net ETH flow (net_flow_eth), median entry MC, and first-touch wallet/time. ULTRA additionally returns the buyers and exited wallet lists. consensus is null when no tracked KOL has traded the token. Tier: PRO+.",
    {
      address: z.string().describe("Token address (0x, 40 hex)"),
    },
    readOnly,
    async ({ address }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/tokens/${encodeURIComponent(address)}/kol-consensus`) }],
    })
  );

  server.tool(
    "rhc_token_buyer_quality",
    "Robinhood Chain early-buyer quality — a 0–100 read on a token's earliest distinct buyer cohort (first 20): win-rate, KOL-presence, bot-domination and bundle-buyer legs, plus the informational dump-cluster ensemble (dump_cluster_count flags the pattern but does not move the score). Neutral score (50) with a note when the token has no buyer history yet. Tier: BASIC.",
    {
      address: z.string().describe("Token address (0x, 40 hex)"),
    },
    readOnly,
    async ({ address }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/tokens/${encodeURIComponent(address)}/buyer-quality`) }],
    })
  );

  server.tool(
    "rhc_token_bundle",
    "Robinhood Chain launch-bundle detection — ranks the first 20 distinct buyers by on-chain order and flags a bundle when 3+ make their first buy in the SAME BLOCK (bundle_kind 'same_block'; there is no atomic_tx on an Arbitrum Orbit L2), then reports the cohort's current held %. Field-gated by tier: BASIC gets the scalar bundle signal; PRO adds the top-10 wallets; ULTRA returns the full cohort with alpha-wallet identity. Tier: BASIC.",
    {
      address: z.string().describe("Token address (0x, 40 hex)"),
    },
    readOnly,
    async ({ address }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/tokens/${encodeURIComponent(address)}/bundle`) }],
    })
  );

  /* ── Deployer hunter ── */

  server.tool(
    "rhc_deployer_leaderboard",
    "Robinhood Chain deployer reputation leaderboard — deployers ranked by reputation over every launchpad token we've indexed (40k+ deployers). Most RHC launchpads are direct-to-DEX (no bonding curve), so graduation is a market-cap milestone: graduation_rate = share of tokens that reached a $40K+ peak MC; runner_rate = share that reached $100K+. Tier: BASIC.",
    {
      sort: z.enum(["graduation_rate", "runner_rate", "tokens_deployed", "best_peak_mc_usd", "last_deploy_at"]).optional().describe("Ordering (all descending, NULLs last; default graduation_rate)"),
      tier: z.enum(["elite", "good", "neutral", "spammer"]).optional().describe("Filter to one reputation tier"),
      min_tokens: z.number().min(1).max(100000).optional().describe("Minimum tokens deployed (default 3)"),
      limit: z.number().min(1).max(50).default(20).describe("Page size (1-50, default 20)"),
      offset: z.number().min(0).max(10000).optional().describe("Pagination offset"),
    },
    readOnly,
    async ({ sort, tier, min_tokens, limit, offset }) => {
      const params: Record<string, string | number> = { limit };
      if (sort) params.sort = sort;
      if (tier) params.tier = tier;
      if (min_tokens !== undefined) params.min_tokens = min_tokens;
      if (offset !== undefined) params.offset = offset;
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/deployer-hunter/leaderboard", params) }] };
    }
  );

  server.tool(
    "rhc_deployer_profile",
    "Robinhood Chain single deployer profile — one deployer's full reputation row (tier, bonding_rate, runner_rate, best peak MC, launchpads, deploy timeline) plus their 50 most recent tokens enriched with live MC and peak MC. Unknown wallets return 200 with is_deployer: false (not a 404). Tier: BASIC.",
    {
      address: z.string().describe("Deployer EVM wallet address (0x, 40 hex)"),
    },
    readOnly,
    async ({ address }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/deployer-hunter/${encodeURIComponent(address)}`) }],
    })
  );

  /* ── Smart money ── */

  server.tool(
    "rhc_alpha_wallets",
    "Robinhood Chain smart-money wallet ranking — trader wallets ranked by realized on-chain performance. net_eth is realized net flow (sell − buy); win_rate is the share of traded tokens taken out profitably; likely_bot flags atomic-arb/MM fleets. memecoin_share = launchpad-token trade share — filter with min_memecoin_share to isolate memecoin traders, or max_avg_mc_usd for low-caps. Refreshed every 15 min. Tier: PRO+.",
    {
      classification: z.enum(["all", "human", "bot", "smart_money"]).default("all").describe("human = not likely_bot; smart_money = human + net_eth ≥ 2 + win_rate ≥ 0.45"),
      identity: z.enum(["all", "known_kol", "unknown"]).default("all").describe("known_kol = already mapped to a tracked Solana KOL; unknown = net-new RHC smart money"),
      min_memecoin_share: z.number().min(0).max(1).optional().describe("Minimum share of trades in launchpad memecoins (0.7 ≈ mostly-memecoin)"),
      max_avg_mc_usd: z.number().optional().describe("Maximum average market cap traded — filter to low-cap degens"),
      min_net_eth: z.number().optional().describe("Minimum realized net ETH flow"),
      min_win_rate: z.number().min(0).max(1).optional().describe("Minimum win rate (0-1)"),
      max_win_rate: z.number().min(0).max(1).optional().describe("Maximum win rate (0-1)"),
      min_trades: z.number().min(0).optional().describe("Minimum trade count"),
      min_tokens: z.number().min(0).optional().describe("Minimum distinct tokens traded"),
      min_buy_eth: z.number().optional().describe("Minimum ETH deployed (whale/size filter)"),
      active_hours: z.number().min(1).max(720).optional().describe("Only wallets that traded within the last N hours"),
      sort: z.enum(["net_eth", "win_rate", "trades", "tokens", "buy_eth", "memecoin_share", "last_trade_at"]).default("net_eth").describe("Sort axis"),
      order: z.enum(["desc", "asc"]).default("desc").describe("Sort direction"),
      limit: z.number().min(1).max(100).default(25).describe("Page size (1-100, default 25)"),
      offset: z.number().min(0).max(10000).optional().describe("Pagination offset"),
    },
    readOnly,
    async (args) => {
      const params: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined) params[k] = v as string | number;
      }
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/alpha-wallets", params) }] };
    }
  );
}

/** Tool catalog for discovery cards (Smithery / glama). Keep in sync with registerTools. */
const TOOL_CARDS = [
  { name: "rhc_kol_feed", description: "Real-time Robinhood Chain KOL trade feed — EVM-native (0x, eth_amount, tx_hash)." },
  { name: "rhc_kol_leaderboard", description: "RHC KOLs ranked by trade count then net ETH flow (24h/7d/30d)." },
  { name: "rhc_kol_hot_tokens", description: "RHC consensus tokens — bought by 2+ distinct KOLs in the window." },
  { name: "rhc_kol_profile", description: "Single RHC KOL profile — stats over last 200 trades + 50 recent." },
  { name: "rhc_trades", description: "RHC DEX trade tape — Uniswap v2/v3/v4 swaps with trader_eoa + MEV fields. PRO+." },
  { name: "rhc_tokens", description: "RHC token discovery — MC, liquidity, peak MC, launchpad, deployer tier. PRO+." },
  { name: "rhc_token", description: "RHC token snapshot — price/MC/FDV, deployer block, KOL activity, pools." },
  { name: "rhc_token_candles", description: "RHC 1-minute OHLC candles — price + MC OHLC, volume buy/sell split. PRO+." },
  { name: "rhc_token_kol_consensus", description: "RHC KOL consensus on a token — buyers/sellers, exit rate, net_flow_eth. PRO+." },
  { name: "rhc_token_buyer_quality", description: "RHC 0–100 early-buyer quality with bundle + dump-cluster legs." },
  { name: "rhc_token_bundle", description: "RHC launch-bundle detection (same_block) + how much the cohort still holds." },
  { name: "rhc_deployer_leaderboard", description: "RHC deployers ranked by reputation — graduation_rate ($40K), runner_rate ($100K)." },
  { name: "rhc_deployer_profile", description: "Single RHC deployer profile + 50 most recent tokens." },
  { name: "rhc_alpha_wallets", description: "RHC smart-money wallets — net_eth, win_rate, memecoin_share, likely_bot. PRO+." },
];

async function main() {
  initAuth();

  if (MODE === "http") {
    // HTTP transport for hosted environments (Smithery, etc.)
    const httpServer = createServer();
    const transports = new Map<string, StreamableHTTPServerTransport>();

    httpServer.on("request", async (req, res) => {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "robinhood-chain-mcp" }));
        return;
      }

      // Server card for discovery
      if (req.method === "GET" && req.url === "/.well-known/mcp/server-card.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          name: "robinhood-chain",
          description: "Robinhood Chain (chain id 4663) EVM-native on-chain trading intelligence — real-time KOL trades, the DEX trade tape, token discovery / bundles / candles, deployer reputation, and smart-money wallets. Auth via msk_ API key. Free tier 200 requests/day.",
          version: VERSION,
          tools: TOOL_CARDS,
          homepage: "https://madeonsol.com/robinhood",
          repository: "https://github.com/madeonsol/mcp-server-robinhood-chain",
        }));
        return;
      }

      // MCP endpoint
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (req.method === "POST") {
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          const server = new McpServer({ name: "robinhood-chain", version: VERSION });
          registerTools(server);
          await server.connect(transport);
        }
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method === "GET" && sessionId) {
        const transport = transports.get(sessionId);
        if (transport) { await transport.handleRequest(req, res); return; }
      }

      if (req.method === "DELETE" && sessionId) {
        const transport = transports.get(sessionId);
        if (transport) { await transport.handleRequest(req, res); transports.delete(sessionId); return; }
      }

      res.writeHead(404);
      res.end("Not found");
    });

    // Bind to 127.0.0.1 only — defense in depth. Override with HOST=0.0.0.0 for
    // hosted environments behind a separate reverse proxy.
    const HOST = process.env.HOST || "127.0.0.1";
    httpServer.listen(PORT, HOST, () => {
      console.error(`[rhc-mcp] HTTP server listening on ${HOST}:${PORT}`);
    });
  } else {
    // Stdio transport for local use (Claude Desktop, Cursor, Claude Code)
    const server = new McpServer({ name: "robinhood-chain", version: VERSION });
    registerTools(server);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

// Only auto-run when executed as a program (CLI / spawned process), not when the
// module is imported by a test for its exported pure helpers.
if (process.env.RHC_MCP_NO_AUTORUN !== "1") {
  main().catch(console.error);
}
