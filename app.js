const state = {
  symbol: 'BTCUSDT',
  pollOverride: 'AUTO', // AUTO | TURBO | MOD
  currentIntervalMs: 45000,
  timerId: null,
  lastPrice: null,
  prevPrice: null,
  klines15m: [],
  prevCvdSnap: null,
  perVenuePrev: {}, // { BN: snap, BB: snap, OKX: snap }
  lastSummarySignature: '',
  events: []
};

const fmtUsd = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '--';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : (n > 0 ? '+' : '');
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};

const fmtPrice = (p) => {
  if (!p) return '--';
  return p >= 1000
    ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : p.toFixed(4);
};

function setPollOverride(mode) {
  state.pollOverride = mode;
  document.getElementById('btnAuto').classList.toggle('active', mode === 'AUTO');
  document.getElementById('btnTurbo').classList.toggle('active', mode === 'TURBO');
  document.getElementById('btnMod').classList.toggle('active', mode === 'MOD');
  scheduleNext(mode === 'TURBO' ? 5000 : (mode === 'MOD' ? 45000 : state.currentIntervalMs));
}

function scheduleNext(ms) {
  state.currentIntervalMs = ms;
  const badge = document.getElementById('modeBadge');
  if (ms <= 5000) {
    badge.className = 'badge turbo';
    badge.textContent = `${state.pollOverride === 'AUTO' ? 'AUTO · ' : ''}TURBO (5s)`;
  } else {
    badge.className = 'badge mod';
    badge.textContent = `${state.pollOverride === 'AUTO' ? 'AUTO · ' : ''}MODERATE (${Math.round(ms / 1000)}s)`;
  }
  if (state.timerId) clearTimeout(state.timerId);
  state.timerId = setTimeout(runCycle, ms);
}

// Binance exact taker buy/sell quote delta over last `bars` or from `startIndex`
function calcBinanceCvdFromKlines(klines, bars, startIndex = null) {
  if (!Array.isArray(klines) || !klines.length) return { delta: 0, totalVol: 0, count: 0 };
  const slice = startIndex !== null
    ? klines.slice(Math.max(0, startIndex))
    : klines.slice(-bars);
  let delta = 0;
  let totalVol = 0;
  for (const k of slice) {
    const quoteVol = parseFloat(k[7]) || 0;
    const takerBuyQuote = parseFloat(k[10]) || 0;
    const takerSellQuote = quoteVol - takerBuyQuote;
    delta += (takerBuyQuote - takerSellQuote);
    totalVol += quoteVol;
  }
  return { delta, totalVol, count: slice.length };
}

// Analyze 5m candle weight (volume vs 1h average) & absorption (heavy flow with minimal price move)
function analyze5mFlowQuality(fut5m, spot5m) {
  if (!Array.isArray(fut5m) || fut5m.length < 2) {
    return {
      fut: 0,
      spot: 0,
      weightMult: 1,
      volRatio: 1,
      qualityTag: 'Κανονικό',
      isAbsorption: false
    };
  }

  const last = fut5m[fut5m.length - 1];
  const last1hSlice = fut5m.slice(-13, -1);
  const avgVol = last1hSlice.length
    ? last1hSlice.reduce((acc, k) => acc + (parseFloat(k[7]) || 0), 0) / last1hSlice.length
    : (parseFloat(last[7]) || 1);

  const lastQuoteVol = parseFloat(last[7]) || 0;
  const volRatio = avgVol > 0 ? lastQuoteVol / avgVol : 1;

  const o = parseFloat(last[1]) || 1;
  const c = parseFloat(last[4]) || o;
  const movePct = Math.abs((c - o) / o) * 100;

  const futDelta = calcBinanceCvdFromKlines(fut5m, 1).delta;
  const spotDelta = Array.isArray(spot5m) && spot5m.length ? calcBinanceCvdFromKlines(spot5m, 1).delta : 0;

  const heavyFlow = volRatio >= 1.4 && Math.abs(futDelta) >= 400000;
  const isAbsorption = Math.abs(futDelta) >= 600000 && movePct < 0.08;

  let weightMult = 1.0;
  let qualityTag = 'Κανονικό';

  if (isAbsorption) {
    weightMult = 1.35;
    qualityTag = 'Απορρόφηση';
  } else if (heavyFlow) {
    weightMult = 1.30;
    qualityTag = `Βαρύ ×${volRatio.toFixed(1)}`;
  } else if (volRatio < 0.75) {
    weightMult = 0.70;
    qualityTag = 'Ελαφρύ';
  }

  return {
    fut: futDelta,
    spot: spotDelta,
    weightMult,
    volRatio,
    qualityTag,
    isAbsorption
  };
}

function calcBybitFlowFromKlines(list, bars, startIndex = null) {
  if (!Array.isArray(list) || !list.length) return null;
  const slice = startIndex !== null
    ? list.slice(Math.max(0, startIndex))
    : list.slice(-bars);
  let delta = 0;
  let totalVol = 0;
  for (const k of slice) {
    const o = parseFloat(k[1]);
    const h = parseFloat(k[2]);
    const l = parseFloat(k[3]);
    const c = parseFloat(k[4]);
    const turnover = parseFloat(k[6]) || 0;
    const range = Math.max(h - l, o * 0.0002);
    const bodyRatio = Math.max(-1, Math.min(1, (c - o) / range));
    delta += turnover * bodyRatio * 0.35;
    totalVol += turnover;
  }
  return { delta, totalVol, count: slice.length };
}

function calcOkxFlowFromKlines(list, bars, startIndex = null) {
  if (!Array.isArray(list) || !list.length) return null;
  const slice = startIndex !== null
    ? list.slice(Math.max(0, startIndex))
    : list.slice(-bars);
  let delta = 0;
  let totalVol = 0;
  for (const k of slice) {
    const o = parseFloat(k[1]);
    const h = parseFloat(k[2]);
    const l = parseFloat(k[3]);
    const c = parseFloat(k[4]);
    const quoteVol = parseFloat(k[7]) || 0;
    const range = Math.max(h - l, o * 0.0002);
    const bodyRatio = Math.max(-1, Math.min(1, (c - o) / range));
    delta += quoteVol * bodyRatio * 0.35;
    totalVol += quoteVol;
  }
  return { delta, totalVol, count: slice.length };
}

