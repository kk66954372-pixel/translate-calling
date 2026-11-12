// Continuous speech recognition using the browser's Web Speech API (Chrome / Edge / Safari).
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const speechSupported = Boolean(Recognition);

export class Recognizer {
  /**
   * @param {string} lang BCP-47 code, e.g. "ko-KR"
   * @param {{onInterim?: (t: string) => void, onFinal?: (t: string) => void, onState?: (s: string) => void, shouldIgnore?: () => boolean}} handlers
   */
  constructor(lang, handlers) {
    this.lang = lang;
    this.h = handlers;
    this.running = false;
    this.rec = null;
    this.restartTimer = null;
  }

  start() {
    if (!speechSupported || this.running) return;
    this.running = true;
    this.#spawn();
  }

  stop() {
    this.running = false;
    clearTimeout(this.restartTimer);
    try {
      this.rec?.abort();
    } catch {}
    this.rec = null;
    this.h.onState?.("stopped");
  }

  #spawn() {
    const rec = new Recognition();
    this.rec = rec;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => this.h.onState?.("listening");
    rec.onresult = (ev) => {
      // Ignore what the mic hears while we are reading a translation aloud (prevents echo loops).
      if (this.h.shouldIgnore?.()) return;
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (r.isFinal) this.h.onFinal?.(text);
        else interim += text + " ";
      }
      if (interim) this.h.onInterim?.(interim.trim());
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        this.running = false;
        this.h.onState?.("denied");
      }
      // "no-speech", "aborted", "network": onend fires next and we restart.
    };
    rec.onend = () => {
      // Chrome stops recognition after silence or ~60s; keep it alive while the call is on.
      if (!this.running) return;
      this.restartTimer = setTimeout(() => this.running && this.#spawn(), 250);
    };

    try {
      rec.start();
    } catch {
      this.restartTimer = setTimeout(() => this.running && this.#spawn(), 1000);
    }
  }
}

// ---- Text-to-speech ---------------------------------------------------------
let speakingUntil = 0;

export function isSpeaking() {
  return window.speechSynthesis?.speaking || Date.now() < speakingUntil;
}

export function speak(text, lang, { rate = 1 } = {}) {
  if (!window.speechSynthesis || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = rate;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace("_", "-").startsWith(lang.slice(0, 2)));
  if (voice) u.voice = voice;
  u.onend = () => (speakingUntil = Date.now() + 600);
  speechSynthesis.speak(u);
}
