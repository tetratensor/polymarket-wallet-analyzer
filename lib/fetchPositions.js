/**
 * PnL data sources (all public, verified):
 *
 * - /closed-positions: one row per settled position with final realizedPnl,
 *   cost basis (avgPrice, totalBought) and a settlement `timestamp`. Supports
 *   sortBy=TIMESTAMP&sortDirection=DESC with NO offset cap, max 50 rows/page,
 *   so we paginate newest-first and stop once rows fall before the window.
 *   (Its start/end query params do NOT actually filter — verified.)
 *
 * - /positions: currently open positions with unrealized PnL (cashPnl).
 *
 * - user-pnl-api: the official account PnL time series (mark-to-market,
 *   cumulative since account start) shown on polymarket.com profiles.
 */

const DATA_API = 'https://data-api.polymarket.com';
const PNL_API = 'https://user-pnl-api.polymarket.com';
const CLOSED_PAGE = 50; // server clamps larger limits to 50
const OPEN_PAGE = 500;
const MAX_RETRIES = 4;
const REQUEST_DELAY_MS = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, fetchImpl) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Positions settled within [startTs, endTs]. */
export async function fetchClosedPositions(wallet, { startTs, endTs, fetchImpl = fetch }) {
  const out = [];
  for (let offset = 0; ; offset += CLOSED_PAGE) {
    const url = `${DATA_API}/closed-positions?user=${wallet}&limit=${CLOSED_PAGE}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`;
    const page = await getJson(url, fetchImpl);
    if (!Array.isArray(page)) throw new Error(`Unexpected closed-positions response: ${JSON.stringify(page).slice(0, 200)}`);
    let pastWindow = false;
    for (const p of page) {
      if (typeof p.timestamp !== 'number') continue;
      if (p.timestamp < startTs) { pastWindow = true; continue; }
      if (p.timestamp > endTs) continue;
      out.push(p);
    }
    if (pastWindow || page.length < CLOSED_PAGE) break;
    await sleep(REQUEST_DELAY_MS);
  }
  return out;
}

/** All currently open positions. */
export async function fetchOpenPositions(wallet, { fetchImpl = fetch } = {}) {
  const out = [];
  for (let offset = 0; ; offset += OPEN_PAGE) {
    const url = `${DATA_API}/positions?user=${wallet}&limit=${OPEN_PAGE}&offset=${offset}&sizeThreshold=0`;
    const page = await getJson(url, fetchImpl);
    if (!Array.isArray(page)) throw new Error(`Unexpected positions response: ${JSON.stringify(page).slice(0, 200)}`);
    out.push(...page);
    if (page.length < OPEN_PAGE) break;
    await sleep(REQUEST_DELAY_MS);
  }
  return out;
}

/**
 * Official cumulative PnL series over the window — the same series the
 * polymarket.com profile P/L graph uses. Interval/fidelity are chosen to
 * match the profile page presets for the requested number of days.
 */
export async function fetchPnlSeries(wallet, { days, fetchImpl = fetch }) {
  let interval;
  let fidelity;
  if (days <= 7) { interval = '1w'; fidelity = '1h'; }
  else if (days <= 30) { interval = '1m'; fidelity = '1d'; }
  else { interval = 'all'; fidelity = '1d'; }
  const url = `${PNL_API}/user-pnl?user_address=${wallet}&interval=${interval}&fidelity=${fidelity}`;
  const data = await getJson(url, fetchImpl);
  if (!Array.isArray(data)) return [];
  let pts = data.map((p) => ({ t: p.t, p: p.p }));
  if (interval === 'all') {
    const startTs = Math.floor(Date.now() / 1000) - days * 86400;
    pts = pts.filter((p) => p.t >= startTs - 86400); // keep one point before the window for rebasing
  }
  return pts;
}