// Compute adaptive lookback window (20..72 x 15m bars) based on recent range & choppiness
function getAdaptiveWindowConfig(klines15m) {
  const n = klines15m.length;
  const currentPrice = parseFloat(klines15m[n - 1]?.[4] || 1);
  const recent24 = klines15m.slice(-24);
  const hi24 = Math.max(...recent24.map(k => parseFloat(k[2])));
  const lo24 = Math.min(...recent24.map(k => parseFloat(k[3])));
  const rangePct24 = currentPrice > 0 ? (hi24 - lo24) / currentPrice : 0.02;

  let flips = 0;
  let prevDir = 0;
  for (let i = Math.max(1, n - 16); i < n; i++) {
    const diff = parseFloat(klines15m[i][4]) - parseFloat(klines15m[i - 1][4]);
    const dir = diff > 0 ? 1 : (diff < 0 ? -1 : 0);
    if (dir !== 0 && prevDir !== 0 && dir !== prevDir) flips++;
    if (dir !== 0) prevDir = dir;
  }

  let windowBars = 40;
  let modeLabel = 'Κανονικό';

  if (rangePct24 < 0.014 && flips <= 8) {
    windowBars = 68;
    modeLabel = 'Πλάγιο/Εύρος';
  } else if (rangePct24 > 0.034 || flips >= 11) {
    windowBars = 22;
    modeLabel = 'Νευρικό/Κύματα';
  } else {
    const normRange = Math.max(0, Math.min(1, (0.034 - rangePct24) / 0.02));
    windowBars = Math.round(24 + normRange * 40);
    modeLabel = 'Δυναμικό';
  }

  windowBars = Math.max(20, Math.min(Math.min(72, n), windowBars));
  const minSwingPct = rangePct24 > 0.032 ? 0.0045 : (rangePct24 < 0.014 ? 0.0025 : 0.0032);

  return { windowBars, minSwingPct, modeLabel, rangePct24 };
}

function extractAdaptiveSwingPoints(klines15m, cfg = null) {
  const activeCfg = cfg || getAdaptiveWindowConfig(klines15m);
  const offset = Math.max(0, klines15m.length - activeCfg.windowBars);
  const win = klines15m.slice(offset);
  const m = win.length;
  const highs = [];
  const lows = [];

  for (let i = 2; i < m - 2; i++) {
    const h = parseFloat(win[i][2]);
    const l = parseFloat(win[i][3]);
    const isHigh =
      h >= parseFloat(win[i - 1][2]) && h >= parseFloat(win[i - 2][2]) &&
      h >= parseFloat(win[i + 1][2]) && h >= parseFloat(win[i + 2][2]);
    const isLow =
      l <= parseFloat(win[i - 1][3]) && l <= parseFloat(win[i - 2][3]) &&
      l <= parseFloat(win[i + 1][3]) && l <= parseFloat(win[i + 2][3]);

    const globalIdx = offset + i;
    if (isHigh) highs.push({ type: 'HIGH', price: h, index: globalIdx, barsAgo: klines15m.length - 1 - globalIdx });
    if (isLow) lows.push({ type: 'LOW', price: l, index: globalIdx, barsAgo: klines15m.length - 1 - globalIdx });
  }

  const filterSwings = (arr) => {
    const res = [];
    for (const pt of arr) {
      if (!res.length) {
        res.push(pt);
        continue;
      }
      const prev = res[res.length - 1];
      if (Math.abs(pt.price - prev.price) / prev.price >= activeCfg.minSwingPct) {
        res.push(pt);
      } else {
        if (pt.type === 'HIGH' && pt.price > prev.price) res[res.length - 1] = pt;
        if (pt.type === 'LOW' && pt.price < prev.price) res[res.length - 1] = pt;
      }
    }
    return res;
  };

  return {
    sigHighs: filterSwings(highs),
    sigLows: filterSwings(lows),
    windowStartIdx: offset,
    cfg: activeCfg
  };
}

function detectLatestSwingAnchor(klines15m, precomputed = null) {
  const n = klines15m.length;
  if (n < 8) {
    return { type: 'INIT', price: parseFloat(klines15m[0]?.[3] || 0), index: 0, barsAgo: n };
  }
  const currentPrice = parseFloat(klines15m[n - 1][4]);
  const { sigHighs, sigLows, windowStartIdx, cfg } = precomputed || extractAdaptiveSwingPoints(klines15m);
  const combined = [...sigHighs, ...sigLows].sort((a, b) => a.index - b.index);

  for (let idx = combined.length - 1; idx >= 0; idx--) {
    const c = combined[idx];
    const moveRatio = Math.abs(currentPrice - c.price) / Math.max(c.price, 1);
    if (moveRatio >= cfg.minSwingPct && c.barsAgo >= 2) {
      return c;
    }
  }

  const lookbackStart = Math.max(windowStartIdx, n - Math.max(12, Math.round(cfg.windowBars * 0.5)));
  let bestLow = { price: Infinity, index: lookbackStart };
  let bestHigh = { price: -Infinity, index: lookbackStart };
  for (let i = lookbackStart; i < n; i++) {
    const l = parseFloat(klines15m[i][3]);
    const h = parseFloat(klines15m[i][2]);
    if (l < bestLow.price) bestLow = { price: l, index: i };
    if (h > bestHigh.price) bestHigh = { price: h, index: i };
  }
  const chosen = Math.abs(currentPrice - bestLow.price) <= Math.abs(bestHigh.price - currentPrice)
    ? { type: 'LOW', price: bestLow.price, index: bestLow.index }
    : { type: 'HIGH', price: bestHigh.price, index: bestHigh.index };

  return { ...chosen, barsAgo: Math.max(1, n - 1 - chosen.index) };
}

