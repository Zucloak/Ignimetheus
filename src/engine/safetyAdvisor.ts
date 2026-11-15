import experimentsJson from '../data/nasaPsiExperiments.json';
import {
  ABOUT_EXAMPLE_QUESTIONS,
  GLOSSARY_FALLBACK,
  lookupGlossaryTerm,
} from '../data/glossary';
import {
  AMBIENT_CHAMBER_TEMP_K,
  canSustainCombustion,
  computeThermoTelemetry,
  DA_CRIT,
  dischargeNitrogen,
  FLAME_ARRESTOR_X_MM,
  IGNITER_JOULE_POWER_W,
  IGNITION_PULSE_DURATION_S,
  INERT_NOZZLE_X_MM,
  MATERIALS,
  matchClosestExperiment,
  N2_DISCHARGE_DURATION_S,
  N2_O2_DROP_PERCENT,
  NASA_STD_BURN_LIMIT_MM,
  resetChamberToStandby,
  resolveDuctHardware,
  resolveSpecimenGeometry,
  SPECIMEN_GEOMETRIES,
  SPECIMEN_LENGTH_MM,
  WAKE_BAFFLE_X_MM,
  type MatchedExperimentResult,
  type NasaPsiExperiment,
  type SimulationParams,
  type ThermoTelemetry,
} from './thermoCore';
import {
  computeExperimentComparison,
  computeHeldOutMeanAbsoluteErrorPct,
  NASA_COMPARISON_CYCLE_IDS,
  NASA_COMPARISON_FOOTNOTE,
} from './nasaComparison';
import {
  DUCT_LENGTH_MM,
  measureCaliperMm,
  sampleDuctFieldAtMm,
  THERMOCOUPLE_ARRAY_SPECS,
  type CadMarker,
} from './ductProbes';
import {
  cmsToMs,
  formatHeatFlux,
  formatLength,
  formatPressure,
  formatSpreadRate,
  formatTemperature,
  formatVelocity,
  fpmToMs,
  gToMs2,
  kelvinToCelsius,
  kelvinToFahrenheit,
  MS_PER_IN_MIN,
  msToCms,
  msToFpm,
  paToAtm,
  paToKpa,
  paToPsi,
  STANDARD_GRAVITY_MS2,
  wm2ToBtuHrFt2,
  wm2ToWcm2,
  type UnitSystem,
} from './units';

const NASA_PSI_EXPERIMENTS = experimentsJson as NasaPsiExperiment[];
const EXP_BY_ID: Record<string, NasaPsiExperiment> = Object.fromEntries(
  NASA_PSI_EXPERIMENTS.map((exp) => [exp.id, exp]),
);

export type SafetyIntent =
  | 'INJECTION'
  | 'AUTHORITY'
  | 'OUT_OF_SCOPE'
  | 'SMALLTALK'
  | 'ABOUT'
  | 'GLOSSARY'
  | 'VALUES'
  | 'WHAT_IF'
  | 'COMPARE_0G_1G'
  | 'EXPLAIN'
  | 'UNKNOWN';

export type SafetyResponseBadge =
  | 'Deterministic'
  | 'Local model (figures checked)'
  | 'Not modeled'
  | 'Info';

export interface AdvisorDebugCounters {
  auditPass: number;
  auditReject: number;
  authorityReject: number;
  truncationFallback: number;
  llmCalls: number;
}

export function createEmptyDebugCounters(): AdvisorDebugCounters {
  return {
    auditPass: 0,
    auditReject: 0,
    authorityReject: 0,
    truncationFallback: 0,
    llmCalls: 0,
  };
}

export interface TemplateClaimProvenance {
  id: string;
  claim: string;
  source: string;
}

/**
 * Audit registry mapping every template claim to its solver field, dataset ID, or model assumption.
 */
export const TEMPLATE_CLAIM_REGISTRY: TemplateClaimProvenance[] = [
  {
    id: 'buoyant_velocity',
    claim: 'Induced buoyant flow speed in 0g vs 1g',
    source: 'solver: telemetry.buoyantVelocityMs',
  },
  {
    id: 'blowoff_threshold',
    claim: 'Convective blow-off threshold (38.0 cm/s nominal, 48.0 cm/s with Wake Baffle IN)',
    source: 'model assumption (thermoCore.ts blowoff threshold)',
  },
  {
    id: 'flame_arrestor_o2_threshold',
    claim: 'Passive flame arrestor mesh (>32.0% O2 threshold, clamps burn <= 280 mm)',
    source: 'model assumption (thermoCore.ts)',
  },
  {
    id: 'wake_baffle_factor',
    claim: 'Wake baffle 0.72x root flow velocity factor at 95 mm',
    source: 'model assumption (thermoCore.ts)',
  },
  {
    id: 'n2_purge_delta',
    claim: 'N2 nozzle pulse (-8.0% O2 for 5.0 s at 160 mm)',
    source: 'model assumption (thermoCore.ts)',
  },
  {
    id: 'igniter_pulse',
    claim: 'Hot-wire Joule ignition pulse (80 W for 3.5 s)',
    source: 'model assumption (thermoCore.ts)',
  },
  {
    id: 'nasa_std_6001_criterion',
    claim: '152 mm (152.4 mm) screening burn-length criterion in 1g vertical upward configuration',
    source: 'dataset: NASA-STD-6001 Test 1 criterion',
  },
  {
    id: 'saffire_benchmarks',
    claim: 'SAFFIRE-I-01, SAFFIRE-II-05, SAFFIRE-II-06, SAFFIRE-III-01, SAFFIRE-II-07, SAFFIRE-II-01 reference spread/burn values',
    source: 'dataset: Urban et al., ASGSR 2017 (NASA NTRS 20180005168 Table 1); PSI IDs/DOIs pending verification',
  },
  {
    id: 'adapted_reference_notes',
    claim: 'Adapted BASS-II / FLEX / STD-6001 comparison notes',
    source: 'dataset: nasaPsiExperiments.json (attributed per record ID)',
  },
];

export interface SafetyRecommendation {
  hazardLevel: 'NOMINAL' | 'ELEVATED' | 'HIGH_RATE' | 'EXTINGUISHED';
  summary: string;
  hvacAction: string;
  atmosphereAction: string;
  suppressantProtocol: string;
  nasaReferenceNote: string;
  rawText: string;
}

export interface SafetyReasoningStep {
  id: string;
  label: string;
  detail?: string;
}

export const STD_6001_DISCLAIMER_SHORT =
  "the app's run is a 0g duct simulation and not the standard's test configuration";

export const QUICK_SAFETY_QUESTIONS = [
  'Why does 0 cm/s quench in 0g?',
  'Compare 0g vs 1g test',
  'What mitigation levers apply here?',
] as const;

export const REJECTED_INJECTION_REPLY =
  "I can only explain the current simulation from its telemetry. I can't change my rules or share my instructions.";

/**
 * Formats gravity using a single consistent gravity unit format ("0g (0.00 m/s²)", "1g (9.81 m/s²)").
 */
export function formatGravityOneUnit(gravityMs2: number): string {
  if (Math.abs(gravityMs2) < 0.01) {
    return '0g (0.00 m/s²)';
  }
  const ratio = gravityMs2 / STANDARD_GRAVITY_MS2;
  if (Math.abs(ratio - 1) < 0.005) {
    return `1g (${gravityMs2.toFixed(2)} m/s²)`;
  }
  const ratioLabel = Number(ratio.toFixed(2));
  return `${ratioLabel}g (${gravityMs2.toFixed(2)} m/s²)`;
}

/**
 * Excludes out-of-scope FLEX droplet surrogates when the specimen geometry is a solid fuel
 * (rod, sheet, or avionics channel), keeping droplet mode eligible for FLEX records.
 */
export function filterExperimentsForSolidScope(
  params: SimulationParams,
  experiments: NasaPsiExperiment[],
): NasaPsiExperiment[] {
  if (resolveSpecimenGeometry(params) !== 'droplet') {
    return experiments.filter(
      (exp) => !(exp.program === 'FLEX' && exp.scopeStatus === 'out_of_scope'),
    );
  }
  return experiments;
}

/**
 * Matches the closest reference experiment while excluding out-of-scope FLEX droplet records
 * for solid-fuel geometries.
 */
export function matchClosestReferenceForParams(
  params: SimulationParams,
  experiments: NasaPsiExperiment[],
  telemetry?: Pick<ThermoTelemetry, 'isBurning' | 'flameSpreadRateMs'>,
): MatchedExperimentResult {
  const pool = filterExperimentsForSolidScope(params, experiments);
  return matchClosestExperiment(
    params,
    pool.length > 0 ? pool : experiments,
    telemetry,
  );
}

/**
 * Ensures any PSI ID (PSI-nn) or DOI (10.xxxx/...) carries an explicit "(pending verification)"
 * qualifier and normalizes raw "pending_psi_verification" tags without duplicating.
 */
export function formatPsiCitation(text: string): string {
  const normalized = text
    .replace(/,\s*pending_psi_verification\s*\)/gi, ') (pending verification)')
    .replace(/\(\s*pending_psi_verification\s*\)/gi, '(pending verification)')
    .replace(/\bpending_psi_verification\b/gi, '(pending verification)');

  if (/\(pending verification\)/i.test(normalized)) {
    return normalized;
  }
  if (/\bPSI-\d+\b|10\.\d{4,9}\/\S+/i.test(normalized)) {
    return `${normalized} (pending verification)`;
  }
  return normalized;
}

export function formatExperimentPsiAndDoi(exp: NasaPsiExperiment): string {
  if (exp.psiInvestigationId && exp.doi) {
    return `${exp.psiInvestigationId} · DOI ${exp.doi} (pending verification)`;
  }
  return formatPsiCitation(exp.psiCitation);
}

export function formatExperimentBurnSummary(exp: NasaPsiExperiment): string {
  if (exp.observedBurnLengthMm !== null) {
    return `${exp.observedBurnLengthMm} mm burn`;
  }
  if (exp.sampleLengthMm != null && exp.sampleWidthMm != null) {
    return `Coupon: ${exp.sampleLengthMm} × ${exp.sampleWidthMm} mm (burn length unverified)`;
  }
  return 'Burn length unverified';
}

/**
 * Sanitizes and attributes dataset discrepancy notes so raw metadata never emits forbidden
 * phrasing ("critical", "passes 1g NASA-STD-6001", or unsourced buoyant-flow estimates).
 */
export function formatAdaptedDiscrepancyNote(exp: NasaPsiExperiment): string {
  const sanitized = exp.discrepancyNote1gVsUg
    .replace(/\bNomex passes 1g NASA-STD-6001 at 21% O2\b/gi, 'In the referenced 1g test configuration, Nomex remained under the NASA-STD-6001 152 mm limit at 21% O2')
    .replace(/\bcritical\b/gi, 'extinction')
    .replace(/\s*\(~?\d+(?:–|-)?\d*\s*cm\/s\)/gi, '')
    .replace(/\b~?\d+\s*cm\/s\s+(?=cool ambient air)/gi, '');
  return `Adapted reference note (dataset ${exp.id}, ${formatExperimentPsiAndDoi(exp)}): ${sanitized}`;
}

export function formatFlameStateLabel(
  telemetry: ThermoTelemetry,
  manualExtinguish = false,
): string {
  if (telemetry.chamberState === 'STANDBY') {
    return 'not ignited yet';
  }
  if (telemetry.chamberState === 'IGNITING') {
    return `IGNITING (${IGNITER_JOULE_POWER_W} W hot-wire pulse)`;
  }
  if (telemetry.chamberState === 'SELF_EXTINGUISHED') {
    return manualExtinguish ? 'Extinguished (manual)' : 'Quenched';
  }
  return `${telemetry.chamberState} (${telemetry.regime})`;
}

function formatHazardDisplayLabel(hazard: SafetyRecommendation['hazardLevel']): string {
  if (hazard === 'HIGH_RATE') return 'HIGH RATE';
  return hazard;
}

/**
 * Generates ordered, telemetry-grounded reasoning steps for the Telemetry Assistant
 * ThoughtLine trace without touching DOM or React state.
 */
export function buildSafetyReasoningSteps(
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  kind: 'diagnostic' | 'chat',
  markers: CadMarker[] = [],
  backendLabel = 'Verified Telemetry Engine',
  manualExtinguish = false,
): SafetyReasoningStep[] {
  const mat = MATERIALS[params.materialId];
  const geom = SPECIMEN_GEOMETRIES[resolveSpecimenGeometry(params)];
  const hw = resolveDuctHardware(params);
  const exp = matched.experiment;
  const press = formatPressure(params.pressurePa, unitSystem);
  const vel = formatVelocity(telemetry.effectiveVelocityMs, unitSystem);
  const spread = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);

  const activeHw: string[] = [];
  if (hw.wakeBaffle) activeHw.push('Wake Baffle');
  if (hw.flameArrestor) {
    activeHw.push(telemetry.arrestorOverwhelmed ? 'Arrestor Overwhelmed' : 'Flame Arrestor');
  }
  if (hw.inertNozzle) {
    activeHw.push(telemetry.n2DischargeActive ? 'N2 Purge Active' : 'N2 Nozzle Armed');
  }

  return [
    {
      id: 'step-atmos',
      label: `Sampling ${mat.shortName} (${geom.shortLabel}) at ${telemetry.effectiveO2Percent.toFixed(1)}% O2 & ${press.text} ${press.unit}`,
      detail: `Effective LOI ${telemetry.effectiveLoiPercent.toFixed(1)}% (margin ${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%) · ppO2 ${(telemetry.o2PartialPressurePa / 1000).toFixed(1)} kPa · ${formatFlameStateLabel(telemetry, manualExtinguish)}`,
    },
    {
      id: 'step-flow',
      label: `Resolving ${telemetry.regime} & Extinction-Proximity Index (Da*) residence bounds`,
      detail: `V_eff=${vel.text} ${vel.unit} · Da*=${telemetry.damkohlerNumber.toFixed(2)} · Re=${Math.round(telemetry.reynoldsDuct)}${activeHw.length > 0 ? ` · ${activeHw.join(', ')}` : ''}`,
    },
    {
      id: 'step-psi',
      label: `Cross-referencing reference scenario ${exp.id} (${matched.similarityScore}% match)`,
      detail:
        exp.observedSpreadRateMmS !== null
          ? `Baseline spread ${exp.observedSpreadRateMmS.toFixed(2)} mm/s vs. live ${spread.text} ${spread.unit}`
          : `152 mm reference criterion (${STD_6001_DISCLAIMER_SHORT}) vs. live ${spread.text} ${spread.unit}`,
    },
    {
      id: 'step-protocol',
      label:
        kind === 'diagnostic'
          ? 'Evaluating mitigation levers modeled in this simulation'
          : 'Synthesizing grounded telemetry response',
      detail: `${markers.length} active CAD marker${markers.length === 1 ? '' : 's'} · ${backendLabel}`,
    },
  ];
}

function buildModeledHardwareSummary(
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  blowoffFmt: { text: string; unit: string },
): string {
  const hw = resolveDuctHardware(params);
  const parts: string[] = [
    hw.wakeBaffle
      ? `Wake Baffle=IN (0.72x root flow, blow-off ${blowoffFmt.text} ${blowoffFmt.unit} at ${WAKE_BAFFLE_X_MM} mm)`
      : `Wake Baffle=OUT (blow-off ${blowoffFmt.text} ${blowoffFmt.unit})`,
    hw.flameArrestor
      ? telemetry.arrestorOverwhelmed
        ? `Passive flame arrestor mesh=OVERWHELMED (>32.0% O2 threshold is a model assumption in thermoCore at ${FLAME_ARRESTOR_X_MM} mm)`
        : `Passive flame arrestor mesh=ARMED (clamps burn <= ${FLAME_ARRESTOR_X_MM} mm while <= 32.0% O2; model assumption in thermoCore)`
      : 'Passive flame arrestor mesh=OUT (>32.0% O2 threshold is a model assumption in thermoCore)',
    hw.inertNozzle
      ? telemetry.n2DischargeActive
        ? `N2 Nozzle=PURGING (-${N2_O2_DROP_PERCENT.toFixed(1)}% O2 for ${N2_DISCHARGE_DURATION_S.toFixed(1)}s at ${INERT_NOZZLE_X_MM} mm)`
        : `N2 Nozzle=ARMED (-${N2_O2_DROP_PERCENT.toFixed(1)}% O2 pulse for ${N2_DISCHARGE_DURATION_S.toFixed(1)}s at ${INERT_NOZZLE_X_MM} mm)`
      : 'N2 Nozzle=OUT',
  ];
  return parts.join(' · ');
}

/**
 * Generates a deterministic, grounded summary of mitigation levers modeled in this simulation
 * directly from computed thermo-fluids telemetry and the matched reference scenario.
 * Contains zero crew procedural imperatives, unmodeled equipment, or forbidden authority terms.
 */
