/**
 * Backtest-overfitting statistics for the parameter-robustness check.
 *
 * Pure deterministic functions: no I/O, no randomness, no clock — the same
 * inputs always yield the same outputs, matching the audit doctrine that
 * numbers come from deterministic instruments and agents only interpret them.
 *
 * Sources:
 * - PBO / CSCV: Bailey, Borwein, López de Prado, Zhu — "The Probability of
 *   Backtest Overfitting" (SSRN 2326253).
 * - PSR / DSR / MinTRL: Bailey, López de Prado — "The Deflated Sharpe Ratio".
 *
 * Wired into the host-owned parameter-grid tool. The engine returns the
 * aligned per-variant daily-return matrix, this module computes the statistics,
 * and AgentRuntime mechanically validates their final evidence disclosure.
 */

const EULER_MASCHERONI = 0.5772156649015329;

export interface CscvOptions {
  /** Number of contiguous time blocks S (even, >= 4). Default 16. */
  readonly blocks?: number;
  /** Annualization factor applied inside per-split Sharpe. Default 252. */
  readonly annualizationFactor?: number;
  /**
   * Upper bound on evaluated IS/OOS combinations. When C(S, S/2) exceeds it,
   * combinations are thinned deterministically (every k-th in enumeration
   * order) — never sampled randomly. Default 12870 = C(16, 8), i.e. no
   * thinning at the default block count.
   */
  readonly maxCombinations?: number;
}

export interface CscvResult {
  /** Probability of backtest overfitting: share of splits with logit <= 0. */
  readonly pbo: number;
  readonly combinationsEvaluated: number;
  readonly blocks: number;
  readonly blockLength: number;
  /** Days actually used (T truncated to blocks * blockLength). */
  readonly usedSampleLength: number;
  readonly medianLogit: number;
  /**
   * OLS of the IS-champion's OOS Sharpe on its IS Sharpe across splits.
   * A negative slope means better in-sample selection predicts worse
   * out-of-sample performance — the classic overfitting signature.
   */
  readonly degradation: {
    readonly slope: number;
    readonly intercept: number;
  };
}

function assertFiniteMatrix(variantDailyReturns: ReadonlyArray<readonly number[]>): number {
  if (variantDailyReturns.length < 2) {
    throw new Error("CSCV requires at least two variants");
  }
  const sampleLength = variantDailyReturns[0]?.length ?? 0;
  for (const [index, series] of variantDailyReturns.entries()) {
    if (series.length !== sampleLength) {
      throw new Error(`CSCV variant ${String(index)} has a different sample length`);
    }
    for (const value of series) {
      if (!Number.isFinite(value)) {
        throw new Error(`CSCV variant ${String(index)} contains a non-finite return`);
      }
    }
  }
  return sampleLength;
}

function sharpeOnIndices(
  series: readonly number[],
  indices: readonly number[],
  annualizationFactor: number,
): number {
  let sum = 0;
  for (const index of indices) {
    sum += series[index] as number;
  }
  const mean = sum / indices.length;
  let squared = 0;
  for (const index of indices) {
    const deviation = (series[index] as number) - mean;
    squared += deviation * deviation;
  }
  const variance = squared / (indices.length - 1);
  if (variance <= 0) {
    return mean > 0 ? Number.POSITIVE_INFINITY : mean < 0 ? Number.NEGATIVE_INFINITY : 0;
  }
  return (mean / Math.sqrt(variance)) * Math.sqrt(annualizationFactor);
}

function enumerateCombinations(blocks: number, choose: number): number[][] {
  const combinations: number[][] = [];
  const current: number[] = [];
  const walk = (nextBlock: number): void => {
    if (current.length === choose) {
      combinations.push([...current]);
      return;
    }
    if (blocks - nextBlock < choose - current.length) {
      return;
    }
    for (let block = nextBlock; block < blocks; block += 1) {
      current.push(block);
      walk(block + 1);
      current.pop();
    }
  };
  walk(0);
  return combinations;
}

/**
 * Combinatorially symmetric cross-validation over the parameter grid's daily
 * returns. `variantDailyReturns[n][t]` is variant n's return on day t; every
 * variant must cover the same days in the same order.
 */