function analyzeAdaptiveSwingMap(klines15m, currentPrice, snapNow, m5Snap, deltaNow, hlData, precomputed = null) {
  const { sigHighs, sigLows, cfg } = precomputed || extractAdaptiveSwingPoints(klines15m);
  const slice = klines15m.slice(-cfg.windowBars);
  const fallbackHigh = Math.max(...slice.map(k => parseFloat(k[2])));
  const fallbackLow = Math.min(...slice.map(k => parseFloat(k[3])));

  const lastHigh = sigHighs[sigHighs.length - 1] || { price: fallbackHigh, barsAgo: 1 };
  const prevHigh = sigHighs[sigHighs.length - 2] || null;
  const lastLow = sigLows[sigLows.length - 1] || { price: fallbackLow, barsAgo: 1 };
  const prevLow = sigLows[sigLows.length - 2] || null;

  const highTrend = prevHigh ? (lastHigh.price > prevHigh.price ? 'HH' : 'LH') : 'SWG-H';
  const lowTrend = prevLow ? (lastLow.price > prevLow.price ? 'HL' : 'LL') : 'SWG-L';

  const span = Math.max(lastHigh.price - lastLow.price, currentPrice * 0.004);
  const posInCorridor = Math.max(0, Math.min(1, (currentPrice - lastLow.price) / span));

  const fSw = snapNow['SWING'].fut;
  const sSw = snapNow['SWING'].spot;
  const f15 = snapNow['15m'].fut;
  const f1h = snapNow['1h'].fut;
  const f4h = snapNow['4h'].fut;
  const dF15 = deltaNow['15m']?.fut ?? 0;
  const f5Weighted = m5Snap.fut * m5Snap.weightMult;

  const hlShortSqueezeBias = hlData && hlData.fundingHourly < -0.00005;
  const hlLongHeavyBias = hlData && hlData.fundingHourly > 0.00015;

  const macroBearish = f4h < 0 || (f1h < 0 && posInCorridor <= 0.5);
  const sellingEasing = (f5Weighted > 0 || m5Snap.isAbsorption || dF15 > 250000 || (fSw > 0 && lowTrend === 'HL'));
  const buyingEasing = (f5Weighted < 0 || dF15 < -250000 || (fSw < 0 && highTrend === 'LH'));

  let mapSignal = 'MID_CORRIDOR';
  let mapHeadline = '';
  let mapAdvice = '';
  let mapScoreBias = 0;

  if (macroBearish && posInCorridor <= 0.45 && sellingEasing) {
    mapSignal = 'DROP_EXHAUSTION_ENTRY';
    mapScoreBias = hlShortSqueezeBias ? 34 : 28;
    mapHeadline = `Επιβράδυνση πτώσης κοντά στο ${lowTrend} ($${fmtPrice(lastLow.price)}) — έλεγχος εισόδου`;
    mapAdvice = `Η ευρύτερη εικόνα είναι επιφυλακτική/πτωτική, αλλά η τοπική ροή μαλακώνει (5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}], 15m: ${fmtUsd(f15)}, SWG: ${fmtUsd(fSw)}).${hlShortSqueezeBias ? ' Στο HL πιέζονται shorts.' : ''} Ενδείκνυται έλεγχος εισόδου αντί για κυνηγητό σορτ.`;
  } else if (currentPrice > lastHigh.price && fSw > 0 && f5Weighted >= -200000) {
    mapSignal = 'BULL_BREAK_READY';
    mapScoreBias = hlShortSqueezeBias ? 38 : 32;
    mapHeadline = `Διάσπαση πάνω από ${highTrend} ($${fmtPrice(lastHigh.price)}) με καύσιμο CVD`;
    mapAdvice = `Σπάσιμο τοπικής κορυφής με ροή κύματος (${fmtUsd(fSw)} Perp / ${fmtUsd(sSw)} Spot) και 5m [${m5Snap.qualityTag}].`;
  } else if (currentPrice < lastLow.price && fSw < 0 && !sellingEasing) {
    mapSignal = 'BEAR_BREAK_READY';
    mapScoreBias = hlLongHeavyBias ? -38 : -32;
    mapHeadline = `Διάσπαση κάτω από ${lowTrend} ($${fmtPrice(lastLow.price)}) με πίεση CVD`;
    mapAdvice = `Πέρασμα κάτω από το τοπικό χαμηλό με αρνητική πίεση (${fmtUsd(fSw)} Perp, 5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}]).${hlLongHeavyBias ? ' Βαρύ funding longs στο HL.' : ''}`;
  } else if (posInCorridor >= 0.65 && buyingEasing) {
    mapSignal = 'RALLY_EXHAUSTION_WAIT';
    mapScoreBias = hlLongHeavyBias ? -30 : -24;
    mapHeadline = `Χάνει φόρα η άνοδος προς ${highTrend} ($${fmtPrice(lastHigh.price)}) — πιθανό LH / αναμονή`;
    mapAdvice = `Η τιμή είναι κοντά στην κορυφή του διαδρόμου (${Math.round(posInCorridor * 100)}%), αλλά η άμεση ροή επιβραδύνει (5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}], 15m: ${fmtUsd(f15)}). Αναμονή για επανεξέταση.`;
  } else if (posInCorridor <= 0.35 && !sellingEasing) {
    mapSignal = 'BEAR_BREAK_READY';
    mapScoreBias = -22;
    mapHeadline = `Πίεση προς τοπικό χαμηλό $${fmtPrice(lastLow.price)} χωρίς ένδειξη φρεναρίσματος`;
    mapAdvice = `Οι πωλητές διατηρούν ρυθμό (5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}], 15m: ${fmtUsd(f15)}). Καλύτερα να φανεί επιβράδυνση πριν από κόντρα είσοδο.`;
  } else {
    mapSignal = 'MID_CORRIDOR';
    mapScoreBias = 0;
    mapHeadline = `Διάδρομος $${fmtPrice(lastLow.price)} (${lowTrend}) ↔ $${fmtPrice(lastHigh.price)} (${highTrend})`;
    mapAdvice = `Η τιμή βρίσκεται στο ${Math.round(posInCorridor * 100)}% του δυναμικού διαδρόμου (${cfg.windowBars}×15m · ${cfg.modeLabel} · 5m ${m5Snap.qualityTag}).`;
  }

  return {
    lastHigh: lastHigh.price,
    lastLow: lastLow.price,
    highTrend,
    lowTrend,
    posInCorridor,
    mapSignal,
    mapHeadline,
    mapAdvice,
    mapScoreBias,
    windowBars: cfg.windowBars,
    modeLabel: cfg.modeLabel
  };
}

function findStartIndexByTs(list, anchorTs, tsExtractor) {
  if (!Array.isArray(list) || !list.length || !anchorTs) return null;
  const idx = list.findIndex(k => tsExtractor(k) >= anchorTs);
  return idx >= 0 ? idx : Math.max(0, list.length - 8);
}

async function fetchBybitData(sym, anchorTs = null) {
  try {
    const [linRes, spotRes] = await Promise.all([
      fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${sym}&interval=15&limit=120`),
      fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=15&limit=120`)
    ]);
    const [linJson, spotJson] = await Promise.all([linRes.json(), spotRes.json()]);
    const linList = linJson?.result?.list ? [...linJson.result.list].reverse() : null;
    const spotList = spotJson?.result?.list ? [...spotJson.result.list].reverse() : null;
    if (!linList || !spotList || linList.length < 20 || spotList.length < 20) return null;

    const linStart = findStartIndexByTs(linList, anchorTs, k => parseInt(k[0], 10));
    const spotStart = findStartIndexByTs(spotList, anchorTs, k => parseInt(k[0], 10));
    const swingFut = linStart !== null ? calcBybitFlowFromKlines(linList, 0, linStart)?.delta ?? 0 : 0;
    const swingSpot = spotStart !== null ? calcBybitFlowFromKlines(spotList, 0, spotStart)?.delta ?? 0 : 0;

    return {
      '15m': { fut: calcBybitFlowFromKlines(linList, 1).delta, spot: calcBybitFlowFromKlines(spotList, 1).delta },
      '1h':  { fut: calcBybitFlowFromKlines(linList, 4).delta, spot: calcBybitFlowFromKlines(spotList, 4).delta },
      '4h':  { fut: calcBybitFlowFromKlines(linList, 16).delta, spot: calcBybitFlowFromKlines(spotList, 16).delta },
      '1D':  { fut: calcBybitFlowFromKlines(linList, 96).delta, spot: calcBybitFlowFromKlines(spotList, 96).delta },
      SWING: { fut: swingFut, spot: swingSpot },
      vol1h: calcBybitFlowFromKlines(linList, 4).totalVol,
      vol4h: calcBybitFlowFromKlines(linList, 16).totalVol
    };
  } catch (e) {
    return null;
  }
}