export function buildVerifiedSafetySnapshot(
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  manualExtinguish = false,
): SafetyRecommendation {
  const mat = MATERIALS[params.materialId];
  const exp = matched.experiment;
  const hw = resolveDuctHardware(params);
  const blowoffLimitMs = hw.wakeBaffle ? 0.48 : 0.38;

  const velFmt = formatVelocity(params.flowVelocityMs, unitSystem);
  const velStr = `${velFmt.text} ${velFmt.unit}`;
  const blowoffFmt = formatVelocity(blowoffLimitMs, unitSystem);
  const blowoffStr = `${blowoffFmt.text} ${blowoffFmt.unit}`;
  const pressFmt = formatPressure(params.pressurePa, unitSystem);
  const pressStr = `${pressFmt.text} ${pressFmt.unit}`;
  const spreadFmt = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);
  const spreadStr = `${spreadFmt.text} ${spreadFmt.unit}`;
  const fluxFmt = formatHeatFlux(telemetry.totalHeatFluxWm2, unitSystem);
  const fluxStr = `${fluxFmt.text} ${fluxFmt.unit}`;
  const tempFmt = formatTemperature(telemetry.peakFlameTempK, unitSystem);
  const tempStr = `${tempFmt.text} ${tempFmt.unit}`;
  const gravStr = formatGravityOneUnit(params.gravityMs2);
  const zeroVelFmt = formatVelocity(0, unitSystem);
  const zeroVelStr = `${zeroVelFmt.text} ${zeroVelFmt.unit}`;

  let hazardLevel: SafetyRecommendation['hazardLevel'] = 'NOMINAL';
  if (telemetry.chamberState === 'STANDBY') {
    hazardLevel = 'NOMINAL';
  } else if (telemetry.chamberState === 'IGNITING') {
    hazardLevel = 'ELEVATED';
  } else if (telemetry.chamberState === 'SELF_EXTINGUISHED') {
    hazardLevel = 'EXTINGUISHED';
  } else if (telemetry.regime === 'Critical Runaway') {
    hazardLevel = 'HIGH_RATE';
  } else if (telemetry.regime === 'Ventilation-Driven Spread') {
    hazardLevel = 'ELEVATED';
  } else if (telemetry.regime === 'Quenched' || telemetry.regime === 'Blow-Off Extinction') {
    hazardLevel = 'EXTINGUISHED';
  } else {
    hazardLevel = 'NOMINAL';
  }

  const hwSummary = buildModeledHardwareSummary(params, telemetry, blowoffFmt);
  const marginStr = `${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%`;

  let summary = '';
  let hvacAction = '';
  let atmosphereAction = '';
  let suppressantProtocol = '';

  if (telemetry.chamberState === 'STANDBY') {
    summary = `Chamber is not ignited yet on ${mat.shortName} at ${telemetry.effectiveO2Percent.toFixed(1)}% O2 (${pressStr}, ${velStr} ${params.flowMode}, ${gravStr}). Ambient baseline ${tempStr}, ${fluxStr} heat flux, ${spreadStr} spread.`;
    hvacAction =
      telemetry.loiMarginPercent > 0
        ? `Modeled flow lever: Current forced flow is ${velStr} (${params.flowMode}). Predicted post-ignition margin is ${marginStr} above effective LOI (${telemetry.effectiveLoiPercent.toFixed(1)}%); reducing flow to ${zeroVelStr} lowers convective transport, while reaching >= ${blowoffStr} triggers blow-off when strain criteria are met.`
        : `Modeled flow lever: Forced flow is ${velStr} (${params.flowMode}); predicted post-ignition LOI margin is ${marginStr} (below ${telemetry.effectiveLoiPercent.toFixed(1)}% effective LOI).`;
    atmosphereAction = `Modeled O2/N2 lever: Prepared at ${params.o2Percent.toFixed(1)}% O2 (${(telemetry.o2PartialPressurePa / 1000).toFixed(1)} kPa ppO2) and ${pressStr}; N2 Nozzle pulse models a -${N2_O2_DROP_PERCENT.toFixed(1)}% O2 shift for ${N2_DISCHARGE_DURATION_S.toFixed(1)}s.`;
    suppressantProtocol = `Modeled hardware & chamber levers: ${hwSummary}. Chamber is not ignited yet; Pulse Igniter applies ${IGNITER_JOULE_POWER_W} W for ${IGNITION_PULSE_DURATION_S.toFixed(1)}s.`;
  } else if (telemetry.chamberState === 'IGNITING') {
    summary = `${IGNITER_JOULE_POWER_W} W hot-wire Joule ignition transient active on ${mat.shortName} (${telemetry.stateElapsedS.toFixed(1)}s / ${IGNITION_PULSE_DURATION_S.toFixed(1)}s). TC-1 at ${tempStr} with ${fluxStr} local pyrolysis flux.`;
    hvacAction =
      telemetry.loiMarginPercent > 0
        ? `Modeled flow lever: At ${velStr}, positive LOI margin (${marginStr}) predicts sustained spread after the ${IGNITION_PULSE_DURATION_S.toFixed(1)}s pulse unless flow or O2 margin drops below effective LOI (${telemetry.effectiveLoiPercent.toFixed(1)}%).`
        : `Modeled flow lever: At ${velStr}, negative LOI margin (${marginStr}) favors self-extinguishment after the ${IGNITION_PULSE_DURATION_S.toFixed(1)}s ignition pulse completes.`;
    atmosphereAction = `Modeled O2/N2 lever: Effective O2 is ${telemetry.effectiveO2Percent.toFixed(1)}% (${(telemetry.o2PartialPressurePa / 1000).toFixed(1)} kPa ppO2) vs. ${telemetry.effectiveLoiPercent.toFixed(1)}% effective LOI.`;
    suppressantProtocol = `Modeled hardware & chamber levers: ${hwSummary}. Manual extinguish transitions the chamber state to Extinguished (manual).`;
  } else if (telemetry.chamberState === 'SELF_EXTINGUISHED') {
    const extHeadline = manualExtinguish
      ? 'Extinguished (manual)'
      : 'Self-Extinguished (Below Flammability Limit)';
    summary = `${extHeadline} on ${mat.shortName} at ${telemetry.effectiveO2Percent.toFixed(1)}% O2, ${velStr}, ${gravStr}. Combustion ended; thermocouples decaying toward ambient (${tempStr}).`;
    hvacAction = `Modeled flow lever: Forced flow at ${velStr}; zero propagation active.`;
    atmosphereAction = `Modeled O2/N2 lever: Chamber O2 (${telemetry.effectiveO2Percent.toFixed(1)}%, ${pressStr}) vs. effective LOI (${telemetry.effectiveLoiPercent.toFixed(1)}%, margin ${marginStr}).`;
    suppressantProtocol = `Modeled hardware & chamber levers: ${hwSummary}. No active propagation remains.`;
  } else if (telemetry.regime === 'Critical Runaway') {
    summary = `High-rate flame runaway on ${mat.shortName} at ${telemetry.effectiveO2Percent.toFixed(1)}% O2 (${pressStr}, ${gravStr}). Spread rate ${spreadStr} with ${fluxStr} heat flux and ${tempStr} peak${telemetry.overloadActive ? ` (+${IGNITER_JOULE_POWER_W} W thermal overload surge active)` : ''}.`;
    hvacAction = `Modeled flow lever: Reducing forced flow toward ${zeroVelStr} removes convective O2 supply, whereas >= ${blowoffStr} reaches modeled blow-off extinction (solver Da* < ${DA_CRIT.toFixed(2)}).`;
    atmosphereAction = `Modeled O2/N2 lever: Effective O2 is ${telemetry.effectiveO2Percent.toFixed(1)}% (LOI margin ${marginStr} above ${telemetry.effectiveLoiPercent.toFixed(1)}%). N2 Nozzle pulse lowers O2 by -${N2_O2_DROP_PERCENT.toFixed(1)}% for ${N2_DISCHARGE_DURATION_S.toFixed(1)}s.`;
    suppressantProtocol = `Modeled hardware & chamber levers: ${hwSummary}. Manual extinguish cuts combustion state to Extinguished (manual).`;
  } else if (telemetry.regime === 'Ventilation-Driven Spread') {
    summary = `Sustained ventilation-driven spread on ${mat.shortName} (${spreadStr}) at ${velStr} ${params.flowMode} flow in ${gravStr}${telemetry.overloadActive ? ` (+${IGNITER_JOULE_POWER_W} W thermal overload surge active)` : ''}.`;
    hvacAction = `Modeled flow lever: Dropping flow to ${zeroVelStr} removes boundary-layer thinning in 0g, while increasing flow past ${blowoffStr} reaches modeled blow-off extinction.`;
    atmosphereAction = `Modeled O2/N2 lever: Lowering O2 below ${telemetry.effectiveLoiPercent.toFixed(1)}% effective LOI (current margin ${marginStr}) or triggering the -${N2_O2_DROP_PERCENT.toFixed(1)}% O2 N2 Nozzle shifts LOI margin negative.`;
    suppressantProtocol = `Modeled hardware & chamber levers: ${hwSummary}. Manual extinguish terminates spread in the solver.`;
  } else if (telemetry.regime === 'Radiative Spherical') {
    summary = `Low-momentum radiative spherical regime (${tempStr}, ${fluxStr}) at ${velStr} in ${gravStr}.`;
    hvacAction = `Modeled flow lever: Forced flow is ${velStr}; moderate velocity increases convective spread, whereas 0 cm/s limits transport.`;
    atmosphereAction = `Modeled O2/N2 lever: Lowering effective O2 below ${telemetry.effectiveLoiPercent.toFixed(1)}% effective LOI or discharging the -${N2_O2_DROP_PERCENT.toFixed(1)}% O2 N2 Nozzle drives LOI margin negative.`;
    suppressantProtocol = `Modeled hardware & chamber levers: ${hwSummary}. Manual extinguish transitions the state to Extinguished (manual).`;
  } else if (telemetry.regime === 'Blow-Off Extinction') {
    summary = `Convective blow-off extinction at ${velStr} (Da*=${telemetry.damkohlerNumber.toFixed(2)}, blow-off threshold ${blowoffStr}).`;
    hvacAction = `Modeled flow lever: Flow (${velStr}) exceeds ${blowoffStr} blow-off threshold; reducing flow back below ${blowoffStr} restores residence time.`;
    atmosphereAction = `Modeled O2/N2 lever: Effective O2 ${telemetry.effectiveO2Percent.toFixed(1)}% at ${pressStr} (effective LOI ${telemetry.effectiveLoiPercent.toFixed(1)}%).`;
    suppressantProtocol = `Modeled hardware & chamber levers: ${hwSummary}.`;
  } else {
    summary = `Quenched regime on ${mat.shortName} (LOI margin ${marginStr} at ${gravStr}).`;
    hvacAction = `Modeled flow lever: Forced flow at ${velStr} (blow-off limit ${blowoffStr}).`;
    atmosphereAction = `Modeled O2/N2 lever: Effective O2 (${telemetry.effectiveO2Percent.toFixed(1)}%, ${pressStr}) is below effective LOI (${telemetry.effectiveLoiPercent.toFixed(1)}%).`;
    suppressantProtocol = `Modeled hardware & chamber levers: ${hwSummary}.`;
  }

  const burnSummary = formatExperimentBurnSummary(exp);
  const spreadSummary =
    exp.observedSpreadRateMmS !== null
      ? `at ${exp.observedSpreadRateMmS.toFixed(2)} mm/s`
      : `(<= ${NASA_STD_BURN_LIMIT_MM} mm reference criterion; ${STD_6001_DISCLAIMER_SHORT})`;
  const formattedCitation = formatPsiCitation(exp.psiCitation);
  const nasaReferenceNote = `Closest Reference Scenario (Adapted): ${exp.id} (${formattedCitation}) — Reference Baseline: ${burnSummary} ${spreadSummary}. ${formatAdaptedDiscrepancyNote(exp)}`;

  const rawText = [
    `STATUS: ${formatHazardDisplayLabel(hazardLevel)} (${telemetry.regime} · ${formatFlameStateLabel(telemetry, manualExtinguish)})`,
    `DIAGNOSIS: ${summary}`,
    'Mitigation levers modeled in this simulation:',
    `FLOW LEVER: ${hvacAction}`,
    `O2 / N2 LEVER: ${atmosphereAction}`,
    `HARDWARE LEVERS: ${suppressantProtocol}`,
    `REFERENCE: ${nasaReferenceNote}`,
  ].join('\n');

  return {
    hazardLevel,
    summary,
    hvacAction,
    atmosphereAction,
    suppressantProtocol,
    nasaReferenceNote,
    rawText,
  };
}

export const NUMERIC_GUARDRAIL_INSTRUCTION =
  'When referencing the active simulation or answering questions about current chamber conditions, cite ONLY the exact numerical values and physical units from the provided telemetry data—never invent, round differently, omit units, or alter any number.';

export const AUTHORITY_BOUNDARY_INSTRUCTION =
  'Never state that a condition is "safe", "unsafe", "within safe limits", "certified", "approved", "validated", or provide any "guarantee", never predict that a fire will extinguish, and never issue crew orders. If ChamberState is STANDBY, explicitly state it is not ignited yet and do not narrate an active flame. Wherever a PSI ID (PSI-nn) or DOI appears, append "(pending verification)".';

export const CONVERSATIONAL_SAFETY_OFFICER_PROMPT = `You are the Ignimetheus Telemetry Assistant for a reduced-order 1D spacecraft fire-safety simulation. Explain the simulation clearly, concisely, and professionally in plain prose without emojis or bulleted data dumps. ${NUMERIC_GUARDRAIL_INSTRUCTION} ${AUTHORITY_BOUNDARY_INSTRUCTION}`;

export function buildWebLlmPrompt(
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  manualExtinguish = false,
): string {
  const mat = MATERIALS[params.materialId];
  const exp = matched.experiment;
  const vel = formatVelocity(params.flowVelocityMs, unitSystem);
  const press = formatPressure(params.pressurePa, unitSystem);
  const spread = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);
  const flux = formatHeatFlux(telemetry.totalHeatFluxWm2, unitSystem);
  const citation = formatPsiCitation(exp.psiCitation);

  return [
    'You are the Ignimetheus Telemetry Assistant. Summarize the mitigation levers modeled in this simulation without emojis, crew commands, or judgment claims.',
    `${NUMERIC_GUARDRAIL_INSTRUCTION} ${AUTHORITY_BOUNDARY_INSTRUCTION}`,
    '[TELEMETRY]',
    `Telemetry: Material=${mat.name}, State=${formatFlameStateLabel(telemetry, manualExtinguish)}, O2=${telemetry.effectiveO2Percent.toFixed(1)}%, Pressure=${press.text} ${press.unit}, Flow=${vel.text} ${vel.unit} (${params.flowMode}), Gravity=${formatGravityOneUnit(params.gravityMs2)}.`,
    `Computed Regime=${telemetry.regime}, SpreadRate=${spread.text} ${spread.unit}, EffectiveLOI=${telemetry.effectiveLoiPercent.toFixed(1)}%, ExtinctionIndexDaStar=${telemetry.damkohlerNumber.toFixed(2)}, TotalHeatFlux=${flux.text} ${flux.unit}.`,
    `Closest Reference Scenario (Adapted): ${exp.id} (${citation}) — ${formatAdaptedDiscrepancyNote(exp)}`,
    '[/TELEMETRY]',
    'Respond with concise prose describing modeled simulation levers only.',
  ].join('\n');
}

export function buildLiveContextSystemPrompt(
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  manualExtinguish = false,
): string {
  const mat = MATERIALS[params.materialId];
  const exp = matched.experiment;
  const vel = formatVelocity(params.flowVelocityMs, unitSystem);
  const press = formatPressure(params.pressurePa, unitSystem);
  const spread = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);
  const gravStr = formatGravityOneUnit(params.gravityMs2);
  const temp = formatTemperature(telemetry.peakFlameTempK, unitSystem);
  const flux = formatHeatFlux(telemetry.totalHeatFluxWm2, unitSystem);
  const obsBurnNote = formatExperimentBurnSummary(exp);
  const obsSpreadNote =
    exp.observedSpreadRateMmS !== null
      ? `at ${exp.observedSpreadRateMmS.toFixed(2)}mm/s`
      : `(<= ${NASA_STD_BURN_LIMIT_MM}mm reference criterion; ${STD_6001_DISCLAIMER_SHORT})`;
  const citation = formatPsiCitation(exp.psiCitation);

  return [
    CONVERSATIONAL_SAFETY_OFFICER_PROMPT,
    '[TELEMETRY]',
    `LIVE CHAMBER: Material=${mat.name} (${mat.shortName}), O2=${telemetry.effectiveO2Percent.toFixed(1)}%, Pressure=${press.text} ${press.unit}, HVAC_Velocity=${vel.text} ${vel.unit} (${params.flowMode}), Gravity=${gravStr}.`,
    `LIVE TELEMETRY: ChamberState=${telemetry.chamberState} (${formatFlameStateLabel(telemetry, manualExtinguish)}, Igniter=${telemetry.igniterPowerW}W), Regime=${telemetry.regime}, SpreadRate=${spread.text} ${spread.unit}, EffectiveLOI=${telemetry.effectiveLoiPercent.toFixed(1)}% (1g LOI=${mat.loi1gPercent.toFixed(1)}%), LOI_Margin=${telemetry.loiMarginPercent.toFixed(1)}%, ExtinctionIndexDaStar=${telemetry.damkohlerNumber.toFixed(2)}, PeakTemp=${temp.text} ${temp.unit}, HeatFlux=${flux.text} ${flux.unit}.`,
    `CLOSEST REFERENCE SCENARIO (ADAPTED): ${exp.id} (${exp.program}) — ${citation}. Reference Baseline: ${obsBurnNote} ${obsSpreadNote}. ${formatAdaptedDiscrepancyNote(exp)}`,
    '[/TELEMETRY]',
  ].join('\n');
}

export function buildTieredSystemPrompt(
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  budget: 'compact' | 'standard' | 'full' = 'full',
  manualExtinguish = false,
): string {
  if (budget === 'full') {
    return buildLiveContextSystemPrompt(params, telemetry, matched, unitSystem, manualExtinguish);
  }

  const mat = MATERIALS[params.materialId];
  const exp = matched.experiment;
  const vel = formatVelocity(params.flowVelocityMs, unitSystem);
  const spread = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);
  const citation = formatPsiCitation(exp.psiCitation);

  if (budget === 'compact') {
    return [
      CONVERSATIONAL_SAFETY_OFFICER_PROMPT,
      '[TELEMETRY]',
      `CHAMBER: ${mat.shortName}, Status=${formatFlameStateLabel(telemetry, manualExtinguish)}, O2=${telemetry.effectiveO2Percent.toFixed(1)}%, V=${vel.text} ${vel.unit} (${params.flowMode}), Gravity=${formatGravityOneUnit(params.gravityMs2)}.`,
      `STATE: ${telemetry.regime}, Vf=${spread.text} ${spread.unit}, LOI_eff=${telemetry.effectiveLoiPercent.toFixed(1)}%, Margin=${telemetry.loiMarginPercent.toFixed(1)}%, Da*=${telemetry.damkohlerNumber.toFixed(2)}, Ref=${exp.id} (${citation}).`,
      '[/TELEMETRY]',
    ].join('\n');
  }

  const press = formatPressure(params.pressurePa, unitSystem);
  const temp = formatTemperature(telemetry.peakFlameTempK, unitSystem);
  return [
    CONVERSATIONAL_SAFETY_OFFICER_PROMPT,
    '[TELEMETRY]',
    `CHAMBER: ${mat.name} (${mat.shortName}), Status=${formatFlameStateLabel(telemetry, manualExtinguish)}, O2=${telemetry.effectiveO2Percent.toFixed(1)}%, P=${press.text} ${press.unit}, Flow=${vel.text} ${vel.unit} (${params.flowMode}), Gravity=${formatGravityOneUnit(params.gravityMs2)}.`,
    `TELEMETRY: State=${telemetry.chamberState}, Regime=${telemetry.regime}, Spread=${spread.text} ${spread.unit}, EffLOI=${telemetry.effectiveLoiPercent.toFixed(1)}% (Margin=${telemetry.loiMarginPercent.toFixed(1)}%), Da*=${telemetry.damkohlerNumber.toFixed(2)}, PeakT=${temp.text} ${temp.unit}.`,
    `REFERENCE: ${exp.id} (${exp.program}) — ${citation}.`,
    '[/TELEMETRY]',
  ].join('\n');
}

/**
 * Standalone Out-of-Scope Detector (retained for direct unit callers and shared with classifyIntent).
 */
export function checkOutOfScopeQuery(
  question: string,
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  manualExtinguish = false,
): string | null {
  const q = normalizeQuestionText(question);
  if (!q) return null;

  const isToxicGasPpm =
    /\b(?:poison(?:ous)?|toxic(?:ity)?|smoke|fumes|breath(?:e|ing)?|inhal(?:e|ing|ation)?|\bco\b|\bhcn\b|\bhcl\b|\bhf\b|phosgene|hydrogen\s+cyanide|cyanide|carbon\s+monoxide|co\s*ppm|ppm|idlh|twa)\b/.test(
      q,
    );
  const isEvacuationTime =
    /\b(?:leave|evacuat(?:e|ion)|egress(?:\s*time)?|abandon|escape|get\s+out|crew\s+action|crew\s+escape)\b/.test(
      q,
    );
  const isDepressurizationTime =
    /\b(?:depressuri[sz](?:e|ing|ation)?|decompress(?:ion)?|leak(?:s|ing)?|vacuum\s+vent|bleed\s*down)\b/.test(
      q,
    );
  const isFlightCertification =
    /\b(?:certif(?:y|ied|ication)|flight[-\s]*qualif(?:y|ied|ication)|waiver\s*approval|sign[-\s]*off|formally\s*approved\s*for\s*flight)\b/.test(
      q,
    );
  const isElectricalArcEnergy =
    /\b(?:arc(?:\s+energy)?|spark\s+energy|ignition\s+energy|millijoule|\bmj\b|dielectric\s+breakdown|short[-\s]*circuit\s+current)\b/.test(
      q,
    );
  const is3dSootField =
    /\b(?:soot|particulate|obscuration)\b/.test(q);
  const isCostOrDamage =
    /\b(?:cost|price|dollar|dollars|budget|damage|lost\s+hardware)\b/.test(q);
  const isFutureTime =
    /\b(?:in\s+an\s+hour|in\s+\d+\s*(?:min|minute|minutes|hour|hours|hr|hrs)|after\s+\d+\s*(?:min|minute|minutes|hour|hours|hr|hrs)|how\s+long\s+until|eventually|will\s+(?:it|the\s+fire|the\s+flame)\s+(?:spread|reach)\s+to|reach\s+the\s+wall\s+after)\b/.test(
      q,
    );
  const isCabinAirTemp =
    /\b(?:cabin\s+air\s+temp|how\s+hot\s+will\s+(?:the\s+)?cabin\s+(?:air\s+)?get)\b/.test(q);

  if (
    !isToxicGasPpm &&
    !isEvacuationTime &&
    !isDepressurizationTime &&
    !isFlightCertification &&
    !isElectricalArcEnergy &&
    !is3dSootField &&
    !isCostOrDamage &&
    !isFutureTime &&
    !isCabinAirTemp
  ) {
    return null;
  }

  const unmodeledTopics: string[] = [];
  if (isToxicGasPpm) unmodeledTopics.push('toxic gas species, smoke, fumes, or inhalation yields');
  if (isEvacuationTime) unmodeledTopics.push('crew evacuation, egress timelines, or crew actions');
  if (isDepressurizationTime) unmodeledTopics.push('cabin depressurization, decompression, or leak rates');
  if (isFlightCertification) unmodeledTopics.push('formal flight hardware qualification or certification');
  if (isElectricalArcEnergy) unmodeledTopics.push('electrical arc or ignition energy (mJ)');
  if (is3dSootField) unmodeledTopics.push('soot concentration, particulate yields, or optical obscuration');
  if (isCostOrDamage) unmodeledTopics.push('hardware damage estimates or mission cost');
  if (isFutureTime) unmodeledTopics.push('multi-minute or multi-hour future timelines beyond the steady-state 60 s duct window');
  if (isCabinAirTemp) unmodeledTopics.push('bulk cabin air temperature rise outside the 1D duct boundary layer');

  const mat = MATERIALS[params.materialId];
  const spread = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);
  const flux = formatHeatFlux(telemetry.totalHeatFluxWm2, unitSystem);

  return [
    '**Not modeled in this 1D thermo-fluids solver**',
    `- Requested topic (${unmodeledTopics.join(', ')}) is not modeled by this steady-state 1D duct solver (which uses a 60 s burn-integration window).`,
    `- Live simulation summary for ${mat.shortName} (${formatFlameStateLabel(telemetry, manualExtinguish)}): Regime=${telemetry.regime}, Spread=${spread.text} ${spread.unit}, Effective LOI=${telemetry.effectiveLoiPercent.toFixed(1)}% (Margin ${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%), Total Heat Flux=${flux.text} ${flux.unit}, Closest Reference=${matched.experiment.id}.`,
  ].join('\n');
}

export interface AuthorityAuditResult {
  passed: boolean;
  blockedTerms: string[];
}

const BLOCKED_AUTHORITY_REGEX =
  /\b(?:within\s+safe\s+limits|unsafe|safe|certified|certify|guarantee|approved|validated|will\s+extinguish|evacuate|recommend\s+that\s+the\s+crew)\b/gi;

const PROMPT_LEAKAGE_REGEX =
  /\[TELEMETRY\]|\[\/TELEMETRY\]|\[SYSTEM\]|\bsystem\s+prompt\b|\bsnapshot\b|\baudit\b/i;

/**
 * Post-LLM & template Authority Filter: blocks unauthorized judgment, certification,
 * guarantee, or crew-order claims.
 */
