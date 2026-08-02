#!/usr/bin/env node

/**
 * mcp-server-robinhood-chain — Model Context Protocol server for the MadeOnSol
 * Robinhood Chain (chain id 4663) API. EVM-native on-chain trading intelligence
 * for AI agents: live KOL trades, the DEX trade tape, token discovery / bundles
 * / candles, deployer reputation, and smart-money wallets.
 *
 * Key-mode only: authenticate with an `msk_` Bearer API key (get a free key at
 * https://madeonsol.com/pricing — RHC coverage is bundled into every tier). The
 * x402 pay-per-call rail is live on Robinhood Chain too (6 keyless endpoints, discovery at /api/x402/rhc), but is not part of this server. All 52
 * tools map 1:1 to /api/v1/rhc/… routes: 40 reads (GET, plus two POST batch
 * routes that are POST only because the address list is too long for a query
 * string) and 12 rule-engine tools that genuinely mutate (POST / PATCH / DELETE
 * on copy-trade, price-alert, coordination and first-touch rules).
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
// Values may be undefined: callers pass optional tool args straight through and
// the loop below already skips them. The type now says so instead of forcing
// every call site to pre-filter.
async function query(
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<string> {
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

/**
 * Perform a non-GET request against a Robinhood Chain route. Same auth + error
 * contract as `query`. Used both by the two POST batch reads (POST only because
 * the address list is too large for a query string, not because they mutate)
 * and by the rule-engine CRUD tools, which really do write.
 */
