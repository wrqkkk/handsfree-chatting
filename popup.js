const DEFAULT_STATE = {
  rawQueue: "",
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
  message: "请在 ChatGPT 对话页面中打开本扩展。",
  boundTabId: null,
  boundUrl: ""
};

const queueInput = document.getElementById("queueInput");
const statusText = document.getElementById("statusText");
const progressText = document.getElementById("progressText");
const messageText = document.getElementById("messageText");
const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resetBtn = document.getElementById("resetBtn");

let saveTimer = null;

function parsePrompts(raw) {
  return raw
    .split(/\n\s*---PROMPT---\s*\n/g)
    .map((prompt) => prompt.trim())
    .filter(Boolean);
}

function statusLabel(status) {
  const labels = {
    idle: "未开始",
    running: "运行中",
    waiting: "等待回答",
    recovering: "正在恢复",
    verifying: "正在验证",
    paused: "已暂停",
    completed: "已完成",
    error: "出现错误"
  };
  return labels[status] || status;
}

function render(state) {
  const prompts = Array.isArray(state.prompts) ? state.prompts : [];
  const current = Math.min(state.currentIndex || 0, prompts.length);

  statusText.textContent = statusLabel(state.status || "idle");
  progressText.textContent = `${current} / ${prompts.length}`;
  messageText.textContent = state.message || "";

  const canResume = !state.running && current < prompts.length && (current > 0 || state.inFlightIndex !== null);
  startBtn.textContent = state.running ? "运行中" : canResume ? "继续" : "开始";
  startBtn.disabled = Boolean(state.running);
  pauseBtn.disabled = !state.running;
}

async function getState() {
  const result = await chrome.storage.local.get(DEFAULT_STATE);
  return { ...DEFAULT_STATE, ...result };
}

async function setState(patch) {
  await chrome.storage.local.set(patch);
  render(await getState());
}

async function getActiveChatGPTTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
    throw new Error("请先打开一个 ChatGPT 对话页面，再点击扩展。 ");
  }

  return tab;
}

function isMissingReceiverError(error) {
  const errorText = String(error?.message || error || "");
  return /Receiving end does not exist|Could not establish connection/i.test(errorText);
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function resolveControlTab(state) {
  if (Number.isInteger(state.boundTabId)) {
    try {
      const tab = await chrome.tabs.get(state.boundTabId);
      if (tab?.id && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
        return tab;
      }
    } catch (_) {
      // Fall through.
    }
  }

  return getActiveChatGPTTab();
}

async function startQueue() {
  const rawQueue = queueInput.value.trim();
  const prompts = parsePrompts(rawQueue);

  if (prompts.length === 0) {
    await setState({ status: "error", message: "队列为空，请先输入至少一个 prompt。" });
    return;
  }

  try {
    const previous = await getState();
    const queueChanged = previous.rawQueue !== rawQueue;

    if (queueChanged && previous.inFlightIndex !== null) {
      throw new Error("当前仍有未确认的 in-flight prompt。为避免重复发送，请先完成或重置当前队列。 ");
    }

    let targetTab;
    let currentIndex;

    if (!queueChanged && Number.isInteger(previous.boundTabId) && (previous.currentIndex > 0 || previous.inFlightIndex !== null)) {
      targetTab = await resolveControlTab(previous);
      currentIndex = Math.min(previous.currentIndex || 0, prompts.length);
    } else {
      targetTab = await getActiveChatGPTTab();
      currentIndex = queueChanged ? 0 : Math.min(previous.currentIndex || 0, prompts.length);
    }

    const resetExecutionFields = queueChanged
      ? {
          inFlightIndex: null,
          currentPrompt: "",
          currentPromptHash: "",
          preSendUserCount: 0,
          preSendAssistantCount: 0,
          sentAt: 0,
          lastProgressAt: 0,
          lastProgressSignature: "",
          recoveryCount: 0,
          phase: "idle"
        }
      : {};

    await chrome.storage.local.set({
      rawQueue,
      prompts,
      currentIndex,
      running: true,
      status: previous.inFlightIndex !== null ? "verifying" : "running",
      message: previous.inFlightIndex !== null
        ? "正在恢复并验证当前 prompt。"
        : "准备发送下一条 prompt。",
      boundTabId: targetTab.id,
      boundUrl: targetTab.url || previous.boundUrl || "",
      ...resetExecutionFields
    });

    const response = await sendToTab(targetTab.id, { type: "HFC_START" });
    if (!response?.ok) {
      throw new Error(response?.error || "无法启动队列。请刷新 ChatGPT 页面后重试。");
    }
  } catch (error) {
    await chrome.storage.local.set({
      running: false,
      status: "error",
      message: error.message
    });
  }

  render(await getState());
}

async function pauseQueue() {
  try {
    const state = await getState();
    await chrome.storage.local.set({
      running: false,
      status: "paused",
      phase: "paused",
      message: "队列已暂停。正在生成的回答不会被中断。"
    });

    if (Number.isInteger(state.boundTabId)) {
      await sendToTab(state.boundTabId, { type: "HFC_PAUSE" });
    }
  } catch (error) {
    await chrome.storage.local.set({
      running: false,
      status: "error",
      message: error.message
    });
  }

  render(await getState());
}

async function resetQueue() {
  const currentRaw = queueInput.value;
  const state = await getState();

  try {
    if (Number.isInteger(state.boundTabId)) {
      await sendToTab(state.boundTabId, { type: "HFC_RESET" });
    }
  } catch (_) {
    // Reset local state even when the page is unavailable.
  }

  await chrome.storage.local.set({
    ...DEFAULT_STATE,
    rawQueue: currentRaw
  });

  render(await getState());
}

queueInput.addEventListener("input", () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ rawQueue: queueInput.value });
  }, 250);
});

startBtn.addEventListener("click", startQueue);
pauseBtn.addEventListener("click", pauseQueue);
resetBtn.addEventListener("click", resetQueue);

chrome.storage.onChanged.addListener(async (_changes, areaName) => {
  if (areaName === "local") {
    render(await getState());
  }
});

(async function init() {
  const state = await getState();
  queueInput.value = state.rawQueue || "";
  render(state);
})();
