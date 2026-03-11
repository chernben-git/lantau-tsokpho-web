/**
 * netlify/functions/asr-transcript.js
 *
 * GAS 傳來音檔 base64 + token
 * → 呼叫 NYCU ASR WebSocket
 * → 回傳逐字稿 + 時長
 *
 * GAS 呼叫：
 *   POST https://familyhistroy-tree.netlify.app/.netlify/functions/asr-transcript
 *   Body: { "audioBase64": "...", "token": "Bearer eyJ..." }
 *
 * 回傳：
 *   { "transcript": "食飽未", "duration_sec": 5.2, "char_count": 3 }
 */

const https     = require('https');
const WebSocket = require('ws');

const ASR_HOST         = '140.113.30.204';
const ASR_PORT         = 8451;
const ACCESS_INFO_PATH = '/api/v1/streaming/transcript/access-info';
const WS_TIMEOUT_MS    = 20000;  // 20秒逾時

// ── 主處理函數 ─────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { audioBase64, token } = body;
  if (!audioBase64 || !token) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing audioBase64 or token' }) };
  }

  try {
    // Step 1：用 token 換取一次性 ticket
    const ticket = await getAsrTicket(token);
    if (!ticket) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Failed to get ASR ticket' }) };
    console.log('ticket:', ticket.substring(0, 40) + '...');

    // Step 2：音檔 base64 → Buffer
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    console.log('audio size:', audioBuffer.length, 'bytes');

    // Step 3：WebSocket 送音檔，等逐字稿
    const result = await transcribeViaWebSocket(ticket, audioBuffer);
    console.log('result:', JSON.stringify(result));

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error('ASR error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, transcript: '', duration_sec: 0, char_count: 0 }) };
  }
};


// ── Step 1：取 ticket ──────────────────────────────────────────
function getAsrTicket(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ASR_HOST,
      port:     ASR_PORT,
      path:     ACCESS_INFO_PATH,
      method:   'GET',
      headers:  { 'Authorization': token, 'Accept': 'application/json' },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json   = JSON.parse(data);
          const ticket = json.data && json.data[0] && json.data[0].ticket;
          resolve(ticket || null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}


// ── Step 2：WebSocket 送音檔，等逐字稿 ─────────────────────────
function transcribeViaWebSocket(ticket, audioBuffer) {
  return new Promise((resolve) => {
    const wsUrl = `wss://${ASR_HOST}:${ASR_PORT}/ws/v1/transcript?ticket=${encodeURIComponent(ticket)}&type=raw&rate=16000`;
    const ws    = new WebSocket(wsUrl, { rejectUnauthorized: false });

    let parts    = [];
    let resolved = false;
    const t0     = Date.now();

    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      ws.terminate();
      const transcript   = parts.length > 0 ? parts[parts.length - 1] : '';
      const duration_sec = Math.round((Date.now() - t0) / 100) / 10;
      const char_count   = transcript.replace(/\s/g, '').length;
      resolve({ transcript, duration_sec, char_count });
    };

    const timer = setTimeout(() => { console.log('WS timeout'); done(); }, WS_TIMEOUT_MS);

    ws.on('open', () => {
      console.log('WS connected, sending audio...');
      const CHUNK = 4096;
      for (let i = 0; i < audioBuffer.length; i += CHUNK) {
        ws.send(audioBuffer.slice(i, i + CHUNK));
      }
      ws.send(Buffer.alloc(0));  // 結束訊號
    });

    ws.on('message', (data) => {
      try {
        const msg  = JSON.parse(data.toString());
        const text = msg.transcript || msg.text || msg.result || '';
        const isFinal = msg.type === 'final' || msg.isFinal === true || msg.is_final === true || msg.type === 'end';
        if (text) parts.push(text);
        if (isFinal) done();
      } catch(e) {
        const text = data.toString().trim();
        if (text) parts.push(text);
      }
    });

    ws.on('close', done);
    ws.on('error', (err) => { console.error('WS error:', err.message); done(); });
  });
}
