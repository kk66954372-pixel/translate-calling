// Server-side speech-to-text for call captions.
//
// The browser sends the call's own microphone audio (16 kHz, 16-bit mono PCM, echo-cancelled) and we
// stream it to Deepgram. This avoids running the browser's speech recognition next to a WebRTC call,
// which phones (iOS Safari, Android Chrome) handle badly: both want the microphone.
//
// STT=deepgram (default when DEEPGRAM_API_KEY is set) | mock (fake transcripts, for tests) | off
import WebSocket from "ws";

const KEY = process.env.DEEPGRAM_API_KEY;
const MODE = (process.env.STT || (KEY ? "deepgram" : "off")).toLowerCase();
const MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
// Cost guard: total audio minutes per day (Korea/Japan date) sent to Deepgram. 0 = unlimited.
const DAILY_MINUTES = Number(process.env.DAILY_STT_MINUTES ?? 600);

export const sttInfo = { mode: MODE === "deepgram" && !KEY ? "off" : MODE, model: MODEL };
export const sttEnabled = sttInfo.mode === "deepgram" || sttInfo.mode === "mock";

const usage = { day: "", bytes: 0 };
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
function addUsage(bytes) {
  const d = today();
  if (usage.day !== d) Object.assign(usage, { day: d, bytes: 0 });
  usage.bytes += bytes;
}
function overDailyLimit() {
  if (usage.day !== today()) return false;
  return DAILY_MINUTES > 0 && usage.bytes >= DAILY_MINUTES * 60 * BYTES_PER_SECOND;
}

/**
 * One live transcription stream (one speaker).
 * @param {{lang: "ko"|"ja", onInterim: (t: string) => void, onFinal: (t: string) => void, onError: (code: string) => void}} h
 */
export function openStream(h) {
  if (!sttEnabled) return null;
  if (overDailyLimit()) {
    queueMicrotask(() => h.onError("daily_limit"));
    return null;
  }
  return sttInfo.mode === "mock" ? new MockStream(h) : new DeepgramStream(h);
}

// Japanese has no spaces between words, but transcripts can come back space-separated.
const CJK = "\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef";
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, "g");

class DeepgramStream {
  constructor(h) {
    this.h = h;
    this.closed = false;
    this.pending = []; // audio that arrived before the socket opened
    this.finals = []; // finished segments of the sentence being spoken
    this.lastAudio = Date.now();
    this.join = (parts) => {
      const text = parts.join(" ").trim();
      return h.lang === "ja" ? text.replace(CJK_GAP, "") : text;
    };

    const params = new URLSearchParams({
      model: MODEL,
      language: h.lang,
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: "400", // ms of silence that ends a sentence
      utterance_end_ms: "1200", // backup end-of-sentence signal for noisy audio
      vad_events: "true",
    });
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${KEY}` },
    });
    this.ws.on("open", () => {
      for (const chunk of this.pending) this.ws.send(chunk);
      this.pending = [];
    });
    this.ws.on("message", (data) => this.#onMessage(data));
    this.ws.on("unexpected-response", (req, res) => {
      req.destroy();
      // 401: bad key, 402: out of credit, 400: unsupported model/language.
      const code = res.statusCode === 402 ? "no_credit" : res.statusCode === 401 || res.statusCode === 403 ? "auth" : `http_${res.statusCode}`;
      console.error(`[stt] Deepgram refused the stream: ${res.statusCode}`);
      this.#fail(code);
    });
    this.ws.on("error", (e) => {
      console.error("[stt] Deepgram socket error:", e.message);
      this.#fail("network");
    });
    this.ws.on("close", (code, reason) => {
      if (!this.closed && code !== 1000) {
        console.error(`[stt] Deepgram closed the stream: ${code} ${reason}`);
        this.#fail("closed");
      }
      this.closed = true;
      clearInterval(this.keepAlive);
    });
    // Deepgram closes a stream after ~10 s without data (e.g. while muted).
    this.keepAlive = setInterval(() => {
      if (Date.now() - this.lastAudio > 7000 && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, 3000);
  }

  write(chunk) {
    if (this.closed) return;
    if (overDailyLimit()) return this.#fail("daily_limit");
    this.lastAudio = Date.now();
    addUsage(chunk.length);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
    else if (this.ws.readyState === WebSocket.CONNECTING && this.pending.length < 50) this.pending.push(chunk);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.#flush();
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "CloseStream" }));
      setTimeout(() => this.ws.terminate(), 1500);
    } catch {}
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "UtteranceEnd") return this.#flush();
    if (msg.type !== "Results") return;
    const text = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
    if (msg.is_final) {
      if (text) this.finals.push(text);
      if (msg.speech_final) this.#flush();
      else if (this.finals.length) this.h.onInterim(this.join(this.finals));
    } else if (text) {
      this.h.onInterim(this.join([...this.finals, text]));
    }
  }

  /** The speaker paused: hand over the finished sentence. */
  #flush() {
    const sentence = this.join(this.finals);
    this.finals = [];
    if (sentence) this.h.onFinal(sentence);
  }

  #fail(code) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    try {
      this.ws.terminate();
    } catch {}
    this.h.onError(code);
  }
}

/** Fake recognizer for tests: one sentence for every 2 seconds of audio received. */
class MockStream {
  constructor(h) {
    this.h = h;
    this.bytes = 0;
    this.n = 0;
    this.closed = false;
  }
  write(chunk) {
    if (this.closed) return;
    addUsage(chunk.length);
    this.bytes += chunk.length;
    if (this.bytes >= BYTES_PER_SECOND && this.bytes - chunk.length < BYTES_PER_SECOND) {
      this.h.onInterim(this.h.lang === "ko" ? "테스트 음성" : "テスト音声");
    }
    if (this.bytes >= 2 * BYTES_PER_SECOND) {
      this.bytes = 0;
      this.n++;
      this.h.onFinal(this.h.lang === "ko" ? `테스트 음성 ${this.n}번` : `テスト音声 ${this.n}番`);
    }
  }
  close() {
    this.closed = true;
  }
}
