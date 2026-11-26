const STORAGE_PREFIX = 'cross_radar_v3_';

const state = {
  symbol: 'BTCUSDT',
  pollOverride: 'AUTO', // AUTO | TURBO | MOD
  currentIntervalMs: 45000,
  timerId: null,
  lastPrice: null,
  prevPrice: null,
  klines15m: [],
  prevCvdSnap: null,
  perVenuePrev: {}, // { BN: snap, BB: snap, OKX: snap, CB: snap }
  prevOiTotal: null,
  oiHistory: [],    // [{ ts, price, oiUsd }]
  cvdHistory: [],   // Rolling samples: [{ ts, price, m5Fut, m5Spot, f15, s15, f1h, s1h, f4h, s4h, fSw, sSw, takerBuyPct, sfState, f15PerMin, swingKey }]
  prevSwingLeg: null, // Last completed swing leg before current anchor
  activeSwingMeta: null, // { key, type, price, startTs }
  shadowState: {
    activeSweep: null, // { side: 'LOW'|'HIGH', level, extremePrice, startedAt, cycles }
    lastReclaimTs: 0,
    lastShadowSignalKey: '',
    lastShadowSignalTs: 0
  },
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
    : (p >= 1 ? p.toFixed(3) : p.toFixed(5));
};

// --- 1. Session & Weekend / Thin-Book Context Detector ---
function getMarketSessionContext(nowTs = Date.now()) {
  const d = new Date(nowTs);
  const utcDay = d.getUTCDay(); // 0 = Sun, 6 = Sat
  const utcHour = d.getUTCHours() + d.getUTCMinutes() / 60;

  // Weekend thin liquidity window (Fri 21:30 UTC -> Sun 22:00 UTC)
  const isWeekend =
    utcDay === 6 ||
    (utcDay === 5 && utcHour >= 21.5) ||
    (utcDay === 0 && utcHour < 22.0);

  if (isWeekend) {
    return {
      code: 'WEEKEND_THIN',
      label: 'ΣΚ · Λεπτό Βιβλίο',
      cbBaseWeight: 0.55,
      flowScale: 0.55,
      wickSensitivity: 1.35
    };
  }

  // US Cash / ETF Active Hours (14:30 - 21:00 UTC => 16:30 - 23:00 EET)
  if (utcHour >= 14.5 && utcHour < 21.0) {
    return {
      code: 'US_CASH',
      label: 'US Session (ETFs)',
      cbBaseWeight: 1.40,
      flowScale: 1.15,
      wickSensitivity: 1.0
    };
  }

  // EU Session & Pre-US (07:00 - 14:30 UTC => 09:00 - 16:30 EET)
  if (utcHour >= 7.0 && utcHour < 14.5) {
    return {
      code: 'EU_SESSION',
      label: 'EU Session',
      cbBaseWeight: 0.90,
      flowScale: 0.90,
      wickSensitivity: 1.1
    };
  }

  // Asia / Overnight (21:00 - 07:00 UTC)
  return {
    code: 'ASIA_SESSION',
    label: 'Asia Session',
    cbBaseWeight: 0.70,
    flowScale: 0.75,
    wickSensitivity: 1.2
  };
}

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
      prevOiTotal: state.prevOiTotal,
      oiHistory: state.oiHistory.slice(-24),
      cvdHistory: state.cvdHistory.slice(-24),
      prevSwingLeg: state.prevSwingLeg,
      activeSwingMeta: state.activeSwingMeta,
      shadowState: state.shadowState,
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
  state.prevOiTotal = null;
  state.oiHistory = [];
  state.cvdHistory = [];
  state.prevSwingLeg = null;
  state.activeSwingMeta = null;
  state.shadowState = {
    activeSweep: null,
    lastReclaimTs: 0,
    lastShadowSignalKey: '',
    lastShadowSignalTs: 0
  };
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
    state.prevOiTotal = data.prevOiTotal ?? null;
    state.oiHistory = Array.isArray(data.oiHistory)
      ? data.oiHistory.filter(item => item && (now - item.ts) <= 4 * 3600 * 1000)
      : [];
    state.cvdHistory = Array.isArray(data.cvdHistory)
      ? data.cvdHistory.filter(item => item && (now - item.ts) <= 2 * 3600 * 1000)
      : [];
    state.prevSwingLeg = data.prevSwingLeg ?? null;
    state.activeSwingMeta = data.activeSwingMeta ?? null;
    if (data.shadowState) {
      state.shadowState = {
        activeSweep: data.shadowState.activeSweep ?? null,
        lastReclaimTs: data.shadowState.lastReclaimTs ?? 0,
        lastShadowSignalKey: data.shadowState.lastShadowSignalKey ?? '',
        lastShadowSignalTs: data.shadowState.lastShadowSignalTs ?? 0
      };
    }
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

