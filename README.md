# mcp-server-robinhood-chain

[![npm version](https://img.shields.io/npm/v/mcp-server-robinhood-chain?style=flat-square)](https://www.npmjs.com/package/mcp-server-robinhood-chain)
[![npm downloads](https://img.shields.io/npm/dm/mcp-server-robinhood-chain?style=flat-square)](https://www.npmjs.com/package/mcp-server-robinhood-chain)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2?style=flat-square)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

> 📚 **[API docs](https://madeonsol.com/api-docs)** · 🤖 **[Robinhood Chain](https://madeonsol.com/robinhood)** · 💰 **[Free API key](https://madeonsol.com/pricing)**

**Robinhood Chain MCP server — EVM-native on-chain trading intelligence for AI agents, chain id 4663.**

Give Claude, Cursor, or any [MCP](https://modelcontextprotocol.io/) client direct access to Robinhood Chain (an Arbitrum Orbit L2) trading data from our **self-hosted RHC node**: real-time KOL trades, the full Uniswap v2/v3/v4 DEX trade tape, token discovery with launch-bundle + early-buyer-quality detection, 1-minute OHLC candles, deployer reputation (40k+ deployers), and smart-money wallet ranking. Every tool is EVM-native — lowercase `0x` addresses, `eth_amount`, `tx_hash`, `block_number`, `net_flow_eth`. The KOL→EVM mapping is recovered by tracing each Solana KOL's bridge deposits (deBridge / Relay / Mayan / Wormhole), a dataset unique to MadeOnSol.

RHC coverage is **bundled into every tier at no extra cost**. Get a free API key (200 req/day, no card) at [madeonsol.com/pricing](https://madeonsol.com/pricing).

> **Key-mode only.** Authenticate with an `msk_` Bearer API key (`MADEONSOL_API_KEY`). The x402 pay-per-call rail is Solana-native and is not part of this server.

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

## Tools — all 14 Robinhood Chain routes

Each tool maps 1:1 to a GET /api/v1/rhc/… route. Fields are EVM-native.

| Tool | Route | Tier | Description |
|---|---|---|---|
| `rhc_kol_feed` | `/api/v1/rhc/kol/feed` | BASIC | Real-time KOL trade feed with MC/peak enrichment and `mc_multiple_since_trade` |
| `rhc_kol_leaderboard` | `/api/v1/rhc/kol/leaderboard` | BASIC | KOLs ranked by trade count then net ETH flow (`24h`/`7d`/`30d`) |
| `rhc_kol_hot_tokens` | `/api/v1/rhc/kol/hot-tokens` | BASIC | Consensus tokens bought by 2+ distinct KOLs in the window |
| `rhc_kol_profile` | `/api/v1/rhc/kol/{wallet}` | BASIC | Single KOL profile — stats over last 200 trades + 50 recent |
| `rhc_trades` | `/api/v1/rhc/trades` | PRO+ | DEX trade tape — Uniswap v2/v3/v4 swaps with `trader_eoa` + MEV fields |
| `rhc_tokens` | `/api/v1/rhc/tokens` | PRO+ | Token discovery — MC, liquidity, peak MC + drawdown, launchpad, deployer tier |
| `rhc_token` | `/api/v1/rhc/tokens/{address}` | BASIC | Token snapshot — price/MC/FDV, deployer block, KOL activity, pools |
| `rhc_token_candles` | `/api/v1/rhc/tokens/{address}/candles` | PRO+ | 1-minute OHLC candles — price + MC OHLC, volume with buy/sell split |
| `rhc_token_kol_consensus` | `/api/v1/rhc/tokens/{address}/kol-consensus` | PRO+ | KOL positioning — buyers/sellers, exit rate, `net_flow_eth`, median entry MC |
| `rhc_token_buyer_quality` | `/api/v1/rhc/tokens/{address}/buyer-quality` | BASIC | 0–100 early-buyer quality with bundle-buyer + dump-cluster legs |
| `rhc_token_bundle` | `/api/v1/rhc/tokens/{address}/bundle` | BASIC | Launch-bundle detection (`same_block`) + how much the cohort still holds |
| `rhc_deployer_leaderboard` | `/api/v1/rhc/deployer-hunter/leaderboard` | BASIC | Deployers ranked by reputation — `graduation_rate` ($40K), `runner_rate` ($100K) |
| `rhc_deployer_profile` | `/api/v1/rhc/deployer-hunter/{address}` | BASIC | Single deployer profile + 50 most recent tokens |
| `rhc_alpha_wallets` | `/api/v1/rhc/alpha-wallets` | PRO+ | Smart-money wallets — `net_eth`, `win_rate`, `memecoin_share`, `likely_bot` |

> BASIC works with any valid key. PRO+ tools return HTTP 403 on a BASIC key — [upgrade at madeonsol.com/pricing](https://madeonsol.com/pricing).

## Why Robinhood Chain

Robinhood Chain is dual-natured — launchpad memecoins (pons / flap / clanker / hood.fun / virtuals) alongside tokenized stocks and stablecoins. Most launchpads are **direct-to-DEX** (no bonding curve), so "graduation" is a market-cap milestone: `graduation_rate` = share of a deployer's tokens that reached a $40K+ peak MC, `runner_rate` = share that reached $100K+. Because it's an Arbitrum Orbit L2 with no atomic multi-signer transaction, a detected launch bundle is `same_block` (there is no `atomic_tx`).

## Links

- 🤖 Robinhood Chain overview — https://madeonsol.com/robinhood
- 💰 Pricing & free API key — https://madeonsol.com/pricing
- 📚 API docs — https://madeonsol.com/api-docs

## License

MIT © MadeOnSol
