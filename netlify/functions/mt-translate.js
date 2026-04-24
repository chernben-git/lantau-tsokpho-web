/**
 * netlify/functions/mt-translate.js
 * 多語翻譯 → 台語
 * 2026/4/24
 * 
 * 支援：
 *   華語 → 台語漢字 + 台羅
 *   華語 → 客語（四縣/海陸）
 *   （英日用 Gemini 先翻華語，再送這個 API）
 * 
 * 參數：
 *   text      必填 要翻譯的文字
 *   mode      可選 翻譯模式（預設 taigi_zh_tw）
 *             - taigi_zh_tw       華 → 台語漢字
 *             - taigi_zh_py       華 → 台羅拼音（數字調）
 *             - hakka_zh_hk       華 → 客語漢字（四縣）
 *             - hakka_hailu_zh_hk 華 → 客語漢字（海陸）
 *             - hakka_hk_py_tone  客漢字 → 客拼音（調符）
 *             - hakka_hk_py       客漢字 → 客拼音（數字）
 *   both      可選 布林 (true 會回傳台語漢字+台羅兩個)
 * 
 * 回傳：
 *   {
 *     original:  原文,
 *     taigi:     台語漢字（如果 mode=taigi_zh_tw 或 both=true）,
 *     tailo:     台羅（如果 mode=taigi_zh_py 或 both=true）,
 *     mode:      使用的 mode,
 *     elapsedMs: 耗時
 *   }
 */

const https = require('https');

const MT_HOST  = '140.113.30.204';
const MT_PORT  = 8461;
const TTS_HOST = 'syn.ivoice.tw';  // login 用這個域名（較穩）
const TTS_PORT = 8461;
const USERNAME = 'chernben';
const PASSWORD = 'SRGER#342sd';

const VALID_MODES = [
  'taigi_zh_tw',
  'taigi_zh_py',
  'hakka_zh_hk',
  'hakka_hailu_zh_hk',
  'hakka_hk_py_tone',
  'hakka_hk_py'
];

// Token 快取（與 tts-speak.js 獨立）
let _cachedToken = null;
let _cachedTime  = 0;
const TOKEN_TTL  = 28800 * 1000;

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

  const { text, mode = 'taigi_zh_tw', both = false } = body;

  if (!text || typeof text !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'text required' }) };
  }
  if (text.length > 500) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'text 最多 500 字' }) };
  }
  if (!VALID_MODES.includes(mode)) {
    return { statusCode: 400, headers, body: JSON.stringify({
      error: 'mode 不在支援範圍',
      validModes: VALID_MODES
    })};
  }

  try {
    const token = await getToken();
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'MT login failed' }) };

    // 祢/你 處理（仿 prayer-translator）
    const niCount = (text.match(/祢/g) || []).length;
    const inputText = text.replace(/祢/g, '你');

    let result = { original: text, mode };

    if (both && mode === 'taigi_zh_tw') {
      // 同時撈台語漢字 + 台羅
      const [taigi, tailo] = await Promise.all([
        callTranslate(token, inputText, 'taigi_zh_tw'),
        callTranslate(token, inputText, 'taigi_zh_py')
      ]);
      result.taigi = restoreNi(taigi, niCount);
      result.tailo = tailo;
    } else {
      // 單一模式
      const output = await callTranslate(token, inputText, mode);
      // 依 mode 決定放哪個欄位
      if (mode.includes('_py')) {
        result.tailo = output;
      } else {
        result.taigi = restoreNi(output, niCount);
      }
    }

    result.elapsedMs = Date.now() - startTime;
    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error('mt-translate error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


// ── Token 取得 ──────────────────────────────────────────
async function getToken() {
  const now = Date.now();
  if (_cachedToken && (now - _cachedTime) < TOKEN_TTL) return _cachedToken;

  return new Promise((resolve) => {
    const payload = JSON.stringify({ username: USERNAME, password: PASSWORD });
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


// ── 翻譯單次呼叫 ────────────────────────────────────────
function callTranslate(token, text, mode) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ input: text });
    const req = https.request({
      hostname: MT_HOST,
      port:     MT_PORT,
      path:     `/MT/translate/${mode}`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  'Bearer ' + token,
        'Content-Length': Buffer.byteLength(payload),
      },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code == 200 || json.code == '200') {
            resolve(json.output || '');
          } else {
            reject(new Error(`MT API code=${json.code}: ${JSON.stringify(json).slice(0,200)}`));
          }
        } catch(e) { reject(new Error('MT parse error: ' + data.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}


// ── 祢/你 還原（仿 prayer-translator）────────────────
function restoreNi(taigi, niCount) {
  if (niCount === 0) return taigi;
  return taigi.replace(/你/g, '祢');
}
