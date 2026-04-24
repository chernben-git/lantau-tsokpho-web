/**
 * netlify/functions/tailo-tts.js  v2.0
 * 2026/4/24
 * 
 * 按廖教授 BRONCI TTS 規格書，零轉換。
 *   台羅拼音（數字調） → textType: 'plain_text'
 *   台語漢字           → textType: 'characters'
 * 
 * 依據：
 *   - BRONCI TTS API 規格書（廖教授提供）
 *   - server.js v2.10 線上穩定版（2026-04-06）
 * 
 * 參數：
 *   text      必填  要合成的文字
 *   textType  選填  'plain_text' (台羅, 預設) | 'characters' (台語漢字)
 *   voice     選填  預設 nan-TW-vs2-M02
 *   rate      選填  預設 1.0
 *   format    選填  m4a | wav，預設 m4a
 */

const https = require('https');
const { execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// ═══════════════════════════════════════════════════
// 端點（依規格書）
// ═══════════════════════════════════════════════════
const TTS_HOST = 'syn.ivoice.tw';
const TTS_PORT = 8461;
const USERNAME = 'chernben';
const PASSWORD = 'SRGER#342sd';

// 語者白名單（依 /api/v1/tts/models 實際回傳）
const VOICE_LANG_MAP = {
  'nan-TW-vs2-M01':    'nan-TW',
  'nan-TW-vs2-M02':    'nan-TW',
  'nan-TW-vs2-F01':    'nan-TW',
  'nan-TW-vs2-F02':    'nan-TW',
  'cmn-TW-vs2-M01':    'cmn-TW',
  'cmn-TW-vs2-F01':    'cmn-TW',
  'hak-xi-TW-vs2-M01': 'hak-xi-TW',
  'hak-xi-TW-vs2-F01': 'hak-xi-TW',
  'hak-hoi-TW-vs2-M01':'hak-hoi-TW',
  'hak-hoi-TW-vs2-F01':'hak-hoi-TW',
};

// Token 快取（8 小時 TTL，規格書 expiration=28800）
let _cachedToken = null;
let _cachedTime  = 0;
const TOKEN_TTL  = 28800 * 1000;


// ═══════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════
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

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    text,
    textType = 'plain_text',       // ⭐ 預設台羅（plain_text）
    voice    = 'nan-TW-vs2-M02',
    rate     = 1.0,
    format   = 'm4a'
  } = body;

  if (!text || typeof text !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'text required' }) };
  }
  if (text.length > 1000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'text 最多 1000 字元' }) };
  }
  if (!['plain_text', 'characters'].includes(textType)) {
    return { statusCode: 400, headers, body: JSON.stringify({
      error: 'textType 只能 plain_text (台羅) 或 characters (台語漢字)'
    })};
  }
  const languageCode = VOICE_LANG_MAP[voice];
  if (!languageCode) {
    return { statusCode: 400, headers, body: JSON.stringify({
      error: 'voice 不在規格書語者清單',
      validVoices: Object.keys(VOICE_LANG_MAP)
    })};
  }

  try {
    const token = await getToken();
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'TTS login failed' }) };

    // 零轉換，直送廖教授 TTS
    const wavBytes = await synthesize(token, text, textType, voice, languageCode, rate);
    if (!wavBytes) {
      _cachedToken = null;
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'TTS synthesis failed' }) };
    }

    let outputBuffer = wavBytes;
    let mimeType = 'audio/wav';

    if (format === 'm4a') {
      const m4a = convertWavToM4a(wavBytes);
      if (m4a) { outputBuffer = m4a; mimeType = 'audio/mp4'; }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        audioBase64: Buffer.from(outputBuffer).toString('base64'),
        mimeType,
        meta: {
          sentText:    text,
          textType,
          voice,
          languageCode,
          rate,
          format,
          sizeKB:      Math.round(outputBuffer.length / 1024),
          elapsedMs:   Date.now() - startTime
        }
      })
    };

  } catch(err) {
    console.error('tailo-tts error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


// ═══════════════════════════════════════════════════
// 廖教授 TTS 合成（規格書範例）
// ═══════════════════════════════════════════════════
function synthesize(token, text, textType, voice, languageCode, rate) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      input:        { text, textType },
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
        'Accept':         'audio/wav',
        'Content-Length': Buffer.byteLength(payload),
      },
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error('TTS synthesize HTTP', res.statusCode, 'body=', Buffer.concat(chunks).toString('utf8').slice(0,200));
          resolve(null);
        } else {
          resolve(Buffer.concat(chunks));
        }
      });
    });
    req.on('error', (e) => { console.error('TTS req error:', e.message); resolve(null); });
    req.write(payload);
    req.end();
  });
}


// ═══════════════════════════════════════════════════
// Token 登入
// ═══════════════════════════════════════════════════
async function getToken() {
  const now = Date.now();
  if (_cachedToken && (now - _cachedTime) < TOKEN_TTL) return _cachedToken;

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      username:   USERNAME,
      password:   PASSWORD,
      rememberMe: true
    });
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
          const token = json.access_token || json.token;
          if (token) {
            _cachedToken = token;
            _cachedTime  = Date.now();
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


// ═══════════════════════════════════════════════════
// WAV → M4A
// ═══════════════════════════════════════════════════
function convertWavToM4a(wavBuffer) {
  const tmpDir  = os.tmpdir();
  const inFile  = path.join(tmpDir, `tailo_in_${Date.now()}.wav`);
  const outFile = path.join(tmpDir, `tailo_out_${Date.now()}.m4a`);

  try {
    fs.writeFileSync(inFile, wavBuffer);
    const ffmpegPath = require('ffmpeg-static');
    execSync(
      `"${ffmpegPath}" -y -i "${inFile}" -c:a aac -b:a 64k "${outFile}"`,
      { stdio: 'pipe' }
    );
    return fs.readFileSync(outFile);
  } catch(e) {
    console.error('ffmpeg error:', e.message);
    return null;
  } finally {
    try { fs.unlinkSync(inFile);  } catch(e) {}
    try { fs.unlinkSync(outFile); } catch(e) {}
  }
}
