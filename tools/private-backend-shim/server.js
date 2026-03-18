import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import OpusScript from 'opusscript';

const PORT = Number(process.env.PORT || 8788);
const WS_PATH = process.env.WS_PATH || '/ws';
const PUBLIC_HOST = process.env.PUBLIC_HOST || '192.168.1.50';
const WS_PROTOCOL_VERSION = Number(process.env.WS_PROTOCOL_VERSION || 3);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe';
const ENABLE_TTS_AUDIO = (process.env.ENABLE_TTS_AUDIO || 'false').toLowerCase() === 'true';
const AUTO_FINALIZE_MS = Number(process.env.AUTO_FINALIZE_MS || 900);
const HARD_FINALIZE_MS = Number(process.env.HARD_FINALIZE_MS || 4000);
const MIN_PACKETS_BEFORE_FINALIZE = Number(process.env.MIN_PACKETS_BEFORE_FINALIZE || 8);
const OPENAI_TTS_PCM_RATE = Number(process.env.OPENAI_TTS_PCM_RATE || 24000);
const SERVER_SAMPLE_RATE = 16000;
const SERVER_FRAME_DURATION_MS = 60;
const SERVER_FRAME_SAMPLES = (SERVER_SAMPLE_RATE * SERVER_FRAME_DURATION_MS) / 1000; // 960

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const app = express();
app.use(express.json({ limit: '2mb' }));

function now() {
  return new Date().toISOString();
}

async function generateAssistantReply({ deviceId, clientId, userText }) {
  if (!openai) return 'OpenAI API key missing on backend.';

  const response = await openai.responses.create({
    model: OPENAI_MODEL,
    input: [
      {
        role: 'system',
        content: [{ type: 'input_text', text: 'You are a concise, friendly robot dog assistant. Keep replies short, natural, and spoken-language friendly.' }]
      },
      {
        role: 'user',
        content: [{ type: 'input_text', text: userText || `User triggered a voice turn on device ${deviceId} (${clientId}).` }]
      }
    ]
  });

  return (response.output_text || '').trim() || 'Hey! I am connected to your private OpenAI backend.';
}

function wrapWavFromPcm16le(pcmBuffer, sampleRate = SERVER_SAMPLE_RATE, channels = 1) {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function unwrapIncomingOpusFrame(data) {
  const buf = Buffer.from(data);
  if (buf.length >= 4) {
    const payloadSize = buf.readUInt16BE(2);
    if (payloadSize > 0 && payloadSize <= buf.length - 4) {
      return buf.subarray(4, 4 + payloadSize);
    }
  }
  return buf;
}

async function transcribePcmToText(pcmBuffer) {
  if (!openai) return '';
  if (!pcmBuffer || pcmBuffer.length < 3200) return ''; // ~100ms guard

  const wav = wrapWavFromPcm16le(pcmBuffer, SERVER_SAMPLE_RATE, 1);
  const file = new File([wav], 'speech.wav', { type: 'audio/wav' });
  const tx = await openai.audio.transcriptions.create({
    file,
    model: OPENAI_STT_MODEL,
  });
  return (tx?.text || '').trim();
}

function buildBinaryProtocolV3(opusPayload) {
  const frame = Buffer.allocUnsafe(4 + opusPayload.length);
  frame[0] = 0; // type: opus
  frame[1] = 0; // reserved
  frame.writeUInt16BE(opusPayload.length, 2);
  opusPayload.copy(frame, 4);
  return frame;
}

function resamplePcm16Mono(inputPcm, inRate, outRate) {
  if (inRate === outRate) return inputPcm;

  const inSamples = new Int16Array(inputPcm.buffer, inputPcm.byteOffset, Math.floor(inputPcm.byteLength / 2));
  const outLen = Math.max(1, Math.floor((inSamples.length * outRate) / inRate));
  const outSamples = new Int16Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const srcPos = (i * inRate) / outRate;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = inSamples[idx] ?? 0;
    const s1 = inSamples[Math.min(idx + 1, inSamples.length - 1)] ?? s0;
    outSamples[i] = (s0 + (s1 - s0) * frac) | 0;
  }

  return Buffer.from(outSamples.buffer, outSamples.byteOffset, outSamples.byteLength);
}

