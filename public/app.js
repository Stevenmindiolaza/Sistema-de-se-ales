'use strict';
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { session: null, signals: new Map(), stats: null, offset: 0, size: 60, config: null, ws: null };
const STATUS_UI = {
  PENDIENTE: ['Pendiente', 'text-amber-400'], MG1: ['En MG1', 'text-orange-400'],
  GANADA: ['GANADA (ITM)', 'text-[#00ff9c]'], GANADA_MG1: ['GANADA MG1', 'text-[#00ff9c]'],
  PERDIDA: ['PERDIDA (OTM)', 'text-[#ff6b6b]'], EMPATE: ['Empate', 'text-gray-400'], ANULADA: ['Anulada', 'text-gray-500']
};
const fmtP = (n) => (n == null ? '—' : Number(n).toFixed(5));
const hhmmss = (ms) => new Date(ms).toTimeString().slice(0, 8);
const serverNow = () => Date.now() + state.offset;

// ---------- Audio (Web Audio API, sin archivos externos) ----------
let actx = null;
function unlockAudio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
}
function beep(freqs, dur = 0.16) {
  if (!$('sound').checked) return;
  try {
    unlockAudio();
    freqs.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      const t0 = actx.currentTime + i * (dur + 0.04);
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(actx.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    });
  } catch { /* audio no disponible */ }
}
const soundCall = () => beep([660, 880, 1100]);
const soundPut = () => beep([880, 660, 440]);
const soundWin = () => beep([880, 1320], 0.1);

// ---------- WebSocket al backend ----------
function connectWS() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onmessage = (ev) => handle(JSON.parse(ev.data));
  ws.onclose = () => { setStatus({ state: 'reconnecting', detail: 'Panel sin conexión con el servidor' }); setTimeout(connectWS, 2000); };
}

function handle(m) {
  if (m.t) state.offset = m.t - Date.now();
  switch (m.type) {
    case 'snapshot':
      state.signals = new Map(m.signals.map((s) => [s.id, s]));
      state.stats = m.stats; state.session = m.session; applyConfig(m.config); setStatus(m.status); renderAll(); break;
    case 'clock': break;
    case 'status': setStatus(m.status); break;
    case 'session': state.session = m.session; renderAnalysis(); break;
    case 'assets': buildAssets(m.assets); break;
    case 'cleared':
      state.signals = new Map(); state.stats = m.stats; state.session = m.session; renderAll(); break;
    case 'config': applyConfig(m.config); break;
    case 'signal':
      state.signals.set(m.signal.id, m.signal); state.stats = m.stats;
      m.signal.direction === 'CALL' ? soundCall() : soundPut();
      renderAll(m.signal.id); break;
    case 'update':
      state.signals.set(m.signal.id, m.signal); state.stats = m.stats;
      if (['GANADA', 'GANADA_MG1'].includes(m.signal.status)) soundWin();
      renderAll(); break;
    default: break;
  }
}

// ---------- Estado de conexión ----------
function setStatus(st) {
  const map = { connected: ['ok', 'Conectado'], connecting: ['wait', 'Conectando…'], reconnecting: ['wait', 'Reconectando'], disconnected: ['off', 'Desconectado'] };
  const [cls, txt] = map[st.state] || map.disconnected;
  $('led').className = `led ${cls}`;
  $('statusText').textContent = st.detail ? `${txt} · ${st.detail}` : txt;
}

// ---------- Panel de control ----------
function applyConfig(cfg) {
  if (!cfg) return;
  state.config = cfg; state.size = cfg.size;
  $('broker').value = cfg.broker;
  document.querySelectorAll('#assets input').forEach((i) => { i.checked = cfg.assets.includes(i.value); });
  markTf();
}
function markTf() {
  document.querySelectorAll('.tf').forEach((b) => {
    const on = Number(b.dataset.size) === state.size;
    b.className = `tf px-3 py-2 rounded border ${on ? 'border-[#00ff9c] text-[#00ff9c] bg-[#0f2a22]' : 'border-[#2a2e39]'}`;
  });
}
const selectedAssets = () => [...document.querySelectorAll('#assets input:checked')].map((i) => i.value);
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  $('msg').textContent = r.ok ? '' : (j.error || 'Error');
  return r.ok;
}

document.querySelectorAll('.tf').forEach((b) => b.addEventListener('click', () => { state.size = Number(b.dataset.size); markTf(); }));
$('btnConnect').addEventListener('click', async () => {
  unlockAudio();
  const ok = await api('/api/connect', { broker: $('broker').value, ssid: $('ssid').value, size: state.size, assets: selectedAssets() });
  if (ok) $('ssid').value = '';
});
$('btnDisconnect').addEventListener('click', () => api('/api/disconnect'));
$('btnApply').addEventListener('click', () => api('/api/subscriptions', { size: state.size, assets: selectedAssets() }));
$('fBroker').addEventListener('change', renderHistory);
$('fStatus').addEventListener('change', renderHistory);
$('btnCsv').addEventListener('click', () => {
  const q = new URLSearchParams({ broker: $('fBroker').value, status: $('fStatus').value });
  [...q.keys()].forEach((k) => { if (!q.get(k)) q.delete(k); });
  location.href = `/api/export.csv?${q}`;
});

