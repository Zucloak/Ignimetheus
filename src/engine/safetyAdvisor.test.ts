import test from 'node:test';
import assert from 'node:assert/strict';
import experimentsJson from '../data/nasaPsiExperiments.json';
import {
  auditLlmAuthority,
  auditLlmNumbers,
  buildGroundedChatAnswer,
  buildLiveContextSystemPrompt,
  buildSafetyReasoningSteps,
  buildTieredSystemPrompt,
  buildVerifiedSafetySnapshot,
  checkOutOfScopeQuery,
  evaluateAuditedReasoningResponse,
  extractThoughtAndAnswer,
  formatExperimentPsiAndDoi,
  formatPsiCitation,
  isWhyOrExplainIntent,
  matchClosestReferenceForParams,
  NUMERIC_GUARDRAIL_INSTRUCTION,
  parseThinkSteps,
  quickRuleMatch,
  REASONING_VALIDATION_FAILED_NOTE,
  STD_6001_DISCLAIMER_SHORT,
  tokenizeInlineMetricPills,
  trimToLastCompleteSentence,
} from './safetyAdvisor';
import {
  computeThermoTelemetry,
  getInitialChamberForParams,
  matchClosestExperiment,
  MISSION_PRESETS,
  resetChamberToStandby,
  stepChamberTransient,
  triggerIgniterPulse,
  type NasaPsiExperiment,
} from './thermoCore';

const experiments = experimentsJson as NasaPsiExperiment[];

test('live context system prompt injects conversational framing, [TELEMETRY] snapshot, and matched NASA PSI run ID', () => {
  const params = MISSION_PRESETS[1].params; // Orion / Artemis 34% O2
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);
  const sys = buildLiveContextSystemPrompt(params, telemetry, matched, 'nasa-psi');

  assert.ok(sys.includes('Ignimetheus Telemetry Assistant'));
  assert.ok(sys.includes('[TELEMETRY]'));
  assert.ok(!sys.includes('always reference the live chamber values'));
  assert.ok(sys.includes('34.0%'));
  assert.ok(sys.includes('56.5 kPa'));
  assert.ok(sys.includes('BASS-II-45'));
  assert.ok(sys.includes('Critical Runaway'));
  assert.ok(sys.includes('(pending verification)'));
  assert.ok(sys.includes(NUMERIC_GUARDRAIL_INSTRUCTION));
});

test('grounded chat responder answers quick questions and custom queries with live telemetry', () => {
  const params = MISSION_PRESETS[2].params; // Ventilation Shutdown 0 cm/s
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);

  const quenchAns = buildGroundedChatAnswer(
    'Why does 0 cm/s quench in 0g?',
    params,
    telemetry,
    matched,
    'nasa-psi',
  );
  assert.ok(quenchAns.toLowerCase().includes('radiative'));
  assert.ok(quenchAns.includes(matched.experiment.id));

  const compare1g = buildGroundedChatAnswer(
    'Compare with Earth 1g test',
    params,
    telemetry,
    matched,
    'nasa-psi',
  );
  assert.ok(compare1g.includes('NASA-STD-6001'));
  assert.ok(compare1g.includes(STD_6001_DISCLAIMER_SHORT));
  assert.ok(compare1g.includes('0G TELEMETRY:'));
  assert.ok(compare1g.includes('1G TELEMETRY:'));

  const suppress = buildGroundedChatAnswer(
    'Recommend mitigation levers',
    params,
    telemetry,
    matched,
    'nasa-psi',
  );
  assert.ok(suppress.includes('Mitigation levers modeled in this simulation'));
  assert.ok(suppress.includes('FLOW LEVER:'));
  assert.ok(suppress.includes('O2 / N2 LEVER:'));
  assert.ok(!/HVAC trip|N2 cabin bleed|CO2 extinguisher/i.test(suppress));
});

