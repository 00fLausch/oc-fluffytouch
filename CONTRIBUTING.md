# Contributing to OC fluffyTouch

Thanks for your interest. OC fluffyTouch is a voice layer for an existing OpenCode session, not an OpenCode SDK plugin. Contributions should keep the native OpenCode UI and session intact.

## Ways to contribute

- Report a reproducible bug.
- Suggest a focused improvement.
- Improve documentation or tests.
- Submit a pull request.

## Before you start

- Read the [README](README.md) and the [installation guide](docs/installation.md).
- Search existing issues first.
- For larger changes, open an issue before writing code.
- Keep pull requests focused: one concern per request.
- Never include private data: pairing links, tokens, tailnet names, private paths, chat logs, audio, model weights, or credentials.

## Setup

Requirements: Windows 10/11, Node.js 22.13 or newer, Python 3.11 or newer, and, for the iPhone mode, OpenCode V2 Desktop and Tailscale.

```powershell
npm.cmd install --ignore-scripts
npm.cmd test
```

Python tests:

```powershell
py -3.11 -m venv .venv-test
& .\.venv-test\Scripts\python.exe -m pip install -r requirements-audio.txt -r requirements-tts.txt
& .\.venv-test\Scripts\python.exe -B -m unittest discover -p 'test_*.py'
```

The Python tests do not require model weights, OmniVoice, or OpenCode.

## Code style

- PowerShell scripts stay ASCII-only (`ae`, `oe`, `ue`, `ss`) because Windows PowerShell 5.1 writes ANSI or UTF-16 by default and non-ASCII text can be mangled. Keep this convention unless you fix the encoding across the whole toolchain.
- Documentation is UTF-8. Use ASCII quotes in code; typographic quotes are fine in prose.
- Browser code is plain JavaScript. Keep the same-origin and feature-gating patterns.
- Do not add a second OpenCode instance, a replacement frontend, or public hosting.
- Do not log tokens, pairing links, or private chat content.

## Tests

- Run both suites before submitting.
- Add a regression test for every bug fix.
- UI changes should include a screenshot or a short note in the pull request.
- Tests must not require real model weights, OmniVoice, or a paired iPhone.

## Pull requests

- Branch from `main`.
- Describe the change, the tests you ran, and any remaining limits.
- Link the related issue.
- Keep unrelated formatting out of the diff.
- By contributing, you agree to license your contribution under the [MIT License](LICENSE).

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## Questions

Open a GitHub issue with the bug-report form or a focused question. Read [docs/module.md](docs/module.md) and [docs/entwicklung.md](docs/entwicklung.md) first.