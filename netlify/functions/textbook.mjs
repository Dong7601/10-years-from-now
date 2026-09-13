const headers = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json; charset=utf-8",
};

const textOf = (value, max = 900) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

export default async (request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST を使ってください。" }), { status: 405, headers });
  }
  if (!process.env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: "NetlifyにGEMINI_API_KEYを登録してください。" }), { status: 503, headers });
  }

  try {
    const { question = "", unit = "", history = [] } = await request.json();
    const transcript = history.slice(-12).map((item) => `${item.role === "ai" ? "先生" : "生徒"}: ${textOf(item.text, 500)}`).join("\n");
    const prompt = `あなたは高校生向け英語教材の編集者です。以下の問題と会話から、生徒が今まさに理解すべき一点を特定し、既存の教科書に追記する短い補足教材を作成してください。答えの丸暗記を避け、見分け方・理由・英語例文を入れてください。\n\n単元: ${textOf(unit, 100)}\n問題: ${textOf(question, 500)}\n会話:\n${transcript}\n\n必ず次のJSONだけを返してください。\n{"topic":"補足の見出し（30字以内）","summary":"何につまずいたかの要約（80字以内）","explanation":"理由を説明する本文（240字以内）","rule":"覚える判断ルール（120字以内）","example":"英語例文と短い和訳","check":"自分で確認する一問（80字以内）"}`;
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 1400, responseMimeType: "application/json" },
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || "Gemini API エラー");
    const raw = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
    const content = JSON.parse(raw);
    return new Response(JSON.stringify({
      topic: textOf(content.topic, 60), summary: textOf(content.summary, 160),
      explanation: textOf(content.explanation), rule: textOf(content.rule, 220),
      example: textOf(content.example, 300), check: textOf(content.check, 160),
    }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message || "教科書の追記に失敗しました。" }), { status: 500, headers });
  }
};