export function computeCscvPbo(
  variantDailyReturns: ReadonlyArray<readonly number[]>,
  options: CscvOptions = {},
): CscvResult {
  const blocks = options.blocks ?? 16;
  const annualizationFactor = options.annualizationFactor ?? 252;
  const maxCombinations = options.maxCombinations ?? 12870;
  if (!Number.isSafeInteger(blocks) || blocks < 4 || blocks % 2 !== 0) {
    throw new Error("CSCV blocks must be an even integer >= 4");
  }
  if (!Number.isFinite(annualizationFactor) || annualizationFactor <= 0) {
    throw new Error("CSCV annualizationFactor must be positive");
  }
  if (!Number.isSafeInteger(maxCombinations) || maxCombinations < 2) {
    throw new Error("CSCV maxCombinations must be an integer >= 2");
  }
  const sampleLength = assertFiniteMatrix(variantDailyReturns);
  const blockLength = Math.floor(sampleLength / blocks);
  if (blockLength < 2) {
    throw new Error("CSCV requires at least two observations per block");
  }
  const usedSampleLength = blockLength * blocks;
  const variantCount = variantDailyReturns.length;

  const blockIndices: number[][] = [];
  for (let block = 0; block < blocks; block += 1) {
    const indices: number[] = [];
    for (let offset = 0; offset < blockLength; offset += 1) {
      indices.push(block * blockLength + offset);
    }
    blockIndices.push(indices);
  }

  const allCombinations = enumerateCombinations(blocks, blocks / 2);
  const stride = Math.max(1, Math.ceil(allCombinations.length / maxCombinations));
  const logits: number[] = [];
  const championPairs: { inSample: number; outOfSample: number }[] = [];

  for (
    let combinationIndex = 0;
    combinationIndex < allCombinations.length;
    combinationIndex += stride
  ) {
    const inSampleBlocks = new Set(allCombinations[combinationIndex]);
    const inSampleIndices: number[] = [];
    const outOfSampleIndices: number[] = [];
    for (let block = 0; block < blocks; block += 1) {
      const target = inSampleBlocks.has(block) ? inSampleIndices : outOfSampleIndices;
      for (const index of blockIndices[block] as number[]) {
        target.push(index);
      }
    }

    let championVariant = 0;
    let championInSampleSharpe = Number.NEGATIVE_INFINITY;
    const outOfSampleSharpes: number[] = [];
    for (let variant = 0; variant < variantCount; variant += 1) {
      const series = variantDailyReturns[variant] as readonly number[];
      const inSampleSharpe = sharpeOnIndices(series, inSampleIndices, annualizationFactor);
      outOfSampleSharpes.push(sharpeOnIndices(series, outOfSampleIndices, annualizationFactor));
      if (inSampleSharpe > championInSampleSharpe) {
        championInSampleSharpe = inSampleSharpe;
        championVariant = variant;
      }
    }

    const championOutOfSample = outOfSampleSharpes[championVariant] as number;
    let rank = 0;
    for (const sharpe of outOfSampleSharpes) {
      if (sharpe <= championOutOfSample) {
        rank += 1;
      }
    }
    const relativeRank = rank / (variantCount + 1);
    logits.push(Math.log(relativeRank / (1 - relativeRank)));
    if (Number.isFinite(championInSampleSharpe) && Number.isFinite(championOutOfSample)) {
      championPairs.push({
        inSample: championInSampleSharpe,
        outOfSample: championOutOfSample,
      });
    }
  }

  const belowMedian = logits.filter((logit) => logit <= 0).length;
  const sortedLogits = [...logits].sort((left, right) => left - right);
  const midpoint = Math.floor(sortedLogits.length / 2);
  const medianLogit =
    sortedLogits.length % 2 === 1
      ? (sortedLogits[midpoint] as number)
      : ((sortedLogits[midpoint - 1] as number) + (sortedLogits[midpoint] as number)) / 2;

  let slope = 0;
  let intercept = 0;
  if (championPairs.length >= 2) {
    const meanX =
      championPairs.reduce((total, pair) => total + pair.inSample, 0) / championPairs.length;
    const meanY =
      championPairs.reduce((total, pair) => total + pair.outOfSample, 0) / championPairs.length;
    let covariance = 0;
    let varianceX = 0;
    for (const pair of championPairs) {
      covariance += (pair.inSample - meanX) * (pair.outOfSample - meanY);
      varianceX += (pair.inSample - meanX) ** 2;
    }
    slope = varianceX > 0 ? covariance / varianceX : 0;
    intercept = meanY - slope * meanX;
  }

  return {
    pbo: belowMedian / logits.length,
    combinationsEvaluated: logits.length,
    blocks,
    blockLength,
    usedSampleLength,
    medianLogit,
    degradation: { slope, intercept },
  };
}

