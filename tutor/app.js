const $ = (id) => document.getElementById(id);
const state = {
  id: crypto.randomUUID(),
  phase: "idle",
  index: 0,
  answers: {},
  events: [],
  dialogue: [],
  results: [],
  proposals: [],
  updates: [],
  media: [],
  startedAt: null,
  endedAt: null,
  imagesSent: 0,
  subject: "english",
  questionSetVersion: "english-reference-v1",
  frames: [],
  observations: "",
};
let questions = [],
  health = null,
  db = null,
  pc = null,
  dc = null,
  mic = null,
  screen = null,
  audioContext = null,
  screenVideo = null;
let tick = null,
  startClock = 0,
  questionClock = 0,
  lastImage = 0,
  hiddenAt = null,
  muted = false,
  connecting = false,
  ending = false;
let responseActive = false,
  reviewPending = false,
  finishing = false,
  recorders = [],
  pendingWrites = new Set(),
  downloadUrls = [];
const timing = {};
let reviewWithVoice = true,
  frameTick = null;
const apiUrl = (path) => new URL("../api/tutor/" + path, location.href);
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
}
function event(type, data = {}) {
  state.events.push({
    type,
    at: new Date().toISOString(),
    elapsedMs: startClock ? Math.round(performance.now() - startClock) : 0,
    ...data,
  });
  persist();
}
function persist() {
  if (!db || state.phase === "idle") return;
  const tx = db.transaction("sessions", "readwrite");
  tx.objectStore("sessions").put(structuredClone({ ...state, timing }));
  tx.onerror = () =>
    notice(
      "端末への保存に失敗しました。終了後にJSONをダウンロードしてください。",
      true,
    );
}
async function api(path, body) {
  const response = await fetch(apiUrl(path), {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(65000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "APIサーバーがありません。npm start で起動したローカルURLを開いてください。",
    );
  }
  if (!response.ok) throw new Error(data.error || "接続に失敗しました。");
  return data;
}
function context() {
  return {
    sessionId: state.id,
    phase: state.phase,
    questionId: questions[state.index]?.id,
    answers: state.answers,
    dialogue: state.dialogue,
    timing,
    events: state.events.filter((e) =>
      [
        "answer_changed",
        "question_opened",
        "page_hidden",
        "page_visible",
        "idle_interval",
      ].includes(e.type),
    ),
    observations: state.observations,
    results: state.results,
  };
}
function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "message " + role;
  div.textContent = text;
  $("chatLog").append(div);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  if (["user", "assistant"].includes(role)) {
    state.dialogue.push({
      id: crypto.randomUUID(),
      role,
      text,
      at: new Date().toISOString(),
      questionId:
        state.phase === "reviewing" ? null : questions[state.index]?.id,
    });
    persist();
  }
  return div;
}
function send(data) {
  if (dc?.readyState === "open") {
    dc.send(JSON.stringify(data));
    return true;
  }
  return false;
}
function sendContext(reason) {
  send({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text:
            "【アプリの状態更新・返答不要】" +
            JSON.stringify({
              ...context(),
              dialogue: undefined,
              reason,
              question: questions[state.index],
            }),
        },
      ],
    },
  });
}
function requestResponse(instructions) {
  if (responseActive) return false;
  return send({
    type: "response.create",
    response: { ...(instructions ? { instructions } : {}) },
  });
}
function voiceStatus(text, live = false) {
  $("voiceBadge").textContent = text;
  $("voiceBadge").classList.toggle("live", live);
  $("tutorStatus").textContent = live ? "声で話しかけてください" : text;
  $("mute").disabled = !live;
  $("snapshot").disabled = !live || !screen;
  $("connectVoice").disabled = live || connecting || state.phase === "ended";
}
function recordingStatus() {
  const active = recorders.filter((x) => x.recorder.state === "recording");
  $("recordBadge").textContent = active.length
    ? "記録中 · " +
      active
        .map((x) =>
          x.kind === "screen"
            ? "画面"
            : x.kind === "microphone"
              ? "自分の声"
              : "AI音声",
        )
        .join(" / ")
    : "記録 停止中";
  $("recordBadge").classList.toggle("live", active.length > 0);
}
function openDb() {
  return new Promise((resolve, reject) => {
    // 名称変更前の端末記録を失わないため、保存領域の内部名は維持する。
    const req = indexedDB.open("manabi-learning-v1", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("sessions", { keyPath: "id" });
      req.result.createObjectStore("chunks", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function recordStream(stream, kind) {
  if (!window.MediaRecorder) {
    notice(
      "このブラウザは録音・録画に非対応です。会話と解答は記録します。",
      true,
    );
    return;
  }
  const mime = (
    kind === "screen"
      ? ["video/webm;codecs=vp9", "video/webm", "video/mp4"]
      : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
  ).find((t) => MediaRecorder.isTypeSupported(t));
  try {
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const entry = {
      recorder,
      kind,
      chunks: [],
      id: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
      saved: true,
    };
    recorders.push(entry);
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      entry.chunks.push(e.data);
      if (db) {
        const promise = new Promise((resolve) => {
          const tx = db.transaction("chunks", "readwrite");
          tx.objectStore("chunks").put({
            id: entry.id + ":" + entry.chunks.length,
            sessionId: state.id,
            mediaId: entry.id,
            kind,
            sequence: entry.chunks.length,
            blob: e.data,
            mime: recorder.mimeType,
          });
          tx.oncomplete = resolve;
          tx.onerror = () => {
            entry.saved = false;
            notice(
              "メディアの端末保存に失敗しました。終了後にダウンロードしてください。",
              true,
            );
            resolve();
          };
        });
        pendingWrites.add(promise);
        promise.finally(() => pendingWrites.delete(promise));
      } else entry.saved = false;
    };
    recorder.onerror = () => {
      entry.saved = false;
      event("recording_error", { kind });
      notice(kind + "の記録に失敗しました。", true);
      recordingStatus();
    };
    recorder.start(2000);
    event("recording_started", { kind, mediaId: entry.id });
    recordingStatus();
  } catch (error) {
    event("recording_failed", { kind });
    notice("記録開始に失敗: " + error.message, true);
  }
}
async function connectVoice() {
  if (state.phase !== "reviewing") {
    notice(
      "AIとの会話は解答終了後に始まります。いまは自分のペースで解いてください。",
    );
    return;
  }
  if (connecting || pc?.connectionState === "connected") return;
  if (!health?.configured) {
    notice(
      "音声AIにはserver/.envのAPIキー設定とサーバー再起動が必要です。",
      true,
    );
    return;
  }
  if (pc) disconnectVoice();
  connecting = true;
  voiceStatus("音声 接続中");
  let readyTimeout;
  try {
    mic ??= await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (state.phase === "ended") throw new Error("学習は終了しています。");
    pc = new RTCPeerConnection();
    mic.getTracks().forEach((t) => pc.addTrack(t, mic));
    pc.ontrack = (e) => {
      if (state.phase === "ended") {
        e.track.stop();
        return;
      }
      const remote = e.streams[0] || new MediaStream([e.track]);
      $("remoteAudio").srcObject = remote;
      $("remoteAudio")
        .play()
        .catch(() =>
          notice("音声の再生を許可するため、画面をタップしてください。", true),
        );
      recordStream(remote, "assistant");
    };
    pc.onconnectionstatechange = () => {
      if (
        pc?.connectionState === "failed" ||
        pc?.connectionState === "disconnected"
      ) {
        voiceStatus("音声 切断");
        event("voice_disconnected");
        notice("音声接続が切れました。文字入力か再接続を使えます。", true);
      }
    };
    dc = pc.createDataChannel("oai-events");
    dc.onmessage = (e) => {
      try {
        handleRealtime(JSON.parse(e.data));
      } catch {
        notice(
          "音声イベントを処理できませんでした。再接続してください。",
          true,
        );
      }
    };
    const ready = new Promise((resolve, reject) => {
      readyTimeout = setTimeout(
        () => reject(new Error("音声接続がタイムアウトしました。")),
        70000,
      );
      dc.onopen = () => {
        clearTimeout(readyTimeout);
        resolve();
      };
      dc.onerror = () => {
        clearTimeout(readyTimeout);
        reject(new Error("音声データ接続に失敗しました。"));
      };
    });
    ready.catch(() => {});
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await api("realtime/session", { sdp: offer.sdp });
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    await ready;
    if (
      !recorders.some(
        (r) => r.kind === "microphone" && r.recorder.state === "recording",
      )
    )
      recordStream(mic, "microphone");
    voiceStatus("音声 接続中 ●", true);
    event("voice_connected");
    sendContext("音声接続");
    for (const frame of reviewFrames().slice(-3))
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `解答中の録画静止画 ${frame.id} / ${frame.questionId} / ${frame.elapsedMs}ms。返答不要。`,
            },
            { type: "input_image", image_url: frame.imageUrl },
          ],
        },
      });
    startReviewResponse();
    notice(
      "解答中の記録をもとに、AIが振り返りを始めます。普通に話して答えてください。",
    );
  } catch (error) {
    disconnectVoice();
    notice(error.message, true);
  } finally {
    clearTimeout(readyTimeout);
    connecting = false;
    $("connectVoice").disabled =
      dc?.readyState === "open" || state.phase === "ended";
  }
}
function disconnectVoice() {
  dc?.close();
  pc?.close();
  dc = null;
  pc = null;
  mic?.getTracks().forEach((t) => t.stop());
  mic = null;
  recorders
    .filter((x) => ["microphone", "assistant"].includes(x.kind))
    .forEach((x) => {
      if (x.recorder.state !== "inactive") x.recorder.stop();
    });
  responseActive = false;
  voiceStatus("音声 未接続");
  recordingStatus();
}
const transcriptItems = new Map();
function handleRealtime(e) {
  if (e.type === "response.created") responseActive = true;
  if (
    e.type === "conversation.item.input_audio_transcription.completed" &&
    e.transcript
  ) {
    addMessage("user", e.transcript);
    event("speech_transcribed");
  }
  if (e.type === "response.output_audio_transcript.delta") {
    let item = transcriptItems.get(e.item_id);
    if (!item) {
      item = addMessage("live", "");
      transcriptItems.set(e.item_id, item);
    }
    item.textContent += e.delta;
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
  }
  if (e.type === "response.output_audio_transcript.done") {
    transcriptItems.get(e.item_id)?.remove();
    transcriptItems.delete(e.item_id);
    addMessage("assistant", e.transcript);
  }
  if (e.type === "input_audio_buffer.speech_started") {
    event("speech_started");
  }
  if (e.type === "response.done") {
    responseActive = false;
    for (const output of e.response?.output || []) {
      if (
        output.type === "function_call" &&
        output.name === "propose_learning_action"
      ) {
        let accepted = false;
        try {
          accepted = addProposal(JSON.parse(output.arguments));
        } catch {}
        send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: output.call_id,
            output: JSON.stringify({
              status: accepted ? "awaiting_user_approval" : "invalid_proposal",
            }),
          },
        });
        requestResponse(
          "提案をカードに表示しました。承認前なのでまだ生成はしていません。短く案内してください。",
        );
      }
    }
    if (reviewPending) {
      reviewPending = false;
      startReviewResponse();
    }
    if (e.response?.status === "failed")
      notice("音声AIの応答に失敗しました。もう一度話しかけてください。", true);
  }
  if (e.type === "error") {
    event("realtime_error", { code: e.error?.code });
    notice("音声AI: " + (e.error?.message || "応答エラー"), true);
  }
}
async function shareScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    notice(
      "この端末はブラウザ画面録画に非対応です。マイクと解答・会話の記録で続けます。",
      true,
    );
    event("screen_unsupported");
    return;
  }
  try {
    screen = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 5 },
      audio: false,
    });
    if (state.phase === "ended") {
      screen.getTracks().forEach((track) => track.stop());
      screen = null;
      return;
    }
    screenVideo = document.createElement("video");
    screenVideo.srcObject = screen;
    screenVideo.muted = true;
    await screenVideo.play();
    recordStream(screen, "screen");
    screen.getVideoTracks()[0].onended = () => {
      event("screen_share_ended");
      screen = null;
      $("snapshot").disabled = true;
      recorders
        .filter((x) => x.kind === "screen")
        .forEach((x) => {
          if (x.recorder.state !== "inactive") x.recorder.stop();
        });
      recordingStatus();
      notice("画面共有が終了しました。音声・解答の記録は継続します。");
    };
    $("snapshot").disabled = dc?.readyState !== "open";
  } catch {
    event("screen_declined");
    notice("画面は共有されていません。音声と解答の記録で続けます。");
  }
}
function snapshot(manual = false, reason = "question_or_answer") {
  if (!screen || !screenVideo?.videoWidth) return;
  if (performance.now() - lastImage < 3000 || state.frames.length >= 30) {
    if (manual) notice("静止画の保存は3秒間隔・1回の学習で最大30枚です。");
    return;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(screenVideo.videoWidth, 960);
  canvas.height = Math.round(
    (screenVideo.videoHeight * canvas.width) / screenVideo.videoWidth,
  );
  canvas
    .getContext("2d")
    .drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
  const imageUrl = canvas.toDataURL("image/jpeg", 0.45);
  const frame = {
    id: crypto.randomUUID(),
    questionId: questions[state.index].id,
    elapsedMs: Math.round(performance.now() - startClock),
    reason,
    imageUrl,
  };
  state.frames.push(frame);
  if (state.phase === "reviewing" && dc?.readyState === "open")
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "共有画面の静止画。" +
              (manual
                ? "この画面をもとに質問を聞いてください。"
                : "問題変更時の参考画像。返答不要。"),
          },
          {
            type: "input_image",
            image_url: imageUrl,
          },
        ],
      },
    });
  lastImage = performance.now();
  event("frame_captured", {
    source: "screen_share",
    frameId: frame.id,
    questionId: frame.questionId,
    reason,
  });
  if (manual)
    notice(
      state.phase === "solving"
        ? "解答中の場面を記録しました。AIは終了後に参照します。"
        : "共有画面の静止画をAIへ送りました。",
    );
}
function reviewFrames() {
  return questions.flatMap((q) => {
    const frames = state.frames.filter((f) => f.questionId === q.id);
    return [
      ...new Map(
        [frames[0], frames[Math.floor(frames.length / 2)], frames.at(-1)]
          .filter(Boolean)
          .map((f) => [f.id, f]),
      ).values(),
    ];
  });
}
function accountTime() {
  if (!questionClock || state.phase !== "solving") return;
  const id = questions[state.index].id;
  timing[id] ??= { elapsedMs: 0, hiddenMs: 0 };
  const elapsed = performance.now() - questionClock;
  timing[id].elapsedMs += Math.round(elapsed);
  if (hiddenAt !== null) timing[id].hiddenMs += Math.round(elapsed);
  questionClock = performance.now();
}
function renderQuestion() {
  const q = questions[state.index];
  $("questionNumber").textContent =
    `QUESTION ${q.displayIndex} / ${questions.length}`;
  $("concept").textContent = q.concept;
  $("questionText").textContent = q.text;
  $("questionPrompt").textContent = q.prompt;
  $("steps").replaceChildren();
  questions.forEach((item, i) => {
    const b = document.createElement("button");
    b.textContent = `0${i + 1} ${item.concept}`;
    b.className =
      (i === state.index ? "active " : "") +
      (state.answers[item.id] ? "done" : "");
    b.disabled = state.phase !== "solving" || finishing;
    b.onclick = () => goQuestion(i);
    $("steps").append(b);
  });
  $("choices").replaceChildren();
  q.choices.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "choice" + (state.answers[q.id] === c.id ? " selected" : "");
    b.setAttribute("aria-pressed", String(state.answers[q.id] === c.id));
    b.disabled = state.phase !== "solving" || finishing;
    const label = document.createElement("span");
    label.className = "letter";
    label.textContent = String.fromCharCode(65 + i);
    b.append(label, document.createTextNode(c.label));
    b.onclick = () => {
      const previous = state.answers[q.id] ?? null;
      state.answers[q.id] = c.id;
      event("answer_changed", { questionId: q.id, previous, selected: c.id });
      renderQuestion();
      sendContext("解答変更");
      snapshot();
    };
    $("choices").append(b);
  });
  $("nextQuestion").textContent =
    state.index === questions.length - 1 ? "AIと振り返る →" : "次の問題へ →";
  $("nextQuestion").disabled = state.phase !== "solving" || finishing;
}
function goQuestion(index) {
  if (finishing || state.phase !== "solving") return;
  accountTime();
  state.index = index;
  questionClock = performance.now();
  event("question_opened", { questionId: questions[index].id });
  renderQuestion();
  sendContext("問題変更");
  snapshot();
}
function showView(view) {
  if (state.phase === "idle") {
    notice("先に学習を開始してください。");
    return;
  }
  if (state.phase === "solving" && view === "book") {
    notice(
      "教科書は解答後の振り返りから開きます。いまは自分の考えで解いてみてください。",
    );
    return;
  }
  for (const id of ["lesson", "book", "record"]) $(id).hidden = id !== view;
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("pageTitle").textContent =
    view === "book"
      ? "会話が、あなたの教科書になる。"
      : view === "record"
        ? "正解までの道のりも、学び。"
        : "英語の「なぜ」を、自分の言葉に。";
  if (view === "record") renderResults();
}
async function start(withVoice) {
  if (!$("consent").checked) return;
  state.phase = "preparing";
  reviewWithVoice = withVoice;
  state.startedAt = new Date().toISOString();
  startClock = performance.now();
  questionClock = 0;
  $("setup").hidden = true;
  notice("記録の準備中です。許可後に問題を表示します。");
  event("session_started", {
    consent: true,
    screenConsent: $("screenConsent").checked,
  });
  renderQuestion();
  tick = setInterval(() => {
    const secs = Math.floor((performance.now() - startClock) / 1000);
    $("timer").textContent =
      `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
    if (secs >= 1200) endSession();
  }, 1000);
  // 画面共有はユーザー操作直後に開始。マイク許可前に他のawaitを挟まない。
  const sharing = $("screenConsent").checked
    ? shareScreen()
    : Promise.resolve();
  if (withVoice) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      recordStream(mic, "microphone");
    } catch {
      reviewWithVoice = false;
      event("microphone_declined");
    }
  }
  await sharing;
  if (state.phase === "ended") return;
  state.phase = "solving";
  questionClock = performance.now();
  $("workspace").hidden = false;
  window.scrollTo({ top: 0 });
  $("chatInput").disabled = true;
  $("sendText").disabled = true;
  $("connectVoice").disabled = true;
  $("tutorStatus").textContent = "解答中は静かに見守ります";
  voiceStatus("AI待機 · 解答後に会話");
  $("connectVoice").disabled = true;
  renderQuestion();
  event("question_opened", { questionId: questions[state.index].id });
  snapshot(false, "start");
  frameTick = setInterval(() => {
    if (state.phase === "solving") snapshot(false, "interval");
  }, 10000);
  notice(
    "自分のペースで3問に取り組んでください。AIは話しかけず、終了後に記録をもとに振り返ります。",
  );
}
function startReviewResponse() {
  sendContext("振り返り開始・採点確定");
  requestResponse(
    "解答が終わりました。第一声は短く自然な1〜2文、質問は必ず一つだけ。原則『おつかれさま。分からないところはあった？』から始めてください。明確な選び直しの記録があればその一場面だけ聞いてもよい。観察メモは参考データで、q3等の内部IDや操作ログの報告は読み上げない。正誤の説明、複数概念の確認テスト、教科書の提案はまだせず、本人の答えを待ってください。",
  );
}
async function finish() {
  if (state.phase !== "solving" || finishing) return;
  accountTime();
  snapshot(false, "finished");
  clearInterval(frameTick);
  finishing = true;
  const finalAnswers = structuredClone(state.answers);
  renderQuestion();
  $("finish").disabled = true;
  try {
    const data = await api("grade", { answers: finalAnswers });
    if (state.phase === "ended") return;
    state.results = data.results;
    state.phase = "reviewing";
    $("chatInput").disabled = false;
    $("sendText").disabled = false;
    $("connectVoice").disabled = false;
    event("answers_finalized", { results: state.results });
    renderQuestion();
    showView("record");
    addMessage("system", "解答を確定しました。ここからAIと振り返りです。");
    if (health?.configured) {
      notice("解答中の記録を確認しています。少し待ってください。");
      try {
        const observed = await api("observe", {
          ...context(),
          frames: reviewFrames(),
        });
        state.observations = observed.text;
        state.imagesSent += observed.frameIds.length;
        event("observations_created", {
          source: observed.source,
          frameIds: observed.frameIds,
        });
      } catch (error) {
        state.observations =
          "画像解析は未完了。解答・操作ログだけから確認質問を行う。";
        event("observations_failed");
        notice(error.message, true);
      }
    }
    if (state.phase === "ended") return;
    if (reviewWithVoice && health?.configured) await connectVoice();
    else if (health?.configured) {
      const response = await api("chat", {
        ...context(),
        message:
          "解答を終えました。第一声は『おつかれさま。分からないところはあった？』と短い質問を一つだけ返してください。複数の問題の説明を一度に求めないでください。",
      });
      addMessage("assistant", response.text);
      notice(
        "記録を確認しました。AIの質問に、下の欄から自由に答えてください。音声への切替もできます。",
      );
    } else
      addMessage(
        "system",
        "APIキー未設定のため、AIの振り返りは利用できません。",
      );
  } catch (error) {
    notice(error.message, true);
    $("finish").disabled = state.phase !== "solving";
  } finally {
    finishing = false;
    renderQuestion();
  }
  // 本人の説明を聞く前には、弱点や教材を先回りして提案しない。
}
function addProposal(p) {
  if (
    state.phase !== "reviewing" ||
    !state.dialogue.some((d) => d.role === "user")
  )
    return false;
  if (
    ![
      "revise_explanation",
      "generate_practice",
      "open_learning_record",
    ].includes(p.action) ||
    !questions.some((q) => q.id === p.questionId) ||
    typeof p.title !== "string" ||
    typeof p.reason !== "string"
  )
    return false;
  if (
    state.proposals.some(
      (x) =>
        x.action === p.action &&
        x.questionId === p.questionId &&
        x.status === "proposed",
    )
  )
    return true;
  if (state.proposals.filter((x) => x.status === "proposed").length >= 3)
    return false;
  const proposal = {
    ...p,
    title: p.title.slice(0, 120),
    reason: p.reason.slice(0, 300),
    id: crypto.randomUUID(),
    status: "proposed",
    source: p.source || "ai",
  };
  state.proposals.push(proposal);
  event("proposal_created", { proposal });
  renderProposals();
  return true;
}
function renderProposals() {
  $("proposals").replaceChildren();
  state.proposals
    .filter((p) => ["proposed", "generating", "failed"].includes(p.status))
    .slice(-3)
    .forEach((p) => {
      const card = document.createElement("div");
      card.className = "proposal";
      const title = document.createElement("h3");
      title.textContent =
        (p.source === "ai" ? "✦ AIの提案 · " : "学習メニュー · ") + p.title;
      const reason = document.createElement("p");
      reason.textContent =
        p.status === "failed"
          ? "生成に失敗しました。再試行できます。"
          : p.reason;
      const accept = document.createElement("button");
      accept.className = "primary";
      accept.textContent = p.status === "generating" ? "生成中…" : "やってみる";
      accept.disabled = p.status === "generating" || state.phase === "ended";
      accept.onclick = () => acceptProposal(p);
      const reject = document.createElement("button");
      reject.className = "text-button";
      reject.textContent = "いまは大丈夫";
      reject.disabled = p.status === "generating";
      reject.onclick = () => {
        p.status = "dismissed";
        event("proposal_dismissed", { id: p.id });
        renderProposals();
      };
      card.append(title, reason, accept, reject);
      $("proposals").append(card);
    });
}
async function acceptProposal(p) {
  p.status = "generating";
  event("proposal_accepted", { id: p.id });
  renderProposals();
  try {
    const result = await api("action", {
      ...context(),
      questionId: p.questionId,
      action: p.action,
    });
    p.status = "completed";
    state.updates.push({
      ...result,
      action: p.action,
      proposalId: p.id,
      title: p.title,
    });
    event("content_generated", { proposalId: p.id });
    renderBook();
    showView("book");
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "【処理結果】承認された提案をこの画面内の教科書へ追加しました。" +
              result.text,
          },
        ],
      },
    });
    notice("会話をもとに、あなた向けの内容を教科書へ追加しました。");
  } catch (error) {
    p.status = "failed";
    event("content_generation_failed", { proposalId: p.id });
    notice(error.message, true);
  }
  renderProposals();
}
function renderBook() {
  $("bookUpdates").replaceChildren();
  for (const update of state.updates) {
    const block = document.createElement("section");
    block.className = "book-update";
    const heading = document.createElement("h3");
    heading.textContent = "✦ " + update.title;
    const text = document.createElement("p");
    text.textContent = update.text;
    const meta = document.createElement("small");
    meta.className = "small";
    meta.textContent =
      "AI生成の更新案 · 対象 " +
      update.paragraphIds.join(", ") +
      " · 内容は確認して使ってください";
    block.append(heading, text, meta);
    $("bookUpdates").append(block);
  }
}
function renderResults() {
  $("results").replaceChildren();
  for (const q of questions) {
    const result = state.results.find((r) => r.questionId === q.id);
    const row = document.createElement("div");
    row.className = "result";
    const title = document.createElement("strong");
    title.textContent = `第${q.displayIndex}問 · ${q.concept}　${result ? (result.correct === null ? "未回答" : result.correct ? "正解" : "要確認") : "未採点"}`;
    const text = document.createElement("p");
    text.textContent =
      "選んだ答え: " +
      (q.choices.find((c) => c.id === state.answers[q.id])?.label || "未回答");
    const time = document.createElement("small");
    const t = timing[q.id];
    time.textContent = `表示時間 ${Math.round((t?.elapsedMs || 0) / 1000)}秒（うち非表示 ${Math.round((t?.hiddenMs || 0) / 1000)}秒）`;
    row.append(title, text, time);
    if (result) {
      const explanation = document.createElement("p");
      explanation.textContent = result.explanation;
      row.append(explanation);
    }
    $("results").append(row);
  }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  downloadUrls.push(url);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}
async function endSession() {
  if (ending || ["idle", "ended"].includes(state.phase)) return;
  ending = true;
  accountTime();
  state.phase = "ended";
  state.endedAt = new Date().toISOString();
  $("endSession").disabled = true;
  $("endSession").textContent = "終了処理中…";
  $("tutorStatus").textContent = "録音・録画を停止しています";
  $("endConfirmation").hidden = false;
  $("endConfirmation").textContent =
    "学習内容を確定しました。録音・録画を停止しています…";
  addMessage("system", "学習を終了します。記録を保存しています…");
  clearInterval(tick);
  clearInterval(frameTick);
  event("session_ended");
  const stops = recorders
    .filter((x) => x.recorder.state !== "inactive")
    .map(
      (x) =>
        new Promise((resolve) => {
          let completed = false;
          const done = () => {
            if (completed) return;
            completed = true;
            resolve();
          };
          x.recorder.addEventListener("stop", done, { once: true });
          setTimeout(done, 3000);
          try {
            x.recorder.stop();
          } catch {
            done();
          }
        }),
    );
  disconnectVoice();
  if (screen) {
    screen.getVideoTracks()[0].onended = null;
    screen.getTracks().forEach((t) => t.stop());
    screen = null;
  }
  await Promise.all(stops);
  await Promise.all([...pendingWrites]);
  for (const r of recorders) {
    if (!r.chunks.length) continue;
    const blob = new Blob(r.chunks, { type: r.recorder.mimeType });
    const extension = r.recorder.mimeType.includes("mp4")
      ? r.kind === "screen"
        ? "mp4"
        : "m4a"
      : "webm";
    const filename = `growbook-${state.id}-${r.kind}-${r.id.slice(0, 6)}.${extension}`;
    state.media.push({
      id: r.id,
      kind: r.kind,
      filename,
      mime: blob.type,
      bytes: blob.size,
      startedAt: r.startedAt,
      endedAt: state.endedAt,
      savedToIndexedDB: r.saved,
    });
    const button = document.createElement("button");
    button.className = "media-link secondary";
    button.textContent = `${r.kind === "screen" ? "画面録画" : r.kind === "microphone" ? "自分の録音" : "AIの録音"}を保存 (${(blob.size / 1024 / 1024).toFixed(1)}MB)`;
    button.onclick = () => download(blob, filename);
    $("mediaDownloads").append(button);
  }
  persist();
  recordingStatus();
  renderQuestion();
  renderProposals();
  $("finish").disabled = true;
  $("sendText").disabled = true;
  $("chatInput").disabled = true;
  $("endSession").textContent = "✓ 終了しました";
  $("tutorStatus").textContent = "学習を終了しました";
  $("endConfirmation").textContent =
    "✓ 学習を終了しました。録音・録画は停止しています。必要な記録を下から保存できます。";
  showView("record");
  notice("学習を終了しました。必要な録音・録画とJSONを保存してください。");
  ending = false;
}
document
  .querySelectorAll("[data-view]")
  .forEach((b) => (b.onclick = () => showView(b.dataset.view)));
$("consent").onchange = () => {
  $("startVoice").disabled = !$("consent").checked;
  $("startText").disabled = !$("consent").checked;
};
$("startVoice").onclick = () => start(true);
$("startText").onclick = () => start(false);
$("connectVoice").onclick = () => connectVoice();
$("snapshot").onclick = () => snapshot(true);
$("finish").onclick = finish;
$("nextQuestion").onclick = () =>
  state.index === questions.length - 1 ? finish() : goQuestion(state.index + 1);
$("endSession").onclick = endSession;
$("mute").onclick = () => {
  muted = !muted;
  mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  $("mute").textContent = muted ? "🔇" : "🎙";
  $("mute").setAttribute(
    "aria-label",
    muted ? "マイクのミュートを解除" : "マイクをミュート",
  );
  event("microphone_muted", { muted });
};
$("chatForm").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text || state.phase !== "reviewing") return;
  if (responseActive) {
    notice(
      "AIの発話が終わってから文字を送信してください。音声なら割り込めます。",
    );
    return;
  }
  $("chatInput").value = "";
  addMessage("user", text);
  if (dc?.readyState === "open") {
    sendContext("文字で質問");
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    requestResponse();
  } else {
    $("sendText").disabled = true;
    try {
      const result = await api("chat", { ...context(), message: text });
      addMessage("assistant", result.text);
      const target =
        state.results.find((r) => r.correct === false) || state.results[0];
      if (target)
        addProposal({
          action: "revise_explanation",
          questionId: target.questionId,
          title: "話したことを教科書に残す",
          reason:
            "本人の説明と解答中の記録を合わせて、読み直す説明案を作ります。",
          source: "app",
        });
    } catch (error) {
      notice(error.message, true);
    } finally {
      $("sendText").disabled = state.phase === "ended";
    }
  }
};
$("export").onclick = () => {
  accountTime();
  download(
    new Blob(
      [
        JSON.stringify(
          {
            ...state,
            timing,
            schemaVersion: "1.0",
            questionSet: questions,
            subject: "english",
            unit: "relative-clauses-tense-vocabulary",
            note: "字幕は自動認識。メディアは別ファイル。未確認の理解度を確定しない。",
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
    `growbook-${state.id}.json`,
  );
};
$("clearLocal").onclick = () => {
  if (state.phase !== "ended") {
    notice("削除は学習を終了してから行ってください。");
    return;
  }
  if (
    !confirm(
      "このブラウザに保存した全セッションの解答・会話・録音・録画を削除します。ダウンロード済みファイルは残ります。削除しますか？",
    )
  )
    return;
  if (db) {
    const tx = db.transaction(["sessions", "chunks"], "readwrite");
    tx.objectStore("sessions").clear();
    tx.objectStore("chunks").clear();
    tx.oncomplete = () => {
      db.close();
      db = null;
      notice(
        "端末内の保存記録を削除しました。ダウンロード済みファイルは削除していません。",
      );
    };
    tx.onerror = () =>
      notice(
        "削除に失敗しました。ブラウザのサイトデータ設定を確認してください。",
        true,
      );
  }
};
document.addEventListener("visibilitychange", () => {
  accountTime();
  hiddenAt = document.hidden ? performance.now() : null;
  event(document.hidden ? "page_hidden" : "page_visible");
});
window.addEventListener("beforeunload", (e) => {
  if (!["idle", "ended"].includes(state.phase)) {
    persist();
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  mic?.getTracks().forEach((t) => t.stop());
  screen?.getTracks().forEach((t) => t.stop());
  pc?.close();
  downloadUrls.forEach(URL.revokeObjectURL);
});
try {
  db = await openDb();
} catch {
  notice("端末保存を利用できません。終了後にダウンロードしてください。", true);
}
try {
  health = await api("health");
  questions = (await api("questions")).questions;
  $("configInfo").textContent =
    `APIキー: ${health.configured ? "設定済み" : "未設定"} / 音声: ${health.realtimeModel} / 教科書生成: ${health.textModel}`;
  notice(
    health.configured
      ? "準備できました。まずは黙って解答し、終了後にAIと話して振り返ります。"
      : "APIキー未設定です。問題・採点は試せます。音声と教科書生成はキー設定後に使えます。",
    !health.configured,
  );
} catch {
  questions = await (await fetch("./questions.json")).json();
  $("configInfo").textContent = "静的プレビュー · APIサーバー未接続";
  notice(
    "GitHub Pages等の静的プレビューです。実際のAI・採点・録音デモは npm start で起動してください。",
    true,
  );
}
