"""Send a user-selected PCM WAV to the local OC fluffyTouch ASR module."""

import argparse
import json
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--port", type=int, default=14974)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Der Port muss zwischen 1 und 65535 liegen.")
    try:
        headers = {"Content-Type": "audio/wav"}
        if token := os.environ.get("OC_FLUFFYTOUCH_BRIDGE_TOKEN"):
            headers["X-FluffyTouch-Bridge-Token"] = token
        request = Request(
            f"http://127.0.0.1:{args.port}/asr.wav",
            data=args.wav.read_bytes(),
            headers=headers,
            method="POST",
        )
        with build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=120) as response:
            print(json.load(response)["text"])
    except HTTPError as error:
        parser.exit(1, f"Transkript fehlgeschlagen ({error.code}): {error.read().decode('utf-8', 'replace')}\n")
    except (OSError, URLError) as error:
        parser.exit(1, f"Transkript fehlgeschlagen: {error}\n")


if __name__ == "__main__":
    main()
