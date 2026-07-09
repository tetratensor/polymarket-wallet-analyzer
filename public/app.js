import { histogram, quantile, offsetExamples } from '/lib/stats.js';

const $ = (id) => document.getElementById(id);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const state = { data: null, tzMode: 'utc', charts: {} };

const AXIS = { color: '#8b94a7', line: '#232b3a' };
const baseAxis = {
  axisLine: { lineStyle: { color: AXIS.line } },
  axisLabel: { color: AXIS.color, fontSize: 11 },
  splitLine: { lineStyle: { color: 'rgba(35,43,58,0.6)' } },
  nameTextStyle: { color: AXIS.color },
};
const baseTooltip = {
  backgroundColor: '#1b2230',
  borderColor: '#2c374b',
  textStyle: { color: '#e6eaf2', fontSize: 12 },
};

// NaN values become null in JSON; isFinite(null) is true, so use Number.isFinite
const fin = (v) => Number.isFinite(v);

function fmtUsd(v, digits = 2) {
  if (!fin(v)) return '—';
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  if (v !== 0 && Math.abs(v) < 0.01) return `$${v.toFixed(3)}`; // sub-cent fills on log axes
  if (v !== 0 && Math.abs(v) < 10) return `$${v.toFixed(2)}`; // keep cents visible on log axes
  return `$${v.toFixed(digits)}`;
}
const fmtCents = (p) => `${(p * 100).toFixed(1)}¢`;
const fmtInt = (n) => n.toLocaleString('en-US');

/* ---------- time zone helpers ---------- */

function tzShiftSeconds() {
  const { tzMode, data } = state;
  if (tzMode === 'utc') return 0;
  if (tzMode === 'inferred') return (data.summary.timezone.utcOffset ?? 0) * 3600;
  return null; // browser: use local getters (DST-correct)
}

function getParts(t) {
  const shift = tzShiftSeconds();
  if (shift === null) {
    const d = new Date(t * 1000);
    return {
      hour: d.getHours(),
      dow: d.getDay(),
      dayKey: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    };
  }
  const d = new Date((t + shift) * 1000);
  return {
    hour: d.getUTCHours(),
    dow: d.getUTCDay(),
    dayKey: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
  };
}

function tzLabel() {
  const { tzMode, data } = state;
  if (tzMode === 'utc') return 'UTC';
  if (tzMode === 'browser') return Intl.DateTimeFormat().resolvedOptions().timeZone;
  const off = data.summary.timezone.utcOffset;
  return off === null ? 'UTC' : `UTC${off >= 0 ? '+' : ''}${off}`;
}

/* ---------- chart helpers ---------- */

function chart(id) {
  if (!state.charts[id]) {
    state.charts[id] = echarts.init($(id), null, { renderer: 'canvas' });
  }
  return state.charts[id];
}

/* ---------- renderers ---------- */

