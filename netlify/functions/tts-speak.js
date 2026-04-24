/**
 * netlify/functions/tts-speak.js
 * 擴充版 v2.0 — 2026/4/24
 * 
 * 前端可選參數：
 *   text      必填 (最多 500 字)
 *   voice     可選 (語者名)
 *   rate      可選 (0.5 ~ 1.5, 預設 1.0)
 *   lang      可選 (預設 nan-TW；可改 cmn-TW 華語 / hak-hoi-TW 客語)
 *   format    可選 (m4a / wav，預設 m4a)
 * 
 * 語者列表（從 /api/v1/tts/models 確認）：
 *   nan-TW-vs2-M01  台語男聲 1
 *   nan-TW-vs2-M02  台語男聲 2 (原預設)
 *   nan-TW-vs2-F01  台語女聲 1
 *   nan-TW-vs2-F02  台語女聲 2
 *   cmn-TW-vs2-M01  華語男聲
 *   cmn-TW-vs2-F01  華語女聲
 *   hak-xi-TW-vs2-M01  四縣客男聲
 *   hak-xi-TW-vs2-F01  四縣客女聲
 *   hak-hoi-TW-vs2-M01  海陸客男聲
 *   hak-hoi-TW-vs2-F01  海陸客女聲
 * 
 * 回傳：
 *   {
 *     audioBase64: string,
 *     mimeType:    string ("audio/mp4" or "audio/wav"),
 *     meta: {
 *       voice:    使用的語者,
 *       rate:     實際語速,
 *       sizeKB:   檔案大小,
 *       elapsedMs: 合成耗時
 *     }
 *   }
 * 
 * 流程與 v1 一致：前端 → Netlify login NYCU → 合成 WAV → ffmpeg WAV→M4A → base64
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

// 白名單語者（防止前端亂傳造成 API 錯誤）
const VALID_VOICES = {
  'nan-TW-vs2-M01': 'nan-TW',
  'nan-TW-vs2-M02': 'nan-TW',
  'nan-TW-vs2-F01': 'nan-TW',
  'nan-TW-vs2-F02': 'nan-TW',
  'cmn-TW-vs2-M01': 'cmn-TW',
  'cmn-TW-vs2-F01': 'cmn-TW',
  'hak-xi-TW-vs2-M01': 'hak-xi-TW',
  'hak-xi-TW-vs2-F01': 'hak-xi-TW',
  'hak-hoi-TW-vs2-M01': 'hak-hoi-TW',
  'hak-hoi-TW-vs2-F01': 'hak-hoi-TW'
};

const DEFAULT_VOICE = 'nan-TW-vs2-M02';
const DEFAULT_RATE  = 1.0;
const DEFAULT_FORMAT = 'm4a';
const MAX_TEXT_LEN  = 500;  // 從 200 提升到 500（古文單句可能較長）

// Token 快取
let _cachedToken = null;
let _cachedTime  = 0;
const TOKEN_TTL  = 28800 * 1000; // 8 小時

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  const startTime = Date.now();

  // ─── Step 0: 解析 body ────────────────────────────────
  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    text,
    voice = DEFAULT_VOICE,
    rate  = DEFAULT_RATE,
    format = DEFAULT_FORMAT
  } = body;

  // ─── Step 1: 驗證參數 ─────────────────────────────────
  if (!text || typeof text !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'text required' }) };
  }
  if (text.length > MAX_TEXT_LEN) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `text 最多 ${MAX_TEXT_LEN} 字` }) };
  }
  if (!VALID_VOICES[voice]) {
    return { statusCode: 400, headers, body: JSON.stringify({
      error: 'voice 不在白名單內',
      validVoices: Object.keys(VALID_VOICES)
    })};
  }
  const numRate = parseFloat(rate);
  if (isNaN(numRate) || numRate < 0.5 || numRate > 1.5) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'rate 必須在 0.5 ~ 1.5' }) };
  }
  if (!['m4a', 'wav'].includes(format)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'format 只能 m4a 或 wav' }) };
  }

  const languageCode = VALID_VOICES[voice];  // 自動從 voice 推導 languageCode

  try {
    // ─── Step 2: 取 Token ───────────────────────────────
    const token = await getTtsToken();
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'TTS login failed' }) };

    // ─── Step 3: 合成 WAV ───────────────────────────────
    const wavBytes = await synthesizeWav(token, text, voice, languageCode, numRate);
    if (!wavBytes) {
      _cachedToken = null;  // Token 可能過期，清掉快取
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'TTS synthesis failed' }) };
    }

    // ─── Step 4: 依 format 決定輸出 ─────────────────────
    let outputBuffer = wavBytes;
    let mimeType = 'audio/wav';

    if (format === 'm4a') {
      const m4aBytes = convertWavToM4a(wavBytes);
      if (m4aBytes) {
        outputBuffer = m4aBytes;
        mimeType = 'audio/mp4';
      }
      // 轉換失敗退回 WAV
    }

    const elapsedMs = Date.now() - startTime;
    const sizeKB = Math.round(outputBuffer.length / 1024);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        audioBase64: Buffer.from(outputBuffer).toString('base64'),
        mimeType,
        meta: {
          voice,
          rate: numRate,
          format,
          sizeKB,
          elapsedMs,
          textLength: text.length
        }
      })
    };

  } catch(err) {
    console.error('tts-speak error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


// ── Token 取得（有快取，與 v1 相同）──────────────────────
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


// ── 合成 WAV（v2 支援參數）──────────────────────────────
function synthesizeWav(token, text, voice, languageCode, rate) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      input:        { text, textType: 'plain_text' },
      voice:        { model: 'broncitts', languageCode, name: voice },
      audioConfig:  { speakingRate: rate },
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


// ── WAV → M4A ────────────────────────────────────────────
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
