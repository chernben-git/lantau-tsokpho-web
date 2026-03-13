// netlify/functions/asr-scoring.js
// ============================================================
// 台語發音評分 ASR 中繼 function
// 咱兜的台語 — 劍橋分析股份有限公司
// ============================================================
// 流程：
//   1. 接收 GAS 傳來的 { audioBase64 }（m4a 格式）
//   2. ffmpeg 轉換 m4a → WAV PCM s16le 16kHz mono
//   3. 登入 NYCU BRONCI ASR（File Inference API V3.5）取得 token
//   4. multipart/form-data 上傳 WAV 建立任務
//   5. 輪詢任務狀態（status=3 成功）
//   6. 下載 resultScriptFilePath（逐字稿純文字）
//   7. 回傳 { transcript }
// ============================================================

const https = require('https');
const path  = require('path');
const os    = require('os');
const fs    = require('fs');
const { execSync } = require('child_process');
const ffmpegPath    = require('ffmpeg-static');

const ASR_HOST = '140.113.30.204';
const ASR_PORT = 8451;
const ASR_USER = 'chernben';
const ASR_PASS = 'SRGER#342sd';
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

    if (status === 3) {
      console.log('[asr-scoring] task data keys=' + JSON.stringify(Object.keys(data.data[0])));
      console.log('[asr-scoring] task data=' + JSON.stringify(data.data[0]).substring(0, 500));
      return data.data[0];
    }
    if (status === 4 || status === 5) throw new Error('Task failed, status=' + status);
  }
  throw new Error('ASR timeout (120s)');
}

// ── 下載逐字稿 ────────────────────────────────────────────────
async function downloadTranscript(token, taskId) {
  const res = await httpsRequest({
    hostname: ASR_HOST, port: ASR_PORT,
    path: '/api/v1/subtitle/tasks/' + taskId + '/file?target=resultScriptFilePath',
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }
  });

  console.log('[asr-scoring] file HTTP=' + res.statusCode + ' size=' + res.body.length);
  const text = res.body.toString('utf8').trim();
  console.log('[asr-scoring] raw file content=' + text.substring(0, 200));

  // 如果是 JSON 格式，解析出純文字
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      return json.map(seg => seg.text || seg.word || seg.content || '').join('').trim();
    }
    if (json.text) return json.text.trim();
    if (json.content) return json.content.trim();
    if (json.data) return String(json.data).trim();
  } catch (_) {}

  return text;
}

// ── Netlify handler ────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let audioBase64;
  try {
    const body = JSON.parse(event.body || '{}');
    audioBase64 = body.audioBase64;
    if (!audioBase64) throw new Error('audioBase64 missing');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: e.message }) };
  }

  const tmpDir   = os.tmpdir();
  const inFile   = path.join(tmpDir, 'scoring_in_'  + Date.now() + '.m4a');
  const outFile  = path.join(tmpDir, 'scoring_out_' + Date.now() + '.wav');

  try {
    // 1. 寫入 m4a
    fs.writeFileSync(inFile, Buffer.from(audioBase64, 'base64'));

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

    // 5. 輪詢（回傳 taskObj）
    const taskObj = await pollTask(token, taskId);

    // 6. 下載逐字稿
    const transcript = await downloadTranscript(token, taskId);
    console.log('[asr-scoring] transcript="' + transcript + '"');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript })
    };

  } catch (e) {
    console.error('[asr-scoring] ERROR:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message, transcript: '' })
    };
  } finally {
    // 清理暫存檔
    try { fs.unlinkSync(inFile);  } catch (_) {}
    try { fs.unlinkSync(outFile); } catch (_) {}
  }
};