function renderCards() {
  const { summary, trades, days } = state.data;
  const s = summary;

  const hourCounts = new Array(24).fill(0);
  for (const t of trades) hourCounts[getParts(t.t).hour]++;
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

  const markets = new Set(trades.map((t) => t.slug || t.title)).size;
  const tz = s.timezone;
  const tzText = tz.utcOffset === null
    ? 'insufficient data'
    : `UTC${tz.utcOffset >= 0 ? '+' : ''}${tz.utcOffset}`;
  const tzDetail = tz.utcOffset === null
    ? ''
    : `${tz.confidence} confidence · ${offsetExamples(tz.utcOffset)}`;

  const pnl = state.data.pnl.settled;
  const series = state.data.pnl.series;
  const accountPnl = series.length >= 2 ? series[series.length - 1].p - series[0].p : NaN;
  const pnlClass = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
  const signUsd = (v) => (fin(v) ? `${v > 0 ? '+' : ''}${fmtUsd(v)}` : '—');

  const cards = [
    { k: `Trades (${days}d)`, v: fmtInt(s.counts.total), d: `${fmtInt(s.counts.buys)} buys · ${fmtInt(s.counts.sells)} sells` },
    {
      k: 'Cash volume', v: fmtUsd(s.volume.total),
      d: `buy ${fmtUsd(s.volume.buy)} · sell ${fmtUsd(s.volume.sell)}` +
        (state.data.officialVolume ? ` · official metric ${fmtUsd(state.data.officialVolume.amount)}` : ''),
    },
    { k: 'Median bet', v: fmtUsd(s.betSize.median), d: `mean ${fmtUsd(s.betSize.mean)} · p90 ${fmtUsd(s.betSize.p90)}` },
    { k: 'Largest bet', v: fmtUsd(s.betSize.max), d: 'single BUY fill' },
    { k: 'Median entry price', v: fin(s.entryPrice.median) ? fmtCents(s.entryPrice.median) : '—', d: `exit ${fin(s.exitPrice.median) ? fmtCents(s.exitPrice.median) : '—'}` },
    { k: 'Markets traded', v: fmtInt(markets), d: `peak hour ${String(peakHour).padStart(2, '0')}:00 (${tzLabel()})` },
    { k: 'Inferred time zone', v: tzText, d: tzDetail, accent: true },
    { k: `Account PnL (${days}d)`, v: signUsd(accountPnl), d: 'official mark-to-market curve', cls: pnlClass(accountPnl) },
    { k: `Settled bets PnL (${days}d)`, v: signUsd(pnl.totalPnl), d: `${fmtInt(pnl.n)} settled bets traded in window`, cls: pnlClass(pnl.totalPnl) },
    { k: 'Win rate (settled)', v: fin(pnl.winRate) ? `${(pnl.winRate * 100).toFixed(1)}%` : '—', d: `${fmtInt(pnl.wins)} won · ${fmtInt(pnl.losses)} lost` },
    { k: 'Profit factor', v: fin(pnl.profitFactor) ? pnl.profitFactor.toFixed(2) : '—', d: `avg win ${fmtUsd(pnl.avgWin)} · avg loss ${fmtUsd(pnl.avgLoss)}` },
  ];

  $('cards').innerHTML = cards
    .map((c) => `<div class="card"><div class="k">${c.k}</div><div class="v${c.accent ? ' accent' : ''}${c.cls ? ' ' + c.cls : ''}">${c.v}</div><div class="d">${c.d}</div></div>`)
    .join('');
}

function renderHourly() {
  const { trades, summary } = state.data;
  const counts = new Array(24).fill(0);
  const volume = new Array(24).fill(0);
  for (const t of trades) {
    const h = getParts(t.t).hour;
    counts[h]++;
    volume[h] += t.usdc;
  }

  const tz = summary.timezone;
  let sleepMark = [];
  if (tz.utcOffset !== null && state.tzMode !== 'browser') {
    const shiftH = tzShiftSeconds() / 3600;
    const start = ((tz.sleepStartUtc + shiftH) % 24 + 24) % 24;
    const end = (start + tz.windowLen) % 24;
    sleepMark = start < end
      ? [[{ xAxis: start }, { xAxis: end }]]
      : [[{ xAxis: start }, { xAxis: 23.999 }], [{ xAxis: 0 }, { xAxis: end }]];
  }

  $('hourly-sub').textContent = `Hours shown in ${tzLabel()}. Shaded band = inferred sleep window.`;

  chart('chart-hourly').setOption({
    tooltip: { ...baseTooltip, trigger: 'axis', valueFormatter: undefined },
    legend: { textStyle: { color: AXIS.color }, top: 0 },
    grid: { left: 55, right: 65, top: 35, bottom: 30 },
    xAxis: { type: 'category', data: [...Array(24)].map((_, h) => `${String(h).padStart(2, '0')}`), ...baseAxis },
    yAxis: [
      { type: 'value', name: 'trades', ...baseAxis },
      { type: 'value', name: 'USDC', ...baseAxis, splitLine: { show: false }, axisLabel: { ...baseAxis.axisLabel, formatter: (v) => fmtUsd(v, 0) } },
    ],
    series: [
      {
        name: 'Trades',
        type: 'bar',
        data: counts,
        itemStyle: { color: '#4f8dff', borderRadius: [3, 3, 0, 0] },
        markArea: sleepMark.length
          ? { silent: true, itemStyle: { color: 'rgba(139,148,167,0.12)' }, data: sleepMark }
          : undefined,
      },
      {
        name: 'Volume (USDC)',
        type: 'line',
        yAxisIndex: 1,
        data: volume.map((v) => +v.toFixed(2)),
        smooth: true,
        symbol: 'none',
        lineStyle: { color: '#38d39f', width: 2 },
        itemStyle: { color: '#38d39f' },
      },
    ],
  }, true);
}

