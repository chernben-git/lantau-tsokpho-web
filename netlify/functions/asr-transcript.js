/**
 * netlify/functions/asr-transcript.js
 *
 * GAS 只傳 audioBase64，Netlify 自己 login → 取 ticket → WS 轉寫
 *
 * 正確流程（參照 bronci_asr_upload_wav.sh）：
 * 1. POST /api/v1/login → token
 * 2. GET /api/v1/streaming/transcript/access-info → ticket
 * 3. WS 連線，等 code:180（服務已就緒）
 * 4. 送 WAV binary chunks
 * 5. 送 "EOS" 文字訊息
 * 6. 等 code:200 result + end:1，或 code:202/204
 */

const https        = require('https');
const WebSocket    = require('ws');
const { execSync } = require('child_process');
const fs           = require('fs');
const os           = require('os');
const path         = require('path');

const ASR_HOST = '140.113.30.204';
const ASR_PORT = 8451;
const USERNAME = 'chernben';
const PASSWORD = 'SRGER#342sd';
const WS_TIMEOUT_MS = 30000;

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

  const { audioBase64 } = body;
  if (!audioBase64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing audioBase64' }) };
  }

  const tmpDir  = os.tmpdir();
  const inFile  = path.join(tmpDir, `asr_in_${Date.now()}.m4a`);
  const outFile = path.join(tmpDir, `asr_out_${Date.now()}.wav`);

  try {
    // Step 1：並行 login + ffmpeg 轉換
    const m4aBuffer = Buffer.from(audioBase64, 'base64');
    fs.writeFileSync(inFile, m4aBuffer);
    console.log('m4a size:', m4aBuffer.length, 'bytes');

    const [token] = await Promise.all([
      asrLogin(),
      new Promise((resolve, reject) => {
        try {
          const ffmpegPath = require('ffmpeg-static');
          execSync(`"${ffmpegPath}" -y -i "${inFile}" -ac 1 -ar 16000 -c:a pcm_s16le "${outFile}"`, { stdio: 'pipe' });
          console.log('ffmpeg done, wav size:', fs.statSync(outFile).size, 'bytes');
          resolve();
        } catch(e) { reject(e); }
      })
    ]);

    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'ASR login failed' }) };
    console.log('login ok, token:', token.substring(0, 30) + '...');

    // Step 2：取 ticket
    const ticket = await getAsrTicket(token);
    if (!ticket) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Failed to get ASR ticket' }) };
    console.log('ticket:', ticket.substring(0, 40) + '...');

    const wavBuffer = fs.readFileSync(outFile);
    console.log('wav size:', wavBuffer.length, 'bytes');

    // Step 3：WebSocket 轉寫
    const result = await transcribeViaWebSocket(ticket, wavBuffer);
    console.log('result:', JSON.stringify(result));

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error('ASR error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, transcript: '', duration_sec: 0, char_count: 0 })
    };
  } finally {
    try { if (fs.existsSync(inFile))  fs.unlinkSync(inFile);  } catch(e) {}
    try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch(e) {}
  }
};


// ── Login ──────────────────────────────────────────────────────
function asrLogin() {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ username: USERNAME, password: PASSWORD });
    const req = https.request({
      hostname: ASR_HOST,
      port:     ASR_PORT,
      path:     '/api/v1/login',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json  = JSON.parse(data);
          console.log('login response code:', json.code);
          const token = json.token || json.access_token || json.accessToken || null;
          resolve(token);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}


// ── 取 ticket ─────────────────────────────────────────────────
function getAsrTicket(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ASR_HOST,
      port:     ASR_PORT,
      path:     '/api/v1/streaming/transcript/access-info',
      method:   'GET',
      headers:  { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
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


// ── WebSocket 轉寫 ─────────────────────────────────────────────
function transcribeViaWebSocket(ticket, wavBuffer) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      ticket:          ticket,
      type:            'file',
      audioFilename:   'input.wav',
      saveResult:      '0',
      enableTransient: '0',
      modelName:       'taigi-roma-0814',
    });
    const wsUrl = `wss://${ASR_HOST}:${ASR_PORT}/ws/v1/transcript?${params.toString()}`;
    const ws    = new WebSocket(wsUrl, { rejectUnauthorized: false });

    let finalSegments   = {};
    let partialSegments = {};
    let resolved = false;
    const t0     = Date.now();

    const done = (transcript) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch(e) {}
      const duration_sec = Math.round((Date.now() - t0) / 100) / 10;
      const char_count   = (transcript || '').replace(/\s/g, '').length;
      resolve({ transcript: transcript || '', duration_sec, char_count });
    };

    const timer = setTimeout(() => {
      console.log('WS timeout');
      const keys = Object.keys(finalSegments).sort();
      done(keys.map(k => finalSegments[k]).join('\n').trim());
    }, WS_TIMEOUT_MS);

    ws.on('open', () => {
      console.log('WS connected, waiting for code:180...');
    });

    ws.on('message', (data) => {
      try {
        const msg  = JSON.parse(data.toString());
        console.log('WS msg:', JSON.stringify(msg));
        const code = msg.code;

        if (code === 180) {
          // 服務已就緒，開始送 WAV
          console.log('code:180 ready, sending WAV', wavBuffer.length, 'bytes');
          const CHUNK = 320 * 1024;
          for (let i = 0; i < wavBuffer.length; i += CHUNK) {
            ws.send(wavBuffer.slice(i, i + CHUNK));
          }
          ws.send('EOS');
          console.log('WAV + EOS sent');

        } else if (code === 200) {
          const results = msg.result || [];
          for (const item of results) {
            const seg = item.segment;
            const txt = (item.transcript || '').trim();
            if (seg == null || !txt) continue;
            if (item.final === 1) {
              finalSegments[seg] = txt;
            } else {
              partialSegments[seg] = txt;
            }
          }
          if (msg.end === 1) {
            const keys = Object.keys(finalSegments).sort();
            done(keys.map(k => finalSegments[k]).join('\n').trim());
          }

        } else if (code === 202 || code === 204) {
          const keys = Object.keys(finalSegments).sort();
          done(keys.map(k => finalSegments[k]).join('\n').trim());

        } else if (code >= 400) {
          console.error('ASR error code:', code, msg.message);
          done('');
        }

      } catch(e) {
        console.log('WS raw:', data.toString().trim());
      }
    });

    ws.on('close', (code, reason) => {
      console.log('WS closed:', code, reason ? reason.toString() : '');
      if (!resolved) {
        const keys = Object.keys(finalSegments).sort();
        done(keys.map(k => finalSegments[k]).join('\n').trim());
      }
    });

    ws.on('error', (err) => {
      console.error('WS error:', err.message);
      done('');
    });
  });
}