export function auditLlmAuthority(text: string): AuthorityAuditResult {
  if (!text) return { passed: true, blockedTerms: [] };
  const scrubbed = text
    .replace(/\bcan['’]?t\s+(?:assess\s+safety\s+or\s+)?certify\s+anything\b/gi, '')
    .replace(/\bnot\s+(?:validated|certified|approved)\b/gi, '');
  const matches = scrubbed.match(BLOCKED_AUTHORITY_REGEX) ?? [];
  const unique = Array.from(new Set(matches.map((m) => m.toLowerCase())));
  return {
    passed: unique.length === 0,
    blockedTerms: unique,
  };
}

export interface NumericAuditResult {
  passed: boolean;
  extractedNumbers: number[];
  rejectedNumbers: number[];
  failureDetail?: string;
}

export const FIXED_AUDIT_REFERENCE_CONSTANTS = [
  0,
  1,
  2,
  3,
  4,
  SPECIMEN_LENGTH_MM,
  120,
  400,
  6001,
  152.4,
  NASA_STD_BURN_LIMIT_MM,
  DUCT_LENGTH_MM,
  FLAME_ARRESTOR_X_MM,
  32,
  N2_O2_DROP_PERCENT,
  N2_DISCHARGE_DURATION_S,
  IGNITION_PULSE_DURATION_S,
  IGNITER_JOULE_POWER_W,
  WAKE_BAFFLE_X_MM,
  INERT_NOZZLE_X_MM,
  38,
  48,
] as const;

type AuditUnitFamily =
  | 'velocity_or_spread'
  | 'percent'
  | 'pressure'
  | 'temperature'
  | 'heat_flux'
  | 'length'
  | 'gravity'
  | 'time'
  | 'power'
  | 'dimensionless_metric'
  | 'bare';

interface UnitTypedTelemetryBuckets {
  all: number[];
  byFamily: Record<Exclude<AuditUnitFamily, 'bare'>, number[]>;
}

function buildUnitTypedTelemetryBuckets(
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  markers: CadMarker[] = [],
): UnitTypedTelemetryBuckets {
  const mat = MATERIALS[params.materialId];
  const exp = matched.experiment;

  const velFmt = formatVelocity(params.flowVelocityMs, unitSystem);
  const effVelFmt = formatVelocity(telemetry.effectiveVelocityMs, unitSystem);
  const pressFmt = formatPressure(params.pressurePa, unitSystem);
  const spreadFmt = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);
  const tempFmt = formatTemperature(telemetry.peakFlameTempK, unitSystem);
  const totalFluxFmt = formatHeatFlux(telemetry.totalHeatFluxWm2, unitSystem);
  const radFluxFmt = formatHeatFlux(telemetry.radiativeHeatFluxWm2, unitSystem);
  const convFluxFmt = formatHeatFlux(telemetry.convectiveHeatFluxWm2, unitSystem);

  const velocity_or_spread: number[] = [
    0,
    params.flowVelocityMs,
    params.flowVelocityMs * 100,
    params.flowVelocityMs * 1000,
    msToFpm(params.flowVelocityMs),
    params.flowVelocityMs / MS_PER_IN_MIN,
    Number(velFmt.text),
    telemetry.effectiveVelocityMs,
    telemetry.effectiveVelocityMs * 100,
    telemetry.effectiveVelocityMs * 1000,
    Number(effVelFmt.text),
    telemetry.buoyantVelocityMs,
    telemetry.buoyantVelocityMs * 100,
    telemetry.buoyantVelocityMs * 1000,
    telemetry.flameSpreadRateMs,
    telemetry.flameSpreadRateMs * 100,
    telemetry.flameSpreadRateMs * 1000,
    msToFpm(telemetry.flameSpreadRateMs),
    telemetry.flameSpreadRateMs / MS_PER_IN_MIN,
    Number(spreadFmt.text),
    0.38,
    38,
    380,
    0.48,
    48,
    480,
    exp.flowVelocityMs,
    exp.flowVelocityMs * 100,
    exp.flowVelocityMs * 1000,
  ];
  if (exp.observedSpreadRateMmS !== null) {
    velocity_or_spread.push(
      exp.observedSpreadRateMmS,
      exp.observedSpreadRateMmS / 10,
      exp.observedSpreadRateMmS / 1000,
    );
  }

  const percent: number[] = [
    0,
    params.o2Percent,
    telemetry.effectiveO2Percent,
    telemetry.effectiveLoiPercent,
    mat.loi1gPercent,
    mat.loiUgMinPercent,
    telemetry.loiMarginPercent,
    Math.abs(telemetry.loiMarginPercent),
    Math.abs(mat.loi1gPercent - telemetry.effectiveLoiPercent),
    matched.similarityScore,
    N2_O2_DROP_PERCENT,
    32,
    exp.o2Percent,
  ];

  const pressure: number[] = [
    params.pressurePa,
    paToKpa(params.pressurePa),
    paToPsi(params.pressurePa),
    paToAtm(params.pressurePa),
    Number(pressFmt.text),
    telemetry.o2PartialPressurePa,
    paToKpa(telemetry.o2PartialPressurePa),
    paToPsi(telemetry.o2PartialPressurePa),
    exp.pressurePa,
    paToKpa(exp.pressurePa),
    paToPsi(exp.pressurePa),
  ];

  const temperature: number[] = [
    telemetry.peakFlameTempK,
    kelvinToCelsius(telemetry.peakFlameTempK),
    kelvinToFahrenheit(telemetry.peakFlameTempK),
    Number(tempFmt.text),
    AMBIENT_CHAMBER_TEMP_K,
    kelvinToCelsius(AMBIENT_CHAMBER_TEMP_K),
    kelvinToFahrenheit(AMBIENT_CHAMBER_TEMP_K),
    telemetry.filmTempK,
    kelvinToCelsius(telemetry.filmTempK),
    telemetry.reactionZoneTempK,
    kelvinToCelsius(telemetry.reactionZoneTempK),
    mat.vaporizationTempK,
    kelvinToCelsius(mat.vaporizationTempK),
    300,
  ];
  for (const tcK of telemetry.thermocoupleTempsK) {
    temperature.push(
      tcK,
      kelvinToCelsius(tcK),
      kelvinToFahrenheit(tcK),
      Number(formatTemperature(tcK, unitSystem).text),
    );
  }

  const heat_flux: number[] = [
    0,
    telemetry.totalHeatFluxWm2,
    telemetry.totalHeatFluxWm2 / 1000,
    wm2ToWcm2(telemetry.totalHeatFluxWm2),
    wm2ToBtuHrFt2(telemetry.totalHeatFluxWm2),
    Number(totalFluxFmt.text),
    telemetry.radiativeHeatFluxWm2,
    telemetry.radiativeHeatFluxWm2 / 1000,
    wm2ToWcm2(telemetry.radiativeHeatFluxWm2),
    wm2ToBtuHrFt2(telemetry.radiativeHeatFluxWm2),
    Number(radFluxFmt.text),
    telemetry.convectiveHeatFluxWm2,
    telemetry.convectiveHeatFluxWm2 / 1000,
    wm2ToWcm2(telemetry.convectiveHeatFluxWm2),
    wm2ToBtuHrFt2(telemetry.convectiveHeatFluxWm2),
    Number(convFluxFmt.text),
  ];

  const length: number[] = [
    0,
    telemetry.burnLengthMm,
    telemetry.burnLengthMm / 10,
    telemetry.burnLengthMm / 1000,
    SPECIMEN_LENGTH_MM,
    SPECIMEN_LENGTH_MM / 10,
    120,
    12,
    400,
    40,
    152.4,
    NASA_STD_BURN_LIMIT_MM,
    DUCT_LENGTH_MM,
    FLAME_ARRESTOR_X_MM,
    WAKE_BAFFLE_X_MM,
    INERT_NOZZLE_X_MM,
    exp.sampleThicknessMm,
    ...THERMOCOUPLE_ARRAY_SPECS.map((t) => t.axialMm),
  ];
  if (exp.sampleLengthMm != null) length.push(exp.sampleLengthMm);
  if (exp.sampleWidthMm != null) length.push(exp.sampleWidthMm);
  if (exp.observedBurnLengthMm != null) length.push(exp.observedBurnLengthMm);

  const gravity: number[] = [
    0,
    1,
    0.165,
    0.38,
    params.gravityMs2,
    params.gravityMs2 / STANDARD_GRAVITY_MS2,
    STANDARD_GRAVITY_MS2,
    9.81,
    exp.gravityMs2,
    exp.gravityMs2 / STANDARD_GRAVITY_MS2,
  ];

  const time: number[] = [
    0,
    telemetry.elapsedTimeS,
    telemetry.stateElapsedS,
    telemetry.n2DischargeRemainingS,
    telemetry.tauFlowS,
    telemetry.tauChemS,
    N2_DISCHARGE_DURATION_S,
    IGNITION_PULSE_DURATION_S,
    30,
    60,
    180,
    300,
  ];

  const power: number[] = [
    0,
    telemetry.igniterPowerW,
    IGNITER_JOULE_POWER_W,
    exp.igniterPowerW,
  ];

  const dimensionless_metric: number[] = [
    0,
    1,
    DA_CRIT,
    0.72,
    telemetry.damkohlerNumber,
    telemetry.reynoldsDuct,
    Math.round(telemetry.reynoldsDuct),
    matched.similarityScore,
  ];

  for (const m of markers) {
    if (m.kind === 'point') {
      const sampled = sampleDuctFieldAtMm(m.xMm, m.yMm, params, telemetry);
      length.push(sampled.xMm, sampled.yMm);
      temperature.push(
        sampled.localTempK,
        kelvinToCelsius(sampled.localTempK),
        kelvinToFahrenheit(sampled.localTempK),
        Number(formatTemperature(sampled.localTempK, unitSystem).text),
      );
      velocity_or_spread.push(
        sampled.localVelMs,
        sampled.localVelMs * 100,
        sampled.localVelMs * 1000,
        Number(formatVelocity(sampled.localVelMs, unitSystem).text),
      );
    } else {
      const span = measureCaliperMm(m);
      length.push(span.distanceMm, span.dxMm, span.dyMm);
    }
  }

  const byFamily: UnitTypedTelemetryBuckets['byFamily'] = {
    velocity_or_spread: velocity_or_spread.filter(Number.isFinite),
    percent: percent.filter(Number.isFinite),
    pressure: pressure.filter(Number.isFinite),
    temperature: temperature.filter(Number.isFinite),
    heat_flux: heat_flux.filter(Number.isFinite),
    length: length.filter(Number.isFinite),
    gravity: gravity.filter(Number.isFinite),
    time: time.filter(Number.isFinite),
    power: power.filter(Number.isFinite),
    dimensionless_metric: dimensionless_metric.filter(Number.isFinite),
  };

  const all = Array.from(
    new Set([
      ...FIXED_AUDIT_REFERENCE_CONSTANTS,
      ...Object.values(byFamily).flat(),
    ]),
  ).filter(Number.isFinite);

  return { all, byFamily };
}

/**
 * Collects all numeric values legitimately present in the live telemetry snapshot
 * (plus solver/dataset reference constants) so WebLLM output can be strictly audited.
 */
export function buildAllowedTelemetryNumberSet(
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  markers: CadMarker[] = [],
): number[] {
  return buildUnitTypedTelemetryBuckets(params, telemetry, matched, unitSystem, markers).all;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

function classifyUnitToken(afterRaw: string, beforeRaw: string): AuditUnitFamily {
  const after = afterRaw.trim().toLowerCase();
  const before = beforeRaw.trim().toLowerCase();

  if (/^(?:mm\/s|cm\/s|m\/s(?![²^2])|ft\/min|fpm|in\/min)\b/.test(after)) {
    return 'velocity_or_spread';
  }
  if (/^(?:%|percent\b)/.test(after)) {
    return 'percent';
  }
  if (/^(?:kpa|pa|psi|atm)\b/.test(after)) {
    return 'pressure';
  }
  if (/^(?:°c|°f|k\b|celsius\b|fahrenheit\b|kelvin\b|deg(?:rees?)?\s*[cf]\b)/.test(after)) {
    return 'temperature';
  }
  if (/^(?:w\/cm²|w\/cm2|kw\/m²|kw\/m2|w\/m²|w\/m2|btu\/hr(?:·ft²)?)/.test(after)) {
    return 'heat_flux';
  }
  if (/^(?:mm|cm|m)\b/.test(after)) {
    return 'length';
  }
  if (/^(?:m\/s²|m\/s2|g)\b/.test(after)) {
    return 'gravity';
  }
  if (/^(?:s|sec|secs|second|seconds)\b/.test(after)) {
    return 'time';
  }
  if (/^(?:w|watts?)\b/.test(after)) {
    return 'power';
  }
  if (
    /(?:\bda\*?|\bdamkohler|\breynolds|\bre|\bindex|\bratio|\bfactor)\s*(?:=|of|is|at|:)?\s*$/i.test(
      before,
    ) ||
    /\b(?:factor|ratio)\b/.test(after)
  ) {
    return 'dimensionless_metric';
  }
  return 'bare';
}

interface ExtractedNumericClaim {
  value: number;
  unitFamily: AuditUnitFamily;
}

function extractNumericClaimsFromText(llmText: string): ExtractedNumericClaim[] {
  const scrubbed = llmText
    .replace(
      /\b(?:SAFFIRE-(?:I|II|III)-\d+|BASS-II-\d+|FLEX-\d+|STD-6001[A-Z0-9-]*|PSI-\d+|NTRS\s*20180005168|TC-[1-6]|P-\d+|D-\d+|O2|N2|CO2|H2O|ppO2|1D|3D|10\.\d{4,9}\/\S+)\b/gi,
      ' ',
    )
    .replace(/\b(?:0g|1g|zero-g|microgravity)\b/gi, ' ');

  const claims: ExtractedNumericClaim[] = [];

  // 1. Numeric ranges (e.g. "10-15 cm/s" or "10 to 15 %") -> both numbers inherit trailing unit
  const rangeCoveredSpans: Array<[number, number]> = [];
  const rangeRegex =
    /(?<![A-Za-z0-9.])([+-]?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*([+-]?\d+(?:\.\d+)?)(?:\s*(mm\/s|cm\/s|m\/s²|m\/s2|m\/s|ft\/min|fpm|in\/min|W\/cm²|W\/cm2|kW\/m²|kW\/m2|W\/m²|W\/m2|BTU\/hr·ft²|BTU\/hr|kPa|Pa|psi|atm|°C|°F|K|mm|cm|m|s|sec|seconds|W|g|%|percent))?/gi;
  let rangeMatch: RegExpExecArray | null = rangeRegex.exec(scrubbed);
  while (rangeMatch !== null) {
    const start = rangeMatch.index;
    const end = start + rangeMatch[0].length;
    const afterText = rangeMatch[3] ?? scrubbed.slice(end, end + 24);
    const beforeText = scrubbed.slice(Math.max(0, start - 24), start);
    const family = classifyUnitToken(afterText, beforeText);
    claims.push({ value: Number(rangeMatch[1]), unitFamily: family });
    claims.push({ value: Number(rangeMatch[2]), unitFamily: family });
    rangeCoveredSpans.push([start, end]);
    rangeMatch = rangeRegex.exec(scrubbed);
  }

  const inCoveredSpan = (idx: number) =>
    rangeCoveredSpans.some(([s, e]) => idx >= s && idx < e);

  // 2. Single numeric literals
  const numRegex = /(?<![A-Za-z])[+-]?\d+(?:\.\d+)?(?![A-Za-z])/g;
  let match: RegExpExecArray | null = numRegex.exec(scrubbed);
  while (match !== null) {
    if (!inCoveredSpan(match.index)) {
      const value = Number(match[0]);
      if (Number.isFinite(value)) {
        const end = match.index + match[0].length;
        const afterText = scrubbed.slice(end, end + 24);
        const beforeText = scrubbed.slice(Math.max(0, match.index - 24), match.index);
        const family = classifyUnitToken(afterText, beforeText);
        claims.push({ value, unitFamily: family });
      }
    }
    match = numRegex.exec(scrubbed);
  }

  // 3. Hyphenated & standalone number words (e.g. "thirteen", "thirty-four percent")
  const compoundWordRegex =
    /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)-(one|two|three|four|five|six|seven|eight|nine)\b/gi;
  const wordSpans: Array<[number, number]> = [];
  let cwMatch: RegExpExecArray | null = compoundWordRegex.exec(scrubbed);
  while (cwMatch !== null) {
    const tens = NUMBER_WORDS[cwMatch[1].toLowerCase()] ?? 0;
    const ones = NUMBER_WORDS[cwMatch[2].toLowerCase()] ?? 0;
    const end = cwMatch.index + cwMatch[0].length;
    const afterText = scrubbed.slice(end, end + 24);
    const beforeText = scrubbed.slice(Math.max(0, cwMatch.index - 24), cwMatch.index);
    claims.push({ value: tens + ones, unitFamily: classifyUnitToken(afterText, beforeText) });
    wordSpans.push([cwMatch.index, end]);
    cwMatch = compoundWordRegex.exec(scrubbed);
  }

  const singleWordRegex = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'gi');
  let swMatch: RegExpExecArray | null = singleWordRegex.exec(scrubbed);
  while (swMatch !== null) {
    const idx = swMatch.index;
    const alreadyCovered = wordSpans.some(([s, e]) => idx >= s && idx < e);
    if (!alreadyCovered) {
      const word = swMatch[1].toLowerCase();
      const val = NUMBER_WORDS[word];
      const end = idx + swMatch[0].length;
      const afterText = scrubbed.slice(end, end + 24);
      const beforeText = scrubbed.slice(Math.max(0, idx - 24), idx);
      const family = classifyUnitToken(afterText, beforeText);
      // Small determiner words ("one", "two", "three") only count as numeric claims if attached to a unit or metric
      if (val >= 4 || family !== 'bare') {
        claims.push({ value: val, unitFamily: family });
      }
    }
    swMatch = singleWordRegex.exec(scrubbed);
  }

  return claims;
}

/**
 * Post-LLM Strict Unit-Aware Numeric Audit (`Local model (figures checked)`).
 * Rejects bare numbers without units, unit-mismatched numbers (e.g. 21.6 mm/s when 21.6 is % O2),
 * hallucinated numbers, number words, and out-of-range numeric spans.
 */
export function auditLlmNumbers(
  llmText: string,
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  markers: CadMarker[] = [],
): NumericAuditResult {
  const claims = extractNumericClaimsFromText(llmText);
  if (claims.length === 0) {
    return {
      passed: true,
      extractedNumbers: [],
      rejectedNumbers: [],
    };
  }

  const buckets = buildUnitTypedTelemetryBuckets(params, telemetry, matched, unitSystem, markers);
  const extractedNumbers: number[] = [];
  const rejectedNumbers: number[] = [];
  let failureDetail: string | undefined;

  for (const claim of claims) {
    extractedNumbers.push(claim.value);

    // Reject bare numbers without physical unit or dimensionless metric tag
    if (claim.unitFamily === 'bare') {
      rejectedNumbers.push(claim.value);
      failureDetail = failureDetail ?? `Bare number without physical unit (${claim.value})`;
      continue;
    }

    const compatibleRefs = buckets.byFamily[claim.unitFamily];
    const isMatched = compatibleRefs.some((ref) => {
      if (Math.abs(claim.value - ref) <= 0.15) return true;
      if (Math.abs(claim.value - Math.round(ref)) <= 1e-6) return true;
      if (Math.abs(Math.abs(claim.value) - Math.abs(ref)) <= 0.15) return true;
      return false;
    });

    if (!isMatched) {
      rejectedNumbers.push(claim.value);
      failureDetail =
        failureDetail ?? `Unit-incompatible or unverified value (${claim.value} [${claim.unitFamily}])`;
    }
  }

  return {
    passed: rejectedNumbers.length === 0,
    extractedNumbers,
    rejectedNumbers,
    ...(failureDetail ? { failureDetail } : {}),
  };
}

function isBulletedTelemetryDump(text: string): boolean {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;
  const telemetryBulletLines = lines.filter((line) =>
    /^(?:[-*•]|\d+\.)\s*(?:O2|Oxygen|Pressure|Flow|Spread|LOI|Regime|State|Peak|Heat Flux|Da\*?|Re)\b[:=]/i.test(
      line,
    ) ||
    /^(?:STATUS|DIAGNOSIS|FLOW LEVER|O2 \/ N2 LEVER|HARDWARE LEVERS|REFERENCE|O2|Pressure|Flow|Spread|LOI):\s*[+-]?\d/i.test(
      line,
    ),
  );
  return telemetryBulletLines.length >= 3;
}

/**
 * Trims truncated LLM output (`finish_reason === 'length'`) back to the last complete sentence.
 */
export function trimToLastCompleteSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/[.!?]$/.test(trimmed)) return trimmed;

  const lastPunctIdx = Math.max(
    trimmed.lastIndexOf('.'),
    trimmed.lastIndexOf('!'),
    trimmed.lastIndexOf('?'),
  );
  if (lastPunctIdx > 0) {
    return trimmed.slice(0, lastPunctIdx + 1).trim();
  }
  const lastNewlineIdx = trimmed.lastIndexOf('\n');
  if (lastNewlineIdx > 0) {
    return `${trimmed.slice(0, lastNewlineIdx).trim()}.`;
  }
  return `${trimmed}.`;
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export const REASONING_VALIDATION_FAILED_NOTE =
  'Audit mismatch — deterministic telemetry fallback used';

export const AUTHORITY_VALIDATION_FAILED_NOTE =
  'Authority filter triggered — deterministic telemetry fallback used';

export const TRUNCATION_VALIDATION_FAILED_NOTE =
  'Truncated or incomplete model output — deterministic telemetry fallback used';

export const PROMPT_LEAKAGE_FAILED_NOTE =
  'Internal prompt framing stripped — deterministic telemetry fallback used';

const EMOJI_CHAR_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu;

