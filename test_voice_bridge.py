"""Regression tests with synthetic audio, no OpenCode, weights or TTS service."""

import importlib.util
import io
import json
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import httpx
import numpy as np
from fastapi.testclient import TestClient as ASGIClient
from starlette.websockets import WebSocketDisconnect


spec = importlib.util.spec_from_file_location('voice_bridge', Path(__file__).with_name('voice-bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class AudioFrames(httpx.AsyncByteStream):
    def __init__(self, frames, broken=False):
        self.frames = frames
        self.broken = broken

    async def __aiter__(self):
        for frame in self.frames:
            yield frame
        if self.broken:
            raise httpx.ReadError('test stream ended early')


PCM = np.array([1024, -1024, 64, -32768, 32767], dtype='<i2').tobytes()


class TestClient(ASGIClient):
    def __init__(self, app):
        super().__init__(app, base_url='http://127.0.0.1:14974')

    def websocket_connect(self, url, **kwargs):
        return super().websocket_connect('ws://127.0.0.1:14974' + url, **kwargs)


def chunks(broken=False):
    return httpx.Response(200, headers={'x-sample-rate': '24000'}, stream=AudioFrames([PCM[:3], PCM[3:]], broken))


class VoiceBridgeTests(unittest.TestCase):
    def setUp(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.reference = root / 'not-installed.wav'
        self.enterContext(patch.object(bridge, 'VOICE_REF', self.reference))
        self.enterContext(patch.object(bridge, 'VOICE_REF_TEXT', 'Unused when the file is missing'))
        self.enterContext(patch.object(bridge, 'VOICE_POOL', self.reference.parent))

    def mock_tts(self, handler):
        self.enterContext(patch.object(bridge, 'omni_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))))

    def test_speak_uses_default_voice_and_cache_when_reference_missing(self):
        calls = []

        def upstream(request):
            self.assertEqual(request.url.path, '/tts/stream')
            payload = json.loads(request.content)
            self.assertIsNone(payload['ref_audio'])
            self.assertIsNone(payload['ref_text'])
            calls.append(payload['text'])
            return chunks()

        self.mock_tts(upstream)
        with TestClient(bridge.make_app(asr=False)) as client:
            for expected in ('miss', 'hit'):
                with client.websocket_connect('/speak') as ws:
                    ws.send_json({'text': 'Eine Testansage.', 'messageId': 'fixture-voice'})
                    self.assertEqual(ws.receive_json(), {'type': 'cache', 'state': expected})
                    self.assertEqual(ws.receive_json(), {'type': 'start', 'rate': 24000})
                    self.assertEqual(ws.receive_bytes() + ws.receive_bytes(), (np.frombuffer(PCM, '<i2').astype('<f4') / 32768).tobytes())
                    self.assertEqual(ws.receive_json(), {'type': 'done'})
            self.assertEqual(calls, ['Eine Testansage.'])
            self.assertEqual(client.get('/voices').json(), {'voices': [], 'default': 'Standardstimme'})

    def test_speak_reports_an_unknown_selected_voice(self):
        with TestClient(bridge.make_app(asr=False)) as client, client.websocket_connect('/speak') as ws:
            ws.send_json({'text': 'Test', 'voice': 'invalid.wav'})
            self.assertEqual(ws.receive_json()['type'], 'error')

    def test_wav_falls_back_on_missing_endpoint_and_preserves_pcm_once(self):
        requests = []

        def upstream(request):
            requests.append(request.url.path)
            return httpx.Response(404) if request.url.path == '/tts/stream' else chunks()

        self.mock_tts(upstream)
        with TestClient(bridge.make_app(asr=False)) as client:
            reply = client.post('/tts.wav', json={'text': 'Test'})
        self.assertEqual(reply.status_code, 200)
        with wave.open(io.BytesIO(reply.content), 'rb') as wav:
            self.assertEqual(wav.getframerate(), 24000)
            self.assertEqual(wav.readframes(20), PCM)
        self.assertEqual(requests, ['/tts/stream', '/tts/full'])

    def test_midstream_failure_is_reported_without_retry(self):
        requests = []

        def upstream(request):
            requests.append(request.url.path)
            return chunks(broken=True)

        self.mock_tts(upstream)
        with TestClient(bridge.make_app(asr=False)) as client:
            reply = client.post('/tts.wav', json={'text': 'Test'})
        self.assertEqual(reply.status_code, 502)
        self.assertIn('nicht vollständig', reply.json()['error'])
        self.assertEqual(requests, ['/tts/stream'])

    def test_other_http_errors_do_not_retry(self):
        requests = []

        def upstream(request):
            requests.append(request.url.path)
            return httpx.Response(503)

        self.mock_tts(upstream)
        with TestClient(bridge.make_app(asr=False)) as client:
            reply = client.post('/tts.wav', json={'text': 'Test'})
        self.assertEqual(reply.status_code, 502)
        self.assertIn('503', reply.json()['error'])
        self.assertEqual(requests, ['/tts/stream'])

    def test_wav_bad_header_and_partial_frame_are_rejected(self):
        mem = io.BytesIO()
        with wave.open(mem, 'wb') as wav:
            wav.setparams((2, 2, 16000, 0, 'NONE', 'none'))
            wav.writeframes(b'\x02\x00\x02\x00' * 8)
        data = mem.getvalue()

        class EngineStub:
            available = True

            def transcribe(self, samples, rate):
                if len(samples) != 8 or rate != 16000:
                    raise AssertionError('bad PCM passed the WAV check')
                return 'Test'

        with patch.object(bridge, 'ENGINE', EngineStub()), TestClient(bridge.make_app(tts=False)) as client:
            for bad in (b'RIFF\x00', data[:-1], data[:-2], data[:-4]):
                with self.subTest(size=len(bad)):
                    self.assertEqual(client.post('/asr.wav', content=bad).status_code, 400)
            self.assertEqual(client.post('/asr.wav', content=data).json(), {'text': 'Test'})

    def test_standalone_http_and_websocket_reject_untrusted_provenance(self):
        with TestClient(bridge.make_app(asr=False)) as client:
            self.assertEqual(client.get('/voices').status_code, 200)
            self.assertEqual(client.get('/voices', headers={'host': 'fixture.invalid:14974'}).status_code, 400)
            self.assertEqual(client.get('/voices', headers={'sec-fetch-site': 'cross-site'}).status_code, 403)
            for origin in ('https://fixture.invalid', 'null', 'http://127.0.0.1:8000'):
                with self.subTest(origin=origin), self.assertRaises(WebSocketDisconnect) as exc:
                    with client.websocket_connect('/speak', headers={'origin': origin}):
                        self.fail('foreign Origin accepted')
                self.assertEqual(exc.exception.code, 1008)
            self.assertEqual(client.post('/tts.wav', content='{"text":"Test"}', headers={'content-type': 'text/plain'}).status_code, 415)

    def test_paired_audio_requires_token_without_putting_it_in_health(self):
        token = 'ab' * 32
        headers = {'X-FluffyTouch-Bridge-Token': token}
        with TestClient(bridge.make_app(asr=False, token=token)) as client:
            health = client.get('/health')
            self.assertEqual(health.status_code, 200)
            self.assertNotIn(token, health.text)
            self.assertIsNotNone(health.json()['pairId'])
            self.assertEqual(client.get('/voices').status_code, 401)
            self.assertEqual(client.get('/voices', headers=headers).status_code, 200)
            self.assertEqual(client.get('/voices', headers={**headers, 'origin': 'https://fixture.invalid'}).status_code, 403)
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect('/speak'):
                    self.fail('paired access without token')
            with client.websocket_connect('/speak', headers=headers) as ws:
                ws.send_json({'text': ''})
                self.assertEqual(ws.receive_json()['type'], 'error')


if __name__ == '__main__':
    unittest.main()
