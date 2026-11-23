'use strict';
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { EventEmitter } = require('events');

const ENDPOINTS = {
  iqoption: { url: 'wss://iqoption.com/echo/websocket', origin: 'https://iqoption.com' },
  exnova: { url: 'wss://ws.exnova.com/echo/websocket', origin: 'https://trade.exnova.com' }
};

// active_id por par. Pueden variar entre brókeres/cuentas: ajusta aquí si algún par no llega.
const ACTIVES = {
  'EURUSD': 1, 'EURGBP': 2, 'GBPJPY': 3, 'EURJPY': 4, 'GBPUSD': 5, 'USDJPY': 6,
  'AUDCAD': 7, 'NZDUSD': 8,
  'EURUSD-OTC': 76, 'EURGBP-OTC': 77, 'USDCHF-OTC': 78, 'NZDUSD-OTC': 79,
  'GBPUSD-OTC': 80, 'GBPJPY-OTC': 81, 'USDJPY-OTC': 84, 'AUDCAD-OTC': 85
};
// Pares extra opcionales: data/actives.json -> { "HBAR-OTC": 1234 }
try {
  Object.assign(ACTIVES, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'actives.json'), 'utf8')));
} catch { /* sin pares personalizados */ }
const ID_TO_ASSET = Object.fromEntries(Object.entries(ACTIVES).map(([k, v]) => [v, k]));
const MAX_CANDLES = 500;

class BrokerSocket extends EventEmitter {
  constructor({ broker, ssid }) {
    super();
    if (!ENDPOINTS[broker]) throw new Error('Bróker no soportado');
    this.broker = broker;
    this.ssid = ssid;
    this.ws = null;
    this.state = 'disconnected'; // disconnected | connecting | connected | reconnecting
    this.stopped = true;
    this.attempt = 0;
    this.timeOffset = 0;
    this.reqN = 0;
    this.pending = new Map();
    this.subs = { assets: [], size: 60 };
    this.books = new Map(); // `${asset}|${size}` -> { closed: [], current: null, ready: false }
    this.lastMsg = Date.now();
    this.timers = [];
    this.reconnectTimer = null;
  }

  nowMs() { return Date.now() + this.timeOffset; }
  getCandles(asset, size) { return (this.books.get(`${asset}|${size}`) || { closed: [] }).closed; }

  _setState(s, detail) {
    this.state = s;
    this.emit('status', { state: s, detail: detail || null });
  }