async function synthesizeTtsPcm16(text) {
  if (!openai) throw new Error('OPENAI_API_KEY missing');

  const ttsResp = await openai.audio.speech.create({
    model: OPENAI_TTS_MODEL,
    voice: OPENAI_TTS_VOICE,
    input: text,
    response_format: 'pcm',
  });

  const ab = await ttsResp.arrayBuffer();
  const pcm = Buffer.from(ab);
  const resampled = resamplePcm16Mono(pcm, OPENAI_TTS_PCM_RATE, SERVER_SAMPLE_RATE);
  return resampled;
}

async function streamPcmAsOpusV3(ws, pcmBuffer) {
  const encoder = new OpusScript(SERVER_SAMPLE_RATE, 1, OpusScript.Application.AUDIO);
  const frameBytes = SERVER_FRAME_SAMPLES * 2; // s16le mono

  for (let off = 0; off < pcmBuffer.length; off += frameBytes) {
    if (ws.readyState !== ws.OPEN) break;

    let chunk = pcmBuffer.subarray(off, off + frameBytes);
    if (chunk.length < frameBytes) {
      const padded = Buffer.alloc(frameBytes);
      chunk.copy(padded);
      chunk = padded;
    }

    // opusscript expects 16-bit samples, not raw byte buffer values
    const pcm16 = new Int16Array(chunk.buffer, chunk.byteOffset, SERVER_FRAME_SAMPLES);
    const opus = Buffer.from(encoder.encode(pcm16, SERVER_FRAME_SAMPLES));
    const packet = buildBinaryProtocolV3(opus);
    ws.send(packet, { binary: true });

    await new Promise((r) => setTimeout(r, SERVER_FRAME_DURATION_MS));
  }
}

function otaPayload(req) {
  const wsUrl = `ws://${PUBLIC_HOST}:${PORT}${WS_PATH}`;
  return {
    // Keep firmware null in phase-1 shim: no OTA flash push from this endpoint yet.
    firmware: {
      version: '0.0.0',
      url: 'http://127.0.0.1/disabled'
    },
    websocket: {
      url: wsUrl,
      token: '',
      version: WS_PROTOCOL_VERSION
    },
    server_time: {
      timestamp: Date.now(),
      timezone_offset: 0
    }
  };
}

app.get('/ota/', (req, res) => {
  const payload = otaPayload(req);
  console.log(`[${now()}] OTA GET from ${req.ip} -> websocket.url=${payload.websocket.url}`);
  res.json(payload);
});

