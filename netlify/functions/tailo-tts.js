/**
 * netlify/functions/tailo-tts.js  v3.0
 * 2026/4/24
 * 
 * 架構對齊 TTS.gs v1.8 + server.js v2.10：
 *   Netlify Function → i5 中繼 (asr.bitfull.tw) → 廖教授 TTS
 * 
 * 為什麼走 i5 不直連廖教授：
 *   - i5 有 TTS token 快取 + AppCache 60 分鐘
 *   - i5 ffmpeg 比 Netlify ffmpeg-static 穩
 *   - i5 有 /store-audio 發直播 URL（省 base64 傳輸）
 *   - Netlify Function 10 秒超時，直連廖教授常逾時
 *   - 省 Netlify 流量費
 * 
 * 參數：
 *   text      必填  要合成的文字
 *   textType  選填  'plain_text' (台羅, 預設) | 'characters' (台語漢字)
 *   voice     選填  預設 nan-TW-vs2-M02
 *   rate      選填  預設 1.0
 *   returnMode 選填 'url' (預設, 回 i5 直播 URL) | 'base64' (回完整音檔)
 * 
 * 回傳：
 *   returnMode='url':
 *     { success: true, audioUrl, textType, voice, rate, elapsedMs }
 *   returnMode='base64':
 *     { success: true, audioBase64, mimeType, textType, voice, rate, sizeKB, elapsedMs }
 */

const https = require('https');

// ═══════════════════════════════════════════════════
// i5 中繼端點（與 TTS.gs v1.8 一致）
// ═══════════════════════════════════════════════════
const I5_BASE   = 'asr.bitfull.tw';
const I5_PORT   = 443;

// 語者白名單
const VALID_VOICES = [
  'nan-TW-vs2-M01','nan-TW-vs2-M02','nan-TW-vs2-F01','nan-TW-vs2-F02',
  'cmn-TW-vs2-M01','cmn-TW-vs2-F01',
  'hak-xi-TW-vs2-M01','hak-xi-TW-vs2-F01',
  'hak-hoi-TW-vs2-M01','hak-hoi-TW-vs2-F01',
];

// speaker 別名（i5 server.js 用 male/female 簡稱）
function voiceToSpeaker(voice) {
  // M01/M02 → 'male'，F01/F02 → 'female'（i5 會轉回完整語者名）
  if (voice.includes('-M0')) return 'male';
  if (voice.includes('-F0')) return 'female';
  return 'male';
}


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
    textType   = 'plain_text',
    voice      = 'nan-TW-vs2-M02',
    rate       = 1.0,
    returnMode = 'url'
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
  if (!VALID_VOICES.includes(voice)) {
    return { statusCode: 400, headers, body: JSON.stringify({
      error: 'voice 不在語者清單',
      validVoices: VALID_VOICES
    })};
  }
  if (!['url', 'base64'].includes(returnMode)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'returnMode 只能 url 或 base64' }) };
  }

  try {
    // ─── Step 1: 呼叫 i5 /tts 取得 WAV base64 ──────
    const speaker = voiceToSpeaker(voice);
    const ttsResult = await callI5Tts(text, speaker, textType);
    if (!ttsResult || !ttsResult.audioBase64) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'i5 /tts 失敗' }) };
    }

    // ─── returnMode='base64'：直接回 WAV base64 ────
    if (returnMode === 'base64') {
      const sizeKB = Math.round(Buffer.from(ttsResult.audioBase64, 'base64').length / 1024);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          audioBase64: ttsResult.audioBase64,
          mimeType: 'audio/wav',
          textType, voice, rate,
          sizeKB,
          elapsedMs: Date.now() - startTime
        })
      };
    }

    // ─── returnMode='url'：轉 M4A + 存 i5 → 回 URL ──
    const wavBase64 = ttsResult.audioBase64;
    
    const m4aResult = await callI5ConvertAudio(wavBase64);
    if (!m4aResult || !m4aResult.m4aBase64) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'i5 convert-audio 失敗' }) };
    }

    const contentId = 'TAILOTTS_' + Date.now();
    const storeResult = await callI5StoreAudio(m4aResult.m4aBase64, contentId);
    if (!storeResult || !storeResult.url) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'i5 store-audio 失敗' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        audioUrl: storeResult.url,
        textType, voice, rate,
        elapsedMs: Date.now() - startTime
      })
    };

  } catch(err) {
    console.error('tailo-tts error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


// ═══════════════════════════════════════════════════
// 呼叫 i5 /tts（與 TTS.gs synthesizeTtsToUrl 同款）
// ═══════════════════════════════════════════════════
function callI5Tts(text, speaker, textType) {
  return postJson('/tts', { text, speaker, textType });
}

// ═══════════════════════════════════════════════════
// 呼叫 i5 /convert-audio（WAV→M4A）
// ═══════════════════════════════════════════════════
function callI5ConvertAudio(wavBase64) {
  return postJson('/convert-audio', { wavBase64 });
}

// ═══════════════════════════════════════════════════
// 呼叫 i5 /store-audio（存檔 → 直播 URL）
// ═══════════════════════════════════════════════════
function callI5StoreAudio(m4aBase64, contentId) {
  const fileName = contentId + '.m4a';
  return postJson('/store-audio', { m4aBase64, fileName });
}


// ═══════════════════════════════════════════════════
// HTTPS POST JSON（共用）
// ═══════════════════════════════════════════════════
function postJson(path, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: I5_BASE,
      port:     I5_PORT,
      path,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 25000,    // 25 秒（Netlify free plan 10 秒, pro 26 秒上限）
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          console.error('i5', path, 'HTTP', res.statusCode, text.slice(0,200));
          resolve(null);
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch(e) { console.error('i5', path, 'JSON parse error'); resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('i5', path, 'req error:', e.message); resolve(null); });
    req.on('timeout', () => { console.error('i5', path, 'timeout'); req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}
