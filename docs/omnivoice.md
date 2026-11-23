# OmniVoice separat einrichten

OmniVoice ist nur für Vorlesen, Live und Auto-Voice erforderlich. Das Projekt enthält die Anbindung in `voice-bridge.py`, aber weder die OmniVoice-Bibliothek noch deren Gewichte oder Aufnahmen. Installiere OmniVoice in einer getrennten Umgebung nach der [Anleitung des OmniVoice-Repositories](https://github.com/k2-fsa/OmniVoice#installation). Dort stehen auch die zur Hardware passenden PyTorch-Varianten und der benötigte [Modellbezug](https://huggingface.co/k2-fsa/OmniVoice).

## Welche Schnittstelle gebraucht wird

Ein kompatibler lokaler HTTP-Dienst muss `POST /tts/stream` anbieten. Die normale Gradio-Demo aus dem OmniVoice-Repository ist kein Ersatz für diesen Endpunkt. Falls du bereits einen kompatiblen Dienst betreibst, gib beim Installer `-OmniVoiceUrl http://127.0.0.1:7861` oder dessen tatsächlichen lokalen Port an. Der Installer prüft den Endpunkt, ohne Text zur Synthese zu schicken. Die Standardadresse ist Loopback, nicht ein Cloud-TTS-Anbieter.

Für einen eigenen Adapter ist `tts_payload()` im Projekt der Vertrag: JSON mit `text`, `segments`, `language`, optionalen `ref_audio`/`ref_text` und Generierungsparametern. Der Dienst liefert **rohes PCM, 16-Bit signed little-endian, mono**, ohne WAV-Header, typischerweise 24 kHz (`X-Sample-Rate` als Header). Für einen einfachen Start kann der Adapter die im [Python-API-Beispiel](https://github.com/k2-fsa/OmniVoice#python-api) gezeigte `generate()`-Methode aufrufen und das resultierende Audio als PCM ausgeben. Das alleine liefert die Antwort erst nach der Synthese; für frühen Wiedergabestart braucht der Adapter echte Audiostücke während der Synthese. Ein eigener OmniVoice-HTTP-Server ist nicht Teil der ZIP.

`OPENCODE_TOUCH_VOICE_POOL` kann auf einen eigenen Ordner mit Stimmen zeigen. `OPENCODE_TOUCH_VOICE_REF` setzt eine Standard-Referenz, `OPENCODE_TOUCH_VOICE_REF_TEXT` deren Transkript. Ohne Referenz erwartet die Brücke, dass der Dienst eine Standardstimme bereitstellt. Verwende nur eigene oder ausdrücklich freigegebene Sprachaufnahmen. Lege sie nicht ins Repository.

## Vorlesen ohne Transkript testen

Sobald der kompatible Dienst läuft:

```powershell
.\Install-OCFluffyTouch.ps1 -Mode Standalone -Features read-aloud
.\Start-OCFluffyTouch.ps1
```

In einem zweiten Fenster einen kurzen neutralen Satz an die Brücke geben:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:14974/tts.wav' `
  -Method Post -ContentType 'application/json' -Body '{"text":"Das ist ein Audiotest."}' -OutFile '.\audiotest.wav'
```

Erst wenn `audiotest.wav` hörbare Sprache enthält, ist der HTTP-Weg geprüft. Bei einem `404` vom Stream-Endpunkt kann nur `/tts.wav` auf `POST /tts/full` mit demselben Roh-PCM-Format zurückfallen. Bei einem abgebrochenen Stream kommt ein Fehler statt einer Mischung aus teilweiser und doppelter Ausgabe.

Teste zusätzlich echtes Streaming: Im Panel einmal eine vollständige Antwort ohne Stimmreferenz vorlesen und erneut abspielen, zwischendurch pausieren bzw. stoppen. Die Weboberfläche nutzt den separaten WebSocket-Weg `/speak` ohne `/tts/full`-Ersatz. Ohne Referenz schickt auch dieser Weg `ref_audio: null` und `ref_text: null`; der Dienst braucht dann eine Standardstimme. AudioWorklet hält eingehende Frames in Reihenfolge. Auto-Voice lässt OpenCode erst eine gesonderte Zusammenfassung schreiben und liest nur diese.

Für einen lokalen Standalone-Client: Verbinde dich mit `ws://127.0.0.1:14974/speak` und sende `{"type":"start","text":"Das ist ein Test.","messageId":"test-1","voice":"default"}`. Auf `cache` (`miss`, `rendering` oder `hit`) und `start` mit der Rate 24000 folgen binäre Float32-PCM-Frames (mono, little-endian), dann `done` oder `error`. `{"type":"stop"}` beendet die Ausgabe auf der Verbindung. `GET /voices` listet die lokal auswählbaren Referenzen.