test('verified safety snapshot reflects STANDBY (not ignited yet), IGNITING (80W), and SELF_EXTINGUISHED states', () => {
  const issParams = MISSION_PRESETS[0].params;
  const matchedIss = matchClosestReferenceForParams(issParams, experiments);

  const standbySnap = buildVerifiedSafetySnapshot(
    issParams,
    computeThermoTelemetry(issParams, resetChamberToStandby()),
    matchedIss,
    'nasa-psi',
  );
  assert.equal(standbySnap.hazardLevel, 'NOMINAL');
  assert.ok(standbySnap.summary.includes('not ignited yet'));
  assert.ok(standbySnap.rawText.includes('Mitigation levers modeled in this simulation:'));
  assert.ok(!/HVAC trip|N2 cabin bleed|CO2 extinguisher/i.test(standbySnap.rawText));

  const ignitingChamber = stepChamberTransient(triggerIgniterPulse(resetChamberToStandby()), 1.0, issParams);
  const ignSnap = buildVerifiedSafetySnapshot(
    issParams,
    computeThermoTelemetry(issParams, ignitingChamber),
    matchedIss,
    'nasa-psi',
  );
  assert.equal(ignSnap.hazardLevel, 'ELEVATED');
  assert.ok(ignSnap.summary.includes('80 W'));

  const earthParams = MISSION_PRESETS[3].params;
  const matchedEarth = matchClosestReferenceForParams(earthParams, experiments);
  const extChamber = stepChamberTransient(triggerIgniterPulse(resetChamberToStandby()), 3.6, earthParams);
  const extSnap = buildVerifiedSafetySnapshot(
    earthParams,
    computeThermoTelemetry(earthParams, extChamber),
    matchedEarth,
    'nasa-psi',
  );
  assert.equal(extSnap.hazardLevel, 'EXTINGUISHED');
  assert.ok(extSnap.summary.includes('Self-Extinguished (Below Flammability Limit)'));
});

test('grounded chat responder resolves @TC-1..6, @SAFFIRE-II-07, @SAFFIRE-II-03 absence, @BASS-II-14, and @FLEX citations', () => {
  const params = MISSION_PRESETS[0].params;
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);

  const tcAns = buildGroundedChatAnswer('Analyze @TC-1..6 gradient', params, telemetry, matched, 'nasa-psi');
  assert.ok(tcAns.includes('TC-1:'));
  assert.ok(tcAns.includes('TC-6:'));

  const saffire07Ans = buildGroundedChatAnswer('Cite @SAFFIRE-II-07', params, telemetry, matched, 'nasa-psi');
  assert.ok(saffire07Ans.includes('SAFFIRE-II-07'));
  assert.ok(saffire07Ans.includes('(pending verification)'));

  const saffire03Ans = buildGroundedChatAnswer('Cite @SAFFIRE-II-03', params, telemetry, matched, 'nasa-psi');
  assert.ok(saffire03Ans.includes('SAFFIRE-II-03'));
  assert.ok(saffire03Ans.includes('Not in Loaded Dataset'));
  assert.ok(saffire03Ans.includes('SAFFIRE-II-07'));

  const bassAns = buildGroundedChatAnswer('Cite @BASS-II-14', params, telemetry, matched, 'nasa-psi');
  assert.ok(bassAns.includes('BASS-II-14'));
  assert.ok(bassAns.includes('1.22 mm/s'));
  assert.ok(bassAns.includes('(pending verification)'));

  const flexAns = buildGroundedChatAnswer('Explain @FLEX', params, telemetry, matched, 'nasa-psi');
  assert.ok(flexAns.includes('FLEX'));
  assert.ok(flexAns.includes('excludes out-of-scope FLEX droplet records'));
});

test('tokenizeInlineMetricPills separates prose and monospace metric/citation tokens cleanly', () => {
  const segments = tokenizeInlineMetricPills(
    'Matched BASS-II-14 at 21.0% O2 and 15.0 cm/s (Da=1.42) with @TC-1..6.',
  );
  const pills = segments.filter((s) => s.isMetricPill).map((s) => s.text);
  assert.ok(pills.includes('BASS-II-14'));
  assert.ok(pills.includes('21.0%'));
  assert.ok(pills.includes('15.0 cm/s'));
  assert.ok(pills.includes('Da=1.42'));
  assert.ok(pills.includes('@TC-1..6.'));
});

