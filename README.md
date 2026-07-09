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

## Correctness notes

- Data source: the public Polymarket data API (`data-api.polymarket.com/trades`), no API key needed.
- Both **maker and taker** fills are included (`takerOnly=false`); taker-only views undercount active traders significantly.
- The API caps pagination at offset 3000. The fetcher works around this with a moving time cursor: when the cap is hit, the partially-fetched oldest second is dropped and refetched in full as the next window. This is exact — no fills are lost or double-counted, even identical fills in the same transaction. If a wallet somehow has >4000 fills in a single second the fetcher raises an error instead of silently returning partial data.
- Every fill is one data point; the API reports the wallet's own side and price for maker fills (verified: a maker's BUY at 58¢ appears as the counterparty taker's BUY of the opposite outcome at 42¢).
- Redeeming winning shares is not a SELL and does not appear in exit prices.
- Time-zone inference is a heuristic (people rarely trade while asleep) and is labeled with high/medium/low confidence. Bots and 24/7 traders yield "low".
- PnL comes from Polymarket's own accounting, not reconstruction: `/closed-positions` (final realized PnL and cost basis per settled position, paginated newest-first via `sortBy=TIMESTAMP` — its `start`/`end` params do NOT filter, verified), `/positions` (unrealized PnL on open positions), and `user-pnl-api` (the official mark-to-market curve shown on profile pages, fetched with the interval matching the selected window). Two PnL cards are shown because they answer different questions: **Account PnL** is the mark-to-market change over the window (profile-graph delta); **Settled bets PnL** sums each bet's full lifetime PnL for positions settled inside the window.
- Volume is fill notional (price × shares). Actual cash moved (`usdcSize` in `/activity`) runs ~1% higher on BUYs where taker fees apply. The lb-api leaderboard volume/profit numbers use undocumented internal definitions (windowed values match neither raw fills nor the official PnL curve) and are deliberately not used.
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
