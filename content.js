(() => {
  "use strict";

  if (window.__handsfreeChattingV2Loaded) {
    return;
  }
  window.__handsfreeChattingV2Loaded = true;

  const POLL_MS = 1000;
  const START_TIMEOUT_MS = 45000;
  const COMPLETE_TIMEOUT_MS = 30 * 60 * 1000;
  const STALL_TIMEOUT_MS = 5 * 60 * 1000;
  const STABLE_REQUIRED_MS = 10000;
  const RECOVERY_VERIFY_MS = 60 * 1000;
  const MAX_RECOVERY_REFRESHES = 2;

  const DEFAULT_STATE = {
    prompts: [],
    currentIndex: 0,
    inFlightIndex: null,
    currentPrompt: "",
    currentPromptHash: "",
    preSendUserCount: 0,
    preSendAssistantCount: 0,
    sentAt: 0,
    lastProgressAt: 0,
    lastProgressSignature: "",
    recoveryCount: 0,
    running: false,
    phase: "idle",
    status: "idle",
    message: "",
    boundTabId: null,
    boundUrl: ""
  };

  let workerActive = false;
  let cancelToken = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hashText(text) {
    const normalized = normalizeText(text);
    let hash = 2166136261;
    for (let i = 0; i < normalized.length; i += 1) {
      hash ^= normalized.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function findFirstVisible(selectors, root = document) {
    for (const selector of selectors) {
      const elements = Array.from(root.querySelectorAll(selector));
      const visible = elements.find(isVisible);
      if (visible) return visible;
    }
    return null;
  }

  function findEditor() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('[data-testid="prompt-textarea"]') ||
      document.querySelector('textarea[placeholder*="Message"]') ||
      document.querySelector('textarea[placeholder*="消息"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  function findStopButton() {
    return findFirstVisible([
      'button[data-testid="stop-button"]',
      'button[data-testid="stop-generating-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label*="停止生成"]'
    ]);
  }

  function findContinueButton() {
    return findFirstVisible([
      'button[data-testid="continue-button"]',
      'button[aria-label*="Continue generating"]',
      'button[aria-label*="Continue response"]',
      'button[aria-label*="继续生成"]'
    ]);
  }

  function findSendButton(editor) {
    const form = editor?.closest("form");
    return (
      form?.querySelector('button[data-testid="send-button"]') ||
      form?.querySelector('button[aria-label="Send prompt"]') ||
      form?.querySelector('button[aria-label*="Send"]') ||
      form?.querySelector('button[aria-label*="发送"]') ||
      form?.querySelector('button[type="submit"]') ||
      document.querySelector('button[data-testid="send-button"]') ||
      null
    );
  }

  function getTurns() {
    return Array.from(document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]'))
      .map((node, domIndex) => ({
        node,
        domIndex,
        role: node.getAttribute("data-message-author-role"),
        text: normalizeText(node.innerText || node.textContent || "")
      }));
  }

  function getRoleCount(role) {
    return getTurns().filter((turn) => turn.role === role).length;
  }

  function findPromptTurn(prompt, expectedUserIndex = 0) {
    const normalizedPrompt = normalizeText(prompt);
    const promptHash = hashText(normalizedPrompt);
    const turns = getTurns();
    const users = turns.filter((turn) => turn.role === "user");

    const exactMatches = users.filter((turn) => {
      return turn.text === normalizedPrompt || hashText(turn.text) === promptHash;
    });

    if (exactMatches.length === 0) {
      return null;
    }

    if (Number.isInteger(expectedUserIndex) && expectedUserIndex >= 0 && expectedUserIndex < users.length) {
      const expected = users[expectedUserIndex];
      if (expected && (expected.text === normalizedPrompt || hashText(expected.text) === promptHash)) {
        return expected;
      }
    }

    return exactMatches[exactMatches.length - 1];
  }

  function findAssistantAfterPrompt(promptTurn) {
    if (!promptTurn) return null;
    const turns = getTurns();
    const start = turns.findIndex((turn) => turn.node === promptTurn.node);
    if (start < 0) return null;

    for (let i = start + 1; i < turns.length; i += 1) {
      if (turns[i].role === "user") {
        return null;
      }
      if (turns[i].role === "assistant") {
        return turns[i];
      }
    }

    return null;
  }

  function hasActiveToolState(assistantTurn) {
    if (!assistantTurn?.node) return false;
    const root = assistantTurn.node;

    if (findFirstVisible([
      '[aria-busy="true"]',
      '[data-state="loading"]',
      '[data-testid*="loading"]',
      '.animate-spin',
      '[class*="animate-spin"]'
    ], root)) {
      return true;
    }

    const tail = normalizeText(root.innerText || "").slice(-300).toLowerCase();
    const phrases = [
      "searching the web",
      "running code",
      "analyzing",
      "working on it",
      "正在搜索",
      "正在运行代码",
      "正在分析",
      "正在处理"
    ];

    return phrases.some((phrase) => tail.includes(phrase));
  }

  function detectKnownError(assistantTurn) {
    const globalVisibleError = findFirstVisible([
      '[data-testid*="error"]',
      '[role="alert"]'
    ]);

    const combined = normalizeText([
      assistantTurn?.text || "",
      globalVisibleError?.innerText || ""
    ].join(" ")).toLowerCase();

    const phrases = [
      "something went wrong",
      "network error",
      "there was an error generating a response",
      "failed to get response",
      "出了点问题",
      "网络错误",
      "生成回复时出错",
      "获取回复失败"
    ];

    return phrases.find((phrase) => combined.includes(phrase)) || "";
  }

  function inspectPromptState(prompt, expectedUserIndex = 0) {
    const promptTurn = findPromptTurn(prompt, expectedUserIndex);
    const assistantTurn = findAssistantAfterPrompt(promptTurn);
    const stopVisible = Boolean(findStopButton());
    const continueVisible = Boolean(findContinueButton());
    const toolActive = hasActiveToolState(assistantTurn);
    const error = detectKnownError(assistantTurn);
    const assistantText = assistantTurn?.text || "";

    const signature = JSON.stringify({
      promptFound: Boolean(promptTurn),
      assistantFound: Boolean(assistantTurn),
      assistantHash: hashText(assistantText),
      assistantLength: assistantText.length,
      stopVisible,
      continueVisible,
      toolActive,
      error
    });

    return {
      promptTurn,
      assistantTurn,
      promptFound: Boolean(promptTurn),
      assistantFound: Boolean(assistantTurn),
      assistantText,
      stopVisible,
      continueVisible,
      toolActive,
      error,
      signature
    };
  }

  function setEditorText(editor, text) {
    editor.focus();

    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      const prototype = editor instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

      if (valueSetter) {
        valueSetter.call(editor, text);
      } else {
        editor.value = text;
      }

      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    editor.replaceChildren(paragraph);
    editor.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }

  async function getState() {
    const result = await chrome.storage.local.get(DEFAULT_STATE);
    return { ...DEFAULT_STATE, ...result };
  }

  async function updateState(patch) {
    await chrome.storage.local.set(patch);
  }

  async function waitUntilIdle(localToken) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < START_TIMEOUT_MS) {
      if (localToken !== cancelToken) {
        throw new Error("队列已暂停。 ");
      }

      const editor = findEditor();
      if (editor && !findStopButton()) {
        return editor;
      }

      await sleep(POLL_MS);
    }

    throw new Error("等待 ChatGPT 空闲超时。可能仍在生成，或网页结构已变化。 ");
  }

  async function prepareAndSendPrompt(prompt, currentIndex, localToken) {
    const editor = await waitUntilIdle(localToken);
    const preSendUserCount = getRoleCount("user");
    const preSendAssistantCount = getRoleCount("assistant");
    const now = Date.now();

    await updateState({
      inFlightIndex: currentIndex,
      currentPrompt: prompt,
      currentPromptHash: hashText(prompt),
      preSendUserCount,
      preSendAssistantCount,
      sentAt: now,
      lastProgressAt: now,
      lastProgressSignature: "",
      recoveryCount: 0,
      phase: "sending_prepared",
      status: "running",
      message: `已准备发送第 ${currentIndex + 1} 条 prompt，正在执行重复发送保护。`
    });

    setEditorText(editor, prompt);
    await sleep(500);

    const sendButton = findSendButton(editor);
    if (!sendButton) {
      throw new Error("没有找到发送按钮。为避免重复发送，队列已停止。 ");
    }

    if (sendButton.disabled || sendButton.getAttribute("aria-disabled") === "true") {
      throw new Error("发送按钮当前不可用。为避免重复发送，队列已停止。 ");
    }

    await updateState({
      phase: "send_attempted",
      message: `正在发送第 ${currentIndex + 1} 条 prompt。`
    });

    sendButton.click();
  }

  async function waitForPromptAndResponseStart(prompt, expectedUserIndex, localToken) {
    const startedAt = Date.now();
    let lastSignature = "";

    while (Date.now() - startedAt < START_TIMEOUT_MS) {
      if (localToken !== cancelToken) {
        throw new Error("队列已暂停。 ");
      }

      const inspection = inspectPromptState(prompt, expectedUserIndex);
      if (inspection.signature !== lastSignature) {
        lastSignature = inspection.signature;
        await updateState({
          lastProgressAt: Date.now(),
          lastProgressSignature: inspection.signature,
          phase: inspection.assistantFound ? "generating" : "waiting_for_start",
          status: "waiting",
          message: inspection.assistantFound
            ? "已检测到对应回答，正在等待完成。"
            : "已确认 prompt 出现在对话中，正在等待回答开始。"
        });
      }

      if (inspection.error) {
        throw new Error(`ChatGPT 页面报告错误：${inspection.error}`);
      }

      if (inspection.promptFound && (inspection.assistantFound || inspection.stopVisible)) {
        return;
      }

      await sleep(POLL_MS);
    }

    throw new Error("发送后 45 秒内无法确认回答开始。为避免重复发送，队列已停止。 ");
  }

  async function requestRecoveryRefresh(promptNumber, total, localToken) {
    if (localToken !== cancelToken) {
      throw new Error("队列已暂停。 ");
    }

    const state = await getState();
    if (state.recoveryCount >= MAX_RECOVERY_REFRESHES) {
      await updateState({
        running: false,
        phase: "paused",
        status: "paused",
        message: `第 ${promptNumber} / ${total} 条在 ${MAX_RECOVERY_REFRESHES} 次自动恢复后仍无法确认，已暂停。`
      });
      throw new Error("RECOVERY_LIMIT_REACHED");
    }

    const nextRecoveryCount = state.recoveryCount + 1;
    await updateState({
      recoveryCount: nextRecoveryCount,
      phase: "refreshing",
      status: "recovering",
      message: `第 ${promptNumber} / ${total} 条连续 5 分钟无有效进展，正在进行第 ${nextRecoveryCount} 次自动刷新恢复。`
    });

    const response = await chrome.runtime.sendMessage({ type: "HFC_REQUEST_REFRESH" });
    if (!response?.ok) {
      throw new Error(response?.error || "自动刷新请求失败。 ");
    }

    await new Promise(() => {});
  }

  async function verifyCompletion(prompt, expectedUserIndex, localToken, options = {}) {
    const startedAt = Date.now();
    const maxWaitMs = options.recoveryMode ? RECOVERY_VERIFY_MS : COMPLETE_TIMEOUT_MS;
    let stableSince = Date.now();
    let lastSignature = "";
    let lastStorageWrite = 0;

    while (Date.now() - startedAt < maxWaitMs) {
      if (localToken !== cancelToken) {
        throw new Error("队列已暂停。 ");
      }

      const inspection = inspectPromptState(prompt, expectedUserIndex);
      const now = Date.now();
      const changed = inspection.signature !== lastSignature;

      if (changed) {
        lastSignature = inspection.signature;
        stableSince = now;
      }

      if (inspection.error) {
        return { result: "error", inspection };
      }

      const stableLongEnough = now - stableSince >= STABLE_REQUIRED_MS;
      const confirmedCompleted =
        inspection.promptFound &&
        inspection.assistantFound &&
        inspection.assistantText.length > 0 &&
        !inspection.stopVisible &&
        !inspection.continueVisible &&
        !inspection.toolActive &&
        stableLongEnough;

      if (confirmedCompleted) {
        return { result: "confirmed_completed", inspection };
      }

      const confirmedNotCompleted =
        inspection.promptFound &&
        (inspection.stopVisible || inspection.toolActive || !inspection.assistantFound);

      const state = await getState();
      const lastProgressAt = changed ? now : (state.lastProgressAt || now);

      if (changed || now - lastStorageWrite >= 5000) {
        lastStorageWrite = now;
        await updateState({
          lastProgressAt,
          lastProgressSignature: inspection.signature,
          phase: options.recoveryMode ? "recovery_verifying" : "generating",
          status: options.recoveryMode ? "verifying" : "waiting",
          message: options.recoveryMode
            ? "刷新后正在重新验证当前 prompt 与回答状态。"
            : confirmedNotCompleted
              ? "正在等待当前回答完成。"
              : "当前状态暂时无法确认，继续观察。"
        });
      }

      if (!options.recoveryMode && now - lastProgressAt >= STALL_TIMEOUT_MS) {
        return { result: "stalled", inspection };
      }

      await sleep(POLL_MS);
    }

    return { result: "uncertain", inspection: inspectPromptState(prompt, expectedUserIndex) };
  }

  async function recoverInFlight(state, localToken) {
    const prompt = state.currentPrompt || state.prompts[state.inFlightIndex];
    const expectedUserIndex = state.preSendUserCount || 0;
    const promptNumber = state.inFlightIndex + 1;
    const total = state.prompts.length;

    await updateState({
      phase: "recovery_verifying",
      status: "verifying",
      message: `正在恢复第 ${promptNumber} / ${total} 条：重新建立 prompt-response 证据链。`
    });

    const pageLoadDeadline = Date.now() + 15000;
    let inspection = inspectPromptState(prompt, expectedUserIndex);

    while (!inspection.promptFound && Date.now() < pageLoadDeadline) {
      if (localToken !== cancelToken) {
        throw new Error("队列已暂停。 ");
      }
      await sleep(POLL_MS);
      inspection = inspectPromptState(prompt, expectedUserIndex);
    }

    if (!inspection.promptFound) {
      await updateState({
        running: false,
        phase: "paused",
        status: "paused",
        message: `刷新后无法确认第 ${promptNumber} 条 prompt 是否已发送。为避免重复发送，队列已暂停。`
      });
      return false;
    }

    const verification = await verifyCompletion(prompt, expectedUserIndex, localToken, { recoveryMode: true });

    if (verification.result === "confirmed_completed") {
      return true;
    }

    if (verification.result === "error") {
      await updateState({
        running: false,
        phase: "error",
        status: "error",
        message: `恢复后检测到 ChatGPT 错误：${verification.inspection.error}`
      });
      return false;
    }

    if (verification.result === "uncertain") {
      const current = await getState();
      if (current.recoveryCount >= MAX_RECOVERY_REFRESHES) {
        await updateState({
          running: false,
          phase: "paused",
          status: "paused",
          message: `第 ${promptNumber} 条在 ${MAX_RECOVERY_REFRESHES} 次自动恢复后仍无法确认，已暂停。`
        });
        return false;
      }

      return "continue_waiting";
    }

    return "continue_waiting";
  }

  async function markCompleted(promptNumber, total) {
    await updateState({
      currentIndex: promptNumber,
      inFlightIndex: null,
      currentPrompt: "",
      currentPromptHash: "",
      preSendUserCount: 0,
      preSendAssistantCount: 0,
      sentAt: 0,
      lastProgressAt: 0,
      lastProgressSignature: "",
      recoveryCount: 0,
      phase: promptNumber === total ? "completed" : "running",
      status: promptNumber === total ? "completed" : "running",
      running: promptNumber !== total,
      message: promptNumber === total
        ? "全部 prompt 已完成。"
        : `第 ${promptNumber} / ${total} 条已确认完成，准备发送下一条。`
    });
  }

  async function runQueue() {
    if (workerActive) return;

    workerActive = true;
    const localToken = cancelToken;

    try {
      while (true) {
        const state = await getState();

        if (!state.running || localToken !== cancelToken) {
          break;
        }

        if (!Array.isArray(state.prompts) || state.currentIndex >= state.prompts.length) {
          await updateState({
            running: false,
            phase: "completed",
            status: "completed",
            message: "全部 prompt 已完成。"
          });
          break;
        }

        const promptNumber = state.currentIndex + 1;
        const total = state.prompts.length;
        const prompt = state.prompts[state.currentIndex];
        const resumingInFlight = state.inFlightIndex === state.currentIndex;

        if (resumingInFlight) {
          const recoveryResult = await recoverInFlight(state, localToken);
          if (recoveryResult === true) {
            await markCompleted(promptNumber, total);
            if (promptNumber === total) break;
            await sleep(1500);
            continue;
          }
          if (recoveryResult === false) {
            break;
          }
        } else {
          await prepareAndSendPrompt(prompt, state.currentIndex, localToken);
          const prepared = await getState();
          await waitForPromptAndResponseStart(prompt, prepared.preSendUserCount, localToken);
        }

        const current = await getState();
        const verification = await verifyCompletion(
          current.currentPrompt || prompt,
          current.preSendUserCount || 0,
          localToken
        );

        if (verification.result === "confirmed_completed") {
          await markCompleted(promptNumber, total);
          if (promptNumber === total) break;
          await sleep(1500);
          continue;
        }

        if (verification.result === "stalled") {
          await requestRecoveryRefresh(promptNumber, total, localToken);
        }

        if (verification.result === "error") {
          await updateState({
            running: false,
            phase: "error",
            status: "error",
            message: `ChatGPT 页面报告错误：${verification.inspection.error}`
          });
          break;
        }

        if (verification.result === "uncertain") {
          await updateState({
            running: false,
            phase: "paused",
            status: "paused",
            message: `第 ${promptNumber} / ${total} 条超过最大等待时间仍无法确认完成，已暂停。`
          });
          break;
        }
      }
    } catch (error) {
      if (error.message === "RECOVERY_LIMIT_REACHED") {
        return;
      }

      const pausedByUser = localToken !== cancelToken;
      await updateState({
        running: false,
        phase: pausedByUser ? "paused" : "error",
        status: pausedByUser ? "paused" : "error",
        message: pausedByUser
          ? "队列已暂停。正在生成的回答不会被中断。"
          : `已停止：${error.message}`
      });
    } finally {
      workerActive = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "HFC_PING") {
      sendResponse({ ok: true, version: "0.2.0" });
      return;
    }

    if (message?.type === "HFC_START" || message?.type === "HFC_RECOVER") {
      runQueue();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "HFC_PAUSE") {
      cancelToken += 1;
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "HFC_RESET") {
      cancelToken += 1;
      sendResponse({ ok: true });
    }
  });

  chrome.runtime.sendMessage({ type: "HFC_CONTENT_READY" }).catch(() => {});
})();
