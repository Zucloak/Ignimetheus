import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import experimentsJson from '../data/nasaPsiExperiments.json';
import { ModelVsNasaCard } from '../components/ModelVsNasaCard';
import {
  computeExperimentComparison,
  computeHeldOutMeanAbsoluteErrorPct,
  getAdjacentCycleExperiment,
  getParamsForExperiment,
  NASA_COMPARISON_CYCLE_IDS,
  NASA_COMPARISON_FOOTNOTE,
  NASA_COMPARISON_HEADLINE,
} from './nasaComparison';
import {
  computeThermoTelemetry,
  matchClosestExperiment,
  type NasaPsiExperiment,
} from './thermoCore';
import { executeSafetyAdvisorTurn } from './safetyAdvisor';

const EXPERIMENTS = experimentsJson as NasaPsiExperiment[];
const BY_ID = new Map(EXPERIMENTS.map((e) => [e.id, e]));

function decodeHtml(html: string): string {
  return html.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
}

function renderCardHtml(exp: NasaPsiExperiment | null): string {
  return renderToStaticMarkup(
    React.createElement(ModelVsNasaCard, {
      experiment: exp,
      allExperiments: EXPERIMENTS,
      onPrevRun: () => {},
      onNextRun: () => {},
      placement: 'inspector',
    }),
  );
}

test('ModelVsNasaCard matches validation/solver steady-state values for all 6 Saffire records and avoids pass/fail styling', () => {
  const expected: Record<
    string,
    {
      modelMmS: string;
      role: string;
      err?: string;
      ratio?: string;
      isExtinction?: boolean;
    }
  > = {
    'SAFFIRE-I-01': {
      modelMmS: '1.888',
      role: 'Fitted (not a test)',
      err: '(+4.9%)',
      ratio: '1.05x',
    },
    'SAFFIRE-II-05': {
      modelMmS: '2.017',
      role: 'Fitted (not a test)',
      err: '(-3.9%)',
      ratio: '0.96x',
    },
    'SAFFIRE-II-06': {
      modelMmS: '2.296',
      role: 'Held-out',
      err: '(-11.7%)',
      ratio: '0.88x',
    },
    'SAFFIRE-III-01': {
      modelMmS: '2.005',
      role: 'Held-out',
      err: '(-12.8%)',
      ratio: '0.87x',
    },
    'SAFFIRE-II-07': {
      modelMmS: '0.000',
      role: 'Extinction check (calibration-informed)',
      isExtinction: true,
    },
    'SAFFIRE-II-01': {
      modelMmS: '0.000',
      role: 'Extinction check (calibration-informed)',
      isExtinction: true,
    },
  };

  for (const id of NASA_COMPARISON_CYCLE_IDS) {
    const exp = BY_ID.get(id)!;
    const directSolver = computeThermoTelemetry(getParamsForExperiment(exp));
    const directMmS = (directSolver.flameSpreadRateMs * 1000).toFixed(3);
    const spec = expected[id];

    assert.equal(directMmS, spec.modelMmS, `Solver check failed for ${id}`);

    const html = renderCardHtml(exp);
    const text = decodeHtml(html);

    assert.ok(text.includes(NASA_COMPARISON_HEADLINE));
    assert.ok(text.includes(id));
    assert.ok(text.includes(spec.role), `Missing role ${spec.role} for ${id}`);
    assert.ok(text.includes(`${spec.modelMmS} mm/s`), `Missing model value ${spec.modelMmS} for ${id}`);
    assert.ok(text.includes('Urban et al. 2017, Table 1 (published summary)'));
    assert.ok(text.includes(NASA_COMPARISON_FOOTNOTE));
    assert.ok(text.includes('Held-out runs (n = 2): mean absolute error 12.3%'));

    if (spec.isExtinction) {
      assert.equal(directSolver.isBurning, false);
      assert.ok(text.includes('NASA: no sustained spread'));
      assert.ok(text.includes('Model: no sustained spread'));
      assert.ok(!html.includes('model-vs-nasa-error-ratio'));
    } else {
      assert.ok(text.includes(`${exp.observedSpreadRateMmS!.toFixed(2)} mm/s`));
      assert.ok(text.includes(spec.err!));
      assert.ok(text.includes(spec.ratio!));
    }

    // No pass/fail color classes anywhere in card markup
    assert.equal(
      /\b(?:bg|text|border|stroke|fill)-(?:red|rose|green|emerald|amber)-/i.test(html),
      false,
      `Found forbidden pass/fail color class on ${id}`,
    );

    // No forbidden claims ("validated", "verified", "accurate", "proves")
    assert.equal(
      /\b(?:validated|verified|accurate|proves)\b/i.test(text),
      false,
      `Found forbidden claim word on ${id}`,
    );
  }
});

test('ModelVsNasaCard never renders burn length and keeps held-out MAE computed dynamically', () => {
  for (const id of NASA_COMPARISON_CYCLE_IDS) {
    const exp = BY_ID.get(id)!;
    const html = decodeHtml(renderCardHtml(exp));
    assert.equal(/burn\s*length/i.test(html), false);
    assert.equal(/350\s*mm|840\s*mm|290\s*mm|420\s*s|300\s*s/i.test(html), false);
  }

  const fullMae = computeHeldOutMeanAbsoluteErrorPct(EXPERIMENTS);
  assert.ok(fullMae !== null);
  assert.equal(fullMae.count, 2);
  assert.equal(fullMae.formattedPct, '12.3%');

  // If held-out records are absent, runtime held-out summary hides cleanly
  const withoutHeldOut = EXPERIMENTS.filter(
    (e) => e.id !== 'SAFFIRE-II-06' && e.id !== 'SAFFIRE-III-01',
  );
  assert.equal(computeHeldOutMeanAbsoluteErrorPct(withoutHeldOut), null);
});