app.post('/ota/', (req, res) => {
  const body = req.body || {};
  const payload = otaPayload(req);
  console.log(`[${now()}] OTA POST from ${req.ip} ua=${req.get('user-agent') || ''}`);
  console.log(`[${now()}] OTA headers Device-Id=${req.get('device-id') || ''} Client-Id=${req.get('client-id') || ''} Lang=${req.get('accept-language') || ''}`);
  console.log(`[${now()}] OTA body keys: ${Object.keys(body).join(', ')}`);
  res.json(payload);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on('connection', (ws, req) => {
  const deviceId = req.headers['device-id'] || 'unknown-device';
  const clientId = req.headers['client-id'] || 'unknown-client';
  const protocolVersion = req.headers['protocol-version'] || 'n/a';

  console.log(`\n[${now()}] WS connected ${req.socket.remoteAddress} deviceId=${deviceId} clientId=${clientId} protocolVersion=${protocolVersion}`);

  let helloSeen = false;
  let turnInFlight = false;
  let listeningActive = false;
  let silenceTimer = null;
  let hardTimer = null;
  let binaryPackets = 0;
  const decoder = new OpusScript(SERVER_SAMPLE_RATE, 1, OpusScript.Application.AUDIO);
  const pcmChunks = [];

  const clearSilenceTimer = () => {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  };

  const clearHardTimer = () => {
    if (hardTimer) {
      clearTimeout(hardTimer);
      hardTimer = null;
    }
  };

  const finalizeTurn = async (reason) => {
    if (turnInFlight || !listeningActive) return;
    if (reason === 'silence-timeout' && binaryPackets < MIN_PACKETS_BEFORE_FINALIZE) return;
    listeningActive = false;
    clearSilenceTimer();
    clearHardTimer();

    turnInFlight = true;
    try {
      const pcm = Buffer.concat(pcmChunks);
      pcmChunks.length = 0;
      console.log(`[${now()}] finalize turn (${reason}), packets=${binaryPackets}, pcmBytes=${pcm.length}`);

      const userText = await transcribePcmToText(pcm);
      console.log(`[${now()}] STT: ${userText || '<empty>'}`);
      if (userText && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stt', text: userText }));
      }

      const promptText = userText || 'The user spoke but transcription was empty. Ask them to repeat briefly.';
      const replyText = await generateAssistantReply({
        deviceId: String(deviceId),
        clientId: String(clientId),
        userText: promptText,
      });

      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tts', state: 'start' }));
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tts', state: 'sentence_start', text: replyText }));

      if (ENABLE_TTS_AUDIO) {
        const ttsPcm = await synthesizeTtsPcm16(replyText);
        console.log(`[${now()}] TTS pcm bytes=${ttsPcm.length} @${SERVER_SAMPLE_RATE}Hz`);
        await streamPcmAsOpusV3(ws, ttsPcm);
      }

      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tts', state: 'stop' }));
      console.log(`[${now()}] Reply sent${ENABLE_TTS_AUDIO ? ' + audio' : ' (text-only mode)'}: ${replyText}`);
    } catch (err) {
      const errMsg = err?.message || String(err);
      console.error(`[${now()}] OpenAI turn failed: ${errMsg}`);
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'tts', state: 'sentence_start', text: 'I hit a backend error. Please check OpenAI configuration.' }));
        ws.send(JSON.stringify({ type: 'tts', state: 'stop' }));
      }
    } finally {
      turnInFlight = false;
      binaryPackets = 0;
    }
  };

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (!listeningActive) return;
      try {
        const opusPayload = unwrapIncomingOpusFrame(data);
        const pcm16 = decoder.decode(opusPayload, SERVER_FRAME_SAMPLES);
        const pcmBuf = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
        pcmChunks.push(Buffer.from(pcmBuf));
        binaryPackets += 1;

        clearSilenceTimer();
        silenceTimer = setTimeout(() => {
          void finalizeTurn('silence-timeout');
        }, AUTO_FINALIZE_MS);
      } catch (e) {
        console.log(`[${now()}] binary decode skipped: ${e?.message || e}`);
      }
      return;
    }

    const text = data.toString('utf8');
    console.log(`[${now()}] <json> ${text}`);

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg?.type === 'hello' && !helloSeen) {
      helloSeen = true;

      const response = {
        type: 'hello',
        transport: 'websocket',
        session_id: `sess-${Math.random().toString(36).slice(2, 10)}`,
        audio_params: {
          format: 'opus',
          sample_rate: SERVER_SAMPLE_RATE,
          channels: 1,
          frame_duration: SERVER_FRAME_DURATION_MS
        }
      };

      ws.send(JSON.stringify(response));
      console.log(`[${now()}] > hello response sent`);

      setTimeout(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'stt', text: 'Private backend connected. OpenAI mode ready.' }));
        }
      }, 250);
    }

    if (msg?.type === 'listen' && msg?.state === 'start') {
      listeningActive = true;
      pcmChunks.length = 0;
      binaryPackets = 0;
      clearSilenceTimer();
      clearHardTimer();
      hardTimer = setTimeout(() => {
        void finalizeTurn('hard-timeout');
      }, HARD_FINALIZE_MS);
      const mode = msg?.mode || 'unknown';
      console.log(`[${now()}] listen start (capturing audio, mode=${mode})`);
      return;
    }

    if (msg?.type === 'listen' && msg?.state === 'stop') {
      await finalizeTurn('listen-stop');
      return;
    }
  });

  ws.on('close', () => {
    void finalizeTurn('ws-disconnect');
    clearSilenceTimer();
    clearHardTimer();
    console.log(`[${now()}] WS disconnected deviceId=${deviceId}`);
  });

  ws.on('error', (err) => {
    console.error(`[${now()}] WS error`, err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Private backend shim listening on http://0.0.0.0:${PORT}`);
  console.log(`OTA: http://0.0.0.0:${PORT}/ota/`);
  console.log(`WS : ws://0.0.0.0:${PORT}${WS_PATH}`);
  console.log(`PUBLIC_HOST for device OTA response: ${PUBLIC_HOST}`);
});