// ---------- Render ----------
function renderAll(flashId) { renderLive(flashId); renderKpis(); renderHistory(); renderAnalysis(); }

function renderLive(flashId) {
  const active = [...state.signals.values()].filter((s) => s.status === 'PENDIENTE' || s.status === 'MG1')
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!active.length) {
    $('live').innerHTML = '<div class="panel p-4 text-gray-500 text-sm col-span-full">Esperando confluencia de la estrategia…</div>';
    return;
  }
  $('live').innerHTML = active.map((s) => {
    const call = s.direction === 'CALL';
    const isMg = s.status === 'MG1';
    const entry = isMg ? s.mg.entryPrice : s.entryPrice;
    const expiry = isMg ? s.mg.expiryTime : s.expiryTime;
    return `<div class="panel p-4 border-2 ${call ? 'call' : 'put'} ${s.id === flashId ? 'flash' : ''}" data-expiry="${expiry}">
      <div class="flex justify-between items-start">
        <div><div class="text-lg font-bold text-white">${esc(s.asset)}</div><div class="text-xs text-gray-400">${esc(s.broker)} · ${esc(s.tf)}</div></div>
        <div class="text-2xl font-extrabold ${call ? 'text-[#00ff9c]' : 'text-[#ff6b6b]'}">${call ? '▲ CALL' : '▼ PUT'}</div>
      </div>
      <div class="mt-2 text-sm text-gray-300">${esc(s.pattern)} · ${s.source === 'ACCION_PRECIO' ? 'Fuerza ' + esc(s.score) : 'RSI ' + esc(s.ind.rsi)}</div>
      <div class="text-sm">${isMg ? '<span class="text-orange-400 font-bold">1er MARTINGALA</span> · ' : ''}Entrada: <b>${fmtP(entry)}</b> · ${hhmmss(expiry - s.size * 1000)}</div>
      <div class="mt-2 flex justify-between items-end">
        <span class="text-xs text-gray-400">Expira ${hhmmss(expiry)} <button data-copy="${esc(s.id)}" class="ml-2 px-2 py-0.5 rounded bg-[#2a2e39] hover:bg-[#363b49] text-white">Copiar</button></span>
        <span class="cd text-2xl font-bold tabular-nums text-white">--:--</span>
      </div>
    </div>`;
  }).join('');
  tickCountdowns();
}

function tickCountdowns() {
  document.querySelectorAll('[data-expiry]').forEach((el) => {
    const left = Math.max(0, Number(el.dataset.expiry) - serverNow());
    const s = Math.ceil(left / 1000);
    el.querySelector('.cd').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  });
}

function renderKpis() {
  const g = (state.stats && state.stats.global) || { total: 0, ganadas: 0, ganadasMG1: 0, perdidas: 0, winrate: 0 };
  const card = (label, val, cls = 'text-white') => `<div class="panel p-3"><div class="text-xs text-gray-400">${label}</div><div class="text-2xl font-bold ${cls}">${val}</div></div>`;
  $('kpis').innerHTML = card('Total señales', g.total) + card('Ganadas directas', g.ganadas, 'text-[#00ff9c]') +
    card('Ganadas MG1', g.ganadasMG1, 'text-[#00ff9c]') + card('Perdidas', g.perdidas, 'text-[#ff6b6b]') + card('Winrate', `${g.winrate}%`, 'text-sky-400');
  const by = (state.stats && state.stats.byAsset) || {};
  $('byAsset').innerHTML = Object.entries(by).map(([a, t]) =>
    `<span class="px-2 py-1 rounded border border-[#2a2e39]">${esc(a)}: <b>${t.winrate}%</b> (${t.ganadas + t.ganadasMG1}/${t.ganadas + t.ganadasMG1 + t.perdidas})</span>`
  ).join('') || '<span class="text-gray-500">Sin datos todavía</span>';
}

function renderHistory() {
  const fb = $('fBroker').value, fs = $('fStatus').value;
  const rows = [...state.signals.values()].filter((s) => (!fb || s.broker === fb) && (!fs || s.status === fs))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  $('history').innerHTML = rows.map((s) => {
    const [label, cls] = STATUS_UI[s.status] || [s.status, ''];
    const close = s.mg && s.mg.closePrice != null ? `${fmtP(s.closePrice)} → ${fmtP(s.mg.closePrice)}` : fmtP(s.closePrice);
    return `<tr class="border-t border-[#2a2e39]">
      <td class="p-2">${hhmmss(s.entryTime)}</td><td class="p-2">${esc(s.broker)}</td><td class="p-2">${esc(s.asset)}</td><td class="p-2">${esc(s.tf)}</td>
      <td class="p-2 font-bold ${s.direction === 'CALL' ? 'text-[#00ff9c]' : 'text-[#ff6b6b]'}">${esc(s.direction)}</td>
      <td class="p-2">${esc(s.pattern)}</td><td class="p-2">${fmtP(s.entryPrice)}</td><td class="p-2">${close}</td>
      <td class="p-2 font-bold ${cls}">${label}</td>
      <td class="p-2"><button data-copy="${esc(s.id)}" class="px-2 rounded bg-[#2a2e39] hover:bg-[#363b49]">Copiar</button></td></tr>`;
  }).join('') || '<tr><td colspan="10" class="p-3 text-gray-500">Sin señales</td></tr>';
}