function renderHeatmap() {
  const { trades } = state.data;
  const m = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const t of trades) {
    const p = getParts(t.t);
    m[p.dow][p.hour]++;
  }
  const points = [];
  let max = 0;
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      points.push([h, d, m[d][h]]);
      max = Math.max(max, m[d][h]);
    }
  }
  $('heatmap-sub').textContent = `Trade count per weekday and hour (${tzLabel()})`;

  chart('chart-heatmap').setOption({
    tooltip: {
      ...baseTooltip,
      formatter: (p) => `${DOW[p.value[1]]} ${String(p.value[0]).padStart(2, '0')}:00 — <b>${fmtInt(p.value[2])}</b> trades`,
    },
    grid: { left: 55, right: 20, top: 10, bottom: 55 },
    xAxis: { type: 'category', data: [...Array(24)].map((_, h) => String(h).padStart(2, '0')), ...baseAxis, splitArea: { show: false } },
    yAxis: { type: 'category', data: DOW, ...baseAxis },
    visualMap: {
      min: 0, max: Math.max(max, 1),
      calculable: false, orient: 'horizontal', left: 'center', bottom: 0,
      inRange: { color: ['#151a24', '#1d3a6b', '#2f6fd6', '#4f8dff', '#9cc2ff'] },
      textStyle: { color: AXIS.color },
    },
    series: [{ type: 'heatmap', data: points, itemStyle: { borderColor: '#0d1017', borderWidth: 1 } }],
  }, true);
}

function renderDaily() {
  const { trades, range } = state.data;
  const byDay = new Map();
  // enumerate every day in the range under the active tz so gaps show as zero
  for (let t = range.startTs; t <= range.endTs + 86399; t += 86400) {
    const k = getParts(Math.min(t, range.endTs)).dayKey;
    if (!byDay.has(k)) byDay.set(k, { buys: 0, sells: 0, vol: 0 });
  }
  for (const tr of trades) {
    const k = getParts(tr.t).dayKey;
    if (!byDay.has(k)) byDay.set(k, { buys: 0, sells: 0, vol: 0 });
    const row = byDay.get(k);
    if (tr.side === 'BUY') row.buys++; else row.sells++;
    row.vol += tr.usdc;
  }
  const keys = [...byDay.keys()].sort();

  chart('chart-daily').setOption({
    tooltip: { ...baseTooltip, trigger: 'axis' },
    legend: { textStyle: { color: AXIS.color }, top: 0 },
    grid: { left: 55, right: 65, top: 35, bottom: 45 },
    xAxis: { type: 'category', data: keys, ...baseAxis, axisLabel: { ...baseAxis.axisLabel, rotate: 40, formatter: (v) => v.slice(5) } },
    yAxis: [
      { type: 'value', name: 'trades', ...baseAxis },
      { type: 'value', name: 'USDC', ...baseAxis, splitLine: { show: false }, axisLabel: { ...baseAxis.axisLabel, formatter: (v) => fmtUsd(v, 0) } },
    ],
    series: [
      { name: 'Buys', type: 'bar', stack: 'n', data: keys.map((k) => byDay.get(k).buys), itemStyle: { color: '#4f8dff' } },
      { name: 'Sells', type: 'bar', stack: 'n', data: keys.map((k) => byDay.get(k).sells), itemStyle: { color: '#b06bff' } },
      { name: 'Volume (USDC)', type: 'line', yAxisIndex: 1, data: keys.map((k) => +byDay.get(k).vol.toFixed(2)), smooth: true, symbol: 'none', lineStyle: { color: '#38d39f', width: 2 }, itemStyle: { color: '#38d39f' } },
    ],
  }, true);
}

const MONEY_EDGES = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000, 1000000, 1e9];