// --- 2. Open Interest & Liquidation Cluster Estimator (Binance + Bybit) ---
async function fetchDerivativeFuel(sym, currentPrice) {
  try {
    const [bnOiRes, bnFundRes, bbTickerRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`),
      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`),
      fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${sym}`)
    ]);

    const [bnOiJson, bnFundJson, bbTickerJson] = await Promise.all([
      bnOiRes.json(),
      bnFundRes.json(),
      bbTickerRes.json()
    ]);

    const bnOiCoins = parseFloat(bnOiJson?.openInterest || 0);
    const bnOiUsd = bnOiCoins * currentPrice;
    const bnFunding = parseFloat(bnFundJson?.lastFundingRate || 0);

    const bbItem = bbTickerJson?.result?.list?.[0] || {};
    const bbOiUsd = parseFloat(bbItem.openInterestValue || 0);
    const bbFunding = parseFloat(bbItem.fundingRate || 0);

    const totalOiUsd = bnOiUsd + bbOiUsd;
    const avgFunding8h = (bnFunding && bbFunding)
      ? (bnFunding + bbFunding) / 2
      : (bnFunding || bbFunding || 0);

    return {
      totalOiUsd,
      bnOiUsd,
      bbOiUsd,
      avgFunding8h,
      annualizedFundingPct: avgFunding8h * 3 * 365 * 100
    };
  } catch (e) {
    return null;
  }
}

function estimateLiquidationClusters(nowTs, currentPrice, klines15m, derivFuel, hlData) {
  if (derivFuel && derivFuel.totalOiUsd > 0) {
    state.oiHistory.push({ ts: nowTs, price: currentPrice, oiUsd: derivFuel.totalOiUsd });
    if (state.oiHistory.length > 24) state.oiHistory.shift();
  }

  let oiDeltaUsd = 0;
  let oiChangePct = 0;
  if (state.oiHistory.length >= 2) {
    const oldest = state.oiHistory[0];
    oiDeltaUsd = derivFuel ? (derivFuel.totalOiUsd - oldest.oiUsd) : 0;
    oiChangePct = oldest.oiUsd > 0 ? (oiDeltaUsd / oldest.oiUsd) * 100 : 0;
  }

  const recent = klines15m.slice(-24);
  let maxVolBar = recent[recent.length - 1];
  let maxQuoteVol = 0;
  for (const k of recent) {
    const qv = parseFloat(k[7]) || 0;
    if (qv > maxQuoteVol) {
      maxQuoteVol = qv;
      maxVolBar = k;
    }
  }
  const anchorMid = maxVolBar
    ? ((parseFloat(maxVolBar[1]) + parseFloat(maxVolBar[4])) / 2)
    : currentPrice;

  const funding8h = derivFuel?.avgFunding8h ?? (hlData ? hlData.fundingHourly * 8 : 0);
  const longCrowded = funding8h > 0.00012;
  const shortCrowded = funding8h < -0.00005;

  const longLiq100x = anchorMid * (1 - 0.009);
  const longLiq50x  = anchorMid * (1 - 0.0185);
  const longLiq25x  = anchorMid * (1 - 0.037);

  const shortLiq100x = anchorMid * (1 + 0.009);
  const shortLiq50x  = anchorMid * (1 + 0.0185);
  const shortLiq25x  = anchorMid * (1 + 0.037);

  let biasSide = 'BALANCED';
  let magnetSummary = `Liq 50x: ↓$${fmtPrice(longLiq50x)} | ↑$${fmtPrice(shortLiq50x)}`;

  if (longCrowded && oiDeltaUsd >= 0) {
    biasSide = 'LONG_HEAVY';
    magnetSummary = `Longs φορτωμένοι (Fund +${(funding8h * 100).toFixed(3)}%) · Κάτω Pools: $${fmtPrice(longLiq100x)} (100x) / $${fmtPrice(longLiq50x)} (50x)`;
  } else if (shortCrowded && oiDeltaUsd >= 0) {
    biasSide = 'SHORT_HEAVY';
    magnetSummary = `Shorts φορτωμένοι (Fund ${(funding8h * 100).toFixed(3)}%) · Πάνω Pools: $${fmtPrice(shortLiq100x)} (100x) / $${fmtPrice(shortLiq50x)} (50x)`;
  } else if (oiDeltaUsd < 0) {
    biasSide = 'DELEVERAGING';
    magnetSummary = `Κλείσιμο OI (${fmtUsd(oiDeltaUsd)}) · Εκκαθάριση θέσεων σε εξέλιξη`;
  }

  return {
    totalOiUsd: derivFuel?.totalOiUsd ?? 0,
    oiDeltaUsd,
    oiChangePct,
    funding8h,
    longCrowded,
    shortCrowded,
    biasSide,
    longLiq100x,
    longLiq50x,
    longLiq25x,
    shortLiq100x,
    shortLiq50x,
    shortLiq25x,
    magnetSummary
  };
}

// --- 3. Spot vs. Futures Alignment with Dynamic Coinbase Weight & Session Scaling ---
function computeSpotFuturesAlignment(snapNow, m5Snap, venueFlowStats, klines15m, sessionCtx, liqInfo) {
  const sc = sessionCtx.flowScale;
  const f15 = snapNow['15m'].fut;
  const s15 = snapNow['15m'].spot;
  const f1h = snapNow['1h'].fut;
  const s1h = snapNow['1h'].spot;
  const f4h = snapNow['4h'].fut;
  const s4h = snapNow['4h'].spot;
  const fSw = snapNow['SWING'].fut;
  const sSw = snapNow['SWING'].spot;

  let spotBuySum = 0;
  let spotVolSum = 0;
  let totalBuySum = 0;
  let totalVolSum = 0;

  (venueFlowStats || []).forEach(v => {
    if (!v) return;
    if (v.spotVol1h > 0 && v.spotBuy1h !== undefined) {
      const w = v.code === 'CB' ? (v.cbDynamicWeight || 1) : 1;
      spotBuySum += v.spotBuy1h * w;
      spotVolSum += v.spotVol1h * w;
    }
    if (v.vol1h > 0 && v.buy1h !== undefined) {
      totalBuySum += v.buy1h;
      totalVolSum += v.vol1h;
    }
  });

  const takerBuyPct = totalVolSum > 0
    ? Math.max(0, Math.min(100, (totalBuySum / totalVolSum) * 100))
    : 50.0;
  const spotBuyPct = spotVolSum > 0
    ? Math.max(0, Math.min(100, (spotBuySum / spotVolSum) * 100))
    : takerBuyPct;

  const lastBar = Array.isArray(klines15m) && klines15m.length ? klines15m[klines15m.length - 1] : null;
  let upperWickRejection = false;
  let lowerWickRejection = false;
  if (lastBar) {
    const o = parseFloat(lastBar[1]) || 0;
    const h = parseFloat(lastBar[2]) || 0;
    const l = parseFloat(lastBar[3]) || 0;
    const c = parseFloat(lastBar[4]) || 0;
    const range = Math.max(h - l, o * 0.0005);
    const upperWick = h - Math.max(o, c);
    const lowerWick = Math.min(o, c) - l;
    upperWickRejection = (upperWick / range) >= 0.45 && c < h * 0.9988;
    lowerWickRejection = (lowerWick / range) >= 0.45 && c > l * 1.0012;
  }

  const cbStats = venueFlowStats?.find(v => v.code === 'CB') || null;
  const cbSpot1h = cbStats?.spot1h ?? null;
  const cbSpot15m = cbStats?.spot15m ?? null;
  const cbRelVol = cbStats?.relVol ?? 1;
  const cbActive = cbStats !== null && cbRelVol >= 0.75;

  const futUp = (f1h > 250000 * sc) || (f15 > 200000 * sc && m5Snap.fut > 150000 * sc);
  const futDown = (f1h < -250000 * sc) || (f15 < -200000 * sc && m5Snap.fut < -150000 * sc);
  const spotUp = (s1h > 150000 * sc) || (s15 > 100000 * sc && m5Snap.spot > 80000 * sc);
  const spotDown = (s1h < -150000 * sc) || (s15 < -100000 * sc && m5Snap.spot < -80000 * sc);

  const cbSellingIntoPump = cbActive && futUp && cbSpot1h !== null && cbSpot1h < -120000 * sc;
  const cbBuyingIntoDump = cbActive && futDown && cbSpot1h !== null && cbSpot1h > 120000 * sc;

  let code = 'MIXED';
  let label = 'Μεικτή Ροή';
  let shortDesc = 'Χωρίς καθαρή συμφωνία Spot & Futures';
  let isValidBullFlow = false;
  let isLeverageTrap = false;

  if (futDown && spotDown) {
    code = 'BOTH_SELLING';
    label = 'Both Selling';
    shortDesc = 'Και Futures και Spot πουλάνε — καθαρή προσφορά';
  } else if (cbBuyingIntoDump || (futDown && spotUp)) {
    code = 'SPOT_ABSORPTION';
    label = cbBuyingIntoDump ? 'CB Spot Absorption' : 'Spot Absorption';
    shortDesc = cbBuyingIntoDump
      ? `Πίεση στα Perps αλλά η Coinbase απορροφά (${fmtUsd(cbSpot1h)}, vol ×${cbRelVol.toFixed(1)})`
      : 'Πίεση στα Futures αλλά το Spot απορροφά';
  } else if (futUp && spotUp && !cbSellingIntoPump && spotBuyPct >= 49.5) {
    code = 'BOTH_BUYING';
    label = 'Both Buying';
    shortDesc = 'Συμφωνία Futures & Spot προς τα πάνω με στήριξη αγοράς';
    isValidBullFlow = true;
  } else if (futUp && (!spotUp || spotDown || cbSellingIntoPump || spotBuyPct < 49.5 || liqInfo?.longCrowded)) {
    code = 'PERP_DIVERGENCE';
    label = cbSellingIntoPump ? 'Perp Pump vs CB Sell' : 'Perp Squeeze / Divergence';
    shortDesc = cbSellingIntoPump
      ? `Άνοδος στα Perps ενώ η Coinbase πουλάει (${fmtUsd(cbSpot1h)})`
      : 'Άνοδος σε μόχλευση χωρίς καθαρή στήριξη Spot';
    isLeverageTrap = true;
  }

  return {
    code,
    label,
    shortDesc,
    takerBuyPct,
    spotBuyPct,
    combined15m: f15 + s15,
    combined1h: f1h + s1h,
    combined4h: f4h + s4h,
    combinedSwing: fSw + sSw,
    upperWickRejection,
    lowerWickRejection,
    cbSpot15m,
    cbSpot1h,
    cbRelVol,
    cbActive,
    isValidBullFlow,
    isLeverageTrap
  };
}

// --- Rolling CVD Velocity, Acceleration & Consistency Calculator ---
function recordCvdSample(nowTs, currentPrice, m5Snap, snapNow, swingKey, f15PerMin = 0, takerBuyPct = 50, sfState = 'MIXED') {
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
    takerBuyPct,
    sfState,
    f15PerMin,
    swingKey
  });
  if (state.cvdHistory.length > 24) {
    state.cvdHistory.shift();
  }
}

function computeRollingFlowStats(currentSwingKey, sessionCtx) {
  const sc = sessionCtx.flowScale;
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
      accelPerMin2: 0,
      deceleratingDown: false,
      consistencyPct: 50,
      spotLeading: false,
      perpOnlyPush: false,
      label: 'Αρχικοποίηση μνήμης'
    };
  }

  const latest = hist[hist.length - 1];
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

  const prevSample = hist[hist.length - 2];
  const prevDtMin = Math.max(0.08, (latest.ts - prevSample.ts) / 60000);
  const instRateNow = (latest.f15 - prevSample.f15) / prevDtMin;
  const instRatePrev = typeof prevSample.f15PerMin === 'number' && prevSample.f15PerMin !== 0
    ? prevSample.f15PerMin
    : f15PerMin;
  const accelPerMin2 = (instRateNow - instRatePrev) / prevDtMin;
  const deceleratingDown = f15PerMin < 0 && (accelPerMin2 > 120000 * sc || instRateNow > f15PerMin * 0.45);

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

  const windowSlice = hist.slice(baseIdx);
  let posSteps = 0;
  let negSteps = 0;
  for (let i = 1; i < windowSlice.length; i++) {
    const stepDiff = windowSlice[i].f15 - windowSlice[i - 1].f15;
    if (stepDiff > 25000 * sc) posSteps++;
    else if (stepDiff < -25000 * sc) negSteps++;
  }
  const activeSteps = posSteps + negSteps;
  const dominantSteps = Math.max(posSteps, negSteps);
  const consistencyPct = activeSteps > 0 ? Math.round((dominantSteps / activeSteps) * 100) : 50;

  const spotLeading =
    (s15PerMin > 80000 * sc && s15PerMin >= f15PerMin * 0.45) ||
    (s15PerMin < -80000 * sc && s15PerMin <= f15PerMin * 0.45);
  const perpOnlyPush =
    Math.abs(f15PerMin) > 250000 * sc &&
    Math.sign(f15PerMin) !== Math.sign(s15PerMin) &&
    Math.abs(s15PerMin) > 50000 * sc;

  let label = `Ρυθμός ${elapsedMin.toFixed(1)}λ: ${fmtUsd(f15PerMin)}/λ (${consistencyPct}% σταθ.)`;
  if (deceleratingDown) label += ' · Φρενάρει πτώση';
  else if (spotLeading) label += ' · Spot οδηγεί';
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
    accelPerMin2,
    deceleratingDown,
    consistencyPct,
    spotLeading,
    perpOnlyPush,
    label
  };
}

// --- Algo Shadow Detector: Sweep, Reclaim, Trap & Velocity Reversal ---
function evaluateAlgoShadowMechanics(nowTs, klines15m, currentPrice, struct, swingMap, m5Snap, rollingStats, hlData, sfAlign = null, sessionCtx = null) {
  const sc = sessionCtx?.flowScale ?? 1;
  const lastBar = klines15m[klines15m.length - 1] || [];
  const barLow = parseFloat(lastBar[3]) || currentPrice;
  const barHigh = parseFloat(lastBar[2]) || currentPrice;
  const barClose = parseFloat(lastBar[4]) || currentPrice;

  const lowerSweepRef = Math.min(swingMap.lastLow, struct.hardPivot);
  const upperSweepRef = Math.max(swingMap.lastHigh, struct.supplyBottom);
  const sweepTol = currentPrice * 0.0005;
  const priceBucket = Math.max(currentPrice * 0.0008, 0.0001);

  const sh = state.shadowState;
  let shadowTag = 'SHADOW: SCANNING';
  let shadowAlert = null;
  let scoreAdj = 0;

  const emitShadowSignal = (key, title, body, cooldownMs = 45000) => {
    if (sh.lastShadowSignalKey === key && (nowTs - sh.lastShadowSignalTs) < cooldownMs) return;
    sh.lastShadowSignalKey = key;
    sh.lastShadowSignalTs = nowTs;
    shadowAlert = { title, body };
    pushEvent(title, body);
  };

  if (!sh.activeSweep) {
    if (barLow < lowerSweepRef - sweepTol || currentPrice < lowerSweepRef) {
      const ext = Math.min(barLow, currentPrice);
      sh.activeSweep = {
        side: 'LOW',
        level: lowerSweepRef,
        extremePrice: ext,
        startedAt: nowTs,
        cycles: 1
      };
      shadowTag = `SWEEP LOW ($${fmtPrice(ext)})`;
      emitShadowSignal(
        `SWEEP_LOW_${Math.round(lowerSweepRef / priceBucket)}`,
        'SHADOW · LIQUIDITY SWEEP ΚΑΤΩ',
        `Χτύπησε κάτω από $${fmtPrice(lowerSweepRef)} (χαμηλό $${fmtPrice(ext)}). Έλεγχος αν θα βγάλει ουρά/reclaim ή θα κλείσει κάτω χωρίς στήριξη.`
      );
    } else if (barHigh > upperSweepRef + sweepTol || currentPrice > upperSweepRef) {
      const ext = Math.max(barHigh, currentPrice);
      sh.activeSweep = {
        side: 'HIGH',
        level: upperSweepRef,
        extremePrice: ext,
        startedAt: nowTs,
        cycles: 1
      };
      shadowTag = `SWEEP HIGH ($${fmtPrice(ext)})`;
      emitShadowSignal(
        `SWEEP_HIGH_${Math.round(upperSweepRef / priceBucket)}`,
        'SHADOW · LIQUIDITY SWEEP ΠΑΝΩ',
        `Τρύπησε πάνω από $${fmtPrice(upperSweepRef)} (κορυφή $${fmtPrice(ext)}). Προσοχή σε fakeout/sweep πριν από pullback.`
      );
    }
  } else {
    sh.activeSweep.cycles += 1;
    const sw = sh.activeSweep;

    if (sw.side === 'LOW') {
      if (Math.min(barLow, currentPrice) < sw.extremePrice) {
        sw.extremePrice = Math.min(barLow, currentPrice);
      }

      const flowTurningBull = m5Snap.fut > 0 || m5Snap.isAbsorption || rollingStats.deceleratingDown || rollingStats.f15PerMin > 100000 * sc;
      const spotSupportsReclaim = !sfAlign || sfAlign.code === 'SPOT_ABSORPTION' || sfAlign.code === 'BOTH_BUYING' || sfAlign.spotBuyPct >= 49.5;

      if (currentPrice >= sw.level && barClose >= sw.level) {
        sh.activeSweep = null;
        sh.lastReclaimTs = nowTs;
        const confirmedReclaim = flowTurningBull && spotSupportsReclaim;
        shadowTag = confirmedReclaim ? 'SWEEP & RECLAIM (LONG WATCH)' : 'RECLAIMED (CHECK FLOW)';
        scoreAdj = confirmedReclaim ? 18 : 6;
        emitShadowSignal(
          `RECLAIM_LOW_${Math.round(sw.level / priceBucket)}`,
          'SHADOW · SWEEP & RECLAIM CONFIRMED',
          `Ανάκτηση πάνω από $${fmtPrice(sw.level)} μετά από sweep στα $${fmtPrice(sw.extremePrice)} (${sw.cycles} κύκλοι) · ${sfAlign?.label || ''} · ${rollingStats.label}.`,
          60000
        );
      } else if (sw.cycles >= 6 && rollingStats.f15PerMin < -250000 * sc && !flowTurningBull) {
        shadowTag = 'UNRECLAIMED BREAKDOWN RISK';
        scoreAdj = -12;
      } else {
        shadowTag = `IN SWEEP LOW ($${fmtPrice(sw.extremePrice)})`;
      }
    } else if (sw.side === 'HIGH') {
      if (Math.max(barHigh, currentPrice) > sw.extremePrice) {
        sw.extremePrice = Math.max(barHigh, currentPrice);
      }

      const flowTurningBear = m5Snap.fut < 0 || rollingStats.f15PerMin < -150000 * sc || Boolean(sfAlign?.upperWickRejection);
      if (currentPrice < sw.level && barClose < sw.level) {
        sh.activeSweep = null;
        sh.lastReclaimTs = nowTs;
        shadowTag = flowTurningBear ? 'SWEEP & REJECT (FADE WATCH)' : 'REJECTED BACK INSIDE';
        scoreAdj = flowTurningBear ? -16 : -6;
        emitShadowSignal(
          `REJECT_HIGH_${Math.round(sw.level / priceBucket)}`,
          'SHADOW · SWEEP & REJECTION',
          `Επιστροφή κάτω από $${fmtPrice(sw.level)} μετά από sweep στα $${fmtPrice(sw.extremePrice)} · ${sfAlign?.label || ''} · ${rollingStats.label}.`,
          60000
        );
      } else {
        shadowTag = `IN SWEEP HIGH ($${fmtPrice(sw.extremePrice)})`;
      }
    }
  }

  if (!sh.activeSweep && sh.lastReclaimTs && (nowTs - sh.lastReclaimTs) < 180000 && !sfAlign?.isLeverageTrap) {
    shadowTag = 'POST-RECLAIM MOMENTUM';
    scoreAdj += 8;
  }

  return {
    shadowTag,
    shadowAlert,
    scoreAdj,
    activeSweep: sh.activeSweep
  };
}

// Binance exact taker buy/sell quote delta over last `bars` or from `startIndex`
function calcBinanceCvdFromKlines(klines, bars, startIndex = null) {
  if (!Array.isArray(klines) || !klines.length) return { delta: 0, totalVol: 0, buyVol: 0, count: 0 };
  const slice = startIndex !== null
    ? klines.slice(Math.max(0, startIndex))
    : klines.slice(-bars);
  let delta = 0;
  let totalVol = 0;
  let buyVol = 0;
  for (const k of slice) {
    const quoteVol = parseFloat(k[7]) || 0;
    const takerBuyQuote = parseFloat(k[10]) || 0;
    const takerSellQuote = quoteVol - takerBuyQuote;
    delta += (takerBuyQuote - takerSellQuote);
    totalVol += quoteVol;
    buyVol += takerBuyQuote;
  }
  return { delta, totalVol, buyVol, count: slice.length };
}

// Analyze 5m candle weight (volume vs 1h average) & absorption (heavy flow with minimal price move)
function analyze5mFlowQuality(fut5m, spot5m, sessionCtx) {
  const sc = sessionCtx.flowScale;
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

  const heavyFlow = volRatio >= 1.4 && Math.abs(futDelta) >= 400000 * sc;
  const isAbsorption = Math.abs(futDelta) >= 600000 * sc && movePct < 0.08;

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
  let buyVol = 0;
  for (const k of slice) {
    const o = parseFloat(k[1]);
    const h = parseFloat(k[2]);
    const l = parseFloat(k[3]);
    const c = parseFloat(k[4]);
    const turnover = parseFloat(k[6]) || 0;
    const range = Math.max(h - l, o * 0.0002);
    const bodyRatio = Math.max(-1, Math.min(1, (c - o) / range));
    const d = turnover * bodyRatio * 0.35;
    delta += d;
    totalVol += turnover;
    buyVol += turnover * (0.5 + bodyRatio * 0.175);
  }
  return { delta, totalVol, buyVol, count: slice.length };
}

function calcOkxFlowFromKlines(list, bars, startIndex = null) {
  if (!Array.isArray(list) || !list.length) return null;
  const slice = startIndex !== null
    ? list.slice(Math.max(0, startIndex))
    : list.slice(-bars);
  let delta = 0;
  let totalVol = 0;
  let buyVol = 0;
  for (const k of slice) {
    const o = parseFloat(k[1]);
    const h = parseFloat(k[2]);
    const l = parseFloat(k[3]);
    const c = parseFloat(k[4]);
    const quoteVol = parseFloat(k[7]) || 0;
    const range = Math.max(h - l, o * 0.0002);
    const bodyRatio = Math.max(-1, Math.min(1, (c - o) / range));
    const d = quoteVol * bodyRatio * 0.35;
    delta += d;
    totalVol += quoteVol;
    buyVol += quoteVol * (0.5 + bodyRatio * 0.175);
  }
  return { delta, totalVol, buyVol, count: slice.length };
}

// Coinbase Spot klines: [time, low, high, open, close, baseVolume]
function calcCoinbaseSpotFlowFromKlines(list, bars, startIndex = null) {
  if (!Array.isArray(list) || !list.length) return null;
  const slice = startIndex !== null
    ? list.slice(Math.max(0, startIndex))
    : list.slice(-bars);
  let delta = 0;
  let totalVol = 0;
  let buyVol = 0;
  for (const k of slice) {
    const l = parseFloat(k[1]);
    const h = parseFloat(k[2]);
    const o = parseFloat(k[3]);
    const c = parseFloat(k[4]);
    const baseVol = parseFloat(k[5]) || 0;
    const avgPx = (o + c) / 2 || c || o || 1;
    const quoteVol = baseVol * avgPx;
    const range = Math.max(h - l, o * 0.0002);
    const bodyRatio = Math.max(-1, Math.min(1, (c - o) / range));
    const d = quoteVol * bodyRatio * 0.40;
    delta += d;
    totalVol += quoteVol;
    buyVol += quoteVol * (0.5 + bodyRatio * 0.20);
  }
  return { delta, totalVol, buyVol, count: slice.length };
}

// --- Dynamic Coinbase Spot Fetcher (Relative Activity + Session Weighting) ---
async function fetchCoinbaseSpotData(sym, anchorTs = null, sessionCtx = null) {
  try {
    const base = sym.replace('USDT', '');
    const candidates = [`${base}-USD`, `${base}-USDT`];
    let candles = null;

    for (const productId of candidates) {
      const res = await fetch(`https://api.exchange.coinbase.com/products/${productId}/candles?granularity=900`);
      if (!res.ok) continue;
      const json = await res.json();
      if (Array.isArray(json) && json.length >= 20) {
        candles = [...json].reverse().slice(-120);
        break;
      }
    }

    if (!candles) return null;

    const startIdx = findStartIndexByTs(candles, anchorTs, k => parseInt(k[0], 10) * 1000);
    const s15Flow = calcCoinbaseSpotFlowFromKlines(candles, 1);
    const s1hFlow = calcCoinbaseSpotFlowFromKlines(candles, 4);
    const s4hFlow = calcCoinbaseSpotFlowFromKlines(candles, 16);
    const s1dFlow = calcCoinbaseSpotFlowFromKlines(candles, 96);
    const sSwFlow = startIdx !== null ? calcCoinbaseSpotFlowFromKlines(candles, 0, startIdx) : null;

    const baseline24 = calcCoinbaseSpotFlowFromKlines(candles, 24);
    const avgHourlyCbVol = baseline24 && baseline24.totalVol > 0 ? (baseline24.totalVol / 6) : (s1hFlow?.totalVol || 1);
    const relVol = avgHourlyCbVol > 0 ? (s1hFlow?.totalVol || 0) / avgHourlyCbVol : 1.0;

    const baseW = sessionCtx?.cbBaseWeight ?? 1.0;
    const activityMult = relVol >= 1.6 ? 1.30 : (relVol >= 1.1 ? 1.10 : (relVol < 0.65 ? 0.65 : 1.0));
    const cbDynamicWeight = Math.max(0.4, Math.min(2.0, baseW * activityMult));

    const w = cbDynamicWeight;
    return {
      snap: {
        '15m': { fut: 0, spot: (s15Flow?.delta ?? 0) * w },
        '1h':  { fut: 0, spot: (s1hFlow?.delta ?? 0) * w },
        '4h':  { fut: 0, spot: (s4hFlow?.delta ?? 0) * w },
        '1D':  { fut: 0, spot: (s1dFlow?.delta ?? 0) * w },
        SWING: { fut: 0, spot: (sSwFlow?.delta ?? 0) * w }
      },
      stats: {
        code: 'CB',
        spot15m: s15Flow?.delta ?? 0,
        spot1h: s1hFlow?.delta ?? 0,
        vol1h: s1hFlow?.totalVol ?? 0,
        buy1h: s1hFlow?.buyVol ?? 0,
        spotVol1h: s1hFlow?.totalVol ?? 0,
        spotBuy1h: s1hFlow?.buyVol ?? 0,
        vol4h: s4hFlow?.totalVol ?? 0,
        relVol,
        cbDynamicWeight
      }
    };
  } catch (e) {
    return null;
  }
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
    const moveRatio = Math.abs(currentPrice - c.price) / Math.max(c.price, 0.0001);
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

