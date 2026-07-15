#!/usr/bin/env python3
"""
Example automation poller for pending angel-name entries.

Usage:
  export API_BASE=https://your-app.up.railway.app
  python scripts/poll_pending.py

Mark an entry processed after photo generation:
  PATCH /entry/{id}/status  {"status": "processed", "metadata": {"photo_url": "..."}}
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request

API_BASE = os.environ.get("API_BASE", "http://localhost:3000").rstrip("/")
POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "10"))


def get_json(path: str) -> dict:
    req = urllib.request.Request(f"{API_BASE}{path}", method="GET")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def patch_status(entry_id: str, status: str, metadata: dict | None = None) -> dict:
    body = {"status": status}
    if metadata:
        body["metadata"] = metadata
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API_BASE}/entry/{entry_id}/status",
        data=data,
        method="PATCH",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def process_entry(entry: dict) -> None:
    """Replace this with your photo-generation pipeline."""
    print(
        f"PROCESSING id={entry['id']} "
        f"real={entry['real_name']!r} angel={entry['angel_name']!r}"
    )
    # Example: mark processing, generate photo, mark processed
    patch_status(entry["id"], "processing")
    # ... generate photo here ...
    patch_status(
        entry["id"],
        "processed",
        metadata={"note": "photo generation placeholder"},
    )


def main() -> None:
    print(f"Polling {API_BASE}/pending every {POLL_SECONDS}s")
    while True:
        try:
            payload = get_json("/pending?limit=20")
            entries = payload.get("entries") or []
            if not entries:
                print("No pending entries")
            for entry in entries:
                try:
                    process_entry(entry)
                except Exception as exc:  # noqa: BLE001
                    print(f"Failed {entry.get('id')}: {exc}")
                    try:
                        patch_status(
                            entry["id"],
                            "failed",
                            metadata={"error": str(exc)},
                        )
                    except Exception:
                        pass
        except urllib.error.URLError as exc:
            print(f"Poll error: {exc}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
