import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import OpenAI from 'openai';
import OpusScript from 'opusscript';
import { spawnSync } from 'node:child_process';

const PORT = Number(process.env.PORT || 8788);
const WS_PATH = process.env.WS_PATH || '/ws';
const PUBLIC_HOST = process.env.PUBLIC_HOST || '192.168.1.50';
const WS_PROTOCOL_VERSION = Number(process.env.WS_PROTOCOL_VERSION || 3);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const ROBOT_CONFIG_URL = process.env.ROBOT_CONFIG_URL || 'https://robotconfig-ndtagy32va-uc.a.run.app';
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'alloy';
const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe';
const ENABLE_TTS_AUDIO = (process.env.ENABLE_TTS_AUDIO || 'false').toLowerCase() === 'true';
const AUTO_FINALIZE_MS = Number(process.env.AUTO_FINALIZE_MS || 900);
const HARD_FINALIZE_MS = Number(process.env.HARD_FINALIZE_MS || 4000);
const MIN_PACKETS_BEFORE_FINALIZE = Number(process.env.MIN_PACKETS_BEFORE_FINALIZE || 8);
const OPENAI_TTS_PCM_RATE = Number(process.env.OPENAI_TTS_PCM_RATE || 24000);
const SERVER_SAMPLE_RATE = Number(process.env.SERVER_SAMPLE_RATE || 16000);
const SERVER_FRAME_DURATION_MS = Number(process.env.SERVER_FRAME_DURATION_MS || 60);
const SERVER_FRAME_SAMPLES = (SERVER_SAMPLE_RATE * SERVER_FRAME_DURATION_MS) / 1000; // 960 @16k/60ms
const TTS_TEST_MODE = (process.env.TTS_TEST_MODE || 'normal').toLowerCase(); // normal | silence | tone | loopback
const TTS_TEST_TONE_HZ = Number(process.env.TTS_TEST_TONE_HZ || 440);
const TTS_TEST_TONE_MS = Number(process.env.TTS_TEST_TONE_MS || 1500);
const TTS_TEST_SILENCE_MS = Number(process.env.TTS_TEST_SILENCE_MS || 2000);
const AUDIO_DEBUG = (process.env.AUDIO_DEBUG || 'true').toLowerCase() === 'true';

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const app = express();
app.use(express.json({ limit: '2mb' }));

function now() {
  return new Date().toISOString();
}

let mcpRequestId = 1000;

function nextMcpId() {
  mcpRequestId += 1;
  return mcpRequestId;
}

function maybeBuildDogActionFromText(userText) {
  const t = (userText || '').toLowerCase();
  if (!t) return null;

  if (/(stop|halt|freeze|be still|stand still|calm down)/.test(t)) {
    return { tool: 'self.dog.basic_control', args: { action: 'stop' }, spoken: 'Stopping now.' };
  }

  if (/(dance|boogie|party|show me a move|do a move)/.test(t)) {
    return {
      sequence: [
        { tool: 'self.dog.advanced_control', args: { action: 'sway' } },
        { tool: 'self.dog.advanced_control', args: { action: 'shake_hand' } },
        { tool: 'self.dog.advanced_control', args: { action: 'sway_back_forth' } },
      ],
      spoken: 'Dance mode activated.',
    };
  }

  if (/(jump|hop)/.test(t)) {
    return { tool: 'self.dog.advanced_control', args: { action: 'jump_forward' }, spoken: 'Jumping.' };
  }

  if (/(shake hand|paw)/.test(t)) {
    return { tool: 'self.dog.advanced_control', args: { action: 'shake_hand' }, spoken: 'Offering a paw.' };
  }

  if (/(lay down|lie down)/.test(t)) {
    return { tool: 'self.dog.advanced_control', args: { action: 'lay_down' }, spoken: 'Laying down.' };
  }

  if (/(forward|go ahead|move ahead)/.test(t)) {
    return { tool: 'self.dog.basic_control', args: { action: 'forward' }, spoken: 'Moving forward.' };
  }

  if (/(backward|go back|reverse)/.test(t)) {
    return { tool: 'self.dog.basic_control', args: { action: 'backward' }, spoken: 'Reversing.' };
  }

  if (/(turn left)/.test(t)) {
    return { tool: 'self.dog.basic_control', args: { action: 'turn_left' }, spoken: 'Turning left.' };
  }

  if (/(turn right)/.test(t)) {
    return { tool: 'self.dog.basic_control', args: { action: 'turn_right' }, spoken: 'Turning right.' };
  }

  return null;
}

