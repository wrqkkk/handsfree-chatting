# handsfree-chatting

**handsfree-chatting** is a reliability-first Microsoft Edge extension that sends a queue of prompts to ChatGPT one by one. You prepare the prompts; the extension handles waiting, turn-taking, stall detection, page recovery, and safe continuation.

> Version: **V2 / 0.2.0**  
> Status: **experimental reliability and recovery version**

## Project philosophy

The project deliberately avoids becoming a fully autonomous agent. The user keeps control of goals, reasoning direction, prompt design, and judgment. The extension focuses on low-value interaction overhead: waiting for a response, repeatedly checking whether it has finished, manually pressing Send for the next prepared prompt, and recovering from ordinary frontend stalls.

The core principle is:

> **Reliability before intelligence. When uncertain, pause instead of guessing.**

## What V2 does

Paste several prompts into the extension popup and separate them with:

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

After you click **开始 / Start**, the extension runs this loop:

```text
Send current prompt
        ↓
Confirm that the prompt really appears in the conversation
        ↓
Wait for the corresponding assistant turn
        ↓
Use multiple signals to verify completion
        ↓
If confirmed complete, send the next prompt
```

## Reliability and recovery in V2

V2 introduces a recovery protocol for the failure mode where the ChatGPT webpage appears stuck even though the server-side answer may later become available after a refresh.

The extension now distinguishes total waiting time from **no-progress time**. A response can run for a long time without being considered stalled as long as observable progress continues. If there is no effective progress for five continuous minutes, the extension enters recovery instead of blindly waiting forever.

The recovery flow is:

```text
5 minutes without effective progress
        ↓
Mark the task as recovering
        ↓
Automatically refresh the bound ChatGPT tab
        ↓
Reload the content script
        ↓
Find the exact current user prompt in the conversation
        ↓
Find the assistant turn that follows that prompt
        ↓
Re-evaluate completion from page evidence
        ↓
Confirmed complete → continue queue
Still incomplete → keep waiting
Cannot safely verify → pause
```

**Refreshing is never treated as proof of completion.**

## Completion detector

V2 uses multiple signals instead of a single timer. It checks whether the current prompt is present in the conversation, whether a corresponding assistant turn exists after it, whether the assistant response has renderable content, whether a stop-generation button is visible, whether a continue-generating state is visible, whether a known active tool state is present, whether the page reports a known error, and whether the response has remained stable for ten seconds.

Internally, the detector separates three epistemic states:

```text
confirmed completed
confirmed not completed
uncertain
```

Only `confirmed completed` advances the queue.

## Duplicate-send protection

Before clicking Send, V2 stores the identity and pre-send conversation position of the current prompt. After a refresh or interruption, it does not automatically resend an in-flight prompt. Instead, it searches the conversation for the expected user turn and reconstructs the prompt-response relationship.

If the extension cannot prove what happened, it pauses rather than risking a duplicate prompt.

## Automatic refresh limits

Each prompt can trigger at most two automatic recovery refreshes. If the same prompt remains unresolved after two recovery cycles, the queue stops and reports the uncertainty.

This prevents infinite refresh loops.

## Bound ChatGPT tab

A running queue is bound to the ChatGPT tab where it was started. A lightweight Manifest V3 background service worker identifies the tab and performs recovery reloads. This prevents another open ChatGPT tab from silently taking over the same in-flight queue.

V2 still supports one active queue at a time. Full independent multi-tab queues are reserved for a later architecture.

## Install in Microsoft Edge

Clone or download this repository, then open:

```text
edge://extensions/
```

Turn on **Developer mode**, click **Load unpacked**, and select the folder that contains `manifest.json`.

After pulling a new version of this repository, return to `edge://extensions/`, click the reload icon for **handsfree-chatting**, and refresh any already-open ChatGPT tab once so the newest content script is active.

## How to use

Open the ChatGPT conversation where the queue should run. Click the **handsfree-chatting** extension icon, paste your prompts separated by `---PROMPT---`, and click **开始**.

You can switch to other browser tabs while the queue runs. Do not intentionally navigate the bound ChatGPT tab to another website. If the ChatGPT page itself is manually refreshed while a prompt is in flight, V2 will attempt to recover automatically.

## Files

```text
handsfree-chatting/
├── manifest.json
├── background.js
├── popup.html
├── popup.css
├── popup.js
├── content.js
├── README.md
├── CHANGELOG.md
└── PROJECT_PROGRESS_20260714_V2.md
```

## Current timing parameters

The current experimental defaults are:

```text
Polling interval:              1 second
Answer stability requirement: 10 seconds
No-progress stall threshold:  5 minutes
Recovery verification window: 60 seconds
Maximum auto refreshes:       2 per prompt
Maximum total answer wait:    30 minutes
```

These values are intentionally conservative and may become configurable later.

## Current limitations

V2 depends on the current ChatGPT webpage DOM. Future ChatGPT UI changes may require selector maintenance.

V2 is still designed for one active queue at a time. It does not yet provide multiple independent simultaneous queues, a full background-owned scheduler, conditional branching, autonomous prompt generation, CAPTCHA handling, rate-limit circumvention, or automatic response export.

Completion detection is necessarily heuristic because the extension observes the webpage rather than an official task-status API. V2 therefore prefers false negatives and pausing over false positive completion and accidental context corruption.

## Privacy

V2 runs locally in your browser. It does not use an external server and does not send your prompt queue to any third-party endpoint created by this extension.

The prompt queue and execution metadata are stored in `chrome.storage.local` so that recovery can survive page refreshes.

## Disclaimer

This project is an experimental personal productivity tool. Use it responsibly and do not use it to bypass platform limits, access controls, CAPTCHA challenges, or other protective mechanisms.