/** Abramowitz–Stegun 7.1.26 erf approximation (|error| < 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absolute = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absolute);
  const polynomial =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - polynomial * Math.exp(-absolute * absolute));
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Acklam's inverse normal CDF approximation (relative error ~1.15e-9). */
export function normalInv(probability: number): number {
  if (!(probability > 0 && probability < 1)) {
    throw new Error("normalInv requires a probability strictly between 0 and 1");
  }
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lower = 0.02425;
  const upper = 1 - lower;
  if (probability < lower) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (probability > upper) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return (
      -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  const q = probability - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

export interface ProbabilisticSharpeInput {
  /** Observed Sharpe in per-period units (e.g. daily), NOT annualized. */
  readonly observedSharpe: number;
  /** Benchmark Sharpe in the same per-period units. Default 0. */
  readonly benchmarkSharpe?: number;
  /** Number of return observations T. */
  readonly sampleLength: number;
  /** Skewness of the return series. Default 0 (declare the assumption). */
  readonly skewness?: number;
  /** Raw kurtosis of the return series (normal = 3). Default 3. */
  readonly kurtosis?: number;
}

/** PSR(SR*) = Phi((SR - SR*) * sqrt(T - 1) / sqrt(1 - g3*SR + (g4-1)/4 * SR^2)). */
export function probabilisticSharpeRatio(input: ProbabilisticSharpeInput): number {
  const benchmarkSharpe = input.benchmarkSharpe ?? 0;
  const skewness = input.skewness ?? 0;
  const kurtosis = input.kurtosis ?? 3;
  if (!Number.isFinite(input.observedSharpe) || !Number.isFinite(benchmarkSharpe)) {
    throw new Error("PSR requires finite Sharpe inputs");
  }
  if (!Number.isSafeInteger(input.sampleLength) || input.sampleLength < 2) {
    throw new Error("PSR requires sampleLength >= 2");
  }
  const varianceAdjustment =
    1 -
    skewness * input.observedSharpe +
    ((kurtosis - 1) / 4) * input.observedSharpe * input.observedSharpe;
  if (!(varianceAdjustment > 0)) {
    throw new Error("PSR variance adjustment must be positive for these moments");
  }
  return normalCdf(
    ((input.observedSharpe - benchmarkSharpe) * Math.sqrt(input.sampleLength - 1)) /
      Math.sqrt(varianceAdjustment),
  );
}

export interface ExpectedMaxSharpeInput {
  /** Number of effectively independent trials N (>= 2). */
  readonly trials: number;
  /** Cross-trial variance of the per-period Sharpe estimates. */
  readonly trialSharpeVariance: number;
}

/**
 * SR0: the Sharpe one expects from the single best of N unskilled trials —
 * the deflation benchmark of the DSR.
 */
export function expectedMaxSharpe(input: ExpectedMaxSharpeInput): number {
  if (!Number.isFinite(input.trials) || input.trials < 2) {
    throw new Error("expectedMaxSharpe requires trials >= 2");
  }
  if (!Number.isFinite(input.trialSharpeVariance) || input.trialSharpeVariance < 0) {
    throw new Error("expectedMaxSharpe requires a non-negative trial Sharpe variance");
  }
  return (
    Math.sqrt(input.trialSharpeVariance) *
    ((1 - EULER_MASCHERONI) * normalInv(1 - 1 / input.trials) +
      EULER_MASCHERONI * normalInv(1 - 1 / (input.trials * Math.E)))
  );
}

export interface DeflatedSharpeInput extends ExpectedMaxSharpeInput {
  readonly observedSharpe: number;
  readonly sampleLength: number;
  readonly skewness?: number;
  readonly kurtosis?: number;
}

export interface DeflatedSharpeResult {
  /** Deflation benchmark SR0. */
  readonly expectedMaxSharpe: number;
  /** DSR = PSR(SR0): probability the observed Sharpe beats selection luck. */
  readonly deflatedSharpeRatio: number;
}

export function deflatedSharpeRatio(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const benchmark = expectedMaxSharpe({
    trials: input.trials,
    trialSharpeVariance: input.trialSharpeVariance,
  });
  return {
    expectedMaxSharpe: benchmark,
    deflatedSharpeRatio: probabilisticSharpeRatio({
      observedSharpe: input.observedSharpe,
      benchmarkSharpe: benchmark,
      sampleLength: input.sampleLength,
      ...(input.skewness === undefined ? {} : { skewness: input.skewness }),
      ...(input.kurtosis === undefined ? {} : { kurtosis: input.kurtosis }),
    }),
  };
}

export interface MinTrackRecordLengthInput {
  /** Observed Sharpe in per-period units. */
  readonly observedSharpe: number;
  /** Benchmark Sharpe to beat, per-period units. Default 0. */
  readonly benchmarkSharpe?: number;
  readonly skewness?: number;
  readonly kurtosis?: number;
  /** Required confidence level, e.g. 0.95. */
  readonly confidence?: number;
}

/**
 * MinTRL: number of observations needed before the observed Sharpe exceeds
 * the benchmark at the requested confidence.
 */
export function minTrackRecordLength(input: MinTrackRecordLengthInput): number {
  const benchmarkSharpe = input.benchmarkSharpe ?? 0;
  const skewness = input.skewness ?? 0;
  const kurtosis = input.kurtosis ?? 3;
  const confidence = input.confidence ?? 0.95;
  if (!(confidence > 0 && confidence < 1)) {
    throw new Error("minTrackRecordLength requires confidence strictly between 0 and 1");
  }
  if (input.observedSharpe <= benchmarkSharpe) {
    return Number.POSITIVE_INFINITY;
  }
  const varianceAdjustment =
    1 -
    skewness * input.observedSharpe +
    ((kurtosis - 1) / 4) * input.observedSharpe * input.observedSharpe;
  if (!(varianceAdjustment > 0)) {
    throw new Error("minTrackRecordLength variance adjustment must be positive");
  }
  const z = normalInv(confidence);
  return 1 + varianceAdjustment * (z / (input.observedSharpe - benchmarkSharpe)) ** 2;
}

export interface EffectiveTrialsInput {
  readonly trials: number;
  /** Average pairwise correlation of trial returns, clamped to [0, 1). */
  readonly averageCorrelation: number;
}

/**
 * Heuristic effective-N for correlated grid variants: N_eff = 1 + (N-1)(1-rho).
 * Documented approximation — using raw N over-deflates highly correlated
 * neighborhoods.
 */
export function effectiveTrials(input: EffectiveTrialsInput): number {
  if (!Number.isFinite(input.trials) || input.trials < 1) {
    throw new Error("effectiveTrials requires trials >= 1");
  }
  const correlation = Math.min(Math.max(input.averageCorrelation, 0), 0.999999);
  return 1 + (input.trials - 1) * (1 - correlation);
}

/**
 * Floating-point floor under which a daily-return standard deviation is
 * treated as zero: summation residue on a constant series produces a tiny
 * nonzero variance (~1e-19) that would otherwise fabricate huge Sharpe values.
 */
const MINIMUM_MEANINGFUL_STD = 1e-12;

function seriesMoments(series: readonly number[]): {
  readonly mean: number;
  readonly standardDeviation: number;
  readonly skewness: number;
  readonly kurtosis: number;
} {
  const count = series.length;
  const mean = series.reduce((total, value) => total + value, 0) / count;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const value of series) {
    const deviation = value - mean;
    m2 += deviation ** 2;
    m3 += deviation ** 3;
    m4 += deviation ** 4;
  }
  m2 /= count;
  m3 /= count;
  m4 /= count;
  const standardDeviation = Math.sqrt((m2 * count) / (count - 1));
  return {
    mean,
    standardDeviation,
    skewness: m2 > 0 ? m3 / m2 ** 1.5 : 0,
    kurtosis: m2 > 0 ? m4 / (m2 * m2) : 3,
  };
}

function pearsonCorrelation(left: readonly number[], right: readonly number[]): number {
  const count = left.length;
  const meanLeft = left.reduce((total, value) => total + value, 0) / count;
  const meanRight = right.reduce((total, value) => total + value, 0) / count;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let index = 0; index < count; index += 1) {
    const deviationLeft = (left[index] as number) - meanLeft;
    const deviationRight = (right[index] as number) - meanRight;
    covariance += deviationLeft * deviationRight;
    varianceLeft += deviationLeft ** 2;
    varianceRight += deviationRight ** 2;
  }
  const denominator = Math.sqrt(varianceLeft * varianceRight);
  return denominator > 0 ? covariance / denominator : 0;
}