test('buildSafetyReasoningSteps encodes live telemetry, geometry, hardware, and NASA PSI match', () => {
  const params = {
    ...MISSION_PRESETS[0].params,
    specimenGeometry: 'channel' as const,
    hardware: { wakeBaffle: true, flameArrestor: false, inertNozzle: true },
  };
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);
  const steps = buildSafetyReasoningSteps(
    params,
    telemetry,
    matched,
    'nasa-psi',
    'diagnostic',
    [{ kind: 'point', id: 'P-1', xMm: 200, yMm: 0 }],
    'Deterministic Telemetry Engine',
  );

  assert.equal(steps.length, 4);
  assert.ok(steps[0].label.includes('Avionics Channel'));
  assert.ok(steps[1].detail?.includes('Wake Baffle'));
  assert.ok(steps[1].detail?.includes('N2 Nozzle Armed'));
  assert.ok(steps[2].label.includes(matched.experiment.id));
  assert.ok(steps[3].label.includes('Evaluating mitigation levers modeled in this simulation'));
  assert.ok(steps[3].detail?.includes('1 active CAD marker'));
});

test('quickRuleMatch fast-path routes standard telemetry queries and returns null on open-ended why/explain prompts', () => {
  const params = MISSION_PRESETS[0].params;
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);
  const markers = [{ kind: 'point' as const, id: 'P-1', xMm: 210, yMm: 0 }];

  const probeHit = quickRuleMatch('Inspect @P-1 probe', params, telemetry, matched, 'nasa-psi', markers);
  assert.ok(probeHit && probeHit.includes('CAD Sensor Probe P-1'));

  const tcHit = quickRuleMatch('Read @TC-1..6 sensors', params, telemetry, matched, 'nasa-psi', markers);
  assert.ok(tcHit && tcHit.includes('Live Thermocouple Array'));

  const orionHit = quickRuleMatch('Explain Orion / Artemis 34% O2 hazard', params, telemetry, matched, 'nasa-psi');
  assert.ok(orionHit && orionHit.includes('Orion / Artemis Exploration Atmosphere'));

  const mitigationHit = quickRuleMatch('How do N2 suppression and Flame Arrestor mesh work?', params, telemetry, matched, 'nasa-psi');
  assert.ok(mitigationHit && mitigationHit.includes('Mitigation levers modeled in this simulation'));
  assert.ok(mitigationHit && mitigationHit.includes('FLOW LEVER:'));

  const openEnded = quickRuleMatch('Explain boundary-layer flame dynamics conceptually', params, telemetry, matched, 'nasa-psi');
  assert.equal(openEnded, null);
});

test('checkOutOfScopeQuery intercepts unmodeled toxic ppm, evacuation, depressurization, and certification queries', () => {
  const params = MISSION_PRESETS[0].params;
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);

  const toxicAns = checkOutOfScopeQuery('What is the HCN and CO ppm concentration?', params, telemetry, matched, 'nasa-psi');
  assert.ok(toxicAns && toxicAns.includes('Not modeled in this 1D thermo-fluids solver'));

  const evacAns = checkOutOfScopeQuery('What is the crew evacuation time from the module?', params, telemetry, matched, 'nasa-psi');
  assert.ok(evacAns && evacAns.includes('Not modeled in this 1D thermo-fluids solver'));

  const certAns = checkOutOfScopeQuery('Is this material formally certified for flight?', params, telemetry, matched, 'nasa-psi');
  assert.ok(certAns && certAns.includes('Not modeled in this 1D thermo-fluids solver'));

  const arcAns = checkOutOfScopeQuery('What electrical arc energy in mJ ignited the sample?', params, telemetry, matched, 'nasa-psi');
  assert.ok(arcAns && arcAns.includes('Not modeled in this 1D thermo-fluids solver'));

  const inScopeAns = checkOutOfScopeQuery('Compare 0g vs 1g LOI margin', params, telemetry, matched, 'nasa-psi');
  assert.equal(inScopeAns, null);
});

