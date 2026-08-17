#!/usr/bin/env python3
"""Add a Google OAuth client ID to Calendar Peek's manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

FREEBUSY_SCOPE = "https://www.googleapis.com/auth/calendar.events.freebusy"
EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly"
CLIENT_ID_PATTERN = re.compile(r"^\d{6,}-[a-z0-9_-]+\.apps\.googleusercontent\.com$", re.IGNORECASE)


def parse_args() -> argparse.Namespace:
    default_manifest = Path(__file__).resolve().parents[1] / "manifest.json"
    parser = argparse.ArgumentParser(
        description="Configure Calendar Peek's Google OAuth client ID."
    )
    parser.add_argument("client_id", help="Google OAuth client ID")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=default_manifest,
        help=f"Path to manifest.json (default: {default_manifest})",
    )
    return parser.parse_args()


def extension_id_from_key(public_key_b64: str) -> str:
    import base64

    public_key = base64.b64decode(public_key_b64)
    prefix = hashlib.sha256(public_key).hexdigest()[:32]
    return "".join(chr(ord("a") + int(character, 16)) for character in prefix)


def main() -> int:
    args = parse_args()
    client_id = args.client_id.strip()
    manifest_path = args.manifest.expanduser().resolve()

    if not CLIENT_ID_PATTERN.fullmatch(client_id):
        print(
            "Error: expected a Google OAuth client ID ending in "
            ".apps.googleusercontent.com.",
            file=sys.stderr,
        )
        return 2

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"Error: manifest not found: {manifest_path}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as error:
        print(f"Error: manifest is not valid JSON: {error}", file=sys.stderr)
        return 2

    if manifest.get("manifest_version") != 3 or manifest.get("name") != "Calendar Peek":
        print("Error: this does not appear to be Calendar Peek's manifest.", file=sys.stderr)
        return 2

    manifest["oauth2"] = {
        "client_id": client_id,
        "scopes": [FREEBUSY_SCOPE, EVENTS_SCOPE],
    }
    manifest_path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    extension_id = extension_id_from_key(str(manifest.get("key", "")))
    print(f"Updated: {manifest_path}")
    if extension_id:
        print(f"Extension ID: {extension_id}")
    print("Next: reload Calendar Peek at chrome://extensions and connect Google Calendar.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