// ---------- Reloj ----------
setInterval(() => { $('clock').textContent = hhmmss(serverNow()); tickCountdowns(); renderAnalysisBar(); }, 250);

// ---------- Pares ----------
function buildAssets(list) {
  const keep = new Set(selectedAssets());
  $('assets').innerHTML = list.map((a) =>
    `<label class="flex items-center gap-2"><input type="checkbox" value="${esc(a)}" ${keep.has(a) ? 'checked' : ''}> ${esc(a)}</label>`).join('');
  $('assetList').innerHTML = list.map((a) => `<option value="${esc(a)}">`).join('');
}

// ---------- Copiar señales ----------
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
async function copyText(t) {
  if (!t) { $('msg').textContent = 'No hay señales para copiar'; return; }
  try { await navigator.clipboard.writeText(t); } catch {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  $('msg').textContent = 'Copiado ✓';
  setTimeout(() => { if ($('msg').textContent === 'Copiado ✓') $('msg').textContent = ''; }, 2000);
}
const signalText = (s) =>
  `${s.direction === 'CALL' ? '🟢 CALL ▲' : '🔴 PUT ▼'} ${s.asset} · ${s.tf}\nEntrada: ${hhmm(s.entryTime)} · Expira: ${hhmm(s.expiryTime)}\nHasta 1 Martingala`;

// ---------- Análisis ----------
function sessionSignals() {
  const ids = (state.session && state.session.signalIds) || [];
  return ids.map((id) => state.signals.get(id)).filter(Boolean).sort((a, b) => a.entryTime - b.entryTime);
}
function listText(sigs) {
  if (!sigs.length) return '';
  const head = `📊 SEÑALES · ${sigs[0].tf} · ${sigs[0].broker === 'exnova' ? 'Exnova' : 'IQ Option'}`;
  return [head, ...sigs.map((s) => `${hhmm(s.entryTime)}  ${s.asset}  ${s.direction}`), 'Entrada en la vela indicada · hasta 1 Martingala'].join('\n');
}
function renderAnalysis() {
  const text = listText(sessionSignals());
  const el = $('anList');
  el.dataset.text = text;
  el.textContent = text || (state.session ? 'Analizando… todavía no hay una lectura clara de acción del precio en estos pares.' : 'Sin análisis todavía. Marca pares (o escribe uno) y pulsa Analizar.');
  renderAnalysisBar();
}
function renderAnalysisBar() {
  const ss = state.session;
  if (!ss) { $('anStatus').textContent = ''; $('anBar').style.width = '0%'; return; }
  const left = Math.max(0, ss.endsAt - serverNow());
  const total = Math.max(1, ss.endsAt - ss.startedAt);
  if (ss.active && left > 0) {
    const s = Math.ceil(left / 1000);
    $('anStatus').textContent = `Analizando ${ss.pairs.join(', ')} · ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    $('anBar').style.width = `${100 - (left / total) * 100}%`;
  } else {
    const sigs = sessionSignals();
    const calls = sigs.filter((x) => x.direction === 'CALL').length;
    $('anStatus').textContent = `Finalizado · ${sigs.length} señales (${calls} CALL / ${sigs.length - calls} PUT)`;
    $('anBar').style.width = '100%';
  }
}
$('btnAnalyze').addEventListener('click', async () => {
  unlockAudio();
  const pairs = new Set(selectedAssets());
  const custom = $('customPair').value.trim();
  if (custom) pairs.add(custom);
  if (!pairs.size) { $('msg').textContent = 'Marca o escribe al menos un par'; return; }
  const ok = await api('/api/analyze', { pairs: [...pairs], minutes: Number($('anMinutes').value) });
  if (ok) $('customPair').value = '';
});
$('btnClear').addEventListener('click', () => {
  if (confirm('¿Borrar todo el historial de señales y las estadísticas? Esta acción no se puede deshacer.')) api('/api/signals/clear');
});
$('btnStopAn').addEventListener('click', () => api('/api/analyze/stop'));
$('btnCopyAll').addEventListener('click', () => copyText($('anList').dataset.text || ''));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const s = state.signals.get(b.dataset.copy);
  if (s) copyText(signalText(s));
});

// ---------- Init ----------
(async function init() {
  const s = await fetch('/api/state').then((r) => r.json());
  buildAssets(s.assets);
  applyConfig(s.config); setStatus(s.status);
  connectWS();
})();
