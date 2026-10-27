/** Agreement and ranking statistics used to judge the judge. */

export const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;

export const sd = (xs: readonly number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/** Average ranks (ties share the mean rank). */
function ranks(xs: readonly number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = r;
    i = j + 1;
  }
  return out;
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    dx += (x[i]! - mx) ** 2;
    dy += (y[i]! - my) ** 2;
  }
  return dx === 0 || dy === 0 ? Number.NaN : num / Math.sqrt(dx * dy);
}

export const spearman = (x: readonly number[], y: readonly number[]) => pearson(ranks(x), ranks(y));

/** Cohen's kappa for two boolean raters. NaN when there is no variation to agree about. */
export function cohenKappa(a: readonly boolean[], b: readonly boolean[]): number {
  const n = a.length;
  if (n === 0) return Number.NaN;
  let agree = 0;
  let aTrue = 0;
  let bTrue = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    if (a[i]) aTrue++;
    if (b[i]) bTrue++;
  }
  const po = agree / n;
  const pe = (aTrue / n) * (bTrue / n) + (1 - aTrue / n) * (1 - bTrue / n);
  return pe === 1 ? Number.NaN : (po - pe) / (1 - pe);
}

/** Quadratic-weighted kappa for ordinal labels on a 1..levels scale (inputs are rounded). */
export function weightedKappa(a: readonly number[], b: readonly number[], levels = 5): number {
  const n = a.length;
  if (n === 0) return Number.NaN;
  const clampLevel = (v: number) => Math.min(levels, Math.max(1, Math.round(v))) - 1;
  const obs = Array.from({ length: levels }, () => new Array<number>(levels).fill(0));
  const ha = new Array<number>(levels).fill(0);
  const hb = new Array<number>(levels).fill(0);
  for (let i = 0; i < n; i++) {
    const x = clampLevel(a[i]!);
    const y = clampLevel(b[i]!);
    obs[x]![y]!++;
    ha[x]!++;
    hb[y]!++;
  }
  let num = 0;
  let den = 0;
  for (let i = 0; i < levels; i++) {
    for (let j = 0; j < levels; j++) {
      const w = (i - j) ** 2 / (levels - 1) ** 2;
      num += w * (obs[i]![j]! / n);
      den += w * ((ha[i]! / n) * (hb[j]! / n));
    }
  }
  return den === 0 ? Number.NaN : 1 - num / den;
}

/** Probability a random "good" item outranks a random "bad" one (ties count half). 1 = perfect separation. */
export function auc(good: readonly number[], bad: readonly number[]): number {
  if (!good.length || !bad.length) return Number.NaN;
  let wins = 0;
  for (const g of good) for (const b of bad) wins += g > b ? 1 : g === b ? 0.5 : 0;
  return wins / (good.length * bad.length);
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
}

export function confusion(predicted: readonly boolean[], actual: readonly boolean[]): Confusion {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < predicted.length; i++) {
    if (predicted[i] && actual[i]) tp++;
    else if (predicted[i]) fp++;
    else if (actual[i]) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn, precision: tp / (tp + fp), recall: tp / (tp + fn) };
}

/** Wilson score interval for a proportion k/n (default 95%). Sound for small n and for 0% / 100%. */
export function wilson(k: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: Number.NaN, lo: Number.NaN, hi: Number.NaN };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}
