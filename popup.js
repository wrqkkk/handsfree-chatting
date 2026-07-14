const DEFAULT_STATE = {
  rawQueue: "",
  prompts: [],
  currentIndex: 0,
  inFlightIndex: null,
  inFlightBeforeCount: 0,
  inFlightBeforeText: "",
  running: false,
  status: "idle",
  message: "请在 ChatGPT 对话页面中打开本扩展。"
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

  startBtn.textContent = state.running ? "运行中" : current > 0 && current < prompts.length ? "继续" : "开始";
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

async function getChatGPTTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
    throw new Error("请先打开一个 ChatGPT 对话页面，再点击扩展。 ");
  }

  return tab;
}

async function sendToContent(message) {
  const tab = await getChatGPTTab();
  return chrome.tabs.sendMessage(tab.id, message);
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
    const currentIndex = queueChanged ? 0 : Math.min(previous.currentIndex || 0, prompts.length);

    await chrome.storage.local.set({
      rawQueue,
      prompts,
      currentIndex,
      running: true,
      status: "running",
      message: "准备发送下一条 prompt。"
    });

    const response = await sendToContent({ type: "HFC_START" });
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
    await chrome.storage.local.set({
      running: false,
      status: "paused",
      message: "队列已暂停。正在生成的回答不会被中断。"
    });
    await sendToContent({ type: "HFC_PAUSE" });
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
  try {
    await chrome.storage.local.set({ ...DEFAULT_STATE, rawQueue: queueInput.value });
    await sendToContent({ type: "HFC_RESET" });
  } catch (_) {
    // 即使当前不在 ChatGPT 页面，也允许本地状态完成重置。
  }

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