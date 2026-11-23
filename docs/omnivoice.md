# Set up OmniVoice separately

OmniVoice is required only for read-aloud, Live, and Auto-Voice. The project includes the integration in `voice-bridge.py`, but neither the OmniVoice library nor its weights or recordings. Install OmniVoice in a separate environment following the [OmniVoice repository guide](https://github.com/k2-fsa/OmniVoice#installation). It also lists the PyTorch variants for your hardware and the required [model download](https://huggingface.co/k2-fsa/OmniVoice).

## Which interface is required

A compatible local HTTP service must offer `POST /tts/stream`. The normal Gradio demo from the OmniVoice repository is not a replacement for this endpoint. If you already run a compatible service, pass `-OmniVoiceUrl http://127.0.0.1:7861` to the installer or its actual local port. The installer checks the endpoint without sending text for synthesis. The default address is loopback, not a cloud TTS provider.

For your own adapter, `tts_payload()` in the project is the contract: JSON with `text`, `segments`, `language`, optional `ref_audio`/`ref_text`, and generation parameters. The service returns **raw PCM, 16-bit signed little-endian, mono**, without a WAV header, typically 24 kHz (`X-Sample-Rate` as a header). For a simple start, the adapter can call the `generate()` method shown in the [Python API example](https://github.com/k2-fsa/OmniVoice#python-api) and output the resulting audio as PCM. On its own, that returns the answer only after synthesis; for early playback start, the adapter needs real audio chunks during synthesis. A custom OmniVoice HTTP server is not part of the ZIP.

`OPENCODE_TOUCH_VOICE_POOL` can point to your own folder with voices. `OPENCODE_TOUCH_VOICE_REF` sets a default reference, and `OPENCODE_TOUCH_VOICE_REF_TEXT` sets its transcript. Without a reference, the bridge expects the service to provide a default voice. Use only your own or explicitly cleared voice recordings. Do not put them in the repository.

## Test read-aloud without dictation

Once the compatible service is running:

```powershell
.\Install-OCFluffyTouch.ps1 -Mode Standalone -Features read-aloud
.\Start-OCFluffyTouch.ps1
```

In a second window, send a short neutral sentence to the bridge:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:14974/tts.wav' `
  -Method Post -ContentType 'application/json' -Body '{"text":"Das ist ein Audiotest."}' -OutFile '.\audiotest.wav'
```

Only when `audiotest.wav` contains audible speech is the HTTP path verified. On a `404` from the stream endpoint, only `/tts.wav` can fall back to `POST /tts/full` with the same raw PCM format. On an aborted stream, an error is returned instead of a mixture of partial and duplicate output.

Also test real streaming: in the panel, read a complete answer without a voice reference once and play it again, pausing or stopping in between. The web UI uses the separate WebSocket path `/speak` without a `/tts/full` fallback. Without a reference, this path also sends `ref_audio: null` and `ref_text: null`; the service then needs a default voice. AudioWorklet keeps incoming frames in order. Auto-Voice first has OpenCode write a separate summary and reads only that.

For a local Standalone client: connect to `ws://127.0.0.1:14974/speak` and send `{"type":"start","text":"Das ist ein Test.","messageId":"test-1","voice":"default"}`. After `cache` (`miss`, `rendering`, or `hit`) and `start` with rate 24000, binary Float32 PCM frames follow (mono, little-endian), then `done` or `error`. `{"type":"stop"}` ends output on the connection. `GET /voices` lists the locally selectable references.