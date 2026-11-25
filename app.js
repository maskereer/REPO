const STORAGE_PREFIX = 'cross_radar_v2_';

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
  cvdHistory: [],   // Rolling samples: [{ ts, price, m5Fut, m5Spot, f15, s15, f1h, s1h, fSw, sSw, swingKey }]
  prevSwingLeg: null, // Last completed swing leg before current anchor
  activeSwingMeta: null, // { key, type, price, startTs }
  lastSummarySignature: '',
  lastAdvisorSignature: '',
  lastAdvisorTs: 0,
  lastCycleTs: 0,
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

// --- Persistent Mobile-Safe Memory (localStorage per symbol) ---
function getStorageKey(sym) {
  return `${STORAGE_PREFIX}${sym}`;
}

function saveSymbolMemory(sym) {
  try {
    const payload = {
      savedAt: Date.now(),
      lastPrice: state.lastPrice,
      prevCvdSnap: state.prevCvdSnap,
      perVenuePrev: state.perVenuePrev,
      cvdHistory: state.cvdHistory.slice(-24),
      prevSwingLeg: state.prevSwingLeg,
      activeSwingMeta: state.activeSwingMeta,
      lastSummarySignature: state.lastSummarySignature,
      lastAdvisorSignature: state.lastAdvisorSignature,
      lastAdvisorTs: state.lastAdvisorTs,
      events: state.events.slice(0, 30)
    };
    localStorage.setItem(getStorageKey(sym), JSON.stringify(payload));
  } catch (e) {
    // Ignore quota/private mode errors silently
  }
}

function loadSymbolMemory(sym) {
  state.lastPrice = null;
  state.prevPrice = null;
  state.prevCvdSnap = null;
  state.perVenuePrev = {};
  state.cvdHistory = [];
  state.prevSwingLeg = null;
  state.activeSwingMeta = null;
  state.lastSummarySignature = '';
  state.lastAdvisorSignature = '';
  state.lastAdvisorTs = 0;
  state.events = [];

  try {
    const raw = localStorage.getItem(getStorageKey(sym));
    if (!raw) {
      renderEventFeed();
      return { restored: false, gapSec: 0 };
    }
    const data = JSON.parse(raw);
    const now = Date.now();
    const gapSec = data.savedAt ? Math.max(0, Math.round((now - data.savedAt) / 1000)) : 0;

    state.lastPrice = data.lastPrice ?? null;
    state.prevCvdSnap = data.prevCvdSnap ?? null;
    state.perVenuePrev = data.perVenuePrev ?? {};
    // Keep rolling samples up to 2 hours old so history survives background pauses
    state.cvdHistory = Array.isArray(data.cvdHistory)
      ? data.cvdHistory.filter(item => item && (now - item.ts) <= 2 * 3600 * 1000)
      : [];
    state.prevSwingLeg = data.prevSwingLeg ?? null;
    state.activeSwingMeta = data.activeSwingMeta ?? null;
    state.lastSummarySignature = data.lastSummarySignature ?? '';
    state.lastAdvisorSignature = data.lastAdvisorSignature ?? '';
    state.lastAdvisorTs = data.lastAdvisorTs ?? 0;
    state.events = Array.isArray(data.events) ? data.events.slice(0, 30) : [];

    renderEventFeed();
    return { restored: true, gapSec };
  } catch (e) {
    renderEventFeed();
    return { restored: false, gapSec: 0 };
  }
}

function renderEventFeed() {
  const feed = document.getElementById('eventFeed');
  if (!feed) return;
  if (!state.events.length) {
    feed.innerHTML = '<div class="feed-item"><div class="feed-meta">Αναμονή πρώτου κύκλου...</div></div>';
    return;
  }
  feed.innerHTML = state.events.map(ev => `
    <div class="feed-item">
      <div class="feed-meta">${ev.time} · ${ev.title}</div>
      <div>${ev.body}</div>
    </div>
  `).join('');
}

function pushEvent(title, body, symToSave = null) {
  const now = new Date().toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  state.events.unshift({ time: now, title, body });
  if (state.events.length > 30) state.events.pop();
  renderEventFeed();
  if (symToSave) saveSymbolMemory(symToSave);
}

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

