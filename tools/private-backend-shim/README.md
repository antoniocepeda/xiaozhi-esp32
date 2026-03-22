# Private Backend Shim (Phase 1)

This is a minimal local backend to prove **full control of the device communication path**:

- ESP32 device checks OTA from your machine
- OTA response returns local WebSocket endpoint
- Device connects to local WebSocket server
- Hello handshake completes
- Incoming text/audio events are logged

## What this is (and isn't)

- ✅ Connectivity + protocol control proof
- ✅ Fast iteration scaffold for STT/LLM/TTS integration
- ❌ Not production auth/security
- ❌ Not full assistant pipeline yet

## Quick start

```bash
cd tools/private-backend-shim
npm install
npm start
```

Default bind:
- OTA: `http://0.0.0.0:8788/ota/`
- WS: `ws://0.0.0.0:8788/ws`

## Local env notes

Keep local secrets and machine-specific config in `tools/private-backend-shim/.env`.
That file is intentionally gitignored.

For actual spoken voice output from the dog, set:

```env
ENABLE_TTS_AUDIO=true
TTS_TEST_MODE=normal
```

Useful test modes:
- `TTS_TEST_MODE=tone` → confirms speaker/audio path without using OpenAI TTS
- `TTS_TEST_MODE=normal` → uses OpenAI TTS for real voice replies

## Device-side expectation

This patch set sets firmware default OTA URL to:

`http://192.168.1.50:8788/ota/`

Change that IP in `main/Kconfig.projbuild` (or in menuconfig) to the machine running this shim.

## Endpoints

### `POST /ota/` (also accepts GET)
Returns OTA JSON with websocket settings only.

### `GET /ws`
WebSocket endpoint for device protocol.

## Next steps

1. Replace fake TTS events with provider-backed streaming
2. Add STT forwarding from incoming Opus frames
3. Add turn/session state and interruption logic
4. Add token auth and LAN ACL
