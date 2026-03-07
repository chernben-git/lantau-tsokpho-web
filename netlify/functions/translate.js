// 降級備案：當 JSON 模式出錯時，手動過濾文字標籤
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
  // 1. CORS 預檢請求處理
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
    if (!name) return { 
      statusCode: 400, 
      headers: { 'Access-Control-Allow-Origin': '*' }, 
      body: JSON.stringify({ error: '缺少姓名' }) 
    };

    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) return { 
      statusCode: 500, 
      headers: { 'Access-Control-Allow-Origin': '*' }, 
      body: JSON.stringify({ error: '後端 API Key 未設定' }) 
    };

    // 2. 核心邏輯：強制 AI 從國語轉台語發音
    const isSpouse = type === 'spouse';
    const prompt = isSpouse
      ? `你是一位台語專家。請將人名漢字「${name}」轉換為「台灣閩南語」發音的台羅拼音。禁止使用華語發音（例如「陳」不讀 Chen，要讀 Tân）。只輸出 JSON：{"tl":"Tân Tsî"}`
      : `你是一位精通台灣閩南語的專家。
         使用者會輸入國語姓名「${name}」，請依照以下邏輯處理：
         1. 判斷該姓名在「台灣閩南語」中的正確讀音（絕對禁止使用華語/普通話拼音）。
         2. 姓氏「陳」必須對應台語發音「Tân」。
         3. 輸出格式必須為 JSON，包含：
            - "tl": 台灣閩南語羅馬字 (Tâi-lô)，需含調符。
            - "bp": 台灣方音符號。
            - "en": 台灣常用英文譯名（例如 Tan Chi 或 Chen Chi）。

         請直接輸出 JSON，不要說明：
         {"tl":"...","bp":"...","en":"..."}`;

    // 使用 v1beta 穩定路徑
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

    // 3. 呼叫 API
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
    
    // 4. 自動降級邏輯 (萬一 API 參數報錯)
    if (!resp.ok) {
      console.log("偵測到參數錯誤，啟動降級方案...");
      return await fallbackFetch(url, prompt, API_KEY);
    }

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('AI 回傳內容為空');

    // 5. 解析並回傳給前端
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