// --- Rolling CVD Velocity & Consistency Calculator ---
function recordCvdSample(nowTs, currentPrice, m5Snap, snapNow, swingKey) {
  state.cvdHistory.push({
    ts: nowTs,
    price: currentPrice,
    m5Fut: m5Snap.fut,
    m5Spot: m5Snap.spot,
    f15: snapNow['15m'].fut,
    s15: snapNow['15m'].spot,
    f1h: snapNow['1h'].fut,
    s1h: snapNow['1h'].spot,
    f4h: snapNow['4h'].fut,
    s4h: snapNow['4h'].spot,
    fSw: snapNow['SWING'].fut,
    sSw: snapNow['SWING'].spot,
    swingKey
  });
  if (state.cvdHistory.length > 24) {
    state.cvdHistory.shift();
  }
}

function computeRollingFlowStats(currentSwingKey) {
  const hist = state.cvdHistory;
  if (hist.length < 2) {
    return {
      hasHistory: false,
      elapsedMin: 0,
      f15PerMin: 0,
      s15PerMin: 0,
      f1hPerMin: 0,
      s1hPerMin: 0,
      fSwPerMin: 0,
      sSwPerMin: 0,
      consistencyPct: 50,
      spotLeading: false,
      perpOnlyPush: false,
      label: 'Αρχικοποίηση μνήμης'
    };
  }

  const latest = hist[hist.length - 1];
  // Look back up to ~5 minutes (or up to 10 samples) for smooth rate calculation
  const targetLookbackMs = 5 * 60 * 1000;
  let baseIdx = Math.max(0, hist.length - 10);
  for (let i = hist.length - 2; i >= 0; i--) {
    baseIdx = i;
    if (latest.ts - hist[i].ts >= targetLookbackMs) break;
  }
  const base = hist[baseIdx];
  const elapsedMin = Math.max(0.15, (latest.ts - base.ts) / 60000);

  const f15PerMin = (latest.f15 - base.f15) / elapsedMin;
  const s15PerMin = (latest.s15 - base.s15) / elapsedMin;
  const f1hPerMin = (latest.f1h - base.f1h) / elapsedMin;
  const s1hPerMin = (latest.s1h - base.s1h) / elapsedMin;

  // For SWING rate, find oldest sample with the SAME swingKey
  let swBase = latest;
  for (let i = hist.length - 2; i >= 0; i--) {
    if (hist[i].swingKey === currentSwingKey) {
      swBase = hist[i];
      if (latest.ts - hist[i].ts >= targetLookbackMs) break;
    } else {
      break;
    }
  }
  const swElapsedMin = Math.max(0.15, (latest.ts - swBase.ts) / 60000);
  const fSwPerMin = latest.ts > swBase.ts ? (latest.fSw - swBase.fSw) / swElapsedMin : f15PerMin;
  const sSwPerMin = latest.ts > swBase.ts ? (latest.sSw - swBase.sSw) / swElapsedMin : s15PerMin;

  // Directional consistency across recent consecutive ticks
  const windowSlice = hist.slice(baseIdx);
  let posSteps = 0;
  let negSteps = 0;
  for (let i = 1; i < windowSlice.length; i++) {
    const stepDiff = windowSlice[i].f15 - windowSlice[i - 1].f15;
    if (stepDiff > 25000) posSteps++;
    else if (stepDiff < -25000) negSteps++;
  }
  const activeSteps = posSteps + negSteps;
  const dominantSteps = Math.max(posSteps, negSteps);
  const consistencyPct = activeSteps > 0 ? Math.round((dominantSteps / activeSteps) * 100) : 50;

  const spotLeading =
    (s15PerMin > 80000 && s15PerMin >= f15PerMin * 0.45) ||
    (s15PerMin < -80000 && s15PerMin <= f15PerMin * 0.45);
  const perpOnlyPush =
    Math.abs(f15PerMin) > 250000 &&
    Math.sign(f15PerMin) !== Math.sign(s15PerMin) &&
    Math.abs(s15PerMin) > 50000;

  let label = `Ρυθμός ${elapsedMin.toFixed(1)}λ: ${fmtUsd(f15PerMin)}/λ (${consistencyPct}% σταθ.)`;
  if (spotLeading) label += ' · Spot οδηγεί';
  else if (perpOnlyPush) label += ' · Μόνο Perps';

  return {
    hasHistory: true,
    elapsedMin,
    f15PerMin,
    s15PerMin,
    f1hPerMin,
    s1hPerMin,
    fSwPerMin,
    sSwPerMin,
    consistencyPct,
    spotLeading,
    perpOnlyPush,
    label
  };
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

function analyzeAdaptiveSwingMap(klines15m, currentPrice, snapNow, m5Snap, deltaNow, hlData, rollingStats, precomputed = null) {
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

  const rollingEasingBear = rollingStats.hasHistory && rollingStats.f15PerMin > 120000 && rollingStats.consistencyPct >= 60;
  const rollingEasingBull = rollingStats.hasHistory && rollingStats.f15PerMin < -120000 && rollingStats.consistencyPct >= 60;

  const macroBearish = f4h < 0 || (f1h < 0 && posInCorridor <= 0.5);
  const sellingEasing = (f5Weighted > 0 || m5Snap.isAbsorption || dF15 > 250000 || rollingEasingBear || (fSw > 0 && lowTrend === 'HL'));
  const buyingEasing = (f5Weighted < 0 || dF15 < -250000 || rollingEasingBull || (fSw < 0 && highTrend === 'LH'));

  let mapSignal = 'MID_CORRIDOR';
  let mapHeadline = '';
  let mapAdvice = '';
  let mapScoreBias = 0;

  if (macroBearish && posInCorridor <= 0.45 && sellingEasing) {
    mapSignal = 'DROP_EXHAUSTION_ENTRY';
    mapScoreBias = hlShortSqueezeBias ? 34 : 28;
    mapHeadline = `Επιβράδυνση πτώσης κοντά στο ${lowTrend} ($${fmtPrice(lastLow.price)}) — έλεγχος εισόδου`;
    mapAdvice = `Η ευρύτερη εικόνα είναι επιφυλακτική/πτωτική, αλλά η τοπική ροή μαλακώνει (5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}], SWG: ${fmtUsd(fSw)}, ${rollingStats.label}).${hlShortSqueezeBias ? ' Στο HL πιέζονται shorts.' : ''} Ενδείκνυται έλεγχος εισόδου αντί για κυνηγητό σορτ.`;
  } else if (currentPrice > lastHigh.price && fSw > 0 && f5Weighted >= -200000) {
    mapSignal = 'BULL_BREAK_READY';
    mapScoreBias = (hlShortSqueezeBias ? 38 : 32) + (rollingStats.spotLeading ? 6 : 0);
    mapHeadline = `Διάσπαση πάνω από ${highTrend} ($${fmtPrice(lastHigh.price)}) με καύσιμο CVD`;
    mapAdvice = `Σπάσιμο τοπικής κορυφής με ροή κύματος (${fmtUsd(fSw)} Perp / ${fmtUsd(sSw)} Spot) · ${rollingStats.label}.`;
  } else if (currentPrice < lastLow.price && fSw < 0 && !sellingEasing) {
    mapSignal = 'BEAR_BREAK_READY';
    mapScoreBias = hlLongHeavyBias ? -38 : -32;
    mapHeadline = `Διάσπαση κάτω από ${lowTrend} ($${fmtPrice(lastLow.price)}) με πίεση CVD`;
    mapAdvice = `Πέρασμα κάτω από το τοπικό χαμηλό με αρνητική πίεση (${fmtUsd(fSw)} Perp, 5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}]) · ${rollingStats.label}.`;
  } else if (posInCorridor >= 0.65 && buyingEasing) {
    mapSignal = 'RALLY_EXHAUSTION_WAIT';
    mapScoreBias = hlLongHeavyBias ? -30 : -24;
    mapHeadline = `Χάνει φόρα η άνοδος προς ${highTrend} ($${fmtPrice(lastHigh.price)}) — πιθανό LH / αναμονή`;
    mapAdvice = `Η τιμή είναι κοντά στην κορυφή του διαδρόμου (${Math.round(posInCorridor * 100)}%), αλλά η άμεση ροή επιβραδύνει (5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}], ${rollingStats.label}). Αναμονή για επανεξέταση.`;
  } else if (posInCorridor <= 0.35 && !sellingEasing) {
    mapSignal = 'BEAR_BREAK_READY';
    mapScoreBias = -22;
    mapHeadline = `Πίεση προς τοπικό χαμηλό $${fmtPrice(lastLow.price)} χωρίς ένδειξη φρεναρίσματος`;
    mapAdvice = `Οι πωλητές διατηρούν ρυθμό (5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}], 15m: ${fmtUsd(f15)}). Καλύτερα να φανεί επιβράδυνση πριν από κόντρα είσοδο.`;
  } else {
    mapSignal = 'MID_CORRIDOR';
    mapScoreBias = 0;
    mapHeadline = `Διάδρομος $${fmtPrice(lastLow.price)} (${lowTrend}) ↔ $${fmtPrice(lastHigh.price)} (${highTrend})`;
    mapAdvice = `Η τιμή βρίσκεται στο ${Math.round(posInCorridor * 100)}% του δυναμικού διαδρόμου (${cfg.windowBars}×15m · ${cfg.modeLabel} · ${rollingStats.label}).`;
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

// Autonomous background critic: flags blind spots, contradictions, rolling exhaustion, or traps
function evaluateAutonomousAdvisor(ctx) {
  const { currentPrice, struct, swingMap, diag, snapNow, m5Snap, deltaNow, hlData, rollingStats, prevSwingLeg } = ctx;
  const fSw = snapNow['SWING'].fut;
  const sSw = snapNow['SWING'].spot;
  const f1h = snapNow['1h'].fut;
  const s1h = snapNow['1h'].spot;
  const f4h = snapNow['4h'].fut;
  const dF1h = deltaNow['1h']?.fut ?? 0;

  let code = null;
  let title = '';
  let msg = '';

  // 1) Bullish headline/score vs negative Spot & heavy 4h overhang
  if (diag.totalScore >= 15 && s1h < -250000 && f4h < -15000000) {
    code = 'SPOT_VS_4H_TRAP';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΑΝΤΙΦΑΣΗ SPOT & 4H';
    msg = `Το score δείχνει θετικό (${diag.totalScore}), αλλά το 1h Spot είναι αρνητικό (${fmtUsd(s1h)}) και το 4h βαραίνει (${fmtUsd(f4h)}). Μην περάσεις εύκολα το ριμπάουντ για αλλαγή κύριας τάσης.`;
  }
  // 2) Rolling Perp-only push without Spot backing near swing extremes
  else if (rollingStats.hasHistory && rollingStats.perpOnlyPush && rollingStats.consistencyPct >= 65 &&
           (swingMap.posInCorridor >= 0.70 || swingMap.posInCorridor <= 0.30)) {
    code = 'ROLLING_PERP_ONLY';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΚΙΝΗΣΗ ΜΟΝΟ ΜΕ PERPS';
    msg = `Στα τελευταία ${rollingStats.elapsedMin.toFixed(1)} λεπτά τα futures τρέχουν (${fmtUsd(rollingStats.f15PerMin)}/λ, ${rollingStats.consistencyPct}% συνέπεια) αλλά το Spot κινείται αντίθετα (${fmtUsd(rollingStats.s15PerMin)}/λ). Υψηλός κίνδυνος sweep/αναστροφής.`;
  }
  // 3) Current swing leg running weaker than previous completed swing leg
  else if (prevSwingLeg && Math.abs(prevSwingLeg.fut) > 2500000 &&
           Math.sign(fSw) === Math.sign(prevSwingLeg.fut) &&
           Math.abs(fSw) < Math.abs(prevSwingLeg.fut) * 0.45 &&
           (swingMap.posInCorridor >= 0.72 || swingMap.posInCorridor <= 0.28)) {
    code = 'SWING_LEG_DIVERGENCE';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΑΔΥΝΑΜΟ SWING LEG';
    msg = `Το τρέχον swing (${fmtUsd(fSw)}) έχει κάτω από το μισό καύσιμο σε σχέση με το προηγούμενο κύμα (${fmtUsd(prevSwingLeg.fut)} από $${fmtPrice(prevSwingLeg.price)}). Προσοχή σε εξάντληση.`;
  }
  // 4) Counter-trend bounce near swing high / supply without spot backing
  else if (swingMap.posInCorridor >= 0.75 && fSw > 0 && sSw <= 0 && (f4h < 0 || f1h < 0)) {
    code = 'HIGH_FADE_RISK';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΠΙΕΣΗ ΣΤΟ ΑΝΩ ΑΚΡΟ';
    msg = `Η τιμή φτάνει στο ${Math.round(swingMap.posInCorridor * 100)}% του διαδρόμου προς ${swingMap.highTrend} ($${fmtPrice(swingMap.lastHigh)}) με θετικό Perp swing (${fmtUsd(fSw)}) αλλά χωρίς στήριξη Spot (${fmtUsd(sSw)}). Πρόσεξε το ρίσκο απόρριψης/LH.`;
  }
  // 5) Absorption detected on 5m near a key boundary or structure level
  else if (m5Snap.isAbsorption && (swingMap.posInCorridor <= 0.35 || swingMap.posInCorridor >= 0.65 || currentPrice <= struct.demandTop)) {
    code = 'ABSORPTION_WATCH';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΑΠΟΡΡΟΦΗΣΗ ΣΕ ΚΡΙΣΙΜΟ ΣΗΜΕΙΟ';
    msg = `Καταγράφηκε απορρόφηση στο 5m (${fmtUsd(m5Snap.fut)}) κοντά σε κρίσιμη ζώνη. Μεγάλη ροή χωρίς αναλογική κίνηση τιμής συχνά προηγείται στροφής ή απότομου ξεσπάσματος — περίμενε κλείσιμο επιβεβαίωσης.`;
  }
  // 6) Drop exhaustion setup while hard pivot / 4h still looms
  else if (swingMap.mapSignal === 'DROP_EXHAUSTION_ENTRY' && currentPrice < struct.softPivot) {
    code = 'DROP_EASING_CHECK';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΦΡΕΝΑΡΙΣΜΑ ΠΤΩΣΗΣ';
    msg = `Οι πωλητές μαλακώνουν κοντά στο ${swingMap.lowTrend} ($${fmtPrice(swingMap.lastLow)}), όμως η τιμή είναι ακόμα κάτω από το S-Pivot ($${fmtPrice(struct.softPivot)}) και το H-Pivot στα $${fmtPrice(struct.hardPivot)}. Έλεγχος επιβεβαίωσης αντί για βιασύνη.`;
  }
  // 7) Extreme Hyperliquid funding skew aligned with momentum shift
  else if (hlData && Math.abs(hlData.annualizedPct) >= 25 && Math.abs(dF1h) >= 1200000) {
    const dirSide = hlData.fundingHourly < 0 ? 'SHORTS' : 'LONGS';
    code = `HL_SKEW_${dirSide}`;
    title = `ΣΥΜΒΟΥΛΟΣ · ΠΙΕΣΗ ${dirSide} ΣΤΟ HL`;
    msg = `Στο Hyperliquid το funding είναι έντονο (${hlData.annualizedPct.toFixed(1)}% ετησιοποιημένο · OI ${fmtUsd(hlData.oiUsd)}) ενώ η 1h ροή κινείται απότομα (${fmtUsd(dF1h)}). Υψηλή πιθανότητα νευρικής εκκαθάρισης/squeeze.`;
  }

  if (!code) return null;

  const nowMs = Date.now();
  const signature = `${code}|${Math.round(currentPrice / 50)}|${Math.round(diag.totalScore / 10)}`;
  const elapsedMs = nowMs - state.lastAdvisorTs;

  if (signature === state.lastAdvisorSignature && elapsedMs < 90000) {
    return null;
  }
  if (elapsedMs < 25000) {
    return null;
  }

  state.lastAdvisorSignature = signature;
  state.lastAdvisorTs = nowMs;
  return { code, title, msg };
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

function computeWeightedDiagnosis(struct, snapNow, m5Snap, swingAnchor, swingMap, rollingStats, currentPrice) {
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
  const rollingBonus = rollingStats.hasHistory
    ? Math.max(-12, Math.min(12, (rollingStats.f15PerMin / 400000) * (rollingStats.consistencyPct / 100) * 10))
    : 0;
  const moveNorm = Math.max(6000000, Math.abs(fSw) * 0.9 + Math.abs(w5Fut) * 4);
  const flowComponent = ((w5Fut * 1.5 + w5Spot * 2.2 + fSw * 0.65 + sSw * 1.2 + f15 * 0.45 + s15 * 0.8) / moveNorm) * 70;
  const mapScore = Math.max(-100, Math.min(100, flowComponent + swingMap.mapScoreBias + rollingBonus));

  const totalScore = Math.round(structScore * 0.35 + macroScore * 0.30 + mapScore * 0.35);

  const reasons = [
    `Φακός ${swingMap.windowBars}×15m (${swingMap.modeLabel}): ${swingMap.lowTrend} $${fmtPrice(swingMap.lastLow)} ↔ ${swingMap.highTrend} $${fmtPrice(swingMap.lastHigh)} (${Math.round(swingMap.posInCorridor * 100)}%)`,
    `Από ${swingAnchor.type === 'LOW' ? 'χαμηλό' : 'υψηλό'} $${fmtPrice(swingAnchor.price)}: Perp ${fmtUsd(fSw)} / Spot ${fmtUsd(sSw)} · 5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}] · ${rollingStats.label}`,
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

  const shortMag = Math.abs(f15) + Math.abs(f1h) + Math.abs(s1h) * 1.5 + Math.abs(dF1h);
  const macroMag = Math.abs(f4h) + Math.abs(f1d) * 0.35 + Math.abs(s4h) * 1.5 + Math.abs(s1d) * 0.4;

  const shortImpulseStrong = shortMag > macroMag * 0.42 || Math.abs(dF15) > 1200000 || fut4hVol < fut1hVol * 2.2;
  const wShort = shortImpulseStrong ? 1.5 : 0.75;
  const wMacro = shortImpulseStrong ? 0.65 : 1.25;
  const activeTfLabel = shortImpulseStrong ? '15m/1h Ροή' : '4h/1D Δομή';

  let bullTilt = 1.0;
  let bearTilt = 1.0;
  let hlPain = 'Ουδέτερο funding (χωρίς ακραίο πόνο)';

  if (hlData) {
    const ann = hlData.annualizedPct;
    document.getElementById('hlFundingBadge').textContent =
      `HL: ${(hlData.fundingHourly * 100).toFixed(4)}%/h (${ann.toFixed(1)}%)`;

    if (hlData.fundingHourly < -0.00005) {
      hlPain = `Πιέζονται SHORTS (funding αρνητικό · HL OI ${fmtUsd(hlData.oiUsd)})`;
      bullTilt = 1.15;
      bearTilt = 0.90;
    } else if (hlData.fundingHourly > 0.00015) {
      hlPain = `Πιέζονται LONGS (funding θετικό · HL OI ${fmtUsd(hlData.oiUsd)})`;
      bearTilt = 1.15;
      bullTilt = 0.90;
    } else {
      hlPain = `Ισορροπημένο funding · HL OI: ${fmtUsd(hlData.oiUsd)} · [${activeVenues.join('+')}]`;
    }
  } else {
    document.getElementById('hlFundingBadge').textContent = `Venues: ${activeVenues.join('+')}`;
    hlPain = `Ενεργές πηγές: ${activeVenues.join(' + ')} (HL εκτός)`;
  }

  const rawBull = (
    (Math.max(0, f15) + Math.max(0, f1h) + Math.max(0, s1h) * 1.5 + Math.max(0, dF15)) * wShort +
    (Math.max(0, f4h) + Math.max(0, f1d) * 0.35 + Math.max(0, s4h) * 1.5) * wMacro
  ) * bullTilt;

  const rawBear = (
    (Math.max(0, -f15) + Math.max(0, -f1h) + Math.max(0, -s1h) * 1.5 + Math.max(0, -dF15)) * wShort +
    (Math.max(0, -f4h) + Math.max(0, -f1d) * 0.35 + Math.max(0, -s4h) * 1.5) * wMacro
  ) * bearTilt;

  const floorBase = Math.max(250000, (fut1hVol + fut4hVol) * 0.0015);
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
  let resumeNote = '';

  if (sym !== state.symbol || state.lastCycleTs === 0) {
    state.symbol = sym;
    const { restored, gapSec } = loadSymbolMemory(sym);
    if (restored && gapSec >= 90) {
      const gapMin = Math.round(gapSec / 60);
      resumeNote = ` · Επαναφορά μνήμης (κενό ${gapMin}λ)`;
    }
  } else if (state.lastCycleTs > 0) {
    const gapSec = Math.round((Date.now() - state.lastCycleTs) / 1000);
    if (gapSec >= 120) {
      resumeNote = ` · Επιστροφή από background (${Math.round(gapSec / 60)}λ)`;
    }
  }

  const baseCoin = sym.replace('USDT', '');
  const nowTs = Date.now();

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
    const swingKey = `${swingAnchor.type}_${Math.round(swingAnchor.price)}_${anchorTs || 0}`;

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
          if (k === 'SWING' && prevV.swingKey !== swingKey) {
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

    // Preserve previous completed swing leg when anchor shifts
    if (state.activeSwingMeta && state.activeSwingMeta.key !== swingKey && state.prevCvdSnap?.['SWING']) {
      state.prevSwingLeg = {
        key: state.activeSwingMeta.key,
        type: state.activeSwingMeta.type,
        price: state.activeSwingMeta.price,
        fut: state.prevCvdSnap['SWING'].fut,
        spot: state.prevCvdSnap['SWING'].spot,
        endedAt: nowTs
      };
    }
    state.activeSwingMeta = {
      key: swingKey,
      type: swingAnchor.type,
      price: swingAnchor.price,
      startTs: anchorTs
    };

    // Record sample into rolling history and compute time-normalized velocity
    recordCvdSample(nowTs, currentPrice, m5Snap, snapNow, swingKey);
    const rollingStats = computeRollingFlowStats(swingKey);

    venues.forEach(v => {
      state.perVenuePrev[v.code] = { ...v.snap, swingKey, ts: nowTs };
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
      } else if (key === '15m' && rollingStats.hasHistory) {
        if (rollingStats.f15PerMin > 180000 && rollingStats.consistencyPct >= 60) {
          pace = `${fmtUsd(rollingStats.f15PerMin)}/λ ↑`;
          paceCls = 'pos';
        } else if (rollingStats.f15PerMin < -180000 && rollingStats.consistencyPct >= 60) {
          pace = `${fmtUsd(rollingStats.f15PerMin)}/λ ↓`;
          paceCls = 'neg';
        } else {
          pace = `${fmtUsd(rollingStats.f15PerMin)}/λ`;
        }
      } else if (key === 'SWING' && rollingStats.hasHistory) {
        pace = `${fmtUsd(rollingStats.fSwPerMin)}/λ`;
        paceCls = rollingStats.fSwPerMin >= 0 ? 'pos' : 'neg';
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
      `Snapshot: ${new Date().toLocaleTimeString('el-GR')} · [${activeCodes.join('+')}]${resumeNote}`;

    const struct = computeDynamicStructure(fut15, currentPrice, snapNow['1h'].fut, swingPrecomp.cfg.windowBars);
    const swingMap = analyzeAdaptiveSwingMap(
      fut15, currentPrice, snapNow, m5Snap, deltaNow, hlData, rollingStats, swingPrecomp
    );
    drawChart(fut15, struct, swingMap);

    document.getElementById('softPivotVal').textContent = `$${fmtPrice(struct.softPivot)}`;
    document.getElementById('hardPivotVal').textContent = `$${fmtPrice(struct.hardPivot)}`;
    document.getElementById('targetPoolVal').textContent = `$${fmtPrice(struct.supplyBottom)} – $${fmtPrice(struct.supplyTop)}`;
    const prevLegTxt = state.prevSwingLeg
      ? ` · Προηγ. SWG: ${fmtUsd(state.prevSwingLeg.fut)}`
      : '';
    document.getElementById('sweepBreakVal').textContent =
      `${struct.zoneBehavior} · Φακός ${swingMap.windowBars}×15m (${swingMap.modeLabel})${prevLegTxt}`;
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

    const diag = computeWeightedDiagnosis(
      struct, snapNow, m5Snap, swingAnchor, swingMap, rollingStats, currentPrice
    );
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

    const advisorNote = evaluateAutonomousAdvisor({
      currentPrice,
      struct,
      swingMap,
      diag,
      snapNow,
      m5Snap,
      deltaNow,
      hlData,
      rollingStats,
      prevSwingLeg: state.prevSwingLeg
    });

    if (advisorNote) {
      detail = `${detail} | [Σύμβουλος: ${advisorNote.msg}]`;
      pushEvent(advisorNote.title, advisorNote.msg);
    }

    document.getElementById('pillFlow').textContent =
      `5m: ${fmtUsd(m5Snap.fut)} (${m5Snap.qualityTag}) | ${rollingStats.label}`;
    document.getElementById('pillSync').textContent = syncLabel;
    document.getElementById('pillPivot').textContent =
      `S-Pivot $${fmtPrice(struct.softPivot)} · H-Pivot $${fmtPrice(struct.hardPivot)}`;

    const signature = `${regime}|${swingMap.windowBars}|${m5Snap.qualityTag}|${Math.round(swingMap.lastLow)}|${Math.round(swingMap.lastHigh)}|${Math.round(diag.totalScore / 10)}|${advisorNote?.code || ''}`;
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
    state.lastCycleTs = nowTs;
    saveSymbolMemory(sym);

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

// Immediately refresh when returning from mobile background
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    runCycle();
  }
});

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
      { hasHistory: false, label: 'Αναμονή' },
      pre
    );
    drawChart(state.klines15m, s, sm);
  }
});

runCycle();
