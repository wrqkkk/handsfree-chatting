"use strict";

const DEFAULT_STATE = {
  running: false,
  boundTabId: null,
  boundUrl: "",
  inFlightIndex: null,
  phase: "idle"
};

function isChatGPTUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url || "");
}

function isMissingReceiverError(error) {
  const text = String(error?.message || error || "");
  return /Receiving end does not exist|Could not establish connection/i.test(text);
}

async function getState() {
  return chrome.storage.local.get(DEFAULT_STATE);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "HFC_PING" });
    return;
  } catch (error) {
    if (!isMissingReceiverError(error)) {
      throw error;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function sendRecover(tabId, reason) {
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: "HFC_RECOVER",
      reason
    });
  } catch (error) {
    console.warn("[handsfree-chatting] recovery message failed", error);
  }
}

async function resolveBoundTab(state) {
  if (Number.isInteger(state.boundTabId)) {
    try {
      const tab = await chrome.tabs.get(state.boundTabId);
      if (tab?.id && isChatGPTUrl(tab.url)) {
        return tab;
      }
    } catch (_) {
      // Fall through to URL matching.
    }
  }

  if (state.boundUrl) {
    const tabs = await chrome.tabs.query({});
    const exact = tabs.find((tab) => tab.id && tab.url === state.boundUrl && isChatGPTUrl(tab.url));
    if (exact) {
      await chrome.storage.local.set({ boundTabId: exact.id });
      return exact;
    }
  }

  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "HFC_GET_SENDER_TAB") {
    sendResponse({
      ok: true,
      tabId: sender.tab?.id ?? null,
      url: sender.tab?.url || ""
    });
    return;
  }

  if (message?.type === "HFC_REQUEST_REFRESH") {
    (async () => {
      try {
        const state = await getState();
        const tabId = sender.tab?.id ?? state.boundTabId;

        if (!Number.isInteger(tabId)) {
          throw new Error("无法确定需要刷新的 ChatGPT 标签页。 ");
        }

        if (Number.isInteger(state.boundTabId) && state.boundTabId !== tabId) {
          throw new Error("恢复请求来自非绑定标签页，已拒绝。 ");
        }

        await chrome.tabs.reload(tabId);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }

  if (message?.type === "HFC_CONTENT_READY") {
    (async () => {
      const state = await getState();
      const tabId = sender.tab?.id;

      if (
        state.running &&
        state.inFlightIndex !== null &&
        Number.isInteger(tabId) &&
        tabId === state.boundTabId
      ) {
        setTimeout(() => {
          sendRecover(tabId, "content-ready");
        }, 750);
      }
    })();

    sendResponse({ ok: true });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !isChatGPTUrl(tab.url)) {
    return;
  }

  (async () => {
    const state = await getState();
    if (
      state.running &&
      state.inFlightIndex !== null &&
      tabId === state.boundTabId
    ) {
      await sendRecover(tabId, "tab-reloaded");
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  (async () => {
    const state = await getState();
    if (!state.running || state.inFlightIndex === null) {
      return;
    }

    const tab = await resolveBoundTab(state);
    if (tab?.id) {
      await sendRecover(tab.id, "browser-startup");
    }
  })();
});
