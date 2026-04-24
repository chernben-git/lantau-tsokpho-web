/**
 * netlify/functions/tailo-tts.js
 * 台羅直接念語音合成
 * 2026/4/24
 * 
 * 設計要點：
 *   1. 廖教授 TTS 是「漢字→MT→台羅→合成」的 pipeline
 *   2. 她的內部格式是「數字調」(kin1 a2 jit8)
 *   3. 我們冰焰系統用「符號調」(thài-iông, me̍k-hû)
 *   4. 所以這個 Function 要：
 *      a. 自動判斷輸入是「符號調」還是「數字調」
 *      b. 如果是符號調 → 自動轉數字調
 *      c. 送給廖教授 TTS（走 textType='tailo' 或 'phoneme'）
 * 
 * 參數：
 *   tailo     必填 台羅拼音（符號調或數字調都可）
 *   voice     可選 預設 nan-TW-vs2-M02
 *   rate      可選 預設 0.9（古文建議慢一點）
 *   inputFormat  可選 auto / symbol / number （預設 auto）
 * 
 * 回傳：
 *   {
 *     audioBase64, mimeType,
 *     meta: {
 *       originalInput:   輸入的台羅原始字串,
 *       detectedFormat:  符號調 or 數字調,
 *       convertedInput:  送給 TTS 的最終字串,
 *       voice, rate, sizeKB, elapsedMs
 *     }
 *   }
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

// ═══════════════════════════════════════════════════════
// 符號調 → 數字調 對照表
// ═══════════════════════════════════════════════════════
// 台羅聲調系統：
//   1 = 陰平 (a)        無符號
//   2 = 陰上 (á)        ́
//   3 = 陰去 (à)        ̀
//   4 = 陰入 (ah)       無符號 + 入聲尾 (-h/-p/-t/-k)
//   5 = 陽平 (â)        ̂
//   7 = 陽去 (ā)        ̄
//   8 = 陽入 (a̍h)       ̍  + 入聲尾
//   9 = 高升 (a̋)        (極少用)
//
// 常見母音對照：
//   ā ē ī ō ū = 7 聲
//   á é í ó ú = 2 聲
//   à è ì ò ù = 3 聲
//   â ê î ô û = 5 聲
//   a̍ e̍ i̍ o̍ u̍ = 8 聲 (上方加點)
// ═══════════════════════════════════════════════════════

const TONE_MARKS = {
  // 2 聲
  'á':'a2','é':'e2','í':'i2','ó':'o2','ú':'u2',
  'Á':'A2','É':'E2','Í':'I2','Ó':'O2','Ú':'U2',
  // 3 聲
  'à':'a3','è':'e3','ì':'i3','ò':'o3','ù':'u3',
  'À':'A3','È':'E3','Ì':'I3','Ò':'O3','Ù':'U3',
  // 5 聲
  'â':'a5','ê':'e5','î':'i5','ô':'o5','û':'u5',
  'Â':'A5','Ê':'E5','Î':'I5','Ô':'O5','Û':'U5',
  // 7 聲
  'ā':'a7','ē':'e7','ī':'i7','ō':'o7','ū':'u7',
  'Ā':'A7','Ē':'E7','Ī':'I7','Ō':'O7','Ū':'U7',
  // 8 聲（上方加點的變音，Unicode 組合字元）
  'a̍':'a8','e̍':'e8','i̍':'i8','o̍':'o8','u̍':'u8',
  // nn 音（鼻化）通常不變音，這裡略
};

// 偵測輸入是符號調還是數字調
function detectFormat(tailo) {
  // 有任何聲調符號 → 符號調
  const hasSymbol = /[áéíóúàèìòùâêîôûāēīōū]|[aeiou]\u030D/.test(tailo);
  // 有 syllable 結尾數字（1-9）且無聲調符號 → 數字調
  const hasNumberTone = /[a-zA-Z]+[1-9](-|$|,|\s|\.)/.test(tailo);
  
  if (hasSymbol) return 'symbol';
  if (hasNumberTone) return 'number';
  return 'unknown';  // 可能是無調的純羅馬字
}

// 符號調 → 數字調
function symbolToNumber(tailo) {
  // Step 1: 先處理組合字元 a̍ e̍ i̍ o̍ u̍（8 聲，上方加點）
  // Unicode 中這些是兩個字元：a + U+030D（Combining Vertical Line Above）
  let result = tailo
    .replace(/a\u030D/g, 'a8')
    .replace(/e\u030D/g, 'e8')
    .replace(/i\u030D/g, 'i8')
    .replace(/o\u030D/g, 'o8')
    .replace(/u\u030D/g, 'u8')
    .replace(/m\u030D/g, 'm8')
    .replace(/n\u030D/g, 'n8')
    .replace(/A\u030D/g, 'A8')
    .replace(/E\u030D/g, 'E8')
    .replace(/I\u030D/g, 'I8')
    .replace(/O\u030D/g, 'O8')
    .replace(/U\u030D/g, 'U8');
  
  // Step 2: 其他單字元變音符號
  for (const [symbol, number] of Object.entries(TONE_MARKS)) {
    if (symbol.length === 1) {
      result = result.split(symbol).join(number);
    }
  }
  
  // Step 3: 把「數字」從字母後面移到 syllable 結尾
  // 例如 "tha2i-io5ng" → "thai2-iong5"（數字應該在音節最後）
  // 這一步比較複雜，暫時假設輸入是「音節中間」而不是「音節結尾」
  // TODO: 更嚴謹的 syllable 邊界偵測
  
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
    rate  = 0.9,           // 古文預設慢一點
    inputFormat = 'auto',  // auto / symbol / number
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
    // 如果是 number 或 unknown，直接送原文

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


// ═══════════════════════════════════════════════════════════
// ⚠️ 關鍵實驗：廖教授 TTS 到底怎麼吃台羅
// ═══════════════════════════════════════════════════════════
// 
// 有兩種可能的 API 送法，我們可能都要試：
//   
// 【方案 α】送純 text（希望 TTS 內部能辨識）
//   {
//     input: { text: "thai3-iong5 tsi-ui5-ping7", textType: 'plain_text' },
//     voice: { languageCode: 'nan-TW' }
//   }
//   
// 【方案 β】可能有 textType: 'tailo' 或 'pinyin'（廖教授文件沒明說，要試）
//   {
//     input: { text: "thai3-iong5", textType: 'tailo' },  // ← 可能要這樣
//     voice: { languageCode: 'nan-TW' }
//   }
// 
// 目前先用方案 α（plain_text）試試看
// ═══════════════════════════════════════════════════════════

function synthesizeTailo(token, tailoText, voice, rate) {
  return new Promise((resolve) => {
    const languageCode = 'nan-TW';  // 台羅一定是台語
    
    const payload = JSON.stringify({
      input: {
        text: tailoText,
        textType: 'plain_text'  // TODO: 如果 TTS 支援 textType:'tailo' 改這裡
      },
      voice: { 
        model: 'broncitts', 
        languageCode, 
        name: voice 
      },
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


// ── Token（與 tts-speak.js 相同）────────────────────────
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


// ── WAV → M4A ────────────────────────────────────────────
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
