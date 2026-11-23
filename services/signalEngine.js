'use strict';
const { EventEmitter } = require('events');
const { EMA, RSI, BollingerBands } = require('technicalindicators');

// Velas hacia atrás donde se acepta el cruce EMA y la salida del RSI (configurable con SIGNAL_WINDOW en .env)
const WINDOW = Math.max(1, Math.min(10, Number(process.env.SIGNAL_WINDOW) || 3));
const MIN_CANDLES = 210; // EMA 200 necesita historial suficiente
const ACTIVE = ['PENDIENTE', 'MG1'];

const { analyzePriceAction, bullEngulf, bearEngulf, bullPin, bearPin } = require('./priceAction');

const at = (arr, k) => arr[arr.length - 1 - k]; // k = 0 → último valor

class SignalEngine extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
  }

  /** Se llama en cada cierre de vela. */
  process({ broker, asset, size, candles }) {
    this._resolve(broker, asset, size, candles[candles.length - 1]);
    const sig = this._evaluate(broker, asset, size, candles);
    if (sig) {
      this.store.add(sig);
      this.emit('signal', sig);
    }
  }

  _evaluate(broker, asset, size, candles) {
    if (candles.length < MIN_CANDLES) return null;
    if (this._hasActive(broker, asset, size)) return null;

    const closes = candles.map((c) => c.close);
    const e200 = EMA.calculate({ period: 200, values: closes });
    const e9 = EMA.calculate({ period: 9, values: closes });
    const e21 = EMA.calculate({ period: 21, values: closes });
    const rsi = RSI.calculate({ period: 14, values: closes });
    const bb = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    if (!e200.length || e21.length < WINDOW + 2 || rsi.length < WINDOW + 2 || !bb.length) return null;

    const c = at(candles, 0);
    const p = at(candles, 1);
    const crossUp = [...Array(WINDOW).keys()].some((k) => at(e9, k) > at(e21, k) && at(e9, k + 1) <= at(e21, k + 1));
    const crossDn = [...Array(WINDOW).keys()].some((k) => at(e9, k) < at(e21, k) && at(e9, k + 1) >= at(e21, k + 1));
    const rsiNow = at(rsi, 0);
    const rsiExitOversold = rsiNow >= 30 && [...Array(WINDOW).keys()].some((k) => at(rsi, k + 1) < 30);
    const rsiExitOverbought = rsiNow <= 70 && [...Array(WINDOW).keys()].some((k) => at(rsi, k + 1) > 70);

    let direction = null;
    let pattern = null;
    if (c.close > at(e200, 0) && crossUp && rsiExitOversold) {
      if (bullEngulf(p, c)) pattern = 'Envolvente alcista';
      else if (bullPin(c)) pattern = 'Pin Bar alcista';
      if (pattern) direction = 'CALL';
    } else if (c.close < at(e200, 0) && crossDn && rsiExitOverbought) {
      if (bearEngulf(p, c)) pattern = 'Envolvente bajista';
      else if (bearPin(c)) pattern = 'Pin Bar bajista';
      if (pattern) direction = 'PUT';
    }
    if (!direction) return null;

    const band = at(bb, 0);
    return this._build(broker, asset, size, c, direction, pattern, 'ESTRATEGIA', {
      ema9: +at(e9, 0).toFixed(6), ema21: +at(e21, 0).toFixed(6), ema200: +at(e200, 0).toFixed(6),
      rsi: +rsiNow.toFixed(2), bbUpper: +band.upper.toFixed(6), bbLower: +band.lower.toFixed(6)
    });
  }

  _hasActive(broker, asset, size) {
    return this.store.all().some((s) => s.broker === broker && s.asset === asset && s.size === size && ACTIVE.includes(s.status));
  }

  _build(broker, asset, size, c, direction, pattern, source, ind, score = null) {
    const ms = size * 1000;
    const entryTime = c.from * 1000 + ms; // la entrada es la apertura de la vela siguiente
    return {
      id: `${broker}-${asset}-${size}-${c.from}`,
      broker, asset, size,
      tf: size === 300 ? 'M5' : 'M1',
      direction, pattern, source, score,
      entryPrice: c.close,
      entryTime,
      expiryTime: entryTime + ms,
      status: 'PENDIENTE',
      closePrice: null,
      mg: null,
      ind,
      createdAt: Date.now()
    };
  }

  /** Modo análisis: lectura de acción del precio sobre la última vela cerrada. */
  analyze(broker, asset, size, candles) {
    if (this._hasActive(broker, asset, size)) return null;
    const r = analyzePriceAction(candles);
    if (!r) return null;
    const sig = this._build(broker, asset, size, candles[candles.length - 1], r.direction, r.reasons.join(' + '), 'ACCION_PRECIO', r.ind, r.score);
    this.store.add(sig);
    this.emit('signal', sig);
    return sig;
  }

  /** Verificador automático ITM / OTM / 1er Martingala con el cierre real de la vela de expiración. */
  _resolve(broker, asset, size, candle) {
    const ms = size * 1000;
    for (const s of this.store.all()) {
      if (s.broker !== broker || s.asset !== asset || s.size !== size) continue;
      if (s.status === 'PENDIENTE' && candle.from * 1000 === s.entryTime) {
        s.closePrice = candle.close;
        if (candle.close === s.entryPrice) s.status = 'EMPATE';
        else if (this._win(s.direction, s.entryPrice, candle.close)) s.status = 'GANADA';
        else {
          s.status = 'MG1';
          s.mg = { entryPrice: candle.close, entryTime: s.expiryTime, expiryTime: s.expiryTime + ms, closePrice: null };
        }
        this._emitUpdate(s);
      } else if (s.status === 'MG1' && candle.from * 1000 === s.mg.entryTime) {
        s.mg.closePrice = candle.close;
        s.status = this._win(s.direction, s.mg.entryPrice, candle.close) ? 'GANADA_MG1' : 'PERDIDA';
        this._emitUpdate(s);
      }
    }
  }

  /** Anula señales que no pudieron verificarse (p. ej. caída de conexión durante la expiración). */
  sweep(nowMs) {
    for (const s of this.store.all()) {
      const limit = (s.status === 'MG1' ? s.mg.expiryTime : s.expiryTime) + s.size * 2000;
      if (ACTIVE.includes(s.status) && nowMs > limit) {
        s.status = 'ANULADA';
        this._emitUpdate(s);
      }
    }
  }

  _win(dir, entry, close) { return dir === 'CALL' ? close > entry : close < entry; }
  _emitUpdate(s) { this.store.save(); this.emit('update', s); }

  /** KPIs globales y por activo. Winrate = (directas + MG1) / (directas + MG1 + perdidas). */
  stats(signals) {
    const blank = () => ({ total: 0, ganadas: 0, ganadasMG1: 0, perdidas: 0, empates: 0, winrate: 0 });
    const g = blank();
    const byAsset = {};
    for (const s of signals) {
      if (s.status === 'ANULADA') continue;
      const a = (byAsset[s.asset] = byAsset[s.asset] || blank());
      for (const t of [g, a]) {
        t.total++;
        if (s.status === 'GANADA') t.ganadas++;
        else if (s.status === 'GANADA_MG1') t.ganadasMG1++;
        else if (s.status === 'PERDIDA') t.perdidas++;
        else if (s.status === 'EMPATE') t.empates++;
      }
    }
    for (const t of [g, ...Object.values(byAsset)]) {
      const done = t.ganadas + t.ganadasMG1 + t.perdidas;
      t.winrate = done ? +(((t.ganadas + t.ganadasMG1) / done) * 100).toFixed(1) : 0;
    }
    return { global: g, byAsset };
  }
}

module.exports = SignalEngine;
