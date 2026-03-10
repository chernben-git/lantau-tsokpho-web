const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { wavBase64 } = JSON.parse(event.body);
    if (!wavBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing wavBase64' }) };
    }

    // 寫 WAV 到 /tmp
    const inputPath  = '/tmp/input_' + Date.now() + '.wav';
    const outputPath = '/tmp/output_' + Date.now() + '.m4a';
    fs.writeFileSync(inputPath, Buffer.from(wavBase64, 'base64'));

    // ffmpeg 轉檔：WAV → M4A (AAC, 44100Hz, mono)
    execSync(`${ffmpegPath} -y -i ${inputPath} -c:a aac -b:a 64k -ar 44100 -ac 1 ${outputPath}`);

    // 讀出來轉 base64
    const m4aBase64 = fs.readFileSync(outputPath).toString('base64');

    // 清理暫存
    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ m4aBase64 })
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};