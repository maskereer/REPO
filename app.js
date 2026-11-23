const state = {
  symbol: 'BTCUSDT',
  pollOverride: 'AUTO', // AUTO | TURBO | MOD
  currentIntervalMs: 45000,
  timerId: null,
  lastPrice: null,
  prevPrice: null,
  klines15m: [],
  prevCvdSnap: null,
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

// Compute CVD from klines (Taker Buy Quote Vol vs Taker Sell Quote Vol)
function calcCvdFromKlines(klines, bars) {
  const slice = klines.slice(-bars);
  let delta = 0;
  let totalVol = 0;
  for (const k of slice) {
    const quoteVol = parseFloat(k[7]);
    const takerBuyQuote = parseFloat(k[10]);
    const takerSellQuote = quoteVol - takerBuyQuote;
    delta += (takerBuyQuote - takerSellQuote);
    totalVol += quoteVol;
  }
  return { delta, totalVol };
}

// Dynamic Support/Demand, Resistance & Pivots with minimum separation so levels don't clump
function computeDynamicStructure(klines, currentPrice, cvd1hDelta) {
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));

  const recent = klines.slice(-96);
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

  const minBandGap = currentPrice * 0.0045; // ~0.45% minimum separation between distinct zones

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

  const minLow = Math.min(...lows.slice(-96));
  const maxHigh = Math.max(...highs.slice(-96));
  const span = Math.max(maxHigh - minLow, currentPrice * 0.015);

  const demandTop = supportsBelow[0] ?? (currentPrice - span * 0.25);
  const demandBottom = supportsBelow[1] ?? Math.max(minLow, demandTop - span * 0.22);

  const supplyBottom = resistsAbove[0] ?? (currentPrice + span * 0.25);
  const supplyTop = resistsAbove[1] ?? Math.min(maxHigh, supplyBottom + span * 0.22);

  // Soft Pivot sits cleanly between current price and demandTop (or supplyBottom if below demand)
  const softPivot = currentPrice >= demandTop
    ? Math.max(demandTop + minBandGap * 0.4, currentPrice - span * 0.12)
    : Math.min(supplyBottom - minBandGap * 0.4, currentPrice + span * 0.12);

  // Hard Pivot sits at the base of the primary demand zone
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

function drawChart(klines, struct) {
  const canvas = document.getElementById('radarCanvas');
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const padR = 82;
  const plotW = Math.max(60, w - padR);

  const view = klines.slice(-64);
  const highs = view.map(k => parseFloat(k[2]));
  const lows = view.map(k => parseFloat(k[3]));
  const maxP = Math.max(...highs, struct.supplyTop) * 1.002;
  const minP = Math.min(...lows, struct.hardPivot) * 0.998;
  const range = maxP - minP || 1;

  const yOf = (price) => h - ((price - minP) / range) * (h - 28) - 14;

  ctx.clearRect(0, 0, w, h);

  // Demand Zone band
  const yDemTop = yOf(struct.demandTop);
  const yDemBot = yOf(struct.demandBottom);
  ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
  ctx.fillRect(0, Math.min(yDemTop, yDemBot), plotW, Math.max(8, Math.abs(yDemBot - yDemTop)));

  // Resistance / Liquidity Pool band
  const ySupTop = yOf(struct.supplyTop);
  const ySupBot = yOf(struct.supplyBottom);
  ctx.fillStyle = 'rgba(239, 68, 68, 0.12)';
  ctx.fillRect(0, Math.min(ySupTop, ySupBot), plotW, Math.max(8, Math.abs(ySupBot - ySupTop)));

  // Soft Pivot dashed line
  const ySoft = yOf(struct.softPivot);
  ctx.strokeStyle = '#f59e0b';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(0, ySoft);
  ctx.lineTo(plotW, ySoft);
  ctx.stroke();

  // Hard Pivot solid line
  const yHard = yOf(struct.hardPivot);
  ctx.strokeStyle = '#ef4444';
  ctx.setLineDash([]);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, yHard);
  ctx.lineTo(plotW, yHard);
  ctx.stroke();

  // Candlesticks
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

  // Right price labels with anti-overlap spacing
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  const labels = [
    { p: struct.supplyBottom, color: '#f87171', tag: 'POOL' },
    { p: struct.softPivot, color: '#fbbf24', tag: 'S-PIV' },
    { p: struct.demandTop, color: '#34d399', tag: 'DEM' },
    { p: struct.hardPivot, color: '#ef4444', tag: 'H-PIV' }
  ]
    .map(lb => ({ ...lb, y: yOf(lb.p) }))
    .sort((a, b) => a.y - b.y);

  let lastLabelY = -999;
  labels.forEach(lb => {
    const drawY = Math.max(lb.y + 3, lastLabelY + 14);
    lastLabelY = drawY - 3;
    ctx.fillStyle = lb.color;
    ctx.fillText(`${lb.tag} ${Math.round(lb.p)}`, plotW + 4, Math.min(h - 6, drawY));
  });
}