function renderBetSize() {
  const buys = state.data.trades.filter((t) => t.side === 'BUY').map((t) => t.usdc);
  if (buys.length === 0) {
    chart('chart-betsize').setOption(emptyState('No BUY fills in this window'), true);
    return;
  }
  const counts = histogram(buys, MONEY_EDGES);
  let last = counts.length - 1;
  while (last > 0 && counts[last] === 0) last--;
  const shown = counts.slice(0, last + 1);
  const labels = shown.map((_, i) => {
    const lo = MONEY_EDGES[i];
    const hi = MONEY_EDGES[i + 1];
    return hi >= 1e9 ? `≥${fmtUsd(lo, 0)}` : `${fmtUsd(lo, 0)}–${fmtUsd(hi, 0)}`;
  });

  chart('chart-betsize').setOption({
    tooltip: { ...baseTooltip, trigger: 'axis', formatter: (ps) => `${ps[0].name}<br/><b>${fmtInt(ps[0].value)}</b> buy fills` },
    grid: { left: 55, right: 20, top: 20, bottom: 60 },
    xAxis: { type: 'category', data: labels, ...baseAxis, axisLabel: { ...baseAxis.axisLabel, rotate: 40 } },
    yAxis: { type: 'value', name: 'fills', ...baseAxis },
    series: [{ type: 'bar', data: shown, itemStyle: { color: '#4f8dff', borderRadius: [3, 3, 0, 0] } }],
  }, true);
}

const emptyState = (msg) => ({
  graphic: {
    type: 'text',
    left: 'center',
    top: 'middle',
    style: { text: msg, fill: '#8b94a7', fontSize: 14 },
  },
  xAxis: { show: false },
  yAxis: { show: false },
  series: [],
});

function priceHistOption(prices, color, emptyMsg) {
  if (prices.length === 0) return emptyState(emptyMsg);
  const edges = [...Array(51)].map((_, i) => i / 50); // 2¢ bins
  const counts = histogram(prices, edges);
  return {
    tooltip: {
      ...baseTooltip, trigger: 'axis',
      formatter: (ps) => `${ps[0].name}<br/><b>${fmtInt(ps[0].value)}</b> fills`,
    },
    grid: { left: 55, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: counts.map((_, i) => `${i * 2}–${i * 2 + 2}¢`),
      ...baseAxis,
      axisLabel: { ...baseAxis.axisLabel, interval: 4 },
    },
    yAxis: { type: 'value', name: 'fills', ...baseAxis },
    series: [{ type: 'bar', data: counts, barCategoryGap: '10%', itemStyle: { color, borderRadius: [2, 2, 0, 0] } }],
  };
}

function renderPriceHists() {
  const buys = state.data.trades.filter((t) => t.side === 'BUY').map((t) => t.price);
  const sells = state.data.trades.filter((t) => t.side === 'SELL').map((t) => t.price);
  chart('chart-entry').setOption(priceHistOption(buys, '#4f8dff', 'No BUY fills in this window'), true);
  chart('chart-exit').setOption(priceHistOption(sells, '#b06bff', 'No SELL fills in this window — positions were held or redeemed, not sold'), true);
}

