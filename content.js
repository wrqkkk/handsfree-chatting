(() => {
  "use strict";

  if (window.__handsfreeChattingV1Loaded) {
    return;
  }
  window.__handsfreeChattingV1Loaded = true;

  const POLL_MS = 1000;
  const START_TIMEOUT_MS = 45000;
  const COMPLETE_TIMEOUT_MS = 30 * 60 * 1000;
  const STABLE_REQUIRED_MS = 5000;

  let workerActive = false;
  let cancelToken = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    return (
      document.querySelector('button[data-testid="stop-button"]') ||
      document.querySelector('button[data-testid="stop-generating-button"]') ||
      document.querySelector('button[aria-label="Stop streaming"]') ||
      document.querySelector('button[aria-label="Stop generating"]') ||
      null
    );
  }

  function findSendButton(editor) {
    const form = editor?.closest("form");
    return (
      form?.querySelector('button[data-testid="send-button"]') ||
      form?.querySelector('button[aria-label="Send prompt"]') ||
      form?.querySelector('button[type="submit"]') ||
      document.querySelector('button[data-testid="send-button"]') ||
      null
    );
  }

  function getAssistantMessages() {
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  }

  function getLatestAssistantSnapshot() {
    const messages = getAssistantMessages();
    const latest = messages[messages.length - 1];
    return {
      count: messages.length,
      text: latest?.innerText || ""
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
    editor.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      })
    );
  }

  async function waitUntilIdle(localToken) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < START_TIMEOUT_MS) {
      if (localToken !== cancelToken) {
        throw new Error("队列已暂停。 ");
      }

      const editor = findEditor();
      const stopButton = findStopButton();

      if (editor && !stopButton) {
        return editor;
      }

      await sleep(POLL_MS);
    }

    throw new Error("等待 ChatGPT 空闲超时。可能仍在生成，或网页结构已变化。");
  }

  async function sendPrompt(prompt, localToken) {
    const editor = await waitUntilIdle(localToken);
    const before = getLatestAssistantSnapshot();

    setEditorText(editor, prompt);
    await sleep(500);

    const sendButton = findSendButton(editor);
    if (!sendButton) {
      throw new Error("没有找到发送按钮。请刷新 ChatGPT 页面后重试。");
    }

    if (sendButton.disabled || sendButton.getAttribute("aria-disabled") === "true") {
      throw new Error("发送按钮当前不可用。请确认输入框已成功写入 prompt。");
    }

    sendButton.click();
    return before;
  }

  async function waitForGenerationStart(before, localToken) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < START_TIMEOUT_MS) {
      if (localToken !== cancelToken) {
        throw new Error("队列已暂停。 ");
      }

      const now = getLatestAssistantSnapshot();
      if (
        findStopButton() ||
        now.count > before.count ||
        (now.count === before.count && now.text !== before.text)
      ) {
        return;
      }

      await sleep(POLL_MS);
    }

    throw new Error("发送后 45 秒内没有检测到回答开始。队列已暂停，避免重复发送。");
  }

  async function waitForGenerationComplete(localToken) {
    const startedAt = Date.now();
    let lastSnapshot = getLatestAssistantSnapshot();
    let stableSince = Date.now();

    while (Date.now() - startedAt < COMPLETE_TIMEOUT_MS) {
      if (localToken !== cancelToken) {
        throw new Error("队列已暂停。 ");
      }

      await sleep(POLL_MS);

      const snapshot = getLatestAssistantSnapshot();
      const changed = snapshot.count !== lastSnapshot.count || snapshot.text !== lastSnapshot.text;

      if (changed) {
        lastSnapshot = snapshot;
        stableSince = Date.now();
      }

      const stopButton = findStopButton();
      const editor = findEditor();
      const stableLongEnough = Date.now() - stableSince >= STABLE_REQUIRED_MS;

      if (!stopButton && editor && stableLongEnough && snapshot.count > 0) {
        return;
      }
    }

    throw new Error("等待回答完成超过 30 分钟。队列已暂停。");
  }

  async function updateState(patch) {
    await chrome.storage.local.set(patch);
  }

  async function runQueue() {
    if (workerActive) {
      return;
    }

    workerActive = true;
    const localToken = cancelToken;

    try {
      while (true) {
        const state = await chrome.storage.local.get({
          prompts: [],
          currentIndex: 0,
          inFlightIndex: null,
          inFlightBeforeCount: 0,
          inFlightBeforeText: "",
          running: false
        });

        if (!state.running || localToken !== cancelToken) {
          break;
        }

        if (!Array.isArray(state.prompts) || state.currentIndex >= state.prompts.length) {
          await updateState({
            running: false,
            status: "completed",
            message: "全部 prompt 已完成。"
          });
          break;
        }

        const promptNumber = state.currentIndex + 1;
        const total = state.prompts.length;
        const prompt = state.prompts[state.currentIndex];
        const resumingInFlight = state.inFlightIndex === state.currentIndex;

        let before;

        if (resumingInFlight) {
          before = {
            count: state.inFlightBeforeCount || 0,
            text: state.inFlightBeforeText || ""
          };

          await updateState({
            status: "waiting",
            message: `继续等待第 ${promptNumber} / ${total} 条回答完成。`
          });
        } else {
          await updateState({
            status: "running",
            message: `正在发送第 ${promptNumber} / ${total} 条 prompt。`
          });

          before = await sendPrompt(prompt, localToken);

          await updateState({
            inFlightIndex: state.currentIndex,
            inFlightBeforeCount: before.count,
            inFlightBeforeText: before.text,
            status: "waiting",
            message: `第 ${promptNumber} / ${total} 条已发送，正在等待回答完成。`
          });
        }

        await waitForGenerationStart(before, localToken);
        await waitForGenerationComplete(localToken);

        await updateState({
          currentIndex: promptNumber,
          inFlightIndex: null,
          inFlightBeforeCount: 0,
          inFlightBeforeText: "",
          status: promptNumber === total ? "completed" : "running",
          running: promptNumber !== total,
          message: promptNumber === total
            ? "全部 prompt 已完成。"
            : `第 ${promptNumber} / ${total} 条已完成，准备发送下一条。`
        });

        if (promptNumber === total) {
          break;
        }

        await sleep(1500);
      }
    } catch (error) {
      const pausedByUser = localToken !== cancelToken;
      await updateState({
        running: false,
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
    if (message?.type === "HFC_START") {
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
})();