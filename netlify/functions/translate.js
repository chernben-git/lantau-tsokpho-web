// 降級備案：手動過濾文字標籤
async function fallbackFetch(url, prompt, key) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const clean = text.replace(/```json|```/g, '').trim();
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(JSON.parse(clean))
  };
}

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
      ? `你是台灣閩南語（台語）專家，精通台羅拼音（Taiwan Romanization System, TRS）。
請將人名漢字「${name}」，依照台灣閩南語（非普通話、非客語）的正確發音，轉換為台羅拼音。

參考發音規則：
- 陳 → Tân（台語，非普通話 Chen）
- 林 → Lîm（台語，非普通話 Lin）
- 黃 → N̂g（台語）
- 李 → Lí（台語）
- 齊 → Tsî（台語）
- 賞 → Síng（台語）

只輸出 JSON，格式：{"tl":"台羅拼音"}`

      : `你是台灣閩南語（台語）專家，精通台羅拼音（Taiwan Romanization System, TRS）。
請將人名漢字「${name}」，依照台灣閩南語（非普通話、非客語）的正確發音，轉換為以下格式。

參考發音規則：
- 陳 → Tân（台語，非普通話 Chen）
- 林 → Lîm（台語，非普通話 Lin）
- 黃 → N̂g（台語）
- 李 → Lí（台語）
- 齊 → Tsî（台語）
- 賞 → Síng（台語）
- 人名各字之間用空格分開，姓氏首字大寫

只輸出 JSON，格式：
{
  "tl": "台羅拼音（含聲調符號，如 Tân Tsî）",
  "bp": "台灣方音符號（如 ㄉㄢˊㄐㄧˊ）",
  "en": "台灣護照慣用英文（如 Tan Chi）"
}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      })
    });

    const data = await resp.json();

    if (!resp.ok) {
      return await fallbackFetch(url, prompt, API_KEY);
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('AI 沒有回傳內容');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(JSON.parse(rawText.trim()))
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '翻譯失敗: ' + e.message })
    };
  }
};
