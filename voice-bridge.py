#!/usr/bin/env python3
"""Local voice bridge for the OpenCode touch UI.

- Parakeet TDT 0.6B v3 INT8 (sherpa-onnx, CPU) for live dictation.
- Optional OmniVoice HTTP streaming for reading answers aloud.

The bridge listens on 127.0.0.1 only. The Node proxy exposes it to the phone
through the existing Tailscale HTTPS route; no additional public port.
"""

import argparse
import asyncio
import hashlib
import hmac
import io
import json
import os
import re
import sys
import threading
import time
import wave
from collections import OrderedDict
from pathlib import Path

import numpy as np

APP_DIR = Path(__file__).resolve().parent
VOICE_POOL = Path(os.environ.get("OPENCODE_TOUCH_VOICE_POOL", str(APP_DIR / "voice_pool")))
VOICE_REF = Path(os.environ.get("OPENCODE_TOUCH_VOICE_REF", str(VOICE_POOL / "reference.wav")))
VOICE_REF_TEXT = os.environ.get("OPENCODE_TOUCH_VOICE_REF_TEXT") or None
MODEL_DIR = Path(
    os.environ.get(
        "OPENCODE_TOUCH_PARAKEET",
        APP_DIR / "models" / "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    )
)
OMNIVOICE_URL = os.environ.get("OPENCODE_TOUCH_OMNIVOICE", "http://127.0.0.1:7861").rstrip("/")
VOICE_PORT = int(os.environ.get("OPENCODE_TOUCH_VOICE_PORT", "14974"))
MODEL_FILES = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")
MAX_AUDIO_BYTES = 120 * 1024 * 1024
MAX_WAV_BYTES = 32 * 1024 * 1024


def log(message: str) -> None:
    print(f"[voice-bridge] {message}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Audio helpers
# --------------------------------------------------------------------------
def resample_to_16k(samples: np.ndarray, rate: int) -> np.ndarray:
    x = np.ascontiguousarray(samples, dtype=np.float32)
    if rate == 16000:
        return x
    if rate > 16000 and rate % 16000 == 0:
        factor = rate // 16000
        usable = len(x) - (len(x) % factor)
        if not usable:
            return np.empty(0, dtype=np.float32)
        return x[:usable].reshape(-1, factor).mean(axis=1).astype(np.float32)
    if not len(x):
        return x
    count = max(1, int(round(len(x) * 16000 / rate)))
    positions = np.linspace(0, len(x) - 1, count, dtype=np.float64)
    return np.interp(positions, np.arange(len(x), dtype=np.float64), x).astype(np.float32)


def resample_linear(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    x = np.ascontiguousarray(samples, dtype=np.float32)
    if source_rate == target_rate or not len(x):
        return x
    count = max(1, int(round(len(x) * target_rate / source_rate)))
    positions = np.linspace(0, len(x) - 1, count, dtype=np.float64)
    return np.interp(positions, np.arange(len(x), dtype=np.float64), x).astype(np.float32)


# --------------------------------------------------------------------------
# Parakeet
# --------------------------------------------------------------------------
class ParakeetEngine:
    def __init__(self, model_dir: Path, threads: int = 6):
        self.model_dir = model_dir
        self.threads = threads
        self._recognizer = None
        self._error: str | None = None
        self._loading = False
        self._load_lock = threading.Lock()
        self._decode_lock = threading.Lock()

    @property
    def available(self) -> bool:
        return all((self.model_dir / name).is_file() for name in MODEL_FILES)

    @property
    def status(self) -> str:
        if self._error:
            return self._error
        if self._recognizer is not None:
            return "ready"
        if self._loading:
            return "loading"
        if not self.available:
            return f"model files missing in {self.model_dir}"
        return "lazy"

    def load(self):
        if self._recognizer is not None:
            return self._recognizer
        with self._load_lock:
            if self._recognizer is not None:
                return self._recognizer
            self._loading = True
            try:
                import sherpa_onnx

                files = {
                    key: str(self.model_dir / name)
                    for key, name in zip(("encoder", "decoder", "joiner", "tokens"), MODEL_FILES)
                }
                self._recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                    **files,
                    num_threads=max(1, self.threads),
                    sample_rate=16000,
                    feature_dim=80,
                    decoding_method="greedy_search",
                    provider="cpu",
                    model_type="nemo_transducer",
                )
                self._error = None
                log("Parakeet ready")
                return self._recognizer
            except Exception as exc:  # pragma: no cover - depends on local model
                self._error = f"Parakeet konnte nicht geladen werden: {exc}"
                log(self._error)
                raise RuntimeError(self._error) from exc
            finally:
                self._loading = False

    def preload(self) -> None:
        try:
            self.load()
        except Exception:
            pass

    def transcribe(self, samples: np.ndarray, rate: int = 48000) -> str:
        audio = np.asarray(samples, dtype=np.float32)
        if not audio.size:
            return ""
        audio16 = resample_to_16k(audio, rate)
        if not audio16.size:
            return ""
        with self._decode_lock:
            recognizer = self.load()
            stream = recognizer.create_stream()
            stream.accept_waveform(16000, audio16)
            recognizer.decode_stream(stream)
            return str(stream.result.text or "").strip()


ENGINE = ParakeetEngine(MODEL_DIR, threads=int(os.environ.get("OPENCODE_TOUCH_THREADS", "6")))


# --------------------------------------------------------------------------
# OmniVoice
# --------------------------------------------------------------------------
class TTSError(RuntimeError):
    pass


class StreamEndpointMissing(TTSError):
    """The upstream does not implement the streaming endpoint."""


class VoiceRender:
    def __init__(self):
        self.frames: list[bytes] = []
        self.size = 0
        self.changed = asyncio.Event()
        self.done = False
        self.error = None

    def notify(self):
        event, self.changed = self.changed, asyncio.Event()
        event.set()


class VoiceCache:
    """Independent renders; closing a player only detaches that listener."""

    def __init__(self):
        self.completed: OrderedDict[bytes, VoiceRender] = OrderedDict()
        self.active: dict[bytes, VoiceRender] = {}
        self.tasks: set[asyncio.Task] = set()
        self.slot = asyncio.Lock()

    def request(self, text, message_id, voice_id=None):
        ref, transcript = resolve_voice(voice_id)
        try:
            modified = ref.stat().st_mtime_ns if ref is not None else 0
        except FileNotFoundError as exc:
            if voice_id not in (None, '', 'default'):
                raise TTSError('Die gewählte Stimmdatei ist nicht mehr vorhanden.') from exc
            ref, transcript, modified = None, None, 0
        except OSError as exc:
            raise TTSError('Die Stimmdatei konnte nicht gelesen werden.') from exc
        key = hashlib.sha256(json.dumps([str(ref) if ref is not None else None, modified, transcript, message_id, text]).encode()).digest()
        if key in self.completed:
            return self.completed[key], "hit"
        if key in self.active:
            return self.active[key], "rendering"
        if len(self.active) >= 4:
            raise TTSError("Zu viele offene Vorlese-Aufträge. Bitte kurz warten.")
        render = self.active[key] = VoiceRender()
        task = asyncio.create_task(self.generate(key, text, render, (ref, transcript)))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return render, "miss"

    async def generate(self, key, text, render, voice):
        async def emit(samples, rate):
            pcm = samples if rate == 24000 else resample_linear(samples, rate, 24000)
            frame = np.ascontiguousarray(pcm, dtype="<f4").tobytes()
            render.size += len(frame)
            if render.size > MAX_AUDIO_BYTES:
                raise TTSError("Die Vertonung überschreitet das Speicherlimit.")
            render.frames.append(frame)
            render.notify()

        try:
            async with self.slot, asyncio.timeout(600):
                async with omni_client() as client:
                    await stream_omnivoice(client, text, emit, voice)
            if not render.frames:
                raise TTSError("OmniVoice hat kein Audio geliefert.")
            self.completed[key] = render
            while len(self.completed) > 2:
                self.completed.popitem(last=False)
        except TTSError as exc:
            render.error = str(exc)
        except Exception as exc:
            log(f"voice render: {type(exc).__name__}")
            render.error = "Die Vertonung konnte nicht abgeschlossen werden."
        finally:
            self.active.pop(key, None)
            render.done = True
            render.notify()


def pool_voices():
    root = VOICE_POOL.resolve()
    return {p.name: p for p in sorted(root.iterdir()) if p.suffix.lower() in {'.wav', '.flac', '.ogg', '.mp3'}
            and p.is_file() and p.resolve().parent == root} if root.is_dir() else {}


def resolve_voice(voice_id):
    if voice_id in (None, '', 'default'):
        return (VOICE_REF, VOICE_REF_TEXT) if VOICE_REF.is_file() else (None, None)
    path = pool_voices().get(voice_id) if isinstance(voice_id, str) else None
    if path is None:
        raise TTSError('Diese Stimme ist nicht mehr im OmniVoice-Stimmenpool.')
    if path.resolve() == VOICE_REF.resolve():
        return path, VOICE_REF_TEXT
    directory = VOICE_POOL.parent / 'transkripte'
    for name in (path.name, path.stem):
        source = directory / (name + '.json')
        if source.is_file() and source.resolve().parent == directory.resolve():
            try:
                text = json.loads(source.read_text(encoding='utf-8-sig')).get('text')
                if isinstance(text, str) and text.strip():
                    return path, text.strip()
            except (ValueError, OSError, AttributeError):
                pass
    return path, None


def tts_payload(text: str, chunk: str, voice=None) -> dict:
    ref, transcript = voice if voice is not None else resolve_voice(None)
    return {
        "text": chunk,
        "segments": [{"text": chunk, "pause_after": 0.0}],
        "language": "de",
        "ref_audio": str(ref) if ref is not None else None,
        "ref_text": transcript,
        "instruct": None,
        "speed": float(os.environ.get("OPENCODE_TOUCH_TTS_SPEED", "1.0")),
        "num_step": int(os.environ.get("OPENCODE_TOUCH_TTS_STEPS", "16")),
        "guidance_scale": float(os.environ.get("OPENCODE_TOUCH_TTS_GUIDANCE", "2.5")),
        "denoise": True,
        "normalize_text": True,
        "pad_duration": 0.0,
    }


def omni_client():
    import httpx

    return httpx.AsyncClient(timeout=httpx.Timeout(connect=5.0, read=90.0, write=10.0, pool=5.0), trust_env=False)


async def stream_omnivoice(client, text: str, emit, voice=None, *, endpoint="stream"):
    """Convert upstream PCM into float32 frames without losing sample boundaries."""
    try:
        async with client.stream("POST", f"{OMNIVOICE_URL}/tts/{endpoint}", json=tts_payload(text, text, voice)) as response:
            if response.status_code == 404 and endpoint == "stream":
                raise StreamEndpointMissing("OmniVoice bietet /tts/stream nicht an.")
            if not 200 <= response.status_code < 300:
                raise TTSError(f"OmniVoice hat HTTP {response.status_code} gemeldet.")
            rate = int(response.headers.get("x-sample-rate", 24000))
            if not 8000 <= rate <= 96000:
                raise TTSError("OmniVoice meldet eine ungültige Abtastrate.")
            pending = b""
            async for raw in response.aiter_bytes():
                pending += raw
                usable = len(pending) - (len(pending) % 2)
                if not usable:
                    continue
                pcm, pending = pending[:usable], pending[usable:]
                samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
                await emit(samples, rate)
            if pending:
                raise TTSError("OmniVoice hat ein unvollständiges PCM-Sample geliefert.")
    except TTSError:
        raise
    except Exception as exc:
        log(f"OmniVoice transport: {type(exc).__name__}")
        raise TTSError("OmniVoice-Audiostream konnte nicht vollständig gelesen werden.") from exc


class LocalAudioGuard:
    """Check browser provenance on HTTP and WebSocket before entering a route."""

    def __init__(self, app, token=None):
        self.app = app
        self.token = token

    async def __call__(self, scope, receive, send):
        from starlette.datastructures import Headers
        from starlette.responses import JSONResponse

        kind = scope["type"]
        if kind not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        headers = Headers(scope=scope)
        hosts = headers.getlist("host")
        host = hosts[0].lower() if len(hosts) == 1 else ""
        origins = headers.getlist("origin")
        code = 0
        if not re.fullmatch(r"(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?", host):
            code = 400
        elif origins not in ([], [f"http://{host}"]) or headers.get("sec-fetch-site", "") not in ("", "same-origin", "none"):
            code = 403
        elif self.token and not (kind == "http" and scope["path"] == "/health" and scope["method"] == "GET"):
            supplied = headers.getlist("x-fluffytouch-bridge-token")
            if len(supplied) != 1 or not hmac.compare_digest(supplied[0].encode("latin-1"), self.token.encode("ascii")):
                code = 401
        if not code:
            return await self.app(scope, receive, send)
        if kind == "websocket":
            await receive()  # Reject the opening handshake without accepting it.
            await send({"type": "websocket.close", "code": 1008})
        else:
            await JSONResponse({"error": "Lokaler Audiozugriff nicht erlaubt."}, status_code=code)(scope, receive, send)


async def bounded_body(request, limit):
    body = bytearray()
    async for part in request.stream():
        if len(body) + len(part) > limit:
            return None
        body.extend(part)
    return body


def make_app(*, asr=True, tts=True, token=None):
    from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
    from fastapi.responses import JSONResponse, Response

    if token is not None and not re.fullmatch(r"[a-f0-9]{64}", token):
        raise ValueError("Ungültige lokale Audio-Prozesskonfiguration.")
    pair_id = hashlib.sha256(token.encode("ascii")).hexdigest() if token else None
    app = FastAPI(title="oc-fluffytouch-voice", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(LocalAudioGuard, token=token)
    voice_cache = VoiceCache()

    @app.get('/voices')
    async def voices():
        return {'voices': list(pool_voices()), 'default': VOICE_REF.name if VOICE_REF.is_file() else 'Standardstimme'}

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "port": VOICE_PORT,
            "service": "oc-fluffytouch-voice-v2",
            "profile": os.environ.get("OC_FLUFFYTOUCH_PROFILE", ""),
            "pairId": pair_id,
            "stt": {
                "engine": "parakeet-tdt-0.6b-v3-int8",
                "status": ENGINE.status if ENGINE.status in ("ready", "loading", "lazy") else ("error" if ENGINE.available else "missing"),
                "available": ENGINE.available,
            } if asr else None,
            "tts": {
                "voice_exists": VOICE_REF.is_file(),
            } if tts else None,
        }

    @app.post("/tts.wav")
    async def tts_wav(request: Request):
        if request.headers.get("content-type", "").partition(";")[0].strip().lower() != "application/json":
            return JSONResponse({"error": "application/json erwartet"}, status_code=415)
        raw_body = await bounded_body(request, 256 * 1024)
        if raw_body is None:
            return JSONResponse({"error": "Anfrage zu groß"}, status_code=413)
        try:
            body = json.loads(raw_body)
        except (ValueError, RecursionError):
            body = None
        text = body.get("text") if isinstance(body, dict) else None
        text = text.strip() if isinstance(text, str) else ""
        if not text:
            return JSONResponse({"error": "text fehlt"}, status_code=400)
        if len(text) > 20000:
            return JSONResponse({"error": "Antwort zu lang zum Vorlesen."}, status_code=400)
        chunks: list[bytes] = []
        rate = 24000
        size = 0

        async def collect(samples: np.ndarray, sample_rate: int):
            nonlocal rate, size
            rate = sample_rate
            size += len(samples) * 2
            if size > MAX_AUDIO_BYTES:
                raise TTSError("Die Vertonung überschreitet das Speicherlimit.")
            chunks.append(np.clip(samples * 32768.0, -32768, 32767).astype("<i2").tobytes())

        try:
            async with asyncio.timeout(600), omni_client() as client:
                try:
                    await stream_omnivoice(client, text, collect)
                except StreamEndpointMissing:
                    if chunks:
                        raise
                    await stream_omnivoice(client, text, collect, endpoint="full")
            if not chunks:
                raise TTSError("OmniVoice hat kein Audio geliefert.")
        except TTSError as exc:
            return JSONResponse({"error": str(exc)}, status_code=502)
        except TimeoutError:
            return JSONResponse({"error": "OmniVoice hat nicht rechtzeitig geantwortet."}, status_code=504)

        pcm = b"".join(chunks)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(rate)
            handle.writeframes(pcm)
        return Response(buffer.getvalue(), media_type="audio/wav", headers={"cache-control": "no-store"})

    @app.post("/asr.wav")
    async def asr_wav(request: Request):
        raw = await bounded_body(request, MAX_WAV_BYTES)
        if raw is None:
            return JSONResponse({"error": "WAV größer als 32 MiB"}, status_code=413)
        if not raw:
            return JSONResponse({"error": "audio fehlt"}, status_code=400)
        try:
            with wave.open(io.BytesIO(raw), "rb") as handle:
                rate = handle.getframerate()
                channels = handle.getnchannels()
                width = handle.getsampwidth()
                count = handle.getnframes()
                frames = handle.readframes(count + 1)
        except (wave.Error, EOFError) as exc:
            return JSONResponse({"error": f"WAV nicht lesbar: {exc}"}, status_code=400)
        if width != 2:
            return JSONResponse({"error": "nur 16-bit PCM wird unterstützt"}, status_code=400)
        if not count or not 1 <= channels <= 8 or not 8000 <= rate <= 96000 or len(frames) != count * channels * width:
            return JSONResponse({"error": "WAV enthält keine vollständigen PCM-Frames."}, status_code=400)
        samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
        if channels > 1:
            samples = samples.reshape(-1, channels).mean(axis=1)
        if not ENGINE.available:
            return JSONResponse({"error": ENGINE.status}, status_code=503)
        try:
            text = await asyncio.to_thread(ENGINE.transcribe, samples, rate)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)
        return {"text": text}

    @app.websocket("/asr")
    async def asr_socket(websocket: WebSocket):
        await websocket.accept()
        chunks: list[np.ndarray] = []
        total = 0
        last_partial_at = 0.0
        last_partial_len = 0
        last_text = ""
        committed: list[str] = []
        client_rate = 48000

        def full_text(tail=""):
            return " ".join([*committed, tail]).strip()

        try:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                data = message.get("bytes")
                if data is not None:
                    if not data or len(data) % 4 or len(data) > 262144:
                        continue
                    chunk = np.frombuffer(data, dtype="<f4")
                    chunks.append(chunk)
                    total += len(chunk)
                    now = time.monotonic()
                    if total >= 12 * client_rate:
                        audio = np.concatenate(chunks)
                        # Prefer a quiet point near the end without dropping any samples.
                        hop = client_rate // 20
                        start = 10 * client_rate
                        windows = audio[start:12 * client_rate].reshape(-1, hop)
                        cut = start + int(np.argmin(np.mean(windows ** 2, axis=1))) * hop + hop // 2
                        text = await asyncio.to_thread(ENGINE.transcribe, audio[:cut], client_rate)
                        if text:
                            committed.append(text)
                        chunks = [audio[cut:].copy()]
                        total, last_partial_len, last_text = len(chunks[0]), 0, ""
                        last_partial_at = now
                        # Keep the previously displayed tail until the remaining audio is decoded.
                    elif total >= client_rate // 5 and (now - last_partial_at) >= 0.9 and total - last_partial_len >= client_rate // 5:
                        last_partial_at = now
                        last_partial_len = total
                        audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
                        try:
                            text = await asyncio.to_thread(ENGINE.transcribe, audio, client_rate)
                        except Exception as exc:
                            await websocket.send_json({"type": "error", "message": str(exc)})
                            continue
                        if text and text != last_text:
                            last_text = text
                            await websocket.send_json({"type": "partial", "text": full_text(text)})
                    continue
                raw = message.get("text")
                if raw is None:
                    continue
                try:
                    command = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(command, dict):
                    continue
                if command.get("type") == "stop":
                    audio = np.concatenate(chunks) if chunks else np.empty(0, dtype=np.float32)
                    text = ""
                    if audio.size and ENGINE.available:
                        try:
                            text = await asyncio.to_thread(ENGINE.transcribe, audio, client_rate)
                        except Exception as exc:
                            await websocket.send_json({"type": "error", "message": str(exc)})
                            break
                    await websocket.send_json({"type": "final", "text": full_text(text or last_text)})
                    break
                elif command.get("type") == "start":
                    requested_rate = command.get("rate")
                    if type(requested_rate) is int and 8000 <= requested_rate <= 96000 and requested_rate % 20 == 0:
                        client_rate = requested_rate
                    chunks, total, last_partial_len, last_text = [], 0, 0, ""
                    committed.clear()
                elif command.get("type") == "reset":
                    chunks, total, last_partial_len, last_text = [], 0, 0, ""
                    committed.clear()
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            log(f"ASR socket error: {exc}")
            try:
                await websocket.send_json({"type": "error", "message": "Transkription wurde unterbrochen."})
            except Exception:
                pass
        finally:
            try:
                await websocket.close()
            except Exception:
                pass

    @app.websocket("/speak")
    async def speak_socket(websocket: WebSocket):
        await websocket.accept()
        tasks = []

        try:
            # Read the start command first: only then may a second reader take
            # over the socket for stop messages. Two concurrent receives would
            # race for the first frame and stall the request.
            message = await asyncio.wait_for(websocket.receive_json(), 10)
            raw_text = message.get("text") if isinstance(message, dict) else None
            text = raw_text.strip() if isinstance(raw_text, str) else ""
            if not text:
                await websocket.send_json({"type": "error", "message": "Text fehlt"})
                return
            if len(text) > 20000:
                await websocket.send_json({"type": "error", "message": "Antwort zu lang zum Vorlesen."})
                return
            message_id = str(message.get("messageId") or "")[:512]
            render, cache_state = voice_cache.request(text, message_id, message.get('voice'))
            await websocket.send_json({"type": "cache", "state": cache_state})

            async def reader():
                try:
                    while True:
                        raw = await websocket.receive_text()
                        try:
                            command = json.loads(raw)
                        except ValueError:
                            continue
                        if isinstance(command, dict) and command.get("type") == "stop":
                            return
                except WebSocketDisconnect:
                    pass

            async def player():
                index = 0
                while True:
                    if index < len(render.frames):
                        if not index:
                            await websocket.send_json({"type": "start", "rate": 24000})
                        await websocket.send_bytes(render.frames[index])
                        index += 1
                        if index % 8 == 0:
                            await asyncio.sleep(0)
                    elif render.done:
                        if render.error:
                            await websocket.send_json({"type": "error", "message": render.error})
                        else:
                            await websocket.send_json({"type": "done"})
                        return
                    else:
                        await render.changed.wait()

            tasks = [asyncio.create_task(reader()), asyncio.create_task(player())]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        except TTSError as exc:
            await websocket.send_json({"type": "error", "message": str(exc)})
        except WebSocketDisconnect:
            pass
        except Exception as exc:
            log(f"speak socket error: {type(exc).__name__}")
            try:
                await websocket.send_json({"type": "error", "message": "Die Vertonung konnte nicht gestartet werden."})
            except (RuntimeError, WebSocketDisconnect):
                pass
        finally:
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            try:
                await websocket.close()
            except Exception:
                pass

    disabled = ({"/asr", "/asr.wav"} if not asr else set()) | ({"/speak", "/voices", "/tts.wav"} if not tts else set())
    app.router.routes[:] = [route for route in app.router.routes if route.path not in disabled]
    return app


def self_test() -> int:
    samples = np.zeros(48000, dtype=np.float32)
    assert resample_to_16k(samples, 48000).shape == (16000,)
    assert resample_to_16k(samples, 24000).shape == (32000,)
    print(json.dumps({"ok": True, "model_available": ENGINE.available, "voice": VOICE_REF.is_file()}))
    return 0


def main() -> int:
    global VOICE_PORT
    if sys.version_info < (3, 11):
        print("OC fluffyTouch braucht Python 3.11 oder neuer.", file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=VOICE_PORT)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--features", choices=("asr", "tts", "asr,tts"), default="asr,tts")
    args = parser.parse_args()
    if args.self_test:
        return self_test()

    VOICE_PORT = args.port

    import uvicorn

    asr, tts = "asr" in args.features, "tts" in args.features
    if asr and os.environ.get("OPENCODE_TOUCH_PRELOAD", "1") != "0" and ENGINE.available:
        threading.Thread(target=ENGINE.preload, name="parakeet-preload", daemon=True).start()

    log(f"listening on 127.0.0.1:{VOICE_PORT} ({args.features})")
    uvicorn.run(make_app(asr=asr, tts=tts, token=os.environ.get("OC_FLUFFYTOUCH_BRIDGE_TOKEN") or None),
                host="127.0.0.1", port=VOICE_PORT, log_level="warning", access_log=False, proxy_headers=False,
                ws_max_size=262144, ws_ping_interval=15.0, ws_ping_timeout=90.0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
