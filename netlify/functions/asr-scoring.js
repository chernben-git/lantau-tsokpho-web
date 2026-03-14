// netlify/functions/asr-scoring.js
// ============================================================
// 台語發音評分 - 使用 GOP API (gop.nptu.edu.tw)
// 咱兜的台語 — 劍橋分析股份有限公司
// ============================================================
// 流程：
//   1. 接收 GAS 傳來的 { messageId, lineToken, taigiText, tailoText }
//   2. 從 LINE API 下載音檔（m4a）
//   3. ffmpeg 轉換 m4a → WAV PCM s16le 16kHz mono
//   4. POST 到 gop.nptu.edu.tw/api/v1/score
//   5. 回傳 { scores, totalScore }
// ============================================================

const https  = require('https');
const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { execSync } = require('child_process');
const ffmpegPath    = require('ffmpeg-static');

const RELAY_URL = 'https://asr.bitfull.tw/asr';

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

// ── 呼叫 GOP API ──────────────────────────────────────────────
function callGopApi(wavBuffer, ansStr, ansTL) {
  return new Promise((resolve, reject) => {
    const boundary = '----GopBoundary' + Date.now();
    const CRLF = '\r\n';

    const fileHeader = Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="file"; filename="voice.wav"' + CRLF +
      'Content-Type: audio/wav' + CRLF + CRLF
    );
    const closing = Buffer.from(CRLF + '--' + boundary + '--' + CRLF);
    const body = Buffer.concat([fileHeader, wavBuffer, closing]);

    const ansTLEncoded = encodeURIComponent(ansTL);
    const ansStrEncoded = encodeURIComponent(ansStr);
    const queryPath = '/api/v1/score?ans_str=' + ansStrEncoded + '&ans_TL=' + ansTLEncoded;

    console.log('[asr-scoring] GOP path=' + queryPath.substring(0, 80));

    const options = {
      hostname: GOP_HOST,
      path: queryPath,
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        console.log('[asr-scoring] GOP HTTP=' + res.statusCode + ' len=' + raw.length);
        if (res.statusCode !== 200) {
          reject(new Error('GOP API failed HTTP ' + res.statusCode + ': ' + raw.substring(0, 200)));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch(e) {
          reject(new Error('GOP JSON parse failed: ' + raw.substring(0, 100)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 計算總分 ──────────────────────────────────────────────────
function calcTotalScore(gopResult) {
  if (!Array.isArray(gopResult) || gopResult.length === 0) return 0;

  // 過濾掉 SIL（靜音）
  const syllables = gopResult.filter(s => s.syllable !== 'SIL' && s.gop_score !== undefined);
  if (syllables.length === 0) return 0;

  const avg = syllables.reduce((sum, s) => sum + (s.gop_score || 0), 0) / syllables.length;
  // GOP 分數通常是 0~100，直接用
  return Math.min(100, Math.max(0, Math.round(avg)));
}

// ── 產生逐音節結果摘要 ──────────────────────────────────────
function buildSyllableSummary(gopResult) {
  if (!Array.isArray(gopResult)) return [];
  return gopResult
    .filter(s => s.syllable !== 'SIL')
    .map(s => ({
      syllable: s.syllable || '',
      score: Math.round(s.gop_score || 0),
      status: (s.gop_score || 0) >= 60 ? 'ok' : 'wrong'
    }));
}

// ── Netlify handler ────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let messageId, lineToken, taigiText, tailoText;
  try {
    const body = JSON.parse(event.body || '{}');
    messageId = body.messageId;
    lineToken  = body.lineToken;
    taigiText  = body.taigiText  || '';
    tailoText  = body.tailoText  || '';
    if (!messageId) throw new Error('messageId missing');
    if (!lineToken)  throw new Error('lineToken missing');
    if (!taigiText)  throw new Error('taigiText missing');
    if (!tailoText)  throw new Error('tailoText missing');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: e.message }) };
  }

  try {
    // 轉發給中繼伺服器處理
    console.log('[asr-scoring] 轉發到中繼伺服器 messageId=' + messageId);
    const relayResp = await fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, lineToken })
    });
    const relayData = await relayResp.json();
    console.log('[asr-scoring] 中繼回傳 transcript="' + (relayData.transcript || '') + '"');

    if (!relayResp.ok) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: relayData.error || 'relay failed' })
      };
    }

    if (relayData.error === 'TOO_SHORT') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: '', error: 'TOO_SHORT' })
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: relayData.transcript || '' })
    };

  } catch (e) {
    console.error('[asr-scoring] ERROR:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message, transcript: '' })
    };
  }
};