function renderScatter() {
  const buys = state.data.trades.filter((t) => t.side === 'BUY' && t.usdc > 0);
  if (buys.length === 0) {
    $('scatter-sub').textContent = '';
    chart('chart-scatter').setOption(emptyState('No BUY fills in this window'), true);
    return;
  }
  const s = state.data.summary.sizeVsEntry;
  $('scatter-sub').textContent =
    `Each point is one BUY fill (n=${fmtInt(s.n)}). Orange line = median bet per price band, band = middle 50%. ` +
    `Pearson r = ${fin(s.pearson) ? s.pearson.toFixed(3) : '—'}, Spearman ρ = ${fin(s.spearman) ? s.spearman.toFixed(3) : '—'}.`;

  // median + interquartile band of bet size per price band (5¢ when dense, 10¢ otherwise)
  const nBands = buys.length >= 2000 ? 20 : 10;
  const bandW = 1 / nBands;
  const p25 = [];
  const p50 = [];
  const p75 = [];
  for (let b = 0; b < nBands; b++) {
    const lo = b * bandW;
    const hi = lo + bandW;
    const inBand = buys
      .filter((t) => t.price >= lo && (b === nBands - 1 ? t.price <= hi : t.price < hi))
      .map((t) => t.usdc);
    const x = lo + bandW / 2;
    if (inBand.length >= 3) {
      p25.push([x, quantile(inBand, 0.25)]);
      p50.push([x, quantile(inBand, 0.5)]);
      p75.push([x, quantile(inBand, 0.75)]);
    }
  }

  const dense = buys.length > 800;
  const ultra = buys.length > 8000;
  chart('chart-scatter').setOption({
    tooltip: {
      ...baseTooltip,
      formatter: (p) => p.seriesType === 'scatter'
        ? `${p.data[2] || ''}<br/>price <b>${fmtCents(p.data[0])}</b> · bet <b>${fmtUsd(p.data[1])}</b>`
        : `entry ${fmtCents(p.data[0] - bandW / 2)}–${fmtCents(p.data[0] + bandW / 2)}<br/>median bet <b>${fmtUsd(p.data[1])}</b>`,
    },
    grid: { left: 70, right: 24, top: 30, bottom: 42 },
    xAxis: {
      type: 'value', min: 0, max: 1,
      name: 'entry price', nameLocation: 'middle', nameGap: 28,
      ...baseAxis,
      interval: 0.1,
      axisLabel: { ...baseAxis.axisLabel, formatter: (v) => `${Math.round(v * 100)}¢` },
      splitLine: { lineStyle: { color: 'rgba(35,43,58,0.5)', type: 'dashed' } },
    },
    yAxis: {
      type: 'log', name: 'bet size', nameGap: 14,
      ...baseAxis,
      axisLabel: { ...baseAxis.axisLabel, formatter: (v) => fmtUsd(v, 0) },
      splitLine: { lineStyle: { color: 'rgba(35,43,58,0.5)', type: 'dashed' } },
    },
    series: [
      {
        name: 'BUY fills',
        type: 'scatter',
        data: buys.map((t) => [t.price, t.usdc, t.title]),
        symbolSize: ultra ? 2.5 : dense ? 3 : 6,
        large: buys.length > 4000,
        itemStyle: { color: ultra ? 'rgba(79,141,255,0.13)' : dense ? 'rgba(79,141,255,0.22)' : 'rgba(79,141,255,0.45)' },
        z: 2,
      },
      ...iqrBandSeries(p25, p50, p75, {
        color: '#ffb454',
        medianTooltip: true,
        name: 'median bet',
      }),
    ],
  }, true);
}

/**
 * Builds three ECharts series that render a shaded interquartile band plus a
 * bold median line. Uses the stacked-area technique: an invisible line at p25
 * and a stacked area of (p75 - p25) on top of it.
 */
function iqrBandSeries(p25, p50, p75, { color, name }) {
  if (p50.length < 2) {
    // not enough bands for a trend — show median points only, if any
    return p50.length
      ? [{ name, type: 'scatter', data: p50, symbolSize: 8, itemStyle: { color }, z: 10 }]
      : [];
  }
  const hex = (c, a) => c + Math.round(a * 255).toString(16).padStart(2, '0');
  return [
    {
      name: 'iqr-base',
      type: 'line',
      data: p25,
      stack: 'iqr',
      smooth: true,
      symbol: 'none',
      lineStyle: { opacity: 0 },
      tooltip: { show: false },
      silent: true,
      z: 4,
    },
    {
      name: 'middle 50%',
      type: 'line',
      data: p75.map(([x, v], i) => [x, v - p25[i][1]]),
      stack: 'iqr',
      smooth: true,
      symbol: 'none',
      lineStyle: { opacity: 0 },
      areaStyle: { color: hex(color, 0.16) },
      tooltip: { show: false },
      silent: true,
      z: 4,
    },
    {
      name,
      type: 'line',
      data: p50,
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { color, width: 2.5 },
      itemStyle: { color, borderColor: '#0d1017', borderWidth: 1 },
      emphasis: { scale: 1.6 },
      z: 10,
    },
  ];
}

