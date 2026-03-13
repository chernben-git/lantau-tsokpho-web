// netlify/functions/asr-scoring.js
// ============================================================
// 台語發音評分 ASR 中繼 function
// 咱兜的台語 — 劍橋分析股份有限公司
// ============================================================
// 流程：
//   1. 接收 GAS 傳來的 { messageId, lineToken }
//   2. 從 LINE API 下載音檔（m4a）
//   3. ffmpeg 轉換 m4a → WAV PCM s16le 16kHz mono
//   4. 登入 NYCU BRONCI ASR（File Inference API V3.5）取得 token
//   5. multipart/form-data 上傳 WAV 建立任務
//   6. 輪詢任務狀態（status=3 成功）
//   7. 下載 resultScriptFilePath（逐字稿純文字）
//   8. 回傳 { transcript }
// ============================================================

const https = require('https');
const http  = require('http');
const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const { execSync } = require('child_process');
const ffmpegPath    = require('ffmpeg-static');

const ASR_HOST  = '140.113.30.204';
const ASR_PORT  = 8451;
const ASR_USER  = 'chernben';
const ASR_PASS  = 'SRGER#342sd';
const ASR_MODEL = 'taigi-roma-0814';

// ── HTTPS helper（忽略自簽憑證）──────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    options.rejectUnauthorized = false;
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, body: raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── 從 LINE API 下載音檔 ──────────────────────────────────────
function downloadLineAudio(messageId, lineToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api-data.line.me',
      path: '/v2/bot/message/' + messageId + '/content',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + lineToken }
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        console.log('[asr-scoring] LINE audio HTTP=' + res.statusCode + ' size=' + buf.length);
        if (res.statusCode !== 200) {
          reject(new Error('LINE download failed HTTP ' + res.statusCode));
        } else {
          resolve(buf);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 登入取 token ──────────────────────────────────────────────
async function getToken() {
  const payload = Buffer.from(JSON.stringify({
    username: ASR_USER,
    password: ASR_PASS,
    rememberMe: 0
  }));
  const res = await httpsRequest({
    hostname: ASR_HOST, port: ASR_PORT,
    path: '/api/v1/login', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': payload.length
    }
  }, payload);
  const data = JSON.parse(res.body.toString());
  if (data.code !== 200) throw new Error('ASR login failed: ' + JSON.stringify(data));
  return data.token;
}

// ── 建立任務（multipart/form-data）────────────────────────────
async function createTask(token, wavBuffer) {
  const boundary = '----NetlifyASR' + Date.now();
  const CRLF = '\r\n';

  const fields = [
    ['sourceType', '2'],
    ['title',      'scoring-' + Date.now()],
    ['modelName',  ASR_MODEL],
    ['dspMode',    '1'],
  ];

  let textParts = Buffer.alloc(0);
  for (const [name, value] of fields) {
    const part =
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="' + name + '"' + CRLF + CRLF +
      value + CRLF;
    textParts = Buffer.concat([textParts, Buffer.from(part)]);
  }

  const audioHeader = Buffer.from(
    '--' + boundary + CRLF +
    'Content-Disposition: form-data; name="audio"; filename="voice.wav"' + CRLF +
    'Content-Type: audio/wav' + CRLF + CRLF
  );
  const closing = Buffer.from(CRLF + '--' + boundary + '--' + CRLF);

  const body = Buffer.concat([textParts, audioHeader, wavBuffer, closing]);

  const res = await httpsRequest({
    hostname: ASR_HOST, port: ASR_PORT,
    path: '/api/v1/subtitle/tasks', method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length
    }
  }, body);

  const data = JSON.parse(res.body.toString());
  if (data.code !== 200) throw new Error('Create task failed: ' + JSON.stringify(data));
  return data.id;
}

// ── 輪詢任務狀態 ──────────────────────────────────────────────
async function pollTask(token, taskId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 4000));

    const res = await httpsRequest({
      hostname: ASR_HOST, port: ASR_PORT,
      path: '/api/v1/subtitle/tasks/' + taskId, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    });

    const data = JSON.parse(res.body.toString());
    if (data.code !== 200 || !data.data || !data.data[0]) continue;

    const status = data.data[0].status;
    console.log('[asr-scoring] poll taskId=' + taskId + ' status=' + status);

    if (status === 3) return data.data[0];
    if (status === 4 || status === 5) throw new Error('Task failed, status=' + status);
  }
  throw new Error('ASR timeout (120s)');
}

// ── 下載逐字稿 ────────────────────────────────────────────────
async function downloadTranscript(token, taskId, taskObj) {
  if (taskObj && taskObj.resultComment && taskObj.resultScriptFileExist === 0) {
    console.log('[asr-scoring] no script: ' + taskObj.resultComment);
    return { text: '', error: taskObj.resultComment };
  }

  const res = await httpsRequest({
    hostname: ASR_HOST, port: ASR_PORT,
    path: '/api/v1/subtitle/tasks/' + taskId + '/file?target=resultScriptFilePath',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  });

  const raw = res.body.toString('utf8').trim();
  console.log('[asr-scoring] file HTTP=' + res.statusCode + ' len=' + raw.length + ' preview=' + raw.substring(0, 100));

  if (!raw) return { text: '', error: 'empty' };

  try {
    const json = JSON.parse(raw);
    if (Array.isArray(json)) {
      return { text: json.map(s => s.text || s.word || s.content || '').join('').trim() };
    }
    if (json.text) return { text: json.text.trim() };
    if (json.content) return { text: json.content.trim() };
  } catch (_) {}

  return { text: raw };
}

// ── Netlify handler ────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let messageId, lineToken;
  try {
    const body = JSON.parse(event.body || '{}');
    messageId = body.messageId;
    lineToken = body.lineToken;
    if (!messageId) throw new Error('messageId missing');
    if (!lineToken) throw new Error('lineToken missing');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: e.message }) };
  }

  const tmpDir  = os.tmpdir();
  const inFile  = path.join(tmpDir, 'scoring_in_'  + Date.now() + '.m4a');
  const outFile = path.join(tmpDir, 'scoring_out_' + Date.now() + '.wav');

  try {
    // 1. 從 LINE 下載音檔
    const audioBuffer = await downloadLineAudio(messageId, lineToken);
    fs.writeFileSync(inFile, audioBuffer);

    // 2. ffmpeg 轉 WAV PCM s16le 16kHz mono
    execSync(
      `"${ffmpegPath}" -y -i "${inFile}" -ac 1 -ar 16000 -c:a pcm_s16le "${outFile}"`,
      { timeout: 30000 }
    );
    const wavBuffer = fs.readFileSync(outFile);
    console.log('[asr-scoring] WAV size:', wavBuffer.length);

    // 3. 登入
    const token = await getToken();
    console.log('[asr-scoring] token OK');

    // 4. 建立任務
    const taskId = await createTask(token, wavBuffer);
    console.log('[asr-scoring] taskId=' + taskId);

    // 5. 輪詢
    const taskObj = await pollTask(token, taskId);

    // 6. 下載逐字稿
    const result = await downloadTranscript(token, taskId, taskObj);
    console.log('[asr-scoring] transcript="' + result.text + '"' + (result.error ? ' error=' + result.error : ''));

    if (!result.text && result.error && result.error.includes('音檔長度過短')) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: '', error: 'TOO_SHORT' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: result.text || '' })
    };

  } catch (e) {
    console.error('[asr-scoring] ERROR:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message, transcript: '' })
    };
  } finally {
    try { fs.unlinkSync(inFile);  } catch (_) {}
    try { fs.unlinkSync(outFile); } catch (_) {}
  }
};
