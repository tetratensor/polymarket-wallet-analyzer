/**
 * Pure analytics functions shared by the Node server, tests, and the browser
 * (served as an ES module). No dependencies, no I/O.
 */

export function mean(xs) {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Linear-interpolated quantile (same definition as numpy's default). q in [0,1]. */
export function quantile(xs, q) {
  if (xs.length === 0) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  const pos = (a.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function pearson(xs, ys) {
  const n = xs.length;
  if (n !== ys.length || n < 2) return NaN;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return NaN;
  return sxy / Math.sqrt(sxx * syy);
}

/** Average ranks for ties (fractional ranking), 1-based. */
export function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k][1]] = avgRank;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation (tie-aware: Pearson of fractional ranks). */
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  return pearson(ranks(xs), ranks(ys));
}

/**
 * Fixed-edge histogram. edges must be ascending; returns edges.length-1 counts.
 * Values are assigned to bin i when edges[i] <= v < edges[i+1]; the last bin is
 * inclusive of its upper edge. Values outside [edges[0], edges[last]] are ignored.
 */
export function histogram(values, edges) {
  const counts = new Array(edges.length - 1).fill(0);
  const lastEdge = edges[edges.length - 1];
  for (const v of values) {
    if (v < edges[0] || v > lastEdge) continue;
    if (v === lastEdge) {
      counts[counts.length - 1]++;
      continue;
    }
    // binary search: greatest i such that edges[i] <= v
    let lo = 0;
    let hi = edges.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (edges[mid] <= v) lo = mid;
      else hi = mid;
    }
    counts[lo]++;
  }
  return counts;
}

/**
 * Infer the wallet owner's likely UTC offset from hourly activity (UTC).
 *
 * Heuristic: people rarely trade while asleep. Find the consecutive
 * `windowLen`-hour window (wrapping) with the least activity and assume it is
 * the sleep window starting at ~01:00 local time. Then offset = 1 - windowStartUTC.
 *
 * @param {number[]} hourCounts 24 numbers, trades per UTC hour of day
 * @returns {{utcOffset:number|null, sleepStartUtc:number|null, windowLen:number,
 *            confidence:'high'|'medium'|'low'|'none', quietShare:number|null}}
 */
export function inferUtcOffset(hourCounts, windowLen = 7) {
  if (hourCounts.length !== 24) throw new Error('hourCounts must have 24 entries');
  const total = hourCounts.reduce((a, b) => a + b, 0);
  if (total < 30) {
    return { utcOffset: null, sleepStartUtc: null, windowLen, confidence: 'none', quietShare: null };
  }
  let bestStart = 0;
  let bestSum = Infinity;
  for (let start = 0; start < 24; start++) {
    let sum = 0;
    for (let k = 0; k < windowLen; k++) sum += hourCounts[(start + k) % 24];
    if (sum < bestSum) {
      bestSum = sum;
      bestStart = start;
    }
  }
  // Share of activity inside the quiet window vs uniform expectation (windowLen/24).
  const quietShare = bestSum / total;
  const uniformShare = windowLen / 24;
  let confidence;
  if (quietShare <= uniformShare * 0.15) confidence = 'high';
  else if (quietShare <= uniformShare * 0.4) confidence = 'medium';
  else confidence = 'low';

  // sleep window starts ~01:00 local => localHour(bestStart) = 1
  let utcOffset = 1 - bestStart;
  // normalize into [-11, +12]
  while (utcOffset > 12) utcOffset -= 24;
  while (utcOffset <= -12) utcOffset += 24;

  return { utcOffset, sleepStartUtc: bestStart, windowLen, confidence, quietShare };
}

/** Example locations for an integer UTC offset (July / DST-aware labels). */
export function offsetExamples(utcOffset) {
  const map = {
    '-11': 'American Samoa',
    '-10': 'Hawaii',
    '-9': 'Alaska',
    '-8': 'US Pacific (PDT area in winter zones)',
    '-7': 'US Pacific (PDT) / Arizona',
    '-6': 'US Mountain (MDT) / Mexico City',
    '-5': 'US Central (CDT) / Bogotá, Lima',
    '-4': 'US Eastern (EDT) / Santiago',
    '-3': 'Argentina, Brazil (São Paulo)',
    '-2': 'Mid-Atlantic',
    '-1': 'Azores',
    0: 'UK (winter) / Iceland, Ghana',
    1: 'UK (BST) / West Africa',
    2: 'Central Europe (CEST) / South Africa',
    3: 'Eastern Europe (EEST) / Turkey, Moscow, East Africa',
    4: 'UAE, Georgia',
    5: 'Pakistan, Uzbekistan',
    6: 'Bangladesh, Kazakhstan',
    7: 'Vietnam, Thailand, W. Indonesia',
    8: 'China, Singapore, Philippines, W. Australia',
    9: 'Japan, Korea',
    10: 'E. Australia (Sydney/Brisbane)',
    11: 'Solomon Is., Magadan',
    12: 'New Zealand, Fiji',
  };
  return map[String(utcOffset)] ?? '';
}

