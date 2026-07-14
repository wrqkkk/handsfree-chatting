# handsfree-chatting

**handsfree-chatting** is a minimal Microsoft Edge extension that sends a queue of prompts to ChatGPT one by one. It waits for the current response to finish before sending the next prompt, so you do not need to stay at the computer just to press Send repeatedly.

> Version: **V1 / 0.1.0**  
> Status: **experimental local test version**

## What V1 does

V1 deliberately keeps the design simple. You paste several prompts into the extension popup and separate them with:

```text
---PROMPT---
```

For example:

```text
Analyze experiment 1 and explain the main result.

---PROMPT---

Based on the previous answer, compare model A and model B.

---PROMPT---

Now propose the next experiment and explain the rationale.
```

After you click **开始 / Start**, the extension will:

```text
Send prompt 1
      ↓
Wait for the ChatGPT response to finish
      ↓
Send prompt 2
      ↓
Wait again
      ↓
Continue until the queue is complete
```

The extension does **not** export, download, or save ChatGPT responses. It only observes the page state needed to decide when it is safe to send the next prompt.

## Install in Microsoft Edge

Download or clone this repository, then open this address in Edge:

```text
edge://extensions/
```

Turn on **Developer mode**, click **Load unpacked**, and select the folder that contains `manifest.json`.

Then open a ChatGPT conversation at:

```text
https://chatgpt.com/
```

After installing or reloading the extension, refresh the ChatGPT page once.

Microsoft's official Edge documentation describes the same local sideloading flow: open the extensions management page, enable Developer mode, choose **Load unpacked**, and select the extension directory containing `manifest.json`.

## How to use

Open the ChatGPT conversation where you want the prompts to run. Click the **handsfree-chatting** extension icon. Paste your prompt queue into the text box and separate prompts with `---PROMPT---`. Click **开始**.

The popup displays the current status and progress. You can also pause the queue. Pausing does not stop a response that ChatGPT is already generating; it only prevents the next queued prompt from being sent.

## Safety behavior in V1

V1 is intentionally conservative. When it cannot find the ChatGPT editor or Send button, cannot detect that a response has started, or waits too long for a response to finish, it stops the queue instead of blindly sending more prompts.

This is important when later prompts depend on earlier conversation context.

## Current limitations

This version depends on the current ChatGPT webpage DOM. Because the ChatGPT web interface can change, future UI updates may require selector maintenance.

V1 is designed for one active ChatGPT tab and one queue at a time. It does not support conditional branching, reading response content to choose the next prompt, multiple simultaneous conversations, CAPTCHA handling, rate-limit circumvention, or automatic response export.

The completion detector combines three signals: whether a stop-generation button is visible, whether the assistant message is still changing, and whether the input editor is available again. The answer must remain stable for several seconds before the next prompt is sent.

## Files

```text
handsfree-chatting/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── content.js
└── README.md
```

## Privacy

V1 runs locally in your browser. It does not use an external server and does not send your prompt queue to any third-party endpoint created by this extension.

The prompt text is stored in the browser extension's local storage so the popup can preserve your queue between openings.

## Development notes

The extension uses Manifest V3, a content script to interact with the ChatGPT page DOM, and `chrome.storage.local` to preserve queue state.

The key implementation principle is **reliability before intelligence**: when the extension is uncertain, it pauses rather than guessing.

## Troubleshooting

If the extension says it cannot find the editor or Send button, refresh the ChatGPT page after installing or reloading the extension.

If Edge reports an extension error, open `edge://extensions/`, find **handsfree-chatting**, and inspect the error details.

If ChatGPT's webpage structure has changed, the DOM selectors in `content.js` may need to be updated.

## Disclaimer

This project is an experimental personal productivity tool. Use it responsibly and do not use it to bypass platform limits, access controls, CAPTCHA challenges, or other protective mechanisms.