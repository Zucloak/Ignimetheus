import {
  computeThermoTelemetry,
  MATERIALS,
  type NasaPsiExperiment,
  type SimulationParams,
} from './thermoCore';
import { ms2ToG } from './units';

export const NASA_COMPARISON_CYCLE_IDS = [
  'SAFFIRE-I-01',
  'SAFFIRE-II-05',
  'SAFFIRE-II-06',
  'SAFFIRE-III-01',
  'SAFFIRE-II-07',
  'SAFFIRE-II-01',
] as const;

export const NASA_COMPARISON_HEADLINE =
  "Same conditions as NASA's Saffire flight run. How close is the model?";

export const NASA_COMPARISON_FOOTNOTE =
  "Reference values from NASA's published summary, not raw PSI data. Spread rate is fitted on the 20 cm/s runs. Concurrent spread depends on duct size, which the model only partly captures.";

export const NASA_PUBLISHED_SOURCE_LINE = 'Urban et al. 2017, Table 1 (published summary)';

export type ExperimentComparisonRole =
  | 'Fitted (not a test)'
  | 'Held-out'
  | 'Extinction check (calibration-informed)'
  | 'Adapted Reference (unverified)';

export interface ExperimentComparisonResult {
  experiment: NasaPsiExperiment;
  role: ExperimentComparisonRole;
  isExtinctionCheck: boolean;
  conditionSummary: string;
  sourceLine: string;
  nasaSpreadMmS: number;
  nasaSpreadText: string;
  modelSpreadMmS: number;
  modelSpreadText: string;
  signedErrorPct: number | null;
  signedErrorText: string | null;
  ratioText: string | null;
  nasaOutcomeText: string;
  modelOutcomeText: string;
}

export function getParamsForExperiment(exp: NasaPsiExperiment): SimulationParams {
  return {
    o2Percent: exp.o2Percent,
    pressurePa: exp.pressurePa,
    flowVelocityMs: exp.flowVelocityMs,
    gravityMs2: exp.gravityMs2,
    materialId: exp.materialId,
    flowMode: exp.flowMode,
    specimenGeometry:
      exp.program === 'Saffire-II' ? 'sheet' : exp.program === 'FLEX' ? 'droplet' : 'rod',
    ductScale: exp.id.startsWith('SAFFIRE-') ? 'saffire-40cm' : 'msg-12cm',
  };
}

export function isEligibleForModelComparison(exp: NasaPsiExperiment): boolean {
  return (
    exp.scopeStatus !== 'out_of_scope' &&
    exp.observedSpreadRateMmS !== null &&
    Number.isFinite(exp.observedSpreadRateMmS) &&
    (exp.program === 'Saffire-II' || exp.id === 'BASS-II-14')
  );
}

export function isSaffireCycleRecord(exp: NasaPsiExperiment): boolean {
  return (NASA_COMPARISON_CYCLE_IDS as readonly string[]).includes(exp.id);
}

export function getExperimentComparisonRole(exp: NasaPsiExperiment): ExperimentComparisonRole {
  if (exp.program === 'Saffire-II' && exp.verificationStatus === 'verified_ntrs_20180005168') {
    if (exp.observedSpreadRateMmS === 0) return 'Extinction check (calibration-informed)';
    return Math.abs(exp.flowVelocityMs - 0.2) < 0.001 ? 'Fitted (not a test)' : 'Held-out';
  }
  return 'Adapted Reference (unverified)';
}

