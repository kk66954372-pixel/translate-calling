// Call captions via server-side speech recognition (works on phones).
// The call's own microphone stream (already echo-cancelled for WebRTC) is converted to 16 kHz PCM
// and streamed to the server, which forwards it to the speech-to-text service.
export class ServerSTT {
  /**
   * @param {import("socket.io-client").Socket} socket
   * @param {{onInterim: (t: string) => void, onError: (code: string) => void, shouldPause: () => boolean}} h
   */
  constructor(socket, h) {
    this.socket = socket;
    this.h = h;
    this.ctx = null;
    this.source = null;
    this.node = null;
    this.running = false;
    this.starting = null;
    socket.on("stt:interim", ({ text }) => this.running && h.onInterim(text));
    socket.on("stt:error", ({ error }) => {
      if (!this.running) return;
      this.stop();
      h.onError(error);
    });
  }

  /** Create/resume the AudioContext. Call from a tap (call / accept button): iOS only allows audio after a gesture. */
  prime() {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    } catch {}
  }

  /** @param {MediaStream} stream */
  start(stream) {
    if (this.running) return Promise.resolve(true);
    this.starting ??= this.#start(stream).finally(() => (this.starting = null));
    return this.starting;
  }

  async #start(stream) {
    this.prime();
    if (!this.ctx?.audioWorklet) return false;
    const ok = await new Promise((resolve) =>
      this.socket.timeout(5000).emit("stt:start", null, (err, res) => resolve(!err && res?.ok)),
    );
    if (!ok) return false;
    try {
      await this.ctx.audioWorklet.addModule("/js/pcm-worklet.js");
      this.source = this.ctx.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(this.ctx, "pcm16k");
      this.node.port.onmessage = (e) => {
        if (this.running && !this.h.shouldPause()) this.socket.emit("stt:audio", e.data);
      };
      // The worklet only runs while connected to the output; a muted gain keeps it silent.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.source.connect(this.node).connect(mute).connect(this.ctx.destination);
      if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
      this.running = true;
      return true;
    } catch (e) {
      console.warn("server STT could not start", e);
      this.socket.emit("stt:stop");
      this.#disconnect();
      return false;
    }
  }

  stop() {
    if (this.running) this.socket.emit("stt:stop");
    this.running = false;
    this.#disconnect();
  }

  #disconnect() {
    try {
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {}
    this.source = null;
    this.node = null;
  }
}
