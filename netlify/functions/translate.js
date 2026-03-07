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
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { name, type } = JSON.parse(event.body || '{}');
    if (!name) return { statusCode: 400, body: JSON.stringify({ error: '缺少姓名' }) };

    const API_KEY = process.env.GEMINI_API_KEY;
    if (!API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'API Key 未設定' }) };

    const isSpouse = type === 'spouse';
    const prompt = isSpouse
      ? `請將閩南語人名「${name}」轉換為台羅拼音。格式：{"tl":"台羅"}`
      : `請將閩南語人名「${name}」轉換為以下 JSON 格式：{"tl":"台羅拼音(含調符)","bp":"台灣方音符號","en":"護照英文譯名"}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${API_KEY}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: "application/json" // 強制要求回傳 JSON 格式
        }
      })
    });

    const data = await resp.json();
    
    // 檢查 Google API 是否回傳錯誤
    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({ error: data.error?.message || 'API 呼叫失敗' })
      };
    }

    // 取得 AI 輸出的文字內容
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('AI 沒有回傳任何內容');

    // 嘗試解析 JSON
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