async function runCycle() {
  const sym = document.getElementById('symbolSelect').value;
  if (sym !== state.symbol) {
    state.symbol = sym;
    state.prevCvdSnap = null;
    state.lastSummarySignature = '';
  }
  const baseCoin = sym.replace('USDT', '');

  try {
    const [fut15Res, fut1hRes, spot15Res, spot1hRes, hlData] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=120`),
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&limit=48`),
      fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=15m&limit=120`),
      fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=48`),
      fetchHyperliquidPain(baseCoin)
    ]);

    const [fut15, fut1h, spot15, spot1h] = await Promise.all([
      fut15Res.json(), fut1hRes.json(), spot15Res.json(), spot1hRes.json()
    ]);

    const currentPrice = parseFloat(fut15[fut15.length - 1][4]);
    state.prevPrice = state.lastPrice;
    state.lastPrice = currentPrice;
    state.klines15m = fut15;

    document.getElementById('livePrice').textContent = `$${fmtPrice(currentPrice)}`;

    const tfs = [
      { key: '15m', fut: calcCvdFromKlines(fut15, 1), spot: calcCvdFromKlines(spot15, 1) },
      { key: '1h',  fut: calcCvdFromKlines(fut15, 4), spot: calcCvdFromKlines(spot15, 4) },
      { key: '4h',  fut: calcCvdFromKlines(fut1h, 4), spot: calcCvdFromKlines(spot1h, 4) },
      { key: '1D',  fut: calcCvdFromKlines(fut1h, 24), spot: calcCvdFromKlines(spot1h, 24) }
    ];

    const snapNow = {};
    tfs.forEach(t => {
      snapNow[t.key] = { fut: t.fut.delta, spot: t.spot.delta };
    });

    const prev = state.prevCvdSnap;
    const tbody = document.getElementById('cvdTableBody');
    tbody.innerHTML = tfs.map(t => {
      const dFut = prev ? (t.fut.delta - prev[t.key].fut) : 0;
      const dSpot = prev ? (t.spot.delta - prev[t.key].spot) : 0;
      let pace = 'Σταθερό';
      let paceCls = '';
      if (prev) {
        if (t.fut.delta > 0 && dFut > 350000) { pace = 'Επιταχύνει ↑'; paceCls = 'pos'; }
        else if (t.fut.delta > 0 && dFut < -350000) { pace = 'Μαλακώνει ↓'; paceCls = 'warn-txt'; }
        else if (t.fut.delta < 0 && dFut < -350000) { pace = 'Πιέζει κάτω ↓'; paceCls = 'neg'; }
        else if (t.fut.delta < 0 && dFut > 350000) { pace = 'Απορρόφηση ↑'; paceCls = 'pos'; }
      }
      return `
        <tr>
          <td><strong>${t.key}</strong></td>
          <td class="${t.fut.delta >= 0 ? 'pos' : 'neg'}">${fmtUsd(t.fut.delta)}</td>
          <td class="${dFut >= 0 ? 'pos' : 'neg'}">${prev ? fmtUsd(dFut) : '--'}</td>
          <td class="${t.spot.delta >= 0 ? 'pos' : 'neg'}">${fmtUsd(t.spot.delta)}</td>
          <td class="${dSpot >= 0 ? 'pos' : 'neg'}">${prev ? fmtUsd(dSpot) : '--'}</td>
          <td class="${paceCls}">${pace}</td>
        </tr>
      `;
    }).join('');

    document.getElementById('snapClock').textContent =
      `Τελευταίο snapshot: ${new Date().toLocaleTimeString('el-GR')}`;

    const struct = computeDynamicStructure(fut15, currentPrice, snapNow['1h'].fut);
    drawChart(fut15, struct);

    document.getElementById('softPivotVal').textContent = `$${fmtPrice(struct.softPivot)}`;
    document.getElementById('hardPivotVal').textContent = `$${fmtPrice(struct.hardPivot)}`;
    document.getElementById('targetPoolVal').textContent = `$${fmtPrice(struct.supplyBottom)} – $${fmtPrice(struct.supplyTop)}`;
    document.getElementById('sweepBreakVal').textContent = struct.zoneBehavior;
    document.getElementById('zoneStatus').textContent =
      `Demand: $${fmtPrice(struct.demandBottom)}–$${fmtPrice(struct.demandTop)}`;
    document.getElementById('zoneLegend').innerHTML = `
      <span class="pos">■ Demand Zone: $${fmtPrice(struct.demandBottom)} – $${fmtPrice(struct.demandTop)}</span>
      <span class="warn-txt">┄ Μαλακό Pivot: $${fmtPrice(struct.softPivot)}</span>
      <span class="neg">━ Σκληρό Pivot: $${fmtPrice(struct.hardPivot)}</span>
      <span>■ Liquidity Pool: $${fmtPrice(struct.supplyBottom)} – $${fmtPrice(struct.supplyTop)}</span>
    `;

    // Hyperliquid Pain & Capital Ratio ($) with broader 4h+1D flow + OI context
    let hlPain = 'Ουδέτερο funding (χωρίς ακραίο πόνο)';
    let hlBullWeight = 0;
    let hlBearWeight = 0;
    if (hlData) {
      const ann = hlData.annualizedPct;
      document.getElementById('hlFundingBadge').textContent =
        `HL Funding: ${(hlData.fundingHourly * 100).toFixed(4)}%/h (${ann.toFixed(1)}% APR)`;
      if (hlData.fundingHourly < -0.00005) {
        hlPain = `Πονάνε οι SHORTS (πληρώνουν longs · OI ${fmtUsd(hlData.oiUsd)})`;
        hlBullWeight = hlData.oiUsd * 0.08;
      } else if (hlData.fundingHourly > 0.00015) {
        hlPain = `Πονάνε οι LONGS (ακριβό funding · OI ${fmtUsd(hlData.oiUsd)})`;
        hlBearWeight = hlData.oiUsd * 0.08;
      } else {
        hlPain = `Ισορροπημένο funding · HL OI: ${fmtUsd(hlData.oiUsd)}`;
      }
    }
    document.getElementById('hlPainText').textContent = hlPain;

    const bullCap =
      Math.max(0, snapNow['4h'].fut) +
      Math.max(0, snapNow['1D'].fut * 0.35) +
      Math.max(0, snapNow['4h'].spot) * 2 +
      hlBullWeight;

    const bearCap =
      Math.max(0, -snapNow['4h'].fut) +
      Math.max(0, -snapNow['1D'].fut * 0.35) +
      Math.max(0, -snapNow['4h'].spot) * 2 +
      hlBearWeight;

    const safeBull = bullCap > 0 ? bullCap : 100000;
    const safeBear = bearCap > 0 ? bearCap : 100000;
    const bullShare = (safeBull / (safeBull + safeBear)) * 100;
    const ratio = (safeBull / safeBear).toFixed(2);

    document.getElementById('bullCapVal').textContent = fmtUsd(bullCap);
    document.getElementById('bearCapVal').textContent = fmtUsd(bearCap);
    document.getElementById('capRatioFill').style.width = `${bullShare.toFixed(1)}%`;
    document.getElementById('capRatioText').textContent =
      `${ratio} : 1 (${bullShare.toFixed(0)}% Υπέρ / ${(100 - bullShare).toFixed(0)}% Κατά)`;

    // Situation Summary (Updates ONLY when regime/flow meaningfully changes)
    const f1h = snapNow['1h'].fut;
    const s1h = snapNow['1h'].spot;
    const dF1h = prev ? (f1h - prev['1h'].fut) : 0;

    let regime = 'NEUTRAL';
    let cardClass = 'summary-card';
    let headline = '';
    let detail = '';
    let syncLabel = '';

    if (currentPrice < struct.hardPivot && f1h < 0) {
      regime = 'HARD_PIVOT_BREAK';
      cardClass = 'summary-card bear';
      headline = `ΣΚΛΗΡΟ PIVOT: Διάσπαση κάτω από $${fmtPrice(struct.hardPivot)} με πωλητική ροή`;
      detail = `Η δομή γύρισε καθοδικά και οι πωλητές σπρώχνουν (${fmtUsd(f1h)} στο 1h). Δεν ισχύει πλέον η ανοδική στήριξη — προτεραιότητα η προστασία ή στροφή ανάλογα με το macro σου.`;
      syncLabel = 'Πίεση πωλητών σε Futures & δομή';
    } else if (f1h > 0 && s1h > 0 && dF1h >= 0) {
      regime = 'ALIGNED_BULL';
      cardClass = 'summary-card bull';
      headline = `Θετική εισροή σε Futures & Spot — φαίνεται να κατευθύνεται προς το Pool $${fmtPrice(struct.supplyBottom)}`;
      detail = `Συμφωνία αγοραστών (${fmtUsd(f1h)} Perps / ${fmtUsd(s1h)} Spot στο 1h) χωρίς εξασθένιση. Όσο κρατάει πάνω από το Μαλακό Pivot ($${fmtPrice(struct.softPivot)}), η ροή ευνοεί συνέχιση προς την επόμενη ζώνη ρευστότητας.`;
      syncLabel = 'Συμφωνία Spot + Futures ↑';
    } else if (f1h > 0 && s1h <= 0) {
      regime = 'PERP_SPOT_DIVERGENCE';
      cardClass = 'summary-card warn';
      headline = `Ασυμφωνία Futures CVD με Spot — η άνοδος πατάει σε μόχλευση`;
      detail = `Τα Futures δείχνουν θετικό Delta (${fmtUsd(f1h)}), αλλά το Spot δεν ακολουθεί (${fmtUsd(s1h)}). Προσοχή σε απότομο σκούπισμα προς τη ζώνη Demand ($${fmtPrice(struct.demandTop)}) πριν υπάρξει καθαρή συνέχεια.`;
      syncLabel = 'Ασυμφωνία: Perps ↑ / Spot ↓';
    } else if (f1h > 0 && dF1h < -400000) {
      regime = 'MOMENTUM_COOLING';
      cardClass = 'summary-card warn';
      headline = `Μαλακώνει η θετική εισροή στο CVD — η κίνηση χάνει φόρα (Μαλακό Pivot $${fmtPrice(struct.softPivot)})`;
      detail = `Το 1h CVD παραμένει θετικό (${fmtUsd(f1h)}) αλλά μειώθηκε κατά ${fmtUsd(dF1h)} σε σχέση με το προηγούμενο snapshot. Σημάδι χώνεψης ή δοκιμής στήριξης — πάγωμα επιθετικών προσθηκών μέχρι να ξαναδείξει απορρόφηση.`;
      syncLabel = 'Εξασθένιση ορμής';
    } else if (currentPrice <= struct.demandTop && dF1h > 0) {
      regime = 'DEMAND_ABSORPTION';
      cardClass = 'summary-card bull';
      headline = `Απορρόφηση μέσα στη ζώνη Demand ($${fmtPrice(struct.demandBottom)} – $${fmtPrice(struct.demandTop)})`;
      detail = `Η τιμή κατέβηκε στη στήριξη αλλά η αρνητική πίεση μαζεύεται (${fmtUsd(dF1h)} βελτίωση ροής). Αν κρατήσει το Σκληρό Pivot ($${fmtPrice(struct.hardPivot)}), στήνεται βάση αντίδρασης.`;
      syncLabel = 'Απορρόφηση σε στήριξη';
    } else {
      regime = 'RANGE_WAIT';
      cardClass = 'summary-card';
      headline = `Πλάγια χώνεψη ανάμεσα σε Demand ($${fmtPrice(struct.demandTop)}) και Pool ($${fmtPrice(struct.supplyBottom)})`;
      detail = `Δεν υπάρχει ακόμα καθαρό ξέσπασμα εισροών (${fmtUsd(f1h)} 1h Perp). Αναμονή για επιτάχυνση CVD ή σκούπισμα ζώνης πριν από εκτέλεση.`;
      syncLabel = 'Ουδέτερη / Πλάγια ροή';
    }

    document.getElementById('pillFlow').textContent = `1h Perp: ${fmtUsd(f1h)} | 4h: ${fmtUsd(snapNow['4h'].fut)}`;
    document.getElementById('pillSync').textContent = syncLabel;
    document.getElementById('pillPivot').textContent = `S-Pivot $${fmtPrice(struct.softPivot)} · H-Pivot $${fmtPrice(struct.hardPivot)}`;

    if (regime !== state.lastSummarySignature) {
      state.lastSummarySignature = regime;
      const card = document.getElementById('summaryCard');
      card.className = cardClass;
      document.getElementById('summaryHeadline').textContent = headline;
      document.getElementById('summaryDetail').textContent = detail;
      document.getElementById('summaryUpdated').textContent =
        `Ενημερώθηκε: ${new Date().toLocaleTimeString('el-GR')} (αλλαγή εικόνας)`;
      pushEvent(regime.replaceAll('_', ' '), headline);
    }

    state.prevCvdSnap = snapNow;
    if (state.pollOverride === 'AUTO') {
      const priceMovePct = state.prevPrice
        ? Math.abs((currentPrice - state.prevPrice) / state.prevPrice) * 100
        : 0;
      const nearPivot =
        Math.abs(currentPrice - struct.softPivot) / currentPrice < 0.0035 ||
        Math.abs(currentPrice - struct.hardPivot) / currentPrice < 0.004;
      const flowBurst = Math.abs(dF1h) > 1500000 || priceMovePct > 0.18;

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
    const s = computeDynamicStructure(
      state.klines15m, state.lastPrice, state.prevCvdSnap['1h'].fut
    );
    drawChart(state.klines15m, s);
  }
});

runCycle();
