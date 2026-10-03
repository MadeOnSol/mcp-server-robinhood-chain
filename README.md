# mcp-server-robinhood-chain

[![npm version](https://img.shields.io/npm/v/mcp-server-robinhood-chain?style=flat-square)](https://www.npmjs.com/package/mcp-server-robinhood-chain)
[![npm downloads](https://img.shields.io/npm/dm/mcp-server-robinhood-chain?style=flat-square)](https://www.npmjs.com/package/mcp-server-robinhood-chain)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2?style=flat-square)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

> 📚 **[API docs](https://madeonsol.com/api-docs)** · 🤖 **[Robinhood Chain](https://madeonsol.com/robinhood)** · 💰 **[Free API key](https://madeonsol.com/pricing)**

**Robinhood Chain MCP server — EVM-native on-chain trading intelligence for AI agents, chain id 4663.**

Give Claude, Cursor, or any [MCP](https://modelcontextprotocol.io/) client direct access to Robinhood Chain (an Arbitrum Orbit L2) trading data from our **self-hosted RHC node**: real-time KOL trades plus coordination and first-touch discovery signals, the full Uniswap v2/v3/v4 DEX trade tape, token discovery with launch-bundle + early-buyer-quality detection (single **and** batch), 1-minute OHLC candles, deployer reputation across 99k+ ranked deployers (leaderboard, alerts, trajectory, per-deployer launch history), and smart-money wallet ranking — plus full CRUD over the RHC **rule engines**: copy-trade rules, market-cap dip/recovery price alerts, KOL-coordination alerts and first-touch push subscriptions, all with per-chain quotas. Every tool is EVM-native — lowercase `0x` addresses, `eth_amount`, `tx_hash`, `block_number`, `net_flow_eth`. The KOL→EVM mapping is recovered by tracing each Solana KOL's bridge deposits (deBridge / Relay / Mayan / Wormhole), a dataset unique to MadeOnSol.

RHC coverage is **bundled into every tier at no extra cost**. Get a free API key (200 req/day, no card) at [madeonsol.com/pricing](https://madeonsol.com/pricing).

> **0.8.1** — version alignment with the wider RHC SDK release: WebSocket stream tokens (`POST /api/v1/stream/token`) **never expire** since 2026-08-27 — the same token comes back on every call, `expires_at` / `next_refresh_at` are always `null`, and only an explicit `{"rotate": true}` replaces one. This MCP server exposes REST tools, not WebSocket channels, and has no stream-token tool, so no tool behavior changed.

> **0.5.0** — version alignment with the wider RHC SDK release: the stream channel names were corrected in the TS/Python/Rust SDKs (the RHC firehose channel is `rhc:dex_trades`; the server accepts `rhc:trades` only as a deprecated alias of it). This MCP server exposes REST tools, not WebSocket channels, so no tool behavior changed — the `rhc_trades` tool (the `GET /rhc/trades` tape) is unaffected.

> **Key-mode only.** Authenticate with an `msk_` Bearer API key (`MADEONSOL_API_KEY`). Robinhood Chain does have a keyless x402 pay-per-call rail — now 10 endpoints (grew from the original 6), documented at [madeonsol.com/robinhood/x402](https://madeonsol.com/robinhood/x402) — but it is not part of this server.

> **New in 0.13.0: token lock provenance.** Tool descriptions: Token lock rows carry `provider` (identity decided by the locker contract address: `verified` only for known provider deployments; `compatible` = ABI match, operator not identified, no id / website / `lock_url`), `explorer` (Blockscout links), `price_usd`, `seconds_until_end`, `seconds_until_next_unlock` (server 2026-10-02). RHC withdrawals stay untracked (`withdrawn` null); LP rows never get usd / price / %. Additive only. `rhc_token_locks` accepts `cursor` (strict keyset paging).

> **New in 0.11.0 — BREAKING: HTTP mode now requires a separate token (security fix, SEC-02).** If you run this server with `MCP_TRANSPORT=http`, you must now also set `MCP_HTTP_TOKEN` (a random secret you generate) and send it as `Authorization: Bearer <token>` on **every** request, including `GET /health` and the server-card endpoint — previously, anything that could reach the bound port could call every tool using the operator's own credentials with no authentication at all. HTTP mode is now hard-restricted to literal loopback (`127.0.0.1` / `::1`), rejects `Origin`/`X-Forwarded-*` headers and duplicate `Authorization`/`Host` headers outright, exposes only `POST /mcp` plus the two GET routes, and refuses to start if a wallet/payment credential is configured. **If you use the default `stdio` transport (Claude Desktop, Cursor, most MCP clients), nothing changes — no action needed.** This is a single shared-operator-token fix, not a new multi-user or OAuth system. Full writeup: `docs/audit/SEC02_PRIVATE_HTTP_MCP.md`.
>
> **New in 0.10.1 — the server now reports MCP `instructions`.** The `initialize` response's `instructions` field (operational guidance for the calling agent — distinct from this README/package description) was never set; directories that introspect the live server (Glama) reported "no recorded MCP instructions." No new tools; still 68 total.
>
> **New in 0.10.0 — token locks & vesting (68 tools total).** Three new tools, shipped 2026-09-15 and only now documented here (the code shipped without a version bump or a changelog line, so this README kept saying 65 while the server had actually registered 68 — checked going forward by `scripts/verify-mcp-tool-counts.mjs` in the main repo). `rhc_token_locks` (**PRO+**) is the newest-first feed of lock/vesting contracts created across every token — PinkLock-compatible, HoodLock, Team Finance-compatible, Titan, UNCX-compatible LP lockers and Sablier v4, decoded from our own node. `rhc_token_lock_summary` (**PRO+**) rolls every lock on ONE token into a live "did the team lock, how much, until when, can they cancel" view. `rhc_token_unlocks` (**PRO+**) lists upcoming unlock events chain-wide inside a 1h–90d window. All three are **create-only**: withdrawals and cancels are not tracked by any RHC locker's on-chain events, so `withdrawn` is always `null` (unknown), never `0` — never present a lock as "still held" beyond what the schedule says.
>
> **New in 0.9.0 — early buyers (65 tools total at the time).** `rhc_token_early_buyers` (`GET /rhc/tokens/{address}/early-buyers`, PRO+) — first buyers of a token, ranked, with still-holding status. Found by an internal agentic-infra coverage audit as the one RHC capability unreachable from every agent surface, not just this one.
>
> **New in 0.8.0 — tokenized equities + the liquidity-removals feed.** Two new tools. `rhc_equities` (`GET /rhc/equities`, **BASIC**) lists every official Robinhood tokenized stock and ETF (NVDA, SPY, AAPL, …) with live price / MC / liquidity and 24h trades, ETH volume and buyer-seller split, sortable by `volume` / `trades` / `market_cap` / `last_trade` / `symbol`, filterable by exact `symbol` or substring `q`. **Identity is the issuer beacon, never the name**: a token is listed only if its contract is an EIP-1967 beacon proxy on Robinhood's issuer beacon `0xe10b6f6b…151b00`, read from our own node — on ship day there were 20 fake "GameStop • Robinhood Token" contracts and 8 fake NVDAs with the exact official suffix, and none of them appear. `rhc_lp_events` (`GET /rhc/lp-events`, **PRO+**) is the rug signal: Uniswap v2/v3 `Burn` and v4 `ModifyLiquidity` with a negative delta on tracked pools, from our node's log subscription, filterable by `token` / `pool` / `provider` / `dex` and cursor-paginated on `next_before`. **Removals only** — adds are not persisted (the response's `coverage` block says `adds_persisted: false`), amounts are raw uint256 **strings**, v4 rows carry `liquidity` only, and `provider_is_token_deployer` is the classic rug tell. Data since 2026-08-05.

> **New in 0.7.0 — `holder_growth`: who arrived and who left.** The `rhc_token_holders` tool now returns `holder_growth` on `GET /rhc/tokens/{address}/holders`: `{ "1h", "24h", "7d" }` × `{ cutoff_block, entered, entered_still_holding, exited, net }`. *entered* = addresses whose first `Transfer` of the token landed at-or-after the window's cutoff block (any current balance); *entered_still_holding* = those still non-zero; *exited* = pre-existing holders whose last movement in the window left them at zero; *net* ≈ the change in `holder_count`. Pools and burn addresses are excluded from every count. This exists because RHC balances are folded from ERC-20 Transfer logs on our own node — the fold keeps first-seen and last-moved blocks per address and retains zero-balance rows — so it is a direct read, not an estimate; the Solana census is a point-in-time ledger scan with no history and cannot answer this. A window is `null` (never 0) only when the chain had no ingested trades in it; the whole block is `null` only if the growth read failed. Sanity check from ship day: a token launched that morning showed 593 entered / 560 still holding over 24h, and `holder_count` was exactly 560.

> **New in 0.6.0 — wallet intelligence.** Ten new operations covering the Robinhood Chain wallet surface, which had no SDK binding at all until now: `rhc_wallet`, `rhc_wallet_pnl`, `rhc_wallet_positions`, `rhc_wallet_trades`, plus the watchlist tools — `rhc_wallet_tracker_list`, `rhc_wallet_tracker_add`, `rhc_wallet_tracker_remove`, `rhc_wallet_tracker_relabel`, `rhc_wallet_tracker_trades` and `rhc_wallet_tracker_summary`. Everything is **ETH**-denominated, and cost basis is FIFO over a rolling 90-day window — `cost_basis_observable_from` names the date the window opens, so a position opened before it reads as a sell with no matching buy. The profile / PnL / positions trio shares ONE snapshot cache server-side, so calling all three on an address costs roughly one computation rather than three; `cache_hit` says which call paid for it. Watchlist quotas are **per chain** (PRO 50 / ULTRA 100 / BUSINESS 500 RHC wallets), independent of your Solana list.

## Install & configure

Add to your MCP client config (Claude Desktop, Cursor, Claude Code). No install step — `npx` fetches it on first run:

```json
{
  "mcpServers": {
    "robinhood-chain": {
      "command": "npx",
      "args": ["-y", "mcp-server-robinhood-chain"],
      "env": {
        "MADEONSOL_API_KEY": "msk_your_api_key_here"
      }
    }
  }
}
```

Then ask your agent things like *"What are tracked KOLs buying on Robinhood Chain right now?"* or *"Score the early-buyer cohort for token 0x… on chain 4663."*

### Transports

- **stdio** (default) — for local clients (Claude Desktop, Cursor, Claude Code).
- **http** — optional private, API-key-only adapter for one trusted operator on loopback. See the access requirements below; public hosting is unsupported.


## Private HTTP transport (SEC-02)

Stdio remains the default for Claude Desktop, Cursor and other local MCP clients. HTTP now requires an explicit private-operator configuration; previously unauthenticated HTTP launch settings will fail closed.

1. Set `MADEONSOL_API_KEY` to the operator's `msk_` key.
2. Generate a separate random access token, for example `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`, and store it as `MCP_HTTP_TOKEN`. Do not reuse the upstream API key or put either credential in a URL.
3. Set `MCP_TRANSPORT=http`, `HOST=127.0.0.1` (default, or `::1`) and optionally `PORT` (default `3100`). Non-loopback bindings, missing credentials and any `SVM_PRIVATE_KEY` or `RHC_PAYER_KEY` are refused before startup. Solana wallet/x402 mode remains available through stdio.
4. Connect to `http://127.0.0.1:3100/mcp` with `Authorization: Bearer <MCP_HTTP_TOKEN>` on **every request**, plus the normal MCP `Content-Type` and `Accept` headers. Use stdio if the client cannot attach headers. The local token is checked by the MCP adapter; only `MADEONSOL_API_KEY` is sent upstream.

Only `POST /mcp`, `GET /health` and `GET /.well-known/mcp/server-card.json` are exposed, all authenticated. `/` and arbitrary paths are no longer MCP endpoints. The adapter is stateless: it does not issue session IDs, rejects supplied `Mcp-Session-Id`, and returns 405 for GET/DELETE on `/mcp`. Host must be the selected loopback literal with its port, or `localhost` with that exact port. Browser Origin headers, forwarded/proxy headers and cross-origin requests are rejected; no CORS access is granted.

Limits: 256 KiB uncompressed JSON bodies, 8 KiB headers, a 10-second body-upload deadline, and 16 active authenticated requests. Oversized or malformed inputs are rejected before tool dispatch. This is not an overall tool-execution deadline; an upstream action already submitted may continue after a disconnect.

Everyone holding the local token acts as the **same operator**, including access to that operator's mutation tools. This is not a multi-user/OAuth server: do not put it behind a public proxy, share it with untrusted users or expose a funded signer. Separate users require isolated processes/credentials or a future transport that authenticates each principal and maps their own credentials. Restart with a new `MCP_HTTP_TOKEN` to rotate access.

The Docker image uses the same loopback restriction and requires both environment credentials. Its healthcheck authenticates without putting the token in the URL. It does not support a publicly published Docker port; use stdio or a client in the same trusted network namespace.

## Tools — all 64 Robinhood Chain routes

Each tool maps 1:1 to a Robinhood Chain v1 API route. **49 are reads** (GET, plus the two batch tools which POST an address list only because it is too long for a query string) and **15 genuinely write** (POST / PATCH / DELETE on the rule engines, plus the three wallet-watchlist mutations) — those are marked ✍️ / 🗑️ below and carry non-`readOnly` MCP annotations, so a well-behaved client will not call them speculatively. Fields are EVM-native.

### Reads

| Tool | Route | Tier | Description |
|---|---|---|---|
| `rhc_kol_feed` | `/api/v1/rhc/kol/feed` | BASIC | KOL trade feed with MC/peak enrichment and `mc_multiple_since_trade` (real-time on PRO+; 5-min delay on free keys) |
| `rhc_kol_leaderboard` | `/api/v1/rhc/kol/leaderboard` | BASIC | KOLs ranked by trade count then net ETH flow (`24h`/`7d`/`30d`) |
| `rhc_kol_hot_tokens` | `/api/v1/rhc/kol/hot-tokens` | BASIC | Consensus tokens bought by 2+ distinct KOLs in the window |
| `rhc_kol_profile` | `/api/v1/rhc/kol/{wallet}` | BASIC | Single KOL profile — stats over last 200 trades + 50 recent |
| `rhc_kol_coordination` | `/api/v1/rhc/kol/coordination` | BASIC | Tokens bought by `min_kols`+ distinct KOLs — net ETH, accumulating vs distributing, `time_to_consensus_sec`, per-KOL breakdown |
| `rhc_kol_first_touches` | `/api/v1/rhc/kol/first-touches` | BASIC | Earliest KOL buy per token (discovery signal) — MC at entry, token age, `tx_hash`. `evm_address` on ULTRA only |
| `rhc_trades` | `/api/v1/rhc/trades` | PRO+ | DEX trade tape — Uniswap v2/v3/v4 swaps with the effective `trader_eoa` + MEV fields |
| `rhc_lp_events` | `/api/v1/rhc/lp-events` | PRO+ | Liquidity **removals** feed (the rug signal) — v2/v3 `Burn` + v4 negative `ModifyLiquidity`, raw uint256 strings, `provider_is_token_deployer`. Removals only, adds are not persisted |
| `rhc_tokens` | `/api/v1/rhc/tokens` | PRO+ | Token discovery — MC, liquidity, peak MC + drawdown, launchpad, deployer tier |
| `rhc_equities` | `/api/v1/rhc/equities` | BASIC | Tokenized stocks & ETFs (NVDA, SPY, AAPL…) — live price/MC/liquidity + 24h trades / ETH volume / buyer-seller split. Identity = issuer **beacon** `0xe10b…151b00`, never the name |
| `rhc_token` | `/api/v1/rhc/tokens/{address}` | BASIC | Token snapshot — price/MC/FDV, deployer block, KOL activity, pools |
| `rhc_token_batch` | `POST /api/v1/rhc/token/batch` | BASIC | **Up to 50 tokens in one call** — price/MC/FDV, peak MC, deployer reputation. Unknown addresses echo back as `found: false` |
| `rhc_token_candles` | `/api/v1/rhc/tokens/{address}/candles` | PRO+ | 1-minute OHLC candles — price + MC OHLC, volume with buy/sell split |
| `rhc_token_kol_consensus` | `/api/v1/rhc/tokens/{address}/kol-consensus` | PRO+ | KOL positioning — buyers/sellers, exit rate, `net_flow_eth`, median entry MC |
| `rhc_token_buyer_quality` | `/api/v1/rhc/tokens/{address}/buyer-quality` | BASIC | 0–100 early-buyer quality with bundle-buyer + dump-cluster legs |
| `rhc_token_batch_buyer_quality` | `POST /api/v1/rhc/tokens/batch/buyer-quality` | BASIC | Buyer quality for **up to 20** tokens in one call (cap is 20, *not* 50 — it's a per-token cohort computation) |
| `rhc_token_bundle` | `/api/v1/rhc/tokens/{address}/bundle` | BASIC | Launch-bundle detection (`same_block`) + how much the cohort still holds |
| `rhc_token_top_traders` | `/api/v1/rhc/tokens/{address}/top-traders` | PRO+ | Top traders by **realized** ETH flow (`net_eth` = sell − buy, *not* PnL) + wallet reputation |
| `rhc_token_flow` | `/api/v1/rhc/tokens/{address}/flow` | PRO+ | Net buy/sell by mutually-exclusive cohort — positive `net_eth` means that cohort **distributed** |
| `rhc_token_peak_history` | `/api/v1/rhc/tokens/{address}/peak-history` | PRO+ | Peak MC, drawdown, high-water curve — `peak_mc_usd_recorded` vs `peak_mc_usd_observed` |
| `rhc_token_risk` | `/api/v1/rhc/tokens/{address}/risk` | PRO+ | EVM-native risk computed live — proxy upgradeability, LP custody, uncached honeypot sell-sim |
| `rhc_token_holders` | `/api/v1/rhc/tokens/{address}/holders` | PRO+ | Exact holders + concentration from Transfer-log replay, reconciled against `totalSupply()`. Check `verified` first. `holder_growth` (1h/24h/7d): `entered`, `entered_still_holding`, `exited`, `net` ≈ Δ `holder_count` |
| `rhc_deployer_leaderboard` | `/api/v1/rhc/deployer-hunter/leaderboard` | BASIC | 99k+ deployers ranked by reputation — `graduation_rate` ($40K), `runner_rate` ($100K); tier rides `runner_rate` |
| `rhc_deployer_profile` | `/api/v1/rhc/deployer-hunter/{address}` | BASIC | Single deployer profile + 50 most recent tokens |
| `rhc_deployer_tokens` | `/api/v1/rhc/deployer-hunter/{address}/tokens` | BASIC | Paginated launch history with live + peak MC (`sort=peak_mc_usd` is page-scoped) |
| `rhc_deployer_history` | `/api/v1/rhc/deployer-hunter/{address}/history` | PRO+ | Deep-paginated deploy history (up to 1000/page) with an exact total |
| `rhc_deployer_trajectory` | `/api/v1/rhc/deployer-hunter/{address}/trajectory` | BASIC | Improving or declining? Streaks, 10-launch rolling success curve, best/worst stretch. Success = $40K graduation |
| `rhc_deployer_best_tokens` | `/api/v1/rhc/deployer-hunter/best-tokens` | BASIC | Highest peak-MC tokens launched by `elite`/`good` deployers in the window |
| `rhc_deployer_stats` | `/api/v1/rhc/deployer-hunter/stats` | BASIC | Chain-wide summary — tier populations, spam share, alert volume, active `tier_rules` |
| `rhc_deployer_alerts` | `/api/v1/rhc/deployer-hunter/alerts` | BASIC | Deployer alerts — **tradability-filtered by default**, tier resolved at read time (`tier_at_alert`, `tier_is_stale`) |
| `rhc_recent_bonds` | `/api/v1/rhc/deployer-hunter/recent-bonds` | BASIC | Tokens that just crossed the $40K peak-MC graduation milestone, newest peak first |
| `rhc_alpha_wallets` | `/api/v1/rhc/alpha-wallets` | PRO+ | Smart-money wallets — `net_eth`, `win_rate`, `memecoin_share`, `likely_bot` |
| `rhc_wallet` | `/api/v1/rhc/wallet/{address}` | PRO+ | Wallet 90-day profile — ETH PnL, per-token breakdown, reputation flags (shares one snapshot cache with pnl/positions) |
| `rhc_wallet_pnl` | `/api/v1/rhc/wallet/{address}/pnl` | PRO+ | FIFO cost-basis PnL over the rolling 90-day window — curve, closed + open positions; `cost_basis_observable_from` |
| `rhc_wallet_positions` | `/api/v1/rhc/wallet/{address}/positions` | PRO+ | Open positions marked to market — check `liquidity_basis` |
| `rhc_wallet_trades` | `/api/v1/rhc/wallet/{address}/trades` | PRO+ | One wallet's trade tape, keyset-paginated by wallet (not token) |
| `rhc_wallet_tracker_list` | `/api/v1/rhc/wallet-tracker/watchlist` | PRO+ | List your RHC watchlist — quota is per chain |
| ✍️ `rhc_wallet_tracker_add` | `POST /api/v1/rhc/wallet-tracker/watchlist` | PRO+ | Track a wallet (address lowercased on write); 409 if already tracked, 403 at cap |
| 🗑️ `rhc_wallet_tracker_remove` | `DELETE /api/v1/rhc/wallet-tracker/watchlist/{address}` | PRO+ | Untrack a wallet, freeing a quota slot |
| ✍️ `rhc_wallet_tracker_relabel` | `PATCH /api/v1/rhc/wallet-tracker/watchlist/{address}` | PRO+ | Relabel a tracked wallet; `null` clears the label |
| `rhc_wallet_tracker_trades` | `/api/v1/rhc/wallet-tracker/trades` | PRO+ | Merged trade feed across your tracked wallets, label-tagged |
| `rhc_wallet_tracker_summary` | `/api/v1/rhc/wallet-tracker/summary` | PRO+ | Per-wallet rollup from `rhc_trades` — full history, not capture-log scoped |
| `rhc_copytrade_list` | `/api/v1/rhc/copytrade/subscriptions` | PRO+ | List your copy-trade rules. Each carries `source_wallets_tracked` / `source_wallets_untracked` + `warnings` — only tracked KOL wallets (`/rhc/kol/wallets`) can ever fire |
| `rhc_copytrade_get` | `/api/v1/rhc/copytrade/subscriptions/{id}` | PRO+ | One copy-trade rule by numeric id (same tracking fields) |
| `rhc_copytrade_signals` | `/api/v1/rhc/copytrade/signals` | PRO+ | Fire history, **7-day** retention — the catch-up path after a missed webhook |
| `rhc_price_alerts_list` | `/api/v1/rhc/price-alerts` | PRO+ | List your market-cap dip/recovery alerts |
| `rhc_price_alerts_get` | `/api/v1/rhc/price-alerts/{id}` | PRO+ | One price alert by numeric id, with its captured `baseline_mc_usd` |
| `rhc_price_alerts_events` | `/api/v1/rhc/price-alerts/events` | PRO+ | `dip` / `recovery` fire history, **30-day** retention |
| `rhc_coordination_alerts_list` | `/api/v1/rhc/kol/coordination/alerts` | PRO+ | List your KOL-coordination alert rules |
| `rhc_coordination_alerts_get` | `/api/v1/rhc/kol/coordination/alerts/{id}` | PRO+ | One coordination rule by UUID |
| `rhc_first_touch_subscriptions_list` | `/api/v1/rhc/kol/first-touches/subscriptions` | ULTRA+ | List your first-touch push subscriptions |
| `rhc_first_touch_subscriptions_get` | `/api/v1/rhc/kol/first-touches/subscriptions/{id}` | ULTRA+ | One first-touch subscription by UUID |

### Writes — rule engines

These **mutate server state**, consume per-tier quota and fire webhooks. They are annotated `readOnlyHint: false`; the deletes additionally carry `destructiveHint: true`. Creates are *not* idempotent — calling one twice makes two rules and can hit the cap with a `409`.

| Tool | Route | Tier | Description |
|---|---|---|---|
| ✍️ `rhc_copytrade_create` | `POST /api/v1/rhc/copytrade/subscriptions` | PRO+ | Create a copy-trade rule. Returns `webhook_secret` **once** |
| ✍️ `rhc_copytrade_update` | `PATCH /api/v1/rhc/copytrade/subscriptions/{id}` | PRO+ | Patch a rule; `source_wallets` is a whole-list replace, re-checked against the tier cap |
| 🗑️ `rhc_copytrade_delete` | `DELETE /api/v1/rhc/copytrade/subscriptions/{id}` | PRO+ | Permanent. Use `is_active: false` to pause instead |
| ✍️ `rhc_price_alerts_create` | `POST /api/v1/rhc/price-alerts` | PRO+ | Create an MC dip (+ optional recovery) alert. Baseline is captured **now** |
| ✍️ `rhc_price_alerts_update` | `PATCH /api/v1/rhc/price-alerts/{id}` | PRO+ | Only `name` / `delivery_mode` / `webhook_url` / `is_active` — thresholds are immutable |
| 🗑️ `rhc_price_alerts_delete` | `DELETE /api/v1/rhc/price-alerts/{id}` | PRO+ | Permanent. Recreating re-captures the baseline, so delete+recreate is not a no-op |
| ✍️ `rhc_coordination_alerts_create` | `POST /api/v1/rhc/kol/coordination/alerts` | PRO+ | Fire when `min_kols`+ KOLs buy the same token inside `window_minutes` |
| ✍️ `rhc_coordination_alerts_update` | `PATCH /api/v1/rhc/kol/coordination/alerts/{id}` | PRO+ | Patch thresholds, MC band, delivery, `is_active` |
| 🗑️ `rhc_coordination_alerts_delete` | `DELETE /api/v1/rhc/kol/coordination/alerts/{id}` | PRO+ | Permanent |
| ✍️ `rhc_first_touch_subscriptions_create` | `POST /api/v1/rhc/kol/first-touches/subscriptions` | ULTRA+ | Push on a token's first tracked-KOL buy. Unknown filter keys are rejected |
| ✍️ `rhc_first_touch_subscriptions_update` | `PATCH /api/v1/rhc/kol/first-touches/subscriptions/{id}` | ULTRA+ | `filters` **replaces** the stored object wholesale — omitted keys are dropped |
| 🗑️ `rhc_first_touch_subscriptions_delete` | `DELETE /api/v1/rhc/kol/first-touches/subscriptions/{id}` | ULTRA+ | Permanent |

**Rule-engine quotas are PER CHAIN.** A full set of Solana copy-trade rules, price alerts, coordination rules or first-touch subscriptions does **not** consume your RHC allowance, and vice versa.

| Engine | PRO | ULTRA | BUSINESS |
|---|---|---|---|
| Copy-trade rules (source wallets each) | 3 (5) | 20 (50) | 100 (250) |
| Price alerts (active) | 5 | 25 | 125 |
| Coordination rules | 5 | 20 | 100 |
| First-touch subscriptions | — | 10 | 50 |

> BASIC works with any valid key. PRO+ tools return HTTP 403 on a BASIC key — [upgrade at madeonsol.com/pricing](https://madeonsol.com/pricing).

### Five things agents get wrong

- **RHC price alerts fire within a few seconds, not sub-second.** Since 2026-09-15 they are evaluated as trades land on the chain trade feed (`rhc:dex_trade`), with price-table polls (5 s / 60 s) and a trade-tape replay as safety nets; the floor is the chain trade flush (about 2 s). Do **not** promise parity with the Solana price alerts, which are sub-second. The create response's `evaluation` block reads `mode: "event_driven"`. `fired_at` on an event is when the evaluator observed the move, not the on-chain moment.
- **RHC copy-trade has no market-cap band.** There is no `min_mc_usd` / `max_mc_usd` on a copy-trade rule, unlike the Solana engine, because the RHC KOL trade event carries no market cap — the filter would need a per-event DB read on a ~3.3M-trades/day chain, or it would silently never match. Filter on `min_trade_eth` and `only_action` instead.


- **`trader_eoa` is not simply `tx.from`.** It is the *effective trading account*: `tx.from` on an ordinary transaction, but the ERC-4337 userOp sender (`UserOperationEvent`) when the trade was bundled — never the bundler that relayed the batch, and never the router. It is still an EOA either way; on Robinhood Chain a userOp sender is an ordinary EOA carrying an EIP-7702 delegation, not a smart-contract wallet. Attribute trades and rank wallets on `trader_eoa`; the separate `trader` field is only the swap-log recipient, which is the router on aggregated swaps.
- **`rhc_deployer_alerts` filters for tradability by default.** Alerts on tokens with `liquidity_usd` under $100 (including unknown liquidity) are dropped — a $45K-MC alert on a drained $68 pool is not a signal. Pass `include_untradeable: true` for the raw tape; the response always echoes the active `tradability_filter`. The alert's `tier` is resolved from the live reputation view at read time, so it can never advertise a reputation the deployer has since lost — the snapshot taken when the alert fired is returned separately as `tier_at_alert`, with `tier_is_stale` flagging the drift.
- **`graduation_rate` no longer sets the tier.** It still means the $40K peak-MC bar and is still returned everywhere, but `elite`/`good` are earned on `runner_rate` ($100K) plus 24h of deployer history. Ranking deployers by `graduation_rate` is ranking them on a metric the tier ignores.

## Why Robinhood Chain

Robinhood Chain is dual-natured — launchpad memecoins (pons / flap / clanker / hood.fun / virtuals) alongside tokenized stocks and stablecoins. Most launchpads are **direct-to-DEX** (no bonding curve), so "graduation" is a market-cap milestone: `graduation_rate` = share of a deployer's tokens that reached a $40K+ peak MC, `runner_rate` = share that reached $100K+. The `elite`/`good` **tier** rides `runner_rate` and requires 24h of deployer history (elite = 5+ tokens, 24h+ old, `runner_rate >= 0.50`; good = `>= 0.25`) — `graduation_rate` is still reported but no longer sets the tier, since the $40K bar proved farmable; only `spammer` still keys off it (20+ tokens, `graduation_rate < 0.05`). Because it's an Arbitrum Orbit L2 with no atomic multi-signer transaction, a detected launch bundle is `same_block` (there is no `atomic_tx`).

## Links

- 🤖 Robinhood Chain overview — https://madeonsol.com/robinhood
- 💰 Pricing & free API key — https://madeonsol.com/pricing
- 📚 API docs — https://madeonsol.com/api-docs

## License

MIT © MadeOnSol