test('auditLlmNumbers passes exact/rounded telemetry numbers and rejects fabricated numbers', () => {
  const params = MISSION_PRESETS[0].params; // 21.0% O2, 101.3 kPa, 15.0 cm/s, 0.00g
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);

  const validOutput = `FLOW LEVER: Reduce 120 mm duct flow from 15.0 cm/s to 0 cm/s at 21.0% O2 and 101.3 kPa. Spread is 1.82 mm/s vs NASA-STD-6001 152.4 mm reference criterion (BASS-II-14 baseline 1.22 mm/s over 300 mm coupon).`;
  const passAudit = auditLlmNumbers(validOutput, params, telemetry, matched, 'nasa-psi');
  assert.equal(passAudit.passed, true);
  assert.deepEqual(passAudit.rejectedNumbers, []);

  const hallucinatedOutput = `At 19.7% O2 and 84.3 kPa, the flame spreads at 4.65 mm/s across 512 mm.`;
  const failAudit = auditLlmNumbers(hallucinatedOutput, params, telemetry, matched, 'nasa-psi');
  assert.equal(failAudit.passed, false);
  assert.ok(failAudit.rejectedNumbers.includes(19.7));
  assert.ok(failAudit.rejectedNumbers.includes(84.3));
  assert.ok(failAudit.rejectedNumbers.includes(4.65));
});

test('trimToLastCompleteSentence trims truncated LLM output cleanly and buildTieredSystemPrompt includes guardrail', () => {
  assert.equal(
    trimToLastCompleteSentence('Isolate duct flow. Reduce O2 below 15.6% LOI. Maintain standby on'),
    'Isolate duct flow. Reduce O2 below 15.6% LOI.',
  );

  const params = MISSION_PRESETS[0].params;
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);
  for (const budget of ['compact', 'standard', 'full'] as const) {
    const prompt = buildTieredSystemPrompt(params, telemetry, matched, 'nasa-psi', budget);
    assert.ok(prompt.includes(NUMERIC_GUARDRAIL_INSTRUCTION));
  }
});

test('extractThoughtAndAnswer isolates <think> blocks and excludes scratchpad numbers from numeric audit', () => {
  const rawWithScratchpad = [
    '<think>',
    'Checking ratio 21.0 / 15.6 = 1.346 and hypothetical delta 999.9 mm/s.',
    '</think>',
    'FLOW LEVER: Reduce 120 mm duct flow from 15.0 cm/s to 0 cm/s at 21.0% O2 and 101.3 kPa (BASS-II-14).',
  ].join('\n');

  const extracted = extractThoughtAndAnswer(rawWithScratchpad);
  assert.equal(
    extracted.reasoningPath,
    'Checking ratio 21.0 / 15.6 = 1.346 and hypothetical delta 999.9 mm/s.',
  );
  assert.ok(!extracted.answer.includes('<think>'));
  assert.ok(!extracted.answer.includes('999.9'));
  assert.equal(extracted.hasUnclosedThink, false);

  const params = MISSION_PRESETS[0].params;
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);

  const passedEval = evaluateAuditedReasoningResponse(
    rawWithScratchpad,
    'stop',
    params,
    telemetry,
    matched,
    'nasa-psi',
  );
  assert.ok(passedEval.auditedText);
  assert.equal(passedEval.reasoningFailedValidation, false);
  assert.equal(passedEval.reasoningPath, extracted.reasoningPath);

  const emptyThink = extractThoughtAndAnswer('<think>\n\n</think>\n\nFinal grounded answer.');
  assert.equal(emptyThink.reasoningPath, null);
  assert.equal(emptyThink.answer, 'Final grounded answer.');

  const unclosedThink = extractThoughtAndAnswer('<think>Partial reasoning 42.5');
  assert.equal(unclosedThink.hasUnclosedThink, true);
  assert.equal(unclosedThink.reasoningPath, 'Partial reasoning 42.5');
  assert.equal(unclosedThink.answer, '');
});

