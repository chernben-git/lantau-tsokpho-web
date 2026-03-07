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
    if (!API_KEY) return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: '後端 API Key 未設定' }) };

    const isSpouse = type === 'spouse';
    const prompt = isSpouse
      ? `請將台灣閩南語人名「${name}」轉換為台羅拼音。格式：{"tl":"Tân Tsî"}`
      : `請將台灣閩南語人名「${name}」轉換為以下格式的 JSON：{"tl":"台羅拼音","bp":"台灣方音符號","en":"護照英文譯名"}。只輸出 JSON。`;

    // 換回 v1beta 路徑，確保支援 JSON 模式
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json" // 注意：在某些環境下要用 responseMimeType (小駝峰)
        }
      })
    });

    const data = await resp.json();
    
    if (!resp.ok) {
      // 如果還是報 responseMimeType 錯誤，就手動處理 JSON
      console.log("嘗試降級處理...");
      return await fallbackFetch(url, prompt, API_KEY);
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(JSON.parse(rawText.trim()))
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '系統故障: ' + e.message })
    };
  }
};

// 降級備案：如果不支援 responseMimeType，就用一般模式並手動過濾文字
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