async function mutate(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<string> {
  if (authMode !== "madeonsol") {
    return "Robinhood Chain tools require MADEONSOL_API_KEY (msk_) — get one free at https://madeonsol.com/pricing (RHC is bundled into every tier).";
  }
  const url = new URL(path, BASE_URL);
  const res = await fetch(url.toString(), {
    method,
    headers: body === undefined ? apiKeyHeaders() : { ...apiKeyHeaders(), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return `Error ${res.status}: ${text}`;
  }
  return JSON.stringify(await res.json(), null, 2);
}

/** POST a batch read. Kept as a named helper so the batch tools stay legible. */
async function post(path: string, body: unknown): Promise<string> {
  return mutate("POST", path, body);
}

/** Drop undefined keys so a PATCH sends only the fields the caller actually set
 *  — the routes reject an empty body with 400 "No fields to update", which is
 *  the correct answer to "update nothing". `null` is preserved on purpose: it
 *  is how you CLEAR name / webhook_url. */
function definedOnly(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/* ── Tool annotations ──────────────────────────────────────────────────────
 * These tell a client whether a tool is safe to call speculatively. Only GET
 * reads may use `readOnly`. The rule-engine CRUD tools mutate server state that
 * costs the user quota and fires webhooks, so they must not claim readOnlyHint.
 *   create — not read-only, not destructive, NOT idempotent (calling twice
 *            creates two rules and can hit the per-tier cap with a 409).
 *   update — not read-only, not destructive, idempotent (same PATCH twice
 *            leaves the same row state).
 *   destroy — not read-only, DESTRUCTIVE (the row is gone permanently), and
 *            idempotent only in the sense that a repeat returns 404.
 */
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const createWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const updateWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const destroyWrite = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

function registerTools(server: McpServer) {
  /* ── KOL intelligence ── */

  server.tool(
    "rhc_kol_feed",
    "Robinhood Chain (chain id 4663) real-time KOL trade feed — every buy/sell from tracked Solana KOLs' verified EVM wallets, attributed to the effective trading account from our self-hosted node (tx.from on an ordinary transaction, or the ERC-4337 userOp sender when the trade was bundled — never the bundler). EVM-native: token_address (0x), eth_amount, tx_hash, block_number. Each row is enriched with deployer_tier, current/peak MC, and mc_multiple_since_trade ('did the call run'). Tier: BASIC (any valid key).",
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

  server.tool(
    "rhc_kol_coordination",
    "Robinhood Chain KOL coordination / clustering — tokens bought by min_kols+ DISTINCT tracked KOLs inside the window, ranked by KOL count then buy ETH. Per token: buy/sell/net ETH, signal ('accumulating' when net_eth >= 0, else 'distributing'), exited_count vs holders_count, time_to_consensus_sec (first→last KOL buy), MC at first KOL buy, current/peak MC, liquidity, deployer_tier, token age, and the per-KOL breakdown (evm_address, name, twitter_url, buy_eth, sell_eth, exited). Computed read-time from the RHC KOL tape — RHC has no KOL winrate/strategy scores, so those Solana fields are absent. Tier: BASIC.",
    {
      period: z.enum(["1h", "6h", "24h", "7d"]).default("24h").describe("Rolling window over KOL buys"),
      min_kols: z.number().min(2).max(50).default(2).describe("Minimum distinct KOL buyers for a token to qualify (2-50)"),
      limit: z.number().min(1).max(50).default(20).describe("Number of tokens to return (1-50)"),
      min_mc_usd: z.number().min(0).optional().describe("Minimum market cap at the FIRST KOL buy (tokens with unknown MC are dropped when a band is set)"),
      max_mc_usd: z.number().min(0).optional().describe("Maximum market cap at the first KOL buy — must be >= min_mc_usd"),
    },
    readOnly,
    async ({ period, min_kols, limit, min_mc_usd, max_mc_usd }) => {
      const params: Record<string, string | number> = { period, min_kols, limit };
      if (min_mc_usd !== undefined) params.min_mc_usd = min_mc_usd;
      if (max_mc_usd !== undefined) params.max_mc_usd = max_mc_usd;
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/kol/coordination", params) }] };
    }
  );

  server.tool(
    "rhc_kol_first_touches",
    "Robinhood Chain KOL first touches — the GLOBALLY earliest buy by ANY tracked KOL per token (the discovery / early-entry signal), newest first. Each event carries eth_amount, tx_hash, token_age_minutes at the touch, MC + price at the first buy, current and peak MC, and the first_kol block. Cursor back with next_before. Tier: BASIC, but limit is clamped to 20 below PRO and the KOL's evm_address is returned only on ULTRA/BUSINESS (name + twitter_url always).",
    {
      limit: z.number().min(1).max(100).default(50).describe("Number of events (1-100; clamped to 20 on BASIC)"),
      since: z.string().optional().describe("Only first touches strictly newer than this (ISO 8601 with offset)"),
      before: z.string().optional().describe("Cursor — only first touches strictly older than this (ISO 8601 with offset). Pass next_before to page back."),
      min_eth: z.number().min(0).max(100000).optional().describe("Minimum size of the first buy in ETH"),
      token_age_max_min: z.number().min(1).max(43200).optional().describe("Only tokens younger than N minutes at the time of the first touch"),
      launchpad: z.string().optional().describe("Filter by launchpad: pons, flap, clanker, hood.fun, noxa, virtuals"),
      min_mc_usd: z.number().min(0).optional().describe("Minimum market cap at the first buy"),
      max_mc_usd: z.number().min(0).optional().describe("Maximum market cap at the first buy — must be >= min_mc_usd"),
    },
    readOnly,
    async ({ limit, since, before, min_eth, token_age_max_min, launchpad, min_mc_usd, max_mc_usd }) => {
      const params: Record<string, string | number> = { limit };
      if (since) params.since = since;
      if (before) params.before = before;
      if (min_eth !== undefined) params.min_eth = min_eth;
      if (token_age_max_min !== undefined) params.token_age_max_min = token_age_max_min;
      if (launchpad) params.launchpad = launchpad;
      if (min_mc_usd !== undefined) params.min_mc_usd = min_mc_usd;
      if (max_mc_usd !== undefined) params.max_mc_usd = max_mc_usd;
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/kol/first-touches", params) }] };
    }
  );

  /* ── DEX trade tape ── */

  server.tool(
    "rhc_trades",
    "Robinhood Chain DEX trade tape — every Uniswap v2/v3/v4 swap on chain 4663, ~sub-second from execution. Each row carries the effective trading account in trader_eoa, plus gas/ordering for MEV analysis, pool state, and is_kol / deployer_tier flags. Cursor via next_before. Tier: PRO+. IMPORTANT — trader_eoa is NOT simply tx.from: on an ordinary transaction it equals tx.from, but when the trade was bundled through ERC-4337 it is the userOp sender (from UserOperationEvent), never the bundler/relayer that submitted the batch and never the router. It is still an EOA either way — on Robinhood Chain a userOp sender is an ordinary EOA carrying an EIP-7702 delegation, not a smart-contract wallet. Always attribute a trade to trader_eoa; the separate trader field is only the swap-log recipient (the router on aggregated swaps).",
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
    "rhc_token_batch",
    "Robinhood Chain multi-token snapshot — up to 50 tokens in ONE call (POST /api/v1/rhc/token/batch). Per token: symbol/name/decimals, launchpad, graduation status, live price/MC/FDV/liquidity, peak MC + peak_mc_at, primary_dex, last trade time, and the deployer reputation block (tier, tokens_deployed, graduation_rate, runner_rate). Set-based, so it is far cheaper than 50 single-token calls. Every REQUESTED address is echoed back in order — unknown ones come back as found:false rather than being silently dropped. Deliberately does NOT include buyer-quality (use rhc_token_batch_buyer_quality). Tier: BASIC.",
    {
      addresses: z.array(z.string()).min(1).max(50).describe("1-50 token addresses (0x, 40 hex). Duplicates are de-duplicated; addresses are lowercased."),
    },
    readOnly,
    async ({ addresses }) => ({
      content: [{ type: "text" as const, text: await post("/api/v1/rhc/token/batch", { addresses }) }],
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
    "rhc_token_batch_buyer_quality",
    "Robinhood Chain multi-token early-buyer quality — score several tokens' early-buyer cohorts in ONE call (POST /api/v1/rhc/tokens/batch/buyer-quality). MAX 20 ADDRESSES, not the Solana batch cap of 50: RHC buyer-quality is a per-token cohort computation (ordered early-buyer scan + bundle + alpha/dump-cluster joins), so it cannot collapse into one set-based query. Each entry is the same payload rhc_token_buyer_quality returns; a token that fails to score degrades to an { error } entry instead of failing the whole batch, and the response reports requested vs scored. Tier: BASIC.",
    {
      addresses: z.array(z.string()).min(1).max(20).describe("1-20 token addresses (0x, 40 hex) — the cap is 20, NOT 50. Duplicates are de-duplicated."),
    },
    readOnly,
    async ({ addresses }) => ({
      content: [{ type: "text" as const, text: await post("/api/v1/rhc/tokens/batch/buyer-quality", { addresses }) }],
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

  server.tool(
    "rhc_token_top_traders",
    "Top traders of one Robinhood Chain token, ranked by REALIZED ETH flow, enriched with wallet reputation (win_rate, likely_bot, is_known_kol, kol_name), dump-cluster membership and early-buyer rank. CRITICAL: net_eth is sell_eth MINUS buy_eth — realized flow, NOT PnL. It does not value a trader's remaining bag, so a wallet that bought and still holds ranks LAST, not first. Do not present net_eth as profit. For FIFO cost-basis PnL use the wallet PnL endpoint instead. Tier: PRO+ (50 rows; ULTRA/BUSINESS raises the cap to 200).",
    {
      address: z.string().describe("Token address (0x, 40 hex)"),
      limit: z.number().int().min(1).max(200).optional().describe("Rows (capped 50 on PRO, 200 on ULTRA/BUSINESS)"),
      offset: z.number().int().min(0).max(10000).optional().describe("Page offset"),
    },
    readOnly,
    async ({ address, limit, offset }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/tokens/${encodeURIComponent(address)}/top-traders`, { limit, offset }) }],
    })
  );

  server.tool(
    "rhc_token_flow",
    "Net buy/sell flow on a Robinhood Chain token split by mutually-exclusive trader cohort — who is accumulating and who is distributing. SIGN CONVENTION: net_eth = sell MINUS buy, so a POSITIVE net_eth means that cohort DISTRIBUTED (took ETH out) and a NEGATIVE value means it ACCUMULATED. Do not invert this. Cohorts are assigned by a priority ladder and each trader lands in exactly one: kol, bot, dump_cluster, early_buyer, unprofiled, smart_money, retail. smart_money is DERIVED (win_rate >= 0.5 and net positive), not a stored label. unprofiled is a real answer, not missing data — that trader has not met the reputation thresholds yet. There is deliberately NO fresh_wallet cohort because Robinhood Chain stores no wallet-level first-seen. Tier: PRO+.",
    {
      address: z.string().describe("Token address (0x, 40 hex)"),
      window: z.enum(["1h", "6h", "24h", "7d"]).optional().describe("Lookback window (default 24h)"),
    },
    readOnly,
    async ({ address, window }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/tokens/${encodeURIComponent(address)}/flow`, { window }) }],
    })
  );

  server.tool(
    "rhc_token_peak_history",
    "Peak market cap, drawdown from peak, and a running high-water MC curve for a Robinhood Chain token. IMPORTANT: TWO peaks are returned because they disagree. peak_mc_usd_recorded is the stored high-water mark that every other RHC surface keys off (deployer runner-rate, the $40K graduation bar); it is sampled from write batches so it can UNDERCOUNT an intra-batch spike. peak_mc_usd_observed is the maximum of 1-minute candle highs — trade-level truth, and always >= recorded. Report whichever the user needs but do not treat them as interchangeable. Candle history begins 2026-07-15, so check observed_covers_full_history before calling the observed value a lifetime maximum. running_peak_mc in the curve is monotonically non-decreasing by construction. Tier: PRO+.",
    {
      address: z.string().describe("Token address (0x, 40 hex)"),
      window: z.enum(["24h", "7d", "30d", "all"]).optional().describe("Curve window (default 7d)"),
      curve: z.enum(["true", "false"]).optional().describe("false = summary only, no series"),
    },
    readOnly,
    async ({ address, window, curve }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/tokens/${encodeURIComponent(address)}/peak-history`, { window, curve }) }],
    })
  );

  server.tool(
    "rhc_token_risk",
    "EVM-native risk assessment for a Robinhood Chain token, computed LIVE against a self-hosted RHC node. THIS IS NOT THE SOLANA RISK MODEL: EVM has no mint or freeze authority. Across 300 random RHC tokens only 2.3% even expose an owner() function and 0% expose mint in their own bytecode — so an ABSENT capability flag is the NORM and is NOT a safety signal. Never tell a user a token is safe because can_mint is false. The signals that actually discriminate are proxy upgradeability, LP custody and above all sellability: sellability.sellable is simulated at the chain head through the router and is never cached, because whether a token can be sold changes the moment an owner flips a setting. 'no' means bought-but-cannot-sell (honeypot-shaped). Note owner.model 'none' (no owner function exists at all) is a DIFFERENT answer from 'renounced'. lp_custody is only read for uniswap-v2 pools; v3/v4 liquidity sits in an LP NFT and reports 'unknown' rather than being guessed. Tier: PRO+.",
    {
      address: z.string().describe("Token address (0x, 40 hex)"),
    },
    readOnly,
    async ({ address }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/tokens/${encodeURIComponent(address)}/risk`) }],
    })
  );

  server.tool(
    "rhc_token_holders",
    "Exact holder set and concentration for a Robinhood Chain token. Balances are folded from ERC-20 Transfer logs — NOT derived from trades — and reconciled against on-chain totalSupply() at a pinned block. ALWAYS CHECK verified FIRST: false means the reconstruction is incomplete for that token and unverified_reason explains why (a token that only recently became liquid legitimately has partial history); do not present unverified numbers as exact. Concentration (top1/top10/top50 share, hhi, deployer_pct) EXCLUDES liquidity pools and burn addresses from the circulating denominator, because the largest holder of a token is normally its own pool; those are reported separately as pool_held_pct and burned_pct. balance is a raw uint256 returned as a decimal STRING — never coerce it to a float, it exceeds 2^53. Holder addresses may be ERC-4337 smart accounts, so holder_count is not a headcount of people. Tier: PRO+ (50 rows; ULTRA/BUSINESS raises the cap to 200).",
    {
      address: z.string().describe("Token address (0x, 40 hex)"),
      limit: z.number().int().min(1).max(200).optional().describe("Rows (capped 50 on PRO, 200 on ULTRA/BUSINESS)"),
      offset: z.number().int().min(0).max(10000).optional().describe("Page offset"),
    },
    readOnly,
    async ({ address, limit, offset }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/tokens/${encodeURIComponent(address)}/holders`, { limit, offset }) }],
    })
  );

  /* ── Deployer hunter ── */

  server.tool(
    "rhc_deployer_leaderboard",
    "Robinhood Chain deployer reputation leaderboard — deployers ranked by reputation over every launchpad token we've indexed (99k+ deployers). Most RHC launchpads are direct-to-DEX (no bonding curve), so both milestones are market-cap based: graduation_rate = share of tokens that reached a $40K+ peak MC; runner_rate = share that reached $100K+. IMPORTANT (migrations 267 + 269): the elite/good TIER now rides runner_rate ($100K) AND requires 24h of deployer history — elite = 5+ tokens, 24h+ old, runner_rate >= 0.50; good = same with >= 0.25. graduation_rate still means the $40K bar and is still returned, but it NO LONGER sets the tier (it proved farmable by operators rotating wallets); only the spammer label still keys off it (20+ tokens, graduation_rate < 0.05). Tier: BASIC.",
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
    "Robinhood Chain single deployer profile — one deployer's full reputation row (tier, bonding_rate, runner_rate, best peak MC, launchpads, deploy timeline) plus their 50 most recent tokens enriched with live MC and peak MC. tier is earned on runner_rate ($100K peak MC) plus 24h of deployer history, NOT on graduation_rate ($40K), which is still returned but no longer sets the tier. Unknown wallets return 200 with is_deployer: false (not a 404). Tier: BASIC.",
    {
      address: z.string().describe("Deployer EVM wallet address (0x, 40 hex)"),
    },
    readOnly,
    async ({ address }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/deployer-hunter/${encodeURIComponent(address)}`) }],
    })
  );

  server.tool(
    "rhc_deployer_tokens",
    "Robinhood Chain deployer launch history (paginated) — the FULL enumerable token list for one deployer, enriched with live MC, peak MC + peak_mc_at and liquidity. Distinct from rhc_deployer_profile, which caps recent tokens at 50 and is a profile read. total is the deployer's lifetime tokens_deployed, with has_more for paging. NOTE: sort=peak_mc_usd re-orders the REQUESTED PAGE only (peak MC lives in another table) and the response echoes sort_scope:'page' to say so — it is not a global top-tokens ranking. Unknown wallets return 200 with is_deployer: false. Tier: BASIC.",
    {
      address: z.string().describe("Deployer EVM wallet address (0x, 40 hex)"),
      limit: z.number().min(1).max(100).default(50).describe("Page size (1-100, default 50)"),
      offset: z.number().min(0).max(10000).optional().describe("Pagination offset"),
      sort: z.enum(["first_seen_at", "peak_mc_usd"]).optional().describe("first_seen_at (default, newest first, applied in Postgres) or peak_mc_usd (page-scoped re-sort)"),
    },
    readOnly,
    async ({ address, limit, offset, sort }) => {
      const params: Record<string, string | number> = { limit };
      if (offset !== undefined) params.offset = offset;
      if (sort) params.sort = sort;
      return { content: [{ type: "text" as const, text: await query(`/api/v1/rhc/deployer-hunter/${encodeURIComponent(address)}/tokens`, params) }] };
    }
  );

  server.tool(
    "rhc_deployer_history",
    "Robinhood Chain deployer deploy history (deep pagination, up to 1000 per page) — the reputation row plus every token the deployer launched, newest first, enriched with live and peak MC, with an EXACT total count. RHC has no per-day reputation snapshot table, so this is a token-deploy history, not a daily tier time-series. Unknown wallets return 200 with is_deployer: false. Tier: PRO+ (the point-in-time rhc_deployer_profile stays BASIC).",
    {
      address: z.string().describe("Deployer EVM wallet address (0x, 40 hex)"),
      limit: z.number().min(1).max(1000).default(100).describe("Page size (1-1000, default 100)"),
      offset: z.number().min(0).max(100000).optional().describe("Pagination offset"),
    },
    readOnly,
    async ({ address, limit, offset }) => {
      const params: Record<string, string | number> = { limit };
      if (offset !== undefined) params.offset = offset;
      return { content: [{ type: "text" as const, text: await query(`/api/v1/rhc/deployer-hunter/${encodeURIComponent(address)}/history`, params) }] };
    }
  );

  server.tool(
    "rhc_deployer_trajectory",
    "Robinhood Chain deployer trajectory — is this deployer getting BETTER or WORSE over time? Returns trend ('improving' | 'declining' | 'stable'), current streak, longest hit/miss streaks, a 10-launch rolling success-rate curve, avg days between deploys, avg launches burned recovering from a miss, and best/worst stretches. The per-token success event is GRADUATION ($40K+ peak MC, echoed as success_metric) — deliberately not the $100K runner bar that sets the tier, because $100K is too rare to give most deployers a readable curve. Field names keep the Solana 'bond' wording for drop-in compatibility. Analyses up to 500 tokens; truncated:true means the curve is a partial history. Unknown wallets return 200 with is_deployer: false. Tier: BASIC.",
    {
      address: z.string().describe("Deployer EVM wallet address (0x, 40 hex)"),
    },
    readOnly,
    async ({ address }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/deployer-hunter/${encodeURIComponent(address)}/trajectory`) }],
    })
  );

  server.tool(
    "rhc_deployer_best_tokens",
    "Robinhood Chain best tokens from REPUTABLE deployers — the highest peak-MC tokens launched by elite/good-tier deployers in the window, each with live MC, peak MC + peak_mc_at, liquidity and the deployer's tier / graduation_rate / runner_rate. Tier-gated on purpose: this answers 'what did the deployers worth tracking actually produce' — for an unfiltered peak-MC ranking use rhc_tokens. Scans at most the 1000 most recent qualifying launches; truncated:true means the top-N was drawn from those rather than the whole period. Tier: BASIC.",
    {
      period: z.enum(["24h", "7d", "30d", "all"]).default("7d").describe("Window over the token's first_seen_at (default 7d)"),
      limit: z.number().min(1).max(50).default(10).describe("Number of tokens (1-50, default 10)"),
    },
    readOnly,
    async ({ period, limit }) => ({
      content: [{ type: "text" as const, text: await query("/api/v1/rhc/deployer-hunter/best-tokens", { period, limit }) }],
    })
  );

  server.tool(
    "rhc_deployer_stats",
    "Robinhood Chain chain-wide deployer reputation summary — total deployers and tokens, reputable (elite+good) count, population and token count per tier, spam token share, and 24h/7d alert volume. Also returns the ACTIVE tier_rules so a consumer can read what 'elite' currently means instead of guessing: elite/good are earned on runner_rate ($100K+ peak MC, migration 267) plus 24h of deployer history (migration 269); graduation_rate ($40K) no longer sets the quality tier and only still drives the spammer label. graduation_definition and runner_definition are echoed too. Tier: BASIC.",
    {},
    readOnly,
    async () => ({
      content: [{ type: "text" as const, text: await query("/api/v1/rhc/deployer-hunter/stats") }],
    })
  );

  server.tool(
    "rhc_deployer_alerts",
    "Robinhood Chain deployer alert feed — new_deploy / graduated events, newest first. TWO things a consumer must know: (1) TRADABILITY IS FILTERED BY DEFAULT — alerts on tokens with liquidity_usd < $100 (including unknown liquidity) are dropped, because a $45K-MC alert on a drained $68 pool is not a signal; set include_untradeable=true for the raw tape. The active setting is echoed as tradability_filter. (2) TIER IS RESOLVED AT READ TIME from the live reputation view, so it can never advertise a reputation the deployer has since lost; the snapshot written when the alert fired is returned as tier_at_alert with tier_is_stale flagging a drift. Tiers ride runner_rate ($100K peak MC) + 24h of deployer history, not the $40K graduation rate. Each alert also carries liquidity_usd and current_mc_usd. Poll forward with since=next_event_at, page back with before=next_before. Tier: BASIC (limit capped at 50 below ULTRA).",
    {
      limit: z.number().min(1).max(500).default(50).describe("Number of alerts (1-500; capped at 50 unless ULTRA)"),
      deployer_tier: z.enum(["elite", "good", "neutral", "spammer"]).optional().describe("Filter on the RESOLVED (current) tier, applied after read-time resolution"),
      priority: z.enum(["high", "medium"]).optional().describe("Alert priority (RHC has no 'low')"),
      alert_type: z.enum(["new_deploy", "graduated"]).optional().describe("Event type — RHC has no bonded/kol_buy alerts"),
      launchpad: z.string().optional().describe("Filter by launchpad: pons, flap, clanker, hood.fun, noxa, virtuals"),
      min_mc: z.number().min(0).optional().describe("Minimum market cap at the time the alert fired (mc_at_alert)"),
      include_untradeable: z.boolean().optional().describe("true disables the default liquidity_usd >= $100 tradability filter and returns the raw tape"),
      since: z.string().optional().describe("Only alerts with event_at strictly newer than this (ISO 8601 with offset) — the incremental-polling cursor"),
      before: z.string().optional().describe("Only alerts with event_at strictly older than this (ISO 8601 with offset) — pass next_before to page back"),
      offset: z.number().min(0).max(10000).optional().describe("Pagination offset (used only when no before cursor is given)"),
    },
    readOnly,
    async ({ limit, deployer_tier, priority, alert_type, launchpad, min_mc, include_untradeable, since, before, offset }) => {
      const params: Record<string, string | number> = { limit };
      if (deployer_tier) params.deployer_tier = deployer_tier;
      if (priority) params.priority = priority;
      if (alert_type) params.alert_type = alert_type;
      if (launchpad) params.launchpad = launchpad;
      if (min_mc !== undefined) params.min_mc = min_mc;
      if (include_untradeable) params.include_untradeable = "true";
      if (since) params.since = since;
      if (before) params.before = before;
      if (offset !== undefined) params.offset = offset;
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/deployer-hunter/alerts", params) }] };
    }
  );

  server.tool(
    "rhc_recent_bonds",
    "Robinhood Chain recent graduations — tokens that just crossed the $40K peak-MC milestone, newest peak first, with live MC, peak MC + peak_mc_at, launchpad and the deployer's address + tier. On RHC a 'bond' is NOT a bonding-curve completion (noxa/pons/clanker launch direct-to-DEX with no curve); the set is defined purely by peak_mc_usd >= $40,000, echoed as graduation_mc. min_peak can only RAISE that floor, never lower it. Tier: BASIC.",
    {
      limit: z.number().min(1).max(200).default(50).describe("Number of tokens (1-200, default 50)"),
      deployer_tier: z.enum(["elite", "good", "neutral", "spammer"]).optional().describe("Only graduations from deployers in this reputation tier"),
      min_peak: z.number().min(0).optional().describe("Minimum peak MC in USD — clamped up to $40,000 if lower"),
    },
    readOnly,
    async ({ limit, deployer_tier, min_peak }) => {
      const params: Record<string, string | number> = { limit };
      if (deployer_tier) params.deployer_tier = deployer_tier;
      if (min_peak !== undefined) params.min_peak = min_peak;
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/deployer-hunter/recent-bonds", params) }] };
    }
  );

  /* ── Smart money ── */

  server.tool(
    "rhc_alpha_wallets",
    "Robinhood Chain smart-money wallet ranking — trader wallets ranked by realized on-chain performance. Wallets are effective trading accounts (the ERC-4337 userOp sender where a trade was bundled, not the bundler that relayed it), so relayer addresses do not appear as traders. net_eth is realized net flow (sell − buy); win_rate is the share of traded tokens taken out profitably; likely_bot flags atomic-arb/MM fleets. memecoin_share = launchpad-token trade share — filter with min_memecoin_share to isolate memecoin traders, or max_avg_mc_usd for low-caps. Refreshed every 15 min. Tier: PRO+.",
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

  /* ── Copy-trade rules (PRO+) ──
   * WRITES. These create/modify/delete server-side rules that consume the
   * caller's per-tier quota and fire webhooks. Quota is PER CHAIN: a full set
   * of Solana copy-trade rules does NOT consume RHC capacity, and vice versa. */

  server.tool(
    "rhc_copytrade_list",
    "List your Robinhood Chain copy-trade rules. Each rule mirrors 1+ source EVM wallets and emits a signal (webhook and/or the rhc:copytrade:signals WS channel) when they trade on chain 4663. Returns id, name, source_wallets, min_trade_eth, only_action, sizing_mode, sizing_amount, delivery_mode, webhook_url, is_active. Rule caps are PER CHAIN and do not consume the Solana copy-trade budget: PRO 3 rules / 5 wallets each, ULTRA 20 / 50, BUSINESS 100 / 250. Tier: PRO+.",
    {},
    readOnly,
    async () => ({
      content: [{ type: "text" as const, text: await query("/api/v1/rhc/copytrade/subscriptions") }],
    })
  );

  server.tool(
    "rhc_copytrade_create",
    "CREATE a Robinhood Chain copy-trade rule (POST — this writes and consumes quota; do not call it to explore). Amounts are ETH, not SOL. IMPORTANT: RHC copy-trade has NO market-cap band (no min_mc_usd/max_mc_usd) — unlike the Solana engine — because the RHC KOL trade event carries no market cap, so the filter would either need a per-event DB lookup on a ~3.3M-trades/day chain or silently never match. Returns webhook_secret EXACTLY ONCE when delivery_mode includes 'webhook' — store it, payloads are HMAC-SHA256 over `<timestamp>.<body>` in X-MadeOnSol-Signature. Rule/wallet caps are PER CHAIN (PRO 3 rules / 5 wallets, ULTRA 20 / 50, BUSINESS 100 / 250); exceeding the rule cap returns 409. Tier: PRO+.",
    {
      source_wallets: z.array(z.string()).min(1).max(250).describe("1-250 source EVM wallets to mirror (0x, 40 hex). Lowercased on write. Capped by tier: PRO 5, ULTRA 50, BUSINESS 250"),
      sizing_amount: z.number().positive().describe("Amount in ETH, interpreted by sizing_mode. Required"),
      name: z.string().min(1).max(64).optional().describe("Optional human label (max 64 chars)"),
      min_trade_eth: z.number().min(0).optional().describe("Minimum source-wallet trade size in ETH to fire (default 0)"),
      only_action: z.enum(["buy", "sell", "both"]).optional().describe("Which side to mirror (default 'buy')"),
      sizing_mode: z.enum(["fixed", "proportional", "percent_source"]).optional().describe("How sizing_amount is interpreted (default 'fixed')"),
      delivery_mode: z.enum(["webhook", "websocket", "both"]).optional().describe("Where signals are delivered (default 'webhook')"),
      webhook_url: z.string().url().optional().describe("HTTPS URL — REQUIRED unless delivery_mode is 'websocket'"),
    },
    createWrite,
    async (args) => ({
      content: [{ type: "text" as const, text: await mutate("POST", "/api/v1/rhc/copytrade/subscriptions", definedOnly(args)) }],
    })
  );

  server.tool(
    "rhc_copytrade_get",
    "Get ONE Robinhood Chain copy-trade rule by id. Returns 404 if the rule does not exist or is not yours. Tier: PRO+.",
    {
      id: z.number().int().positive().describe("Copy-trade rule id (positive integer)"),
    },
    readOnly,
    async ({ id }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/copytrade/subscriptions/${id}`) }],
    })
  );

  server.tool(
    "rhc_copytrade_update",
    "UPDATE a Robinhood Chain copy-trade rule (PATCH — this writes). Send only the fields you want changed; is_active:false pauses a rule without deleting it. source_wallets is a whole-list REPLACE and is re-checked against the tier wallet cap, so a PRO rule cannot be PATCHed past 5 wallets. Pass null for name or webhook_url to clear them. There is no market-cap band to set on RHC. Tier: PRO+.",
    {
      id: z.number().int().positive().describe("Copy-trade rule id (positive integer)"),
      name: z.string().min(1).max(64).nullable().optional().describe("New label, or null to clear"),
      source_wallets: z.array(z.string()).min(1).max(250).optional().describe("Replacement wallet list (0x, 40 hex) — re-checked against the tier cap"),
      min_trade_eth: z.number().min(0).optional().describe("Minimum source trade size in ETH"),
      only_action: z.enum(["buy", "sell", "both"]).optional().describe("Which side to mirror"),
      sizing_mode: z.enum(["fixed", "proportional", "percent_source"]).optional().describe("How sizing_amount is interpreted"),
      sizing_amount: z.number().positive().optional().describe("Amount in ETH"),
      delivery_mode: z.enum(["webhook", "websocket", "both"]).optional().describe("Where signals are delivered"),
      webhook_url: z.string().url().nullable().optional().describe("New HTTPS webhook URL, or null to clear"),
      is_active: z.boolean().optional().describe("false pauses the rule without deleting it"),
    },
    updateWrite,
    async ({ id, ...patch }) => ({
      content: [{ type: "text" as const, text: await mutate("PATCH", `/api/v1/rhc/copytrade/subscriptions/${id}`, definedOnly(patch)) }],
    })
  );

  server.tool(
    "rhc_copytrade_delete",
    "DELETE a Robinhood Chain copy-trade rule PERMANENTLY. This cannot be undone — to stop a rule temporarily use rhc_copytrade_update with is_active:false instead. Returns 404 if the rule does not exist or is not yours. Tier: PRO+.",
    {
      id: z.number().int().positive().describe("Copy-trade rule id (positive integer)"),
    },
    destroyWrite,
    async ({ id }) => ({
      content: [{ type: "text" as const, text: await mutate("DELETE", `/api/v1/rhc/copytrade/subscriptions/${id}`) }],
    })
  );

  server.tool(
    "rhc_copytrade_signals",
    "Fire history for your Robinhood Chain copy-trade rules — the catch-up path after a missed webhook or a dropped WS connection. Each signal carries fired_at, source_wallet, action, token_address/symbol/name, source_eth_amount, suggested_eth_amount, price_usd, dex, tx_hash and delivery status. Retained 7 DAYS, newest first. Read-only. Tier: PRO+.",
    {
      limit: z.number().int().min(1).max(500).default(50).describe("Number of signals (1-500, default 50)"),
      subscription_id: z.number().int().positive().optional().describe("Filter to one of your rules (404 if not yours)"),
      since: z.string().optional().describe("Only signals fired at or after this ISO 8601 timestamp"),
    },
    readOnly,
    async ({ limit, subscription_id, since }) => {
      const params: Record<string, string | number> = { limit };
      if (subscription_id !== undefined) params.subscription_id = subscription_id;
      if (since) params.since = since;
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/copytrade/signals", params) }] };
    }
  );

  /* ── Price alerts (PRO+) ──
   * WRITES. Note the evaluation model differs from Solana: RHC is POLLED. */

  server.tool(
    "rhc_price_alerts_list",
    "List your Robinhood Chain price alerts — market-cap dip/recovery alerts on a single RHC token. Returns baseline_mc_usd (captured when the alert was created), drop_pct, recovery_pct, status, dip_low_mc_usd, dip_fired_at, delivery_mode, is_active, expires_at. TIMING: RHC alerts are POLLED on a ~15 SECOND interval against rhc_token_prices — they are NOT sub-second like the Solana price alerts, because the RHC price writer emits no pg_notify. Quota is PER CHAIN and does not consume the Solana price-alert budget: PRO 5 active, ULTRA 25, BUSINESS 125. Tier: PRO+.",
    {},
    readOnly,
    async () => ({
      content: [{ type: "text" as const, text: await query("/api/v1/rhc/price-alerts") }],
    })
  );

  server.tool(
    "rhc_price_alerts_create",
    "CREATE a Robinhood Chain price alert (POST — this writes and consumes quota). Fires when the token's market cap falls drop_pct below the baseline captured AT CREATION TIME, and optionally again when it recovers recovery_pct off the dip low. TIMING: evaluation is a ~15 SECOND POLL of rhc_token_prices, not a live price loop — effective latency is that interval plus the token's own price-update cadence, so do NOT assume parity with Solana's sub-second alerts. The token must already be tracked with a market cap on RHC or the call returns 400. Returns webhook_secret EXACTLY ONCE when delivery_mode includes 'webhook'. Active-alert quota is PER CHAIN (PRO 5, ULTRA 25, BUSINESS 125); exceeding it returns 409. Tier: PRO+.",
    {
      token_address: z.string().describe("RHC token address (0x, 40 hex). Must be a token we already price"),
      drop_pct: z.number().min(0.01).max(99.99).describe("Percent drop from the creation-time baseline MC that fires the dip (0.01-99.99)"),
      name: z.string().min(1).max(64).optional().describe("Optional human label (max 64 chars)"),
      recovery_pct: z.number().min(0.01).max(1000).optional().describe("Percent rebound off the dip low that fires a recovery event (0.01-1000). Omit for dip-only"),
      delivery_mode: z.enum(["webhook", "websocket", "both"]).optional().describe("Where events are delivered (default 'webhook')"),
      webhook_url: z.string().url().optional().describe("HTTPS URL — REQUIRED unless delivery_mode is 'websocket'"),
    },
    createWrite,
    async (args) => ({
      content: [{ type: "text" as const, text: await mutate("POST", "/api/v1/rhc/price-alerts", definedOnly(args)) }],
    })
  );

  server.tool(
    "rhc_price_alerts_get",
    "Get ONE Robinhood Chain price alert by id, including its captured baseline_mc_usd, current status and dip_low_mc_usd. Returns 404 if the alert does not exist or is not yours. Tier: PRO+.",
    {
      id: z.number().int().positive().describe("Price alert id (positive integer)"),
    },
    readOnly,
    async ({ id }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/price-alerts/${id}`) }],
    })
  );

  server.tool(
    "rhc_price_alerts_update",
    "UPDATE a Robinhood Chain price alert (PATCH — this writes). Only name, delivery_mode, webhook_url and is_active are mutable. token_address, drop_pct and recovery_pct are IMMUTABLE BY DESIGN: changing a threshold on an already-dipped alert would make its recorded events uninterpretable — delete and recreate instead (which also re-captures the baseline). Pass null for name or webhook_url to clear them. Tier: PRO+.",
    {
      id: z.number().int().positive().describe("Price alert id (positive integer)"),
      name: z.string().min(1).max(64).nullable().optional().describe("New label, or null to clear"),
      delivery_mode: z.enum(["webhook", "websocket", "both"]).optional().describe("Where events are delivered"),
      webhook_url: z.string().url().nullable().optional().describe("New HTTPS webhook URL, or null to clear"),
      is_active: z.boolean().optional().describe("false pauses the alert without deleting it"),
    },
    updateWrite,
    async ({ id, ...patch }) => ({
      content: [{ type: "text" as const, text: await mutate("PATCH", `/api/v1/rhc/price-alerts/${id}`, definedOnly(patch)) }],
    })
  );

  server.tool(
    "rhc_price_alerts_delete",
    "DELETE a Robinhood Chain price alert PERMANENTLY. This cannot be undone — to stop it temporarily use rhc_price_alerts_update with is_active:false. Note that recreating an alert re-captures the baseline market cap at the new creation time, so a delete+recreate is NOT a no-op. Tier: PRO+.",
    {
      id: z.number().int().positive().describe("Price alert id (positive integer)"),
    },
    destroyWrite,
    async ({ id }) => ({
      content: [{ type: "text" as const, text: await mutate("DELETE", `/api/v1/rhc/price-alerts/${id}`) }],
    })
  );

  server.tool(
    "rhc_price_alerts_events",
    "Fire history for your Robinhood Chain price alerts — the catch-up path after a missed webhook or a dropped WS connection. Each event carries event_type ('dip' or 'recovery'), fired_at, token_address, baseline_mc_usd, current_mc_usd, drop_pct_actual, dip_low_mc_usd, recovery_pct_actual and delivery status. Retained 30 DAYS, newest first. Because evaluation is a ~15s poll, fired_at is the poll tick that observed the move, not the exact on-chain moment. Read-only. Tier: PRO+.",
    {
      limit: z.number().int().min(1).max(500).default(50).describe("Number of events (1-500, default 50)"),
      alert_id: z.number().int().positive().optional().describe("Filter to one of your alerts (404 if not yours)"),
      event_type: z.enum(["dip", "recovery"]).optional().describe("Only dip events or only recovery events"),
      since: z.string().optional().describe("Only events fired at or after this ISO 8601 timestamp"),
    },
    readOnly,
    async ({ limit, alert_id, event_type, since }) => {
      const params: Record<string, string | number> = { limit };
      if (alert_id !== undefined) params.alert_id = alert_id;
      if (event_type) params.event_type = event_type;
      if (since) params.since = since;
      return { content: [{ type: "text" as const, text: await query("/api/v1/rhc/price-alerts/events", params) }] };
    }
  );

  /* ── Coordination alert rules (PRO+) ── WRITES. */

  server.tool(
    "rhc_coordination_alerts_list",
    "List your Robinhood Chain coordination alert rules — rules that fire when min_kols+ tracked KOLs buy the same RHC token inside a rolling window. Returns min_kols, window_minutes, min_score, cooldown_min, score_jump_break, the optional min_mc_usd/max_mc_usd band, delivery_mode and is_active. Rule quota is PER CHAIN and does not consume the Solana coordination budget: PRO 5, ULTRA 20, BUSINESS 100. Tier: PRO+.",
    {},
    readOnly,
    async () => ({
      content: [{ type: "text" as const, text: await query("/api/v1/rhc/kol/coordination/alerts") }],
    })
  );

  server.tool(
    "rhc_coordination_alerts_create",
    "CREATE a Robinhood Chain coordination alert rule (POST — this writes and consumes quota). Fires when min_kols+ distinct tracked KOLs buy the same RHC token within window_minutes and the cluster scores at least min_score. SCORING CAVEAT: the shared v1 scorer is used so the number is comparable to Solana, but on RHC the `earliness` component is DEFAULTED to 50 (RHC has no early-entry equivalent) while `quality` is real (KOL 7d win-rate); every fired signal records which components were real in score_inputs. Delivered on the rhc:kol:coordination WS channel and/or an HMAC-signed webhook; webhook_secret is returned EXACTLY ONCE. Rule quota is PER CHAIN (PRO 5, ULTRA 20, BUSINESS 100); exceeding it returns 409. Tier: PRO+.",
    {
      name: z.string().min(1).max(64).optional().describe("Optional human label (max 64 chars)"),
      min_kols: z.number().int().min(2).max(50).optional().describe("Minimum distinct KOL buyers to fire (2-50, default 3)"),
      window_minutes: z.number().int().min(1).max(60).optional().describe("Rolling cluster window in minutes (1-60, default 15)"),
      min_score: z.number().int().min(0).max(100).optional().describe("Minimum composite score 0-100 (default 0)"),
      cooldown_min: z.number().int().min(1).max(1440).optional().describe("Silence per (rule, token) in minutes (1-1440, default 30)"),
      score_jump_break: z.number().int().min(0).max(100).optional().describe("Re-fire inside the cooldown when the score jumps this many points (0-100, default 20)"),
      min_mc_usd: z.number().min(0).max(1e12).nullable().optional().describe("Minimum token market cap, or null for no floor"),
      max_mc_usd: z.number().min(0).max(1e12).nullable().optional().describe("Maximum token market cap — must be >= min_mc_usd"),
      delivery_mode: z.enum(["websocket", "webhook", "both"]).optional().describe("Where fires are delivered (default 'websocket')"),
      webhook_url: z.string().url().optional().describe("HTTPS URL — REQUIRED unless delivery_mode is 'websocket'"),
    },
    createWrite,
    async (args) => ({
      content: [{ type: "text" as const, text: await mutate("POST", "/api/v1/rhc/kol/coordination/alerts", definedOnly(args)) }],
    })
  );

  server.tool(
    "rhc_coordination_alerts_get",
    "Get ONE Robinhood Chain coordination alert rule by id (UUID). Returns 404 if the rule does not exist or is not yours. Tier: PRO+.",
    {
      id: z.string().describe("Coordination rule id (UUID)"),
    },
    readOnly,
    async ({ id }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/kol/coordination/alerts/${encodeURIComponent(id)}`) }],
    })
  );

  server.tool(
    "rhc_coordination_alerts_update",
    "UPDATE a Robinhood Chain coordination alert rule (PATCH — this writes). Send only the fields you want changed; is_active:false pauses the rule without deleting it. The min_mc_usd <= max_mc_usd check is only applied when BOTH bounds arrive in the same call, so send both together when narrowing a band. Pass null for name, webhook_url, min_mc_usd or max_mc_usd to clear them. Tier: PRO+.",
    {
      id: z.string().describe("Coordination rule id (UUID)"),
      name: z.string().min(1).max(64).nullable().optional().describe("New label, or null to clear"),
      min_kols: z.number().int().min(2).max(50).optional().describe("Minimum distinct KOL buyers (2-50)"),
      window_minutes: z.number().int().min(1).max(60).optional().describe("Rolling cluster window in minutes (1-60)"),
      min_score: z.number().int().min(0).max(100).optional().describe("Minimum composite score 0-100"),
      cooldown_min: z.number().int().min(1).max(1440).optional().describe("Silence per (rule, token) in minutes (1-1440)"),
      score_jump_break: z.number().int().min(0).max(100).optional().describe("Re-fire threshold in score points (0-100)"),
      min_mc_usd: z.number().min(0).max(1e12).nullable().optional().describe("Minimum market cap, or null to clear the floor"),
      max_mc_usd: z.number().min(0).max(1e12).nullable().optional().describe("Maximum market cap, or null to clear the ceiling"),
      delivery_mode: z.enum(["websocket", "webhook", "both"]).optional().describe("Where fires are delivered"),
      webhook_url: z.string().url().nullable().optional().describe("New HTTPS webhook URL, or null to clear"),
      is_active: z.boolean().optional().describe("false pauses the rule without deleting it"),
    },
    updateWrite,
    async ({ id, ...patch }) => ({
      content: [{ type: "text" as const, text: await mutate("PATCH", `/api/v1/rhc/kol/coordination/alerts/${encodeURIComponent(id)}`, definedOnly(patch)) }],
    })
  );

  server.tool(
    "rhc_coordination_alerts_delete",
    "DELETE a Robinhood Chain coordination alert rule PERMANENTLY. This cannot be undone — to stop it temporarily use rhc_coordination_alerts_update with is_active:false. Tier: PRO+.",
    {
      id: z.string().describe("Coordination rule id (UUID)"),
    },
    destroyWrite,
    async ({ id }) => ({
      content: [{ type: "text" as const, text: await mutate("DELETE", `/api/v1/rhc/kol/coordination/alerts/${encodeURIComponent(id)}`) }],
    })
  );

  /* ── First-touch subscriptions (ULTRA+) ── WRITES. */

  server.tool(
    "rhc_first_touch_subscriptions_list",
    "List your Robinhood Chain first-touch subscriptions — push rules that fire when a token receives its FIRST buy from any tracked KOL (the discovery signal behind rhc_kol_first_touches). Returns the filters object, delivery_mode, webhook_url and is_active. Subscription quota is PER CHAIN and does not consume the Solana first-touch budget: ULTRA 10, BUSINESS 50 (PRO is 0 — this feature is ULTRA+). Tier: ULTRA+.",
    {},
    readOnly,
    async () => ({
      content: [{ type: "text" as const, text: await query("/api/v1/rhc/kol/first-touches/subscriptions") }],
    })
  );

  server.tool(
    "rhc_first_touch_subscriptions_create",
    "CREATE a Robinhood Chain first-touch subscription (POST — this writes and consumes quota). Pushes on the rhc:kol:first_touches WS channel and/or an HMAC-signed webhook the moment a token gets its first tracked-KOL buy. FILTER SET DIFFERS FROM SOLANA ON PURPOSE: RHC has no scout-score table, so min_scout_tier and min_n_touches do NOT exist here (a filter that silently matched nothing would be worse than its absence); the RHC quality gates are min_kol_winrate and strategy. Unknown filter keys are REJECTED, not ignored. webhook_secret is returned EXACTLY ONCE. Quota is PER CHAIN (ULTRA 10, BUSINESS 50); exceeding it returns 409. Tier: ULTRA+.",
    {
      name: z.string().min(1).max(64).optional().describe("Optional human label (max 64 chars)"),
      filters: z
        .object({
          kol: z.string().optional().describe("Only first touches by this KOL EVM wallet (0x, 40 hex). Lowercased on write"),
          min_first_buy_eth: z.number().min(0).max(100000).optional().describe("Minimum size of the first buy in ETH"),
          min_kol_winrate: z.number().min(0).max(1).optional().describe("Minimum KOL 7d win-rate (0-1) — an RHC-only quality gate"),
          strategy: z.enum(["scalper", "day_trader", "swing", "inactive", "unscored"]).optional().describe("Only KOLs classified with this trading strategy"),
          min_mc_usd: z.number().min(0).max(1e12).optional().describe("Minimum token market cap at the first touch"),
          max_mc_usd: z.number().min(0).max(1e12).optional().describe("Maximum token market cap — must be >= min_mc_usd"),
        })
        .optional()
        .describe("Filter object. Omit or {} to receive every first touch. Unknown keys are rejected"),
      delivery_mode: z.enum(["websocket", "webhook", "both"]).optional().describe("Where events are delivered (default 'websocket')"),
      webhook_url: z.string().url().optional().describe("HTTPS URL — REQUIRED unless delivery_mode is 'websocket'"),
    },
    createWrite,
    async (args) => ({
      content: [{ type: "text" as const, text: await mutate("POST", "/api/v1/rhc/kol/first-touches/subscriptions", definedOnly(args)) }],
    })
  );

  server.tool(
    "rhc_first_touch_subscriptions_get",
    "Get ONE Robinhood Chain first-touch subscription by id (UUID), including its stored filters object. Returns 404 if the subscription does not exist or is not yours. Tier: ULTRA+.",
    {
      id: z.string().describe("First-touch subscription id (UUID)"),
    },
    readOnly,
    async ({ id }) => ({
      content: [{ type: "text" as const, text: await query(`/api/v1/rhc/kol/first-touches/subscriptions/${encodeURIComponent(id)}`) }],
    })
  );

  server.tool(
    "rhc_first_touch_subscriptions_update",
    "UPDATE a Robinhood Chain first-touch subscription (PATCH — this writes). CAREFUL: `filters` is a WHOLE-OBJECT REPLACE, not a merge — send the complete filter set you want, because any key you omit is removed (that is the only way to express 'drop this filter'). Read the current filters with rhc_first_touch_subscriptions_get first. is_active:false pauses without deleting. Pass null for name or webhook_url to clear them. Tier: ULTRA+.",
    {
      id: z.string().describe("First-touch subscription id (UUID)"),
      name: z.string().min(1).max(64).nullable().optional().describe("New label, or null to clear"),
      filters: z
        .object({
          kol: z.string().optional().describe("Only first touches by this KOL EVM wallet (0x, 40 hex)"),
          min_first_buy_eth: z.number().min(0).max(100000).optional().describe("Minimum size of the first buy in ETH"),
          min_kol_winrate: z.number().min(0).max(1).optional().describe("Minimum KOL 7d win-rate (0-1)"),
          strategy: z.enum(["scalper", "day_trader", "swing", "inactive", "unscored"]).optional().describe("Only KOLs with this trading strategy"),
          min_mc_usd: z.number().min(0).max(1e12).optional().describe("Minimum token market cap at the first touch"),
          max_mc_usd: z.number().min(0).max(1e12).optional().describe("Maximum token market cap — must be >= min_mc_usd"),
        })
        .optional()
        .describe("REPLACES the stored filter object wholesale — omitted keys are dropped, not kept"),
      delivery_mode: z.enum(["websocket", "webhook", "both"]).optional().describe("Where events are delivered"),
      webhook_url: z.string().url().nullable().optional().describe("New HTTPS webhook URL, or null to clear"),
      is_active: z.boolean().optional().describe("false pauses the subscription without deleting it"),
    },
    updateWrite,
    async ({ id, ...patch }) => ({
      content: [{ type: "text" as const, text: await mutate("PATCH", `/api/v1/rhc/kol/first-touches/subscriptions/${encodeURIComponent(id)}`, definedOnly(patch)) }],
    })
  );

  server.tool(
    "rhc_first_touch_subscriptions_delete",
    "DELETE a Robinhood Chain first-touch subscription PERMANENTLY. This cannot be undone — to stop it temporarily use rhc_first_touch_subscriptions_update with is_active:false. Tier: ULTRA+.",
    {
      id: z.string().describe("First-touch subscription id (UUID)"),
    },
    destroyWrite,
    async ({ id }) => ({
      content: [{ type: "text" as const, text: await mutate("DELETE", `/api/v1/rhc/kol/first-touches/subscriptions/${encodeURIComponent(id)}`) }],
    })
  );
}