function sendMcpToolCall(ws, toolName, args = {}) {
  if (ws.readyState !== ws.OPEN) return false;

  const payload = {
    jsonrpc: '2.0',
    id: nextMcpId(),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  ws.send(JSON.stringify({ type: 'mcp', payload }));
  console.log(`[${now()}] MCP tools/call -> ${toolName} ${JSON.stringify(args)}`);
  return true;
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

function pcmDurationMs(pcmBuffer) {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  return Math.round((sampleCount * 1000) / SERVER_SAMPLE_RATE);
}

function generateSilencePcm16(durationMs) {
  const sampleCount = Math.max(1, Math.floor((SERVER_SAMPLE_RATE * durationMs) / 1000));
  return Buffer.alloc(sampleCount * 2);
}

function generateTonePcm16(durationMs, frequencyHz) {
  const sampleCount = Math.max(1, Math.floor((SERVER_SAMPLE_RATE * durationMs) / 1000));
  const samples = new Int16Array(sampleCount);
  const amplitude = 0.25 * 32767;
  const phaseStep = (2 * Math.PI * frequencyHz) / SERVER_SAMPLE_RATE;

  for (let i = 0; i < sampleCount; i++) {
    samples[i] = Math.round(amplitude * Math.sin(i * phaseStep));
  }

  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

async function synthesizeTtsPcm16(text) {
  if (TTS_TEST_MODE === 'silence') {
    const pcm = generateSilencePcm16(TTS_TEST_SILENCE_MS);
    console.log(`[${now()}] TTS_TEST_MODE=silence -> ${pcmDurationMs(pcm)}ms (${pcm.length} bytes)`);
    return pcm;
  }

  if (TTS_TEST_MODE === 'tone') {
    const pcm = generateTonePcm16(TTS_TEST_TONE_MS, TTS_TEST_TONE_HZ);
    console.log(`[${now()}] TTS_TEST_MODE=tone(${TTS_TEST_TONE_HZ}Hz) -> ${pcmDurationMs(pcm)}ms (${pcm.length} bytes)`);
    return pcm;
  }

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

function extractOpusPacketsFromOgg(oggBuffer) {
  const packets = [];
  let off = 0;
  let packetParts = [];

  while (off + 27 <= oggBuffer.length) {
    if (oggBuffer.toString('ascii', off, off + 4) !== 'OggS') break;

    const pageSegments = oggBuffer[off + 26];
    const segTableOff = off + 27;
    const payloadOff = segTableOff + pageSegments;
    if (payloadOff > oggBuffer.length) break;

    const segTable = oggBuffer.subarray(segTableOff, segTableOff + pageSegments);
    let payloadPtr = payloadOff;

    for (const segLen of segTable) {
      if (payloadPtr + segLen > oggBuffer.length) break;
      packetParts.push(oggBuffer.subarray(payloadPtr, payloadPtr + segLen));
      payloadPtr += segLen;

      if (segLen < 255) {
        const pkt = Buffer.concat(packetParts);
        packetParts = [];
        if (pkt.length >= 8) {
          const sig = pkt.subarray(0, 8).toString('ascii');
          if (sig !== 'OpusHead' && sig !== 'OpusTags') packets.push(pkt);
        } else if (pkt.length > 0) {
          packets.push(pkt);
        }
      }
    }

    off = payloadPtr;
  }

  return packets;
}

function encodePcmToOpusPacketsViaFfmpeg(pcmBuffer, sampleRate) {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    's16le',
    '-ar',
    String(sampleRate),
    '-ac',
    '1',
    '-i',
    'pipe:0',
    '-c:a',
    'libopus',
    '-application',
    'audio',
    '-frame_duration',
    String(SERVER_FRAME_DURATION_MS),
    '-vbr',
    'off',
    '-b:a',
    '32k',
    '-f',
    'ogg',
    'pipe:1',
  ];

  const out = spawnSync('ffmpeg', args, {
    input: pcmBuffer,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (out.status !== 0) {
    const err = out.stderr?.toString('utf8') || `ffmpeg failed with code ${out.status}`;
    throw new Error(err.trim());
  }

  const ogg = out.stdout;
  const packets = extractOpusPacketsFromOgg(ogg);
  if (!packets.length) throw new Error('No Opus packets extracted from ffmpeg output');

  if (AUDIO_DEBUG) {
    console.log(`[${now()}] ffmpeg opus packets=${packets.length}, oggBytes=${ogg.length}`);
  }

  return packets;
}

async function streamLoopbackOpusV3(ws, opusFrames) {
  if (!opusFrames?.length) {
    console.log(`[${now()}] loopback: no captured opus frames`);
    return;
  }

  console.log(
    `[${now()}] loopback out: frames=${opusFrames.length}, frameMs=${SERVER_FRAME_DURATION_MS}`,
  );

  for (let i = 0; i < opusFrames.length; i++) {
    if (ws.readyState !== ws.OPEN) break;
    const opus = opusFrames[i];
    const packet = buildBinaryProtocolV3(opus);
    ws.send(packet, { binary: true });

    if (AUDIO_DEBUG && (i < 5 || i % 25 === 0 || i === opusFrames.length - 1)) {
      console.log(
        `[${now()}] loopback frame out seq=${i + 1}/${opusFrames.length} opusBytes=${opus.length} packetBytes=${packet.length}`,
      );
    }

    await new Promise((r) => setTimeout(r, SERVER_FRAME_DURATION_MS));
  }
}

async function streamPcmAsOpusV3(ws, pcmBuffer) {
  const encoder = new OpusScript(SERVER_SAMPLE_RATE, 1, OpusScript.Application.AUDIO);
  const frameBytes = SERVER_FRAME_SAMPLES * 2; // s16le mono
  const totalFrames = Math.ceil(pcmBuffer.length / frameBytes);
  let sentFrames = 0;

  if (AUDIO_DEBUG) {
    console.log(
      `[${now()}] audio out config: mode=${TTS_TEST_MODE}, sampleRate=${SERVER_SAMPLE_RATE}, channels=1, frameMs=${SERVER_FRAME_DURATION_MS}, frameSamples=${SERVER_FRAME_SAMPLES}, frameBytes=${frameBytes}, totalPcmBytes=${pcmBuffer.length}, totalFrames=${totalFrames}`,
    );
  }

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

    sentFrames += 1;
    if (AUDIO_DEBUG && (sentFrames <= 5 || sentFrames % 25 === 0 || sentFrames === totalFrames)) {
      const ts = Date.now();
      console.log(
        `[${now()}] audio frame out seq=${sentFrames}/${totalFrames} tsMs=${ts} pcmBytes=${chunk.length} opusBytes=${opus.length} packetBytes=${packet.length}`,
      );
    }

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

function defaultRobotConfig() {
  return {
    ok: true,
    config: {
      configVersion: 0,
      updatedAt: null,
      kidName: null,
      voiceLines: [],
      movements: [],
    },
  };
}

app.get('/robotConfig', async (req, res) => {
  const mac = typeof req.query.mac === 'string' ? req.query.mac : '';
  if (!mac) {
    return res.status(400).json({ ok: false, error: 'missing_mac' });
  }

  try {
    const url = new URL(ROBOT_CONFIG_URL);
    url.searchParams.set('mac', mac);
    const upstream = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const text = await upstream.text();

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      console.log(`[${now()}] robotConfig GET mac=${mac} -> invalid upstream JSON`);
      return res.status(502).json({ ok: false, error: 'server_error' });
    }

    if (!upstream.ok) {
      const status = payload?.error === 'not_found' ? 404 : upstream.status;
      console.log(`[${now()}] robotConfig GET mac=${mac} -> upstream error ${upstream.status}`);
      return res.status(status).json(payload);
    }

    const config = payload?.config || {};
    const normalized = {
      ok: payload?.ok !== false,
      config: {
        configVersion: Number.isInteger(config.configVersion) ? config.configVersion : 0,
        updatedAt: typeof config.updatedAt === 'string' ? config.updatedAt : null,
        kidName: typeof config.kidName === 'string' ? config.kidName : null,
        voiceLines: Array.isArray(config.voiceLines) ? config.voiceLines : [],
        movements: Array.isArray(config.movements) ? config.movements : [],
      },
    };

    console.log(`[${now()}] robotConfig GET mac=${mac} -> version=${normalized.config.configVersion}`);
    return res.json(normalized);
  } catch (error) {
    console.log(`[${now()}] robotConfig GET mac=${mac} -> proxy failure: ${error.message}`);
    return res.status(502).json(defaultRobotConfig());
  }
});

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
  const loopbackOpusFrames = [];

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
      console.log(`[${now()}] finalize turn (${reason}), packets=${binaryPackets}, pcmBytes=${pcm.length}, loopbackFrames=${loopbackOpusFrames.length}`);

      const userText = await transcribePcmToText(pcm);
      console.log(`[${now()}] STT: ${userText || '<empty>'}`);
      if (userText && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stt', text: userText }));
      }

      const promptText = userText || 'The user spoke but transcription was empty. Ask them to repeat briefly.';

      let replyText = '';
      const dogAction = maybeBuildDogActionFromText(promptText);
      if (dogAction) {
        if (dogAction.sequence) {
          for (const step of dogAction.sequence) {
            sendMcpToolCall(ws, step.tool, step.args || {});
            await new Promise((r) => setTimeout(r, 150));
          }
        } else {
          sendMcpToolCall(ws, dogAction.tool, dogAction.args || {});
        }
        replyText = dogAction.spoken || 'Done.';
      } else {
        replyText = await generateAssistantReply({
          deviceId: String(deviceId),
          clientId: String(clientId),
          userText: promptText,
        });
      }

      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tts', state: 'start' }));
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tts', state: 'sentence_start', text: replyText }));

      if (ENABLE_TTS_AUDIO) {
        if (TTS_TEST_MODE === 'loopback') {
          await streamLoopbackOpusV3(ws, loopbackOpusFrames);
        } else {
          const ttsPcm = await synthesizeTtsPcm16(replyText);
          console.log(`[${now()}] TTS pcm bytes=${ttsPcm.length} @${SERVER_SAMPLE_RATE}Hz`);
          const opusPackets = encodePcmToOpusPacketsViaFfmpeg(ttsPcm, SERVER_SAMPLE_RATE);
          await streamLoopbackOpusV3(ws, opusPackets);
        }
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
      loopbackOpusFrames.length = 0;
    }
  };

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (!listeningActive) return;
      try {
        const opusPayload = unwrapIncomingOpusFrame(data);
        loopbackOpusFrames.push(Buffer.from(opusPayload));
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
      loopbackOpusFrames.length = 0;
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
  console.log(`Audio config: sampleRate=${SERVER_SAMPLE_RATE}, frameMs=${SERVER_FRAME_DURATION_MS}, testMode=${TTS_TEST_MODE}, debug=${AUDIO_DEBUG}`);
});
