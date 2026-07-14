# Changelog

All notable changes to **handsfree-chatting** will be documented in this file.

The project currently uses simple semantic-style versioning while it is experimental.

## [0.2.0] - 2026-07-14

### Added

- Five-minute **no-progress stall detection** for in-flight ChatGPT responses.
- Automatic recovery refreshes for the bound ChatGPT tab.
- Refresh-time recovery verification that rebuilds the current prompt-response relationship from the page.
- Multi-signal completion detection using:
  - current prompt presence,
  - corresponding assistant turn presence,
  - response stability,
  - stop-generation state,
  - continue-generating state,
  - active tool/loading state,
  - known page errors.
- Three-way completion reasoning: `confirmed_completed`, `confirmed_not_completed`, and `uncertain`.
- Duplicate-send protection by persisting in-flight prompt identity and pre-send conversation position before clicking Send.
- Per-prompt recovery limit of two automatic refreshes.
- Bound-tab state (`boundTabId` and `boundUrl`) so recovery targets the ChatGPT tab where the queue started.
- Manifest V3 `background.js` service worker for refresh coordination and reload recovery.
- Expanded internal phases including `sending_prepared`, `send_attempted`, `waiting_for_start`, `generating`, `refreshing`, and `recovery_verifying`.
- V2 project progress snapshot: `PROJECT_PROGRESS_20260714_V2.md`.

### Changed

- Answer stability requirement increased from 5 seconds to 10 seconds.
- Refresh is explicitly treated as a recovery action, never as proof that a response is complete.
- Recovery now prefers pausing over resending whenever the extension cannot prove what happened to an in-flight prompt.
- Queue control is tied to the originally bound ChatGPT tab instead of whichever ChatGPT tab happens to be active later.
- README updated for V2 reliability and recovery behavior.

### Safety

- The queue advances only after `confirmed_completed`.
- An unresolved in-flight prompt is never automatically resent after refresh.
- Repeated unresolved stalls stop after two recovery refreshes instead of entering an infinite loop.

## [0.1.1] - 2026-07-14

### Fixed

- Fixed `Could not establish connection. Receiving end does not exist.` after installing or reloading the extension while an older ChatGPT tab was already open.
- Added automatic `content.js` injection and one retry when the popup cannot find a receiving content script.
- Added the `scripting` permission required for recovery injection.

## [0.1.0] - 2026-07-14

### Added

- Initial Microsoft Edge Manifest V3 extension.
- Prompt queue separated by `---PROMPT---`.
- Automatic prompt sending in one ChatGPT conversation.
- Basic answer completion detection.
- Start, pause, continue, and reset controls.
- Queue state persistence in `chrome.storage.local`.
