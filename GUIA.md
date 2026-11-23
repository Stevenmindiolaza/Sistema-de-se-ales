# Señales en Vivo · IQ Option / Exnova

## Ejecución rápida
```bash
cd signals-bot
cp .env.example .env     # opcional: Telegram y SIGNAL_WINDOW
npm install && node server.js
```
Abre http://127.0.0.1:3000, elige bróker, pega el SSID, marca pares, elige M1/M5 y pulsa **Conectar**.

## Cómo obtener el SSID
1. Inicia sesión en la web del bróker (iqoption.com / exnova.com) en Chrome.
2. F12 → pestaña **Application** (Aplicación) → **Cookies** → dominio del bróker.
3. Copia el valor de la cookie llamada **ssid**.
4. Pégalo en el panel. Caduca al cerrar sesión; si ves "SSID inválido", repite el paso.

Trátalo como una contraseña: da acceso a tu cuenta. El servidor lo guarda solo en memoria y escucha solo en 127.0.0.1.

## Notas
- El protocolo WebSocket de ambos brókeres no es público: los `active_id` (en `services/brokerSocket.js`) y el formato de mensajes pueden cambiar. Si un par no llega, ajusta ese mapa.
- La señal se emite al cierre de la vela; la entrada es la apertura de la siguiente. La cuenta regresiva muestra el tiempo hasta la expiración.
- Persistencia: `data/db.json` (JSON local propio, sin dependencias nativas).
- Telegram: define TELEGRAM_TOKEN y TELEGRAM_CHAT_ID en `.env`.
