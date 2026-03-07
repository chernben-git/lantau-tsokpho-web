exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'Method Not Allowed' };
  }

  try {
    const { name, type } = JSON.parse(event.body || '{}');
    if (!name) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: '缺少姓名' }) };

    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'API Key 未設定' }) };

    const isSpouse = type === 'spouse';

    const prompt = isSpouse
      ? `你是台灣閩南語（台語）專家。請將人名「${name}」用台灣閩南語發音轉為台羅拼音。
例如：陳→Tân，林→Lîm，黃→N̂g，齊→Tsî，賞→Síng，義→Gī
只輸出這個 JSON（不要任何說明）：{"tl":"台羅拼音"}`
      : `你是台灣閩南語（台語）專家。請將人名「${name}」用台灣閩南語（非普通話）發音轉換。
例如：陳→Tân，林→Lîm，黃→N̂g，齊→Tsî，賞→Síng，義→Gī，為→Uî
只輸出這個 JSON（不要任何說明、不要markdown）：
{"tl":"台羅拼音含調符","bp":"台灣方音符號","en":"護照英文"}`;

    // 使用 v1 + gemini-1.5-flash
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      })
    });

    const data = await resp.json();

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: data.error?.message || 'API 呼叫失敗' })
      };
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) throw new Error('AI 沒有回傳內容');

    const clean = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(parsed)
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '翻譯失敗: ' + e.message })
    };
  }
};
