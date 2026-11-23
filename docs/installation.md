# Installation

Run the commands from the unpacked project folder in Windows PowerShell 5.1 or newer. Standalone requires a local Windows machine; OpenCode additionally requires a running OpenCode V2 Desktop, Node.js 22.13 or newer, and Tailscale on both PC and iPhone. The audio modules need **Python 3.11 or newer**; 3.11 is the tested starting point for a fresh setup. The installer does not need a global Python package installation.

## What the installer checks

1. **Choose target and modules.** Enter the feature numbers separated by commas. Required modules are added and listed before any change. For example, Live needs Transcript and Read-aloud; Auto-Voice needs only Read-aloud.
2. **Detect what exists.** For the selected combination, setup checks Python and actually importable packages, the four Parakeet files, and, if needed, the local OmniVoice HTTP endpoint. In OpenCode mode it also checks Node.js, the running desktop process, and Tailscale status. For voice memories it additionally checks the token counter.
3. **Set up what is missing.** Setup installs Python packages into `.venv` in the project; `js-tiktoken` only for voice memories. It can download a missing Parakeet model from the official source after your approval. Python extracts the four required files without `tar.exe`. For missing system programs, OpenCode, the Tailscale login, and the separate OmniVoice service, follow the instructions printed by the installer. An existing installation or a foreign virtual environment is not rewritten.
4. **Save the selection.** `fluffytouch.local.json` contains the enabled modules and local paths. The same selection and prerequisites do not require another download on the next run. Installing does not start an OpenCode service or a public route.
5. **Run the start instruction.** The starter reads this selection and starts only the matching project components. For the iPhone start it also checks the service, native API, HTML, free port, and private serve route. A foreign route or a Funnel on the selected port aborts instead of being replaced.

`-Check` validates without writing, installing, downloading, or starting. Exit code `2` indicates missing components or required manual work. `-VoicePython` and `-ModelDir` allow existing compatible environments and models; the path to an environment explicitly selected with `-VoicePython` is only checked. `-Yes` confirms package installation and configuration, but a missing model download in an automated run only together with `-DownloadModel`.

## Transcript only

```powershell
.\Install-OCFluffyTouch.ps1 -Check -Mode Standalone -Features transcript
.\Install-OCFluffyTouch.ps1 -Mode Standalone -Features transcript
.\Start-OCFluffyTouch.ps1
```

The API listens on `http://127.0.0.1:14974` by default. Press Ctrl+C to stop it. If the port is in use, choose another one with `-VoicePort`. [The WAV and streaming examples](voice-transcript.md) show how your app receives text.

## Dictation in an existing OpenCode chat

1. Open OpenCode Desktop and keep Windows awake. Sign in to Tailscale on the PC and iPhone in the same private tailnet. HTTPS and access rules must allow the private connection.
2. Run `.\Install-OCFluffyTouch.ps1 -Mode OpenCode -Features transcript`. The microphone appears on the native composer, without the live agent or read-aloud. Open the installer interactively again for other combinations.
3. Run `.\Start-OCFluffyTouch.ps1 -Pair`. The script uses HTTPS port `8443`, proxy `14973`, and voice `14974` by default. `-Port`, `-ProxyPort`, and `-VoicePort` allow other free ports. It sets up only the selected private serve route; no Funnel and no reset.
4. Open the one-time link printed by OpenCode directly in Safari on the iPhone. Do not save it, redirect it to a file or transcript, or share it. If it expires, run with `-Pair` again.
5. Optionally add it via **Share → Add to Home Screen**. If iOS asks you to sign in again there, use a new one-time link.

Without `-Pair`, the starter launches the selected combination without a new one-time link. After a Windows restart, open OpenCode first and then run the starter. When switching from the older ZIP or a different module selection, restart the matching fluffyTouch processes and reload the iPhone web app. For “andere Konfiguration” (other configuration) or “gehören nicht als Paar zusammen” (do not belong together as a pair), check the processes on the **selected** proxy/voice ports. Stop only processes that are clearly identified as belonging to this package installation. OpenCode and another private installation remain untouched.

## Choose a consultation model

If you select `expert`, the installer asks for `provider/model-id`; in a non-interactive run, pass `-ExpertModel 'provider/model-id'`. Use the exact reference from the OpenCode model list. When you say “Ask the big model”, the app checks this model. It neither switches the main chat model nor starts a task. Without a matching selection there is no automatic fallback.

## When something is missing

| Message | Next step |
| --- | --- |
| Python or Node is missing | Use the vendor page shown by the installer; then open a new PowerShell window and run the check again. |
| Model is missing or does not load | Check [Voice Transcript](voice-transcript.md). All four INT8 files must be in the same folder. Finding the files is not a successful speech test. |
| OmniVoice is missing | Read the [compatibility guide](omnivoice.md) or deselect Read-aloud and the modules that depend on it. |
| No session or no microphone in Safari | Check the Tailscale connection and native pairing; allow microphone access when prompted. Close and reopen the home-screen app. |
| Route already in use | Choose a different private HTTPS port. Do not delete the foreign entry. |
| OpenCode is incompatible after an update | Check the starter output and the [development guide](entwicklung.md). The browser extension and service worker depend on the structure and version of the original UI. |