async function fetchOkxData(sym, anchorTs = null) {
  try {
    const base = sym.replace('USDT', '');
    const instSwap = `${base}-USDT-SWAP`;
    const instSpot = `${base}-USDT`;
    const [swapRes, spotRes] = await Promise.all([
      fetch(`https://www.okx.com/api/v5/market/candles?instId=${instSwap}&bar=15m&limit=120`),
      fetch(`https://www.okx.com/api/v5/market/candles?instId=${instSpot}&bar=15m&limit=120`)
    ]);
    const [swapJson, spotJson] = await Promise.all([swapRes.json(), spotRes.json()]);
    const swapList = Array.isArray(swapJson?.data) ? [...swapJson.data].reverse() : null;
    const spotList = Array.isArray(spotJson?.data) ? [...spotJson.data].reverse() : null;
    if (!swapList || !spotList || swapList.length < 20 || spotList.length < 20) return null;

    const swapStart = findStartIndexByTs(swapList, anchorTs, k => parseInt(k[0], 10));
    const spotStart = findStartIndexByTs(spotList, anchorTs, k => parseInt(k[0], 10));
    const swingFut = swapStart !== null ? calcOkxFlowFromKlines(swapList, 0, swapStart)?.delta ?? 0 : 0;
    const swingSpot = spotStart !== null ? calcOkxFlowFromKlines(spotList, 0, spotStart)?.delta ?? 0 : 0;

    return {
      '15m': { fut: calcOkxFlowFromKlines(swapList, 1).delta, spot: calcOkxFlowFromKlines(spotList, 1).delta },
      '1h':  { fut: calcOkxFlowFromKlines(swapList, 4).delta, spot: calcOkxFlowFromKlines(spotList, 4).delta },
      '4h':  { fut: calcOkxFlowFromKlines(swapList, 16).delta, spot: calcOkxFlowFromKlines(spotList, 16).delta },
      '1D':  { fut: calcOkxFlowFromKlines(swapList, 96).delta, spot: calcOkxFlowFromKlines(spotList, 96).delta },
      SWING: { fut: swingFut, spot: swingSpot },
      vol1h: calcOkxFlowFromKlines(swapList, 4).totalVol,
      vol4h: calcOkxFlowFromKlines(swapList, 16).totalVol
    };
  } catch (e) {
    return null;
  }
}

function computeDynamicStructure(klines, currentPrice, cvd1hDelta, windowBars = 48) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));
  const lookback = Math.max(24, Math.min(klines.length, windowBars));

  const recent = klines.slice(-lookback);
  const swingHighs = [];
  const swingLows = [];

  for (let i = 3; i < recent.length - 3; i++) {
    const h = parseFloat(recent[i][2]);
    const l = parseFloat(recent[i][3]);
    const isSwingHigh =
      h >= parseFloat(recent[i - 1][2]) && h >= parseFloat(recent[i - 2][2]) && h >= parseFloat(recent[i - 3][2]) &&
      h >= parseFloat(recent[i + 1][2]) && h >= parseFloat(recent[i + 2][2]) && h >= parseFloat(recent[i + 3][2]);
    const isSwingLow =
      l <= parseFloat(recent[i - 1][3]) && l <= parseFloat(recent[i - 2][3]) && l <= parseFloat(recent[i - 3][3]) &&
      l <= parseFloat(recent[i + 1][3]) && l <= parseFloat(recent[i + 2][3]) && l <= parseFloat(recent[i + 3][3]);

    if (isSwingHigh) swingHighs.push(h);
    if (isSwingLow) swingLows.push(l);
  }

  const minBandGap = currentPrice * 0.004;

  const pickSeparated = (candidates, asc) => {
    const sorted = [...candidates].sort((a, b) => asc ? a - b : b - a);
    const chosen = [];
    for (const val of sorted) {
      if (chosen.every(existing => Math.abs(existing - val) >= minBandGap)) {
        chosen.push(val);
      }
      if (chosen.length >= 2) break;
    }
    return chosen;
  };

  const supportsBelow = pickSeparated(swingLows.filter(v => v < currentPrice * 0.9985), false);
  const resistsAbove = pickSeparated(swingHighs.filter(v => v > currentPrice * 1.0015), true);

  const minLow = Math.min(...lows.slice(-lookback));
  const maxHigh = Math.max(...highs.slice(-lookback));
  const span = Math.max(maxHigh - minLow, currentPrice * 0.012);

  const demandTop = supportsBelow[0] ?? (currentPrice - span * 0.25);
  const demandBottom = supportsBelow[1] ?? Math.max(minLow, demandTop - span * 0.22);

  const supplyBottom = resistsAbove[0] ?? (currentPrice + span * 0.25);
  const supplyTop = resistsAbove[1] ?? Math.min(maxHigh, supplyBottom + span * 0.22);

  const softPivot = currentPrice >= demandTop
    ? Math.max(demandTop + minBandGap * 0.4, currentPrice - span * 0.12)
    : Math.min(supplyBottom - minBandGap * 0.4, currentPrice + span * 0.12);

  const hardPivot = Math.min(demandBottom, demandTop - minBandGap * 0.6);

  const lastBar = klines[klines.length - 1];
  const lastLow = parseFloat(lastBar[3]);
  const lastClose = parseFloat(lastBar[4]);

  let zoneBehavior = 'Εντός εύρους ισορροπίας';
  if (lastLow < demandTop && lastClose > demandTop) {
    zoneBehavior = cvd1hDelta >= 0
      ? 'SWEEP & ΑΝΑΚΤΗΣΗ πάνω από Demand (Απορρόφηση)'
      : 'SWEEP στη ζώνη — αναμονή επιβεβαίωσης ροής';
  } else if (lastClose < hardPivot && cvd1hDelta < 0) {
    zoneBehavior = 'ΚΑΘΑΡΟ BREAK κάτω από Σκληρό Pivot (Αλλαγή Δομής)';
  } else if (lastClose <= demandTop && lastClose >= hardPivot) {
    zoneBehavior = 'Δοκιμή μέσα στη ζώνη Demand';
  } else if (lastClose > supplyBottom) {
    zoneBehavior = 'Διάσπαση Αντίστασης — κίνηση προς επόμενο Pool';
  }

  return {
    demandTop,
    demandBottom,
    supplyBottom,
    supplyTop,
    softPivot,
    hardPivot,
    zoneBehavior
  };
}

