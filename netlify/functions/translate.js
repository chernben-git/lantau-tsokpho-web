// 降級備案函數：當 JSON 模式失效時，手動過濾 Markdown 標籤
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
  // 移除可能出現的 ```json ... ``` 標籤
  const clean = text.replace(/```json|```/g, '').trim();
  return {
    statusCode: 200,
    headers: { 
      'Content-Type': 'application/json', 
      'Access-Control-Allow-Origin': '*' 
    },
    body: JSON.stringify(JSON.parse(clean))
  };
}

exports.handler = async (event) => {
  // 1. 處理 CORS 預檢請求
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
    return { 
      statusCode: 405, 
      headers: { 'Access-Control-Allow-Origin': '*' }, 
      body: 'Method Not Allowed' 
    };
  }

  try {
    const { name, type } = JSON.parse(event.body || '{}');
    if (!name) {
      return { 
        statusCode: 400, 
        headers: { 'Access-Control-Allow-Origin': '*' }, 
        body: JSON.stringify({ error: '缺少姓名' }) 
      };
    }

    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) {
      return { 
        statusCode: 500, 
        headers: { 'Access-Control-Allow-Origin': '*' }, 
        body: JSON.stringify({ error: 'API Key 未設定' }) 
      };
    }

    // 2. 強化版 Prompt：強制台語邏輯
    const isSpouse = type === 'spouse';
    const prompt = isSpouse
      ? `以下是台灣人名漢字「${name}」，請用「台灣閩南語」發音轉換為台羅拼音 (Taiwan Romanization System)，絕對不要用華語(Mandarin)讀音。只輸出 JSON：{"tl":"Tân Tsî"}`
      : `你是一位台灣台語專家。請將人名漢字「${name}」轉換為「台灣閩南語」發音（絕對不要用華語/普通話讀音）。
         格式要求：
         1. "tl": 台灣閩南語羅馬字拼音（台羅，需含調符，如 Tân Tsî）。
         2. "bp": 台灣方音符號。
         3. "en": 台灣常用的護照英文譯名（例如「陳」要用 Chen 或 Tan，不要用 Qi 這種大陸拼音）。
         請只輸出以下格式的 JSON，不要有任何說明文字：
         {"tl":"...","bp":"...","en":"..."}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

    // 3. 呼叫 Gemini API
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
    
    // 4. 錯誤處理與降級邏輯
    if (!resp.ok) {
      // 萬一 responseMimeType 參數被判定為無效欄位，則啟動降級備案
      if (data.error?.message?.includes('response_mime_type') || data.error?.message?.includes('responseMimeType')) {
        return await fallbackFetch(url, prompt, API_KEY);
      }
      return {
        statusCode: resp.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: data.error?.message || 'API 呼叫失敗' })
      };
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('AI 回傳空內容');

    const parsed = JSON.parse(rawText.trim());

    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json', 
        'Access-Control-Allow-Origin': '*' 
      },
      body: JSON.stringify(parsed)
    };

  } catch (e) {
    console.error('Error:', e);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '翻譯失敗: ' + e.message })
    };
  }
};