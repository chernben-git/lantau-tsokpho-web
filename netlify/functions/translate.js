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
  // CORS 預檢
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
    
    // --- 核心修改：強化國語轉台語發音的邏輯 ---
    const prompt = isSpouse
      ? `你是一位台灣台語專家。請將人名「${name}」先轉為台灣閩南語唸法，再輸出為台羅拼音。格式：{"tl":"Tân Tsî"}`
      : `你是一位台灣台語專家。使用者會提供國語書寫的姓名「${name}」，請依照以下步驟處理：
         1. 思考該姓名在台灣閩南語中的正確發音（例如「陳」讀 Tân，「齊」讀 Tsî）。
         2. 根據該台語發音輸出台羅拼音（需含調符）、方音符號及台灣常用護照英文。
         
         請嚴格只輸出 JSON 格式如下：
         {
           "tl": "台語發音的台羅拼音",
           "bp": "台灣方音符號",
           "en": "台灣常用英文譯名(如 Chen Chi)"
         }`;

    // 使用 v1beta 以確保 responseMimeType 支援
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
      // 網址或參數錯誤時自動降級
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