export function computeExperimentComparison(exp: NasaPsiExperiment): ExperimentComparisonResult | null {
  if (!isEligibleForModelComparison(exp)) return null;

  const role = getExperimentComparisonRole(exp);
  const isExtinctionCheck = role === 'Extinction check (calibration-informed)';
  const steady = computeThermoTelemetry(getParamsForExperiment(exp));
  const modelSpreadMmS = steady.flameSpreadRateMs * 1000;
  const nasaSpreadMmS = exp.observedSpreadRateMmS ?? 0;
  const nasaSpreadText = `${nasaSpreadMmS.toFixed(2)} mm/s`;
  const modelSpreadText = `${modelSpreadMmS.toFixed(3)} mm/s`;
  const gRatio = ms2ToG(exp.gravityMs2);
  const showError = !isExtinctionCheck && role !== 'Adapted Reference (unverified)' && nasaSpreadMmS > 0;
  const signedErrorPct = showError ? ((modelSpreadMmS - nasaSpreadMmS) / nasaSpreadMmS) * 100 : null;

  return {
    experiment: exp,
    role,
    isExtinctionCheck,
    conditionSummary: `${MATERIALS[exp.materialId].shortName} · ${exp.o2Percent.toFixed(1)}% O2 · ${Math.round(exp.flowVelocityMs * 100)} cm/s ${exp.flowMode} · ${gRatio < 0.01 ? '0g' : `${gRatio.toFixed(1)}g`}`,
    sourceLine:
      exp.program === 'Saffire-II'
        ? NASA_PUBLISHED_SOURCE_LINE
        : exp.id === 'BASS-II-14'
          ? 'PSI-25 (DOI 10.60555/4qc4-de67, CC0-1.0) · Value: Adapted Reference (unverified; not in NASA/TM-20210011385 or PSI-25 tables)'
          : exp.sourceCitation ?? 'NASA PSI adapted reference (pending verification)',
    nasaSpreadMmS,
    nasaSpreadText,
    modelSpreadMmS,
    modelSpreadText,
    signedErrorPct,
    signedErrorText: signedErrorPct === null ? null : `(${signedErrorPct >= 0 ? '+' : ''}${signedErrorPct.toFixed(1)}%)`,
    ratioText: showError ? `${(modelSpreadMmS / nasaSpreadMmS).toFixed(2)}x` : null,
    nasaOutcomeText: nasaSpreadMmS <= 0 ? 'NASA: no sustained spread' : `NASA: burning at ${nasaSpreadText}`,
    modelOutcomeText: steady.isBurning ? `Model: burning at ${modelSpreadText}` : 'Model: no sustained spread',
  };
}

export function getAdjacentCycleExperiment(
  currentId: string | null | undefined,
  direction: 'next' | 'prev',
  experiments: NasaPsiExperiment[],
): NasaPsiExperiment | null {
  const byId = new Map(experiments.map((e) => [e.id, e]));
  const ordered = NASA_COMPARISON_CYCLE_IDS.map((id) => byId.get(id)).filter(
    (e): e is NasaPsiExperiment => Boolean(e && isEligibleForModelComparison(e)),
  );
  const n = ordered.length;
  if (!n) return null;
  const idx = currentId ? ordered.findIndex((e) => e.id === currentId) : -1;
  if (idx < 0) return ordered[direction === 'next' ? 0 : n - 1];
  return ordered[(idx + (direction === 'next' ? 1 : n - 1)) % n];
}

export function computeHeldOutMeanAbsoluteErrorPct(experiments: NasaPsiExperiment[]) {
  const heldOut = experiments.filter(
    (e) =>
      isEligibleForModelComparison(e) &&
      getExperimentComparisonRole(e) === 'Held-out' &&
      (e.observedSpreadRateMmS ?? 0) > 0,
  );
  if (!heldOut.length) return null;

  let sum = 0;
  for (const exp of heldOut) {
    const pct = computeExperimentComparison(exp)?.signedErrorPct;
    if (pct == null || !Number.isFinite(pct)) return null;
    sum += Math.abs(pct);
  }
  const meanAbsErrorPct = sum / heldOut.length;
  if (!Number.isFinite(meanAbsErrorPct)) return null;
  const formattedPct = `${meanAbsErrorPct.toFixed(1)}%`;
  return {
    count: heldOut.length,
    meanAbsErrorPct,
    formattedPct,
    line: `Held-out runs (n = ${heldOut.length}): mean absolute error ${formattedPct}`,
  };
}
