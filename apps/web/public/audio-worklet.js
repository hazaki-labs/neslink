// Plays mono samples posted by the emulator worker through a ring buffer.
// Served as a static file because AudioWorklet modules are loaded by URL.
//
// The emulator is paced by the display, not the audio clock, so it produces
// samples slightly faster or slower than we play them. Instead of dropping or
// starving, the playback rate is nudged (at most +-0.5%, inaudible) to keep
// the buffer near its target fill.

const CAPACITY = 16384; // samples (~340ms at 48kHz)
const MAX_RATE_ADJUST = 0.005;

class NesAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CAPACITY);
    this.read = 0; // fractional position
    this.write = 0;
    this.size = 0;
    this.primed = false;
    const frame = sampleRate / 60;
    // Aim for ~3 NES frames queued; start once that much has arrived.
    this.target = Math.round(frame * 3);
    // Far beyond target (e.g. a burst after a stall): skip ahead rather than lag.
    this.maxQueued = Math.round(frame * 10);
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "port") {
        message.port.onmessage = (e) => this.onMessage(e.data);
      } else {
        this.onMessage(message);
      }
    };
  }

  onMessage(message) {
    if (message.type === "flush") {
      this.read = this.write = this.size = 0;
      this.primed = false;
      return;
    }
    if (message.type !== "samples") return;
    const samples = message.samples;
    for (let i = 0; i < samples.length && this.size < CAPACITY; i++) {
      this.buffer[this.write] = samples[i];
      this.write = (this.write + 1) % CAPACITY;
      this.size++;
    }
    if (this.size > this.maxQueued) {
      const skip = this.size - this.target;
      this.read = (this.read + skip) % CAPACITY;
      this.size -= skip;
    }
  }

  process(_inputs, outputs) {
    const [outL, outR = outL] = outputs[0];
    if (!this.primed && this.size >= this.target) this.primed = true;
    // Proportional control: consume faster when over target, slower when under.
    const error = (this.size - this.target) / this.target;
    const rate = 1 + Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, error * 0.01));
    for (let i = 0; i < outL.length; i++) {
      if (this.primed && this.size > 1) {
        const index = Math.floor(this.read);
        const frac = this.read - index;
        const a = this.buffer[index];
        const b = this.buffer[(index + 1) % CAPACITY];
        outL[i] = outR[i] = a + (b - a) * frac;
        const next = this.read + rate;
        const consumed = Math.floor(next) - index;
        this.read = next % CAPACITY;
        this.size -= consumed;
      } else {
        outL[i] = outR[i] = 0;
        // Underrun: wait to rebuffer instead of crackling sample by sample.
        this.primed = false;
      }
    }
    return true;
  }
}

registerProcessor("nes-audio", NesAudioProcessor);