export function stripEmojis(text: string): string {
  return text.replace(EMOJI_CHAR_REGEX, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Parses Qwen3 `<think>...</think>` paragraphs or step lines into clean monochrome
 * timeline nodes with zero emojis.
 */
export function parseThinkSteps(reasoningPath: string | null | undefined): SafetyReasoningStep[] {
  if (!reasoningPath) return [];
  const cleaned = reasoningPath.replace(EMOJI_CHAR_REGEX, '').trim();
  if (!cleaned) return [];

  let blocks = cleaned
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (blocks.length === 1 && blocks[0].includes('\n')) {
    const lines = blocks[0]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 1) {
      blocks = lines;
    }
  }

  return blocks
    .map((block, idx) => {
      const normalized = block
        .replace(/^[-*•]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/\s*\n\s*/g, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      return {
        id: `think-${idx}`,
        label: normalized,
      };
    })
    .filter((step) => step.label.length > 0);
}

export interface ExtractedThoughtAndAnswer {
  reasoningPath: string | null;
  answer: string;
  hasUnclosedThink: boolean;
}

/**
 * Extracts `<think>...</think>` reasoning traces from Qwen3 / reasoning-model outputs,
 * isolating the raw thought path while returning the clean final answer for auditing.
 */
export function extractThoughtAndAnswer(rawText: string): ExtractedThoughtAndAnswer {
  if (!rawText) {
    return { reasoningPath: null, answer: '', hasUnclosedThink: false };
  }

  const thoughts: string[] = [];
  let stripped = rawText.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, inner: string) => {
    const cleanedThought = inner.replace(EMOJI_CHAR_REGEX, '').trim();
    if (cleanedThought) {
      thoughts.push(cleanedThought);
    }
    return '\n';
  });

  let hasUnclosedThink = false;
  const openTagMatch = stripped.match(/<think>/i);
  if (openTagMatch && openTagMatch.index !== undefined) {
    hasUnclosedThink = true;
    const unclosedThought = stripped
      .slice(openTagMatch.index + openTagMatch[0].length)
      .replace(EMOJI_CHAR_REGEX, '')
      .trim();
    if (unclosedThought) {
      thoughts.push(unclosedThought);
    }
    stripped = stripped.slice(0, openTagMatch.index);
  }

  const answer = stripped.replace(/<\/think>/gi, '').replace(EMOJI_CHAR_REGEX, '').trim();
  const reasoningPath = thoughts.length > 0 ? thoughts.join('\n\n') : null;

  return {
    reasoningPath,
    answer,
    hasUnclosedThink,
  };
}

export interface AuditedReasoningEvaluation {
  auditedText: string | null;
  reasoningPath?: string;
  reasoningFailedValidation: boolean;
  reasoningFailureNote?: string;
  failureCategory?: 'authority' | 'audit' | 'truncation' | 'leakage' | null;
  auditResult: NumericAuditResult | null;
  authorityAudit?: AuthorityAuditResult;
}

/**
 * Enforces Phase 4 output guards on WebLLM outputs:
 * - Isolates `<think>` blocks
 * - Rejects internal prompt leakage (`[TELEMETRY]`, `[SYSTEM]`, `system prompt`, `snapshot`, `audit`)
 * - Trims truncated outputs and rejects `< 15` word / bare-number fragments
 * - Enforces Authority Filter (`authorityReject`)
 * - Rejects bulleted telemetry data dumps
 * - Enforces strict unit-aware numeric audit (`auditReject`)
 */
export function evaluateAuditedReasoningResponse(
  rawText: string,
  finishReason: string | null | undefined,
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  markers: CadMarker[] = [],
): AuditedReasoningEvaluation {
  const extracted = extractThoughtAndAnswer(rawText);
  const rawAnswer = extracted.answer.trim();

  if (!rawAnswer) {
    if (extracted.reasoningPath) {
      return {
        auditedText: null,
        reasoningPath: extracted.reasoningPath,
        reasoningFailedValidation: true,
        reasoningFailureNote: TRUNCATION_VALIDATION_FAILED_NOTE,
        failureCategory: 'truncation',
        auditResult: null,
      };
    }
    return {
      auditedText: null,
      reasoningFailedValidation: true,
      reasoningFailureNote: TRUNCATION_VALIDATION_FAILED_NOTE,
      failureCategory: 'truncation',
      auditResult: null,
    };
  }

  // 1. Prompt leakage check
  if (PROMPT_LEAKAGE_REGEX.test(rawAnswer)) {
    return {
      auditedText: null,
      ...(extracted.reasoningPath ? { reasoningPath: extracted.reasoningPath } : {}),
      reasoningFailedValidation: true,
      reasoningFailureNote: PROMPT_LEAKAGE_FAILED_NOTE,
      failureCategory: 'leakage',
      auditResult: null,
    };
  }

  // 2. Authority filter
  const authorityAudit = auditLlmAuthority(rawAnswer);
  if (!authorityAudit.passed) {
    return {
      auditedText: null,
      ...(extracted.reasoningPath ? { reasoningPath: extracted.reasoningPath } : {}),
      reasoningFailedValidation: true,
      reasoningFailureNote: AUTHORITY_VALIDATION_FAILED_NOTE,
      failureCategory: 'authority',
      auditResult: null,
      authorityAudit,
    };
  }

  // 3. Truncation & completeness handling
  const wasTruncatedByLength = finishReason === 'length';
  const endsWithSentencePunct = /[.!?]$/.test(rawAnswer);
  const candidateAnswer =
    wasTruncatedByLength || !endsWithSentencePunct
      ? trimToLastCompleteSentence(rawAnswer)
      : rawAnswer;

  const trimmedWordCount = countWords(candidateAnswer);
  if (
    !candidateAnswer ||
    wasTruncatedByLength && trimmedWordCount < 15 ||
    (!endsWithSentencePunct && trimmedWordCount < 15)
  ) {
    return {
      auditedText: null,
      ...(extracted.reasoningPath ? { reasoningPath: extracted.reasoningPath } : {}),
      reasoningFailedValidation: true,
      reasoningFailureNote: TRUNCATION_VALIDATION_FAILED_NOTE,
      failureCategory: 'truncation',
      auditResult: null,
      authorityAudit,
    };
  }

  // 4. Bulleted telemetry dump rejection
  if (isBulletedTelemetryDump(candidateAnswer)) {
    return {
      auditedText: null,
      ...(extracted.reasoningPath ? { reasoningPath: extracted.reasoningPath } : {}),
      reasoningFailedValidation: true,
      reasoningFailureNote: REASONING_VALIDATION_FAILED_NOTE,
      failureCategory: 'audit',
      auditResult: {
        passed: false,
        extractedNumbers: [],
        rejectedNumbers: [],
        failureDetail: 'Bulleted telemetry data dump rejected',
      },
      authorityAudit,
    };
  }

  // 5. Unit-aware numeric & bare-number audit
  const auditResult = auditLlmNumbers(
    candidateAnswer,
    params,
    telemetry,
    matched,
    unitSystem,
    markers,
  );

  if (!auditResult.passed) {
    return {
      auditedText: null,
      ...(extracted.reasoningPath ? { reasoningPath: extracted.reasoningPath } : {}),
      reasoningFailedValidation: true,
      reasoningFailureNote: REASONING_VALIDATION_FAILED_NOTE,
      failureCategory: 'audit',
      auditResult,
      authorityAudit,
    };
  }

  // 6. Short telemetry-bearing response check (< 15 words with telemetry numbers = truncated/thin)
  if (trimmedWordCount < 15 && auditResult.extractedNumbers.length > 0) {
    return {
      auditedText: null,
      ...(extracted.reasoningPath ? { reasoningPath: extracted.reasoningPath } : {}),
      reasoningFailedValidation: true,
      reasoningFailureNote: TRUNCATION_VALIDATION_FAILED_NOTE,
      failureCategory: 'truncation',
      auditResult,
      authorityAudit,
    };
  }

  return {
    auditedText: candidateAnswer,
    ...(extracted.reasoningPath ? { reasoningPath: extracted.reasoningPath } : {}),
    reasoningFailedValidation: false,
    failureCategory: null,
    auditResult,
    authorityAudit,
  };
}

function normalizeQuestionText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s@\-.*?,/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingGreeting(q: string): {
  hadGreeting: boolean;
  wasThanks: boolean;
  remainder: string;
} {
  const cleaned = q
    .replace(/^[\s,!.?]+|[\s,!.?]+$/g, '')
    .trim();
  const thanksMatch = cleaned.match(
    /^(?:thanks(?:\s+(?:so|very)\s+much|\s+a\s+lot)?|thank\s+you(?:\s+(?:so|very)\s+much)?|thx)(?:\s+(?:there|assistant|ignimetheus))?(?:[,!.\s]+(.*))?$/i,
  );
  if (thanksMatch) {
    return {
      hadGreeting: true,
      wasThanks: true,
      remainder: (thanksMatch[1] ?? '').trim(),
    };
  }

  const greetMatch = cleaned.match(
    /^(?:hello|hi|hey|yo|greetings|howdy|good\s+morning|good\s+afternoon|good\s+evening|please)(?:\s+(?:there|assistant|ignimetheus))?(?:[,!.\s]+(.*))?$/i,
  );
  if (greetMatch) {
    return {
      hadGreeting: true,
      wasThanks: false,
      remainder: (greetMatch[1] ?? '').trim(),
    };
  }

  return {
    hadGreeting: false,
    wasThanks: false,
    remainder: q,
  };
}

function isInjectionQuery(q: string): boolean {
  return (
    /\b(?:ignore|override|disregard|forget|bypass)\b[\w\s]{0,28}\b(?:rules|instructions|prompt|constraints|guardrails|safety|audit|filters?)\b/.test(
      q,
    ) ||
    /\b(?:repeat|reveal|print|show|dump|display|share|tell\s+me)\b[\w\s]{0,24}\b(?:system\s+prompt|hidden\s+prompt|instructions|your\s+rules)\b/.test(
      q,
    ) ||
    /\b(?:pretend|act\s+as\s+if|imagine)\b[\w\s]{0,28}\b(?:audit|guardrails|rules|filters|safety)\b[\w\s]{0,16}\b(?:off|disabled|removed|gone)\b/.test(
      q,
    ) ||
    /\b(?:you\s+are\s+now|jailbreak|developer\s+mode|dan\s+mode)\b/.test(q)
  );
}

export function isSafetyJudgmentQuestion(qRaw: string): boolean {
  const q = normalizeQuestionText(qRaw);
  return (
    /\b(?:within\s+safe\s+limits|unsafe|safe|ok\s+to\s+stay|fine\s+for\s+(?:flight|crew|spacecraft|cabin|use|design)|good\s+enough\s+for\s+(?:design|flight|crew|spacecraft))\b/.test(
      q,
    ) ||
    /\bwill\s+(?:it|this|that|the\s+(?:fire|flame))\s+(?:definitely\s+)?(?:go\s+out|extinguish)\b/.test(
      q,
    ) ||
    /\b(?:confirm|meets?|passes?|compliant)\b[\w\s-]{0,40}\b(?:nasa[\s-]*std|std[\s-]*6001|6001|standard|criterion)\b/.test(
      q,
    ) ||
    /\b(?:validated|certified|certify|approved|qualified|flight[\s-]*ready|waiver|guarantee|verified\s+for)\b/.test(
      q,
    )
  );
}

function isOutOfScopeText(q: string): boolean {
  return (
    /\b(?:depressuri[sz](?:e|ing|ation)?|decompress(?:ion)?|leak(?:s|ing)?)\b/.test(q) ||
    /\b(?:poison(?:ous)?|toxic(?:ity)?|smoke|fumes|breath(?:e|ing)?|inhal(?:e|ing|ation)?|\bco\b|\bhcn\b|\bhcl\b|\bhf\b|phosgene|hydrogen\s+cyanide|cyanide|carbon\s+monoxide|ppm|idlh|twa)\b/.test(
      q,
    ) ||
    /\b(?:leave|evacuat(?:e|ion)|egress|abandon|escape|get\s+out|crew\s+action)\b/.test(q) ||
    /\b(?:cost|price|dollar|dollars|budget|damage|lost\s+hardware)\b/.test(q) ||
    /\b(?:soot|particulate|obscuration)\b/.test(q) ||
    /\b(?:in\s+an\s+hour|in\s+\d+\s*(?:min|minute|minutes|hour|hours|hr|hrs)|after\s+\d+\s*(?:min|minute|minutes|hour|hours|hr|hrs)|how\s+long\s+until|eventually|will\s+(?:it|the\s+fire|the\s+flame)\s+(?:spread|reach)\s+to|reach\s+the\s+wall\s+after)\b/.test(
      q,
    ) ||
    /\b(?:arc(?:\s+energy)?|ignition\s+energy|\bmj\b|spark\s+energy|millijoule)\b/.test(q) ||
    /\b(?:cabin\s+air\s+temp|how\s+hot\s+will\s+(?:the\s+)?cabin\s+(?:air\s+)?get)\b/.test(q)
  );
}

function isDualGravityComparisonQuery(q: string): boolean {
  return /(?:\b0\s*g\s*(?:vs\.?|versus|and|or|to|with)\s*1\s*g\b|\b1\s*g\s*(?:vs\.?|versus|and|or|to|with)\s*0\s*g\b|\bcompare\b[\w\s,]{0,36}\b(?:1\s*g|earth|0\s*g)\b|\bearth\s+1\s*g\s+test\b)/.test(
    q,
  );
}

function hasWhatIfCueText(q: string): boolean {
  const hasCue =
    /\bwhat\s+if\b/.test(q) ||
    /\bwhat\s+(?:changes|happens)\b/.test(q) ||
    /\bhow\s+(?:would|does)\s+.*\bchange\b/.test(q) ||
    /\bsuppose\b/.test(q) ||
    /\bif\s+(?:we|i|you|the\s+chamber|the\s+fan)\b/.test(q) ||
    /\b(?:n2|nitrogen)\s+(?:is\s+)?(?:discharged|activated|triggered|pulsed|fired|added|applied)\b/.test(
      q,
    ) ||
    /^(?:raise|increase|drop|lower|reduce|set|turn\s+on|enable|activate|add|disable|turn\s+off)\b/.test(
      q,
    );
  if (!hasCue) return false;
  return true;
}

