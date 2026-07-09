/**
 * Fetches ALL trades for a wallet from the Polymarket data API within a time range.
 *
 * The API caps `offset` at 3000, so offset paging alone can only reach 4000 trades.
 * To guarantee completeness for heavy traders we paginate with a moving time cursor:
 * results come newest-first inside [start, end] (both inclusive, unix seconds).
 * When the offset cap is reached, the oldest second we saw may be only partially
 * fetched, so we DROP all rows at that second and restart the next window with
 * `end` = that second. This refetches the boundary second in full and never
 * double-counts or drops rows — even identical fills (same tx/price/size) are safe,
 * which a dedupe-key approach could not guarantee.
 */

const DATA_API = 'https://data-api.polymarket.com';
const PAGE_LIMIT = 1000;
const MAX_OFFSET = 3000;
const REQUEST_DELAY_MS = 120;
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(wallet, { start, end, offset }, fetchImpl) {
  const url = new URL(`${DATA_API}/trades`);
  url.searchParams.set('user', wallet);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('takerOnly', 'false'); // include maker fills — required for completeness
  url.searchParams.set('start', String(start));
  url.searchParams.set('end', String(end));

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Polymarket API ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error(`Unexpected API response: ${JSON.stringify(data).slice(0, 200)}`);
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

/**
 * @param {string} wallet 0x address (Polymarket proxy wallet)
 * @param {{startTs:number, endTs:number, onProgress?:(count:number)=>void, fetchImpl?:typeof fetch}} opts
 * @returns {Promise<Array>} all trades in [startTs, endTs], newest first
 */
export async function fetchAllTrades(wallet, { startTs, endTs, onProgress, fetchImpl = fetch }) {
  const trades = [];
  let windowEnd = endTs;

  for (;;) {
    const windowTrades = [];
    let done = false;

    for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE_LIMIT) {
      const page = await fetchPage(wallet, { start: startTs, end: windowEnd, offset }, fetchImpl);
      for (const t of page) {
        if (typeof t.timestamp !== 'number' || t.timestamp < startTs || t.timestamp > endTs) continue;
        windowTrades.push(t);
      }
      onProgress?.(trades.length + windowTrades.length);
      if (page.length < PAGE_LIMIT) {
        done = true;
        break;
      }
      await sleep(REQUEST_DELAY_MS);
    }

    if (done) {
      trades.push(...windowTrades);
      break;
    }

    // Offset cap exhausted: the oldest second is possibly partial. Drop it and
    // refetch it in full as the start of the next window.
    const oldest = windowTrades.reduce((a, t) => (t.timestamp < a ? t.timestamp : a), Infinity);
    const keep = windowTrades.filter((t) => t.timestamp > oldest);
    if (keep.length === 0) {
      // 4000+ fills within a single second — cannot make progress
      throw new Error(`Pagination stuck: more than ${MAX_OFFSET + PAGE_LIMIT} trades at timestamp ${oldest}`);
    }
    trades.push(...keep);
    windowEnd = oldest;
    await sleep(REQUEST_DELAY_MS);
  }

  trades.sort((a, b) => b.timestamp - a.timestamp);
  return trades;
}
