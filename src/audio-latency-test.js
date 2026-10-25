/**
 * audio-latency-test — measure speaker → microphone round-trip audio latency in the browser.
 *
 * Plays a train of short linear chirps, records the microphone, cross-correlates the recording with one chirp
 * (FFT-based), and keeps only peaks that line up with the known chirp spacing. Repeats a few times and reports
 * the median.
 *
 * Zero dependencies. The DSP functions are pure (no DOM, no Web Audio) and run in Node; `measureRoundTrip`
 * needs a browser with Web Audio, AudioWorklet and getUserMedia.
 *
 * @license MIT
 */

/** Default signal parameters. */
export const DEFAULTS = Object.freeze({
  /** Chirp length in seconds. */
  durationSec: 0.02,
  /** Sweep start frequency, Hz. */
  f0: 1000,
  /** Sweep end frequency, Hz. */
  f1: 8000,
  /** Chirps per sequence. */
  count: 5,
  /** Time between chirp onsets, seconds. */
  gapSec: 0.3,
  /** Minimum ratio of the weakest matched peak to the strongest other peak. */
  minRatio: 3,
});

/**
 * Linear frequency sweep f0 → f1 with a Hann window (no clicks, sharp correlation peak).
 * @param {{ sampleRate: number, durationSec?: number, f0?: number, f1?: number }} opts
 * @returns {Float32Array}
 */
export function makeChirp({ sampleRate, durationSec = DEFAULTS.durationSec, f0 = DEFAULTS.f0, f1 = DEFAULTS.f1 }) {
  if (!(sampleRate > 0)) throw new RangeError('sampleRate must be a positive number.');
  const n = Math.max(8, Math.round(durationSec * sampleRate));
  const out = new Float32Array(n);
  const k = (f1 - f0) / durationSec;
  for (let i = 0; i < n; i += 1) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = Math.sin(phase) * w;
  }
  return out;
}

/**
 * Builds the playback signal: `count` chirps, one every `gapSec` seconds.
 * @param {{ sampleRate: number, count?: number, gapSec?: number, amplitude?: number, chirp?: { durationSec?: number, f0?: number, f1?: number } }} opts
 * @returns {{ signal: Float32Array, chirp: Float32Array, onsets: number[], gapSamples: number }}
 */
export function makeSequence({ sampleRate, count = DEFAULTS.count, gapSec = DEFAULTS.gapSec, amplitude = 0.8, chirp: chirpOpts = {} }) {
  const chirp = makeChirp({ sampleRate, ...chirpOpts });
  const gapSamples = Math.round(gapSec * sampleRate);
  if (gapSamples <= chirp.length) throw new RangeError('gapSec must be longer than the chirp.');
  const signal = new Float32Array(gapSamples * (count - 1) + chirp.length);
  const onsets = [];
  for (let c = 0; c < count; c += 1) {
    const at = c * gapSamples;
    onsets.push(at);
    for (let i = 0; i < chirp.length; i += 1) signal[at + i] = chirp[i] * amplitude;
  }
  return { signal, chirp, onsets, gapSamples };
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * In-place iterative radix-2 FFT. With `inverse` it computes the unscaled inverse transform.
 * @param {Float64Array} re
 * @param {Float64Array} im
 * @param {boolean} [inverse=false]
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) throw new RangeError('FFT length must be a power of two.');
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k += 1) {
        const ar = re[i + k];
        const ai = im[i + k];
        const br = re[i + k + half] * cr - im[i + k + half] * ci;
        const bi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = ar + br;
        im[i + k] = ai + bi;
        re[i + k + half] = ar - br;
        im[i + k + half] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Cross-correlation c[k] = Σ x[n + k] · ref[n] for lags k = 0 … x.length − 1
 * (non-negative lags only: sound cannot arrive before it is played).
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} ref
 * @returns {Float64Array}
 */
