// 1:1 WebRTC call. Media goes peer-to-peer; the server only relays signaling.
export class Call extends EventTarget {
  constructor(socket, iceServers) {
    super();
    this.socket = socket;
    this.iceServers = iceServers;
    this.state = "idle"; // idle | outgoing | incoming | active
    this.video = false;
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingCandidates = [];

    socket.on("call:request", ({ video }) => {
      if (this.state !== "idle") return socket.emit("call:decline", { reason: "busy" });
      this.state = "incoming";
      this.video = Boolean(video);
      this.emit("incoming", { video: this.video });
    });
    socket.on("call:accept", () => this.#onAccepted());
    socket.on("call:decline", () => {
      if (this.state === "outgoing") this.#cleanup("declined");
    });
    socket.on("call:cancel", () => {
      if (this.state === "incoming") this.#cleanup("cancelled");
    });
    socket.on("call:end", () => this.#cleanup("ended"));
    socket.on("rtc:signal", (data) => this.#onSignal(data).catch((e) => console.error("signal error", e)));
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async start(video) {
    if (this.state !== "idle") return;
    this.state = "outgoing";
    this.video = video;
    try {
      await this.#getMedia(video);
    } catch (e) {
      this.#cleanup("media_error");
      throw e;
    }
    this.emit("state", { state: this.state });
    this.socket.emit("call:request", { video });
  }

  async accept() {
    if (this.state !== "incoming") return;
    try {
      await this.#getMedia(this.video);
    } catch (e) {
      this.socket.emit("call:decline", { reason: "media_error" });
      this.#cleanup("media_error");
      throw e;
    }
    this.state = "active";
    this.#createPeer();
    this.emit("state", { state: this.state });
    this.socket.emit("call:accept");
  }

  decline() {
    if (this.state !== "incoming") return;
    this.socket.emit("call:decline", { reason: "declined" });
    this.#cleanup("declined_by_me");
  }

  hangup() {
    if (this.state === "idle") return;
    this.socket.emit(this.state === "outgoing" ? "call:cancel" : "call:end");
    this.#cleanup("ended_by_me");
  }

  /** Called when the chat room closes (partner left / disconnected). */
  abort() {
    if (this.state !== "idle") this.#cleanup("ended");
  }

  setMicEnabled(on) {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = on));
  }
  setCameraEnabled(on) {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = on));
  }
  get hasLocalVideo() {
    return Boolean(this.localStream?.getVideoTracks().length);
  }

  async #getMedia(video) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: video ? { width: 1280, height: 720 } : false });
    } catch (e) {
      if (!video) throw e;
      // Camera unavailable: fall back to a voice call instead of failing outright.
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    }
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
      this.emit("remote-track", { track: ev.track });
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.socket.emit("rtc:signal", { type: "candidate", candidate: ev.candidate });
    };
    pc.onconnectionstatechange = () => {
      this.emit("connection", { state: pc.connectionState });
      if (pc.connectionState === "failed") this.hangup();
    };
    return pc;
  }

  async #onAccepted() {
    if (this.state !== "outgoing") return;
    this.state = "active";
    this.emit("state", { state: this.state });
    const pc = this.#createPeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.socket.emit("rtc:signal", { type: "offer", sdp: pc.localDescription });
  }

  async #onSignal(data) {
    if (this.state !== "active" || !this.pc) return;
    const pc = this.pc;
    if (data.type === "offer") {
      await pc.setRemoteDescription(data.sdp);
      await this.#flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit("rtc:signal", { type: "answer", sdp: pc.localDescription });
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
