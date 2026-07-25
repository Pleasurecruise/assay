import { describe, expect, test } from "vitest";
import {
  computeCscvPbo,
  computeOverfitStatistics,
  deflatedSharpeRatio,
  effectiveTrials,
  expectedMaxSharpe,
  minTrackRecordLength,
  normalCdf,
  normalInv,
  probabilisticSharpeRatio,
} from "../src/pbo";

/** Deterministic LCG so tests never touch Math.random. */
function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Approximately standard-normal deterministic noise via Box–Muller. */
function createNoise(seed: number): () => number {
  const uniform = createLcg(seed);
  return () => {
    const u = Math.max(uniform(), 1e-12);
    const v = uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

function noiseMatrix(variants: number, days: number, seed: number): number[][] {
  const matrix: number[][] = [];
  for (let variant = 0; variant < variants; variant += 1) {
    const noise = createNoise(seed + variant * 7919);
    const series: number[] = [];
    for (let day = 0; day < days; day += 1) {
      series.push(noise() * 0.01);
    }
    matrix.push(series);
  }
  return matrix;
}

describe("normal distribution helpers", () => {
  test("normalInv matches known quantiles", () => {
    expect(normalInv(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalInv(0.5)).toBeCloseTo(0, 9);
    expect(normalInv(0.05)).toBeCloseTo(-1.644854, 5);
  });

  test("normalCdf inverts normalInv", () => {
    for (const probability of [0.01, 0.2, 0.5, 0.9, 0.995]) {
      expect(normalCdf(normalInv(probability))).toBeCloseTo(probability, 6);
    }
  });

  test("normalInv rejects probabilities outside (0, 1)", () => {
    expect(() => normalInv(0)).toThrow();
    expect(() => normalInv(1)).toThrow();
  });
});

describe("probabilisticSharpeRatio", () => {
  test("reduces to Phi(SR * sqrt(T - 1)) under normal moments", () => {
    const observedSharpe = 0.06;
    const sampleLength = 756;
    const expected = normalCdf(
      (observedSharpe * Math.sqrt(sampleLength - 1)) /
        Math.sqrt(1 + 0.5 * observedSharpe * observedSharpe),
    );
    expect(probabilisticSharpeRatio({ observedSharpe, sampleLength })).toBeCloseTo(expected, 12);
  });

  test("equals one half when the observed Sharpe equals the benchmark", () => {
    expect(
      probabilisticSharpeRatio({
        observedSharpe: 0.05,
        benchmarkSharpe: 0.05,
        sampleLength: 500,
      }),
      // The erf approximation guarantees |error| < 1.5e-7, so assert to that
      // precision rather than machine precision.
    ).toBeCloseTo(0.5, 6);
  });

  test("negative skew lowers the PSR for a positive Sharpe", () => {
    const base = probabilisticSharpeRatio({ observedSharpe: 0.08, sampleLength: 504 });
    const skewed = probabilisticSharpeRatio({
      observedSharpe: 0.08,
      sampleLength: 504,
      skewness: -1,
      kurtosis: 6,
    });
    expect(skewed).toBeLessThan(base);
  });
});

describe("expectedMaxSharpe and deflatedSharpeRatio", () => {
  test("SR0 grows with the number of trials", () => {
    const few = expectedMaxSharpe({ trials: 5, trialSharpeVariance: 0.01 });
    const many = expectedMaxSharpe({ trials: 100, trialSharpeVariance: 0.01 });
    expect(few).toBeGreaterThan(0);
    expect(many).toBeGreaterThan(few);
  });

  test("DSR equals one half when the observed Sharpe equals SR0", () => {
    const trialSharpeVariance = 0.0004;
    const trials = 14;
    const sr0 = expectedMaxSharpe({ trials, trialSharpeVariance });
    const result = deflatedSharpeRatio({
      observedSharpe: sr0,
      trials,
      trialSharpeVariance,
      sampleLength: 756,
    });
    expect(result.expectedMaxSharpe).toBeCloseTo(sr0, 12);
    expect(result.deflatedSharpeRatio).toBeCloseTo(0.5, 6);
  });

  test("more trials deflate the same observed Sharpe", () => {
    const base = {
      observedSharpe: 0.07,
      trialSharpeVariance: 0.0009,
      sampleLength: 756,
    };
    const few = deflatedSharpeRatio({ ...base, trials: 4 });
    const many = deflatedSharpeRatio({ ...base, trials: 64 });
    expect(many.deflatedSharpeRatio).toBeLessThan(few.deflatedSharpeRatio);
  });
});

describe("minTrackRecordLength", () => {
  test("is infinite when the observed Sharpe does not beat the benchmark", () => {
    expect(minTrackRecordLength({ observedSharpe: 0.01, benchmarkSharpe: 0.02 })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test("the returned length reaches the requested confidence", () => {
    const observedSharpe = 0.05;
    const confidence = 0.95;
    const length = Math.ceil(minTrackRecordLength({ observedSharpe, confidence }));
    const psrAtLength = probabilisticSharpeRatio({
      observedSharpe,
      sampleLength: length,
    });
    expect(psrAtLength).toBeGreaterThanOrEqual(confidence - 1e-3);
  });

  test("higher confidence demands a longer track record", () => {
    const at90 = minTrackRecordLength({ observedSharpe: 0.05, confidence: 0.9 });
    const at99 = minTrackRecordLength({ observedSharpe: 0.05, confidence: 0.99 });
    expect(at99).toBeGreaterThan(at90);
  });
});

describe("effectiveTrials", () => {
  test("interpolates between full independence and a single trial", () => {
    expect(effectiveTrials({ trials: 15, averageCorrelation: 0 })).toBe(15);
    expect(effectiveTrials({ trials: 15, averageCorrelation: 0.999999 })).toBeCloseTo(1, 4);
    expect(effectiveTrials({ trials: 15, averageCorrelation: 0.5 })).toBeCloseTo(8, 9);
  });
});

describe("computeCscvPbo", () => {
  test("pure selection noise yields a PBO near one half", () => {
    const matrix = noiseMatrix(12, 512, 20260725);
    const result = computeCscvPbo(matrix, { blocks: 16 });
    expect(result.combinationsEvaluated).toBe(12870);
    expect(result.blockLength).toBe(32);
    expect(result.pbo).toBeGreaterThan(0.25);
    expect(result.pbo).toBeLessThan(0.75);
  });

  test("one genuinely dominant variant yields a low PBO", () => {
    const matrix = noiseMatrix(12, 512, 42);
    const dominant = matrix[0] as number[];
    for (let day = 0; day < dominant.length; day += 1) {
      dominant[day] = (dominant[day] as number) + 0.006;
    }
    const result = computeCscvPbo(matrix, { blocks: 16 });
    expect(result.pbo).toBeLessThan(0.1);
  });

  test("thinning caps the evaluated combinations deterministically", () => {
    const matrix = noiseMatrix(6, 256, 7);
    const capped = computeCscvPbo(matrix, { blocks: 16, maxCombinations: 500 });
    expect(capped.combinationsEvaluated).toBeLessThanOrEqual(500);
    expect(capped.combinationsEvaluated).toBeGreaterThan(400);
  });

  test("is deterministic for identical inputs", () => {
    const matrix = noiseMatrix(8, 320, 99);
    const first = computeCscvPbo(matrix, { blocks: 8 });
    const second = computeCscvPbo(matrix, { blocks: 8 });
    expect(second).toEqual(first);
  });

  test("rejects ragged matrices, odd block counts, and tiny samples", () => {
    expect(() => computeCscvPbo([[0.01, 0.02], [0.01]])).toThrow();
    expect(() => computeCscvPbo(noiseMatrix(4, 256, 1), { blocks: 15 })).toThrow();
    expect(() => computeCscvPbo(noiseMatrix(4, 16, 1), { blocks: 16 })).toThrow();
    expect(() => computeCscvPbo([noiseMatrix(1, 64, 1)[0] as number[]])).toThrow();
  });
});

describe("computeOverfitStatistics", () => {
  test("produces bounded, deterministic statistics for a healthy matrix", () => {
    const matrix = noiseMatrix(15, 512, 1234);
    const baseline = matrix[7] as number[];
    for (let day = 0; day < baseline.length; day += 1) {
      baseline[day] = (baseline[day] as number) + 0.004;
    }
    const first = computeOverfitStatistics(matrix, 7);
    const second = computeOverfitStatistics(matrix, 7);
    expect(first).not.toBeNull();
    if (first === null) {
      throw new Error("expected overfit statistics");
    }
    expect(second).toEqual(first);
    expect(first.pbo).toBeGreaterThanOrEqual(0);
    expect(first.pbo).toBeLessThanOrEqual(1);
    expect(first.deflatedSharpeRatio).toBeGreaterThanOrEqual(0);
    expect(first.deflatedSharpeRatio).toBeLessThanOrEqual(1);
    expect(first.dailyBaselineSharpe).toBeGreaterThan(0);
    expect(first.effectiveTrials).toBeGreaterThanOrEqual(2);
    expect(first.sampleLength).toBe(512);
    expect(first.minTrackRecordDays === null || first.minTrackRecordDays > 0).toBe(true);
  });

  test("returns null instead of throwing on degenerate inputs", () => {
    const constant = Array.from({ length: 64 }, () => 0.001);
    const matrix = [constant, [...constant]];
    expect(computeOverfitStatistics(matrix, 0)).toBeNull();
    expect(computeOverfitStatistics(noiseMatrix(4, 8, 5), 0)).toBeNull();
    expect(computeOverfitStatistics(noiseMatrix(4, 256, 5), 99)).toBeNull();
  });
});
