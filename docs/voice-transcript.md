# Voice Transcript integrieren

Voice Transcript macht aus Audio einen editierbaren Text. Die Spracherkennung läuft auf dem Rechner mit der Sprachbrücke. Das iPhone oder eine eigene App nimmt nur auf und zeigt den Text an. Das Modul sendet keinen Prompt an ein Modell, erzeugt keine Antwort und startet keinen Auftrag.

## Voraussetzungen

- Python ab 3.11; Pakete aus `requirements-audio.txt` und `requirements-asr.txt`. Eine GPU ist nicht erforderlich.
- Parakeet TDT 0.6B v3 INT8. Benötigt werden `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx` und `tokens.txt` im selben Ordner. Falls sie fehlen: [sherpa-onnx-Modellanleitung](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html#sherpa-onnx-nemo-parakeet-tdt-0-6b-v3-int8-25-european-languages) oder [offizielles Modellarchiv](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2). Die vier Dateien belegen rund 670 MB. Für Archiv und Entpacken etwa 2 GB freien Platz einplanen.
- Für Live-Aufnahme im Browser: Mikrofonberechtigung, Web Audio mit `AudioWorklet` und ein sicherer Kontext (HTTPS außerhalb von localhost). Für WAV-Dateien ist kein Mikrofon nötig.

Für den [Installer](installation.md#nur-transkript) wählst du nur `transcript`. Für einen vorhandenen Ordner nimm `-ModelDir` und gib seinen Pfad an. Wer die Sprachbrücke selbst in einem Projekt startet, kann `OPENCODE_TOUCH_PARAKEET` in der Prozessumgebung setzen und `python voice-bridge.py --features asr --port 14974` verwenden. `OPENCODE_TOUCH_THREADS` stellt die CPU-Threads ein (Vorgabe: 6).

## Schnelltest mit einer Audiodatei

In einem zweiten Fenster, während die Sprachbrücke läuft:

```powershell
Invoke-RestMethod 'http://127.0.0.1:14974/health' | Select-Object -ExpandProperty stt
python .\examples\transcribe_wav.py .\test.wav
```

`test.wav` ist eine eigene kurze Sprachprobe im Format **16-Bit-PCM-WAV** (8–96 kHz, bis 8 Kanäle, bis 32 MiB). Das Beispiel überträgt die WAV unverändert per `POST /asr.wav` und gibt den Text aus. Die API antwortet mit JSON `{"text":"Das ist ein Spracherkennungstest."}`. Leere, abgeschnittene oder nicht unterstützte WAV-Dateien werden abgelehnt. `stt.available: true` bedeutet, dass die Dateien vorhanden sind; erst der Sprachtest belegt, dass das Modell geladen und ausgeführt wurde.

## Laufende Aufnahme per WebSocket

| Richtung | Nachricht |
| --- | --- |
| Client → `ws://127.0.0.1:14974/asr` | `{"type":"start","rate":48000}`. Gib die tatsächliche Rate des Audio-Kontexts an, nicht die Modellrate. Erlaubt: ganzzahlige Vielfache von 20 zwischen 8000 und 96000 Hz. |
| Client → Brücke | Binäre Mono-Frames aus **32-Bit-Gleitkomma-PCM, little-endian**, ohne WAV-Header, maximal 262144 Byte je Frame. |
| Brücke → Client | `{"type":"partial","text":"Das ist ein"}`. Das ist der bisherige Text der Aufnahme: die vorige Vorschau ersetzen, nicht anhängen. |
| Client → Brücke | Die letzten gepufferten Frames senden, dann `{"type":"stop"}`. Optional löscht `{"type":"reset"}` den bisherigen Aufnahmepuffer, ohne die Verbindung zu beenden. |
| Brücke → Client | `{"type":"final","text":"Das ist ein Spracherkennungstest."}`, danach schließt der Server die Verbindung. Bei Fehlern kann `{"type":"error","message":"…"}` eintreffen. |

Im Browser liefert der `capture-processor` in `mobile-worklet.js` die Frames. Beim Stopp sorgt `flush` dafür, dass auch der letzte Puffer beim Server ankommt. Die Brücke rechnet auf 16 kHz um und dekodiert Zwischenergebnisse mit dem Offline-Recognizer von sherpa-onnx. Zwischenstände können sich also noch ändern. Das OpenCode-Diktat zeigt sie wortweise an, scrollt mit und behält nach Stopp den editierbaren Entwurf. Erst der Nutzer sendet ihn; beim Klick auf Senden während der Aufnahme wartet der Adapter auf den Endtext. Ein Verbindungsabbruch lässt das bisherige Diktat stehen.

Die gelieferte `mobile-ios.js` ist der Adapter für den OpenCode-Composer und kein universelles Einfügeskript. Für eine andere Weboberfläche binde sie mit einem eigenen lokalen Backend an; die Sprachbrücke akzeptiert keine Browser-Anfragen von anderen Origins. Im iPhone-Profil verwendet fluffyTouch same-origin `wss://…/__opencode_touch/asr`; der Proxy prüft die native Anmeldung und leitet mit einem lokalen Prozess-Token weiter. Die Standalone-API ohne Login auf Loopback lassen und nicht direkt ins Netz freigeben.