function analyzeAdaptiveSwingMap(klines15m, currentPrice, snapNow, m5Snap, deltaNow, hlData, rollingStats, precomputed = null, sfAlign = null, sessionCtx = null, liqInfo = null) {
  const sc = sessionCtx?.flowScale ?? 1;
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

  const shortSqueezeBias = (hlData && hlData.fundingHourly < -0.00005) || Boolean(liqInfo?.shortCrowded);
  const longHeavyBias = (hlData && hlData.fundingHourly > 0.00015) || Boolean(liqInfo?.longCrowded);

  const rollingEasingBear = rollingStats.hasHistory && (rollingStats.f15PerMin > 120000 * sc || rollingStats.deceleratingDown) && rollingStats.consistencyPct >= 55;
  const rollingEasingBull = rollingStats.hasHistory && rollingStats.f15PerMin < -120000 * sc && rollingStats.consistencyPct >= 60;

  const macroBearish = f4h < 0 || (f1h < 0 && posInCorridor <= 0.5);
  const sellingEasing = (f5Weighted > 0 || m5Snap.isAbsorption || dF15 > 250000 * sc || rollingEasingBear || (fSw > 0 && lowTrend === 'HL'));
  const buyingEasing = (f5Weighted < 0 || dF15 < -250000 * sc || rollingEasingBull || (fSw < 0 && highTrend === 'LH'));

  const validBullBreak = currentPrice > lastHigh.price && fSw > 0 && f5Weighted >= -200000 * sc &&
    !sfAlign?.isLeverageTrap && !sfAlign?.upperWickRejection && (sfAlign?.spotBuyPct ?? 50) >= 49.0;

  let mapSignal = 'MID_CORRIDOR';
  let mapHeadline = '';
  let mapAdvice = '';
  let mapScoreBias = 0;

  if (macroBearish && posInCorridor <= 0.45 && sellingEasing) {
    mapSignal = 'DROP_EXHAUSTION_ENTRY';
    mapScoreBias = shortSqueezeBias ? 34 : 28;
    mapHeadline = `Επιβράδυνση πτώσης κοντά στο ${lowTrend} ($${fmtPrice(lastLow.price)}) — έλεγχος εισόδου`;
    mapAdvice = `[${sessionCtx?.label || ''}] Η τοπική ροή μαλακώνει (5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}], SWG: ${fmtUsd(fSw)}, ${rollingStats.label}).${shortSqueezeBias ? ' Πιέζονται shorts.' : ''} Ενδείκνυται έλεγχος εισόδου αντί για κυνηγητό σορτ.`;
  } else if (validBullBreak) {
    mapSignal = 'BULL_BREAK_READY';
    mapScoreBias = (shortSqueezeBias ? 38 : 32) + (rollingStats.spotLeading || sfAlign?.code === 'BOTH_BUYING' ? 6 : 0);
    mapHeadline = `Διάσπαση πάνω από ${highTrend} ($${fmtPrice(lastHigh.price)}) με καύσιμο CVD`;
    mapAdvice = `Σπάσιμο τοπικής κορυφής με ροή κύματος (${fmtUsd(fSw)} Perp / ${fmtUsd(sSw)} Spot · ${sfAlign?.label || ''}) · ${rollingStats.label}.`;
  } else if (currentPrice > lastHigh.price && fSw > 0 && (sfAlign?.isLeverageTrap || sfAlign?.upperWickRejection)) {
    mapSignal = 'RALLY_EXHAUSTION_WAIT';
    mapScoreBias = -18;
    mapHeadline = `Πέρασμα πάνω από ${highTrend} ($${fmtPrice(lastHigh.price)}) με κίνδυνο παγίδας/wick`;
    mapAdvice = `Η κίνηση πάνω από το τοπικό υψηλό συνοδεύεται από ${sfAlign?.upperWickRejection ? 'άνω ουρά απόρριψης' : sfAlign?.shortDesc || 'ασυμφωνία Spot/Perp'} (Spot Buy ${sfAlign?.spotBuyPct?.toFixed(1) ?? '--'}%). Αναμονή για καθαρή επιβεβαίωση.`;
  } else if (currentPrice < lastLow.price && fSw < 0 && !sellingEasing) {
    mapSignal = 'BEAR_BREAK_READY';
    mapScoreBias = longHeavyBias ? -38 : -32;
    mapHeadline = `Διάσπαση κάτω από ${lowTrend} ($${fmtPrice(lastLow.price)}) με πίεση CVD`;
    mapAdvice = `Πέρασμα κάτω από το τοπικό χαμηλό με αρνητική πίεση (${fmtUsd(fSw)} Perp, 5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}]) · ${liqInfo?.magnetSummary || ''}.`;
  } else if (posInCorridor >= 0.65 && buyingEasing) {
    mapSignal = 'RALLY_EXHAUSTION_WAIT';
    mapScoreBias = longHeavyBias ? -30 : -24;
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
    mapAdvice = `[${sessionCtx?.label || ''}] Η τιμή βρίσκεται στο ${Math.round(posInCorridor * 100)}% του δυναμικού διαδρόμου (${cfg.windowBars}×15m · ${cfg.modeLabel} · ${rollingStats.label}).`;
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
  const { currentPrice, struct, swingMap, diag, snapNow, m5Snap, deltaNow, hlData, rollingStats, prevSwingLeg, shadowInfo, sfAlign, sessionCtx, liqInfo } = ctx;
  const sc = sessionCtx?.flowScale ?? 1;
  const fSw = snapNow['SWING'].fut;
  const sSw = snapNow['SWING'].spot;
  const f1h = snapNow['1h'].fut;
  const s1h = snapNow['1h'].spot;
  const f4h = snapNow['4h'].fut;
  const dF1h = deltaNow['1h']?.fut ?? 0;

  let code = null;
  let title = '';
  let msg = '';

  if (sessionCtx?.code === 'WEEKEND_THIN' && liqInfo?.longCrowded && swingMap.posInCorridor >= 0.65) {
    code = 'WKND_LONG_TRAP';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΣΚ ΛΕΠΤΟ ΒΙΒΛΙΟ & LONGS';
    msg = `Σαββατοκύριακο με λεπτό βιβλίο, θετικό funding και ${liqInfo.magnetSummary}. Υψηλός κίνδυνος για απότομο καθοδικό sweep.`;
  } else if (sfAlign?.code === 'BOTH_SELLING' && currentPrice >= state.prevPrice) {
    code = 'BOTH_SELLING_RALLY';
    title = 'ΣΥΜΒΟΥΛΟΣ · BOTH SELLING ΣΤΗΝ ΑΝΟΔΟ';
    msg = `Και τα Futures (${fmtUsd(snapNow['15m'].fut)}) και το Spot (${fmtUsd(snapNow['15m'].spot)}, Spot Buy ${sfAlign.spotBuyPct.toFixed(1)}%) έχουν καθαρή πώληση. Προσοχή σε κίνηση ξετυλίγματος/squeeze χωρίς αγοραστική στήριξη.`;
  } else if (sfAlign?.isLeverageTrap) {
    code = 'PERP_SPOT_TRAP';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΑΝΟΔΟΣ ΜΕ ΜΟΧΛΕΥΣΗ / ΧΩΡΙΣ SPOT';
    msg = `${sfAlign.shortDesc} (1h Perp ${fmtUsd(f1h)} / Spot ${fmtUsd(s1h)} · CB vol ×${sfAlign.cbRelVol.toFixed(1)}). Απόφυγε βιαστικό κυνηγητό ψηλά.`;
  } else if (diag.totalScore >= 15 && s1h < -250000 * sc && f4h < -15000000 * sc) {
    code = 'SPOT_VS_4H_TRAP';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΑΝΤΙΦΑΣΗ SPOT & 4H';
    msg = `Το score δείχνει θετικό (${diag.totalScore}), αλλά το 1h Spot είναι αρνητικό (${fmtUsd(s1h)}) και το 4h βαραίνει (${fmtUsd(f4h)}). Μην περάσεις εύκολα το ριμπάουντ για αλλαγή κύριας τάσης.`;
  } else if (rollingStats.hasHistory && rollingStats.perpOnlyPush && rollingStats.consistencyPct >= 65 &&
           (swingMap.posInCorridor >= 0.70 || swingMap.posInCorridor <= 0.30)) {
    code = 'ROLLING_PERP_ONLY';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΚΙΝΗΣΗ ΜΟΝΟ ΜΕ PERPS';
    msg = `Στα τελευταία ${rollingStats.elapsedMin.toFixed(1)} λεπτά τα futures τρέχουν (${fmtUsd(rollingStats.f15PerMin)}/λ, ${rollingStats.consistencyPct}% συνέπεια) αλλά το Spot κινείται αντίθετα (${fmtUsd(rollingStats.s15PerMin)}/λ). Υψηλός κίνδυνος sweep/αναστροφής.`;
  } else if (prevSwingLeg && Math.abs(prevSwingLeg.fut) > 2500000 * sc &&
           Math.sign(fSw) === Math.sign(prevSwingLeg.fut) &&
           Math.abs(fSw) < Math.abs(prevSwingLeg.fut) * 0.45 &&
           (swingMap.posInCorridor >= 0.72 || swingMap.posInCorridor <= 0.28)) {
    code = 'SWING_LEG_DIVERGENCE';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΑΔΥΝΑΜΟ SWING LEG';
    msg = `Το τρέχον swing (${fmtUsd(fSw)}) έχει κάτω από το μισό καύσιμο σε σχέση με το προηγούμενο κύμα (${fmtUsd(prevSwingLeg.fut)} από $${fmtPrice(prevSwingLeg.price)}). Προσοχή σε εξάντληση.`;
  } else if (swingMap.posInCorridor >= 0.75 && fSw > 0 && sSw <= 0 && (f4h < 0 || f1h < 0)) {
    code = 'HIGH_FADE_RISK';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΠΙΕΣΗ ΣΤΟ ΑΝΩ ΑΚΡΟ';
    msg = `Η τιμή φτάνει στο ${Math.round(swingMap.posInCorridor * 100)}% του διαδρόμου προς ${swingMap.highTrend} ($${fmtPrice(swingMap.lastHigh)}) με θετικό Perp swing (${fmtUsd(fSw)}) αλλά χωρίς στήριξη Spot (${fmtUsd(sSw)}). Πρόσεξε το ρίσκο απόρριψης/LH.`;
  } else if (m5Snap.isAbsorption && (swingMap.posInCorridor <= 0.35 || swingMap.posInCorridor >= 0.65 || currentPrice <= struct.demandTop)) {
    code = 'ABSORPTION_WATCH';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΑΠΟΡΡΟΦΗΣΗ ΣΕ ΚΡΙΣΙΜΟ ΣΗΜΕΙΟ';
    msg = `Καταγράφηκε απορρόφηση στο 5m (${fmtUsd(m5Snap.fut)}) κοντά σε κρίσιμη ζώνη. Μεγάλη ροή χωρίς αναλογική κίνηση τιμής συχνά προηγείται στροφής ή απότομου ξεσπάσματος — περίμενε κλείσιμο επιβεβαίωσης.`;
  } else if (swingMap.mapSignal === 'DROP_EXHAUSTION_ENTRY' && currentPrice < struct.softPivot) {
    code = 'DROP_EASING_CHECK';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΦΡΕΝΑΡΙΣΜΑ ΠΤΩΣΗΣ';
    msg = `Οι πωλητές μαλακώνουν κοντά στο ${swingMap.lowTrend} ($${fmtPrice(swingMap.lastLow)}), όμως η τιμή είναι ακόμα κάτω από το S-Pivot ($${fmtPrice(struct.softPivot)}) και το H-Pivot στα $${fmtPrice(struct.hardPivot)}. Έλεγχος επιβεβαίωσης αντί για βιασύνη.`;
  } else if (hlData && Math.abs(hlData.annualizedPct) >= 25 && Math.abs(dF1h) >= 1200000 * sc) {
    const dirSide = hlData.fundingHourly < 0 ? 'SHORTS' : 'LONGS';
    code = `HL_SKEW_${dirSide}`;
    title = `ΣΥΜΒΟΥΛΟΣ · ΠΙΕΣΗ ${dirSide} ΣΤΟ HL`;
    msg = `Στο Hyperliquid το funding είναι έντονο (${hlData.annualizedPct.toFixed(1)}% ετησιοποιημένο · OI ${fmtUsd(hlData.oiUsd)}) ενώ η 1h ροή κινείται απότομα (${fmtUsd(dF1h)}). Υψηλή πιθανότητα νευρικής εκκαθάρισης/squeeze.`;
  } else if (shadowInfo?.activeSweep && shadowInfo.activeSweep.cycles >= 3) {
    code = 'SWEEP_DURATION_CHECK';
    title = 'ΣΥΜΒΟΥΛΟΣ · ΔΙΑΡΚΕΙΑ SWEEP';
    msg = `Το sweep (${shadowInfo.activeSweep.side}) στα $${fmtPrice(shadowInfo.activeSweep.extremePrice)} κρατάει ${shadowInfo.activeSweep.cycles} κύκλους. Αν δεν ανακτήσει γρήγορα, το sweep μπορεί να γυρίσει σε κανονικό break.`;
  }

  if (!code) return null;

  const nowMs = Date.now();
  const priceBucket = Math.max(currentPrice * 0.0008, 0.0001);
  const signature = `${code}|${Math.round(currentPrice / priceBucket)}|${Math.round(diag.totalScore / 10)}`;
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
    const f1h = calcBybitFlowFromKlines(linList, 4);
    const s1h = calcBybitFlowFromKlines(spotList, 4);

    return {
      snap: {
        '15m': { fut: calcBybitFlowFromKlines(linList, 1).delta, spot: calcBybitFlowFromKlines(spotList, 1).delta },
        '1h':  { fut: f1h.delta, spot: s1h.delta },
        '4h':  { fut: calcBybitFlowFromKlines(linList, 16).delta, spot: calcBybitFlowFromKlines(spotList, 16).delta },
        '1D':  { fut: calcBybitFlowFromKlines(linList, 96).delta, spot: calcBybitFlowFromKlines(spotList, 96).delta },
        SWING: { fut: swingFut, spot: swingSpot }
      },
      stats: {
        code: 'BB',
        vol1h: f1h.totalVol + s1h.totalVol,
        buy1h: f1h.buyVol + s1h.buyVol,
        spotVol1h: s1h.totalVol,
        spotBuy1h: s1h.buyVol,
        futVol1h: f1h.totalVol,
        futVol4h: calcBybitFlowFromKlines(linList, 16).totalVol
      }
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
    const f1h = calcOkxFlowFromKlines(swapList, 4);
    const s1h = calcOkxFlowFromKlines(spotList, 4);

    return {
      snap: {
        '15m': { fut: calcOkxFlowFromKlines(swapList, 1).delta, spot: calcOkxFlowFromKlines(spotList, 1).delta },
        '1h':  { fut: f1h.delta, spot: s1h.delta },
        '4h':  { fut: calcOkxFlowFromKlines(swapList, 16).delta, spot: calcOkxFlowFromKlines(spotList, 16).delta },
        '1D':  { fut: calcOkxFlowFromKlines(swapList, 96).delta, spot: calcOkxFlowFromKlines(spotList, 96).delta },
        SWING: { fut: swingFut, spot: swingSpot }
      },
      stats: {
        code: 'OKX',
        vol1h: f1h.totalVol + s1h.totalVol,
        buy1h: f1h.buyVol + s1h.buyVol,
        spotVol1h: s1h.totalVol,
        spotBuy1h: s1h.buyVol,
        futVol1h: f1h.totalVol,
        futVol4h: calcOkxFlowFromKlines(swapList, 16).totalVol
      }
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

function computeWeightedDiagnosis(struct, snapNow, m5Snap, swingAnchor, swingMap, rollingStats, currentPrice, shadowAdj = 0, sfAlign = null, sessionCtx = null) {
  const sc = sessionCtx?.flowScale ?? 1;
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

  const macroNorm = Math.max(15000000 * sc, Math.abs(f4h) * 0.8 + Math.abs(f1h) * 2.5);
  const macroRaw = (f1h * 0.55 + s1h * 1.15 + f4h * 0.45 + s4h * 0.9) / macroNorm;
  const macroScore = Math.max(-100, Math.min(100, macroRaw * 100));

  const w5Fut = m5Snap.fut * m5Snap.weightMult;
  const w5Spot = m5Snap.spot * m5Snap.weightMult;
  const rollingBonus = rollingStats.hasHistory
    ? Math.max(-12, Math.min(12, (rollingStats.f15PerMin / (400000 * sc)) * (rollingStats.consistencyPct / 100) * 10))
    : 0;
  const sfAdj = sfAlign?.isLeverageTrap
    ? -14
    : (sfAlign?.code === 'SPOT_ABSORPTION' ? 12 : (sfAlign?.code === 'BOTH_BUYING' ? 8 : (sfAlign?.code === 'BOTH_SELLING' ? -8 : 0)));
  const moveNorm = Math.max(6000000 * sc, Math.abs(fSw) * 0.9 + Math.abs(w5Fut) * 4);
  const flowComponent = ((w5Fut * 1.5 + w5Spot * 2.2 + fSw * 0.65 + sSw * 1.2 + f15 * 0.45 + s15 * 0.8) / moveNorm) * 70;
  const mapScore = Math.max(-100, Math.min(100, flowComponent + swingMap.mapScoreBias + rollingBonus + shadowAdj + sfAdj));

  const totalScore = Math.round(structScore * 0.35 + macroScore * 0.30 + mapScore * 0.35);

  const reasons = [
    `[${sessionCtx?.label || ''}] Φακός ${swingMap.windowBars}×15m (${swingMap.modeLabel}): ${swingMap.lowTrend} $${fmtPrice(swingMap.lastLow)} ↔ ${swingMap.highTrend} $${fmtPrice(swingMap.lastHigh)} (${Math.round(swingMap.posInCorridor * 100)}%)`,
    `Από ${swingAnchor.type === 'LOW' ? 'χαμηλό' : 'υψηλό'} $${fmtPrice(swingAnchor.price)}: Perp ${fmtUsd(fSw)} / Spot ${fmtUsd(sSw)} · ${sfAlign?.label || ''} (Spot Buy ${sfAlign?.spotBuyPct?.toFixed(1) ?? '--'}%) · 5m: ${fmtUsd(m5Snap.fut)} [${m5Snap.qualityTag}] · ${rollingStats.label}`,
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

function computeAdaptiveCapitalRatio(snapNow, prevSnap, fut1hVol, fut4hVol, hlData, activeVenues, sessionCtx, liqInfo) {
  const sc = sessionCtx?.flowScale ?? 1;
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

  const shortImpulseStrong = shortMag > macroMag * 0.42 || Math.abs(dF15) > 1200000 * sc || fut4hVol < fut1hVol * 2.2;
  const wShort = shortImpulseStrong ? 1.5 : 0.75;
  const wMacro = shortImpulseStrong ? 0.65 : 1.25;
  const activeTfLabel = `${shortImpulseStrong ? '15m/1h Ροή' : '4h/1D Δομή'} · ${sessionCtx.label}`;

  let bullTilt = 1.0;
  let bearTilt = 1.0;
  let hlPain = liqInfo?.magnetSummary || 'Ουδέτερο funding (χωρίς ακραίο πόνο)';

  if (hlData) {
    const ann = hlData.annualizedPct;
    document.getElementById('hlFundingBadge').textContent =
      `HL: ${(hlData.fundingHourly * 100).toFixed(4)}%/h (${ann.toFixed(1)}%)`;

    if (hlData.fundingHourly < -0.00005) {
      bullTilt = 1.15;
      bearTilt = 0.90;
    } else if (hlData.fundingHourly > 0.00015) {
      bearTilt = 1.15;
      bullTilt = 0.90;
    }
  } else {
    document.getElementById('hlFundingBadge').textContent = `Venues: ${activeVenues.join('+')}`;
  }

  const rawBull = (
    (Math.max(0, f15) + Math.max(0, f1h) + Math.max(0, s1h) * 1.5 + Math.max(0, dF15)) * wShort +
    (Math.max(0, f4h) + Math.max(0, f1d) * 0.35 + Math.max(0, s4h) * 1.5) * wMacro
  ) * bullTilt;

  const rawBear = (
    (Math.max(0, -f15) + Math.max(0, -f1h) + Math.max(0, -s1h) * 1.5 + Math.max(0, -dF15)) * wShort +
    (Math.max(0, -f4h) + Math.max(0, -f1d) * 0.35 + Math.max(0, -s4h) * 1.5) * wMacro
  ) * bearTilt;

  const floorBase = Math.max(250000 * sc, (fut1hVol + fut4hVol) * 0.0015);
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

function drawChart(klines, struct, swingMap = null, liqInfo = null) {
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

  if (liqInfo) {
    const targetLiq = liqInfo.longCrowded ? liqInfo.longLiq50x : (liqInfo.shortCrowded ? liqInfo.shortLiq50x : null);
    if (targetLiq && targetLiq >= minP && targetLiq <= maxP) {
      ctx.strokeStyle = 'rgba(168, 85, 247, 0.70)';
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(0, yOf(targetLiq));
      ctx.lineTo(plotW, yOf(targetLiq));
      ctx.stroke();
    }
  }

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
  if (liqInfo) {
    const targetLiq = liqInfo.longCrowded ? liqInfo.longLiq50x : (liqInfo.shortCrowded ? liqInfo.shortLiq50x : null);
    if (targetLiq && targetLiq >= minP && targetLiq <= maxP) {
      labels.push({ p: targetLiq, color: '#c084fc', tag: 'LIQ50' });
    }
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
  const sessionCtx = getMarketSessionContext(nowTs);
  const sc = sessionCtx.flowScale;

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

    const currentPrice = parseFloat(fut15[fut15.length - 1][4]);
    state.prevPrice = state.lastPrice;
    state.lastPrice = currentPrice;
    state.klines15m = fut15;

    const swingPrecomp = extractAdaptiveSwingPoints(fut15);
    const swingAnchor = detectLatestSwingAnchor(fut15, swingPrecomp);
    const anchorTs = fut15[swingAnchor.index] ? parseInt(fut15[swingAnchor.index][0], 10) : null;
    const swingKey = `${swingAnchor.type}_${Math.round(swingAnchor.price)}_${anchorTs || 0}`;

    const [bybitRes, okxRes, cbRes, derivFuel] = await Promise.all([
      fetchBybitData(sym, anchorTs),
      fetchOkxData(sym, anchorTs),
      fetchCoinbaseSpotData(sym, anchorTs, sessionCtx),
      fetchDerivativeFuel(sym, currentPrice)
    ]);

    const liqInfo = estimateLiquidationClusters(nowTs, currentPrice, fut15, derivFuel, hlData);

    document.getElementById('livePrice').textContent = `$${fmtPrice(currentPrice)}`;

    const bnFut15 = calcBinanceCvdFromKlines(fut15, 1);
    const bnSpot15 = calcBinanceCvdFromKlines(spot15, 1);
    const bnFut1h = calcBinanceCvdFromKlines(fut15, 4);
    const bnSpot1h = calcBinanceCvdFromKlines(spot15, 4);
    const bnFut4h = calcBinanceCvdFromKlines(fut1h, 4);
    const bnSpot4h = calcBinanceCvdFromKlines(spot1h, 4);
    const bnFut1d = calcBinanceCvdFromKlines(fut1h, 24);
    const bnSpot1d = calcBinanceCvdFromKlines(spot1h, 24);
    const bnSwingFut = calcBinanceCvdFromKlines(fut15, 0, swingAnchor.index).delta;
    const bnSwingSpot = calcBinanceCvdFromKlines(spot15, 0, swingAnchor.index).delta;

    const bnSnap = {
      '15m': { fut: bnFut15.delta, spot: bnSpot15.delta },
      '1h':  { fut: bnFut1h.delta, spot: bnSpot1h.delta },
      '4h':  { fut: bnFut4h.delta, spot: bnSpot4h.delta },
      '1D':  { fut: bnFut1d.delta, spot: bnSpot1d.delta },
      SWING: { fut: bnSwingFut, spot: bnSwingSpot }
    };

    const m5Snap = analyze5mFlowQuality(fut5m, spot5m, sessionCtx);

    const venues = [{
      code: 'BN',
      snap: bnSnap,
      stats: {
        code: 'BN',
        spot15m: bnSpot15.delta,
        spot1h: bnSpot1h.delta,
        vol1h: bnFut1h.totalVol + bnSpot1h.totalVol,
        buy1h: bnFut1h.buyVol + bnSpot1h.buyVol,
        spotVol1h: bnSpot1h.totalVol,
        spotBuy1h: bnSpot1h.buyVol,
        futVol1h: bnFut1h.totalVol,
        futVol4h: bnFut4h.totalVol
      }
    }];
    if (bybitRes) venues.push({ code: 'BB', snap: bybitRes.snap, stats: bybitRes.stats });
    if (okxRes) venues.push({ code: 'OKX', snap: okxRes.snap, stats: okxRes.stats });
    if (cbRes) venues.push({ code: 'CB', snap: cbRes.snap, stats: cbRes.stats });

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

    const venueStatsList = venues.map(v => v.stats).filter(Boolean);
    const sfAlign = computeSpotFuturesAlignment(snapNow, m5Snap, venueStatsList, fut15, sessionCtx, liqInfo);

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

    const lastHist = state.cvdHistory[state.cvdHistory.length - 1];
    const estMin = lastHist ? Math.max(0.15, (nowTs - lastHist.ts) / 60000) : 0.75;
    const estF15Rate = lastHist ? (snapNow['15m'].fut - lastHist.f15) / estMin : 0;

    recordCvdSample(nowTs, currentPrice, m5Snap, snapNow, swingKey, estF15Rate, sfAlign.spotBuyPct, sfAlign.code);
    const rollingStats = computeRollingFlowStats(swingKey, sessionCtx);

    venues.forEach(v => {
      state.perVenuePrev[v.code] = { ...v.snap, swingKey, ts: nowTs };
    });

    const activeCodes = venues.map(v =>
      v.code === 'CB' && cbRes?.stats ? `CB×${cbRes.stats.cbDynamicWeight.toFixed(1)}` : v.code
    );
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
        if (rollingStats.deceleratingDown) {
          pace = `${fmtUsd(rollingStats.f15PerMin)}/λ (Φρενάρει)`;
          paceCls = 'pos';
        } else if (rollingStats.f15PerMin > 180000 * sc && rollingStats.consistencyPct >= 60) {
          pace = `${fmtUsd(rollingStats.f15PerMin)}/λ ↑`;
          paceCls = 'pos';
        } else if (rollingStats.f15PerMin < -180000 * sc && rollingStats.consistencyPct >= 60) {
          pace = `${fmtUsd(rollingStats.f15PerMin)}/λ ↓`;
          paceCls = 'neg';
        } else {
          pace = `${fmtUsd(rollingStats.f15PerMin)}/λ`;
        }
      } else if (key === 'SWING' && rollingStats.hasHistory) {
        pace = `${fmtUsd(rollingStats.fSwPerMin)}/λ`;
        paceCls = rollingStats.fSwPerMin >= 0 ? 'pos' : 'neg';
      } else if (hasDelta) {
        if (fVal > 0 && dFut > 350000 * sc) { pace = 'Επιταχύνει ↑'; paceCls = 'pos'; }
        else if (fVal > 0 && dFut < -350000 * sc) { pace = 'Μαλακώνει ↓'; paceCls = 'warn-txt'; }
        else if (fVal < 0 && dFut < -350000 * sc) { pace = 'Πιέζει κάτω ↓'; paceCls = 'neg'; }
        else if (fVal < 0 && dFut > 350000 * sc) { pace = 'Απορρόφηση ↑'; paceCls = 'pos'; }
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
      `${sessionCtx.label} · ${new Date().toLocaleTimeString('el-GR')} · [${activeCodes.join('+')}] · SpotBuy ${sfAlign.spotBuyPct.toFixed(1)}% · ${sfAlign.label}${resumeNote}`;

    const struct = computeDynamicStructure(fut15, currentPrice, snapNow['1h'].fut, swingPrecomp.cfg.windowBars);
    const swingMap = analyzeAdaptiveSwingMap(
      fut15, currentPrice, snapNow, m5Snap, deltaNow, hlData, rollingStats, swingPrecomp, sfAlign, sessionCtx, liqInfo
    );
    const shadowInfo = evaluateAlgoShadowMechanics(
      nowTs, fut15, currentPrice, struct, swingMap, m5Snap, rollingStats, hlData, sfAlign, sessionCtx
    );

    drawChart(fut15, struct, swingMap, liqInfo);

    document.getElementById('softPivotVal').textContent = `$${fmtPrice(struct.softPivot)}`;
    document.getElementById('hardPivotVal').textContent = `$${fmtPrice(struct.hardPivot)}`;
    document.getElementById('targetPoolVal').textContent = `$${fmtPrice(struct.supplyBottom)} – $${fmtPrice(struct.supplyTop)}`;
    const prevLegTxt = state.prevSwingLeg
      ? ` · Προηγ. SWG: ${fmtUsd(state.prevSwingLeg.fut)}`
      : '';
    document.getElementById('sweepBreakVal').textContent =
      `${struct.zoneBehavior} · ${shadowInfo.shadowTag} · ${liqInfo.magnetSummary}${prevLegTxt}`;
    document.getElementById('zoneStatus').textContent =
      `${sessionCtx.label} · ${shadowInfo.shadowTag} · W:${swingMap.windowBars} · $${fmtPrice(swingMap.lastLow)} (${swingMap.lowTrend}) ↔ $${fmtPrice(swingMap.lastHigh)} (${swingMap.highTrend})`;
    document.getElementById('zoneLegend').innerHTML = `
      <span class="pos">■ Demand: $${fmtPrice(struct.demandBottom)} – $${fmtPrice(struct.demandTop)}</span>
      <span class="warn-txt">┄ S-Pivot: $${fmtPrice(struct.softPivot)}</span>
      <span class="neg">━ H-Pivot: $${fmtPrice(struct.hardPivot)}</span>
      <span style="color:#c084fc">┄ Liq50x: ↓$${fmtPrice(liqInfo.longLiq50x)} / ↑$${fmtPrice(liqInfo.shortLiq50x)}</span>
    `;

    const totalVol1h = venueStatsList.reduce((acc, s) => acc + (s.futVol1h || 0), 0);
    const totalVol4h = venueStatsList.reduce((acc, s) => acc + (s.futVol4h || 0), 0);

    const cap = computeAdaptiveCapitalRatio(
      snapNow, state.prevCvdSnap, totalVol1h, totalVol4h, hlData, activeCodes, sessionCtx, liqInfo
    );
    document.getElementById('hlPainText').textContent = cap.hlPain;
    document.getElementById('bullCapVal').textContent = fmtUsd(cap.bullCap);
    document.getElementById('bearCapVal').textContent = fmtUsd(cap.bearCap);
    document.getElementById('capRatioFill').style.width = `${cap.bullShare.toFixed(1)}%`;
    document.getElementById('capRatioText').textContent =
      `${cap.ratio} : 1 (${cap.bullShare.toFixed(0)}% Υπέρ / ${(100 - cap.bullShare).toFixed(0)}% Κατά) · ${cap.activeTfLabel}`;

    const diag = computeWeightedDiagnosis(
      struct, snapNow, m5Snap, swingAnchor, swingMap, rollingStats, currentPrice, shadowInfo.scoreAdj, sfAlign, sessionCtx
    );
    const f1h = snapNow['1h'].fut;
    const s1h = snapNow['1h'].spot;
    const dF1h = deltaNow['1h'].fut ?? 0;

    let regime = swingMap.mapSignal;
    let cardClass = 'summary-card';
    let headline = `${swingMap.mapHeadline} (${diag.totalScore})`;
    let detail = `${swingMap.mapAdvice} ${diag.reasonText}.`;
    let syncLabel = `${sfAlign.label} · SpotBuy ${sfAlign.spotBuyPct.toFixed(1)}% · ${shadowInfo.shadowTag}`;

    if (shadowInfo.shadowTag.includes('SWEEP & RECLAIM') && !sfAlign.isLeverageTrap) {
      regime = 'SHADOW_SWEEP_RECLAIM';
      cardClass = 'summary-card bull';
      headline = `SHADOW RECLAIM (${diag.totalScore}): Ανάκτηση επιπέδου μετά από sweep`;
      detail = `${shadowInfo.shadowAlert?.body || swingMap.mapAdvice} ${diag.reasonText}.`;
    } else if (currentPrice < struct.hardPivot && f1h < 0 && swingMap.mapSignal !== 'DROP_EXHAUSTION_ENTRY') {
      regime = 'HARD_PIVOT_BREAK';
      cardClass = 'summary-card bear';
      headline = `ΣΚΛΗΡΟ PIVOT (${diag.totalScore}): Διάσπαση κάτω από $${fmtPrice(struct.hardPivot)} με πωλητική ροή`;
      detail = `Η δομή γύρισε καθοδικά (${fmtUsd(f1h)} στο 1h). ${swingMap.mapAdvice} ${diag.reasonText}.`;
    } else if (swingMap.mapSignal === 'DROP_EXHAUSTION_ENTRY' || sfAlign.code === 'SPOT_ABSORPTION') {
      cardClass = 'summary-card bull';
    } else if (swingMap.mapSignal === 'BULL_BREAK_READY' && sfAlign.isValidBullFlow && !sfAlign.upperWickRejection) {
      cardClass = 'summary-card bull';
    } else if (swingMap.mapSignal === 'BEAR_BREAK_READY') {
      cardClass = 'summary-card bear';
    } else if (swingMap.mapSignal === 'RALLY_EXHAUSTION_WAIT' || sfAlign.isLeverageTrap) {
      cardClass = 'summary-card warn';
      if (sfAlign.isLeverageTrap && swingMap.mapSignal !== 'RALLY_EXHAUSTION_WAIT') {
        regime = 'PERP_SPOT_DIVERGENCE';
        headline = `Ασυμφωνία Futures CVD με Spot (${diag.totalScore}) — άνοδος σε μόχλευση`;
      }
    } else if (sfAlign.isValidBullFlow && dF1h >= 0 && !sfAlign.upperWickRejection) {
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
      prevSwingLeg: state.prevSwingLeg,
      shadowInfo,
      sfAlign,
      sessionCtx,
      liqInfo
    });

    if (advisorNote) {
      detail = `${detail} | [Σύμβουλος: ${advisorNote.msg}]`;
      pushEvent(advisorNote.title, advisorNote.msg);
    }

    document.getElementById('pillFlow').textContent =
      `5m: ${fmtUsd(m5Snap.fut)} (${m5Snap.qualityTag}) | OI: ${fmtUsd(liqInfo.totalOiUsd)} (${fmtUsd(liqInfo.oiDeltaUsd)})`;
    document.getElementById('pillSync').textContent = syncLabel;
    document.getElementById('pillPivot').textContent =
      `S-Pivot $${fmtPrice(struct.softPivot)} · H-Pivot $${fmtPrice(struct.hardPivot)}`;

    const priceBucket = Math.max(currentPrice * 0.0008, 0.0001);
    const signature = `${sessionCtx.code}|${regime}|${sfAlign.code}|${shadowInfo.shadowTag}|${swingMap.windowBars}|${Math.round(currentPrice / priceBucket)}|${Math.round(diag.totalScore / 10)}|${advisorNote?.code || ''}`;
    if (signature !== state.lastSummarySignature) {
      state.lastSummarySignature = signature;
      const card = document.getElementById('summaryCard');
      card.className = cardClass;
      document.getElementById('summaryHeadline').textContent = headline;
      document.getElementById('summaryDetail').textContent = detail;
      document.getElementById('summaryUpdated').textContent =
        `${sessionCtx.label} · ${new Date().toLocaleTimeString('el-GR')} [${activeCodes.join('+')}] · SpotBuy ${sfAlign.spotBuyPct.toFixed(1)}%`;
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
        Math.abs(currentPrice - swingMap.lastLow) / currentPrice < 0.0025 ||
        Math.abs(currentPrice - liqInfo.longLiq50x) / currentPrice < 0.003 ||
        Math.abs(currentPrice - liqInfo.shortLiq50x) / currentPrice < 0.003;
      const flowBurst =
        Math.abs(dF1h) > 2000000 * sc ||
        Math.abs(m5Snap.fut * m5Snap.weightMult) > 1500000 * sc ||
        priceMovePct > 0.18 ||
        Boolean(shadowInfo.activeSweep);

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
      pre,
      null
    );
    drawChart(state.klines15m, s, sm, null);
  }
});

runCycle();
