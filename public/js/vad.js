// Voice activity gate: decides which 100 ms chunks of call audio are worth sending to speech recognition.
// Speech recognition is billed by the audio sent, and in a conversation each person is silent more than
// half the time, so skipping the silence roughly halves the cost.
//
// - pre-roll: the last few quiet chunks are held back and sent when speech starts, so the first syllable
//   is not cut off;
// - hangover: chunks keep flowing for a while after speech stops, so the recognizer hears the pause and
//   closes the sentence.
// The mic stream already has noise suppression on, so a simple level threshold that follows the
// background level works well.
export class VoiceGate {
  constructor({ preRoll = 3, hangover = 8, minLevel = 0.006, ratio = 3 } = {}) {
    this.preRoll = preRoll;
    this.hangover = hangover;
    this.minLevel = minLevel; // about -44 dBFS: quieter than this is never speech
    this.ratio = ratio; // speech must be this many times louder than the background
    this.noise = 0.002; // running estimate of the background level
    this.held = [];
    this.quietFor = Infinity;
    this.stats = { sent: 0, skipped: 0 };
  }

  /** Root-mean-square level of 16-bit PCM, 0..1. */
  static level(int16) {
    let sum = 0;
    for (let i = 0; i < int16.length; i++) sum += int16[i] * int16[i];
    return Math.sqrt(sum / int16.length) / 32768;
  }

  /**
   * @param {Int16Array} chunk
   * @returns {Int16Array[]} the chunks to send now (empty while it is quiet)
   */
  push(chunk) {
    const level = VoiceGate.level(chunk);
    const speech = level > Math.max(this.minLevel, this.noise * this.ratio);
    // Follow the background quickly while quiet, and very slowly during "speech" so a steady new noise
    // (a fan, traffic) eventually stops counting as speech.
    const rate = speech ? 0.002 : 0.05;
    this.noise += (level - this.noise) * rate;

    this.quietFor = speech ? 0 : this.quietFor + 1;
    if (this.quietFor <= this.hangover) {
      const out = this.held.length ? [...this.held, chunk] : [chunk];
      this.held = [];
      this.stats.sent += out.length;
      return out;
    }
    this.held.push(chunk);
    if (this.held.length > this.preRoll) {
      this.held.shift();
      this.stats.skipped++;
    }
    return [];
  }
}
