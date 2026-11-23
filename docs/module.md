# Module und Datenflüsse

`features.json` benennt die Module und ihre Pflichtabhängigkeiten. Der Installer löst diese Abhängigkeiten auf und speichert die Auswahl lokal. Der Starter gibt dieselbe Auswahl an Proxy, Browser und Sprachbrücke weiter. Ein deaktiviertes Modul wird nicht automatisch gestartet. Seine Zusatzbedienung und lokalen Endpunkte stehen nicht zur Verfügung; normaler OpenCode-Zugriff bleibt unverändert. Die ZIP enthält bewusst auch den Code der abgewählten Funktionen, damit du die Auswahl später ändern kannst.

`settings`, `handoff` und `expert` schalten Funktionen der fluffyTouch-Oberfläche frei oder ab. Sie sind keine Zugriffsgrenze für native OpenCode-APIs. Audio, Erinnerungen und Verlauf haben eigene Schalter im Proxy.

| Modul | Eingang → Ausgang | Code und Nutzung |
| --- | --- | --- |
| OpenCode-Integration | Original-Weboberfläche → Originaloberfläche mit Touch-Anpassung | `Start-OpenCodeTouch.ps1`, `mobile-proxy.cjs`. Der Proxy ergänzt HTML, JavaScript und den Service-Worker; er nutzt dieselbe laufende Instanz. Änderungen an nativen Web-APIs oder DOM können Anpassungen nötig machen. |
| `transcript` | Audio → vorläufiger und finaler Text | `voice-bridge.py`, `mobile-worklet.js`, Composer-Adapter in `mobile-ios.js`. Einzeln nutzbar per WAV-HTTP oder PCM-WebSocket. |
| `read-aloud` | Text → Audio | `voice-bridge.py`, Audio-Worklet und Lautsprecher neben „Kopieren“. Enthält Pause, Fortsetzen und Stop; der Rendercache ist flüchtig. Einzeln nutzbar, wenn der separate [OmniVoice-Dienst](omnivoice.md) läuft. |
| `live` | Spracherkennung + kurzer Gesprächskontext → gesprochener Dialog | `mobile-ios.js`, Textgenerierung mit dem bestehenden OpenCode-Modellzugang. Das Eingabefeld bleibt kompakter; Live lauscht erst nach dem Vorlesen wieder. |
| `auto-voice` | Neue abgeschlossene Hauptchat-Antwort → gesprochene Zusammenfassung | `mobile-ios.js`, Ereignisstrom und separate Textgenerierung über OpenCode. Die Zusammenfassung ist keine neue Nachricht im Hauptchat. Live und Auto-Voice können installiert sein, aber nicht gleichzeitig laufen. |
| `handoff` | Ausdrücklich gewünschte Aufgabe → konkrete Nachricht in der vorhandenen Sitzung | `mobile-ios.js`, `POST /api/session/{sessionID}/prompt`. Der Coding-Chat bekommt den anhand des Auftrags formulierten Text, keine Mitschrift der Live-Unterhaltung. |
| `settings` | Eindeutiger Einstellungswunsch → geprüfte Einstellung | `mobile-ios.js`: App-Code liest Auswahl und Optionen, ändert nur bei klarem Wunsch und bestätigt nach Rücklesen. Voice-Menü und OpenCodes native Modellwahl bleiben unabhängig von diesem Sprachbefehl-Modul. |
| `expert` | Ausdrückliche Frage → separate Zweitmeinung | `mobile-ios.js`, OpenCode-Textgenerierung statt `/prompt`. Das Beratungsmodell muss beim Setup angegeben und in OpenCode verfügbar sein. Die Anfrage kann Modellverbrauch verursachen. |
| `memory` | Erlaubte Vorliebe → SQLite-Eintrag im Tailnet-Profil | `voice-memory.cjs`, `js-tiktoken`. Standardmäßig nach Bestätigung, mit optionaler Einwilligung pro Live-Gespräch. 8000 Tokens je Tailnet-Profil, unabhängig vom Modell. Private Erinnerungen und damit formulierte Antworten sind keine Quelle für Aufgaben oder Expertenanfragen. |
| `history` | Hauptchat- und Live-Ereignisse → lokales JSONL | `history-log.cjs`. Das Log ist auch ohne Live nutzbar. Abgleich beim geöffneten Chat, mit Zeitstempeln und Nachrichten-ID; kein Web-Lesezugriff. |

## Übergabe: Gespräch, Auftrag und Ergebnis

Für die Kurzfassung zählt der noch nicht übergebene Live-Dialog. Nicht als Notizen erfasste Einschränkungen stehen also weiter zur Verfügung. Private, lokale Settings-/Erinnerungsvorgänge und Expertenturns werden vor dem Zusammenfassen aussortiert. Die Beiträge verbleiben bis zur bestätigten Annahme im Übergabekontext. Fehlen Ziel, Bezug oder eine nötige Einschränkung, fragt der Assistent nach, bevor er sendet. Eine bloße Erwähnung und ein angebotenes Vorhaben starten keine Arbeit.