export function crossCorrelate(x, ref) {
  const n = nextPow2(x.length + ref.length);
  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  const rr = new Float64Array(n);
  const ri = new Float64Array(n);
  xr.set(x);
  rr.set(ref);
  fft(xr, xi);
  fft(rr, ri);
  for (let i = 0; i < n; i += 1) {
    const a = xr[i];
    const b = xi[i];
    const c = rr[i];
    const d = -ri[i];
    xr[i] = a * c - b * d;
    xi[i] = a * d + b * c;
  }
  fft(xr, xi, true);
  const out = new Float64Array(x.length);
  for (let k = 0; k < x.length; k += 1) out[k] = xr[k] / n;
  return out;
}

/**
 * @typedef {'ok' | 'not_found' | 'too_noisy' | 'too_quiet'} DetectStatus
 *
 * @typedef {object} DetectResult
 * @property {DetectStatus} status
 * @property {number} [lagSamples] Lag of the first chirp in samples, relative to `expectedStart`.
 * @property {number} [delayMs] Same lag in milliseconds.
 * @property {number} [peakRatio] Weakest matched peak divided by the strongest correlation elsewhere.
 * @property {number[]} [peaks] Indices of the matched correlation peaks.
 *
 * @typedef {object} DetectOptions
 * @property {number} sampleRate
 * @property {number} [count=5] Chirps in the sequence.
 * @property {number} [gapSamples] Spacing between chirp onsets (default 0.3 s).
 * @property {number} [expectedStart=0] Index in the recording where playback of the first chirp was scheduled.
 * @property {number} [minRatio=3] Below this peak ratio the result is `too_noisy` (or `not_found` if < 1.6).
 * @property {number} [spacingTolerance] Allowed error in chirp spacing, samples (default 0.5 ms, min 2).
 */

/**
 * Finds the chirp train in a recording and returns its delay.
 * Correlates with one chirp, takes the strongest peak, then requires the other chirps at exact multiples of the
 * gap (± tolerance). Inconsistent spacing → `not_found`; weak peaks vs. background → `too_noisy`; silence →
 * `too_quiet`.
 * @param {Float32Array} recording
 * @param {Float32Array} chirp
 * @param {DetectOptions} opts
 * @returns {DetectResult}
 */
export function detectDelay(recording, chirp, opts) {
  const { sampleRate } = opts;
  const count = opts.count ?? DEFAULTS.count;
  const gap = opts.gapSamples ?? Math.round(DEFAULTS.gapSec * sampleRate);
  const start = opts.expectedStart ?? 0;
  const minRatio = opts.minRatio ?? DEFAULTS.minRatio;
  const tol = opts.spacingTolerance ?? Math.max(2, Math.round(sampleRate * 0.0005));

  let peakAbs = 0;
  for (let i = 0; i < recording.length; i += 1) peakAbs = Math.max(peakAbs, Math.abs(recording[i]));
  if (peakAbs < 1e-4) return { status: 'too_quiet' };

  const c = crossCorrelate(recording, chirp);
  const env = new Float64Array(c.length);
  for (let i = 0; i < c.length; i += 1) env[i] = Math.abs(c[i]);

  const localMax = (from, to) => {
    let best = -1;
    let bestValue = -1;
    for (let i = Math.max(0, from); i <= Math.min(env.length - 1, to); i += 1) {
      if (env[i] > bestValue) {
        bestValue = env[i];
        best = i;
      }
    }
    return best;
  };

  const top = localMax(start, env.length - 1);
  if (top < 0) return { status: 'not_found' };
  let best = null;
  for (let slot = 0; slot < count; slot += 1) {
    const first = top - slot * gap;
    if (first < start) continue;
    const peaks = [];
    let complete = true;
    for (let i = 0; i < count; i += 1) {
      const expected = first + i * gap;
      if (expected + chirp.length > env.length + tol) { complete = false; break; }
      const p = localMax(expected - tol, expected + tol);
      if (p < 0) { complete = false; break; }
      peaks.push(p);
    }
    if (!complete) continue;
    const score = Math.min(...peaks.map((p) => env[p]));
    if (!best || score > best.score) best = { first, peaks, score };
  }
  if (!best) return { status: 'not_found' };

  for (let i = 1; i < best.peaks.length; i += 1) {
    if (Math.abs(best.peaks[i] - best.peaks[i - 1] - gap) > tol) return { status: 'not_found' };
  }

  const guard = chirp.length;
  let outside = 0;
  for (let i = start; i < env.length; i += 1) {
    let near = false;
    for (const p of best.peaks) {
      if (Math.abs(i - p) <= guard) { near = true; break; }
    }
    if (!near && env[i] > outside) outside = env[i];
  }
  const ratio = outside > 0 ? best.score / outside : Number.POSITIVE_INFINITY;
  const lag = best.peaks[0] - start;
  if (ratio < minRatio) {
    return { status: ratio < 1.6 ? 'not_found' : 'too_noisy', peakRatio: ratio, peaks: best.peaks };
  }
  return { status: 'ok', lagSamples: lag, delayMs: (lag / sampleRate) * 1000, peakRatio: ratio, peaks: best.peaks };
}

