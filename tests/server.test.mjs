import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "../server/index.mjs";
import { grade, publicQuestions } from "../server/content.mjs";

test("採点: 未回答を誤答にせず、表示番号と元IDを保持", () => {
  const result = grade({ "eng-q1": "b", "eng-q2": "b" });
  assert.equal(result[0].correct, true);
  assert.equal(result[1].correct, false);
  assert.equal(result[2].correct, null);
  assert.equal(result[1].displayIndex, 2);
  assert.equal(result[1].questionId, "eng-q2");
});
test("未知の問題・選択肢・解答形式を拒否", () => {
  for (const value of [{ q1: "a" }, { "eng-q1": "z" }, [], null])
    assert.throws(() => grade(value));
});
test("公開問題に正解や解説を含めず、静的版と一致", async () => {
  assert.ok(
    publicQuestions.every((q) => !("correct" in q) && !("explanation" in q)),
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(new URL("../tutor/questions.json", import.meta.url)),
    ),
    publicQuestions,
  );
});
test("HTTP: ページ・採点・秘密保護・外部Origin拒否", async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(base + "/tutor/")).status, 200);
  for (const path of [
    "/server/.env",
    "/.git/config",
    "/server/content.mjs",
    "/../server/.env",
  ])
    assert.equal((await fetch(base + path)).status, 404);
  const health = await (await fetch(base + "/api/tutor/health")).json();
  assert.equal("apiKey" in health, false);
  const response = await fetch(base + "/api/tutor/grade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers: { "eng-q2": "b" } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results[1].correct, false);
  assert.equal(
    (
      await fetch(base + "/api/tutor/grade", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/tutor/grade", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await fetch(base + "/api/tutor/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"answers":{"eng-q2":"invalid"}}',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(base + "/api/tutor/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"action":"delete_all","questionId":"eng-q2"}',
      })
    ).status,
    400,
  );
});
test("配布ファイルはキー・実装サーバーを含まない許可リスト", async () => {
  const build = await readFile(
    new URL("../scripts/build.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(build.includes('"tutor/app.js"'));
  const ignore = await readFile(
    new URL("../.gitignore", import.meta.url),
    "utf8",
  );
  assert.ok(ignore.includes("server/.env"));
  await import("../scripts/build.mjs");
  assert.deepEqual(
    (await readdir(new URL("../dist/", import.meta.url))).sort(),
    [".nojekyll", "index.html", "tutor"],
  );
});

test("模擬API: 教科書生成・残高不足・Realtime設定の契約を確認（実通信なし）", async (t) => {
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only-not-a-real-key";
  const { createServer: makeServer } = await import(
    "../server/index.mjs?contract-test"
  );
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
  const originalFetch = globalThis.fetch;
  let mode = "success",
    lastRequest;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).startsWith("https://api.openai.com/")) {
      lastRequest = options;
      if (mode === "quota")
        return Response.json(
          {
            error: {
              code: "credit_balance_exhausted",
              type: "insufficient_quota",
              message: "do-not-leak-test-secret",
            },
          },
          { status: 429 },
        );
      if (String(url).endsWith("/realtime/calls"))
        return new Response("v=0\r\nTEST-SDP");
      return Response.json({
        output: [
          {
            content: [
              {
                type: "output_text",
                text: "【テスト用】現在完了はこれまでの経験を表します。",
              },
            ],
          },
        ],
      });
    }
    return originalFetch(url, options);
  });
  const server = makeServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const post = (path, data) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const response = await post("/api/tutor/action", {
    action: "revise_explanation",
    questionId: "eng-q2",
    answers: { "eng-q2": "b" },
    dialogue: [{ role: "user", text: "サッカーの例で" }],
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.questionId, "eng-q2");
  assert.equal(data.sourceQuestionId, 2);
  assert.deepEqual(data.paragraphIds, ["en-present-perfect"]);
  const body = JSON.parse(lastRequest.body);
  assert.equal(body.store, false);
  assert.ok(body.input.includes("サッカー"));
  const rtc = await post("/api/tutor/realtime/session", {
    sdp: "v=0\r\nTEST-OFFER",
  });
  assert.equal(rtc.status, 200);
  const session = JSON.parse(lastRequest.body.get("session"));
  assert.equal(session.audio.input.turn_detection.create_response, true);
  assert.equal(session.audio.input.turn_detection.interrupt_response, true);
  assert.equal(session.tools[0].name, "propose_learning_action");
  assert.ok(
    session.instructions.includes("生徒は黙って問題を解き終えています"),
  );
  const observation = await post("/api/tutor/observe", {
    answers: { "eng-q2": "b" },
    phase: "reviewing",
    frames: [],
    events: [{ type: "answer_changed", questionId: "eng-q2", elapsedMs: 1200 }],
  });
  assert.equal(observation.status, 200);
  assert.equal((await observation.json()).source, "events_only");
  assert.ok(
    JSON.parse(lastRequest.body).input[0].content[0].text.includes(
      "answer_changed",
    ),
  );
  const invalidImage = await post("/api/tutor/observe", {
    frames: [
      { questionId: "eng-q2", imageUrl: "https://untrusted.example/image.jpg" },
    ],
  });
  assert.equal(invalidImage.status, 400);
  mode = "quota";
  const error = await post("/api/tutor/chat", { message: "こんにちは" });
  assert.equal(error.status, 502);
  const failure = await error.text();
  assert.ok(failure.includes("残高"));
  assert.ok(!failure.includes("do-not-leak"));
});
