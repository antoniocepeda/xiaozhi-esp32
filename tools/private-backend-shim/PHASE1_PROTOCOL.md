# Phase 1 Shim Protocol Contract

This document defines the **minimum** contract between ESP32 firmware and the local shim.

## 1) OTA check

- Endpoint: `GET/POST /ota/`
- Response must include a `websocket` object:

```json
{
  "websocket": {
    "url": "ws://<backend-ip>:8788/ws",
    "token": "",
    "version": 3
  }
}
```

Optional:
- `firmware` object (can be placeholder if no update)
- `server_time` object

## 2) WebSocket handshake

### Device -> Server
Text frame:

```json
{
  "type": "hello",
  "version": 3,
  "transport": "websocket",
  "audio_params": {
    "format": "opus",
    "sample_rate": 16000,
    "channels": 1,
    "frame_duration": 60
  }
}
```

### Server -> Device
Text frame:

```json
{
  "type": "hello",
  "transport": "websocket",
  "session_id": "sess-xxxx",
  "audio_params": {
    "format": "opus",
    "sample_rate": 24000,
    "channels": 1,
    "frame_duration": 60
  }
}
```

## 3) Runtime frames

- Binary frames: incoming device audio (Opus or wrapped by protocol version)
- Text frames: JSON events (`stt`, `tts`, `llm`, `mcp`, etc.)

For phase 1, shim can:
- log inbound binary/text
- send minimal `stt` / `tts` events for state/UI validation

## 4) Success criteria

- Device OTA hits local backend URL
- Device stores websocket config from local response
- Device opens WS and completes hello handshake
- Device remains connected and streaming/logging frames
- No vendor backend required for this loop