  start() {
    this.stopped = false;
    this._connect();
    this.timers.push(setInterval(() => this._watchdog(), 5000));
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.removeAllListeners(); this.ws.terminate(); } catch { /* noop */ } }
    this.ws = null;
    this.pending.forEach((p) => p.reject(new Error('Conexión cerrada')));
    this.pending.clear();
    this.ssid = null; // el SSID nunca se persiste
    this._setState('disconnected');
  }

  _watchdog() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (Date.now() - this.lastMsg > 30000) { this.ws.terminate(); return; }
      try { this.ws.ping(); } catch { /* noop */ }
    }
  }

  _connect() {
    const ep = ENDPOINTS[this.broker];
    this._setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const ws = new WebSocket(ep.url, { headers: { Origin: ep.origin, 'User-Agent': 'Mozilla/5.0' } });
    this.ws = ws;
    ws.on('open', () => {
      this.lastMsg = Date.now();
      this._send('ssid', this.ssid);
    });
    ws.on('message', (raw) => {
      this.lastMsg = Date.now();
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      this._onMessage(m);
    });
    ws.on('error', (e) => this.emit('log', `WS error: ${e.message}`));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.books.forEach((b) => { b.ready = false; });
      if (this.stopped) return;
      this.attempt++;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempt, 5));
      this._setState('reconnecting', `Reintentando en ${Math.round(delay / 1000)}s`);
      this.reconnectTimer = setTimeout(() => this._connect(), delay);
    });
  }

  _send(name, msg, requestId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = { name, msg };
    if (requestId) payload.request_id = requestId;
    this.ws.send(JSON.stringify(payload));
  }

  _onMessage(m) {
    if (m.request_id && this.pending.has(m.request_id)) {
      const p = this.pending.get(m.request_id);
      this.pending.delete(m.request_id);
      p.resolve(m.msg);
      return;
    }
    switch (m.name) {
      case 'timeSync':
        this.timeOffset = m.msg - Date.now();
        break;
      case 'heartbeat':
        this._send('heartbeat', { userTime: this.nowMs(), heartbeatTime: m.msg });
        break;
      case 'authenticated':
        if (m.msg === false) {
          this.emit('log', 'SSID inválido o expirado');
          this.stopped = true;
          if (this.ws) this.ws.terminate();
          this._setState('disconnected', 'SSID inválido o expirado');
        }
        break;
      case 'profile':
        this.attempt = 0;
        this._setState('connected');
        this._applySubscriptions();
        this._discoverActives().catch((e) => this.emit('log', `Descubrimiento de pares: ${e.message}`));
        break;
      case 'candle-generated':
      case 'candles-generated':
        this._onTick(m.msg);
        break;
      default: break;
    }
  }

  /** Define pares y temporalidad (segundos: 60 = M1, 300 = M5). */
  setSubscriptions(assets, size) {
    const old = this.subs;
    this.subs = { assets: assets.filter((a) => ACTIVES[a]), size };
    if (this.state === 'connected') {
      old.assets.forEach((a) => this._unsubscribe(a, old.size));
      this._applySubscriptions();
    }
  }

  _applySubscriptions() {
    const { assets, size } = this.subs;
    assets.forEach((a) => this._subscribe(a, size));
  }

  _subscribe(asset, size) {
    this.books.set(`${asset}|${size}`, { closed: [], current: null, ready: false });
    this._send('subscribeMessage', {
      name: 'candle-generated',
      params: { routingFilters: { active_id: ACTIVES[asset], size } }
    });
    this._loadHistory(asset, size).catch((e) => this.emit('log', `Historial ${asset}: ${e.message}`));
  }

  _unsubscribe(asset, size) {
    this._send('unsubscribeMessage', {
      name: 'candle-generated',
      params: { routingFilters: { active_id: ACTIVES[asset], size } }
    });
    this.books.delete(`${asset}|${size}`);
  }

  _request(name, version, body, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const id = `r${Date.now()}_${++this.reqN}`;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); }
      });
      this._send('sendMessage', { name, version, body }, id);
    });
  }

  async _loadHistory(asset, size, count = 260) {
    const res = await this._request('get-candles', '2.0', {
      active_id: ACTIVES[asset], size, to: Math.floor(this.nowMs() / 1000), count, split_normalization: true
    });
    const book = this.books.get(`${asset}|${size}`);
    if (!book) return;
    const nowS = this.nowMs() / 1000;
    const hist = (res.candles || [])
      .filter((c) => c.to <= nowS + 1) // solo velas ya cerradas
      .map((c) => ({ from: c.from, open: c.open, high: c.max, low: c.min, close: c.close, volume: c.volume || 0 }))
      .sort((a, b) => a.from - b.from);
    book.closed = hist.slice(-MAX_CANDLES);
    book.ready = true;
    this.emit('history', { asset, size, count: book.closed.length });
  }

  /** Completa el mapa de pares con la lista de activos del bróker (mejor esfuerzo; falla en silencio). */
  async _discoverActives() {
    const res = await this._request('get-initialization-data', '3.0', {}, 15000);
    let added = 0;
    for (const group of ['binary', 'turbo', 'blitz']) {
      const actives = res && res[group] && res[group].actives;
      if (!actives) continue;
      for (const [id, a] of Object.entries(actives)) {
        const raw = String((a && (a.ticker || a.name)) || '').replace(/^front\./i, '').trim().toUpperCase().replace(/[\s/]+/g, '-');
        if (!/^[A-Z0-9-]{3,20}$/.test(raw) || ACTIVES[raw] || !Number.isFinite(Number(id))) continue;
        ACTIVES[raw] = Number(id);
        ID_TO_ASSET[id] = raw;
        added++;
      }
    }
    if (added) this.emit('assets', Object.keys(ACTIVES));
    this.emit('log', `Pares descubiertos: +${added}`);
  }

  _onTick(m) {
    if (!m) return;
    const asset = ID_TO_ASSET[m.active_id];
    if (!asset) return;
    const book = this.books.get(`${asset}|${m.size}`);
    if (!book) return;
    const cur = { from: m.from, open: m.open, high: m.max, low: m.min, close: m.close, volume: m.volume || 0 };
    if (book.current && cur.from > book.current.from) {
      const done = book.current;
      const last = book.closed[book.closed.length - 1];
      if (book.ready && (!last || last.from < done.from)) {
        book.closed.push(done);
        if (book.closed.length > MAX_CANDLES) book.closed.shift();
        this.emit('candleClosed', { asset, size: m.size, candle: done });
      }
      book.current = cur;
    } else if (!book.current || cur.from === book.current.from) {
      book.current = cur;
    }
    this.emit('tick', { asset, size: m.size, price: cur.close });
  }
}

module.exports = { BrokerSocket, ACTIVES, ENDPOINTS };
