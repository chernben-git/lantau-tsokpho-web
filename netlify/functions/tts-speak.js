/**
 * netlify/functions/tts-speak.js
 * 
 * 麻將對對碰遊戲 TTS 中繼
 * 前端傳 text → 這裡 login NYCU → 合成 WAV → 轉 M4A → 回傳 base64
 * 
 * 流程與 TTS.gs 完全一致，只是搬到 Netlify 讓前端可以呼叫
 */

const https    = require('https');
const { execSync } = require('child_process');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const TTS_HOST     = 'syn.ivoice.tw';
const TTS_PORT     = 8461;
const TTS_USERNAME = 'chernben';
const TTS_PASSWORD = 'SRGER#342sd';

// Token 快取（同一 Netlify instance 有效，冷啟動會重新登入）
let _cachedToken = null;
let _cachedTime  = 0;
const TOKEN_TTL  = 28800 * 1000; // 8小時

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { text } = body;
  if (!text || text.length > 200) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'text required, max 200 chars' }) };
  }

  try {
    // Step 1: 取 Token（有快取）
    const token = await getTtsToken();
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'TTS login failed' }) };

    // Step 2: 合成 WAV
    const wavBytes = await synthesizeWav(token, text);
    if (!wavBytes) {
      // Token 可能過期，清掉快取
      _cachedToken = null;
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'TTS synthesis failed' }) };
    }

    // Step 3: WAV → M4A（用 ffmpeg-static，與 asr-transcript.js 相同套件）
    const m4aBytes = convertWavToM4a(wavBytes);
    if (!m4aBytes) {
      // WAV 轉換失敗，回傳 WAV（瀏覽器大部分支援）
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: Buffer.from(wavBytes).toString('base64'),
          mimeType: 'audio/wav'
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        audioBase64: Buffer.from(m4aBytes).toString('base64'),
        mimeType: 'audio/mp4'
      })
    };

  } catch(err) {
    console.error('tts-speak error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


// ── Token 取得（有快取）──────────────────────────────────────
async function getTtsToken() {
  const now = Date.now();
  if (_cachedToken && (now - _cachedTime) < TOKEN_TTL) {
    return _cachedToken;
  }

  return new Promise((resolve) => {
    const payload = JSON.stringify({ username: TTS_USERNAME, password: TTS_PASSWORD });
    const req = https.request({
      hostname: TTS_HOST,
      port:     TTS_PORT,
      path:     '/api/v1/tts/login',
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
          const token = json.token || json.access_token || json.accessToken;
          if (token) {
            _cachedToken = token;
            _cachedTime  = Date.now();
            console.log('TTS login ok');
          }
          resolve(token || null);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}


// ── 合成 WAV ──────────────────────────────────────────────────
function synthesizeWav(token, text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      input:        { text, textType: 'plain_text' },
      voice:        { model: 'broncitts', languageCode: 'nan-TW', name: 'nan-TW-vs2-M02' },
      audioConfig:  { speakingRate: 1.0 },
      outputConfig: { streamMode: 0 }
    });

    const req = https.request({
      hostname: TTS_HOST,
      port:     TTS_PORT,
      path:     '/api/v1/tts/synthesize',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  'Bearer ' + token,
        'Content-Length': Buffer.byteLength(payload),
      },
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error('TTS synthesize HTTP', res.statusCode);
          resolve(null);
        } else {
          resolve(Buffer.concat(chunks));
        }
      });
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}


// ── WAV → M4A（與 convert-audio 相同邏輯）──────────────────
function convertWavToM4a(wavBuffer) {
  const tmpDir  = os.tmpdir();
  const inFile  = path.join(tmpDir, `tts_in_${Date.now()}.wav`);
  const outFile = path.join(tmpDir, `tts_out_${Date.now()}.m4a`);

  try {
    fs.writeFileSync(inFile, wavBuffer);
    const ffmpegPath = require('ffmpeg-static');
    execSync(
      `"${ffmpegPath}" -y -i "${inFile}" -c:a aac -b:a 64k "${outFile}"`,
      { stdio: 'pipe' }
    );
    const m4aBuffer = fs.readFileSync(outFile);
    console.log('WAV→M4A ok, size:', m4aBuffer.length);
    return m4aBuffer;
  } catch(e) {
    console.error('ffmpeg error:', e.message);
    return null;
  } finally {
    try { fs.unlinkSync(inFile);  } catch(e) {}
    try { fs.unlinkSync(outFile); } catch(e) {}
  }
}