function renderPnlSeries() {
  const { series } = state.data.pnl;
  if (series.length < 2) {
    $('pnlseries-sub').textContent = '';
    chart('chart-pnlseries').setOption(emptyState('No PnL history available for this wallet'), true);
    return;
  }
  // official series is cumulative since account start; rebase to the window start
  const base = series[0].p;
  const pts = series.map((x) => [x.t * 1000, +(x.p - base).toFixed(2)]);
  $('pnlseries-sub').textContent =
    'Official Polymarket mark-to-market PnL (realized + unrealized) — same series as the profile-page P/L graph, rebased to 0 at the start of the window.';

  chart('chart-pnlseries').setOption({
    tooltip: {
      ...baseTooltip, trigger: 'axis',
      formatter: (ps) => `${new Date(ps[0].value[0]).toISOString().slice(0, 10)}<br/>PnL <b>${ps[0].value[1] >= 0 ? '+' : ''}${fmtUsd(ps[0].value[1])}</b>`,
    },
    grid: { left: 65, right: 20, top: 20, bottom: 40 },
    xAxis: { type: 'time', ...baseAxis },
    yAxis: { type: 'value', name: 'USDC', ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v) => fmtUsd(v, 0) } },
    series: [{
      type: 'line',
      data: pts,
      symbol: 'none',
      smooth: false,
      lineStyle: { color: '#38d39f', width: 2 },
      itemStyle: { color: '#38d39f' },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: 'rgba(56,211,159,0.25)' }, { offset: 1, color: 'rgba(56,211,159,0)' }],
        },
      },
      markLine: {
        silent: true, symbol: 'none',
        lineStyle: { color: '#8b94a7', type: 'dashed', width: 1 },
        data: [{ yAxis: 0 }],
        label: { show: false },
      },
    }],
  }, true);
}

function renderPnlScatter() {
  const { positions, settled } = state.data.pnl;
  const withBet = positions.filter((p) => p.betUsdc > 0);
  if (withBet.length === 0) {
    $('pnlscatter-sub').textContent = '';
    chart('chart-pnlscatter').setOption(emptyState('No settled bets in this window'), true);
    return;
  }
  const c = settled.corr;
  $('pnlscatter-sub').textContent =
    `Each point is one settled bet (n=${fmtInt(withBet.length)}); green won, red lost. ` +
    `Orange line = median PnL per bet-size bucket, band = middle 50%. ` +
    `Spearman ρ: size vs PnL ${fin(c.betVsPnl.spearman) ? c.betVsPnl.spearman.toFixed(3) : '—'}, size vs ROI ${fin(c.betVsRoi.spearman) ? c.betVsRoi.spearman.toFixed(3) : '—'}.`;

  const winPts = [];
  const lossPts = [];
  for (const p of withBet) {
    (p.pnl >= 0 ? winPts : lossPts).push([p.betUsdc, +p.pnl.toFixed(2), p.title]);
  }

  // median + IQR of PnL per logarithmic bet-size bucket
  const logs = withBet.map((p) => Math.log10(p.betUsdc));
  const loLog = Math.min(...logs);
  const hiLog = Math.max(...logs);
  const nBuckets = Math.min(12, Math.max(5, Math.floor(withBet.length / 25)));
  const step = (hiLog - loLog) / nBuckets || 1;
  const p25 = [];
  const p50 = [];
  const p75 = [];
  for (let b = 0; b < nBuckets; b++) {
    const lo = loLog + b * step;
    const hi = lo + step;
    const inB = withBet
      .filter((p, i) => logs[i] >= lo && (b === nBuckets - 1 ? logs[i] <= hi : logs[i] < hi))
      .map((p) => p.pnl);
    if (inB.length >= 3) {
      const x = 10 ** (lo + step / 2);
      p25.push([x, quantile(inB, 0.25)]);
      p50.push([x, quantile(inB, 0.5)]);
      p75.push([x, quantile(inB, 0.75)]);
    }
  }

  const dense = withBet.length > 800;
  const ultra = withBet.length > 8000;
  const large = withBet.length > 4000;
  const dot = (color) => ({
    type: 'scatter',
    symbolSize: ultra ? 2.5 : dense ? 3.5 : 6,
    large,
    z: 2,
    itemStyle: { color },
  });
  const point = (p) => `${p.data[2] || ''}<br/>bet <b>${fmtUsd(p.data[0])}</b> · PnL <b>${p.data[1] >= 0 ? '+' : ''}${fmtUsd(p.data[1])}</b>`;

  chart('chart-pnlscatter').setOption({
    tooltip: {
      ...baseTooltip,
      formatter: (p) => p.seriesType === 'scatter'
        ? point(p)
        : `bets ~${fmtUsd(p.data[0], 0)}<br/>median PnL <b>${p.data[1] >= 0 ? '+' : ''}${fmtUsd(p.data[1])}</b>`,
    },
    grid: { left: 70, right: 24, top: 30, bottom: 42 },
    xAxis: {
      type: 'log', name: 'bet size', nameLocation: 'middle', nameGap: 28,
      ...baseAxis,
      axisLabel: { ...baseAxis.axisLabel, formatter: (v) => fmtUsd(v, 0) },
      splitLine: { lineStyle: { color: 'rgba(35,43,58,0.5)', type: 'dashed' } },
    },
    yAxis: {
      type: 'value', name: 'realized PnL', nameGap: 14,
      ...baseAxis,
      axisLabel: { ...baseAxis.axisLabel, formatter: (v) => fmtUsd(v, 0) },
      splitLine: { lineStyle: { color: 'rgba(35,43,58,0.5)', type: 'dashed' } },
    },
    series: [
      {
        name: 'Won', data: winPts,
        ...dot(dense ? 'rgba(56,211,159,0.28)' : 'rgba(56,211,159,0.55)'),
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: '#8b94a7', type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
          label: { show: false },
        },
      },
      { name: 'Lost', data: lossPts, ...dot(dense ? 'rgba(255,107,129,0.28)' : 'rgba(255,107,129,0.55)') },
      ...iqrBandSeries(p25, p50, p75, { color: '#ffb454', name: 'median PnL' }),
    ],
  }, true);
}