/**
 * Backtest-overfitting summary computed from the grid daily-return matrix.
 * All Sharpe quantities are per-day (unannualized) as the PSR/DSR formulas
 * require; `null` fields mean "not defined for these inputs", never an error.
 */
export interface OverfitStatistics {
  readonly pbo: number;
  readonly combinationsEvaluated: number;
  readonly degradationSlope: number;
  readonly dailyBaselineSharpe: number;
  readonly sampleLength: number;
  readonly effectiveTrials: number;
  readonly expectedMaxSharpeDaily: number;
  readonly deflatedSharpeRatio: number;
  readonly minTrackRecordDays: number | null;
}

/**
 * One-call wrapper used by the grid agent view. Returns null when the matrix
 * cannot support the statistics (degenerate series, too few observations for
 * the CSCV block layout, non-positive variance adjustment). Deterministic:
 * identical matrices always produce identical output.
 */
export function computeOverfitStatistics(
  variantDailyReturns: ReadonlyArray<readonly number[]>,
  baselineVariantIndex: number,
): OverfitStatistics | null {
  try {
    const baselineSeries = variantDailyReturns[baselineVariantIndex];
    if (baselineSeries === undefined) {
      return null;
    }
    const cscv = computeCscvPbo(variantDailyReturns);
    const baselineMoments = seriesMoments(baselineSeries);
    if (baselineMoments.standardDeviation < MINIMUM_MEANINGFUL_STD) {
      return null;
    }
    const dailyBaselineSharpe = baselineMoments.mean / baselineMoments.standardDeviation;
    const dailySharpes = variantDailyReturns.map((series) => {
      const moments = seriesMoments(series);
      return moments.standardDeviation >= MINIMUM_MEANINGFUL_STD
        ? moments.mean / moments.standardDeviation
        : 0;
    });
    const meanSharpe =
      dailySharpes.reduce((total, value) => total + value, 0) / dailySharpes.length;
    const trialSharpeVariance =
      dailySharpes.reduce((total, value) => total + (value - meanSharpe) ** 2, 0) /
      Math.max(dailySharpes.length - 1, 1);
    let correlationSum = 0;
    let correlationPairs = 0;
    for (let left = 0; left < variantDailyReturns.length; left += 1) {
      for (let right = left + 1; right < variantDailyReturns.length; right += 1) {
        correlationSum += pearsonCorrelation(
          variantDailyReturns[left] as readonly number[],
          variantDailyReturns[right] as readonly number[],
        );
        correlationPairs += 1;
      }
    }
    const averageCorrelation = correlationPairs > 0 ? correlationSum / correlationPairs : 0;
    const trials = Math.max(
      2,
      effectiveTrials({
        trials: variantDailyReturns.length,
        averageCorrelation,
      }),
    );
    const sampleLength = cscv.usedSampleLength;
    const deflated = deflatedSharpeRatio({
      observedSharpe: dailyBaselineSharpe,
      trials,
      trialSharpeVariance,
      sampleLength,
      skewness: baselineMoments.skewness,
      kurtosis: baselineMoments.kurtosis,
    });
    const minTrl = minTrackRecordLength({
      observedSharpe: dailyBaselineSharpe,
      skewness: baselineMoments.skewness,
      kurtosis: baselineMoments.kurtosis,
      confidence: 0.95,
    });
    return {
      pbo: cscv.pbo,
      combinationsEvaluated: cscv.combinationsEvaluated,
      degradationSlope: cscv.degradation.slope,
      dailyBaselineSharpe,
      sampleLength,
      effectiveTrials: trials,
      expectedMaxSharpeDaily: deflated.expectedMaxSharpe,
      deflatedSharpeRatio: deflated.deflatedSharpeRatio,
      minTrackRecordDays: Number.isFinite(minTrl) ? minTrl : null,
    };
  } catch {
    return null;
  }
}
