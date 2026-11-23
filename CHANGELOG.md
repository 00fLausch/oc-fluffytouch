# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-11-23

### Added

- Live can adopt an already running task and search up to 20 history pages for its message ID, including pages before Live started.
- The main-chat timeline follows new content only while the reader is at the end; scrolling up preserves the reading position.
- Public source preview with English README, screenshots, MIT license, changelog, contributing guide, security policy, and a bug-report issue form.

### Changed

- The service-worker cache revision now includes the package version, so a new release invalidates the old cached UI.
- Documentation and screenshots are in English; screenshot filenames use English names.

### Fixed

- Adopted message IDs that cannot be found now produce a clear notice instead of endless polling.
- The reading position is no longer overridden when the reader scrolls up in the main chat.
- Review fixes: missing-reference TTS crash, Python 3.11 requirement, PowerShell 5.1 stderr abort, duplicate `/tts.wav` fallback audio, bridge exposure to foreign websites, dictation frame pass-through, handoff context retention, deferred role hint, configurable expert model, and ambiguous task outcome handling.

## [0.2.0] - 2026-11-22

### Added

- Guided Windows installer with Standalone and OpenCode modes and selectable modules.
- Voice Transcript (dictation), read-aloud, live conversation, coding handoff, Auto-Voice, voice controls, second opinion, voice memories, and a local history log.
- Loopback-only voice bridge with Host, Origin, and Fetch Metadata checks plus a process token shared only with the proxy.
- TTS streaming and support for a service default voice when no reference is configured.
- Handoff context retention and a role hint for the coding chat.
- Node and Python regression tests.

[0.2.1]: https://github.com/00fLausch/oc-fluffytouch/releases/tag/v0.2.1