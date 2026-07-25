# mcp-server-robinhood-chain

[![npm version](https://img.shields.io/npm/v/mcp-server-robinhood-chain?style=flat-square)](https://www.npmjs.com/package/mcp-server-robinhood-chain)
[![npm downloads](https://img.shields.io/npm/dm/mcp-server-robinhood-chain?style=flat-square)](https://www.npmjs.com/package/mcp-server-robinhood-chain)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2?style=flat-square)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

> 📚 **[API docs](https://madeonsol.com/api-docs)** · 🤖 **[Robinhood Chain](https://madeonsol.com/robinhood)** · 💰 **[Free API key](https://madeonsol.com/pricing)**

**Robinhood Chain MCP server — EVM-native on-chain trading intelligence for AI agents, chain id 4663.**

Give Claude, Cursor, or any [MCP](https://modelcontextprotocol.io/) client direct access to Robinhood Chain (an Arbitrum Orbit L2) trading data from our **self-hosted RHC node**: real-time KOL trades plus coordination and first-touch discovery signals, the full Uniswap v2/v3/v4 DEX trade tape, token discovery with launch-bundle + early-buyer-quality detection (single **and** batch), 1-minute OHLC candles, deployer reputation across 99k+ ranked deployers (leaderboard, alerts, trajectory, per-deployer launch history), and smart-money wallet ranking. Every tool is EVM-native — lowercase `0x` addresses, `eth_amount`, `tx_hash`, `block_number`, `net_flow_eth`. The KOL→EVM mapping is recovered by tracing each Solana KOL's bridge deposits (deBridge / Relay / Mayan / Wormhole), a dataset unique to MadeOnSol.

RHC coverage is **bundled into every tier at no extra cost**. Get a free API key (200 req/day, no card) at [madeonsol.com/pricing](https://madeonsol.com/pricing).

> **Key-mode only.** Authenticate with an `msk_` Bearer API key (`MADEONSOL_API_KEY`). Robinhood Chain does have a keyless x402 pay-per-call rail — a deliberately narrow 6-endpoint subset, documented at [madeonsol.com/robinhood/x402](https://madeonsol.com/robinhood/x402) — but it is not part of this server.

New customers get a **3-day free trial** of Pro or Ultra when you pay by card — full access, nothing charged during the trial, cancel anytime. Start at [madeonsol.com/pricing](https://madeonsol.com/pricing).

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
- **http** — set `MCP_TRANSPORT=http` (+ optional `PORT`, default 3100) for hosted environments (Smithery, etc.). Exposes `/health` and `/.well-known/mcp/server-card.json`.

## Tools — all 25 Robinhood Chain routes

Each tool maps 1:1 to a Robinhood Chain v1 API route — GET, except the two batch tools, which POST an address list. Fields are EVM-native.

| Tool | Route | Tier | Description |
|---|---|---|---|
| `rhc_kol_feed` | `/api/v1/rhc/kol/feed` | BASIC | Real-time KOL trade feed with MC/peak enrichment and `mc_multiple_since_trade` |
| `rhc_kol_leaderboard` | `/api/v1/rhc/kol/leaderboard` | BASIC | KOLs ranked by trade count then net ETH flow (`24h`/`7d`/`30d`) |
| `rhc_kol_hot_tokens` | `/api/v1/rhc/kol/hot-tokens` | BASIC | Consensus tokens bought by 2+ distinct KOLs in the window |
| `rhc_kol_profile` | `/api/v1/rhc/kol/{wallet}` | BASIC | Single KOL profile — stats over last 200 trades + 50 recent |
| `rhc_kol_coordination` | `/api/v1/rhc/kol/coordination` | BASIC | Tokens bought by `min_kols`+ distinct KOLs — net ETH, accumulating vs distributing, `time_to_consensus_sec`, per-KOL breakdown |
| `rhc_kol_first_touches` | `/api/v1/rhc/kol/first-touches` | BASIC | Earliest KOL buy per token (discovery signal) — MC at entry, token age, `tx_hash`. `evm_address` on ULTRA only |
| `rhc_trades` | `/api/v1/rhc/trades` | PRO+ | DEX trade tape — Uniswap v2/v3/v4 swaps with `trader_eoa` + MEV fields |
| `rhc_tokens` | `/api/v1/rhc/tokens` | PRO+ | Token discovery — MC, liquidity, peak MC + drawdown, launchpad, deployer tier |
| `rhc_token` | `/api/v1/rhc/tokens/{address}` | BASIC | Token snapshot — price/MC/FDV, deployer block, KOL activity, pools |
| `rhc_token_batch` | `POST /api/v1/rhc/token/batch` | BASIC | **Up to 50 tokens in one call** — price/MC/FDV, peak MC, deployer reputation. Unknown addresses echo back as `found: false` |
| `rhc_token_candles` | `/api/v1/rhc/tokens/{address}/candles` | PRO+ | 1-minute OHLC candles — price + MC OHLC, volume with buy/sell split |
| `rhc_token_kol_consensus` | `/api/v1/rhc/tokens/{address}/kol-consensus` | PRO+ | KOL positioning — buyers/sellers, exit rate, `net_flow_eth`, median entry MC |
| `rhc_token_buyer_quality` | `/api/v1/rhc/tokens/{address}/buyer-quality` | BASIC | 0–100 early-buyer quality with bundle-buyer + dump-cluster legs |
| `rhc_token_batch_buyer_quality` | `POST /api/v1/rhc/tokens/batch/buyer-quality` | BASIC | Buyer quality for **up to 20** tokens in one call (cap is 20, *not* 50 — it's a per-token cohort computation) |
| `rhc_token_bundle` | `/api/v1/rhc/tokens/{address}/bundle` | BASIC | Launch-bundle detection (`same_block`) + how much the cohort still holds |
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

> BASIC works with any valid key. PRO+ tools return HTTP 403 on a BASIC key — [upgrade at madeonsol.com/pricing](https://madeonsol.com/pricing).

### Two things agents get wrong

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
