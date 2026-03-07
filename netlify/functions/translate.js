exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { name, type } = JSON.parse(event.body || '{}');
  if (!name) return { statusCode: 400, body: JSON.stringify({ error: '缺少姓名' }) };

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'API Key 未設定' }) };

  const isSpouse = type === 'spouse';

  const prompt = isSpouse
    ? `請將閩南語人名「${name}」轉換為台羅拼音。只輸出JSON，格式：{"tl":"台羅拼音"}`
    : `請將閩南語人名「${name}」轉換為以下格式，只輸出JSON不要其他文字：
{
  "tl": "台灣閩南語台羅拼音（含調符，如 Tân Tsî-sim）",
  "bp": "臺灣方音符號",
  "en": "常見護照英文譯名（如 Chen Chi-sen）"
}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${API_KEY}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }
      })
    });

    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed)
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: '翻譯失敗: ' + e.message }) };
  }
};
