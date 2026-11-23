'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const processors = {};
vm.runInNewContext(fs.readFileSync(require.resolve('./mobile-worklet.js'), 'utf8'), {
  Float32Array, sampleRate: 48000,
  AudioWorkletProcessor: class {
    constructor() { this.messages = []; this.port = { postMessage: (m) => this.messages.push(m) }; }
  },
  registerProcessor: (name, processor) => { processors[name] = processor; },
});

test('burst, pause and short tail preserve all samples in sequence', () => {
  const p = new processors['playback-processor']({ processorOptions: { srcRate: 24000 } });
  const send = (data) => p.port.onmessage({ data });
  const render = (length) => {
    const out = new Float32Array(length);
    const active = p.process([], [[out]]);
    return { out, active };
  };
  send(Float32Array.of(1, 2));
  assert.deepEqual([...render(4).out], [0, 0, 0, 0]);
  send(Float32Array.of(3, 4));
  send({ cmd: 'end' });
  assert.deepEqual([...render(3).out], [1, 1.5, 2]);
  send({ cmd: 'pause' });
  assert.deepEqual([...render(4).out], [0, 0, 0, 0]);
  send({ cmd: 'resume' });
  const tail = render(5);
  assert.deepEqual([...tail.out], [2.5, 3, 3.5, 4, 4]);
  assert.equal(tail.active, false);
  assert.deepEqual(p.messages.map((message) => message.cmd), ['started', 'drained']);
});

test('mic flush sends its remaining audio before the stop acknowledgement', () => {
  const p = new processors['capture-processor']();
  p.process([[Float32Array.of(0.25, 0.5)]]);
  p.port.onmessage({ data: { cmd: 'flush' } });
  assert.deepEqual([...p.messages[0]], [0.25, 0.5]);
  assert.equal(p.messages[1].cmd, 'flushed');
  assert.equal(p.process([]), false);
});

test('a long burst retains the beginning instead of overwriting it', () => {
  const p = new processors['playback-processor']({ processorOptions: { srcRate: 24000 } });
  for (let index = 1; index <= 300; index += 1) {
    p.port.onmessage({ data: new Float32Array(4096).fill(index) });
  }
  const out = new Float32Array(128);
  p.process([], [[out]]);
  assert.ok(out.every((sample) => sample === 1));
});