function isLiveValuesQueryText(q: string): boolean {
  if (/^\s*(?:why|explain)\b/.test(q)) {
    return false;
  }

  const hasExplicitTelemetryMetric =
    /\b(?:spread(?:\s*rate)?|flame\s*speed|vf\b|propagation\s*rate|burn\s*rate|loi\s*margin|effective\s*loi|flammability\s*limit|o2(?:\s*percent|\s*%|)?|oxygen|ppo2|flow(?:\s*velocity|\s*rate|\s*mode)?|velocity|ventilation|airflow|pressure|kpa|psi|atm|gravity|buoyant\s*velocity|temp(?:erature)?|peak\s*(?:flame\s*)?temp|heat\s*flux|radiative\s*flux|convective\s*flux|flux|da\*?|damkohler|reynolds|burn\s*length|chamber\s*state|flame\s*state|status|thermocouples?|tc-[1-6]|tc-?1\.\.6|mitigation(?:\s*levers?)?|n2\s+suppression|flame\s*arrestor|wake\s*baffle|nasa[\s-]*std[\s-]*6001|std[\s-]*6001|152\s*mm|verdict)\b/.test(
      q,
    ) ||
    /@?\b(?:p-\d+|d-\d+|saffire-(?:i|ii|iii)-\d+|bass-ii-\d+)\b/.test(q) ||
    /\bconvert\b/.test(q);

  if (!hasExplicitTelemetryMetric) return false;

  // Exclude glossary-style conceptual questions ("What is LOI margin", "What is Da*?") unless asking about current/live run or conversions
  const isConceptualTermOnly =
    /^(?:what\s+(?:is|are|does)|define|meaning\s+of)\s+(?:the\s+)?(?:loi(?:\s*margin)?|limiting\s+oxygen\s+index|da\*?|damkohler|extinction[\s-]*proximity|thermocouples?|probes?|calipers?|microgravity|concurrent|opposed|saffire|bass|flex)\b/.test(
      q,
    ) &&
    !/\b(?:current|live|this\s+run|this\s+simulation|right\s+now|read|reads|reading|convert)\b/.test(
      q,
    );
  if (isConceptualTermOnly) return false;

  return (
    /\b(?:what(?:'s|\s+is|\s+are|\s+does|\s+do)|how\s+(?:do|does)|give\s+me|report|show|read|reads|reading|list|check|convert|value\s+of|current|live|tell\s+me|cite|inspect|analyze|recommend)\b/.test(
      q,
    ) ||
    /@\b(?:p-\d+|d-\d+|tc-[1-6]|tc-?1\.\.6|saffire|bass|flex)\b/i.test(q)
  );
}

/**
 * Requirement 10: Local WebGPU LLM is eligible ONLY for conceptual "why" or "explain" intents
 * when not already resolved by injection/authority/out-of-scope/smalltalk/about/glossary/values/what-if/compare.
 */
export function isWhyOrExplainIntent(question: string): boolean {
  const q = normalizeQuestionText(question);
  if (!q) return false;
  return classifyIntent(q) === 'EXPLAIN';
}

export function classifyIntent(rawQuestion: string): SafetyIntent {
  const q = normalizeQuestionText(rawQuestion);
  if (!q) return 'UNKNOWN';

  // 1. INJECTION
  if (isInjectionQuery(q)) {
    return 'INJECTION';
  }

  // 2. AUTHORITY
  if (isSafetyJudgmentQuestion(q)) {
    return 'AUTHORITY';
  }

  // 3. OUT_OF_SCOPE
  if (isOutOfScopeText(q)) {
    return 'OUT_OF_SCOPE';
  }

  // 3b. Model vs NASA comparison fast path (never calls LLM)
  if (isNasaModelComparisonQuery(q)) {
    return 'VALUES';
  }

  // 4. Greeting-stripping -> SMALLTALK / ABOUT / GLOSSARY
  const { hadGreeting, wasThanks, remainder } = stripLeadingGreeting(q);
  const effectiveQ = hadGreeting ? remainder : q;

  if (hadGreeting && !effectiveQ) {
    return 'SMALLTALK';
  }
  if (wasThanks && (!effectiveQ || /^(?:so\s+much|very\s+much|a\s+lot)$/i.test(effectiveQ))) {
    return 'SMALLTALK';
  }

  if (
    /^(?:how\s+are\s+you(?:\s+doing)?|how'?s\s+it\s+going|how\s+do\s+you\s+feel|bye|goodbye|see\s+you|later|nice|cool|ok|okay|got\s+it|sounds\s+good|great)[?!.]*$/.test(
      effectiveQ,
    )
  ) {
    return 'SMALLTALK';
  }

  if (
    /^(?:who\s+(?:are|made|built|created|authored)\s+(?:you|this)|what\s+are\s+you|what\s+can\s+you\s+do|help|what\s+is\s+(?:this|ignimetheus)|about)[?!.]*$/.test(
      effectiveQ,
    )
  ) {
    return 'ABOUT';
  }

  const asksLiveRun =
    /\b(?:current|live|right\s+now|this\s+run|this\s+simulation|read|reads|reading|convert|what\s+if|analyze|verdict)\b/.test(
      effectiveQ,
    ) ||
    /@|\btc-[1-6]\b|\bp-\d+\b|\bd-\d+\b|-\d{2}\b/.test(effectiveQ);

  if (!asksLiveRun) {
    if (lookupGlossaryTerm(effectiveQ) !== null) {
      return 'GLOSSARY';
    }
    if (
      /^(?:what\s+(?:is|are|does)\s+(?:a|an|the)?\s*[a-z0-9*-]+(?:\s+[a-z0-9*-]+){0,3}|define\s+[a-z0-9*-]+(?:\s+[a-z0-9*-]+){0,3}|meaning\s+of\s+[a-z0-9*-]+)[?!.]*$/.test(
        effectiveQ,
      ) &&
      !isLiveValuesQueryText(effectiveQ) &&
      !/\b(?:why|compare|diagnostic|mitigation)\b/.test(effectiveQ)
    ) {
      return 'GLOSSARY';
    }
  }

  // 5. COMPARE_0G_1G vs VALUES vs WHAT_IF
  if (isDualGravityComparisonQuery(effectiveQ)) {
    return 'COMPARE_0G_1G';
  }

  if (hasWhatIfCueText(effectiveQ)) {
    return 'WHAT_IF';
  }

  if (isLiveValuesQueryText(effectiveQ)) {
    return 'VALUES';
  }

  // 8. EXPLAIN (conceptual "why" / "explain" about current run)
  if (/\b(?:why|explain)\b/.test(effectiveQ)) {
    return 'EXPLAIN';
  }

  // 9. UNKNOWN
  return 'UNKNOWN';
}

function detectRequestedUnitSystem(q: string, defaultUnitSystem: UnitSystem): UnitSystem {
  if (
    /\b(?:hvac[\s/-]*us|imperial|us\s+units)\b|\b(?:in|to)\s+(?:psi|ft\/min|fpm|in\/min|fahrenheit|°f|btu)\b/.test(
      q,
    )
  ) {
    return 'hvac-us';
  }
  if (/\b(?:si[\s-]*thermo|si\s+units)\b|\b(?:in|to)\s+(?:si|kelvin|w\/m2|w\/m²|kw\/m2|kw\/m²|pa\b)\b/.test(q)) {
    return 'si-thermo';
  }
  if (/\b(?:nasa[\s-]*psi)\b|\b(?:in|to)\s+(?:cm\/s|mm\/s|kpa|celsius|°c)\b/.test(q)) {
    return 'nasa-psi';
  }
  return defaultUnitSystem;
}

function getUnitSystemDisplayName(unitSystem: UnitSystem): string {
  if (unitSystem === 'hvac-us') return 'HVAC / Aerospace US (psi, ft/min, in/min, °F, BTU/hr·ft²)';
  if (unitSystem === 'si-thermo') return 'SI Thermo (Pa/kPa, m/s, K, W/m²)';
  return 'NASA PSI Lab (kPa, cm/s, mm/s, °C, W/cm²)';
}

interface ExplicitUnitConversions {
  hasExplicitRateUnit: boolean;
  rateUnits: Array<'mm/s' | 'cm/s' | 'm/s' | 'ft/min' | 'in/min'>;
  pressureUnits: Array<'kPa' | 'Pa' | 'psi' | 'atm'>;
  tempUnits: Array<'°C' | '°F' | 'K'>;
  fluxUnits: Array<'W/cm²' | 'kW/m²' | 'W/m²' | 'BTU/hr·ft²'>;
}

function collectMatchedUnitsInOrder<T extends string>(
  q: string,
  specs: Array<{ unit: T; regex: RegExp }>,
): T[] {
  const hits: Array<{ unit: T; index: number }> = [];
  for (const spec of specs) {
    const m = q.match(spec.regex);
    if (m && m.index !== undefined) {
      hits.push({ unit: spec.unit, index: m.index });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  return hits.map((h) => h.unit);
}

function extractExplicitUnits(q: string): ExplicitUnitConversions {
  const rateUnits = collectMatchedUnitsInOrder<'mm/s' | 'cm/s' | 'm/s' | 'ft/min' | 'in/min'>(q, [
    { unit: 'cm/s', regex: /\bcm\/s\b|\bcentimeters?\s+per\s+second\b/ },
    { unit: 'mm/s', regex: /\bmm\/s\b|\bmillimeters?\s+per\s+second\b/ },
    { unit: 'm/s', regex: /(?<![cm])m\/s(?![\^²2])\b|\bmeters?\s+per\s+second\b/ },
    { unit: 'ft/min', regex: /\b(?:ft\/min|fpm|feet\s+per\s+minute)\b/ },
    { unit: 'in/min', regex: /\b(?:in\/min|inches\s+per\s+minute)\b/ },
  ]);

  const pressureUnits = collectMatchedUnitsInOrder<'kPa' | 'Pa' | 'psi' | 'atm'>(q, [
    { unit: 'kPa', regex: /\bkpa\b/ },
    { unit: 'Pa', regex: /(?<![k])pa\b/ },
    { unit: 'psi', regex: /\bpsi\b/ },
    { unit: 'atm', regex: /\batm\b/ },
  ]);

  const tempUnits = collectMatchedUnitsInOrder<'°C' | '°F' | 'K'>(q, [
    { unit: '°C', regex: /°c|\bcelsius\b|\bdeg(?:rees?)?\s*c\b/ },
    { unit: '°F', regex: /°f|\bfahrenheit\b|\bdeg(?:rees?)?\s*f\b/ },
    { unit: 'K', regex: /\bkelvin\b|\b(?:in|to)\s+k\b/ },
  ]);

  const fluxUnits = collectMatchedUnitsInOrder<'W/cm²' | 'kW/m²' | 'W/m²' | 'BTU/hr·ft²'>(q, [
    { unit: 'W/cm²', regex: /\bw\/cm(?:\^?2|²)\b/ },
    { unit: 'kW/m²', regex: /\bkw\/m(?:\^?2|²)\b/ },
    { unit: 'W/m²', regex: /(?<![k])w\/m(?:\^?2|²)\b/ },
    { unit: 'BTU/hr·ft²', regex: /\bbtu\b/ },
  ]);

  return {
    hasExplicitRateUnit: rateUnits.length > 0,
    rateUnits,
    pressureUnits,
    tempUnits,
    fluxUnits,
  };
}

function formatRateInSpecificUnits(
  ms: number,
  units: ExplicitUnitConversions['rateUnits'],
  isSpreadRate: boolean,
): string[] {
  return units.map((u) => {
    if (u === 'cm/s') {
      const val = msToCms(ms);
      return `${val.toFixed(isSpreadRate ? 4 : 1)} cm/s`;
    }
    if (u === 'mm/s') {
      return `${(ms * 1000).toFixed(2)} mm/s`;
    }
    if (u === 'm/s') {
      return `${ms.toFixed(isSpreadRate ? 5 : 3)} m/s`;
    }
    if (u === 'ft/min') {
      return `${msToFpm(ms).toFixed(2)} ft/min`;
    }
    return `${(ms / MS_PER_IN_MIN).toFixed(2)} in/min`;
  });
}

function formatPressureInSpecificUnits(
  pa: number,
  units: ExplicitUnitConversions['pressureUnits'],
): string[] {
  return units.map((u) => {
    if (u === 'kPa') return `${paToKpa(pa).toFixed(2)} kPa`;
    if (u === 'Pa') return `${Math.round(pa)} Pa`;
    if (u === 'psi') return `${paToPsi(pa).toFixed(2)} psi`;
    return `${paToAtm(pa).toFixed(3)} atm`;
  });
}

function formatTempInSpecificUnits(
  k: number,
  units: ExplicitUnitConversions['tempUnits'],
): string[] {
  return units.map((u) => {
    if (u === '°C') return `${kelvinToCelsius(k).toFixed(1)} °C`;
    if (u === '°F') return `${kelvinToFahrenheit(k).toFixed(1)} °F`;
    return `${k.toFixed(1)} K`;
  });
}

function formatFluxInSpecificUnits(
  wm2: number,
  units: ExplicitUnitConversions['fluxUnits'],
): string[] {
  return units.map((u) => {
    if (u === 'W/cm²') return `${wm2ToWcm2(wm2).toFixed(3)} W/cm²`;
    if (u === 'kW/m²') return `${(wm2 / 1000).toFixed(3)} kW/m²`;
    if (u === 'W/m²') return `${wm2.toFixed(1)} W/m²`;
    return `${wm2ToBtuHrFt2(wm2).toFixed(1)} BTU/hr·ft²`;
  });
}

function buildWhatIfAnswer(
  q: string,
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  unitSystem: UnitSystem,
  manualExtinguish = false,
): string | null {
  if (!hasWhatIfCueText(q)) return null;

  const targetUnits = detectRequestedUnitSystem(q, unitSystem);
  const currentHw = resolveDuctHardware(params);
  const nextHardware = { ...currentHw };
  const patch: Partial<SimulationParams> = {};
  const changedLabels: string[] = [];

  const mentionsN2 = /\b(?:n2|nitrogen|inert\s*(?:nozzle|purge|dilution|suppression)|suppression)\b/.test(
    q,
  );
  const mentionsFlow = /\b(?:flow|velocity|ventilation|wind|airflow|blow-?off|opposed|concurrent)\b/.test(
    q,
  );
  const mentionsO2 = /\b(?:o2|oxygen)\b/.test(q);
  const mentionsGravity = /\b(?:gravity|0g|1g|microgravity|zero\s*g|moon|lunar|mars|martian)\b|\b\d+(?:\.\d+)?\s*(?:g\b|m\/s(?:2|\^2|²))/.test(
    q,
  );
  const mentionsArrestor = /\b(?:flame\s+arrestor|arrestor|mesh)\b/.test(q);
  const mentionsBaffle = /\b(?:wake\s+baffle|baffle)\b/.test(q);

  if (
    !mentionsN2 &&
    !mentionsFlow &&
    !mentionsO2 &&
    !mentionsGravity &&
    !mentionsArrestor &&
    !mentionsBaffle
  ) {
    return null;
  }

  if (mentionsO2) {
    const o2Match = q.match(/(\d+(?:\.\d+)?)\s*%/);
    if (o2Match) {
      const nextO2 = Math.max(12, Math.min(40, Number(o2Match[1])));
      patch.o2Percent = nextO2;
      changedLabels.push(`O2 ${params.o2Percent.toFixed(1)}% -> ${nextO2.toFixed(1)}%`);
    } else if (/\b(?:raise|increase|higher|boost|more)\b/.test(q)) {
      const nextO2 = Math.min(40, params.o2Percent + 5);
      patch.o2Percent = nextO2;
      changedLabels.push(`O2 ${params.o2Percent.toFixed(1)}% -> ${nextO2.toFixed(1)}%`);
    } else if (/\b(?:lower|drop|reduce|decrease|less)\b/.test(q)) {
      const nextO2 = Math.max(12, params.o2Percent - 5);
      patch.o2Percent = nextO2;
      changedLabels.push(`O2 ${params.o2Percent.toFixed(1)}% -> ${nextO2.toFixed(1)}%`);
    }
  }

  if (mentionsGravity) {
    if (/\b(?:0\s*g|microgravity|zero\s*g)\b/.test(q)) {
      patch.gravityMs2 = 0.0;
    } else if (/\b(?:moon|lunar)\b/.test(q)) {
      patch.gravityMs2 = 0.165 * STANDARD_GRAVITY_MS2;
    } else if (/\b(?:mars|martian)\b/.test(q)) {
      patch.gravityMs2 = 0.38 * STANDARD_GRAVITY_MS2;
    } else if (/\b1(?:\.0+)?\s*g\b|\bearth\b/.test(q)) {
      patch.gravityMs2 = STANDARD_GRAVITY_MS2;
    } else {
      const gMatch = q.match(/(\d+(?:\.\d+)?)\s*g\b/);
      const ms2Match = q.match(/(\d+(?:\.\d+)?)\s*m\/s(?:\^?2|²)/);
      if (gMatch) {
        patch.gravityMs2 = Math.max(
          0,
          Math.min(2.0 * STANDARD_GRAVITY_MS2, gToMs2(Number(gMatch[1]))),
        );
      } else if (ms2Match) {
        patch.gravityMs2 = Math.max(
          0,
          Math.min(2.0 * STANDARD_GRAVITY_MS2, Number(ms2Match[1])),
        );
      } else {
        patch.gravityMs2 = params.gravityMs2 < 1.0 ? STANDARD_GRAVITY_MS2 : 0.0;
      }
    }
    changedLabels.push(
      `Gravity ${formatGravityOneUnit(params.gravityMs2)} -> ${formatGravityOneUnit(patch.gravityMs2)}`,
    );
  }

  if (mentionsFlow) {
    const cmsMatch = q.match(/(\d+(?:\.\d+)?)\s*cm\/s\b/);
    const msMatch = q.match(/(\d+(?:\.\d+)?)\s*m\/s\b(?!\^?2|²)/);
    const fpmMatch = q.match(/(\d+(?:\.\d+)?)\s*(?:ft\/min|fpm)\b/);

    if (cmsMatch) {
      patch.flowVelocityMs = Math.max(0, Math.min(0.6, cmsToMs(Number(cmsMatch[1]))));
    } else if (msMatch) {
      patch.flowVelocityMs = Math.max(0, Math.min(0.6, Number(msMatch[1])));
    } else if (fpmMatch) {
      patch.flowVelocityMs = Math.max(0, Math.min(0.6, fpmToMs(Number(fpmMatch[1]))));
    } else if (/\b(?:stop|stops|shut(?:s)?\s*(?:off|down)|zero|no\s+flow|off)\b/.test(q)) {
      patch.flowVelocityMs = 0.0;
    } else if (/\b(?:double|doubles|2x)\b/.test(q)) {
      patch.flowVelocityMs = Math.min(0.6, params.flowVelocityMs * 2);
    } else if (/\b(?:halve|halves|half)\b/.test(q)) {
      patch.flowVelocityMs = params.flowVelocityMs * 0.5;
    } else if (/\b(?:blow-?off)\b/.test(q)) {
      patch.flowVelocityMs = currentHw.wakeBaffle ? 0.50 : 0.40;
    } else if (/\b(?:increase|increases|higher|faster|raise|raises|add|boost)\b/.test(q)) {
      patch.flowVelocityMs = Math.min(0.6, params.flowVelocityMs + 0.1);
    } else if (/\b(?:decrease|decreases|lower|slower|drop|drops|reduce|reduces|cut|cuts)\b/.test(q)) {
      patch.flowVelocityMs = Math.max(0.0, params.flowVelocityMs - 0.1);
    }

    if (/\bconcurrent\b/.test(q) && params.flowMode !== 'concurrent') {
      patch.flowMode = 'concurrent';
      changedLabels.push('Flow mode opposed -> concurrent');
    } else if (/\bopposed\b/.test(q) && params.flowMode !== 'opposed') {
      patch.flowMode = 'opposed';
      changedLabels.push('Flow mode concurrent -> opposed');
    }

    if (patch.flowVelocityMs !== undefined) {
      const fBefore = formatVelocity(params.flowVelocityMs, targetUnits);
      const fAfter = formatVelocity(patch.flowVelocityMs, targetUnits);
      changedLabels.push(`Flow ${fBefore.text} ${fBefore.unit} -> ${fAfter.text} ${fAfter.unit}`);
    }
  }

  let hardwarePatched = false;
  if (mentionsArrestor) {
    const turnOff = /\b(?:turn\s+off|disable|remove|off|out)\b/.test(q);
    nextHardware.flameArrestor = !turnOff;
    hardwarePatched = true;
    changedLabels.push(
      `Flame Arrestor ${currentHw.flameArrestor ? 'ON' : 'OFF'} -> ${nextHardware.flameArrestor ? 'ON' : 'OFF'}`,
    );
  }
  if (mentionsBaffle) {
    const turnOff = /\b(?:turn\s+off|disable|remove|off|out)\b/.test(q);
    nextHardware.wakeBaffle = !turnOff;
    hardwarePatched = true;
    changedLabels.push(
      `Wake Baffle ${currentHw.wakeBaffle ? 'IN' : 'OUT'} -> ${nextHardware.wakeBaffle ? 'IN' : 'OUT'}`,
    );
  }
  if (hardwarePatched) {
    patch.hardware = nextHardware;
  }

  const afterParams: SimulationParams = { ...params, ...patch };
  const isStandby = telemetry.chamberState === 'STANDBY';
  const beforeEval = isStandby ? computeThermoTelemetry(params) : telemetry;

  let afterEval: ThermoTelemetry;
  if (mentionsN2) {
    changedLabels.push(
      `N2 Nozzle purge (-${N2_O2_DROP_PERCENT.toFixed(1)}% O2 for ${N2_DISCHARGE_DURATION_S.toFixed(1)}s)`,
    );
    const n2Chamber = dischargeNitrogen(resetChamberToStandby());
    const n2Steady = computeThermoTelemetry(afterParams, n2Chamber);
    const shiftedO2 = Math.max(5.0, afterParams.o2Percent - N2_O2_DROP_PERCENT);
    if (shiftedO2 >= 10.0) {
      afterEval = computeThermoTelemetry({ ...afterParams, o2Percent: shiftedO2 });
    } else {
      afterEval = {
        ...n2Steady,
        flameSpreadRateMs: 0,
        peakFlameTempK: AMBIENT_CHAMBER_TEMP_K + 45,
        radiativeHeatFluxWm2: 180,
        convectiveHeatFluxWm2: 120,
        totalHeatFluxWm2: 300,
      };
    }
  } else {
    afterEval = computeThermoTelemetry(afterParams);
  }

  const beforeSpread = formatSpreadRate(beforeEval.flameSpreadRateMs, targetUnits);
  const afterSpread = formatSpreadRate(afterEval.flameSpreadRateMs, targetUnits);
  const beforeTemp = formatTemperature(beforeEval.peakFlameTempK, targetUnits);
  const afterTemp = formatTemperature(afterEval.peakFlameTempK, targetUnits);
  const beforeFlux = formatHeatFlux(beforeEval.totalHeatFluxWm2, targetUnits);
  const afterFlux = formatHeatFlux(afterEval.totalHeatFluxWm2, targetUnits);

  const beforeStateLabel = isStandby
    ? 'not ignited yet'
    : formatFlameStateLabel(beforeEval, manualExtinguish);
  const afterStateLabel =
    afterEval.loiMarginPercent <= 0 ||
    afterEval.regime === 'Quenched' ||
    afterEval.regime === 'Blow-Off Extinction'
      ? 'Quenched'
      : `SUSTAINED_BURN (${afterEval.regime})`;

  const lines: string[] = [
    `**What-If Solver Evaluation (${changedLabels.join(' · ')})**`,
  ];

  if (isStandby) {
    lines.push(
      `- Chamber State: not ignited yet — ambient ${formatTemperature(telemetry.peakFlameTempK, targetUnits).text}${formatTemperature(telemetry.peakFlameTempK, targetUnits).unit}, 0 ${beforeSpread.unit} live spread. Post-ignition steady-state evaluation Before -> After:`,
    );
  }

  lines.push(
    `- Lever delta: ${changedLabels.join('; ')}`,
    `- State: Before ${beforeStateLabel} -> After ${afterStateLabel}`,
    `- Regime: Before ${beforeEval.regime} -> After ${afterEval.regime}`,
    `- Effective O2: Before ${beforeEval.effectiveO2Percent.toFixed(1)}% -> After ${afterEval.effectiveO2Percent.toFixed(1)}%`,
    `- Effective LOI: Before ${beforeEval.effectiveLoiPercent.toFixed(1)}% -> After ${afterEval.effectiveLoiPercent.toFixed(1)}%`,
    `- LOI Margin: Before ${beforeEval.loiMarginPercent >= 0 ? '+' : ''}${beforeEval.loiMarginPercent.toFixed(1)}% -> After ${afterEval.loiMarginPercent >= 0 ? '+' : ''}${afterEval.loiMarginPercent.toFixed(1)}%`,
    `- Extinction Index (Da*): Before ${beforeEval.damkohlerNumber.toFixed(2)} -> After ${afterEval.damkohlerNumber.toFixed(2)}`,
    `- Spread Rate: Before ${beforeSpread.text} ${beforeSpread.unit} -> After ${afterSpread.text} ${afterSpread.unit}`,
  );

  if (!isStandby) {
    lines.push(
      `- Peak Temp: Before ${beforeTemp.text}${beforeTemp.unit} -> After ${afterTemp.text}${afterTemp.unit}`,
      `- Total Heat Flux: Before ${beforeFlux.text} ${beforeFlux.unit} -> After ${afterFlux.text} ${afterFlux.unit}`,
    );
  }

  if (mentionsArrestor) {
    const arrestorOutcome = !nextHardware.flameArrestor
      ? 'Passive flame arrestor mesh disabled (no 280 mm clamp).'
      : afterEval.arrestorOverwhelmed
        ? `Passive flame arrestor mesh is OVERWHELMED at ${afterEval.effectiveO2Percent.toFixed(1)}% O2 (>32.0% O2 threshold is a model assumption in thermoCore; burn clamp bypassed).`
        : `Passive flame arrestor mesh is ARMED at ${FLAME_ARRESTOR_X_MM} mm (clamps burn length <= ${FLAME_ARRESTOR_X_MM} mm while <= 32.0% O2, a model assumption in thermoCore; steady-state spread rate and LOI margin upstream remain unchanged).`;
    lines.push(`- Arrestor Hardware Effect: ${arrestorOutcome}`);
  }

  return lines.join('\n');
}

function build0gVs1gComparisonAnswer(
  q: string,
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
): string {
  const targetUnits = detectRequestedUnitSystem(q, unitSystem);
  const mat = MATERIALS[params.materialId];
  const exp = matched.experiment;
  const isStandby = telemetry.chamberState === 'STANDBY';
  const tel0g = computeThermoTelemetry({ ...params, gravityMs2: 0.0 });
  const tel1g = computeThermoTelemetry({ ...params, gravityMs2: 9.81 });

  const spread0g = formatSpreadRate(tel0g.flameSpreadRateMs, targetUnits);
  const spread1g = formatSpreadRate(tel1g.flameSpreadRateMs, targetUnits);
  const buoy0g = formatVelocity(tel0g.buoyantVelocityMs, targetUnits);
  const buoy1g = formatVelocity(tel1g.buoyantVelocityMs, targetUnits);
  const velFmt = formatVelocity(params.flowVelocityMs, targetUnits);
  const pressFmt = formatPressure(params.pressurePa, targetUnits);
  const temp0g = formatTemperature(tel0g.peakFlameTempK, targetUnits);
  const temp1g = formatTemperature(tel1g.peakFlameTempK, targetUnits);
  const flux0g = formatHeatFlux(tel0g.totalHeatFluxWm2, targetUnits);
  const flux1g = formatHeatFlux(tel1g.totalHeatFluxWm2, targetUnits);

  const state0g =
    tel0g.loiMarginPercent <= 0 ||
    tel0g.regime === 'Quenched' ||
    tel0g.regime === 'Blow-Off Extinction'
      ? 'Quenched'
      : `SUSTAINED_BURN (${tel0g.regime})`;
  const state1g =
    tel1g.loiMarginPercent <= 0 ||
    tel1g.regime === 'Quenched' ||
    tel1g.regime === 'Blow-Off Extinction'
      ? 'Quenched'
      : `SUSTAINED_BURN (${tel1g.regime})`;

  const lines: string[] = [
    `**0g vs 1g Comparison (${mat.shortName} · ${params.o2Percent.toFixed(1)}% O2, ${pressFmt.text} ${pressFmt.unit}, ${velFmt.text} ${velFmt.unit} ${params.flowMode})**`,
    `- The same duct and sample geometry are assumed.${isStandby ? ' Live chamber is not ignited yet; post-ignition steady-state flammability values are compared below.' : ''}`,
    `0G TELEMETRY: Gravity=${formatGravityOneUnit(0.0)} · State=${state0g} · Regime=${tel0g.regime} · Effective LOI=${tel0g.effectiveLoiPercent.toFixed(1)}% (Margin ${tel0g.loiMarginPercent >= 0 ? '+' : ''}${tel0g.loiMarginPercent.toFixed(1)}%) · Buoyant Flow=${buoy0g.text} ${buoy0g.unit} · Da*=${tel0g.damkohlerNumber.toFixed(2)} · Spread=${spread0g.text} ${spread0g.unit}${isStandby ? '' : ` · Peak=${temp0g.text}${temp0g.unit} · Flux=${flux0g.text} ${flux0g.unit}`}`,
    `1G TELEMETRY: Gravity=${formatGravityOneUnit(9.81)} · State=${state1g} · Regime=${tel1g.regime} · Effective LOI=${tel1g.effectiveLoiPercent.toFixed(1)}% (Margin ${tel1g.loiMarginPercent >= 0 ? '+' : ''}${tel1g.loiMarginPercent.toFixed(1)}%) · Buoyant Flow=${buoy1g.text} ${buoy1g.unit} · Da*=${tel1g.damkohlerNumber.toFixed(2)} · Spread=${spread1g.text} ${spread1g.unit}${isStandby ? '' : ` · Peak=${temp1g.text}${temp1g.unit} · Flux=${flux1g.text} ${flux1g.unit}`}`,
    `- Material 1g LOI reference: ${mat.loi1gPercent.toFixed(1)}% (NASA-STD-6001 152 mm criterion; note: ${STD_6001_DISCLAIMER_SHORT}). ${formatAdaptedDiscrepancyNote(exp)}`,
  ];

  return lines.join('\n');
}

interface OrderedMetricToken {
  key: string;
  pos: number;
  clause: string;
  bullet: string;
}

function findFirstIndex(q: string, regex: RegExp): number {
  const m = q.match(regex);
  return m && m.index !== undefined ? m.index : -1;
}

export function isNasaModelComparisonQuery(qRaw: string): boolean {
  const q = normalizeQuestionText(qRaw);
  return /\b(?:how\s+(?:accurate|close)\s+is\s+(?:the\s+)?model|compare\s+(?:the\s+)?(?:model|this|run)?\s*(?:to|with|against)\s+nasa|model\s*(?:vs\.?|versus)\s*nasa|nasa\s*(?:vs\.?|versus)\s*model)\b/.test(
    q,
  );
}

export function buildNasaModelComparisonAnswer(matched: MatchedExperimentResult): string {
  const c = computeExperimentComparison(matched.experiment);
  const rows = NASA_COMPARISON_CYCLE_IDS.map((id) => EXP_BY_ID[id])
    .filter((e): e is NasaPsiExperiment => Boolean(e))
    .map((e) => computeExperimentComparison(e))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  const mae = computeHeldOutMeanAbsoluteErrorPct(NASA_PSI_EXPERIMENTS);
  const fmt = (r: NonNullable<typeof c>) =>
    r.isExtinctionCheck
      ? `${r.experiment.id}: ${r.nasaOutcomeText} vs ${r.modelOutcomeText}`
      : `${r.experiment.id}: NASA ${r.nasaSpreadText} vs model ${r.modelSpreadText} ${r.signedErrorText ?? ''} ${r.ratioText ?? ''}`.trim();
  const byRole = (role: NonNullable<typeof c>['role']) => rows.filter((r) => r.role === role).map(fmt).join('; ');
  const active = c
    ? `- Active (${c.experiment.id}, ${c.role}): ${c.isExtinctionCheck ? `${c.nasaOutcomeText} vs ${c.modelOutcomeText} (${c.modelSpreadText})` : `NASA ${c.nasaSpreadText} vs Model ${c.modelSpreadText} ${c.signedErrorText ?? ''} ${c.ratioText ?? ''}`.trim()} (${c.sourceLine}).`
    : `- Active (${matched.experiment.id}): outside Saffire spread comparison scope (FLEX and NASA-STD-6001 excluded).`;

  return [
    '**Model vs NASA Saffire Comparison (Steady State)**',
    active,
    `- Fitted (not a test, 20 cm/s): ${byRole('Fitted (not a test)')}.`,
    `- Held-out (25 cm/s): ${byRole('Held-out')}.${mae ? ` ${mae.line}.` : ''}`,
    `- Extinction checks (calibration-informed): ${byRole('Extinction check (calibration-informed)')}.`,
    `- ${NASA_COMPARISON_FOOTNOTE}`,
  ].join('\n');
}

function buildValuesAnswer(
  q: string,
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  markers: CadMarker[],
  manualExtinguish = false,
): string | null {
  if (isNasaModelComparisonQuery(q)) {
    return buildNasaModelComparisonAnswer(matched);
  }
  const explicitUnits = extractExplicitUnits(q);
  const targetUnits = detectRequestedUnitSystem(q, unitSystem);
  const mat = MATERIALS[params.materialId];
  const exp = matched.experiment;
  const isStandby = telemetry.chamberState === 'STANDBY';
  const stateLabel = formatFlameStateLabel(telemetry, manualExtinguish);

  const vel = formatVelocity(params.flowVelocityMs, targetUnits);
  const press = formatPressure(params.pressurePa, targetUnits);
  const spread = formatSpreadRate(telemetry.flameSpreadRateMs, targetUnits);
  const gravStr = formatGravityOneUnit(params.gravityMs2);
  const temp = formatTemperature(telemetry.peakFlameTempK, targetUnits);
  const totalFlux = formatHeatFlux(telemetry.totalHeatFluxWm2, targetUnits);
  const radFlux = formatHeatFlux(telemetry.radiativeHeatFluxWm2, targetUnits);
  const convFlux = formatHeatFlux(telemetry.convectiveHeatFluxWm2, targetUnits);
  const burnFmt = formatLength(telemetry.burnLengthMm / 1000, targetUnits);

  const items: OrderedMetricToken[] = [];

  const spreadPos = findFirstIndex(q, /\b(?:spread(?:\s*rate)?|flame\s*speed|vf\b|propagation\s*rate|burn\s*rate)\b/);
  if (spreadPos >= 0) {
    const spreadExplicit =
      explicitUnits.rateUnits.length > 0
        ? formatRateInSpecificUnits(telemetry.flameSpreadRateMs, explicitUnits.rateUnits, true)
        : [];
    const spreadVal =
      spreadExplicit.length > 0 ? spreadExplicit.join(' / ') : `${spread.text} ${spread.unit}`;
    items.push({
      key: 'spread',
      pos: spreadPos,
      clause: isStandby ? `spread rate is ${spreadVal} (not ignited yet)` : `spread rate is ${spreadVal}`,
      bullet: isStandby
        ? `- Spread Rate: ${spreadVal} (not ignited yet)`
        : `- Spread Rate: ${spreadVal}`,
    });
  }

  const loiPos = findFirstIndex(q, /\b(?:loi(?:\s*margin)?|limiting\s+oxygen|effective\s*loi|flammability\s*limit)\b/);
  if (loiPos >= 0) {
    const marginStr = `${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%`;
    items.push({
      key: 'loi',
      pos: loiPos,
      clause: `effective LOI is ${telemetry.effectiveLoiPercent.toFixed(1)}% (LOI margin ${marginStr})`,
      bullet: `- LOI & Margin: Effective LOI ${telemetry.effectiveLoiPercent.toFixed(1)}% (1g LOI ${mat.loi1gPercent.toFixed(1)}%) · LOI Margin ${marginStr}`,
    });
  }

  const o2Pos = findFirstIndex(q, /\b(?:o2|oxygen|ppo2|partial\s*pressure\s*of\s*o2)\b/);
  if (o2Pos >= 0) {
    items.push({
      key: 'o2',
      pos: o2Pos,
      clause: `O2 is ${telemetry.effectiveO2Percent.toFixed(1)}% (ppO2 ${(telemetry.o2PartialPressurePa / 1000).toFixed(1)} kPa)`,
      bullet: `- O2 Concentration: ${telemetry.effectiveO2Percent.toFixed(1)}% effective (${params.o2Percent.toFixed(1)}% setpoint) · ppO2 ${(telemetry.o2PartialPressurePa / 1000).toFixed(1)} kPa`,
    });
  }

  const flowPos = findFirstIndex(q, /\b(?:flow(?:\s*velocity|\s*rate|\s*mode)?|velocity|ventilation|airflow)\b/);
  if (flowPos >= 0) {
    const flowExplicit =
      explicitUnits.rateUnits.length > 0
        ? formatRateInSpecificUnits(params.flowVelocityMs, explicitUnits.rateUnits, false)
        : [];
    const flowVal =
      flowExplicit.length > 0 ? flowExplicit.join(' / ') : `${vel.text} ${vel.unit}`;
    items.push({
      key: 'flow',
      pos: flowPos,
      clause: `flow velocity is ${flowVal} (${params.flowMode})`,
      bullet: `- Forced Flow: ${flowVal} (${params.flowMode}) · Effective Transport ${formatVelocity(telemetry.effectiveVelocityMs, targetUnits).text} ${vel.unit}`,
    });
  }

  const pressPos = findFirstIndex(q, /\b(?:pressure|kpa|psi|atm|cabin\s*pressure)\b/);
  if (pressPos >= 0) {
    const pressExplicit =
      explicitUnits.pressureUnits.length > 0
        ? formatPressureInSpecificUnits(params.pressurePa, explicitUnits.pressureUnits)
        : [];
    const pressVal =
      pressExplicit.length > 0 ? pressExplicit.join(' / ') : `${press.text} ${press.unit}`;
    items.push({
      key: 'pressure',
      pos: pressPos,
      clause: `pressure is ${pressVal}`,
      bullet: `- Chamber Pressure: ${pressVal}`,
    });
  }

  const gravPos = findFirstIndex(q, /\b(?:gravity|g-level|buoyant\s*velocity)\b/);
  if (gravPos >= 0) {
    items.push({
      key: 'gravity',
      pos: gravPos,
      clause: `gravity is ${gravStr} (buoyant velocity ${formatVelocity(telemetry.buoyantVelocityMs, targetUnits).text} ${vel.unit})`,
      bullet: `- Gravity & Buoyancy: ${gravStr} · Buoyant Velocity ${formatVelocity(telemetry.buoyantVelocityMs, targetUnits).text} ${vel.unit}`,
    });
  }

  const tempPos = findFirstIndex(q, /\b(?:temp(?:erature)?|peak\s*flame|flame\s*temp)\b/);
  if (tempPos >= 0) {
    const tempExplicit =
      explicitUnits.tempUnits.length > 0
        ? formatTempInSpecificUnits(telemetry.peakFlameTempK, explicitUnits.tempUnits)
        : [];
    const tempVal =
      tempExplicit.length > 0 ? tempExplicit.join(' / ') : `${temp.text}${temp.unit}`;
    items.push({
      key: 'temp',
      pos: tempPos,
      clause: isStandby ? `chamber temperature is ambient ${tempVal} (not ignited yet)` : `peak temperature is ${tempVal}`,
      bullet: isStandby
        ? `- Chamber Temperature: Ambient ${tempVal} (not ignited yet)`
        : `- Peak Temperature: ${tempVal}`,
    });
  }

  const fluxPos = findFirstIndex(q, /\b(?:heat\s*flux|radiative\s*flux|convective\s*flux|flux)\b/);
  if (fluxPos >= 0) {
    const fluxExplicit =
      explicitUnits.fluxUnits.length > 0
        ? formatFluxInSpecificUnits(telemetry.totalHeatFluxWm2, explicitUnits.fluxUnits)
        : [];
    const fluxVal =
      fluxExplicit.length > 0 ? fluxExplicit.join(' / ') : `${totalFlux.text} ${totalFlux.unit}`;
    items.push({
      key: 'flux',
      pos: fluxPos,
      clause: `total heat flux is ${fluxVal}`,
      bullet: isStandby
        ? `- Heat Flux: Total ${fluxVal} (not ignited yet)`
        : `- Heat Flux: Total ${fluxVal} (Radiative ${radFlux.text} ${radFlux.unit} + Convective ${convFlux.text} ${convFlux.unit})`,
    });
  }

  const daPos = findFirstIndex(q, /\b(?:da\*?|damkohler|extinction[\s-]*proximity|reynolds)\b/);
  if (daPos >= 0) {
    items.push({
      key: 'da',
      pos: daPos,
      clause: `Da* is ${telemetry.damkohlerNumber.toFixed(2)} and Re is ${Math.round(telemetry.reynoldsDuct)}`,
      bullet: `- Extinction Index (Da*) & Re: Da*=${telemetry.damkohlerNumber.toFixed(2)} · Inlet Duct Re=${Math.round(telemetry.reynoldsDuct)}`,
    });
  }

  const burnPos = findFirstIndex(q, /\b(?:burn\s*length|char\s*length)\b/);
  if (burnPos >= 0) {
    items.push({
      key: 'burn',
      pos: burnPos,
      clause: `burn length is ${telemetry.burnLengthMm.toFixed(1)} mm`,
      bullet: `- Burn Length: ${burnFmt.text} ${burnFmt.unit} (${telemetry.burnLengthMm.toFixed(1)} mm; In this 0g duct simulation the burn length was ${telemetry.burnLengthMm.toFixed(1)} mm — the standard's ${NASA_STD_BURN_LIMIT_MM} mm screening criterion is for a different test configuration)`,
    });
  }

  const statePos = findFirstIndex(q, /\b(?:regime|chamber\s*state|flame\s*state|status)\b/);
  if (statePos >= 0) {
    items.push({
      key: 'state',
      pos: statePos,
      clause: `chamber state is ${stateLabel} (${telemetry.regime})`,
      bullet: `- Chamber State: ${stateLabel} · Regime: ${telemetry.regime}`,
    });
  }

  // Individual CAD markers P-n / D-n in exact order
  const seenProbe = new Set<string>();
  for (const m of q.matchAll(/@?\b(p-\d+|d-\d+)\b/g)) {
    const probeId = m[1].toUpperCase();
    if (seenProbe.has(probeId)) continue;
    seenProbe.add(probeId);
    const marker = markers.find((mk) => mk.id === probeId);
    const pos = m.index ?? 0;
    if (!marker) {
      items.push({
        key: `marker-${probeId}`,
        pos,
        clause: `${probeId} is not placed yet`,
        bullet: `- ${probeId} is not placed yet.`,
      });
    } else if (marker.kind === 'point') {
      const sampled = sampleDuctFieldAtMm(marker.xMm, marker.yMm, params, telemetry);
      const tFmt = formatTemperature(sampled.localTempK, targetUnits);
      const vFmt = formatVelocity(sampled.localVelMs, targetUnits);
      items.push({
        key: `marker-${probeId}`,
        pos,
        clause: `${marker.id} reads T=${tFmt.text}${tFmt.unit} and V=${vFmt.text} ${vFmt.unit} at X=${sampled.xMm.toFixed(1)} mm, Y=${sampled.yMm.toFixed(1)} mm`,
        bullet: `- CAD Probe ${marker.id} (X=${sampled.xMm.toFixed(1)} mm, Y=${sampled.yMm.toFixed(1)} mm): T=${tFmt.text}${tFmt.unit} · V=${vFmt.text} ${vFmt.unit}`,
      });
    } else {
      const span = measureCaliperMm(marker);
      items.push({
        key: `marker-${probeId}`,
        pos,
        clause: `${marker.id} measures ${span.distanceMm.toFixed(1)} mm`,
        bullet: `- CAD Caliper ${marker.id}: Distance=${span.distanceMm.toFixed(1)} mm (dX=${span.dxMm.toFixed(1)} mm, dY=${span.dyMm.toFixed(1)} mm)`,
      });
    }
  }

  // Thermocouples TC-1..6 or individual TC-n in exact order
  const allTcPos = findFirstIndex(q, /@?\btc-?1\.\.6\b|\bthermocouples?\b|\btc\s*array\b/);
  const tcAllText = telemetry.thermocoupleTempsK
    .map((k, idx) => {
      const tf = formatTemperature(k, targetUnits);
      return `TC-${idx + 1}: ${tf.text}${tf.unit}`;
    })
    .join(' · ');
  if (allTcPos >= 0) {
    items.push({
      key: 'tc-all',
      pos: allTcPos,
      clause: `thermocouples read ${tcAllText}`,
      bullet: `- Live Thermocouple Array (${stateLabel}): ${tcAllText}`,
    });
  } else {
    const seenTc = new Set<number>();
    for (const m of q.matchAll(/@?\btc-([1-6])\b/g)) {
      const idx = Number(m[1]) - 1;
      if (idx < 0 || idx > 5 || seenTc.has(idx)) continue;
      seenTc.add(idx);
      const tf = formatTemperature(telemetry.thermocoupleTempsK[idx], targetUnits);
      items.push({
        key: `tc-${idx + 1}`,
        pos: m.index ?? 0,
        clause: `TC-${idx + 1} reads ${tf.text}${tf.unit}`,
        bullet: `- TC-${idx + 1}: ${tf.text}${tf.unit} (${stateLabel})`,
      });
    }
  }

  // Sort strictly by first occurrence position in user question
  items.sort((a, b) => a.pos - b.pos);

  if (items.length === 0) {
    return null;
  }

  // Delegate standalone single-sensor inspection queries ("Inspect @P-1", "Measure @D-1", "Check @TC-3")
  // to buildDatasetOrFeatureRuleAnswer so full probe/duct context and focused-sensor headings remain intact.
  const isSingleSentence = /\bin\s+(?:a|one|single)\s+sentence\b/.test(q);
  const asksConversion = /\bconvert\b/.test(q) || targetUnits !== unitSystem;
  if (
    !isSingleSentence &&
    !asksConversion &&
    items.length === 1 &&
    (items[0].key.startsWith('marker-') || items[0].key.startsWith('tc-'))
  ) {
    return null;
  }

  // Single-sentence request
  if (/\bin\s+(?:a|one|single)\s+sentence\b/.test(q)) {
    const joined =
      items.length > 1
        ? `${items.slice(0, -1).map((i) => i.clause).join(', ')}, and ${items[items.length - 1].clause}`
        : items[0].clause;
    return `In this ${mat.shortName} simulation (${stateLabel}), ${joined}.`;
  }

  // If query asked solely about CAD probes & TCs (e.g. "What does @P-1 read, and what does @TC-3 read?"), output concise ordered lines
  const lines: string[] = [
    `**Telemetry Readout (${mat.shortName} · ${stateLabel})**`,
    ...items.map((i) => i.bullet),
  ];

  if (/\bunits?\b|\bconvert\b/.test(q) || targetUnits !== unitSystem) {
    lines.push(`- Unit System: ${getUnitSystemDisplayName(targetUnits)}`);
  }

  if (items.every((i) => i.key.startsWith('marker-') || i.key.startsWith('tc-'))) {
    if (allTcPos >= 0) {
      lines.push(`- Duct Profile: ${tcAllText}`);
    }
    lines.push(`- Closest Reference Scenario (Adapted): ${exp.id} (${formatPsiCitation(exp.psiCitation)})`);
  }

  return lines.join('\n');
}

function buildDatasetOrFeatureRuleAnswer(
  q: string,
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  markers: CadMarker[],
  manualExtinguish = false,
): string | null {
  const mat = MATERIALS[params.materialId];
  const exp = matched.experiment;
  const isStandby = telemetry.chamberState === 'STANDBY';
  const stateLabel = formatFlameStateLabel(telemetry, manualExtinguish);
  const vel = formatVelocity(params.flowVelocityMs, unitSystem);
  const press = formatPressure(params.pressurePa, unitSystem);
  const spread = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);
  const gravStr = formatGravityOneUnit(params.gravityMs2);
  const temp = formatTemperature(telemetry.peakFlameTempK, unitSystem);
  const radFlux = formatHeatFlux(telemetry.radiativeHeatFluxWm2, unitSystem);
  const convFlux = formatHeatFlux(telemetry.convectiveHeatFluxWm2, unitSystem);
  const expBurnClause = formatExperimentBurnSummary(exp);
  const expSpreadClause =
    exp.observedSpreadRateMmS !== null
      ? `at ${exp.observedSpreadRateMmS.toFixed(2)} mm/s`
      : `(<= ${NASA_STD_BURN_LIMIT_MM} mm reference criterion; ${STD_6001_DISCLAIMER_SHORT})`;

  const probeMention = q.match(/@?\b(p-\d+|d-\d+)\b/);
  if (probeMention) {
    const targetId = probeMention[1].toUpperCase();
    const marker = markers.find((m) => m.id === targetId);
    if (!marker) {
      return [
        `**CAD Marker ${targetId} Status**`,
        `- ${targetId} is not placed yet (no active CAD marker with ID ${targetId}).`,
        `- Active duct markers: ${markers.length > 0 ? markers.map((m) => m.id).join(', ') : 'none'}.`,
      ].join('\n');
    }
    if (marker.kind === 'point') {
      const sampled = sampleDuctFieldAtMm(marker.xMm, marker.yMm, params, telemetry);
      const tFmt = formatTemperature(sampled.localTempK, unitSystem);
      const vFmt = formatVelocity(sampled.localVelMs, unitSystem);
      return [
        `**CAD Sensor Probe ${marker.id} Sampled Telemetry**`,
        `- Coordinates: X=${sampled.xMm.toFixed(1)} mm · Y=${sampled.yMm.toFixed(1)} mm along ${DUCT_LENGTH_MM} mm quartz duct.`,
        `- Local Field: T=${tFmt.text}${tFmt.unit} · V=${vFmt.text} ${vFmt.unit} (${params.flowMode}, ${stateLabel}).`,
        `- Context: ${telemetry.regime} on ${mat.shortName} · Closest reference scenario (adapted) ${exp.id} (${formatPsiCitation(exp.psiCitation)}).`,
      ].join('\n');
    }
    const span = measureCaliperMm(marker);
    return [
      `**CAD Caliper Marker ${marker.id} Measurement**`,
      `- Span: Distance=${span.distanceMm.toFixed(1)} mm (dX=${span.dxMm.toFixed(1)} mm, dY=${span.dyMm.toFixed(1)} mm).`,
      `- Reference: In this 0g duct simulation the burn length was ${telemetry.burnLengthMm.toFixed(1)} mm (the standard's ${NASA_STD_BURN_LIMIT_MM} mm screening criterion is for a different test configuration; ${stateLabel}).`,
    ].join('\n');
  }

  if (/@?tc-?1\.\.6|thermocouple|tc-1|tc-2|tc-3|tc-4|tc-5|tc-6/.test(q)) {
    const singleMatch = q.match(/tc-([1-6])/);
    const tcList = telemetry.thermocoupleTempsK
      .map((k, idx) => {
        const tf = formatTemperature(k, unitSystem);
        return `TC-${idx + 1}: ${tf.text}${tf.unit}`;
      })
      .join(' · ');
    const singleIdx = singleMatch ? Number(singleMatch[1]) - 1 : -1;
    const singleLine =
      singleIdx >= 0
        ? `- Focused sensor TC-${singleIdx + 1}: ${formatTemperature(telemetry.thermocoupleTempsK[singleIdx], unitSystem).text}${formatTemperature(telemetry.thermocoupleTempsK[singleIdx], unitSystem).unit} (${stateLabel}).\n`
        : '';
    return [
      `**Live Thermocouple Array (${stateLabel})**`,
      `${singleLine}- Profile along ${DUCT_LENGTH_MM} mm quartz duct: ${tcList}`,
      isStandby
        ? `- Chamber Status: not ignited yet · Ambient temp ${temp.text}${temp.unit} · Spread rate ${spread.text} ${spread.unit}`
        : `- Leading-edge input: ${telemetry.igniterPowerW.toFixed(0)} W · Peak temp: ${temp.text}${temp.unit} · Spread rate: ${spread.text} ${spread.unit}`,
      `- Closest reference scenario (adapted) ${exp.id} (${formatPsiCitation(exp.psiCitation)}): Reference Baseline: ${expBurnClause} ${expSpreadClause}.`,
    ].join('\n');
  }

  if (/orion|artemis|34\s*%\s*o2|34%|56\.5\s*kpa|exploration atmosphere/.test(q)) {
    const bass45 = EXP_BY_ID['BASS-II-45'];
    const bass45PpO2 = bass45
      ? ((bass45.pressurePa * (bass45.o2Percent / 100)) / 1000).toFixed(1)
      : '19.2';
    const livePpO2 = (telemetry.o2PartialPressurePa / 1000).toFixed(1);
    const hw = resolveDuctHardware(params);
    const arrestorStatus = hw.flameArrestor
      ? telemetry.arrestorOverwhelmed
        ? `overwhelmed above 32.0% O2 limit at ${FLAME_ARRESTOR_X_MM} mm (model assumption in thermoCore)`
        : `armed at ${FLAME_ARRESTOR_X_MM} mm (<= 32.0% O2; model assumption in thermoCore)`
      : `disabled (modeled threshold <= 32.0% O2 at ${FLAME_ARRESTOR_X_MM} mm)`;
    return [
      `**Orion / Artemis Exploration Atmosphere (${bass45 ? `${bass45.o2Percent.toFixed(0)}% O2 at ${(bass45.pressurePa / 1000).toFixed(1)} kPa` : '34% O2 at 56.5 kPa'})**`,
      `- Adapted reference (${bass45 ? `${bass45.id}, ${formatPsiCitation(bass45.psiCitation)}` : 'BASS-II-45'}): ${bass45 ? `${bass45.o2Percent.toFixed(1)}% O2 at ${(bass45.pressurePa / 1000).toFixed(1)} kPa gives ppO2=${bass45PpO2} kPa and ${bass45.observedSpreadRateMmS?.toFixed(1) ?? '0.0'} mm/s under ${(bass45.flowVelocityMs * 100).toFixed(0)} cm/s ${bass45.flowMode} flow. ${formatAdaptedDiscrepancyNote(bass45)}` : 'Elevated O2 molar enrichment drives rapid spread even at hypobaric ppO2.'}`,
      `- Live chamber state (${mat.shortName}, ${stateLabel} @ ${telemetry.effectiveO2Percent.toFixed(1)}% O2, ppO2=${livePpO2} kPa, ${press.text} ${press.unit}, ${vel.text} ${vel.unit}): Regime=${telemetry.regime}, Effective LOI=${telemetry.effectiveLoiPercent.toFixed(1)}% (margin ${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%), Spread=${spread.text} ${spread.unit}.`,
      `- Modeled mitigation levers: Passive flame arrestor mesh is ${arrestorStatus}; N2 Nozzle applies -${N2_O2_DROP_PERCENT.toFixed(1)}% O2 dilution for ${N2_DISCHARGE_DURATION_S.toFixed(1)}s. Closest match: ${exp.id} (${formatPsiCitation(exp.psiCitation)}).`,
    ].join('\n');
  }

  if (/@?saffire-?ii-?03/.test(q)) {
    const saf07 = EXP_BY_ID['SAFFIRE-II-07'];
    const saf07Note = saf07
      ? `${saf07.id} (${formatPsiCitation(saf07.psiCitation)}): ${formatAdaptedDiscrepancyNote(saf07)} (${saf07.o2Percent.toFixed(1)}% O2, ${(saf07.flowVelocityMs * 100).toFixed(1)} cm/s ${saf07.flowMode}, ${saf07.observedBurnLengthMm ?? 0} mm burn, ${(saf07.observedSpreadRateMmS ?? 0).toFixed(1)} mm/s spread).`
      : 'No Saffire Nomex dataset entry loaded.';
    return [
      '**Dataset Note: SAFFIRE-II-03 Not in Loaded Dataset**',
      `- SAFFIRE-II-03 is not included in the loaded NASA PSI dataset. The loaded Nomex Saffire-II record is ${saf07Note}`,
      `- Current chamber (${mat.shortName}, ${stateLabel} @ ${telemetry.effectiveO2Percent.toFixed(1)}% O2, ${vel.text} ${vel.unit}): Effective LOI is ${telemetry.effectiveLoiPercent.toFixed(1)}% (margin ${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%), Spread=${spread.text} ${spread.unit}.`,
      `- Closest reference scenario (adapted): ${exp.id} (${formatPsiCitation(exp.psiCitation)}).`,
    ].join('\n');
  }

  if (/@?saffire-?ii-?07/.test(q)) {
    const saf07 = EXP_BY_ID['SAFFIRE-II-07'];
    return [
      `**Reference Scenario: ${saf07?.id ?? 'SAFFIRE-II-07'} (${saf07?.title ?? 'Nomex Coupon Limit'})**`,
      saf07
        ? `- Dataset baseline (${formatPsiCitation(saf07.psiCitation)}): ${saf07.o2Percent.toFixed(1)}% O2, ${(saf07.pressurePa / 1000).toFixed(1)} kPa, ${(saf07.flowVelocityMs * 100).toFixed(1)} cm/s ${saf07.flowMode} in 0g — ${saf07.observedBurnLengthMm ?? 0} mm burn, ${(saf07.observedSpreadRateMmS ?? 0).toFixed(1)} mm/s spread. ${formatAdaptedDiscrepancyNote(saf07)}`
        : '- Saffire-II Nomex dataset baseline unavailable.',
      `- Live chamber comparison (${mat.shortName}, ${stateLabel} @ ${telemetry.effectiveO2Percent.toFixed(1)}% O2, ${vel.text} ${vel.unit}): Spread=${spread.text} ${spread.unit}, Effective LOI=${telemetry.effectiveLoiPercent.toFixed(1)}% (margin ${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%).`,
      `- Active reference match: ${exp.id} (${formatPsiCitation(exp.psiCitation)}).`,
    ].join('\n');
  }

  if (/@?saffire/.test(q)) {
    const saffireRuns = NASA_PSI_EXPERIMENTS.filter((e) => e.program === 'Saffire-II');
    const summaryItems = saffireRuns.map(
      (r) =>
        `${r.id}: ${MATERIALS[r.materialId].shortName} @ ${r.o2Percent.toFixed(1)}% O2, ${(r.flowVelocityMs * 100).toFixed(0)} cm/s ${r.flowMode} -> ${r.observedBurnLengthMm ?? 0} mm burn, ${(r.observedSpreadRateMmS ?? 0).toFixed(1)} mm/s`,
    );
    return [
      `**Reference Scenario: ${exp.id.startsWith('SAFFIRE-') ? exp.id : 'Saffire-II Dataset'}**`,
      `- Loaded Saffire records (${formatPsiCitation('Urban et al., ASGSR 2017, NASA NTRS 20180005168 Table 1 · PSI-98 / PSI-99')}): ${summaryItems.join('; ')}.`,
      `- Live chamber comparison (${mat.shortName}, ${stateLabel} @ ${telemetry.effectiveO2Percent.toFixed(1)}% O2, ${vel.text} ${vel.unit}): Spread=${spread.text} ${spread.unit}, Effective LOI=${telemetry.effectiveLoiPercent.toFixed(1)}% (margin ${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%), Da*=${telemetry.damkohlerNumber.toFixed(2)}.`,
      `- Active reference match: ${exp.id} (${formatPsiCitation(exp.psiCitation)}).`,
    ].join('\n');
  }

  if (/@?bass-?ii-?14|@?bass-?ii\b|@?bass\b/.test(q)) {
    const bass14 = EXP_BY_ID['BASS-II-14'];
    return [
      `**Reference Scenario: ${bass14?.id ?? 'BASS-II-14'} (${bass14?.title ?? 'PMMA Rod Baseline'})**`,
      bass14
        ? `- Dataset baseline (${formatPsiCitation(bass14.psiCitation)}): ${bass14.sampleThicknessMm} mm ${MATERIALS[bass14.materialId].shortName} ${bass14.flowMode}-flow run at ${bass14.o2Percent.toFixed(1)}% O2, ${(bass14.pressurePa / 1000).toFixed(1)} kPa, ${(bass14.flowVelocityMs * 100).toFixed(1)} cm/s in ${bass14.gravityMs2.toFixed(1)} m/s² — ${bass14.observedBurnLengthMm ?? 0} mm burn at ${(bass14.observedSpreadRateMmS ?? 0).toFixed(2)} mm/s. ${formatAdaptedDiscrepancyNote(bass14)}`
        : '- BASS-II dataset baseline unavailable.',
      `- Live chamber comparison (${mat.shortName}, ${stateLabel}): Spread=${spread.text} ${spread.unit}, Da*=${telemetry.damkohlerNumber.toFixed(2)}, Re=${Math.round(telemetry.reynoldsDuct)}, Temp=${temp.text}${temp.unit}.`,
      `- Closest reference scenario (adapted): ${exp.id} (${formatPsiCitation(exp.psiCitation)}).`,
    ].join('\n');
  }

  if (/@?flex\b/.test(q)) {
    const flex09 = EXP_BY_ID['FLEX-09'];
    const isSolidFuel = resolveSpecimenGeometry(params) !== 'droplet';
    return [
      `**Reference Scenario: FLEX (${formatPsiCitation(flex09?.psiCitation ?? 'NASA PSI-69')})**`,
      flex09
        ? `- Dataset note (${flex09.id}): ${formatAdaptedDiscrepancyNote(flex09)} (${flex09.quarantineReason ?? 'Liquid droplet reference'})`
        : '- FLEX investigates liquid droplet combustion in microgravity.',
      isSolidFuel
        ? `- Scope note: Solid-fuel geometry (${SPECIMEN_GEOMETRIES[resolveSpecimenGeometry(params)].shortLabel}) excludes out-of-scope FLEX droplet records from Closest Reference matching.`
        : '- Geometry note: Suspended Droplet geometry is active.',
      `- Current chamber (${stateLabel}): Gravity=${gravStr}, Flow=${vel.text} ${vel.unit}, Radiative flux=${radFlux.text} ${radFlux.unit} vs Convective=${convFlux.text} ${convFlux.unit}. Closest reference=${exp.id} (${formatPsiCitation(exp.psiCitation)}).`,
    ].join('\n');
  }

  if (/verdict|post-test|analyze completed run|burn length|nasa-std-6001|std-?6001|152\s*mm/.test(q)) {
    const verdict = telemetry.testVerdict;
    const burnMm = (verdict?.burnLengthMm ?? telemetry.burnLengthMm).toFixed(1);
    const durS = (verdict?.testDuration ?? '60') === 'Continuous' ? 'Continuous' : `${verdict?.testDuration ?? 60}s`;
    const elapS = (verdict?.elapsedTimeS ?? telemetry.elapsedTimeS).toFixed(1);
    const outcomeLine = verdict
      ? `Simulation Run Summary: ${verdict.headline} (Test Window: ${durS}, Elapsed: ${elapS}s, Burn Length: ${burnMm} / ${SPECIMEN_LENGTH_MM} mm).`
      : isStandby
        ? `Chamber State: not ignited yet — 0.0 / ${SPECIMEN_LENGTH_MM} mm burned.`
        : `Transient Run Summary (${stateLabel}): ${telemetry.burnLengthMm.toFixed(1)} / ${SPECIMEN_LENGTH_MM} mm burned in ${telemetry.elapsedTimeS.toFixed(1)}s.`;
    const limitNote = `In this 0g duct simulation the burn length was ${burnMm} mm (${STD_6001_DISCLAIMER_SHORT}; the standard's ${NASA_STD_BURN_LIMIT_MM} mm screening criterion is for a different test configuration). Live parameters: ${telemetry.effectiveO2Percent.toFixed(1)}% O2, ${vel.text} ${vel.unit} (${params.flowMode}), ${gravStr}, effective LOI ${telemetry.effectiveLoiPercent.toFixed(1)}%, margin ${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%.`;
    return [
      outcomeLine,
      limitNote,
      `Closest Reference Scenario (Adapted) (${exp.id}, ${formatPsiCitation(exp.psiCitation)}): Reference Baseline: ${expBurnClause} ${expSpreadClause}. ${formatAdaptedDiscrepancyNote(exp)}`,
    ].join('\n\n');
  }

  if (/0\s*cm\/s|quench|radiative|spherical|stagnant|shutdown|no flow|zero flow/.test(q)) {
    return [
      `At quiescent 0 cm/s in microgravity, natural buoyancy vanishes (${gravStr} gives ${formatVelocity(telemetry.buoyantVelocityMs, unitSystem).text} ${vel.unit} buoyant velocity), so oxygen transport depends on molecular diffusion.`,
      `Because radiative cooling drains energy while low-momentum diffusion limits O2 supply, the solver applies a low-flow radiative LOI shift (effective LOI=${telemetry.effectiveLoiPercent.toFixed(1)}%, margin ${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%, radiative flux=${radFlux.text} ${radFlux.unit} vs convective=${convFlux.text} ${convFlux.unit}).`,
      isStandby
        ? `Current chamber (${mat.shortName}, ${telemetry.effectiveO2Percent.toFixed(1)}% O2, ${vel.text} ${vel.unit}): not ignited yet — ambient ${temp.text}${temp.unit}. Closest Reference Scenario (Adapted): ${exp.id} (${formatPsiCitation(exp.psiCitation)}).`
        : `Current state (${mat.shortName}, ${stateLabel}, ${telemetry.effectiveO2Percent.toFixed(1)}% O2, ${vel.text} ${vel.unit}): Regime=${telemetry.regime}, Peak=${temp.text}${temp.unit}. Closest Reference Scenario (Adapted): ${exp.id} (${formatPsiCitation(exp.psiCitation)}).`,
    ].join('\n\n');
  }

  if (/suppress|hvac|extinguish|protocol|action|damper|n2|inert|mitigat|recommend|arrestor|mesh|baffle/.test(q)) {
    const snap = buildVerifiedSafetySnapshot(params, telemetry, matched, unitSystem, manualExtinguish);
    const hw = resolveDuctHardware(params);
    const blowoffFmt = formatVelocity(hw.wakeBaffle ? 0.48 : 0.38, unitSystem);
    const hwSummary = buildModeledHardwareSummary(params, telemetry, blowoffFmt);
    return [
      `Mitigation levers modeled in this simulation (${formatHazardDisplayLabel(snap.hazardLevel)} — ${telemetry.regime}, ${stateLabel}) for ${mat.shortName} at ${telemetry.effectiveO2Percent.toFixed(1)}% O2, ${press.text} ${press.unit}, ${vel.text} ${vel.unit}:`,
      `FLOW LEVER: ${snap.hvacAction}`,
      `O2 / N2 LEVER: ${snap.atmosphereAction}`,
      `HARDWARE LEVERS: ${hwSummary}. ${snap.suppressantProtocol}`,
      `REFERENCE: ${exp.id} (${formatPsiCitation(exp.psiCitation)}).`,
    ].join('\n');
  }

  if (/blow-?off|high flow|fast|velocity|extinction index|da\*|reynolds/.test(q)) {
    const hw = resolveDuctHardware(params);
    const blowoffLimitMs = hw.wakeBaffle ? 0.48 : 0.38;
    const blowoffFmt = formatVelocity(blowoffLimitMs, unitSystem);
    const bass52 = EXP_BY_ID['BASS-II-52'];
    return [
      `Current forced flow is ${vel.text} ${vel.unit} (${params.flowMode}) with Extinction-Proximity Index (Da*) Da*=${telemetry.damkohlerNumber.toFixed(2)} and Inlet Duct Re=${Math.round(telemetry.reynoldsDuct)}${isStandby ? ' (chamber not ignited yet)' : ''}.`,
      `Modeled convective blow-off threshold is ${blowoffFmt.text} ${blowoffFmt.unit} (${hw.wakeBaffle ? 'Wake Baffle IN' : 'Wake Baffle OUT'}). ${bass52 ? `Reference ${bass52.id} (${formatPsiCitation(bass52.psiCitation)}): ${(bass52.flowVelocityMs * 100).toFixed(0)} cm/s at ${bass52.o2Percent.toFixed(1)}% O2 -> ${(bass52.observedSpreadRateMmS ?? 0).toFixed(2)} mm/s spread (${bass52.observedBurnLengthMm ?? 0} mm burn).` : ''}`,
      `Closest Reference Scenario (Adapted) ${exp.id} (${formatPsiCitation(exp.psiCitation)}): Reference Baseline: ${expBurnClause} ${expSpreadClause}.`,
    ].join('\n\n');
  }

  return null;
}

function buildAuthorityReply(
  rawQuestion: string,
  telemetry: ThermoTelemetry,
  unitSystem: UnitSystem,
  manualExtinguish = false,
): string {
  const spread = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);
  const loiMarginStr = `${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}% O2 (effective LOI ${telemetry.effectiveLoiPercent.toFixed(1)}%)`;
  const stateLabel = formatFlameStateLabel(telemetry, manualExtinguish);
  const base = `I can't assess safety or certify anything. This is a reduced-order screening and teaching tool, not validated for spacecraft design. In this simulation: flame state ${stateLabel}, LOI margin ${loiMarginStr}, spread ${spread.text} ${spread.unit}.`;
  if (/\b(?:nasa[\s-]*)?std[\s-]*6001\b|\b6001\b/i.test(rawQuestion)) {
    return `${base} This is a 0g duct simulation, not the standard's test configuration.`;
  }
  return base;
}

function buildSmalltalkOrAboutReply(
  intent: 'SMALLTALK' | 'ABOUT' | 'GLOSSARY',
  rawQuestion: string,
): { content: string; exampleQuestions?: string[] } {
  const q = normalizeQuestionText(rawQuestion);
  const { hadGreeting, wasThanks, remainder } = stripLeadingGreeting(q);
  const effectiveQ = hadGreeting ? remainder : q;

  if (intent === 'SMALLTALK') {
    if (wasThanks) {
      return { content: "You're welcome. Ask whenever you need telemetry or explanations." };
    }
    if (/how\s+are\s+you|how'?s\s+it\s+going|how\s+do\s+you\s+feel/.test(effectiveQ)) {
      return {
        content:
          "I'm a deterministic and local-model telemetry interface for this simulation, so I don't have feelings, but I'm ready to report readings or explain the model.",
      };
    }
    if (/^(?:bye|goodbye|see\s+you|later)/.test(effectiveQ)) {
      return { content: 'Standing by. Ask anytime if you want to inspect another run.' };
    }
    if (/^(?:nice|cool|ok|okay|got\s+it|sounds\s+good|great)/.test(effectiveQ)) {
      return { content: 'Ready whenever you want to inspect the simulation or ask a question.' };
    }
    return { content: 'Hello! Ask me about this simulation, or what terms mean.' };
  }

  if (intent === 'ABOUT') {
    if (/who\s+(?:built|made|created|authored)\s+this/.test(effectiveQ)) {
      return {
        content:
          'Built solo by Ken Mosquera for the NASA Space Apps Challenge 2026 (Manila), Flame in Freefall challenge.',
      };
    }
    return {
      content: [
        'I am the Ignimetheus Telemetry Assistant. I report live chamber readings, compare 0g vs 1g flammability margins, run deterministic what-if checks, and explain combustion behavior in this 1D duct simulation.',
        'What this is not: a safety authority, flight-certification tool, or multi-room spacecraft cabin fire model.',
      ].join('\n\n'),
      exampleQuestions: [...ABOUT_EXAMPLE_QUESTIONS],
    };
  }

  // GLOSSARY
  const entry = lookupGlossaryTerm(effectiveQ);
  if (!entry) {
    return { content: GLOSSARY_FALLBACK };
  }
  return {
    content: `${entry.term}: ${entry.definition} (Source: ${entry.source})`,
  };
}

function buildPreIgnitionQuenchReply(
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  unitSystem: UnitSystem,
): string {
  const mat = MATERIALS[params.materialId];
  const vel = formatVelocity(params.flowVelocityMs, unitSystem);
  const steadyEval = computeThermoTelemetry(params);
  const willSustain = canSustainCombustion(params, steadyEval);
  const loiMarginStr = `${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}% O2 (effective LOI ${telemetry.effectiveLoiPercent.toFixed(1)}%)`;
  const spreadEval = formatSpreadRate(steadyEval.flameSpreadRateMs, unitSystem);
  const implication = willSustain
    ? `If ignited at these settings, the positive LOI margin implies sustained propagation (${steadyEval.regime}, predicted spread ${spreadEval.text} ${spreadEval.unit}, Da*=${steadyEval.damkohlerNumber.toFixed(2)}).`
    : `If ignited at these settings, the LOI margin implies the flame will quench after the ${IGNITION_PULSE_DURATION_S.toFixed(1)}s ignition pulse (${steadyEval.regime}, Da*=${steadyEval.damkohlerNumber.toFixed(2)}).`;
  return [
    `Chamber is not ignited yet on ${mat.shortName}, so no active quench or propagation has occurred.`,
    `- Current Settings: LOI margin ${loiMarginStr}, Flow ${vel.text} ${vel.unit} (${params.flowMode}), O2 ${telemetry.effectiveO2Percent.toFixed(1)}%.`,
    `- Ignition Implication: ${implication}`,
  ].join('\n');
}

export function buildDeterministicExplainAnswer(
  rawQuestion: string,
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  markers: CadMarker[] = [],
  manualExtinguish = false,
): string {
  const q = normalizeQuestionText(rawQuestion);
  const { hadGreeting, remainder } = stripLeadingGreeting(q);
  const effectiveQ = hadGreeting && remainder ? remainder : q;

  // Pre-ignition STANDBY quenched explanation
  if (
    telemetry.chamberState === 'STANDBY' &&
    /\b(?:quench|quenched|extinguished|not\s+burning|isn't\s+burning|is\s+not\s+burning)\b/.test(
      effectiveQ,
    )
  ) {
    return buildPreIgnitionQuenchReply(params, telemetry, unitSystem);
  }

  const featureSpecific = buildDatasetOrFeatureRuleAnswer(
    effectiveQ,
    params,
    telemetry,
    matched,
    unitSystem,
    markers,
    manualExtinguish,
  );
  if (featureSpecific !== null) {
    return featureSpecific;
  }

  const mat = MATERIALS[params.materialId];
  const exp = matched.experiment;
  const vel = formatVelocity(params.flowVelocityMs, unitSystem);
  const press = formatPressure(params.pressurePa, unitSystem);
  const spread = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);
  const gravStr = formatGravityOneUnit(params.gravityMs2);
  const temp = formatTemperature(telemetry.peakFlameTempK, unitSystem);
  const citation = formatPsiCitation(exp.psiCitation);
  const stateLabel = formatFlameStateLabel(telemetry, manualExtinguish);

  if (telemetry.chamberState === 'STANDBY') {
    return [
      `**Live Telemetry Explanation (${mat.shortName} · not ignited yet)**`,
      `- Chamber Status: not ignited yet · ${telemetry.effectiveO2Percent.toFixed(1)}% O2 at ${press.text} ${press.unit}, Flow=${vel.text} ${vel.unit} (${params.flowMode}), Gravity=${gravStr}, Ambient=${temp.text}${temp.unit}.`,
      `- Predicted Post-Ignition Bounds: Effective LOI=${telemetry.effectiveLoiPercent.toFixed(1)}% (Margin ${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%), Predicted Regime=${telemetry.regime}, Da*=${telemetry.damkohlerNumber.toFixed(2)}.`,
      `- ${formatAdaptedDiscrepancyNote(exp)} (${citation})`,
    ].join('\n');
  }

  return [
    `**Live Telemetry Explanation (${mat.shortName} · ${telemetry.regime} · ${stateLabel})**`,
    `- Chamber: ${telemetry.effectiveO2Percent.toFixed(1)}% O2 at ${press.text} ${press.unit}, Flow=${vel.text} ${vel.unit} (${params.flowMode}), Gravity=${gravStr}.`,
    `- Propagation: Spread=${spread.text} ${spread.unit}, Effective LOI=${telemetry.effectiveLoiPercent.toFixed(1)}% (Margin ${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%), Da*=${telemetry.damkohlerNumber.toFixed(2)}, Peak=${temp.text}${temp.unit}.`,
    `- ${formatAdaptedDiscrepancyNote(exp)} (${citation})`,
  ].join('\n');
}

