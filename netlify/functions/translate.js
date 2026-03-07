exports.handler = async (event) => {
  // 1. 處理 CORS
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
    
    // 強化的提示語：這次我們不依賴 API 的 JSON 模式，直接寫在 Prompt 裡要求
    const prompt = `你是一位台灣台語專家。請將人名漢字「${name}」轉換為「台灣閩南語」發音。
絕對不要用華語/普通話讀音（例如「陳」要讀 Tân）。

請嚴格依照以下格式回傳，不要有任何說明文字：
{
  "tl": "台羅拼音（含調符，如 Tân Tsî）",
  "bp": "台灣方音符號",
  "en": "護照英文譯名（如 Chen Chi 或 Tan Chi）"
}`;

    // 使用最穩定的 v1 路徑
    const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${API_KEY}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1
        }
      })
    });

    const data = await resp.json();
    
    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: `Google API 錯誤: ${data.error?.message || '未知錯誤'}` })
      };
    }

    // 手動解析回傳的文字
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    // 移除可能出現的 Markdown 標籤並解析
    const cleanJson = rawText.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

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