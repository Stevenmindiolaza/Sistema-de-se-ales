'use strict';
require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');
const { BrokerSocket, ACTIVES } = require('./services/brokerSocket');
const SignalEngine = require('./services/signalEngine');
const Store = require('./services/store');
const { sendTelegram } = require('./services/telegram');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // solo local por defecto: el SSID es una credencial

const app = express();
app.use(cors({ origin: false }));
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const store = new Store();
const engine = new SignalEngine(store);

let broker = null;
let config = { broker: 'iqoption', size: 60, assets: [] };
let status = { state: 'disconnected', detail: null };
let session = null; // sesión de análisis de acción del precio
let sessionTimer = null;

const serverNow = () => (broker ? broker.nowMs() : Date.now());
const recent = (n = 200) => store.all().slice(-n).reverse();
const snapshot = () => ({
  type: 'snapshot', status, config, session, signals: recent(), stats: engine.stats(store.all()), t: serverNow()
});
function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

wss.on('connection', (ws) => ws.send(JSON.stringify(snapshot())));

// Reloj sincronizado con el servidor del bróker (o local si no hay conexión)
setInterval(() => broadcast({ type: 'clock', t: serverNow() }), 1000);
setInterval(() => engine.sweep(serverNow()), 10000);

// ---- Eventos del motor ----
const fmt = (n) => Number(n).toFixed(5);
engine.on('signal', (s) => {
  if (session && session.active && session.pairs.includes(s.asset)) {
    session.signalIds.push(s.id);
    broadcast({ type: 'session', session });
  }
  broadcast({ type: 'signal', signal: s, stats: engine.stats(store.all()) });
  sendTelegram(
    `📡 <b>SEÑAL ${s.direction}</b> ${s.asset} ${s.tf}\n` +
    `Bróker: ${s.broker}\nPatrón: ${s.pattern}\nEntrada: ${fmt(s.entryPrice)}\n` +
    `RSI: ${s.ind.rsi}\nExpira: ${new Date(s.expiryTime).toISOString().slice(11, 19)} UTC`
  );
});
engine.on('update', (s) => {
  broadcast({ type: 'update', signal: s, stats: engine.stats(store.all()) });
  const labels = { GANADA: '✅ GANADA (ITM)', GANADA_MG1: '✅ GANADA en MG1', PERDIDA: '❌ PERDIDA (OTM)', EMPATE: '➖ EMPATE', MG1: '🔁 Activa 1er Martingala', ANULADA: '⚠️ ANULADA' };
  sendTelegram(`${labels[s.status] || s.status}\n${s.asset} ${s.tf} ${s.direction}`);
});

// ---- Broker ----
function attachBroker(b) {
  b.on('status', (st) => { status = st; broadcast({ type: 'status', status }); });
  b.on('log', (m) => console.log(`[${b.broker}] ${m}`));
  b.on('history', (h) => console.log(`[${b.broker}] historial ${h.asset} M${h.size / 60}: ${h.count} velas`));
  b.on('candleClosed', ({ asset, size }) => {
    const candles = b.getCandles(asset, size);
    engine.process({ broker: b.broker, asset, size, candles });
    if (session && session.active && size === 60 && session.pairs.includes(asset) && serverNow() < session.endsAt) {
      engine.analyze(b.broker, asset, size, candles);
    }
  });
  b.on('assets', (list) => broadcast({ type: 'assets', assets: list }));
}

function validate({ size, assets }) {
  if (![60, 300].includes(size)) return 'Temporalidad inválida (60 o 300)';
  if (!Array.isArray(assets) || assets.some((a) => !ACTIVES[a])) return 'Lista de pares inválida';
  return null;
}

// ---- API REST ----
app.get('/api/state', (req, res) => res.json({ status, config, assets: Object.keys(ACTIVES), t: serverNow() }));