test('evaluateAuditedReasoningResponse preserves rejected <think> path with fallback warning when audit fails', () => {
  const params = MISSION_PRESETS[0].params;
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);

  const hallucinatedWithThink = [
    '<think>Evaluating boundary layer at 21.0% O2 and 15.0 cm/s.</think>',
    'At 19.7% O2 and 84.3 kPa, spread reaches 4.65 mm/s.',
  ].join('\n');

  const failedEval = evaluateAuditedReasoningResponse(
    hallucinatedWithThink,
    'stop',
    params,
    telemetry,
    matched,
    'nasa-psi',
  );

  assert.equal(failedEval.auditedText, null);
  assert.equal(
    failedEval.reasoningPath,
    'Evaluating boundary layer at 21.0% O2 and 15.0 cm/s.',
  );
  assert.equal(failedEval.reasoningFailedValidation, true);
  assert.equal(failedEval.reasoningFailureNote, REASONING_VALIDATION_FAILED_NOTE);
  assert.equal(failedEval.auditResult?.passed, false);
});

test('authority filter blocks safe/unsafe/within safe limits/certified/guarantee in LLM output', () => {
  const params = MISSION_PRESETS[0].params;
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);

  for (const forbidden of [
    'This condition is safe for crew operations.',
    'The test is unsafe right now.',
    'Parameters are within safe limits at 21.0% O2.',
    'The material is certified for flight.',
    'I guarantee this will not ignite.',
  ]) {
    const auth = auditLlmAuthority(forbidden);
    assert.equal(auth.passed, false, `Expected authority filter to block: ${forbidden}`);

    const evaluated = evaluateAuditedReasoningResponse(
      forbidden,
      'stop',
      params,
      telemetry,
      matched,
      'nasa-psi',
    );
    assert.equal(evaluated.auditedText, null);
    assert.equal(evaluated.reasoningFailedValidation, true);
  }

  // "safety" (noun) must pass authority filter cleanly
  assert.equal(auditLlmAuthority("I can't assess safety. In this simulation: LOI margin +5.4%.").passed, true);
});

test('matchClosestReferenceForParams excludes out-of-scope FLEX records for solid fuels and retains them for droplet geometry', () => {
  const ventShutdownParams = MISSION_PRESETS[2].params; // rod/cellulose quiescent
  const solidMatch = matchClosestReferenceForParams(ventShutdownParams, experiments);
  assert.notEqual(solidMatch.experiment.program, 'FLEX');
  assert.equal(matchClosestExperiment(ventShutdownParams, experiments).experiment.program, 'FLEX');

  const dropletMatch = matchClosestReferenceForParams(
    { ...ventShutdownParams, specimenGeometry: 'droplet' },
    experiments,
  );
  assert.equal(dropletMatch.experiment.program, 'FLEX');
});

test('PSI IDs and DOIs always include (pending verification)', () => {
  assert.ok(formatPsiCitation('NASA PSI-25 / BASS-II').includes('(pending verification)'));
  assert.ok(formatPsiCitation('DOI 10.60555/2e0d-9d0a').includes('(pending verification)'));
  for (const exp of experiments) {
    const formatted = formatExperimentPsiAndDoi(exp);
    if (exp.psiInvestigationId || exp.doi || /PSI-\d+|10\.\d{4,9}\//.test(exp.psiCitation)) {
      assert.ok(
        formatted.includes('(pending verification)'),
        `Missing (pending verification) on ${exp.id}: ${formatted}`,
      );
    }
  }
});

test('STD-6001 152 mm statements carry 0g duct configuration disclaimer and avoid Material passed/failed phrasing', () => {
  const params = MISSION_PRESETS[0].params;
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);

  const stdAns = buildGroundedChatAnswer(
    'Analyze NASA-STD-6001 152 mm verdict',
    params,
    telemetry,
    matched,
    'nasa-psi',
  );
  assert.ok(stdAns.includes('152'));
  assert.ok(stdAns.includes(STD_6001_DISCLAIMER_SHORT));
  assert.ok(!/Material (?:passed|failed) the criterion/i.test(stdAns));
});

test('pre-ignition STANDBY state states not ignited yet and handles "Why is this run quenched?" deterministically', () => {
  const params = MISSION_PRESETS[2].params; // Vent Shutdown 0 cm/s
  const standbyTelemetry = computeThermoTelemetry(params, resetChamberToStandby());
  const matched = matchClosestReferenceForParams(params, experiments);

  const ans = quickRuleMatch(
    'Why is this run quenched?',
    params,
    standbyTelemetry,
    matched,
    'nasa-psi',
  );
  assert.ok(ans, 'Expected deterministic fast-path answer for pre-ignition quenched query');
  assert.ok(ans.includes('not ignited yet'));
  assert.ok(ans.includes('LOI margin'));
  assert.ok(ans.toLowerCase().includes('flow'));
  assert.ok(ans.toLowerCase().includes('if ignited'));
});