function computeWeightedDiagnosis(struct, snapNow, m5Snap, swingAnchor, swingMap, currentPrice) {
  const f15 = snapNow['15m'].fut;
  const s15 = snapNow['15m'].spot;
  const f1h = snapNow['1h'].fut;
  const s1h = snapNow['1h'].spot;
  const f4h = snapNow['4h'].fut;
  const s4h = snapNow['4h'].spot;
  const fSw = snapNow['SWING'].fut;
  const sSw = snapNow['SWING'].spot;

  let structScore = 0;
  if (currentPrice < struct.hardPivot) structScore = -90;
  else if (currentPrice < struct.demandBottom) structScore = -60;
  else if (currentPrice < struct.demandTop) structScore = -25;
  else if (currentPrice > struct.supplyBottom) structScore = 80;
  else if (currentPrice >= struct.softPivot) structScore = 30;
  else structScore = -15;

  const macroNorm = Math.max(15000000, Math.abs(f4h) * 0.8 + Math.abs(f1h) * 2.5);
  const macroRaw = (f1h * 0.55 + s1h * 1.15 + f4h * 0.45 + s4h * 0.9) / macroNorm;
  const macroScore = Math.max(-100, Math.min(100, macroRaw * 100));

  const w5Fut = m5Snap.fut * m5Snap.weightMult;
  const w5Spot = m5Snap.spot * m5Snap.weightMult;
  const moveNorm = Math.max(6000000, Math.abs(fSw) * 0.9 + Math.abs(w5Fut) * 4);
  const flowComponent = ((w5Fut * 1.5 + w5Spot * 2.2 + fSw * 0.65 + sSw * 1.2 + f15 * 0.45 + s15 * 0.8) / moveNorm) * 70;
  const mapScore = Math.max(-100, Math.min(100, flowComponent + swingMap.mapScoreBias));

  const totalScore = Math.round(structScore * 0.35 + macroScore * 0.30 + mapScore * 0.35);

  const reasons = [
    `Φακός ${swingMap.windowBars}×15m (${swingMap.modeLabel}): ${swingMap.lowTrend} $${fmtPrice(swingMap.lastLow)} ↔ ${swingMap.highTrend} $${fmtPrice(swingMap.lastHigh)} (${Math.round(swingMap.posInCorridor * 100)}%)`,
    `Από ${swingAnchor.type === 'LOW' ? 'χαμηλό' : 'υψηλό'} $${fmtPrice(swingAnchor.price)}: Perp ${fmtUsd(fSw)} / Spot ${fmtUsd(sSw)} · 5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}]`,
    `Βάρη: Δομή 35% (${structScore > 0 ? '+' : ''}${structScore}) · 1h/4h 30% (${macroScore > 0 ? '+' : ''}${Math.round(macroScore)}) · Φακός 35% (${mapScore > 0 ? '+' : ''}${Math.round(mapScore)})`
  ];

  return {
    totalScore,
    structScore,
    macroScore,
    mapScore,
    reasonText: reasons.join(' · ')
  };
}

function computeAdaptiveCapitalRatio(snapNow, prevSnap, fut1hVol, fut4hVol, hlData, activeVenues) {
  const f15 = snapNow['15m'].fut;
  const s15 = snapNow['15m'].spot;
  const f1h = snapNow['1h'].fut;
  const s1h = snapNow['1h'].spot;
  const f4h = snapNow['4h'].fut;
  const s4h = snapNow['4h'].spot;
  const f1d = snapNow['1D'].fut;
  const s1d = snapNow['1D'].spot;

  const dF15 = prevSnap ? (f15 - prevSnap['15m'].fut) : 0;
  const dF1h = prevSnap ? (f1h - prevSnap['1h'].fut) : 0;

  const shortMag = Math.abs(f15) + Math.abs(f1h) + Math.abs(s1h) * 2 + Math.abs(dF1h);
  const macroMag = Math.abs(f4h) + Math.abs(f1d) * 0.4 + Math.abs(s4h) * 2 + Math.abs(s1d) * 0.5;

  const shortImpulseStrong = shortMag > macroMag * 0.42 || Math.abs(dF15) > 1200000 || fut4hVol < fut1hVol * 2.2;
  const wShort = shortImpulseStrong ? 1.65 : 0.65;
  const wMacro = shortImpulseStrong ? 0.55 : 1.35;
  const activeTfLabel = shortImpulseStrong ? '15m/1h Ροή' : '4h/1D Δομή';

  let hlBullWeight = 0;
  let hlBearWeight = 0;
  let hlPain = 'Ουδέτερο funding (χωρίς ακραίο πόνο)';

  if (hlData) {
    const ann = hlData.annualizedPct;
    document.getElementById('hlFundingBadge').textContent =
      `HL: ${(hlData.fundingHourly * 100).toFixed(4)}%/h (${ann.toFixed(1)}%)`;
    if (hlData.fundingHourly < -0.00005) {
      hlPain = `Πιέζονται SHORTS (πληρώνουν longs · OI ${fmtUsd(hlData.oiUsd)})`;
      hlBullWeight = hlData.oiUsd * 0.08;
    } else if (hlData.fundingHourly > 0.00015) {
      hlPain = `Πιέζονται LONGS (ακριβό funding · OI ${fmtUsd(hlData.oiUsd)})`;
      hlBearWeight = hlData.oiUsd * 0.08;
    } else {
      hlPain = `Ισορροπημένο funding · HL OI: ${fmtUsd(hlData.oiUsd)} · [${activeVenues.join('+')}]`;
    }
  } else {
    document.getElementById('hlFundingBadge').textContent = `Venues: ${activeVenues.join('+')}`;
    hlPain = `Ενεργές πηγές: ${activeVenues.join(' + ')} (HL εκτός)`;
  }

  const rawBull =
    (Math.max(0, f15) + Math.max(0, f1h) + Math.max(0, s1h) * 2 + Math.max(0, dF15)) * wShort +
    (Math.max(0, f4h) + Math.max(0, f1d) * 0.35 + Math.max(0, s4h) * 2) * wMacro +
    hlBullWeight;

  const rawBear =
    (Math.max(0, -f15) + Math.max(0, -f1h) + Math.max(0, -s1h) * 2 + Math.max(0, -dF15)) * wShort +
    (Math.max(0, -f4h) + Math.max(0, -f1d) * 0.35 + Math.max(0, -s4h) * 2) * wMacro +
    hlBearWeight;

  const floorBase = Math.max(250000, (fut1hVol + fut4hVol) * 0.002);
  const bullCap = Math.max(rawBull, floorBase * 0.25);
  const bearCap = Math.max(rawBear, floorBase * 0.25);

  const bullShare = (bullCap / (bullCap + bearCap)) * 100;
  const ratio = (bullCap / bearCap).toFixed(2);

  return {
    bullCap,
    bearCap,
    bullShare,
    ratio,
    hlPain,
    activeTfLabel
  };
}

async function fetchHyperliquidPain(coin) {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' })
    });
    const data = await res.json();
    const universe = data[0]?.universe || [];
    const ctxs = data[1] || [];
    const idx = universe.findIndex(u => u.name === coin);
    if (idx === -1) return null;
    const ctx = ctxs[idx];
    const fundingHourly = parseFloat(ctx.funding || 0);
    const openInterestCoins = parseFloat(ctx.openInterest || 0);
    const markPx = parseFloat(ctx.markPx || 0);
    const oiUsd = openInterestCoins * markPx;
    const annualizedPct = fundingHourly * 24 * 365 * 100;
    return { fundingHourly, annualizedPct, oiUsd };
  } catch (e) {
    return null;
  }
}

