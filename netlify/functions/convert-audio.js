const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body);

    // 支援 wavBase64（WAV）或 audioBase64（MP3/任何格式）
    const inputBase64 = body.wavBase64 || body.audioBase64;
    const inputExt    = body.wavBase64 ? '.wav' : '.mp3';

    if (!inputBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing wavBase64 or audioBase64' }) };
    }

    const ts         = Date.now();
    const inputPath  = '/tmp/input_'  + ts + inputExt;
    const outputPath = '/tmp/output_' + ts + '.m4a';
    fs.writeFileSync(inputPath, Buffer.from(inputBase64, 'base64'));

    // ffmpeg 轉檔：WAV 或 MP3 → M4A (AAC, 44100Hz, mono)
    execSync(`${ffmpegPath} -y -i ${inputPath} -c:a aac -b:a 64k -ar 44100 -ac 1 ${outputPath}`);

    const m4aBase64 = fs.readFileSync(outputPath).toString('base64');

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