function buildUnknownReply(
  telemetry: ThermoTelemetry,
  unitSystem: UnitSystem,
  manualExtinguish = false,
): string {
  const stateLabel = formatFlameStateLabel(telemetry, manualExtinguish);
  const marginStr = `${telemetry.loiMarginPercent >= 0 ? '+' : ''}${telemetry.loiMarginPercent.toFixed(1)}%`;
  const spread = formatSpreadRate(telemetry.flameSpreadRateMs, unitSystem);
  return `In this simulation: ${stateLabel}, LOI margin ${marginStr}, spread ${spread.text} ${spread.unit}. Ask about the current run, or check Not modeled topics.`;
}

/**
 * Legacy fast-path entrypoint retained for backward compatibility with unit tests and callers.
 * Enforces default-deny classification before returning any deterministic bypass, returning null
 * only for open-ended conceptual EXPLAIN or SMALLTALK/ABOUT/GLOSSARY/UNKNOWN queries when
 * direct rule matching shouldn't steal them.
 */
export function quickRuleMatch(
  question: string,
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  markers: CadMarker[] = [],
  manualExtinguish = false,
): string | null {
  const intent = classifyIntent(question);
  const q = normalizeQuestionText(question);
  const { hadGreeting, remainder } = stripLeadingGreeting(q);
  const effectiveQ = hadGreeting && remainder ? remainder : q;

  if (intent === 'INJECTION') {
    return REJECTED_INJECTION_REPLY;
  }
  if (intent === 'AUTHORITY') {
    return buildAuthorityReply(question, telemetry, unitSystem, manualExtinguish);
  }
  if (intent === 'COMPARE_0G_1G') {
    return build0gVs1gComparisonAnswer(effectiveQ, params, telemetry, matched, unitSystem);
  }
  if (intent === 'WHAT_IF') {
    return buildWhatIfAnswer(effectiveQ, params, telemetry, unitSystem, manualExtinguish);
  }
  if (intent === 'VALUES') {
    return (
      buildValuesAnswer(
        effectiveQ,
        params,
        telemetry,
        matched,
        unitSystem,
        markers,
        manualExtinguish,
      ) ??
      buildDatasetOrFeatureRuleAnswer(
        effectiveQ,
        params,
        telemetry,
        matched,
        unitSystem,
        markers,
        manualExtinguish,
      )
    );
  }
  if (intent === 'EXPLAIN') {
    if (
      telemetry.chamberState === 'STANDBY' &&
      /\b(?:quench|quenched|extinguished|not\s+burning|isn't\s+burning|is\s+not\s+burning)\b/.test(
        effectiveQ,
      )
    ) {
      return buildPreIgnitionQuenchReply(params, telemetry, unitSystem);
    }
    if (/\b(?:orion|artemis|saffire|bass|flex|nasa-std-6001|std-?6001|mitigat|suppress|arrestor|baffle|blow-?off)\b/.test(effectiveQ)) {
      return buildDatasetOrFeatureRuleAnswer(
        effectiveQ,
        params,
        telemetry,
        matched,
        unitSystem,
        markers,
        manualExtinguish,
      );
    }
    return null;
  }
  return null;
}