function pushEvent(title, body) {
  const now = new Date().toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.events.unshift({ time: now, title, body });
  if (state.events.length > 18) state.events.pop();

  const feed = document.getElementById('eventFeed');
  feed.innerHTML = state.events.map(ev => `
    <div class="feed-item">
      <div class="feed-meta">${ev.time} · ${ev.title}</div>
      <div>${ev.body}</div>
    </div>
  `).join('');
}

function drawChart(klines, struct, swingMap = null) {
  const canvas = document.getElementById('radarCanvas');
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const padR = 86;
  const plotW = Math.max(60, w - padR);

  const viewBars = swingMap?.windowBars ? Math.min(klines.length, swingMap.windowBars) : 48;
  const view = klines.slice(-viewBars);
  const highs = view.map(k => parseFloat(k[2]));
  const lows = view.map(k => parseFloat(k[3]));
  const extraHighs = swingMap ? [struct.supplyTop, swingMap.lastHigh] : [struct.supplyTop];
  const extraLows = swingMap ? [struct.hardPivot, swingMap.lastLow] : [struct.hardPivot];

  const maxP = Math.max(...highs, ...extraHighs) * 1.002;
  const minP = Math.min(...lows, ...extraLows) * 0.998;
  const range = maxP - minP || 1;

  const yOf = (price) => h - ((price - minP) / range) * (h - 28) - 14;

  ctx.clearRect(0, 0, w, h);

  const yDemTop = yOf(struct.demandTop);
  const yDemBot = yOf(struct.demandBottom);
  ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
  ctx.fillRect(0, Math.min(yDemTop, yDemBot), plotW, Math.max(8, Math.abs(yDemBot - yDemTop)));

  const ySupTop = yOf(struct.supplyTop);
  const ySupBot = yOf(struct.supplyBottom);
  ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
  ctx.fillRect(0, Math.min(ySupTop, ySupBot), plotW, Math.max(8, Math.abs(ySupBot - ySupTop)));

  if (swingMap) {
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.0;

    ctx.beginPath();
    ctx.moveTo(0, yOf(swingMap.lastHigh));
    ctx.lineTo(plotW, yOf(swingMap.lastHigh));
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, yOf(swingMap.lastLow));
    ctx.lineTo(plotW, yOf(swingMap.lastLow));
    ctx.stroke();
  }

  const ySoft = yOf(struct.softPivot);
  ctx.strokeStyle = '#f59e0b';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(0, ySoft);
  ctx.lineTo(plotW, ySoft);
  ctx.stroke();

  const yHard = yOf(struct.hardPivot);
  ctx.strokeStyle = '#ef4444';
  ctx.setLineDash([]);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, yHard);
  ctx.lineTo(plotW, yHard);
  ctx.stroke();

  const step = plotW / view.length;
  const candleW = Math.max(2, step * 0.62);
  view.forEach((k, i) => {
    const o = parseFloat(k[1]);
    const hi = parseFloat(k[2]);
    const lo = parseFloat(k[3]);
    const c = parseFloat(k[4]);
    const x = i * step + step * 0.5;
    const up = c >= o;

    ctx.strokeStyle = up ? '#10b981' : '#ef4444';
    ctx.fillStyle = up ? '#10b981' : '#ef4444';
    ctx.beginPath();
    ctx.moveTo(x, yOf(hi));
    ctx.lineTo(x, yOf(lo));
    ctx.stroke();

    const top = yOf(Math.max(o, c));
    const bot = yOf(Math.min(o, c));
    ctx.fillRect(x - candleW / 2, top, candleW, Math.max(1.5, bot - top));
  });

  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  const labels = [
    { p: struct.supplyBottom, color: '#f87171', tag: 'POOL' },
    { p: struct.softPivot, color: '#fbbf24', tag: 'S-PIV' },
    { p: struct.demandTop, color: '#34d399', tag: 'DEM' },
    { p: struct.hardPivot, color: '#ef4444', tag: 'H-PIV' }
  ];
  if (swingMap) {
    labels.push({ p: swingMap.lastHigh, color: '#38bdf8', tag: swingMap.highTrend });
    labels.push({ p: swingMap.lastLow, color: '#38bdf8', tag: swingMap.lowTrend });
  }

  const sortedLabels = labels
    .map(lb => ({ ...lb, y: yOf(lb.p) }))
    .sort((a, b) => a.y - b.y);

  let lastLabelY = -999;
  sortedLabels.forEach(lb => {
    const drawY = Math.max(lb.y + 3, lastLabelY + 12);
    lastLabelY = drawY - 3;
    ctx.fillStyle = lb.color;
    ctx.fillText(`${lb.tag} ${Math.round(lb.p)}`, plotW + 4, Math.min(h - 4, drawY));
  });
}

