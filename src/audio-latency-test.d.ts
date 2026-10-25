export declare const DEFAULTS: Readonly<{
  durationSec: number;
  f0: number;
  f1: number;
  count: number;
  gapSec: number;
  minRatio: number;
}>;

export interface ChirpOptions {
  sampleRate: number;
  durationSec?: number;
  f0?: number;
  f1?: number;
}

export interface SequenceOptions {
  sampleRate: number;
  count?: number;
  gapSec?: number;
  amplitude?: number;
  chirp?: Omit<ChirpOptions, 'sampleRate'>;
}

export interface Sequence {
  signal: Float32Array;
  chirp: Float32Array;
  /** Start of each chirp inside `signal`, in samples. */
  onsets: number[];
  gapSamples: number;
}

export type DetectStatus = 'ok' | 'not_found' | 'too_noisy' | 'too_quiet';

export interface DetectOptions {
  sampleRate: number;
  count?: number;
  gapSamples?: number;
  expectedStart?: number;
  minRatio?: number;
  spacingTolerance?: number;
}

export interface DetectResult {
  status: DetectStatus;
  lagSamples?: number;
  delayMs?: number;
  peakRatio?: number;
  peaks?: number[];
}

export interface MeasureOptions {
  runs?: number;
  maxFailures?: number;
  audioContext?: AudioContext;
  stream?: MediaStream;
  volume?: number;
  onProgress?: (p: { run: number; runs: number; result: DetectResult }) => void;
  signal?: AbortSignal;
}

export interface MeasureResult {
  medianMs: number;
  runsMs: number[];
  spreadMs: number;
  sampleRate: number;
  baseLatencyMs: number | undefined;
  outputLatencyMs: number | undefined;
  failures: DetectStatus[];
}

export declare function makeChirp(opts: ChirpOptions): Float32Array;
export declare function makeSequence(opts: SequenceOptions): Sequence;
export declare function fft(re: Float64Array, im: Float64Array, inverse?: boolean): void;
export declare function crossCorrelate(x: ArrayLike<number>, ref: ArrayLike<number>): Float64Array;
export declare function detectDelay(recording: Float32Array, chirp: Float32Array, opts: DetectOptions): DetectResult;
export declare function median(values: readonly number[]): number;
export declare function spread(values: readonly number[]): number;
export declare function seededNoise(length: number, rmsLevel: number, seed?: number): Float32Array;
export declare function measureRoundTrip(options?: MeasureOptions): Promise<MeasureResult>;
