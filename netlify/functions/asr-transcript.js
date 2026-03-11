/**
 * netlify/functions/asr-transcript.js
 *
 * GAS 傳來音檔 base64 (m4a) + token
 * → ffmpeg 轉換 m4a → raw PCM 16kHz 單聲道
 * → 呼叫 NYCU ASR WebSocket (type=raw)
 * → 回傳逐字稿 + 時長
 */

const https        = require('https');
const WebSocket    = require('ws');
const { execSync } = require('child_process');
const fs           = require('fs');
const os           = require('os');
const path         = require('path');

const ASR_HOST         = '140.113.30.204';
const ASR_PORT         = 8451;
const ACCESS_INFO_PATH = '/api/v1/streaming/transcript/access-info';
const WS_TIMEOUT_MS    = 25000;

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

  const tmpDir  = os.tmpdir();
  const inFile  = path.join(tmpDir, `asr_in_${Date.now()}.m4a`);
  const outFile = path.join(tmpDir, `asr_out_${Date.now()}`);

  try {
    // Step 1：取 ticket
    const ticket = await getAsrTicket(token);
    if (!ticket) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Failed to get ASR ticket' }) };
    console.log('ticket:', ticket.substring(0, 40) + '...');

    // Step 2：m4a → raw PCM 16kHz 單聲道
    const m4aBuffer = Buffer.from(audioBase64, 'base64');
    fs.writeFileSync(inFile, m4aBuffer);
    console.log('m4a size:', m4aBuffer.length, 'bytes');

    const ffmpegPath = require('ffmpeg-static');
    execSync(`"${ffmpegPath}" -y -i "${inFile}" -ar 16000 -ac 1 -acodec pcm_s16le "${outFile}.wav"`, {
      stdio: 'pipe'
    });

    const pcmBuffer = fs.readFileSync(outFile + '.wav');
    console.log('wav size:', pcmBuffer.length, 'bytes');

    // Step 3：WebSocket 送 raw PCM
    const result = await transcribeViaWebSocket(ticket, pcmBuffer);
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
    try { if (fs.existsSync(outFile + '.wav')) fs.unlinkSync(outFile + '.wav'); } catch(e) {}
  }
};


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


function transcribeViaWebSocket(ticket, pcmBuffer) {
  return new Promise((resolve) => {
    const wsUrl = `wss://${ASR_HOST}:${ASR_PORT}/ws/v1/transcript?ticket=${encodeURIComponent(ticket)}&type=file`;
    const ws    = new WebSocket(wsUrl, { rejectUnauthorized: false });

    let parts    = [];
    let resolved = false;
    const t0     = Date.now();

    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch(e) {}
      const transcript   = parts.length > 0 ? parts[parts.length - 1] : '';
      const duration_sec = Math.round((Date.now() - t0) / 100) / 10;
      const char_count   = transcript.replace(/\s/g, '').length;
      resolve({ transcript, duration_sec, char_count });
    };

    const timer = setTimeout(() => { console.log('WS timeout'); done(); }, WS_TIMEOUT_MS);

    ws.on('open', () => {
      console.log('WS connected, sending WAV', pcmBuffer.length, 'bytes');
      const CHUNK = 4096;
      for (let i = 0; i < pcmBuffer.length; i += CHUNK) {
        ws.send(pcmBuffer.slice(i, i + CHUNK));
      }
      ws.close();  // 送完 wav 關閉連線
      console.log('wav sent, ws closed, waiting for transcript...');
    });

    ws.on('message', (data) => {
      try {
        const msg  = JSON.parse(data.toString());
        console.log('WS msg:', JSON.stringify(msg));
        const text    = msg.transcript || msg.text || msg.result || '';
        const isFinal = msg.type === 'final' || msg.isFinal === true ||
                        msg.is_final === true || msg.type === 'end' ||
                        msg.status === 'end';
        if (text) parts.push(text);
        if (isFinal) done();
      } catch(e) {
        const text = data.toString().trim();
        console.log('WS raw:', text);
        if (text) parts.push(text);
      }
    });

    ws.on('close', (code, reason) => {
      console.log('WS closed:', code, reason ? reason.toString() : '');
      done();
    });
    ws.on('error', (err) => {
      console.error('WS error:', err.message);
      done();
    });
  });
}
