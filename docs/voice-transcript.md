# Integrate Voice Transcript

Voice Transcript turns audio into editable text. Speech recognition runs on the machine with the voice bridge. The iPhone or your own app only records and displays the text. The module does not send a prompt to a model, generate an answer, or start a task.

## Requirements

- Python 3.11 or newer; packages from `requirements-audio.txt` and `requirements-asr.txt`. No GPU is required.
- Parakeet TDT 0.6B v3 INT8. It needs `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and `tokens.txt` in the same folder. If they are missing, see the [sherpa-onnx model guide](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html#sherpa-onnx-nemo-parakeet-tdt-0-6b-v3-int8-25-european-languages) or the [official model archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2). The four files occupy about 670 MB. Plan for about 2 GB of free space for the archive and extraction.
- For live recording in the browser: microphone permission, Web Audio with `AudioWorklet`, and a secure context (HTTPS outside localhost). WAV files do not need a microphone.

For the [installer](installation.md#transcript-only), select only `transcript`. For an existing folder, use `-ModelDir` and pass its path. If you start the voice bridge yourself in a project, you can set `OPENCODE_TOUCH_PARAKEET` in the process environment and use `python voice-bridge.py --features asr --port 14974`. `OPENCODE_TOUCH_THREADS` sets the CPU threads (default: 6).

## Quick test with an audio file

In a second window while the voice bridge is running:

```powershell
Invoke-RestMethod 'http://127.0.0.1:14974/health' | Select-Object -ExpandProperty stt
python .\examples\transcribe_wav.py .\test.wav
```

`test.wav` is your own short speech sample in **16-bit PCM WAV** format (8–96 kHz, up to 8 channels, up to 32 MiB). The example sends the WAV unchanged via `POST /asr.wav` and prints the text. The API responds with JSON `{"text":"Das ist ein Spracherkennungstest."}`. Empty, truncated, or unsupported WAV files are rejected. `stt.available: true` means the files are present; only the speech test proves that the model was loaded and executed.

## Live recording over WebSocket

| Direction | Message |
| --- | --- |
| Client → `ws://127.0.0.1:14974/asr` | `{"type":"start","rate":48000}`. Pass the actual rate of the audio context, not the model rate. Allowed: integer multiples of 20 between 8000 and 96000 Hz. |
| Client → bridge | Binary mono frames of **32-bit float PCM, little-endian**, without a WAV header, maximum 262144 bytes per frame. |
| Bridge → client | `{"type":"partial","text":"Das ist ein"}`. This is the text so far: replace the previous preview, do not append. |
| Client → bridge | Send the last buffered frames, then `{"type":"stop"}`. Optionally, `{"type":"reset"}` clears the current recording buffer without closing the connection. |
| Bridge → client | `{"type":"final","text":"Das ist ein Spracherkennungstest."}`, after which the server closes the connection. On errors, `{"type":"error","message":"…"}` may arrive. |

In the browser, the `capture-processor` in `mobile-worklet.js` supplies the frames. On stop, `flush` ensures that the last buffer also reaches the server. The bridge resamples to 16 kHz and decodes interim results with the sherpa-onnx offline recognizer. Interim results can therefore still change. The OpenCode dictation displays them word by word, follows along, and keeps the editable draft after stop. Only the user sends it; when Send is clicked during recording, the adapter waits for the final text. A dropped connection leaves the existing dictation in place.

The supplied `mobile-ios.js` is the adapter for the OpenCode composer and not a universal insertion script. For another web UI, connect it through your own local backend; the voice bridge does not accept browser requests from other origins. In the iPhone profile, fluffyTouch uses same-origin `wss://…/__opencode_touch/asr`; the proxy checks the native login and forwards with a local process token. Leave the Standalone API without login on loopback and do not expose it directly to the network.