import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeChirp, makeSequence, fft, crossCorrelate, detectDelay, median, spread, seededNoise, DEFAULTS,
} from '../src/audio-latency-test.js';

const SR = 48000;

/** Recording = silence, then the chirp sequence starting `delay` samples after `start`, scaled, plus noise. */
function synth({ delay, start = 0, gain = 0.3, noiseRms = 0, seed = 7, sr = SR }) {
  const seq = makeSequence({ sampleRate: sr });
  const rec = new Float32Array(start + delay + seq.signal.length + Math.round(0.5 * sr));
  for (let i = 0; i < seq.signal.length; i += 1) rec[start + delay + i] += seq.signal[i] * gain;
  if (noiseRms) {
    const n = seededNoise(rec.length, noiseRms, seed);
    for (let i = 0; i < rec.length; i += 1) rec[i] += n[i];
  }
  return { rec, seq };
}

test('makeChirp: length, Hann edges, bounded', () => {
  const c = makeChirp({ sampleRate: SR });
  assert.equal(c.length, Math.round(DEFAULTS.durationSec * SR));
  assert.ok(Math.abs(c[0]) < 1e-6 && Math.abs(c[c.length - 1]) < 1e-6);
  assert.ok(c.every((v) => Math.abs(v) <= 1));
});

test('makeSequence: 5 onsets at 0.3 s spacing', () => {
  const s = makeSequence({ sampleRate: SR });
  assert.deepEqual(s.onsets, [0, 1, 2, 3, 4].map((i) => i * 14400));
  assert.equal(s.gapSamples, 14400);
});

test('fft round-trip restores the input', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + (i % 3));
  const orig = Float64Array.from(re);
  const im = new Float64Array(64);
  fft(re, im);
  fft(re, im, true);
  for (let i = 0; i < 64; i += 1) assert.ok(Math.abs(re[i] / 64 - orig[i]) < 1e-9);
  assert.throws(() => fft(new Float64Array(6), new Float64Array(6)), RangeError);
});

test('crossCorrelate matches direct computation and peaks at the shift', () => {
  const ref = Float32Array.from([1, -2, 3, 0.5]);
  const x = new Float32Array(40);
  x.set(ref, 17);
  const c = crossCorrelate(x, ref);
  for (let k = 0; k < x.length; k += 1) {
    let d = 0;
    for (let n = 0; n < ref.length; n += 1) d += (x[n + k] ?? 0) * ref[n];
    assert.ok(Math.abs(c[k] - d) < 1e-9, `lag ${k}`);
  }
  let best = 0;
  for (let k = 1; k < c.length; k += 1) if (c[k] > c[best]) best = k;
  assert.equal(best, 17);
});

for (const delayMs of [0, 12.5, 87, 250]) {
  test(`detectDelay recovers a known ${delayMs} ms delay (clean)`, () => {
    const delay = Math.round((delayMs / 1000) * SR);
    const { rec, seq } = synth({ delay });
    const r = detectDelay(rec, seq.chirp, { sampleRate: SR, gapSamples: seq.gapSamples });
    assert.equal(r.status, 'ok');
    assert.equal(r.lagSamples, delay);
    assert.ok(Math.abs(r.delayMs - delay / SR * 1000) < 1e-9);
  });
}

test('detectDelay recovers delay with noise and expectedStart offset (±1 sample)', () => {
  const start = 2400;
  const delay = Math.round(0.143 * SR);
  const { rec, seq } = synth({ delay, start, gain: 0.2, noiseRms: 0.02 });
  const r = detectDelay(rec, seq.chirp, { sampleRate: SR, expectedStart: start, gapSamples: seq.gapSamples });
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.lagSamples - delay) <= 1, `got ${r.lagSamples}, want ${delay}`);
  assert.ok(r.peakRatio >= 3);
});

test('detectDelay works at 44.1 kHz', () => {
  const sr = 44100;
  const delay = Math.round(0.061 * sr);
  const { rec, seq } = synth({ delay, sr, noiseRms: 0.01 });
  const r = detectDelay(rec, seq.chirp, { sampleRate: sr, gapSamples: seq.gapSamples });
  assert.equal(r.status, 'ok');
  assert.ok(Math.abs(r.lagSamples - delay) <= 1);
});

test('detectDelay: silence → too_quiet', () => {
  const chirp = makeChirp({ sampleRate: SR });
  assert.equal(detectDelay(new Float32Array(SR * 2), chirp, { sampleRate: SR }).status, 'too_quiet');
});

test('detectDelay: pure noise is not reported as ok', () => {
  const chirp = makeChirp({ sampleRate: SR });
  const r = detectDelay(seededNoise(SR * 2, 0.1, 3), chirp, { sampleRate: SR });
  assert.notEqual(r.status, 'ok');
});

test('detectDelay: a single chirp (wrong spacing) is not ok', () => {
  const chirp = makeChirp({ sampleRate: SR });
  const rec = new Float32Array(SR * 2);
  rec.set(chirp.map((v) => v * 0.5), 5000);
  const r = detectDelay(rec, chirp, { sampleRate: SR });
  assert.notEqual(r.status, 'ok');
});

test('median and spread', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.equal(spread([10, 14, 12]), 4);
});

test('seededNoise is deterministic and has the requested RMS', () => {
  const a = seededNoise(20000, 0.5, 42);
  const b = seededNoise(20000, 0.5, 42);
  assert.deepEqual(a, b);
  const rms = Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  assert.ok(Math.abs(rms - 0.5) < 0.02);
});