/**
 * Median of a list of numbers (NaN for an empty list).
 * @param {readonly number[]} values
 */
export function median(values) {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * max − min of a list of numbers (NaN for an empty list).
 * @param {readonly number[]} values
 */
export function spread(values) {
  if (values.length === 0) return Number.NaN;
  return Math.max(...values) - Math.min(...values);
}

/**
 * Deterministic Gaussian noise (xorshift32 + Box–Muller), handy for tests.
 * @param {number} length
 * @param {number} rmsLevel
 * @param {number} [seed=1]
 * @returns {Float32Array}
 */
export function seededNoise(length, rmsLevel, seed = 1) {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const u = rand();
    const v = rand();
    out[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * rmsLevel;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Browser part                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------ */

// AudioWorklet that forwards mic blocks with their frame index. Loaded from a Blob URL so the library stays one file.
const WORKLET_SOURCE = `class AltCapture extends AudioWorkletProcessor {
  constructor() { super(); this.active = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.active = false; }; }
  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    if (input && input[0] && input[0].length) this.port.postMessage({ frame: currentFrame, samples: input[0].slice(0) });
    return true;
  }
}
registerProcessor('alt-capture', AltCapture);`;

const loadedContexts = new WeakSet();

async function ensureWorklet(ctx) {
  if (loadedContexts.has(ctx)) return;
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
    loadedContexts.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function stitch(chunks, from, to) {
  if (!chunks.length) return null;
  const first = Math.max(from, chunks[0].frame);
  if (to <= first) return null;
  const out = new Float32Array(to - first);
  for (const c of chunks) {
    for (let i = 0; i < c.samples.length; i += 1) {
      const f = c.frame + i;
      if (f >= first && f < to) out[f - first] = c.samples[i];
    }
  }
  return { startFrame: first, samples: out };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(cond, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) resolve(true);
      else if (Date.now() - t0 > timeoutMs) resolve(false);
      else setTimeout(tick, 30);
    };
    tick();
  });
}

/**
 * @typedef {object} MeasureOptions
 * @property {number} [runs=5] Successful runs wanted.
 * @property {number} [maxFailures=3] Stop after this many failed runs.
 * @property {AudioContext} [audioContext] Reuse an existing context (must be resumed by a user gesture).
 * @property {MediaStream} [stream] Reuse a microphone stream; otherwise one is requested with processing off.
 * @property {number} [volume=0.9] Output gain 0…1.
 * @property {(p: { run: number, runs: number, result: DetectResult }) => void} [onProgress]
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} MeasureResult
 * @property {number} medianMs Median round-trip latency of the successful runs.
 * @property {number[]} runsMs Every successful run, ms.
 * @property {number} spreadMs max − min of the runs.
 * @property {number} sampleRate
 * @property {number | undefined} baseLatencyMs Browser-reported AudioContext.baseLatency.
 * @property {number | undefined} outputLatencyMs Browser-reported AudioContext.outputLatency.
 * @property {DetectStatus[]} failures Statuses of failed runs.
 */

/**
 * Measures speaker → microphone round-trip latency. Call it from a click handler (autoplay policy).
 * Rejects with an Error whose `code` is one of 'insecure', 'unsupported', 'not_enough_runs', 'aborted', or with the
 * DOMException from getUserMedia (e.g. NotAllowedError).
 * @param {MeasureOptions} [options]
 * @returns {Promise<MeasureResult>}
 */
export async function measureRoundTrip(options = {}) {
  const runs = options.runs ?? 5;
  const maxFailures = options.maxFailures ?? 3;
  const fail = (code, message) => Object.assign(new Error(message), { code });

  if (typeof window === 'undefined' || !window.isSecureContext) throw fail('insecure', 'Needs a secure context (https or localhost).');
  if (!navigator.mediaDevices?.getUserMedia) throw fail('unsupported', 'getUserMedia is not available.');
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) throw fail('unsupported', 'Web Audio is not available.');

  const ownCtx = !options.audioContext;
  const ctx = options.audioContext ?? new Ctor({ latencyHint: 'interactive' });
  if (ctx.state !== 'running') await ctx.resume();
  if (!ctx.audioWorklet) throw fail('unsupported', 'AudioWorklet is not available.');
  await ensureWorklet(ctx);

  const ownStream = !options.stream;
  const stream =
    options.stream ??
    (await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    }));

  const out = ctx.createGain();
  out.gain.value = options.volume ?? 0.9;
  out.connect(ctx.destination);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'alt-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink).connect(ctx.destination);

  const chunks = [];
  node.port.onmessage = (e) => chunks.push(e.data);

  const sr = ctx.sampleRate;
  const seq = makeSequence({ sampleRate: sr });
  const buffer = ctx.createBuffer(1, seq.signal.length, sr);
  buffer.copyToChannel(seq.signal, 0);
  const leadSec = 0.3;
  const captureSec = leadSec + seq.signal.length / sr + 0.9;

  const delays = [];
  const failures = [];
  try {
    for (let run = 0; delays.length < runs && failures.length < maxFailures; run += 1) {
      if (options.signal?.aborted) throw fail('aborted', 'Measurement aborted.');
      chunks.length = 0;
      const t0Frame = Math.round((ctx.currentTime + leadSec) * sr);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(out);
      src.start(t0Frame / sr);
      const endFrame = t0Frame + Math.round((captureSec - leadSec) * sr);
      await waitFor(() => chunks.length > 0 && chunks[chunks.length - 1].frame >= endFrame, (captureSec + 2) * 1000);
      src.disconnect();
      const rec = stitch(chunks, t0Frame - Math.round(0.05 * sr), endFrame);
      const result = rec
        ? detectDelay(rec.samples, seq.chirp, { sampleRate: sr, expectedStart: t0Frame - rec.startFrame, gapSamples: seq.gapSamples })
        : { status: 'not_found' };
      if (result.status === 'ok') delays.push(result.delayMs);
      else failures.push(result.status);
      options.onProgress?.({ run: run + 1, runs, result });
      await sleep(250);
    }
  } finally {
    node.port.postMessage('stop');
    node.port.onmessage = null;
    for (const n of [source, node, sink, out]) {
      try { n.disconnect(); } catch { /* already disconnected */ }
    }
    if (ownStream) stream.getTracks().forEach((t) => t.stop());
    if (ownCtx) ctx.close().catch(() => undefined);
  }

  if (delays.length < Math.min(3, runs)) {
    throw Object.assign(fail('not_enough_runs', 'Could not detect the test chirps reliably.'), { failures });
  }
  const ms = (v) => (typeof v === 'number' && v > 0 ? v * 1000 : undefined);
  return {
    medianMs: median(delays),
    runsMs: delays,
    spreadMs: spread(delays),
    sampleRate: sr,
    baseLatencyMs: ms(ctx.baseLatency),
    outputLatencyMs: ms(ctx.outputLatency),
    failures,
  };
}