test('intent router restricts WebLLM exclusively to why/explain prompts', () => {
  assert.equal(isWhyOrExplainIntent('Why does radiative cooling quench a 0g droplet?'), true);
  assert.equal(isWhyOrExplainIntent('Explain boundary-layer thinning in 0g flow'), true);

  for (const nonLlmPrompt of [
    'hello there',
    'Is the current one safe?',
    'Give me the spread rate, O2 percent, flow velocity and pressure in one sentence.',
    'What does @P-1 read, and what does @TC-3 read?',
    'Convert the spread rate to cm/s and to m/s.',
    'If I add N2 suppression, what changes?',
    'Compare this scenario in 0g and 1g.',
    'Run Protocol Diagnostic for current chamber telemetry.',
  ]) {
    assert.equal(
      isWhyOrExplainIntent(nonLlmPrompt),
      false,
      `Expected WebLLM intent router to return false for: ${nonLlmPrompt}`,
    );
  }
});

test('Requirement 13 exact prompt replays match deterministic safety, compound, probe, unit, N2, and 0g/1g contracts', () => {
  const params = MISSION_PRESETS[0].params;
  const burningChamber = getInitialChamberForParams(params);
  const burningTelemetry = computeThermoTelemetry(params, burningChamber);
  const matched = matchClosestReferenceForParams(params, experiments, burningTelemetry);

  // Replay 1: "Is the current one safe?"
  const q1 = 'Is the current one safe?';
  const a1 = quickRuleMatch(q1, params, burningTelemetry, matched, 'nasa-psi');
  assert.ok(a1);
  assert.equal(isWhyOrExplainIntent(q1), false);
  assert.equal(auditLlmAuthority(a1).passed, true); // no "safe" or "unsafe"
  assert.ok(!/\bunsafe\b|\bsafe\b/i.test(a1));
  assert.ok(a1.includes('LOI margin'));
  assert.ok(a1.includes('flame state'));

  // Replay 2: "Give me the spread rate, O2 percent, flow velocity and pressure in one sentence."
  const q2 = 'Give me the spread rate, O2 percent, flow velocity and pressure in one sentence.';
  const a2 = quickRuleMatch(q2, params, burningTelemetry, matched, 'nasa-psi');
  assert.ok(a2);
  assert.equal(isWhyOrExplainIntent(q2), false);
  assert.ok(a2.includes('1.82 mm/s'));
  assert.ok(a2.includes('21.0%'));
  assert.ok(a2.includes('15.0 cm/s'));
  assert.ok(a2.includes('101.3 kPa'));
  assert.equal(a2.includes('\n'), false); // single sentence

  // Replay 3a (P-1 absent) & Replay 3b (P-1 placed): "What does @P-1 read, and what does @TC-3 read?"
  const q3 = 'What does @P-1 read, and what does @TC-3 read?';
  assert.equal(isWhyOrExplainIntent(q3), false);
  const a3NoProbe = quickRuleMatch(q3, params, burningTelemetry, matched, 'nasa-psi', []);
  assert.ok(a3NoProbe);
  assert.ok(a3NoProbe.includes('P-1'));
  assert.ok(a3NoProbe.toLowerCase().includes('not placed'));
  assert.ok(a3NoProbe.includes('TC-3'));

  const a3WithProbe = quickRuleMatch(q3, params, burningTelemetry, matched, 'nasa-psi', [
    { kind: 'point', id: 'P-1', xMm: 210, yMm: 0 },
  ]);
  assert.ok(a3WithProbe);
  assert.ok(a3WithProbe.includes('CAD Probe P-1'));
  assert.ok(a3WithProbe.includes('TC-3'));

  // Replay 4: "Convert the spread rate to cm/s and to m/s."
  const q4 = 'Convert the spread rate to cm/s and to m/s.';
  const a4 = quickRuleMatch(q4, params, burningTelemetry, matched, 'nasa-psi');
  assert.ok(a4);
  assert.equal(isWhyOrExplainIntent(q4), false);
  assert.ok(a4.includes('cm/s'));
  assert.ok(a4.includes('m/s'));

  // Replay 5: "If I add N2 suppression, what changes?"
  const q5 = 'If I add N2 suppression, what changes?';
  const a5 = quickRuleMatch(q5, params, burningTelemetry, matched, 'nasa-psi');
  assert.ok(a5);
  assert.equal(isWhyOrExplainIntent(q5), false);
  assert.ok(a5.includes('Before') && a5.includes('-> After'));
  assert.ok(a5.includes('21.0%'));
  assert.ok(a5.includes('13.0%'));

  // Replay 6: "Compare this scenario in 0g and 1g."
  const q6 = 'Compare this scenario in 0g and 1g.';
  const a6 = quickRuleMatch(q6, params, burningTelemetry, matched, 'nasa-psi');
  assert.ok(a6);
  assert.equal(isWhyOrExplainIntent(q6), false);
  assert.ok(a6.includes('0G TELEMETRY:'));
  assert.ok(a6.includes('1G TELEMETRY:'));
  assert.ok(a6.includes(STD_6001_DISCLAIMER_SHORT));
});