function renderPnlBands() {
  const { settled } = state.data.pnl;
  const bands = settled.bands.filter((b) => b.count > 0);
  if (bands.length === 0) {
    $('pnlbands-sub').textContent = '';
    chart('chart-pnlbands').setOption(emptyState('No settled bets in this window'), true);
    return;
  }
  $('pnlbands-sub').textContent =
    'Settled bets grouped by average entry price. Bars = total realized PnL, line = win rate. ' +
    `Entry price vs ROI: Spearman ρ = ${fin(settled.corr.entryVsRoi.spearman) ? settled.corr.entryVsRoi.spearman.toFixed(3) : '—'}.`;

  const labels = bands.map((b) => `${b.lo * 100}–${b.hi * 100}¢`);
  chart('chart-pnlbands').setOption({
    tooltip: {
      ...baseTooltip, trigger: 'axis',
      formatter: (ps) => {
        const b = bands[ps[0].dataIndex];
        return `entry ${labels[ps[0].dataIndex]} · ${fmtInt(b.count)} bets<br/>` +
          `PnL <b>${b.totalPnl >= 0 ? '+' : ''}${fmtUsd(b.totalPnl)}</b> · win rate <b>${(b.winRate * 100).toFixed(1)}%</b>` +
          `<br/>median ROI ${fin(b.medianRoi) ? (b.medianRoi * 100).toFixed(1) + '%' : '—'}`;
      },
    },
    legend: { textStyle: { color: AXIS.color }, top: 0 },
    grid: { left: 65, right: 55, top: 35, bottom: 40 },
    xAxis: { type: 'category', data: labels, ...baseAxis },
    yAxis: [
      { type: 'value', name: 'PnL (USDC)', ...baseAxis, axisLabel: { ...baseAxis.axisLabel, formatter: (v) => fmtUsd(v, 0) } },
      { type: 'value', name: 'win rate', min: 0, max: 1, ...baseAxis, splitLine: { show: false }, axisLabel: { ...baseAxis.axisLabel, formatter: (v) => `${v * 100}%` } },
    ],
    series: [
      {
        name: 'Total PnL',
        type: 'bar',
        itemStyle: { color: '#38d39f' },
        data: bands.map((b) => ({ value: +b.totalPnl.toFixed(2), itemStyle: { color: b.totalPnl >= 0 ? '#38d39f' : '#ff6b81', borderRadius: [3, 3, 0, 0] } })),
      },
      {
        name: 'Win rate',
        type: 'line',
        yAxisIndex: 1,
        data: bands.map((b) => +b.winRate.toFixed(4)),
        symbol: 'circle',
        symbolSize: 6,
        lineStyle: { color: '#ffb454', width: 2 },
        itemStyle: { color: '#ffb454' },
      },
    ],
  }, true);
}

