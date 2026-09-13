const cors = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
};

export default async (request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST を使ってください。" }), { status: 405, headers: cors });
  }
  if (!process.env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: "NetlifyにGEMINI_API_KEYを登録してください。" }), { status: 503, headers: cors });
  }

  try {
    const { message = "", question = "", unit = "", history = [] } = await request.json();
    const conversation = history.slice(-8).map((item) => ({
      role: item.role === "ai" ? "model" : "user",
      parts: [{ text: item.text }],
    }));
    const prompt = `あなたは高校生向け英語学習チューターです。答えを丸投げせず、短く分かりやすく考え方を説明してください。日本語で答え、必要に応じて英語例文を一つ示してください。\n\n単元: ${unit}\n問題: ${question}\n質問: ${message}`;
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent", {
      method: "POST",
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [...conversation, { role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.45, maxOutputTokens: 700 },
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "Gemini API エラー");
    const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    return new Response(JSON.stringify({ text: text || "回答を取得できませんでした。" }), { headers: cors });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || "AIとの通信に失敗しました。" }), { status: 500, headers: cors });
  }
};
