# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.2.x | Yes |
| < 0.2 | No |

## Reporting a vulnerability

Please report privately through GitHub Security Advisories:

<https://github.com/00fLausch/oc-fluffytouch/security/advisories/new>

Do not open a public issue, pull request, or discussion for a vulnerability.

Include:

- OC fluffyTouch version and commit.
- Installation mode (Standalone or OpenCode) and operating system/browser versions.
- Steps to reproduce and the impact.
- Relevant logs, with tokens, pairing links, private paths, and chat content removed.
- Any suggested mitigation.

I aim to acknowledge reports within a few working days. Fix timing depends on severity and available time; this is a volunteer-maintained project. Please allow a reasonable disclosure window before publishing details.

## Scope

In scope:

- Proxy and voice-bridge authentication, token handling, and Host/Origin/Fetch Metadata checks.
- Tailscale Serve route configuration and Funnel exclusion.
- Path/share policy, reparse-point handling, and write protection.
- XSS or HTML injection in the mobile UI.
- History-log and voice-memory privacy.
- Installer and PowerShell download/extraction paths.
- Leakage of private data in source, docs, or release assets.

Out of scope:

- Vulnerabilities in OpenCode, Tailscale, OmniVoice, sherpa-onnx, or other upstream dependencies. Report those to their maintainers.
- The user's own tailnet, device pairing links, or physical device security.
- Social engineering, phishing, or attacks that require an already compromised Windows account.
- Findings from automated scanners without a reproducible impact.
- Missing hardening that is documented as a limit.

## No bounty

There is no bug bounty. Fixes are released as time permits.

## Disclosure

Please coordinate disclosure. A public report should wait until a fix or mitigation is available. Credit is welcome if you want it.