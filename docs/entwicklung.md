# Prüfungen und Veröffentlichung

## Lokale Tests

Im Projektordner mit Node.js ab 22.13:

```powershell
npm.cmd install --ignore-scripts
npm.cmd test
```

Die Node-Tests verwenden Dummys für OpenCode und temporäre Daten für Logs und Speicher. Sie prüfen unter anderem Proxy, HTTP-/WebSocket-Weitergabe, Mikrofon-Flush, Audioreihenfolge, Einstellungen, Übergabe, Rückfragen und Privatsphäre.

Für die Python-Tests reicht eine Testumgebung ohne Gewichte, OmniVoice oder OpenCode:

```powershell
py -3.11 -m venv .venv-test
& .\.venv-test\Scripts\python.exe -m pip install -r requirements-audio.txt -r requirements-tts.txt
& .\.venv-test\Scripts\python.exe -B -m unittest discover -p 'test_*.py'
```

Die Tests prüfen unter anderem den Cache ohne Referenzstimme, TTS-Abbruch ohne Fallback, abgeschnittene WAVs, lokale Zugriffsprüfungen und das Entpacken eines künstlichen Modellarchivs. `python .\voice-bridge.py --self-test` prüft zusätzlich Resampling und Modelldateien, aber keine echte Transkription.

## Geprüft in 0.2.1

54 Node- und 10 Python-Tests bestanden. Die drei neuen Node-Tests decken übernommene Aufträge auf späteren Seiten, den Abbruch bei nicht auffindbaren IDs sowie das Mitscrollen ab, ohne die Leseposition oben zu überschreiben. Alle 31 ZIP-Dateien lassen sich streng als UTF-8 lesen. Das iPhone-Verhalten wurde für diese Fassung noch nicht am Gerät geprüft.

## Weitere Nachweise aus 0.2.0

Windows PowerShell 5.1 hat alle vier Skripte geparst sowie einen nativen Prozess mit Ausgabe auf stderr ohne Abbruch geprüft. Der Standalone-Installer hat in einer frischen Projektumgebung die Python-Pakete installiert und ein vorhandenes Parakeet-Modell wiederverwendet. `-Check` schrieb nichts, eine Wiederholung ließ die Konfiguration unverändert. Der Starter lieferte mit CPU-Parakeet den synthetischen Satz „Der Mikrofontest funktioniert heute.“ über WAV und WebSocket, beim WebSocket auch einen Zwischenstand.

Mit simuliertem OpenCode-Login und einem lokalen TTS-Dummy lief der WebSocket vom Node-Proxy bis zur Python-Brücke auch ohne Referenzstimme. Eine Wiederholung kam aus dem Cache, ohne zweiten TTS-Aufruf. Der OpenCode-Installationscheck lief rein lesend; der Starter für das echte OpenCode-Profil wurde dabei nicht ausgeführt.

## Noch offen vor Veröffentlichung

Auf einer frischen Windows-VM oder einem anderen Rechner den genehmigten Upstream-Download testen. Das simulierte TTS ersetzt keine Probe mit einem echten OmniVoice-Adapter. Im gepaarten OpenCode-Profil am physischen iPhone testen: leises Diktat, letzter Satz vor Senden, Unterbrechung, Vorlesen und Pause, Auto-Voice und eine neue, unkritische Coding-Frage mit Rückfrage. Auch eine zweite manuelle Nachricht während laufender Arbeit testen. Im Verlauf nach angenommener ID abgleichen, ob die gehörte Ausgabe die Frage tatsächlich beantwortet. Einen Versandbeleg nicht mit einer inhaltlichen Antwort verwechseln.

## Dateiverzeichnis

```text
oc-fluffytouch/
  README.md                    Projektstart und Funktionswahl
  Install-OCFluffyTouch.ps1    Voraussetzungen, Pakete, Auswahl
  Start-OCFluffyTouch.ps1      Start des gewählten Profils
  Start-OpenCodeTouch.ps1      interne OpenCode-/Tailscale-Anbindung
  setup-common.ps1             gemeinsame Prüfungen
  features.json                Module und Pflichtabhängigkeiten
  requirements-audio.txt       Python-Basis für Audio
  requirements-asr.txt         Parakeet-Laufzeit
  requirements-tts.txt         Client für den OmniVoice-Dienst
  extract-model.py             Entpackt die vier Modell-Dateien
  package.json                 Node-Abhängigkeit und Testbefehl
  voice-bridge.py               Audio-API für ASR und optionales TTS
  mobile-proxy.cjs              Loopback-Proxy und mobile Webanpassungen
  mobile-ios.js                 Browser-Adapter für OpenCode
  mobile-worklet.js             Audioaufnahme und Wiedergabe
  voice-memory.cjs              persönliche SQLite-Erinnerungen
  history-log.cjs               lokaler Diagnoselog-Speicher
  *.test.cjs, test_*.py          automatisierte Regressionstests
  docs/                         Installation, Module und externe Dienste
  examples/transcribe_wav.py    minimaler API-Client
```

## Repository

GitHub-Name: `oc-fluffytouch`. Projektbeschreibung: *Modular voice tools for OpenCode: local dictation, read-aloud, and a private iPhone companion for your existing session.*

Quellen: [OpenCode V2 API](https://opencode.ai/v2/docs/api), [Tailscale Serve](https://tailscale.com/kb/1312/serve), [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), [OmniVoice](https://github.com/k2-fsa/OmniVoice). OpenCode nutzt die eigene native Anmeldung. Zusatzrouten bleiben privat und lokale Audio-Endpunkte auf Loopback. Kein Funnel- oder öffentlicher Remote-Hosting-Modus.

Nicht in Releases gehören `fluffytouch.local.json`, Dateipfade der Entwicklungsmaschine, Pairing-Links, Sitzungsdaten, Audio, Modellgewichte, Datenbanken, Logs, `.venv` und `node_modules`. Der Projektcode steht unter der MIT-Lizenz; vor einer Veröffentlichung wird das Archiv zusätzlich auf private Dateien geprüft.
