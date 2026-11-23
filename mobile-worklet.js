'use strict';

// AudioWorklet processors for the OpenCode touch UI.
// Capture: 48 kHz mono Float32 frames for Parakeet.
// Playback: ordered FIFO for streamed OmniVoice PCM.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.pos = 0;
    this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (data.cmd !== 'flush' || this.finished) return;
      this.finished = true;
      if (this.pos) this.port.postMessage(this.buf.slice(0, this.pos));
      this.port.postMessage({ cmd: 'flushed' });
    };
  }

  process(inputs) {
    if (this.finished) return false;
    const input = inputs[0];
    if (!input || !input.length) return true;
    const channel = input[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.buf[this.pos] = channel[i];
      this.pos += 1;
      if (this.pos >= this.buf.length) {
        this.port.postMessage(this.buf.slice(0));
        this.pos = 0;
      }
    }
    return true;
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.queue = [];
    this.head = 0;
    this.offset = 0;
    this.frac = 0;
    this.fill = 0;
    const srcRate = options.processorOptions.srcRate || 24000;
    this.ratio = srcRate / sampleRate;
    this.resumeFill = Math.round(srcRate * 0.22);
    this.started = false;
    this.ended = false;
    this.paused = false;
    this.port.onmessage = ({ data }) => {
      if (data.cmd === 'pause') this.paused = true;
      else if (data.cmd === 'resume') this.paused = false;
      else if (data.cmd === 'end') this.ended = true;
      else if (data instanceof Float32Array && data.length) {
        this.queue.push(data);
        this.fill += data.length;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    out.fill(0);
    if (this.paused) return true;
    if (!this.started && !this.ended && this.fill < this.resumeFill) return true;
    this.started = true;
    if (this.fill > 0 && !this.reportedStart) {
      this.reportedStart = true;
      this.port.postMessage({ cmd: 'started' });
    }
    for (let i = 0; i < out.length && this.fill >= (this.ended ? 1 : Math.max(2, Math.ceil(this.ratio))); i += 1) {
      const chunk = this.queue[this.head];
      const current = chunk[this.offset];
      const next = chunk[this.offset + 1] ?? this.queue[this.head + 1]?.[0] ?? current;
      out[i] = current + this.frac * (next - current);
      this.frac += this.ratio;
      while (this.frac >= 1 && this.fill) {
        this.frac -= 1;
        this.fill -= 1;
        if (++this.offset === this.queue[this.head].length) {
          this.queue[this.head++] = null;
          this.offset = 0;
        }
      }
    }
    if (this.head >= 64 || this.head === this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    if (this.ended && this.fill === 0) {
      this.port.postMessage({ cmd: 'drained' });
      return false;
    }
    if (this.fill < Math.max(2, Math.ceil(this.ratio))) this.started = false;
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
registerProcessor('playback-processor', PlaybackProcessor);