Bei einer bestätigten Übergabe schickt die App nur den präzisen Auftrag und den dafür nötigen Kontext. Möchtest du ausdrücklich eine frühere Frage beantworten lassen, kann sie deren Wortlaut übernehmen oder auf die vorhandene Nachricht verweisen, ohne sie doppelt einzureihen. Der Assistent liest den tatsächlich angenommenen Auftrag vor. Eine Nachrichten-ID belegt Annahme, nicht Ausführung und nicht die inhaltliche Antwort. Ein Folgeauftrag darf in die Queue, während der Hauptchat arbeitet. Der Live-Verlauf wird in dieser Paketversion nicht nachträglich als Hintergrundnotiz angehängt.

Übernimmt Live die Beobachtung eines bereits laufenden Auftrags, sucht es die Nachrichten-ID auf bis zu 20 Verlaufsseiten, auch vor dem Live-Start. Findet es sie nicht, weist es darauf hin, statt eine Antwort zu behaupten oder endlos weiterzusuchen. Bei geöffnetem Live-Panel scrollt die Hauptchat-Timeline mit, solange du am Ende bist. Blätterst du nach oben, beginnt das Mitscrollen erst wieder, wenn du am Ende ankommst.

### Rollenhinweis in OpenCode

Live zu öffnen ändert keine Anweisungen der Sitzung. Erst vor einer ausdrücklichen Übergabe, die eine neue Nachricht einreiht, legt fluffyTouch in dieser OpenCode-Sitzung den Eintrag `opencode-touch-live-role` an. Er erklärt dem Hauptchat, dass er Fragen beantworten und nicht nur ihren Eingang bestätigen soll. Der Eintrag bleibt nach Live-Ende und Deinstallation bestehen. Wenn er nicht zurückgelesen werden kann, wird der Auftrag nicht eingereiht. Der Readback belegt den Eintrag, nicht die Umsetzung durch das Modell.

Zum Entfernen in der nativen CLI der noch laufenden OpenCode-Instanz: `<sessionID>` durch die ID der betroffenen Sitzung ersetzen und gezielt auch den Readback ausführen. Der Befehl löscht nur diesen einen Eintrag, keine Nachrichten und keine anderen Anweisungen.

```powershell
opencode api delete '/api/experimental/session/<sessionID>/instructions/entries/opencode-touch-live-role'
opencode api get '/api/experimental/session/<sessionID>/instructions/entries'
```

Im Ergebnis der zweiten Abfrage darf `opencode-touch-live-role` nicht mehr vorkommen. Solange `handoff` aktiv ist, legt eine neue ausdrückliche Übergabe den Hinweis wieder an. Eine Entfernung wird an der nächsten OpenCode-Schrittgrenze wirksam.

### Lokaler Audiozugriff

Die Audio-API bindet nur an Loopback und prüft `Host`, Browser-Herkunft und Fetch-Metadaten. Im OpenCode-Profil erzeugt der Starter einen zufälligen Prozess-Token: Nur der Proxy legt ihn auf der Verbindung zur Sprachbrücke bei, nach Prüfung der nativen Anmeldung und – bei WebSockets – der exakten Seiten-Origin. Browser bekommen den Token nicht. Im Standalone-Profil brauchen lokale native Clients standardmäßig keinen Login; die Bridge ist kein Endpunkt für abweichende Browser-Origins oder für eine Netzfreigabe.

## Welche Daten den Rechner verlassen

Mikrofonframes wandern im iPhone-Modus über das private Tailnet zur Sprachbrücke auf dem PC. Parakeet verarbeitet sie lokal. Der lokale TTS-Adapter erhält den Text zum Vorlesen. Wenn du Live, Auto-Voice oder die Zweitmeinung nutzt, kann OpenCode für die jeweilige Textgenerierung Ausschnitte an den in OpenCode bereits konfigurierten Anbieter geben. Für persönliche Live-Antworten gilt das auch für Voice-Erinnerungen. „Lokal“ bei der Erkennung und Ausgabe bedeutet also nicht, dass jedes verwendete Chatmodell lokal läuft.

Bei aktiviertem Verlaufslog werden nutzbare Chattexte und Statusdaten unter `%LOCALAPPDATA%\OCFluffyTouch\verlaufslog.jsonl` abgelegt. Die Rotation hält eine Vorgängerdatei; es gibt keine Nachzeichnung vergangener Live-Turns. Das Log ist vertraulich. Es sammelt keine Audiodateien, Zugangsdaten, Tool-Ausgaben, internes Reasoning oder als privat markierte Erinnerungsaktionen. Nutzerdaten und Stimmaufnahmen bleiben außerhalb des veröffentlichten Quellcodes.