export function buildGroundedChatAnswer(
  question: string,
  params: SimulationParams,
  telemetry: ThermoTelemetry,
  matched: MatchedExperimentResult,
  unitSystem: UnitSystem,
  markers: CadMarker[] = [],
  manualExtinguish = false,
): string {
  const intent = classifyIntent(question);
  const q = normalizeQuestionText(question);
  const { hadGreeting, remainder } = stripLeadingGreeting(q);
  const effectiveQ = hadGreeting && remainder ? remainder : q;

  if (intent === 'INJECTION') return REJECTED_INJECTION_REPLY;
  if (intent === 'AUTHORITY') return buildAuthorityReply(question, telemetry, unitSystem, manualExtinguish);
  if (intent === 'OUT_OF_SCOPE') {
    return (
      checkOutOfScopeQuery(question, params, telemetry, matched, unitSystem, manualExtinguish) ??
      buildUnknownReply(telemetry, unitSystem, manualExtinguish)
    );
  }
  if (intent === 'SMALLTALK' || intent === 'ABOUT' || intent === 'GLOSSARY') {
    return buildSmalltalkOrAboutReply(intent, question).content;
  }
  if (intent === 'COMPARE_0G_1G') {
    return build0gVs1gComparisonAnswer(effectiveQ, params, telemetry, matched, unitSystem);
  }
  if (intent === 'WHAT_IF') {
    return (
      buildWhatIfAnswer(effectiveQ, params, telemetry, unitSystem, manualExtinguish) ??
      buildUnknownReply(telemetry, unitSystem, manualExtinguish)
    );
  }
  if (intent === 'VALUES') {
    return (
      buildValuesAnswer(
        effectiveQ,
        params,
        telemetry,
        matched,
        unitSystem,
        markers,
        manualExtinguish,
      ) ??
      buildDatasetOrFeatureRuleAnswer(
        effectiveQ,
        params,
        telemetry,
        matched,
        unitSystem,
        markers,
        manualExtinguish,
      ) ??
      buildUnknownReply(telemetry, unitSystem, manualExtinguish)
    );
  }
  if (intent === 'EXPLAIN') {
    return buildDeterministicExplainAnswer(
      question,
      params,
      telemetry,
      matched,
      unitSystem,
      markers,
      manualExtinguish,
    );
  }
  return buildUnknownReply(telemetry, unitSystem, manualExtinguish);
}