test('conversational responses with zero numbers pass numeric audit cleanly without fallback', () => {
  const params = MISSION_PRESETS[0].params;
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);

  const greetingReply =
    'Hello! I am the Ignimetheus Spacecraft Fire Safety Officer. How can I assist you with microgravity combustion or cabin fire safety today?';
  const audit = auditLlmNumbers(greetingReply, params, telemetry, matched, 'nasa-psi');
  assert.equal(audit.passed, true);
  assert.deepEqual(audit.extractedNumbers, []);
  assert.deepEqual(audit.rejectedNumbers, []);

  const evaluated = evaluateAuditedReasoningResponse(
    '<think>\nThe user greeted me casually. No telemetry dump is needed.\n\nKeep the tone concise and professional.\n</think>\nHello! How can I help with spacecraft fire safety today?',
    'stop',
    params,
    telemetry,
    matched,
    'nasa-psi',
  );
  assert.equal(
    evaluated.auditedText,
    'Hello! How can I help with spacecraft fire safety today?',
  );
  assert.equal(evaluated.reasoningFailedValidation, false);

  const nodes = parseThinkSteps(evaluated.reasoningPath);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].id, 'think-0');
  assert.equal(nodes[0].label, 'The user greeted me casually. No telemetry dump is needed.');
  assert.equal(nodes[1].label, 'Keep the tone concise and professional.');
});

test('parseThinkSteps and extractThoughtAndAnswer strip all emojis from reasoning nodes and assistant text', () => {
  const raw = '<think>🔍 Step one: check flow.\n- 🔥 Step two: verify quench.</think>\nHello there! 🚀';
  const extracted = extractThoughtAndAnswer(raw);
  assert.equal(extracted.answer, 'Hello there!');
  const nodes = parseThinkSteps(extracted.reasoningPath);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].label, 'Step one: check flow.');
  assert.equal(nodes[1].label, 'Step two: verify quench.');
});

test('greetings bypass quickRuleMatch and WebLLM, returning deterministic conversational reply without dumping telemetry', () => {
  const params = MISSION_PRESETS[0].params;
  const telemetry = computeThermoTelemetry(params);
  const matched = matchClosestReferenceForParams(params, experiments);

  assert.equal(
    quickRuleMatch('hello there', params, telemetry, matched, 'nasa-psi'),
    null,
  );
  assert.equal(isWhyOrExplainIntent('hello there'), false);

  const fallbackGreeting = buildGroundedChatAnswer(
    'hello there',
    params,
    telemetry,
    matched,
    'nasa-psi',
  );
  assert.ok(fallbackGreeting.includes('Hello!') && fallbackGreeting.includes('Ask me about this simulation'));
  assert.ok(!fallbackGreeting.includes('Live Telemetry Assessment'));
  assert.ok(!fallbackGreeting.includes('101.3'));
});