/**
 * Aggregate settled positions into PnL analytics.
 * Positions: {betUsdc (cost basis), pnl (realized USDC), entryPrice (avg, 0..1)}.
 */
export function analyzePnl(positions) {
  const n = positions.length;
  const pnls = positions.map((p) => p.pnl);
  const bets = positions.map((p) => p.betUsdc);
  const entries = positions.map((p) => p.entryPrice);
  const rois = positions.map((p) => (p.betUsdc > 0 ? p.pnl / p.betUsdc : 0));

  const wins = positions.filter((p) => p.pnl > 0);
  const losses = positions.filter((p) => p.pnl < 0);
  const grossProfit = wins.reduce((a, p) => a + p.pnl, 0);
  const grossLoss = -losses.reduce((a, p) => a + p.pnl, 0);

  // per 10¢ entry-price band: settled bet count, win rate, total PnL, median ROI
  const bands = [];
  for (let b = 0; b < 10; b++) {
    const lo = b / 10;
    const hi = (b + 1) / 10;
    const inBand = positions.filter((p) => p.entryPrice >= lo && (b === 9 ? p.entryPrice <= hi : p.entryPrice < hi));
    const bandWins = inBand.filter((p) => p.pnl > 0).length;
    bands.push({
      lo,
      hi,
      count: inBand.length,
      winRate: inBand.length ? bandWins / inBand.length : null,
      totalPnl: inBand.reduce((a, p) => a + p.pnl, 0),
      medianRoi: inBand.length ? quantile(inBand.map((p) => (p.betUsdc > 0 ? p.pnl / p.betUsdc : 0)), 0.5) : null,
    });
  }

  return {
    n,
    totalPnl: pnls.reduce((a, b) => a + b, 0),
    winRate: n ? wins.length / n : NaN,
    wins: wins.length,
    losses: losses.length,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : NaN,
    avgWin: mean(wins.map((p) => p.pnl)),
    avgLoss: mean(losses.map((p) => p.pnl)),
    medianPnl: quantile(pnls, 0.5),
    biggestWin: pnls.reduce((a, b) => (b > a ? b : a), -Infinity),
    biggestLoss: pnls.reduce((a, b) => (b < a ? b : a), Infinity),
    corr: {
      betVsPnl: { pearson: pearson(bets, pnls), spearman: spearman(bets, pnls) },
      betVsRoi: { pearson: pearson(bets, rois), spearman: spearman(bets, rois) },
      entryVsRoi: { pearson: pearson(entries, rois), spearman: spearman(entries, rois) },
    },
    bands,
  };
}

/**
 * Aggregate per-trade rows into all datasets the dashboard needs.
 * Trades: {t (unix sec), side ('BUY'|'SELL'), price (0..1), size (shares), usdc}.
 * All time bucketing here is UTC; the client re-buckets for other zones.
 */
export function analyzeTrades(trades) {
  const buys = trades.filter((t) => t.side === 'BUY');
  const sells = trades.filter((t) => t.side === 'SELL');

  const hourCounts = new Array(24).fill(0);
  const hourVolume = new Array(24).fill(0);
  const dowHour = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const t of trades) {
    const d = new Date(t.t * 1000);
    const h = d.getUTCHours();
    hourCounts[h]++;
    hourVolume[h] += t.usdc;
    dowHour[d.getUTCDay()][h]++;
  }

  const buyUsdc = buys.map((t) => t.usdc);
  const sellUsdc = sells.map((t) => t.usdc);
  const buyPrices = buys.map((t) => t.price);
  const sellPrices = sells.map((t) => t.price);

  const tz = inferUtcOffset(hourCounts);

  return {
    counts: { total: trades.length, buys: buys.length, sells: sells.length },
    volume: {
      total: trades.reduce((a, t) => a + t.usdc, 0),
      buy: buyUsdc.reduce((a, b) => a + b, 0),
      sell: sellUsdc.reduce((a, b) => a + b, 0),
    },
    betSize: {
      mean: mean(buyUsdc),
      median: quantile(buyUsdc, 0.5),
      p90: quantile(buyUsdc, 0.9),
      // no spread: Math.max(...arr) overflows the stack on very large arrays
      max: buyUsdc.length ? buyUsdc.reduce((a, b) => (b > a ? b : a), -Infinity) : NaN,
    },
    entryPrice: {
      mean: mean(buyPrices),
      median: quantile(buyPrices, 0.5),
    },
    exitPrice: {
      mean: mean(sellPrices),
      median: quantile(sellPrices, 0.5),
    },
    sizeVsEntry: {
      pearson: pearson(buyPrices, buyUsdc),
      spearman: spearman(buyPrices, buyUsdc),
      n: buys.length,
    },
    hourCounts,
    hourVolume,
    dowHour,
    timezone: tz,
  };
}