test('BASS-II-14 shows Adapted Reference (unverified) badge with no error percentage styling', () => {
  const bass14 = BY_ID.get('BASS-II-14')!;
  const html = renderCardHtml(bass14);
  const text = decodeHtml(html);

  assert.ok(text.includes('BASS-II-14'));
  assert.ok(text.includes('Adapted Reference (unverified)'));
  assert.equal(text.includes('(pending verification)'), false);
  assert.ok(text.includes('1.22 mm/s'));
  assert.ok(text.includes('1.824 mm/s'));
  assert.equal(html.includes('model-vs-nasa-error-ratio'), false);
  assert.equal(/49\.5%|1\.49x|1\.50x/.test(text), false);
  assert.equal(/\b(?:bg|text|border)-(?:red|rose|green|emerald|amber)-/i.test(html), false);
  assert.equal(/112\s*mm/.test(text), false);

  const cmp = computeExperimentComparison(bass14)!;
  assert.equal(cmp.role, 'Adapted Reference (unverified)');
  assert.equal(cmp.signedErrorPct, null);
  assert.equal(cmp.signedErrorText, null);
});

test('switching records leaves no stale values and card renders nothing for FLEX and STD-6001 records', () => {
  // Cycle order matches spec
  let cur: NasaPsiExperiment | null = BY_ID.get('SAFFIRE-I-01')!;
  const seen: string[] = [cur.id];
  for (let i = 0; i < 5; i++) {
    cur = getAdjacentCycleExperiment(cur.id, 'next', EXPERIMENTS);
    assert.ok(cur);
    seen.push(cur.id);
  }
  assert.deepEqual(seen, [...NASA_COMPARISON_CYCLE_IDS]);
  assert.equal(getAdjacentCycleExperiment('SAFFIRE-I-01', 'prev', EXPERIMENTS)?.id, 'SAFFIRE-II-01');

  // Render sequence transition leaves zero stale values from prior record
  const firstText = decodeHtml(renderCardHtml(BY_ID.get('SAFFIRE-I-01')!));
  const secondText = decodeHtml(renderCardHtml(BY_ID.get('SAFFIRE-II-06')!));
  const thirdText = decodeHtml(renderCardHtml(BY_ID.get('SAFFIRE-II-07')!));

  assert.ok(firstText.includes('1.888 mm/s') && !firstText.includes('2.296 mm/s'));
  assert.ok(secondText.includes('2.296 mm/s') && !secondText.includes('1.888 mm/s'));
  assert.ok(
    thirdText.includes('NASA: no sustained spread') &&
      !thirdText.includes('2.296 mm/s') &&
      !thirdText.includes('1.888 mm/s'),
  );

  // FLEX and STD-6001 records render nothing
  for (const excludedId of ['FLEX-09', 'FLEX-18', 'STD-6001-1G-NOMEX', 'STD-6001-1G-PMMA']) {
    const html = renderCardHtml(BY_ID.get(excludedId)!);
    assert.equal(html, '', `Expected empty card for ${excludedId}`);
  }
});

test('Telemetry Assistant compare/accuracy queries return exact card numbers, fitted vs held-out split, and footnote with 0 LLM calls', async () => {
  const saffireI01 = BY_ID.get('SAFFIRE-I-01')!;
  const params = getParamsForExperiment(saffireI01);
  const steady = computeThermoTelemetry(params);
  const matched = matchClosestExperiment(params, EXPERIMENTS, steady);
  const cmp = computeExperimentComparison(saffireI01)!;

  for (const prompt of ['how accurate is the model', 'compare to NASA', 'model vs NASA']) {
    let llmCalls = 0;
    const res = await executeSafetyAdvisorTurn({
      question: prompt,
      params,
      telemetry: steady,
      matched,
      unitSystem: 'nasa-psi',
      canUseWebLlm: true,
      llmInvoker: async () => {
        llmCalls += 1;
        return { content: 'Should never be called' };
      },
    });

    assert.equal(res.llmCalled, false, `Expected 0 LLM calls for "${prompt}"`);
    assert.equal(llmCalls, 0);
    assert.equal(res.counters.llmCalls, 0);
    assert.equal(res.source, 'Deterministic');
    assert.ok(res.content.includes(cmp.modelSpreadText));
    assert.ok(res.content.includes(cmp.nasaSpreadText));
    assert.ok(res.content.includes('Fitted (not a test'));
    assert.ok(res.content.includes('Held-out'));
    assert.ok(res.content.includes('Held-out runs (n = 2): mean absolute error 12.3%'));
    assert.ok(res.content.includes(NASA_COMPARISON_FOOTNOTE));
    assert.equal(/840\s*mm|290\s*mm|burn\s*length/i.test(res.content), false);
    assert.equal(/\b(?:validated|verified|accurate|proves)\b/i.test(res.content), false);
  }
});