/** Tool catalog for discovery cards (Smithery / glama). Keep in sync with registerTools. */
const TOOL_CARDS = [
  { name: "rhc_kol_feed", description: "Real-time Robinhood Chain KOL trade feed — EVM-native (0x, eth_amount, tx_hash)." },
  { name: "rhc_kol_leaderboard", description: "RHC KOLs ranked by trade count then net ETH flow (24h/7d/30d)." },
  { name: "rhc_kol_hot_tokens", description: "RHC consensus tokens — bought by 2+ distinct KOLs in the window." },
  { name: "rhc_kol_profile", description: "Single RHC KOL profile — stats over last 200 trades + 50 recent." },
  { name: "rhc_kol_coordination", description: "RHC tokens bought by N+ distinct KOLs — net ETH, accumulating vs distributing." },
  { name: "rhc_kol_first_touches", description: "RHC earliest KOL buy per token — the discovery signal, with MC at entry." },
  { name: "rhc_trades", description: "RHC DEX trade tape — Uniswap v2/v3/v4 swaps with trader_eoa + MEV fields. PRO+." },
  { name: "rhc_tokens", description: "RHC token discovery — MC, liquidity, peak MC, launchpad, deployer tier. PRO+." },
  { name: "rhc_token", description: "RHC token snapshot — price/MC/FDV, deployer block, KOL activity, pools." },
  { name: "rhc_token_batch", description: "Up to 50 RHC tokens in one call — price/MC/FDV, peak MC, deployer reputation." },
  { name: "rhc_token_candles", description: "RHC 1-minute OHLC candles — price + MC OHLC, volume buy/sell split. PRO+." },
  { name: "rhc_token_kol_consensus", description: "RHC KOL consensus on a token — buyers/sellers, exit rate, net_flow_eth. PRO+." },
  { name: "rhc_token_buyer_quality", description: "RHC 0–100 early-buyer quality with bundle + dump-cluster legs." },
  { name: "rhc_token_batch_buyer_quality", description: "Early-buyer quality for up to 20 RHC tokens in one call (cap is 20, not 50)." },
  { name: "rhc_token_bundle", description: "RHC launch-bundle detection (same_block) + how much the cohort still holds." },
  { name: "rhc_token_top_traders", description: "Top traders of an RHC token by REALIZED eth (sell−buy, not PnL) + reputation. PRO+." },
  { name: "rhc_token_flow", description: "RHC net buy/sell by cohort; net_eth = sell−buy so positive = distributing. PRO+." },
  { name: "rhc_token_peak_history", description: "RHC peak MC + drawdown + high-water curve; recorded vs observed peak. PRO+." },
  { name: "rhc_token_risk", description: "RHC EVM-native risk computed live — proxy, LP custody, live honeypot sell-sim. PRO+." },
  { name: "rhc_token_holders", description: "RHC exact holders + concentration from Transfer-log replay, supply-reconciled. PRO+." },
  { name: "rhc_deployer_leaderboard", description: "RHC deployers ranked by reputation — tier rides runner_rate ($100K) + 24h history." },
  { name: "rhc_deployer_profile", description: "Single RHC deployer profile + 50 most recent tokens." },
  { name: "rhc_deployer_tokens", description: "Paginated RHC deployer launch history with live + peak MC." },
  { name: "rhc_deployer_history", description: "Deep-paginated RHC deployer deploy history with exact total. PRO+." },
  { name: "rhc_deployer_trajectory", description: "Is an RHC deployer improving or declining — streaks + rolling success curve." },
  { name: "rhc_deployer_best_tokens", description: "Highest peak-MC RHC tokens launched by elite/good deployers in a window." },
  { name: "rhc_deployer_stats", description: "RHC chain-wide deployer summary — tier populations, spam share, active tier rules." },
  { name: "rhc_deployer_alerts", description: "RHC deployer alerts — tradability-filtered by default, tier resolved at read time." },
  { name: "rhc_recent_bonds", description: "RHC tokens that just crossed the $40K peak-MC graduation milestone." },
  { name: "rhc_alpha_wallets", description: "RHC smart-money wallets — net_eth, win_rate, memecoin_share, likely_bot. PRO+." },
  { name: "rhc_copytrade_list", description: "List RHC copy-trade rules. Quota is per-chain. PRO+." },
  { name: "rhc_copytrade_create", description: "WRITES — create an RHC copy-trade rule (ETH sizing, no MC band). PRO+." },
  { name: "rhc_copytrade_get", description: "Get one RHC copy-trade rule by id. PRO+." },
  { name: "rhc_copytrade_update", description: "WRITES — patch an RHC copy-trade rule; source_wallets is a replace. PRO+." },
  { name: "rhc_copytrade_delete", description: "DESTRUCTIVE — permanently delete an RHC copy-trade rule. PRO+." },
  { name: "rhc_copytrade_signals", description: "RHC copy-trade fire history (7-day catch-up feed). PRO+." },
  { name: "rhc_price_alerts_list", description: "List RHC price alerts — ~15s polled, not sub-second. PRO+." },
  { name: "rhc_price_alerts_create", description: "WRITES — create an RHC MC dip/recovery alert (~15s poll). PRO+." },
  { name: "rhc_price_alerts_get", description: "Get one RHC price alert by id, with its captured baseline MC. PRO+." },
  { name: "rhc_price_alerts_update", description: "WRITES — patch an RHC price alert; thresholds are immutable. PRO+." },
  { name: "rhc_price_alerts_delete", description: "DESTRUCTIVE — permanently delete an RHC price alert. PRO+." },
  { name: "rhc_price_alerts_events", description: "RHC price-alert fire history (30-day dip/recovery events). PRO+." },
  { name: "rhc_coordination_alerts_list", description: "List RHC coordination alert rules. Quota is per-chain. PRO+." },
  { name: "rhc_coordination_alerts_create", description: "WRITES — create an RHC N-KOL coordination rule (earliness defaulted). PRO+." },
  { name: "rhc_coordination_alerts_get", description: "Get one RHC coordination alert rule by UUID. PRO+." },
  { name: "rhc_coordination_alerts_update", description: "WRITES — patch an RHC coordination alert rule. PRO+." },
  { name: "rhc_coordination_alerts_delete", description: "DESTRUCTIVE — permanently delete an RHC coordination rule. PRO+." },
  { name: "rhc_first_touch_subscriptions_list", description: "List RHC first-touch push subscriptions. ULTRA+." },
  { name: "rhc_first_touch_subscriptions_create", description: "WRITES — create an RHC first-touch push subscription. ULTRA+." },
  { name: "rhc_first_touch_subscriptions_get", description: "Get one RHC first-touch subscription by UUID. ULTRA+." },
  { name: "rhc_first_touch_subscriptions_update", description: "WRITES — patch an RHC first-touch sub; filters REPLACE wholesale. ULTRA+." },
  { name: "rhc_first_touch_subscriptions_delete", description: "DESTRUCTIVE — permanently delete an RHC first-touch subscription. ULTRA+." },
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
