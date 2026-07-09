# Polymarket Wallet Analyzer

Visual analyzer for any Polymarket wallet. Enter a wallet address (or profile URL) and get:

- **Activity patterns** — trades by hour of day, weekday × hour heatmap, daily timeline, and an inferred home time zone (based on the quietest 7-hour "sleep" window, with a confidence rating)
- **Bet sizing** — distribution of bet sizes in USDC (BUY fills, cost basis = price × shares)
- **Entry / exit prices** — histograms of prices paid on BUY fills and received on SELL fills (2¢ bins)
- **Size vs price relationship** — scatter of bet size against entry price with Pearson and Spearman correlations and a median-bet-per-price-band trend line
- **PnL** — realized PnL, win rate and profit factor over settled bets; unrealized PnL on open positions; the official mark-to-market PnL curve; PnL vs bet size scatter (won/lost); PnL and win rate by entry-price band, with bet-vs-PnL / bet-vs-ROI / entry-vs-ROI correlations

## Run

```bash
npm install
npm start        # http://localhost:3000
```

Requires Node 18+ (uses built-in fetch). Default window is 30 days (7–90 selectable).

## Deploy (free hosting)

This is a long-running Express server whose API calls can take 1–2 minutes for very
heavy wallets, so serverless platforms with short function timeouts (Vercel/Netlify
free tiers) are a poor fit without rework. Recommended:

- **Render (recommended)** — free web service tier, deploys straight from this repo
  via the included `render.yaml`: [dashboard.render.com](https://dashboard.render.com)
  → New → Blueprint → pick this repo. Caveat: free instances sleep after ~15 min idle
  (first request after that takes ~30–60 s to wake).
- **Koyeb** — similar free web-service model, also works with a plain `npm start`.

No environment variables or API keys are required; the server binds `process.env.PORT`.

## Correctness notes

- Data source: the public Polymarket data API (`data-api.polymarket.com/trades`), no API key needed.
- Both **maker and taker** fills are included (`takerOnly=false`); taker-only views undercount active traders significantly.
- The API caps pagination at offset 3000. The fetcher works around this with a moving time cursor: when the cap is hit, the partially-fetched oldest second is dropped and refetched in full as the next window. This is exact — no fills are lost or double-counted, even identical fills in the same transaction. If a wallet somehow has >4000 fills in a single second the fetcher raises an error instead of silently returning partial data.
- Every fill is one data point; the API reports the wallet's own side and price for maker fills (verified: a maker's BUY at 58¢ appears as the counterparty taker's BUY of the opposite outcome at 42¢).
- Redeeming winning shares is not a SELL and does not appear in exit prices.
- Time-zone inference is a heuristic (people rarely trade while asleep) and is labeled with high/medium/low confidence. Bots and 24/7 traders yield "low".
- PnL comes from Polymarket's own accounting, not reconstruction: `/closed-positions` (final realized PnL and cost basis per settled position, paginated newest-first via `sortBy=TIMESTAMP` — its `start`/`end` params do NOT filter, verified), `/positions` (unrealized PnL on open positions), and `user-pnl-api` (the official mark-to-market curve shown on profile pages, fetched with the interval matching the selected window). Two PnL cards are shown because they answer different questions: **Account PnL** is the mark-to-market change over the window (profile-graph delta); **Settled bets PnL** sums each bet's full lifetime PnL for positions settled inside the window.
- **Cash volume** is fill notional (price × shares). Actual cash moved (`usdcSize` in `/activity`) runs ~1% higher on BUYs where taker fees apply. Polymarket's **official volume metric** (shown alongside for 7d/30d windows) counts book trades at USDC paid but credits matched buy-buy fills (complete-set mints) at ~$1 per share — verified to the cent on a mint-only wallet whose official all-time volume exactly equals its total shares bought. For mint-heavy wallets the official number can be several times cash notional; neither is wrong, they answer different questions.
- `node scripts/verify.mjs <wallet> [days]` audits any wallet against independent endpoints: fill count vs `/activity`, notional vs cash volume, curve delta, settled PnL, and open portfolio value vs the official `/value` endpoint.
- Stats (quantiles, tie-aware Spearman, histogram binning, pagination) are unit tested: `npm test`.

## Structure

| Path | Purpose |
|---|---|
| `server.js` | Express server, `/api/analyze` endpoint, 5-min in-memory cache |
| `lib/fetchTrades.js` | Complete trade fetching with time-cursor pagination and retries |
| `lib/fetchPositions.js` | Closed/open positions and official PnL series fetching |
| `lib/stats.js` | Pure analytics (shared by server, browser, and tests) |
| `public/` | Dashboard (ECharts, served locally) |
| `test/` | Unit tests (`node --test`) |
| `scripts/screenshot.mjs` | Headless-browser smoke test (server must be running) |
