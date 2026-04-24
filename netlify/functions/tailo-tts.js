/**
 * netlify/functions/tailo-tts.js
 * 台羅直接念語音合成 v1.1
 * 2026/4/24 修正版
 * 
 * v1.1 修正：
 *   - 符號調 → 數字調改為「以音節為單位」的轉換
 *   - 例：thài-iông → thai3-iong5 (正確)
 *   - 之前錯誤是 thà i → tha3i (數字塞在字母中間)
 */

const https = require('https');
const { execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const TTS_HOST = 'syn.ivoice.tw';
const TTS_PORT = 8461;
const USERNAME = 'chernben';
const PASSWORD = 'SRGER#342sd';

let _cachedToken = null;
let _cachedTime  = 0;

// ═══════════════════════════════════════════════════════════
// 聲調符號對應表
// key: 變音字元 → value: [基本字元, 聲調數字]
// ═══════════════════════════════════════════════════════════
const TONE_MAP = {
  // 2 聲
  'á':['a',2], 'é':['e',2], 'í':['i',2], 'ó':['o',2], 'ú':['u',2], 'ḿ':['m',2], 'ń':['n',2],
  'Á':['A',2], 'É':['E',2], 'Í':['I',2], 'Ó':['O',2], 'Ú':['U',2], 'Ḿ':['M',2], 'Ń':['N',2],
  // 3 聲
  'à':['a',3], 'è':['e',3], 'ì':['i',3], 'ò':['o',3], 'ù':['u',3], 'ǹ':['n',3],
  'À':['A',3], 'È':['E',3], 'Ì':['I',3], 'Ò':['O',3], 'Ù':['U',3], 'Ǹ':['N',3],
  // 5 聲
  'â':['a',5], 'ê':['e',5], 'î':['i',5], 'ô':['o',5], 'û':['u',5], 'm̂':['m',5], 'n̂':['n',5],
  'Â':['A',5], 'Ê':['E',5], 'Î':['I',5], 'Ô':['O',5], 'Û':['U',5],
  // 7 聲
  'ā':['a',7], 'ē':['e',7], 'ī':['i',7], 'ō':['o',7], 'ū':['u',7], 'm̄':['m',7], 'n̄':['n',7],
  'Ā':['A',7], 'Ē':['E',7], 'Ī':['I',7], 'Ō':['O',7], 'Ū':['U',7],
};

// 組合字元（U+030D）需要特殊處理：a+◌̍ = 8 聲
const COMBINING_MAP = {
  'a':8, 'e':8, 'i':8, 'o':8, 'u':8, 'm':8, 'n':8,
  'A':8, 'E':8, 'I':8, 'O':8, 'U':8, 'M':8, 'N':8,
};

/**
 * 偵測輸入格式
 */
function detectFormat(text) {
  // 有組合字元 \u030D 或變音字元 → 符號調
  if (/[áàâāéèêēíìîīóòôōúùûūǹ]/i.test(text)) return 'symbol';
  if (/\u030D/.test(text)) return 'symbol';
  // 有「字母後面接數字」→ 數字調
  if (/[a-zA-Z]+[1-9]/.test(text)) return 'number';
  return 'unknown';
}

/**
 * 符號調 → 數字調（以音節為單位）
 * 
 * 演算法：
 * 1. 逐字掃描，記錄「當前音節的字母」和「當前音節的聲調」
 * 2. 遇到非字母（空格、連字號、標點）→ 結算當前音節，加上聲調數字
 * 3. 1 聲和 4 聲沒符號，要用規則判定（有入聲尾 ptkh → 4 聲，否則 1 聲）
 */
function symbolToNumber(text) {
  let result = '';
  let syllable = '';      // 當前音節累積的基本字母
  let tone = 0;           // 當前音節的聲調（0 = 未定）
  
  function flushSyllable() {
    if (syllable.length === 0) return;
    
    let finalTone = tone;
    if (finalTone === 0) {
      // 未標聲調 → 判斷 1 聲或 4 聲
      // 4 聲規則：音節尾是 p/t/k/h（入聲）
      if (/[ptkhPTKH]$/.test(syllable)) {
        finalTone = 4;
      } else {
        finalTone = 1;
      }
    }
    
    result += syllable + finalTone;
    syllable = '';
    tone = 0;
  }
  
  const chars = [...text];  // 用 spread 避免 surrogate pair 問題
  
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    
    // ─── 處理組合字元：字母 + U+030D = 8 聲 ─────────
    if (next === '\u030D' && COMBINING_MAP[ch]) {
      syllable += ch;
      tone = 8;
      i++;  // 跳過 U+030D
      continue;
    }
    
    // ─── 處理變音字元（2/3/5/7 聲）────────────────
    if (TONE_MAP[ch]) {
      const [base, t] = TONE_MAP[ch];
      syllable += base;
      tone = t;
      continue;
    }
    
    // ─── 普通字母 ──────────────────────────────────
    if (/[a-zA-Z]/.test(ch)) {
      syllable += ch;
      continue;
    }
    
    // ─── 非字母（分隔符）→ 結算音節 ────────────────
    flushSyllable();
    result += ch;
  }
  
  // 最後一個音節
  flushSyllable();
  
  return result;
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
    tailo,
    voice = 'nan-TW-vs2-M02',
    rate  = 0.9,
    inputFormat = 'auto',
    format = 'm4a'
  } = body;

  if (!tailo || typeof tailo !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'tailo required' }) };
  }
  if (tailo.length > 1000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'tailo 最多 1000 字元' }) };
  }

  try {
    // ─── 決定要送什麼給 TTS ─────────────────────────────
    let detectedFormat = inputFormat;
    let convertedInput = tailo;

    if (inputFormat === 'auto') {
      detectedFormat = detectFormat(tailo);
    }

    if (detectedFormat === 'symbol') {
      convertedInput = symbolToNumber(tailo);
    }

    // ─── 取 Token & 合成 ────────────────────────────────
    const token = await getToken();
    if (!token) return { statusCode: 401, headers, body: JSON.stringify({ error: 'TTS login failed' }) };

    const wavBytes = await synthesizeTailo(token, convertedInput, voice, rate);
    if (!wavBytes) {
      _cachedToken = null;
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'TTS synthesis failed' }) };
    }

    // ─── 格式轉換 ───────────────────────────────────────
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
          originalInput: tailo,
          detectedFormat,
          convertedInput,
          voice,
          rate,
          sizeKB: Math.round(outputBuffer.length / 1024),
          elapsedMs: Date.now() - startTime
        }
      })
    };

  } catch(err) {
    console.error('tailo-tts error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};


function synthesizeTailo(token, tailoText, voice, rate) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      input: { text: tailoText, textType: 'plain_text' },
      voice: { model: 'broncitts', languageCode: 'nan-TW', name: voice },
      audioConfig: { speakingRate: rate },
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


async function getToken() {
  const now = Date.now();
  if (_cachedToken && (now - _cachedTime) < 28800 * 1000) return _cachedToken;

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