function renderAll() {
  const { data } = state;
  const name = data.profile?.name || '';
  $('who').innerHTML =
    `${name ? `<span class="name">${name}</span>` : ''}` +
    `<span class="addr">${data.wallet}</span> · ${fmtInt(data.trades.length)} trades in last ${data.days} days`;

  const inferredOpt = document.querySelector('#tzmode option[value="inferred"]');
  const off = data.summary.timezone.utcOffset;
  inferredOpt.disabled = off === null;
  inferredOpt.textContent = off === null ? 'Inferred (n/a)' : `Inferred (UTC${off >= 0 ? '+' : ''}${off})`;

  const from = new Date(data.range.startTs * 1000).toISOString().slice(0, 10);
  const to = new Date(data.range.endTs * 1000).toISOString().slice(0, 10);
  $('footnote').innerHTML =
    `Data: Polymarket data API (all fills incl. maker + taker), ${from} → ${to}. ` +
    `Bet size = price × shares per fill, in USDC. Entry = BUY fills, exit = SELL fills; redeeming winning shares is not a SELL and does not appear here. ` +
    `Cash volume is fill notional (price × shares actually paid); taker fees, where charged, add ~1–2% on top and are excluded. Polymarket's official volume metric differs: matched buy-buy fills (complete-set mints, common in two-sided/cheap markets) are credited at ~$1 per share rather than cash paid, so the official number can be several times the cash figure. Wallets that exit by redeeming winners rather than selling legitimately show $0 sell volume. ` +
    `Account PnL = official mark-to-market curve (realized + unrealized, matches the profile P/L graph). Settled bets PnL covers settled positions the wallet traded inside the window (full lifetime PnL each; Polymarket sometimes batch-records losing settlements weeks late, so settlement dates alone are unreliable). The two answer different questions and will differ. ` +
    `Time-zone inference is a heuristic based on the quietest ${data.summary.timezone.windowLen}-hour window (assumed sleep starting ~01:00 local); confidence: ${data.summary.timezone.confidence}.`;

  renderCards();
  renderHourly();
  renderHeatmap();
  renderDaily();
  renderPnlSeries();
  renderPnlScatter();
  renderPnlBands();
  renderBetSize();
  renderPriceHists();
  renderScatter();
}

/* ---------- wiring ---------- */

async function analyze(wallet, days) {
  const go = $('go');
  const status = $('status');
  go.disabled = true;
  status.classList.remove('hidden', 'error');
  status.textContent = 'Fetching trades from Polymarket… (large wallets can take a minute)';
  $('results').classList.add('hidden');

  try {
    const res = await fetch(`/api/analyze?wallet=${encodeURIComponent(wallet)}&days=${days}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.trades.length === 0) {
      status.textContent = 'No trades found for this wallet in the selected window. Note: use the Polymarket proxy wallet address shown on the profile page.';
      return;
    }
    state.data = data;
    status.classList.add('hidden');
    $('results').classList.remove('hidden');
    renderAll();
  } catch (err) {
    status.classList.add('error');
    status.textContent = `Error: ${err.message}`;
  } finally {
    go.disabled = false;
  }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const wallet = $('wallet').value.trim();
  if (wallet) analyze(wallet, $('days').value);
});

$('tzmode').addEventListener('change', (e) => {
  state.tzMode = e.target.value;
  if (state.data) renderAll();
});

window.addEventListener('resize', () => {
  for (const c of Object.values(state.charts)) c.resize();
});
