# Tests and release

## Local tests

In the project folder with Node.js 22.13 or newer:

```powershell
npm.cmd install --ignore-scripts
npm.cmd test
```

The Node tests use dummies for OpenCode and temporary data for logs and storage. They cover, among other things, the proxy, HTTP/WebSocket forwarding, microphone flush, audio order, settings, handoff, follow-up questions, and privacy.

For the Python tests, an environment without weights, OmniVoice, or OpenCode is enough:

```powershell
py -3.11 -m venv .venv-test
& .\.venv-test\Scripts\python.exe -m pip install -r requirements-audio.txt -r requirements-tts.txt
& .\.venv-test\Scripts\python.exe -B -m unittest discover -p 'test_*.py'
```

The tests cover, among other things, caching without a reference voice, TTS abort without fallback, truncated WAVs, local access checks, and unpacking an artificial model archive. `python .\voice-bridge.py --self-test` additionally checks resampling and model files, but not real transcription.

## Verified in 0.2.1

54 Node and 10 Python tests passed. The three new Node tests cover adopted tasks on later pages, aborting when an ID cannot be found, and following the timeline without overriding the reading position at the top. All 31 ZIP files can be read strictly as UTF-8. The iPhone behavior has not yet been tested on a device for this version.

## Further evidence from 0.2.0

Windows PowerShell 5.1 parsed all four scripts and checked a native process writing to stderr without aborting. The Standalone installer installed the Python packages in a fresh project environment and reused an existing Parakeet model. `-Check` wrote nothing, and a repeat left the configuration unchanged. With CPU Parakeet, the starter delivered the synthetic sentence “Der Mikrofontest funktioniert heute.” over WAV and WebSocket, including an interim result over WebSocket.

With a simulated OpenCode login and a local TTS dummy, the WebSocket ran from the Node proxy to the Python bridge without a reference voice. A repeat came from the cache without a second TTS call. The OpenCode installation check ran read-only; the starter for the real OpenCode profile was not executed.

## Still open before release

On a fresh Windows VM or another machine, test the approved upstream download. The simulated TTS does not replace a probe with a real OmniVoice adapter. In the paired OpenCode profile on a physical iPhone, test quiet dictation, the last sentence before Send, interruption, read-aloud and pause, Auto-Voice, and a new, unproblematic coding question with a follow-up question. Also test a second manual message while work is running. In the history, compare the admitted ID with whether the audio you heard actually answers the question. Do not confuse a delivery receipt with a substantive answer.

## File layout

```text
oc-fluffytouch/
  README.md                    Project start and feature selection
  Install-OCFluffyTouch.ps1    Prerequisites, packages, selection
  Start-OCFluffyTouch.ps1      Start of the selected profile
  Start-OpenCodeTouch.ps1      Internal OpenCode/Tailscale integration
  setup-common.ps1             Shared checks
  features.json                Modules and required dependencies
  requirements-audio.txt       Python audio base
  requirements-asr.txt         Parakeet runtime
  requirements-tts.txt         Client for the OmniVoice service
  extract-model.py             Extracts the four model files
  package.json                 Node dependency and test command
  voice-bridge.py              Audio API for ASR and optional TTS
  mobile-proxy.cjs             Loopback proxy and mobile web adjustments
  mobile-ios.js                Browser adapter for OpenCode
  mobile-worklet.js            Audio recording and playback
  voice-memory.cjs             Personal SQLite memories
  history-log.cjs              Local diagnostic log store
  *.test.cjs, test_*.py        Automated regression tests
  docs/                        Installation, modules, and external services
  examples/transcribe_wav.py   Minimal API client
```

## Repository

GitHub name: `oc-fluffytouch`. Project description: *Modular voice tools for OpenCode: local dictation, read-aloud, and a private iPhone companion for your existing session.*

Sources: [OpenCode V2 API](https://opencode.ai/v2/docs/api), [Tailscale Serve](https://tailscale.com/kb/1312/serve), [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), [OmniVoice](https://github.com/k2-fsa/OmniVoice). OpenCode uses its own native login. Additional routes stay private and local audio endpoints stay on loopback. No Funnel or public remote hosting mode.

Releases must not include `fluffytouch.local.json`, file paths from the development machine, pairing links, session data, audio, model weights, databases, logs, `.venv`, or `node_modules`. The project code is licensed under the MIT License; before a release, the archive is also checked for private files.