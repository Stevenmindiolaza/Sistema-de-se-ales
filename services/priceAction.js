'use strict';
const { ATR } = require('technicalindicators');

const MIN_SCORE = Math.max(2, Number(process.env.PA_MIN_SCORE) || 4); // puntaje mínimo para emitir señal

const body = (c) => Math.abs(c.close - c.open);
const range = (c) => c.high - c.low;

const bullEngulf = (p, c) => p.close < p.open && c.close > c.open && c.close >= p.open && c.open <= p.close && body(c) > body(p);
const bearEngulf = (p, c) => p.close > p.open && c.close < c.open && c.close <= p.open && c.open >= p.close && body(c) > body(p);
const bullPin = (c) => range(c) > 0 && (Math.min(c.open, c.close) - c.low) / range(c) >= 0.6;
const bearPin = (c) => range(c) > 0 && (c.high - Math.max(c.open, c.close)) / range(c) >= 0.6;

/** Pivotes confirmados (fractales de n velas a cada lado). La vela actual nunca entra en un nivel. */
function swings(cs, n = 2) {
  const highs = [];
  const lows = [];
  for (let i = n; i < cs.length - n; i++) {
    let h = true;
    let l = true;
    for (let j = 1; j <= n; j++) {
      if (!(cs[i].high > cs[i - j].high && cs[i].high >= cs[i + j].high)) h = false;
      if (!(cs[i].low < cs[i - j].low && cs[i].low <= cs[i + j].low)) l = false;
    }
    if (h) highs.push({ i, price: cs[i].high });
    if (l) lows.push({ i, price: cs[i].low });
  }
  return { highs, lows };
}

/** Agrupa pivotes cercanos en una sola zona; más toques = nivel más fuerte. */
function cluster(prices, tol) {
  const out = [];
  for (const p of [...prices].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && p - last.price <= tol) {
      last.price = (last.price * last.touches + p) / (last.touches + 1);
      last.touches++;
    } else out.push({ price: p, touches: 1 });
  }
  return out;
}

const fx = (n) => Number(n).toFixed(5);

/**
 * Analiza la última vela cerrada con acción del precio puro.
 * Devuelve { direction, score, reasons, ... } o null si no hay una lectura clara.
 */
function analyzePriceAction(candles) {
  if (candles.length < 60) return null;
  const look = candles.slice(-120);
  const atrArr = ATR.calculate({
    period: 14, high: look.map((c) => c.high), low: look.map((c) => c.low), close: look.map((c) => c.close)
  });
  const atr = atrArr[atrArr.length - 1];
  if (!atr) return null;

  const tol = atr * 0.6;
  const sw = swings(look);
  const sup = cluster(sw.lows.map((x) => x.price), tol);
  const res = cluster(sw.highs.map((x) => x.price), tol);
  const c = look[look.length - 1];
  const p = look[look.length - 2];
  const pp = look[look.length - 3];

  // Estructura de mercado: máximos/mínimos crecientes o decrecientes
  const h = sw.highs.slice(-2);
  const l = sw.lows.slice(-2);
  let trend = 'lateral';
  if (h.length === 2 && l.length === 2) {
    if (h[1].price > h[0].price && l[1].price > l[0].price) trend = 'alcista';
    else if (h[1].price < h[0].price && l[1].price < l[0].price) trend = 'bajista';
  }

  const sc = { CALL: 0, PUT: 0 };
  const why = { CALL: [], PUT: [] };
  const add = (d, pts, txt) => { sc[d] += pts; why[d].push(txt); };
  const near = (x, lvl) => Math.abs(x - lvl.price) <= tol;

  // 1) Rechazo en soporte / resistencia
  const sLvl = sup.find((s) => near(c.low, s) && c.close > s.price);
  const rLvl = res.find((r) => near(c.high, r) && c.close < r.price);
  // Rechazo = toca la zona y cierra en la mitad opuesta de su rango (no hace falta que el cuerpo sea del color esperado)
  const mid = c.low + range(c) / 2;
  if (sLvl && c.close >= mid) add('CALL', sLvl.touches >= 2 ? 3 : 2, `Rechazo en soporte ${fx(sLvl.price)}`);
  if (rLvl && c.close <= mid) add('PUT', rLvl.touches >= 2 ? 3 : 2, `Rechazo en resistencia ${fx(rLvl.price)}`);

  // 2) Rupturas con cuerpo decidido
  const rBreak = res.find((r) => p.close <= r.price + tol * 0.1 && c.close > r.price + tol * 0.3 && body(c) >= atr * 0.6);
  const sBreak = sup.find((s) => p.close >= s.price - tol * 0.1 && c.close < s.price - tol * 0.3 && body(c) >= atr * 0.6);
  if (rBreak) add('CALL', 3, `Ruptura de resistencia ${fx(rBreak.price)}`);
  if (sBreak) add('PUT', 3, `Ruptura de soporte ${fx(sBreak.price)}`);

  // 3) Patrones de vela
  if (bullEngulf(p, c)) add('CALL', 2, 'Envolvente alcista');
  if (bearEngulf(p, c)) add('PUT', 2, 'Envolvente bajista');
  if (bullPin(c)) add('CALL', 2, 'Pin Bar alcista');
  if (bearPin(c)) add('PUT', 2, 'Pin Bar bajista');
  if (p.high < pp.high && p.low > pp.low) { // vela interna: rompimiento de la vela madre
    if (c.close > pp.high) add('CALL', 2, 'Ruptura de vela interna');
    else if (c.close < pp.low) add('PUT', 2, 'Ruptura de vela interna');
  }
  if (range(c) > 0 && body(c) / range(c) >= 0.7 && body(c) >= atr) {
    add(c.close > c.open ? 'CALL' : 'PUT', 1, 'Vela de impulso');
  }

  // 4) Estructura: a favor suma, en contra resta
  if (trend === 'alcista') {
    if (sc.CALL > 0) add('CALL', 1, 'A favor de estructura alcista');
    if (sc.PUT > 0) sc.PUT -= 1;
  } else if (trend === 'bajista') {
    if (sc.PUT > 0) add('PUT', 1, 'A favor de estructura bajista');
    if (sc.CALL > 0) sc.CALL -= 1;
  }

  // 5) Obstáculos: un nivel pegado al precio resta fuerza a la dirección contraria
  const resAbove = res.find((r) => r.price > c.close && r.price - c.close < atr * 0.8);
  const supBelow = sup.find((s) => s.price < c.close && c.close - s.price < atr * 0.8);
  if (resAbove && !rBreak) sc.CALL -= 2;
  if (supBelow && !sBreak) sc.PUT -= 2;

  const direction = sc.CALL >= sc.PUT ? 'CALL' : 'PUT';
  const best = Math.max(sc.CALL, sc.PUT);
  const other = Math.min(sc.CALL, sc.PUT);
  if (best < MIN_SCORE || best - other < 2) return null;

  return {
    direction,
    score: best,
    reasons: why[direction],
    ind: {
      atr: +atr.toFixed(6),
      trend,
      support: sLvl ? +sLvl.price.toFixed(6) : (supBelow ? +supBelow.price.toFixed(6) : null),
      resistance: rLvl ? +rLvl.price.toFixed(6) : (resAbove ? +resAbove.price.toFixed(6) : null)
    }
  };
}

module.exports = { analyzePriceAction, bullEngulf, bearEngulf, bullPin, bearPin };
