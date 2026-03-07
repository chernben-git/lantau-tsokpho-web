exports.handler = async (event) => {
  // 1. 處理 CORS 預檢請求 (讓前端不同網域也能呼叫)
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

  // 限制只能用 POST 請求
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

    const isSpouse = type === 'spouse';
    
    // 優化 Prompt，確保 AI 了解它是處理「台灣閩南語」姓名
    const prompt = isSpouse
      ? `請將台灣閩南語人名「${name}」轉換為台羅拼音。格式：{"tl":"Tân Tsî"}`
      : `將台灣閩南語人名「${name}」轉換為以下 JSON 格式：{"tl":"台羅拼音(含調符)","bp":"台灣方音符號","en":"護照英文譯名"}`;

    // 使用穩定版 gemini-1.5-flash，避免 2.0-flash-lite 的配額限制問題
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1, // 降低隨機性
          response_mime_type: "application/json" // 強制要求 AI 輸出純 JSON
        }
      })
    });

    const data = await resp.json();
    
    // 檢查 API 是否報錯 (如 Quota exceeded 或 Key 無效)
    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: `Google API 錯誤: ${data.error?.message || '未知錯誤'}` })
      };
    }

    // 取得 AI 輸出的內容
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('AI 回傳內容為空');

    // 解析 JSON 並回傳給前端
    const parsed = JSON.parse(rawText.trim());

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' // 確保前端可以收到資料
      },
      body: JSON.stringify(parsed)
    };

  } catch (e) {
    console.error('Error:', e);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '翻譯系統發生故障: ' + e.message })
    };
  }
};