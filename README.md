# audio-latency-test

Measure **speaker → microphone round-trip audio latency** in the browser. The page plays five short chirps, records them back through the microphone, finds them by cross-correlation and reports the median delay over several runs.

- Zero dependencies, one ES module (`src/audio-latency-test.js`) with TypeScript declarations.
- The DSP part (chirp generator, FFT, cross-correlation, peak detection) is pure JavaScript and runs in Node, so it is unit-tested with synthetic signals.
- Audio never leaves the page; the microphone is released when the measurement ends.

**Live demo:** https://teasoup90.github.io/audio-latency-test/

If you just want to check a device without writing code, there is also a full browser-based [audio latency test](https://audiodelaytest.com/audio-latency-test/?utm_source=github&utm_medium=readme&utm_campaign=audio-latency-test) built on the same method.

## Install

Not published to npm. Copy `src/audio-latency-test.js` (and optionally `src/audio-latency-test.d.ts`) into your project, or import it straight from the demo site:

```js
import { measureRoundTrip } from 'https://teasoup90.github.io/audio-latency-test/src/audio-latency-test.js';
```

## Usage

### In the browser

Call it from a user gesture (autoplay rules), over https or on localhost:

```js
import { measureRoundTrip } from './audio-latency-test.js';

button.addEventListener('click', async () => {
  try {
    const r = await measureRoundTrip({
      runs: 5,
      onProgress: ({ run, result }) => console.log(`run ${run}:`, result.status, result.delayMs),
    });
    console.log(`Round trip: ${r.medianMs.toFixed(1)} ms (spread ${r.spreadMs.toFixed(1)} ms)`, r.runsMs);
  } catch (err) {
    // err.name === 'NotAllowedError' → microphone permission denied
    // err.code is 'insecure' | 'unsupported' | 'not_enough_runs' | 'aborted'
    console.error(err);
  }
});
```

`measureRoundTrip(options)` options:

| Option | Default | Meaning |
|---|---|---|
| `runs` | `5` | Successful runs to collect |
| `maxFailures` | `3` | Give up after this many failed runs |
| `audioContext` | new context | Reuse your own (already resumed) `AudioContext` |
| `stream` | new mic stream | Reuse a `MediaStream`; by default one is requested with echo cancellation, noise suppression and auto gain **off** |
| `volume` | `0.9` | Output gain |
| `onProgress` | — | Called after every run with `{ run, runs, result }` |
| `signal` | — | `AbortSignal` to stop between runs |

It resolves to `{ medianMs, runsMs, spreadMs, sampleRate, baseLatencyMs, outputLatencyMs, failures }`. `baseLatencyMs` / `outputLatencyMs` are what the browser reports about itself (may be `undefined`); they are shown for comparison, not used in the result.

### The pure functions (Node or browser)

```js
import { makeSequence, detectDelay } from './audio-latency-test.js';

const sampleRate = 48000;
const seq = makeSequence({ sampleRate });          // 5 chirps, 0.3 s apart
// ...play seq.signal, record the input into `recording`...
const r = detectDelay(recording, seq.chirp, {
  sampleRate,
  gapSamples: seq.gapSamples,
  expectedStart: 0,                                 // index where playback started in `recording`
});
// r.status: 'ok' | 'not_found' | 'too_noisy' | 'too_quiet'
// r.delayMs, r.lagSamples, r.peakRatio
```

Also exported: `makeChirp`, `fft`, `crossCorrelate`, `median`, `spread`, `seededNoise`, `DEFAULTS`.

## How it works

1. **Test signal.** Each chirp is a 20 ms linear sweep from 1 kHz to 8 kHz with a Hann window. A sweep has a very narrow autocorrelation, so its position can be found to within a sample, and the window avoids clicks. Five chirps are played 0.3 s apart.
2. **Capture.** An `AudioWorklet` copies microphone blocks to the main thread together with `currentFrame`, the audio-clock frame index. Playback is scheduled on the same clock, so the recording and the playback share one timeline and no `setTimeout` jitter enters the result.
3. **Cross-correlation.** The recording is correlated with a single chirp using an FFT (`X · conj(R)`, inverse FFT), only at non-negative lags because sound cannot arrive before it is played.
4. **Validation.** The strongest peak is taken, then the other four chirps must appear at exact multiples of the 0.3 s spacing (±0.5 ms). If they don't, the run is `not_found`. The weakest matched peak must be at least 3× stronger than anything else in the correlation, otherwise the run is `too_noisy`. Near-silent input is `too_quiet`.
5. **Result.** The lag of the first peak is the round-trip delay of that run. Several runs are collected and the median is reported, with max − min as a simple repeatability figure.

What you measure is output latency + input latency + the time sound needs to travel through the air (about 2.9 ms per metre). It is not the one-way delay you would notice when watching a video.

## Browser limitations

- **Secure context and a user gesture are required:** `getUserMedia` only works over https or on localhost, and the `AudioContext` must be started from a click/tap.
- **Microphone permission:** the user has to allow it. Denial rejects with a `NotAllowedError`.
- **Audio processing:** the library asks for `echoCancellation`, `noiseSuppression` and `autoGainControl` to be off. Some browsers or devices ignore this; echo cancellation in particular can remove the chirps (→ `not_found`). Headsets that route sound away from the mic will also fail.
- **AudioWorklet** is needed (all current Chrome, Edge, Firefox and Safari versions have it).
- **iOS / Safari:** the ringer switch and low volume can mute Web Audio output; Safari may resample, which is handled because everything uses `AudioContext.sampleRate`.
- **Bluetooth:** a Bluetooth headset with a microphone usually switches to a low-quality hands-free profile while the mic is open, so the number does not represent music/video playback latency.
- `baseLatency` and `outputLatency` are not reported by every browser.

## Tests

```sh
node --test test/
```

The tests build synthetic recordings with known delays (clean, with noise, at 44.1 and 48 kHz) and check that the detector finds them to within a sample, and that silence, noise and a lone chirp are rejected.

## License

[MIT](LICENSE) © 2026 teasoup