export interface ExecuteSafetyAdvisorTurnOptions {
  question: string;
  params: SimulationParams;
  telemetry: ThermoTelemetry;
  matched: MatchedExperimentResult;
  unitSystem: UnitSystem;
  markers?: CadMarker[];
  manualExtinguish?: boolean;
  canUseWebLlm?: boolean;
  modelFamilyLabel?: string;
  systemPromptBudget?: 'compact' | 'standard' | 'full';
  recentHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  llmInvoker?: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  ) => Promise<{ content: string; finishReason?: string | null } | null>;
  counters?: AdvisorDebugCounters;
}

export interface ExecuteSafetyAdvisorTurnResult {
  intent: SafetyIntent;
  content: string;
  source: SafetyResponseBadge;
  llmCalled: boolean;
  reasoningSteps: SafetyReasoningStep[];
  reasoningPath?: string;
  reasoningFailedValidation: boolean;
  reasoningFailureNote?: string;
  failureCategory?: 'authority' | 'audit' | 'truncation' | 'leakage' | null;
  includeTelemetryCard: boolean;
  exampleQuestions?: string[];
  counters: AdvisorDebugCounters;
}

/**
 * Single production + replay orchestrator implementing Phases 1-7:
 * Default-deny intent classification -> pre-LLM routing -> gated WebLLM invocation (EXPLAIN only)
 * -> strict Phase 4 output guards -> deterministic fallbacks + debug counters.
 */
export async function executeSafetyAdvisorTurn(
  options: ExecuteSafetyAdvisorTurnOptions,
): Promise<ExecuteSafetyAdvisorTurnResult> {
  const {
    question,
    params,
    telemetry,
    matched,
    unitSystem,
    markers = [],
    manualExtinguish = false,
    canUseWebLlm = false,
    modelFamilyLabel = 'Qwen3-0.6B',
    systemPromptBudget = 'full',
    recentHistory = [],
    llmInvoker,
    counters = createEmptyDebugCounters(),
  } = options;

  const intent = classifyIntent(question);
  const nextCounters: AdvisorDebugCounters = { ...counters };
  const q = normalizeQuestionText(question);
  const { hadGreeting, remainder } = stripLeadingGreeting(q);
  const effectiveQ = hadGreeting && remainder ? remainder : q;

  // Phase 7: SMALLTALK / ABOUT / GLOSSARY -> Info badge, 0 LLM, zero telemetry dump
  if (intent === 'SMALLTALK' || intent === 'ABOUT' || intent === 'GLOSSARY') {
    const infoReply = buildSmalltalkOrAboutReply(intent, question);
    return {
      intent,
      content: infoReply.content,
      source: 'Info',
      llmCalled: false,
      reasoningSteps: [],
      reasoningFailedValidation: false,
      includeTelemetryCard: false,
      ...(infoReply.exampleQuestions ? { exampleQuestions: infoReply.exampleQuestions } : {}),
      counters: nextCounters,
    };
  }

  // Phase 1: INJECTION -> fixed reply, 0 LLM, zero telemetry dump
  if (intent === 'INJECTION') {
    return {
      intent,
      content: REJECTED_INJECTION_REPLY,
      source: 'Deterministic',
      llmCalled: false,
      reasoningSteps: [],
      reasoningFailedValidation: false,
      includeTelemetryCard: false,
      counters: nextCounters,
    };
  }

  const backendLabel =
    intent === 'OUT_OF_SCOPE'
      ? '1D Scope Guardrail'
      : intent === 'EXPLAIN' && canUseWebLlm && telemetry.chamberState !== 'STANDBY'
        ? `${modelFamilyLabel} Local WebGPU`
        : 'Deterministic Telemetry Engine';

  const baseSteps = buildSafetyReasoningSteps(
    params,
    telemetry,
    matched,
    unitSystem,
    'chat',
    markers,
    backendLabel,
    manualExtinguish,
  );

  // Phase 1: AUTHORITY
  if (intent === 'AUTHORITY') {
    return {
      intent,
      content: buildAuthorityReply(question, telemetry, unitSystem, manualExtinguish),
      source: 'Deterministic',
      llmCalled: false,
      reasoningSteps: baseSteps,
      reasoningFailedValidation: false,
      includeTelemetryCard: true,
      counters: nextCounters,
    };
  }

  // Phase 1: OUT_OF_SCOPE
  if (intent === 'OUT_OF_SCOPE') {
    return {
      intent,
      content:
        checkOutOfScopeQuery(question, params, telemetry, matched, unitSystem, manualExtinguish) ??
        buildUnknownReply(telemetry, unitSystem, manualExtinguish),
      source: 'Not modeled',
      llmCalled: false,
      reasoningSteps: baseSteps,
      reasoningFailedValidation: false,
      includeTelemetryCard: true,
      counters: nextCounters,
    };
  }

  // Phase 1: COMPARE_0G_1G
  if (intent === 'COMPARE_0G_1G') {
    return {
      intent,
      content: build0gVs1gComparisonAnswer(effectiveQ, params, telemetry, matched, unitSystem),
      source: 'Deterministic',
      llmCalled: false,
      reasoningSteps: baseSteps,
      reasoningFailedValidation: false,
      includeTelemetryCard: true,
      counters: nextCounters,
    };
  }

  // Phase 1: WHAT_IF
  if (intent === 'WHAT_IF') {
    const whatIfContent =
      buildWhatIfAnswer(effectiveQ, params, telemetry, unitSystem, manualExtinguish) ??
      buildUnknownReply(telemetry, unitSystem, manualExtinguish);
    return {
      intent,
      content: whatIfContent,
      source: 'Deterministic',
      llmCalled: false,
      reasoningSteps: baseSteps,
      reasoningFailedValidation: false,
      includeTelemetryCard: true,
      counters: nextCounters,
    };
  }

  // Phase 1: VALUES
  if (intent === 'VALUES') {
    const valuesContent =
      buildValuesAnswer(
        effectiveQ,
        params,
        telemetry,
        matched,
        unitSystem,
        markers,
        manualExtinguish,
      ) ??
      buildDatasetOrFeatureRuleAnswer(
        effectiveQ,
        params,
        telemetry,
        matched,
        unitSystem,
        markers,
        manualExtinguish,
      ) ??
      buildUnknownReply(telemetry, unitSystem, manualExtinguish);
    return {
      intent,
      content: valuesContent,
      source: 'Deterministic',
      llmCalled: false,
      reasoningSteps: baseSteps,
      reasoningFailedValidation: false,
      includeTelemetryCard: true,
      counters: nextCounters,
    };
  }

  // Phase 1: UNKNOWN
  if (intent === 'UNKNOWN') {
    return {
      intent,
      content: buildUnknownReply(telemetry, unitSystem, manualExtinguish),
      source: 'Deterministic',
      llmCalled: false,
      reasoningSteps: baseSteps,
      reasoningFailedValidation: false,
      includeTelemetryCard: false,
      counters: nextCounters,
    };
  }

  // Phase 1 + Phase 2: EXPLAIN
  const isPreIgnitionQuench =
    telemetry.chamberState === 'STANDBY' &&
    /\b(?:quench|quenched|extinguished|not\s+burning|isn't\s+burning|is\s+not\s+burning)\b/.test(
      effectiveQ,
    );
  const deterministicExplain = buildDeterministicExplainAnswer(
    question,
    params,
    telemetry,
    matched,
    unitSystem,
    markers,
    manualExtinguish,
  );

  // Pre-ignition quench never invokes LLM
  if (isPreIgnitionQuench || !canUseWebLlm || !llmInvoker) {
    return {
      intent,
      content: deterministicExplain,
      source: 'Deterministic',
      llmCalled: false,
      reasoningSteps: baseSteps,
      reasoningFailedValidation: false,
      includeTelemetryCard: true,
      counters: nextCounters,
    };
  }

  // Invoke WebLLM + Phase 4 Output Guards
  nextCounters.llmCalls += 1;
  const sysPrompt = buildTieredSystemPrompt(
    params,
    telemetry,
    matched,
    unitSystem,
    systemPromptBudget,
    manualExtinguish,
  );
  const filteredHistory = recentHistory
    .slice(-4)
    .map((m) => ({ role: m.role, content: m.content }));

  try {
    const rawResult = await llmInvoker([
      { role: 'system', content: sysPrompt },
      ...filteredHistory,
      { role: 'user', content: question },
    ]);

    if (!rawResult || !rawResult.content.trim()) {
      nextCounters.truncationFallback += 1;
      return {
        intent,
        content: deterministicExplain,
        source: 'Deterministic',
        llmCalled: true,
        reasoningSteps: baseSteps,
        reasoningFailedValidation: true,
        reasoningFailureNote: TRUNCATION_VALIDATION_FAILED_NOTE,
        failureCategory: 'truncation',
        includeTelemetryCard: true,
        counters: nextCounters,
      };
    }

    const evaluation = evaluateAuditedReasoningResponse(
      rawResult.content,
      rawResult.finishReason,
      params,
      telemetry,
      matched,
      unitSystem,
      markers,
    );

    const thinkNodes = parseThinkSteps(evaluation.reasoningPath);
    const mergedSteps = thinkNodes.length > 0 ? [...baseSteps, ...thinkNodes] : baseSteps;

    if (evaluation.auditedText) {
      nextCounters.auditPass += 1;
      return {
        intent,
        content: evaluation.auditedText,
        source: 'Local model (figures checked)',
        llmCalled: true,
        reasoningSteps: mergedSteps,
        ...(evaluation.reasoningPath ? { reasoningPath: evaluation.reasoningPath } : {}),
        reasoningFailedValidation: false,
        failureCategory: null,
        includeTelemetryCard: true,
        counters: nextCounters,
      };
    }

    if (evaluation.failureCategory === 'authority') {
      nextCounters.authorityReject += 1;
    } else if (evaluation.failureCategory === 'truncation') {
      nextCounters.truncationFallback += 1;
    } else {
      nextCounters.auditReject += 1;
    }

    return {
      intent,
      content: deterministicExplain,
      source: 'Deterministic',
      llmCalled: true,
      reasoningSteps: mergedSteps,
      ...(evaluation.reasoningPath ? { reasoningPath: evaluation.reasoningPath } : {}),
      reasoningFailedValidation: true,
      reasoningFailureNote:
        evaluation.reasoningFailureNote ?? REASONING_VALIDATION_FAILED_NOTE,
      failureCategory: evaluation.failureCategory ?? 'audit',
      includeTelemetryCard: true,
      counters: nextCounters,
    };
  } catch {
    nextCounters.auditReject += 1;
    return {
      intent,
      content: deterministicExplain,
      source: 'Deterministic',
      llmCalled: true,
      reasoningSteps: baseSteps,
      reasoningFailedValidation: true,
      reasoningFailureNote: REASONING_VALIDATION_FAILED_NOTE,
      failureCategory: 'audit',
      includeTelemetryCard: true,
      counters: nextCounters,
    };
  }
}

export interface InlineSegment {
  text: string;
  isMetricPill: boolean;
}

const METRIC_TOKEN_REGEX =
  /(@[A-Za-z0-9_.-]+|\b(?:TC-[1-6]|P-\d+|D-\d+|SAFFIRE-(?:I|II|III)-\d+|BASS-II-\d+|FLEX-\d+|STD-6001[A-Z0-9-]*)\b|[+-]?\d+(?:\.\d+)?\s*(?:mm\/s|cm\/s|m\/s²|m\/s2|m\/s|ft\/min|in\/min|W\/cm²|W\/cm2|kW\/m²|kW\/m2|W\/m²|W\/m2|BTU\/hr·ft²|BTU\/hr|kPa|Pa|psi|atm|°C|°F|mm|cm|s|W|K|%)(?![A-Za-z])|\b(?:Da\*?|Re)=\d+(?:\.\d+)?)/g;

/**
 * Pure tokenizer splitting text into plain prose and inline monospace metric/citation pills.
 */
export function tokenizeInlineMetricPills(line: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let lastIdx = 0;
  METRIC_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = METRIC_TOKEN_REGEX.exec(line);
  while (match !== null) {
    if (match.index > lastIdx) {
      segments.push({ text: line.slice(lastIdx, match.index), isMetricPill: false });
    }
    segments.push({ text: match[0], isMetricPill: true });
    lastIdx = match.index + match[0].length;
    match = METRIC_TOKEN_REGEX.exec(line);
  }
  if (lastIdx < line.length) {
    segments.push({ text: line.slice(lastIdx), isMetricPill: false });
  }
  return segments.length > 0 ? segments : [{ text: line, isMetricPill: false }];
}
