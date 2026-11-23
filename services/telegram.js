'use strict';
/** Envío a Telegram con fetch nativo (Node 20). Se activa si hay TELEGRAM_TOKEN y TELEGRAM_CHAT_ID. */
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' })
    });
    return r.ok;
  } catch (e) {
    console.error('[telegram]', e.message);
    return false;
  }
}
module.exports = { sendTelegram };
