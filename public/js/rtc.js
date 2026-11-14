// 1:1 WebRTC voice call. Audio goes peer-to-peer; the server only relays signaling.
// If the network changes mid-call (Wi-Fi <-> mobile data), the caller renegotiates with an ICE restart.
const RECOVERY_WINDOW_MS = 30_000;

export class Call extends EventTarget {
  /** @param {() => Promise<RTCIceServer[]>} getIceServers fetched per call so TURN credentials are fresh */
  constructor(socket, getIceServers) {
    super();
    this.socket = socket;
    this.getIceServers = getIceServers;
    this.iceServers = [];
    this.isCaller = false;
    this.recoverTimer = null;
    this.recoverDeadline = null;
    this.roomId = null;
    this.state = "idle"; // idle | outgoing | incoming | active
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingCandidates = [];

    // Every event carries the room it belongs to; events for another room are ignored.
    const mine = (p) => p?.roomId === this.roomId;
    socket.on("call:request", (p = {}) => {
      if (this.state === "incoming" && mine(p)) return; // same call delivered twice (e.g. after reopening the app)
      if (this.state !== "idle") return socket.emit("call:decline", { roomId: p.roomId, reason: "busy" });
      this.roomId = p.roomId;
      this.state = "incoming";
      this.emit("incoming", { roomId: p.roomId, from: p.from });
    });
    socket.on("call:accept", (p) => mine(p) && this.#onAccepted());
    socket.on("call:decline", (p) => {
      if (mine(p) && this.state === "outgoing") this.#cleanup("declined");
    });
    socket.on("call:cancel", (p) => {
      if (mine(p) && this.state === "incoming") this.#cleanup("cancelled");
    });
    socket.on("call:no-answer", (p) => {
      if (mine(p) && this.state === "outgoing") this.#cleanup("no_answer");
    });
    socket.on("call:ringing", (p) => mine(p) && this.emit("ringing", { notified: p.notified }));
    socket.on("call:end", (p) => mine(p) && this.#cleanup("ended"));
    socket.on("rtc:signal", (data) => mine(data) && this.#onSignal(data).catch((e) => console.error("signal error", e)));
  }

  #send(event, data = {}) {
    this.socket.emit(event, { ...data, roomId: this.roomId });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** @param {string} roomId */
  async start(roomId) {
    if (this.state !== "idle") return;
    this.roomId = roomId;
    this.state = "outgoing";
    this.isCaller = true;
    try {
      await this.#prepare();
    } catch (e) {
      this.#cleanup("media_error");
      throw e;
    }
    this.emit("state", { state: this.state });
    this.#send("call:request");
  }

  async accept() {
    if (this.state !== "incoming") return;
    this.isCaller = false;
    try {
      await this.#prepare();
    } catch (e) {
      this.#send("call:decline", { reason: "media_error" });
      this.#cleanup("media_error");
      throw e;
    }
    this.state = "active";
    this.#createPeer();
    this.emit("state", { state: this.state });
    this.#send("call:accept");
  }

  decline() {
    if (this.state !== "incoming") return;
    this.#send("call:decline", { reason: "declined" });
    this.#cleanup("declined_by_me");
  }

  hangup() {
    if (this.state === "idle") return;
    this.#send(this.state === "outgoing" ? "call:cancel" : "call:end");
    this.#cleanup("ended_by_me");
  }

  /** Called when the chat room closes (partner left / disconnected). */
  abort() {
    if (this.state !== "idle") this.#cleanup("ended");
  }

  setMicEnabled(on) {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = on));
  }

  /**
   * Try to bring a dropped connection back (also called after the signaling socket reconnects).
   * Only the caller sends offers, so both sides never renegotiate at the same time.
   */
  recover() {
    const pc = this.pc;
    if (this.state !== "active" || !pc) return;
    if (!["disconnected", "failed"].includes(pc.connectionState)) return;
    this.recoverDeadline ??= Date.now() + RECOVERY_WINDOW_MS;
    if (Date.now() > this.recoverDeadline) return this.hangup();
    this.emit("connection", { state: "reconnecting" });
    if (this.isCaller) this.#sendOffer(true).catch((e) => console.warn("ice restart failed", e));
    else this.#send("rtc:signal", { type: "restart" });
    clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => this.recover(), 5000);
  }

  #clearRecovery() {
    clearTimeout(this.recoverTimer);
    this.recoverTimer = null;
    this.recoverDeadline = null;
  }

  async #prepare() {
    const [servers] = await Promise.all([this.getIceServers().catch(() => null), this.#getMedia()]);
    if (servers?.length) this.iceServers = servers;
  }

  async #getMedia() {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.emit("local-stream", { stream: this.localStream });
  }

  #createPeer() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.remoteStream = new MediaStream();
    this.emit("remote-stream", { stream: this.remoteStream });

    this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
    pc.ontrack = (ev) => {
      if (!this.remoteStream.getTracks().includes(ev.track)) this.remoteStream.addTrack(ev.track);
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.#send("rtc:signal", { type: "candidate", candidate: ev.candidate });
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      this.emit("connection", { state: st });
      if (st === "connected") this.#clearRecovery();
      else if (st === "disconnected" || st === "failed") {
        // "disconnected" often heals by itself within a few seconds; "failed" needs an ICE restart now.
        clearTimeout(this.recoverTimer);
        this.recoverTimer = setTimeout(() => this.recover(), st === "failed" ? 0 : 2500);
      }
    };
    return pc;
  }

  async #onAccepted() {
    if (this.state !== "outgoing") return;
    this.state = "active";
    this.emit("state", { state: this.state });
    this.#createPeer();
    await this.#sendOffer(false);
  }

  async #sendOffer(iceRestart) {
    const pc = this.pc;
    if (!pc) return;
    const offer = await pc.createOffer({ iceRestart });
    await pc.setLocalDescription(offer);
    this.#send("rtc:signal", { type: "offer", sdp: pc.localDescription });
  }

  async #onSignal(data) {
    if (this.state !== "active" || !this.pc) return;
    const pc = this.pc;
    if (data.type === "restart") {
      if (this.isCaller) await this.#sendOffer(true);
    } else if (data.type === "offer") {
      await pc.setRemoteDescription(data.sdp);
      await this.#flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.#send("rtc:signal", { type: "answer", sdp: pc.localDescription });
    } else if (data.type === "answer") {
      await pc.setRemoteDescription(data.sdp);
      await this.#flushCandidates();
    } else if (data.type === "candidate") {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else this.pendingCandidates.push(data.candidate);
    }
  }

  async #flushCandidates() {
    const list = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of list) await this.pc.addIceCandidate(c).catch(() => {});
  }

  #cleanup(reason) {
    this.#clearRecovery();
    this.pc?.close();
    this.pc = null;
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.remoteStream = null;
    this.pendingCandidates = [];
    const was = this.state;
    this.state = "idle";
    if (was !== "idle") this.emit("ended", { reason, was });
  }
}