app.post('/api/connect', (req, res) => {
  const { broker: name, ssid } = req.body || {};
  const size = Number(req.body.size);
  const assets = req.body.assets || [];
  if (!['iqoption', 'exnova'].includes(name)) return res.status(400).json({ error: 'Bróker inválido' });
  if (typeof ssid !== 'string' || ssid.trim().length < 10) return res.status(400).json({ error: 'SSID inválido' });
  const err = validate({ size, assets });
  if (err) return res.status(400).json({ error: err });

  if (broker) broker.stop();
  clearTimeout(sessionTimer);
  session = null;
  broadcast({ type: 'session', session });
  config = { broker: name, size, assets };
  broker = new BrokerSocket({ broker: name, ssid: ssid.trim() });
  broker.setSubscriptions(assets, size);
  attachBroker(broker);
  broker.start();
  res.json({ ok: true });
});

app.post('/api/subscriptions', (req, res) => {
  const size = Number(req.body.size);
  const assets = req.body.assets || [];
  const err = validate({ size, assets });
  if (err) return res.status(400).json({ error: err });
  config = { ...config, size, assets };
  if (broker) broker.setSubscriptions(assets, size);
  broadcast({ type: 'config', config });
  res.json({ ok: true });
});

app.post('/api/disconnect', (req, res) => {
  endSession();
  if (broker) { broker.stop(); broker = null; }
  res.json({ ok: true });
});

// ---- Modo análisis (acción del precio) ----
const normPair = (s) => {
  let p = String(s).trim().toUpperCase().replace(/\//g, '').replace(/[\s_]+/g, '-');
  if (/[A-Z0-9]OTC$/.test(p)) p = p.replace(/OTC$/, '-OTC');
  return p;
};
function endSession() {
  clearTimeout(sessionTimer);
  if (session && session.active) { session.active = false; broadcast({ type: 'session', session }); }
}

app.post('/api/analyze', (req, res) => {
  if (!broker || broker.state !== 'connected') return res.status(400).json({ error: 'Conecta primero con tu SSID' });
  const minutes = Math.min(30, Math.max(1, Number(req.body.minutes) || 5));
  const pairs = [...new Set((req.body.pairs || []).map(normPair))].filter(Boolean);
  if (!pairs.length) return res.status(400).json({ error: 'Indica al menos un par' });
  const unknown = pairs.filter((p) => !ACTIVES[p]);
  if (unknown.length) {
    return res.status(400).json({ error: `Par no disponible: ${unknown.join(', ')}. Añade su active_id en data/actives.json` });
  }
  const assets = [...new Set([...config.assets, ...pairs])];
  config = { ...config, size: 60, assets }; // el análisis trabaja en M1
  broker.setSubscriptions(assets, 60);
  broadcast({ type: 'config', config });
  clearTimeout(sessionTimer);
  const startedAt = serverNow();
  session = { active: true, pairs, minutes, startedAt, endsAt: startedAt + minutes * 60000, signalIds: [] };
  sessionTimer = setTimeout(endSession, minutes * 60000);
  broadcast({ type: 'session', session });
  res.json({ ok: true });
});

app.post('/api/analyze/stop', (req, res) => { endSession(); res.json({ ok: true }); });

// Borra todo el historial de señales (y la lista de la sesión de análisis)
app.post('/api/signals/clear', (req, res) => {
  store.clear();
  if (session) session.signalIds = [];
  broadcast({ type: 'cleared', stats: engine.stats([]), session });
  res.json({ ok: true });
});

function filtered(q) {
  return store.all().filter((s) => (!q.broker || s.broker === q.broker) && (!q.status || s.status === q.status));
}
app.get('/api/signals', (req, res) => res.json(filtered(req.query).slice(-500).reverse()));
app.get('/api/stats', (req, res) => res.json(engine.stats(filtered(req.query))));

app.get('/api/export.csv', (req, res) => {
  const cols = ['id', 'broker', 'asset', 'tf', 'direction', 'pattern', 'entryPrice', 'entryTime', 'closePrice', 'mgEntry', 'mgClose', 'status'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = filtered(req.query).map((s) => [
    s.id, s.broker, s.asset, s.tf, s.direction, s.pattern, s.entryPrice,
    new Date(s.entryTime).toISOString(), s.closePrice, s.mg && s.mg.entryPrice, s.mg && s.mg.closePrice, s.status
  ].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="senales.csv"');
  res.send('\ufeff' + [cols.join(','), ...rows].join('\n'));
});

server.listen(PORT, HOST, () => console.log(`Panel en http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
process.on('SIGINT', () => { if (broker) broker.stop(); store.save(); setTimeout(() => process.exit(0), 500); });