async function runCycle() {
  const sym = document.getElementById('symbolSelect').value;
  if (sym !== state.symbol) {
    state.symbol = sym;
    state.prevCvdSnap = null;
    state.perVenuePrev = {};
    state.lastSummarySignature = '';
  }
  const baseCoin = sym.replace('USDT', '');

  try {
    const [fut15Res, fut1hRes, spot15Res, spot1hRes, fut5mRes, spot5mRes, hlData] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=120`),
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&limit=48`),
      fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=15m&limit=120`),
      fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=48`),
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=5m&limit=36`),
      fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=5m&limit=36`),
      fetchHyperliquidPain(baseCoin)
    ]);

    const [fut15, fut1h, spot15, spot1h, fut5m, spot5m] = await Promise.all([
      fut15Res.json(), fut1hRes.json(), spot15Res.json(), spot1hRes.json(), fut5mRes.json(), spot5mRes.json()
    ]);

    if (!Array.isArray(fut15) || !fut15.length) {
      throw new Error('Binance klines unavailable');
    }

    const swingPrecomp = extractAdaptiveSwingPoints(fut15);
    const swingAnchor = detectLatestSwingAnchor(fut15, swingPrecomp);
    const anchorTs = fut15[swingAnchor.index] ? parseInt(fut15[swingAnchor.index][0], 10) : null;

    const [bybitSnap, okxSnap] = await Promise.all([
      fetchBybitData(sym, anchorTs),
      fetchOkxData(sym, anchorTs)
    ]);

    const currentPrice = parseFloat(fut15[fut15.length - 1][4]);
    state.prevPrice = state.lastPrice;
    state.lastPrice = currentPrice;
    state.klines15m = fut15;

    document.getElementById('livePrice').textContent = `$${fmtPrice(currentPrice)}`;

    const bnFut1h = calcBinanceCvdFromKlines(fut15, 4);
    const bnFut4h = calcBinanceCvdFromKlines(fut1h, 4);
    const bnSwingFut = calcBinanceCvdFromKlines(fut15, 0, swingAnchor.index).delta;
    const bnSwingSpot = calcBinanceCvdFromKlines(spot15, 0, swingAnchor.index).delta;

    const bnSnap = {
      '15m': { fut: calcBinanceCvdFromKlines(fut15, 1).delta, spot: calcBinanceCvdFromKlines(spot15, 1).delta },
      '1h':  { fut: bnFut1h.delta, spot: calcBinanceCvdFromKlines(spot15, 4).delta },
      '4h':  { fut: bnFut4h.delta, spot: calcBinanceCvdFromKlines(spot1h, 4).delta },
      '1D':  { fut: calcBinanceCvdFromKlines(fut1h, 24).delta, spot: calcBinanceCvdFromKlines(spot1h, 24).delta },
      SWING: { fut: bnSwingFut, spot: bnSwingSpot }
    };

    const m5Snap = analyze5mFlowQuality(fut5m, spot5m);

    const venues = [{ code: 'BN', snap: bnSnap }];
    if (bybitSnap) venues.push({ code: 'BB', snap: bybitSnap });
    if (okxSnap) venues.push({ code: 'OKX', snap: okxSnap });

    const tfKeys = ['15m', '1h', '4h', '1D', 'SWING'];
    const snapNow = {};
    const deltaNow = {};

    tfKeys.forEach(k => {
      let sumFut = 0;
      let sumSpot = 0;
      let dFutSum = 0;
      let dSpotSum = 0;
      let anyComparable = false;

      venues.forEach(v => {
        if (!v.snap[k]) return;
        sumFut += v.snap[k].fut;
        sumSpot += v.snap[k].spot;

        const prevV = state.perVenuePrev[v.code];
        if (prevV && prevV[k]) {
          if (k === 'SWING' && prevV.swingIndex !== swingAnchor.index) {
            return;
          }
          dFutSum += (v.snap[k].fut - prevV[k].fut);
          dSpotSum += (v.snap[k].spot - prevV[k].spot);
          anyComparable = true;
        }
      });

      snapNow[k] = { fut: sumFut, spot: sumSpot };
      deltaNow[k] = {
        fut: anyComparable ? dFutSum : null,
        spot: anyComparable ? dSpotSum : null
      };
    });

    venues.forEach(v => {
      state.perVenuePrev[v.code] = { ...v.snap, swingIndex: swingAnchor.index };
    });

    const activeCodes = venues.map(v => v.code);
    if (hlData) activeCodes.push('HL');

    const tbody = document.getElementById('cvdTableBody');
    const rowOrder = ['5m', 'SWING', '15m', '1h', '4h', '1D'];

    tbody.innerHTML = rowOrder.map(key => {
      let fVal = 0;
      let sVal = 0;
      let dFut = null;
      let dSpot = null;
      let label = key;

      if (key === '5m') {
        fVal = m5Snap.fut;
        sVal = m5Snap.spot;
        if (state.prevCvdSnap && state.prevCvdSnap['5m']) {
          dFut = fVal - state.prevCvdSnap['5m'].fut;
          dSpot = sVal - state.prevCvdSnap['5m'].spot;
        }
        label = '5m';
      } else {
        fVal = snapNow[key].fut;
        sVal = snapNow[key].spot;
        dFut = deltaNow[key].fut;
        dSpot = deltaNow[key].spot;
        if (key === 'SWING') {
          label = `SWG·${swingAnchor.type === 'LOW' ? 'L' : 'H'}`;
        }
      }

      const hasDelta = dFut !== null && dSpot !== null;

      let pace = 'Σταθερό';
      let paceCls = '';
      if (key === '5m' && m5Snap.isAbsorption) {
        pace = 'Απορρόφηση 5m';
        paceCls = 'pos';
      } else if (hasDelta) {
        if (fVal > 0 && dFut > 350000) { pace = 'Επιταχύνει ↑'; paceCls = 'pos'; }
        else if (fVal > 0 && dFut < -350000) { pace = 'Μαλακώνει ↓'; paceCls = 'warn-txt'; }
        else if (fVal < 0 && dFut < -350000) { pace = 'Πιέζει κάτω ↓'; paceCls = 'neg'; }
        else if (fVal < 0 && dFut > 350000) { pace = 'Απορρόφηση ↑'; paceCls = 'pos'; }
      }

      return `
        <tr>
          <td><strong>${label}</strong></td>
          <td class="${fVal >= 0 ? 'pos' : 'neg'}">${fmtUsd(fVal)}</td>
          <td class="${hasDelta ? (dFut >= 0 ? 'pos' : 'neg') : ''}">${hasDelta ? fmtUsd(dFut) : '--'}</td>
          <td class="${sVal >= 0 ? 'pos' : 'neg'}">${fmtUsd(sVal)}</td>
          <td class="${hasDelta ? (dSpot >= 0 ? 'pos' : 'neg') : ''}">${hasDelta ? fmtUsd(dSpot) : '--'}</td>
          <td class="${paceCls}">${pace}</td>
        </tr>
      `;
    }).join('');

    document.getElementById('snapClock').textContent =
      `Snapshot: ${new Date().toLocaleTimeString('el-GR')} · [${activeCodes.join('+')}]`;

    const struct = computeDynamicStructure(fut15, currentPrice, snapNow['1h'].fut, swingPrecomp.cfg.windowBars);
    const swingMap = analyzeAdaptiveSwingMap(fut15, currentPrice, snapNow, m5Snap, deltaNow, hlData, swingPrecomp);
    drawChart(fut15, struct, swingMap);

    document.getElementById('softPivotVal').textContent = `$${fmtPrice(struct.softPivot)}`;
    document.getElementById('hardPivotVal').textContent = `$${fmtPrice(struct.hardPivot)}`;
    document.getElementById('targetPoolVal').textContent = `$${fmtPrice(struct.supplyBottom)} – $${fmtPrice(struct.supplyTop)}`;
    document.getElementById('sweepBreakVal').textContent =
      `${struct.zoneBehavior} · Φακός ${swingMap.windowBars}×15m (${swingMap.modeLabel})`;
    document.getElementById('zoneStatus').textContent =
      `W:${swingMap.windowBars} · $${fmtPrice(swingMap.lastLow)} (${swingMap.lowTrend}) ↔ $${fmtPrice(swingMap.lastHigh)} (${swingMap.highTrend})`;
    document.getElementById('zoneLegend').innerHTML = `
      <span class="pos">■ Demand: $${fmtPrice(struct.demandBottom)} – $${fmtPrice(struct.demandTop)}</span>
      <span class="warn-txt">┄ S-Pivot: $${fmtPrice(struct.softPivot)}</span>
      <span class="neg">━ H-Pivot: $${fmtPrice(struct.hardPivot)}</span>
      <span style="color:#38bdf8">┄ Swing (${swingMap.windowBars}): $${fmtPrice(swingMap.lastLow)} – $${fmtPrice(swingMap.lastHigh)}</span>
    `;

    const totalVol1h = bnFut1h.totalVol + (bybitSnap?.vol1h || 0) + (okxSnap?.vol1h || 0);
    const totalVol4h = bnFut4h.totalVol + (bybitSnap?.vol4h || 0) + (okxSnap?.vol4h || 0);

    const cap = computeAdaptiveCapitalRatio(
      snapNow, state.prevCvdSnap, totalVol1h, totalVol4h, hlData, activeCodes
    );
    document.getElementById('hlPainText').textContent = cap.hlPain;
    document.getElementById('bullCapVal').textContent = fmtUsd(cap.bullCap);
    document.getElementById('bearCapVal').textContent = fmtUsd(cap.bearCap);
    document.getElementById('capRatioFill').style.width = `${cap.bullShare.toFixed(1)}%`;
    document.getElementById('capRatioText').textContent =
      `${cap.ratio} : 1 (${cap.bullShare.toFixed(0)}% Υπέρ / ${(100 - cap.bullShare).toFixed(0)}% Κατά) · ${cap.activeTfLabel}`;

    const diag = computeWeightedDiagnosis(struct, snapNow, m5Snap, swingAnchor, swingMap, currentPrice);
    const f1h = snapNow['1h'].fut;
    const s1h = snapNow['1h'].spot;
    const dF1h = deltaNow['1h'].fut ?? 0;

    let regime = swingMap.mapSignal;
    let cardClass = 'summary-card';
    let headline = `${swingMap.mapHeadline} (${diag.totalScore})`;
    let detail = `${swingMap.mapAdvice} ${diag.reasonText}.`;
    let syncLabel = `${swingMap.lowTrend} $${fmtPrice(swingMap.lastLow)} ↔ ${swingMap.highTrend} $${fmtPrice(swingMap.lastHigh)} [W:${swingMap.windowBars}]`;

    if (currentPrice < struct.hardPivot && f1h < 0 && swingMap.mapSignal !== 'DROP_EXHAUSTION_ENTRY') {
      regime = 'HARD_PIVOT_BREAK';
      cardClass = 'summary-card bear';
      headline = `ΣΚΛΗΡΟ PIVOT (${diag.totalScore}): Διάσπαση κάτω από $${fmtPrice(struct.hardPivot)} με πωλητική ροή`;
      detail = `Η δομή γύρισε καθοδικά (${fmtUsd(f1h)} στο 1h). ${swingMap.mapAdvice} ${diag.reasonText}.`;
    } else if (swingMap.mapSignal === 'DROP_EXHAUSTION_ENTRY') {
      cardClass = 'summary-card bull';
    } else if (swingMap.mapSignal === 'BULL_BREAK_READY' && f1h > 0 && s1h > 0) {
      cardClass = 'summary-card bull';
    } else if (swingMap.mapSignal === 'BEAR_BREAK_READY') {
      cardClass = 'summary-card bear';
    } else if (swingMap.mapSignal === 'RALLY_EXHAUSTION_WAIT') {
      cardClass = 'summary-card warn';
    } else if (f1h > 0 && s1h > 0 && dF1h >= 0) {
      regime = 'ALIGNED_BULL';
      cardClass = 'summary-card bull';
      headline = `Θετική εισροή (${diag.totalScore}): Futures & Spot προς Pool $${fmtPrice(struct.supplyBottom)}`;
      detail = `${swingMap.mapAdvice} ${diag.reasonText}.`;
    } else if (f1h > 0 && s1h <= 0) {
      regime = 'PERP_SPOT_DIVERGENCE';
      cardClass = 'summary-card warn';
      headline = `Ασυμφωνία Futures CVD με Spot (${diag.totalScore}) — άνοδος σε μόχλευση`;
      detail = `${swingMap.mapAdvice} ${diag.reasonText}.`;
    }

    document.getElementById('pillFlow').textContent =
      `5m: ${fmtUsd(m5Snap.fut)} (${m5Snap.qualityTag}) | 1h: ${fmtUsd(f1h)} | 4h: ${fmtUsd(snapNow['4h'].fut)}`;
    document.getElementById('pillSync').textContent = syncLabel;
    document.getElementById('pillPivot').textContent =
      `S-Pivot $${fmtPrice(struct.softPivot)} · H-Pivot $${fmtPrice(struct.hardPivot)}`;

    const signature = `${regime}|${swingMap.windowBars}|${m5Snap.qualityTag}|${Math.round(swingMap.lastLow)}|${Math.round(swingMap.lastHigh)}|${Math.round(diag.totalScore / 10)}`;
    if (signature !== state.lastSummarySignature) {
      state.lastSummarySignature = signature;
      const card = document.getElementById('summaryCard');
      card.className = cardClass;
      document.getElementById('summaryHeadline').textContent = headline;
      document.getElementById('summaryDetail').textContent = detail;
      document.getElementById('summaryUpdated').textContent =
        `Ενημερώθηκε: ${new Date().toLocaleTimeString('el-GR')} [${activeCodes.join('+')}]`;
      pushEvent(regime.replaceAll('_', ' '), headline);
    }

    state.prevCvdSnap = { ...snapNow, '5m': m5Snap };

    if (state.pollOverride === 'AUTO') {
      const priceMovePct = state.prevPrice
        ? Math.abs((currentPrice - state.prevPrice) / state.prevPrice) * 100
        : 0;
      const nearPivot =
        Math.abs(currentPrice - struct.softPivot) / currentPrice < 0.0035 ||
        Math.abs(currentPrice - struct.hardPivot) / currentPrice < 0.004 ||
        Math.abs(currentPrice - swingMap.lastHigh) / currentPrice < 0.0025 ||
        Math.abs(currentPrice - swingMap.lastLow) / currentPrice < 0.0025;
      const flowBurst = Math.abs(dF1h) > 2000000 || Math.abs(m5Snap.fut * m5Snap.weightMult) > 1500000 || priceMovePct > 0.18;

      scheduleNext((nearPivot || flowBurst) ? 5000 : 45000);
    } else {
      scheduleNext(state.pollOverride === 'TURBO' ? 5000 : 45000);
    }
  } catch (err) {
    document.getElementById('summaryHeadline').textContent =
      'Προσωρινή καθυστέρηση λήψης live δεδομένων — αυτόματη επανασύνδεση...';
    scheduleNext(10000);
  }
}

document.getElementById('symbolSelect').addEventListener('change', () => runCycle());
window.addEventListener('resize', () => {
  if (state.klines15m.length && state.prevCvdSnap) {
    const pre = extractAdaptiveSwingPoints(state.klines15m);
    const s = computeDynamicStructure(
      state.klines15m, state.lastPrice, state.prevCvdSnap['1h'].fut, pre.cfg.windowBars
    );
    const sm = analyzeAdaptiveSwingMap(
      state.klines15m,
      state.lastPrice,
      state.prevCvdSnap,
      state.prevCvdSnap['5m'] || { fut: 0, spot: 0, weightMult: 1, qualityTag: 'Κανονικό', isAbsorption: false },
      { '15m': { fut: 0, spot: 0 } },
      null,
      pre
    );
    drawChart(state.klines15m, s, sm);
  }
});

runCycle();
