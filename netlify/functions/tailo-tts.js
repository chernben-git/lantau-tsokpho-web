/**
 * netlify/functions/tailo-tts.js  v3.1
 * 2026/4/24
 * 
 * v3.1 變更：
 *   - textType 預設改為 'roma'（廖教授官方介面實證的台羅 textType）
 *   - 接受 'roma' | 'characters' | 'plain_text'
 *   - 支援 shortPause / longPause 參數（單位毫秒）
 *   - 走 i5 中繼（asr.bitfull.tw）需 i5 server.js v2.11
 * 
 * 廖教授官方介面 syn.ivoice.tw:8461/generate 抓包確認：
 *   "中文" → ?
 *   "漢字" → textType: 'characters'
 *   "拼音" → textType: 'roma'   ← 台羅就用這個
 * 
 * 參數：
 *   text         必填  要合成的文字
 *   textType     選填  'roma' (台羅, 預設) | 'characters' (台語漢字) | 'plain_text'
 *   voice        選填  預設 nan-TW-vs2-M02
 *   rate         選填  預設 1.0  (i5 v2.11 起暴露)
 *   shortPause   選填  毫秒，預設不傳（廖教授後端預設 150）
 *   longPause    選填  毫秒，預設不傳（廖教授後端預設 300）
 *   returnMode   選填  'url' (預設, 回 i5 直播 URL) | 'base64' (回 WAV base64)
 * 
 * 回傳：
 *   returnMode='url':
 *     { success, audioUrl, textType, voice, elapsedMs }
 *   returnMode='base64':
 *     { success, audioBase64, mimeType, textType, voice, sizeKB, elapsedMs }
 */

const https = require('https');

const I5_BASE = 'asr.bitfull.tw';
const I5_PORT = 443;

const VALID_VOICES = [
  'nan-TW-vs2-M01','nan-TW-vs2-M02','nan-TW-vs2-F01','nan-TW-vs2-F02',
  'cmn-TW-vs2-M01','cmn-TW-vs2-F01',
  'hak-xi-TW-vs2-M01','hak-xi-TW-vs2-F01',
  'hak-hoi-TW-vs2-M01','hak-hoi-TW-vs2-F01',
];

const VALID_TEXT_TYPES = ['roma', 'characters', 'plain_text'];

function voiceToSpeaker(voice) {
  // 對齊 i5 server.js v2.11，仍然用 male/female 兩值；
  // 真正的 voice mapping 在 i5 內部 VOICE_NAME 表
  if (voice.includes('-M0')) return 'male';
  if (voice.includes('-F0')) return 'female';
  return 'male';
}


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
    textType   = 'roma',
    voice      = 'nan-TW-vs2-M02',
    shortPause,
    longPause,
    returnMode = 'url'
  } = body;

  if (!text || typeof text !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'text required' }) };
  }
  if (text.length > 1000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'text 最多 1000 字元' }) };
  }
  if (!VALID_TEXT_TYPES.includes(textType)) {
    return { statusCode: 400, headers, body: JSON.stringify({
      error: 'textType 只能 roma (台羅) / characters (台語漢字) / plain_text',
      got: textType
    })};
  }
  if (!VALID_VOICES.includes(voice)) {
    return { statusCode: 400, headers, body: JSON.stringify({
      error: 'voice 不在語者清單',
      validVoices: VALID_VOICES
    })};
  }

  try {
    // ─── Step 1: i5 /tts ──────────────────────────
    const speaker = voiceToSpeaker(voice);
    const ttsPayload = { text, speaker, textType };
    if (typeof shortPause === 'number') ttsPayload.shortPause = shortPause;
    if (typeof longPause  === 'number') ttsPayload.longPause  = longPause;

    const ttsResult = await postJson('/tts', ttsPayload);
    if (!ttsResult || !ttsResult.success || !ttsResult.audioBase64) {
      return { statusCode: 500, headers, body: JSON.stringify({
        error: 'i5 /tts 失敗',
        i5Response: ttsResult
      })};
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
          textType, voice,
          sizeKB,
          elapsedMs: Date.now() - startTime
        })
      };
    }

    // ─── Step 2: convert-audio WAV→M4A ─────────────
    const m4aResult = await postJson('/convert-audio', { wavBase64: ttsResult.audioBase64 });
    if (!m4aResult || !m4aResult.m4aBase64) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'i5 convert-audio 失敗' }) };
    }

    // ─── Step 3: store-audio → 直播 URL ────────────
    const contentId = 'TAILOTTS_' + Date.now();
    const storeResult = await postJson('/store-audio', {
      m4aBase64: m4aResult.m4aBase64,
      fileName:  contentId + '.m4a'
    });
    if (!storeResult || !storeResult.url) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'i5 store-audio 失敗' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        audioUrl: storeResult.url,
        textType, voice,
        elapsedMs: Date.now() - startTime
      })
    };

  } catch(err) {
    console.error('tailo-tts error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


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
      timeout: 25000,
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
