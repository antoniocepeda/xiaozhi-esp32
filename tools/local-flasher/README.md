# Robot Dog Local Flasher (Phase 1)

This is a simple LAN-hosted browser flasher for the robot dog firmware.

## What it does

- Serves a shared web page any computer on your network can open
- Uses the browser on that computer to talk to the USB-connected ESP board
- Flashes the current ESP-IDF build artifacts from this repo's `build/` folder
- Avoids requiring the full ESP-IDF toolchain on every laptop just to install firmware

## What it does **not** do

- It does **not** let one machine flash a board plugged into a different machine
- It does **not** do OTA updates yet
- It does **not** replace the firmware build step; it only makes local USB install easier

## Browser support

Use a Chromium-based browser such as:

- Google Chrome
- Microsoft Edge
- Other Chromium browsers with Web Serial support

Safari is not a good fit here.

## Files

- `index.html` — local flasher page
- `manifest.json` — generated browser flash manifest
- `../../build/*` — actual firmware artifacts referenced by the manifest

## Refresh after a new firmware build

From the repo root:

```bash
python3 scripts/export_web_flasher.py
```

That rebuilds `tools/local-flasher/manifest.json` from `build/flasher_args.json`.

## How to host it on your LAN

From the repo root, run a simple static file server:

```bash
python3 -m http.server 8766
```

Then from any computer on the same network, open:

```text
http://YOUR-MAC-IP:8766/tools/local-flasher/
```

Example:

```text
http://10.0.0.50:8766/tools/local-flasher/
```

## How to flash a dog

1. Make sure the repo has a fresh firmware build in `build/`
2. Run `python3 scripts/export_web_flasher.py`
3. Start the local server from the repo root
4. On the laptop/desktop doing the flash, open the flasher page in Chrome or Edge
5. Plug the ESP board into **that same computer** over USB
6. Click the install button and choose the serial device

## Notes

The manifest is generated from ESP-IDF's `build/flasher_args.json`, so it tracks the real flash addresses and artifact paths instead of relying on stale manual values.
