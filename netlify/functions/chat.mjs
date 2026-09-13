const cors = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
};

export default async (request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST を使ってください。" }), { status: 405, headers: cors });
  }
  if (!process.env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: "NetlifyにOPENAI_API_KEYを登録してください。" }), { status: 503, headers: cors });
  }

  try {
    const { message = "", question = "", unit = "", history = [] } = await request.json();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        instructions: "あなたは高校生向け英語学習チューターです。答えを丸投げせず、短く分かりやすく考え方を説明してください。日本語で答え、必要に応じて英語例文を一つ示してください。",
        input: [
          ...history.slice(-8).map((item) => ({ role: item.role === "ai" ? "assistant" : "user", content: item.text })),
          { role: "user", content: `単元: ${unit}\n問題: ${question}\n質問: ${message}` },
        ],
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "OpenAI API エラー");
    return new Response(JSON.stringify({ text: payload.output_text || "回答を取得できませんでした。" }), { headers: cors });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || "AIとの通信に失敗しました。" }), { status: 500, headers: cors });
  }
};

