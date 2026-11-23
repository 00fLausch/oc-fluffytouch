# Modules and data flows

`features.json` names the modules and their required dependencies. The installer resolves these dependencies and stores the selection locally. The starter passes the same selection to the proxy, browser, and voice bridge. A disabled module is not started automatically. Its extra controls and local endpoints are unavailable; normal OpenCode access remains unchanged. The ZIP intentionally includes the code of deselected features so you can change the selection later.

`settings`, `handoff`, and `expert` enable or disable features of the fluffyTouch UI. They are not an access boundary for native OpenCode APIs. Audio, memories, and history have their own switches in the proxy.

| Module | Input → Output | Code and use |
| --- | --- | --- |
| OpenCode integration | Original web UI → original UI with touch adjustments | `Start-OpenCodeTouch.ps1`, `mobile-proxy.cjs`. The proxy adds HTML, JavaScript, and the service worker; it uses the same running instance. Changes to native web APIs or the DOM may require adjustments. |
| `transcript` | Audio → interim and final text | `voice-bridge.py`, `mobile-worklet.js`, composer adapter in `mobile-ios.js`. Usable on its own via WAV HTTP or PCM WebSocket. |
| `read-aloud` | Text → audio | `voice-bridge.py`, audio worklet, and speaker next to “Copy”. Includes pause, resume, and stop; the render cache is transient. Usable on its own when the separate [OmniVoice service](omnivoice.md) is running. |
| `live` | Speech recognition + short conversation context → spoken dialogue | `mobile-ios.js`, text generation through the existing OpenCode model access. The composer stays more compact; Live listens again only after read-aloud. |
| `auto-voice` | New completed main-chat answer → spoken summary | `mobile-ios.js`, event stream and separate text generation through OpenCode. The summary is not a new message in the main chat. Live and Auto-Voice can be installed but cannot run at the same time. |
| `handoff` | Explicitly requested task → concrete message in the existing session | `mobile-ios.js`, `POST /api/session/{sessionID}/prompt`. The coding chat receives the text formulated from the task, not a transcript of the live conversation. |
| `settings` | Unambiguous settings request → verified setting | `mobile-ios.js`: app code reads the selection and options, changes only on a clear request, and confirms after reading back. The voice menu and OpenCode's native model picker remain independent of this voice-command module. |
| `expert` | Explicit question → separate second opinion | `mobile-ios.js`, OpenCode text generation instead of `/prompt`. The advisory model must be specified during setup and available in OpenCode. The request can consume model usage. |
| `memory` | Permitted preference → SQLite entry in the tailnet profile | `voice-memory.cjs`, `js-tiktoken`. Confirmed by default, with optional consent per live conversation. 8,000 tokens per tailnet profile, independent of the model. Private memories and answers formulated from them are not a source for tasks or expert requests. |
| `history` | Main-chat and live events → local JSONL | `history-log.cjs`. The log works without Live. Reconciliation when the chat is opened, with timestamps and message IDs; no web read access. |

## Handoff: conversation, task, and result

For the summary, the live dialogue that has not yet been handed off counts. Restrictions that were not captured as notes therefore remain available. Private, local settings/memory operations and expert turns are filtered out before summarizing. Contributions remain in the handoff context until admission is confirmed. If the target, reference, or a required restriction is missing, the assistant asks before sending. A mere mention and an offered intention do not start work.

On a confirmed handoff, the app sends only the precise task and the context required for it. If you explicitly want an earlier question answered, the assistant can reuse its wording or refer to the existing message without adding it twice. The assistant reads back the task that was actually admitted. A message ID proves admission, not execution and not the substantive answer. A follow-up task may queue while the main chat is working. The live history is not attached later as a background note in this package version.

When Live takes over observing an already running task, it searches for the message ID across up to 20 history pages, including pages before Live started. If it cannot find the ID, it says so instead of claiming an answer or searching forever. With the live panel open, the main-chat timeline follows along while you are at the end. If you scroll up, following resumes only when you reach the end again.

### Role hint in OpenCode

Opening Live does not change the session's instructions. Only before an explicit handoff that will admit a new message does fluffyTouch create the entry `opencode-touch-live-role` in that OpenCode session. It tells the main chat to answer questions and not merely acknowledge their receipt. The entry remains after Live ends and after uninstallation. If it cannot be read back, the task is not admitted. The read-back proves the entry, not the model's implementation.

To remove it, use the native CLI of the still-running OpenCode instance: replace `<sessionID>` with the ID of the affected session and perform the read-back as well. The command deletes only this one entry, no messages and no other instructions.

```powershell
opencode api delete '/api/experimental/session/<sessionID>/instructions/entries/opencode-touch-live-role'
opencode api get '/api/experimental/session/<sessionID>/instructions/entries'
```

The result of the second query must no longer contain `opencode-touch-live-role`. While `handoff` is active, a new explicit handoff creates the hint again. A removal takes effect at the next OpenCode step boundary.

### Local audio access

The audio API binds to loopback only and checks `Host`, browser origin, and Fetch Metadata. In the OpenCode profile, the starter generates a random process token: only the proxy attaches it to the connection to the voice bridge, after checking the native login and — for WebSockets — the exact page origin. Browsers never receive the token. In the Standalone profile, local native clients need no login by default; the bridge is not an endpoint for foreign browser origins or for network exposure.

## What data leaves the machine

In iPhone mode, microphone frames travel over the private tailnet to the voice bridge on the PC. Parakeet processes them locally. The local TTS adapter receives the text to read aloud. When you use Live, Auto-Voice, or the second opinion, OpenCode may send excerpts to the provider already configured in OpenCode for the respective text generation. For personal Live answers, this also applies to voice memories. “Local” for recognition and output therefore does not mean that every chat model used runs locally.

With the history log enabled, usable chat texts and status data are stored under `%LOCALAPPDATA%\OCFluffyTouch\verlaufslog.jsonl`. Rotation keeps one previous file; there is no replay of past live turns. The log is confidential. It does not collect audio files, credentials, tool output, internal reasoning, or memory actions marked private. User data and voice recordings remain outside the published source code.