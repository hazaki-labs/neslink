// Plays interleaved stereo samples posted by the emulator worker through a ring buffer.
// Served as a static file because AudioWorklet modules are loaded by URL.

const CAPACITY = 16384; // stereo frames (~340ms at 48kHz)

class NesAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY);
    this.right = new Float32Array(CAPACITY);
    this.read = 0;
    this.write = 0;
    this.size = 0;
    this.primed = false;
    // Start once ~3 NES frames are queued; never hold more than ~8.
    this.startAt = Math.round((sampleRate / 60) * 3);
    this.maxQueued = Math.round((sampleRate / 60) * 8);
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
    for (let i = 0; i + 1 < samples.length; i += 2) {
      if (this.size === CAPACITY) break;
      this.left[this.write] = samples[i];
      this.right[this.write] = samples[i + 1];
      this.write = (this.write + 1) % CAPACITY;
      this.size++;
    }
    // The emulator runs slightly faster than 60Hz; drop the oldest audio to keep latency bounded.
    while (this.size > this.maxQueued) {
      this.read = (this.read + 1) % CAPACITY;
      this.size--;
    }
  }

  process(_inputs, outputs) {
    const [outL, outR = outL] = outputs[0];
    if (!this.primed && this.size >= this.startAt) this.primed = true;
    for (let i = 0; i < outL.length; i++) {
      if (this.primed && this.size > 0) {
        outL[i] = this.left[this.read];
        outR[i] = this.right[this.read];
        this.read = (this.read + 1) % CAPACITY;
        this.size--;
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
