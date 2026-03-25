#!/usr/bin/env python3
"""Generate a browser flasher manifest from ESP-IDF build artifacts."""

from __future__ import annotations

import json
from pathlib import Path
import sys

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = REPO_ROOT / "build"
FLASHER_ARGS = BUILD_DIR / "flasher_args.json"
OUTPUT_DIR = REPO_ROOT / "tools" / "local-flasher"
OUTPUT_MANIFEST = OUTPUT_DIR / "manifest.json"

CHIP_MAP = {
    "esp32": "ESP32",
    "esp32s2": "ESP32-S2",
    "esp32s3": "ESP32-S3",
    "esp32c3": "ESP32-C3",
    "esp32c6": "ESP32-C6",
    "esp32h2": "ESP32-H2",
    "esp32p4": "ESP32-P4",
}


def fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def main() -> int:
    if not FLASHER_ARGS.exists():
        return fail(f"missing build metadata: {FLASHER_ARGS}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    data = json.loads(FLASHER_ARGS.read_text())
    chip = data.get("extra_esptool_args", {}).get("chip")
    chip_family = CHIP_MAP.get(chip, chip.upper() if chip else "ESP32")
    flash_files = data.get("flash_files", {})

    if not flash_files:
        return fail("build/flasher_args.json does not contain flash_files")

    parts = []
    for offset_hex, relative_path in sorted(flash_files.items(), key=lambda item: int(item[0], 16)):
        parts.append({
            "path": f"../../build/{relative_path}",
            "offset": int(offset_hex, 16),
        })

    manifest = {
        "name": "Robot Dog Firmware",
        "version": "local-build",
        "new_install_prompt_erase": True,
        "builds": [
            {
                "chipFamily": chip_family,
                "parts": parts,
            }
        ],
    }

    OUTPUT_MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {OUTPUT_MANIFEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
