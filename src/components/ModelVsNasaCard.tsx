import React, { useMemo, useState } from 'react';
import {
  computeExperimentComparison,
  computeHeldOutMeanAbsoluteErrorPct,
  NASA_COMPARISON_FOOTNOTE,
  NASA_COMPARISON_HEADLINE,
} from '../engine/nasaComparison';
import type { NasaPsiExperiment } from '../engine/thermoCore';

export interface ModelVsNasaCardProps {
  experiment: NasaPsiExperiment | null;
  allExperiments: NasaPsiExperiment[];
  onPrevRun?: () => void;
  onNextRun?: () => void;
  placement?: 'inspector' | 'stage';
  defaultCollapsed?: boolean;
}

const BOX = 'rounded-lg border border-[#1F1F24] bg-[#0C0C0E] px-2.5 py-2';
const LBL = 'text-[10px] font-mono uppercase tracking-wider text-[#71717A]';
const CHIP = 'rounded border border-[#27272A] bg-[#18181C] px-1.5 py-0.5 font-mono';
const BTN = `${CHIP} text-[10px] font-medium text-[#E4E4E7] hover:bg-[#27272A] cursor-pointer`;
const GRID2 = 'grid grid-cols-2 max-[430px]:grid-cols-1 gap-2';

export const ModelVsNasaCard: React.FC<ModelVsNasaCardProps> = ({
  experiment,
  allExperiments,
  onPrevRun,
  onNextRun,
  placement = 'inspector',
  defaultCollapsed = false,
}) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const c = useMemo(() => (experiment ? computeExperimentComparison(experiment) : null), [experiment]);
  const heldOut = useMemo(() => computeHeldOutMeanAbsoluteErrorPct(allExperiments), [allExperiments]);

  if (!c) return null;

  const scaleMax = Math.max(c.nasaSpreadMmS, c.modelSpreadMmS, 0.5);
  const bars = [
    ['NASA', c.nasaSpreadText, c.nasaSpreadMmS, 'bg-[#71717A]', 'model-vs-nasa-bar-nasa'],
    ['model', c.modelSpreadText, c.modelSpreadMmS, 'bg-[#E4E4E7]', 'model-vs-nasa-bar-model'],
  ] as const;

  return (
    <section
      aria-label="Model vs NASA readout"
      data-testid="model-vs-nasa-section"
      data-record-id={c.experiment.id}
      className={placement === 'stage' ? 'mx-auto w-full max-w-4xl px-3 sm:px-5 pt-2.5 pb-1' : 'px-3.5 py-2.5'}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <p data-testid="model-vs-nasa-headline" className="text-[11px] font-medium text-[#D4D4D8] leading-snug">
          {NASA_COMPARISON_HEADLINE}
        </p>
        {placement === 'stage' && (
          <button
            type="button"
            data-testid="model-vs-nasa-collapse-btn"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand Model vs NASA readout' : 'Collapse Model vs NASA readout'}
            onClick={() => setCollapsed((v) => !v)}
            className={`${BTN} shrink-0`}
          >
            {collapsed ? `Show (${c.experiment.id})` : 'Collapse'}
          </button>
        )}
      </div>

      {!collapsed && (
        <div data-testid="model-vs-nasa-card" className="rounded-xl border border-[#27272A] bg-[#111114] p-2.5 flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <span data-testid="model-vs-nasa-id" className="font-mono text-xs font-semibold text-[#F4F4F5]">
                {c.experiment.id}
              </span>
              <span data-testid="model-vs-nasa-role-badge" className={`${CHIP} text-[9px] text-[#D4D4D8]`}>
                {c.role}
              </span>
            </div>
            {(onPrevRun || onNextRun) && (
              <div className="flex items-center gap-1 shrink-0">
                {onPrevRun && (
                  <button type="button" data-testid="prev-nasa-run-btn" aria-label="Previous NASA run" onClick={onPrevRun} className={BTN}>
                    Previous
                  </button>
                )}
                {onNextRun && (
                  <button type="button" data-testid="next-nasa-run-btn" aria-label="Next NASA run" onClick={onNextRun} className={BTN}>
                    Next NASA run
                  </button>
                )}
              </div>
            )}
          </div>

          <div data-testid="model-vs-nasa-conditions" className="font-mono text-[10px] text-[#A1A1AA] leading-snug">
            {c.conditionSummary}
          </div>

          <div data-testid={c.isExtinctionCheck ? 'model-vs-nasa-extinction-outcomes' : undefined} className={GRID2}>
            <div className={BOX}>
              <div className={LBL}>NASA published</div>
              <div
                data-testid={c.isExtinctionCheck ? 'model-vs-nasa-nasa-outcome' : 'model-vs-nasa-nasa-value'}
                className={`mt-0.5 ${c.isExtinctionCheck ? 'text-xs' : 'font-mono text-sm tabular-nums'} font-semibold text-[#E4E4E7]`}
              >
                {c.isExtinctionCheck ? c.nasaOutcomeText : c.nasaSpreadText}
              </div>
              <div className="mt-1 text-[10px] text-[#71717A] leading-tight">{c.sourceLine}</div>
            </div>

            <div className={BOX}>
              <div className={`flex items-start justify-between gap-1 leading-tight ${LBL}`}>
                <span>Model (steady state)</span>
                <span className={`${CHIP} px-1 py-0 text-[9px] lowercase text-[#A1A1AA] shrink-0`}>model</span>
              </div>
              <div
                data-testid={c.isExtinctionCheck ? 'model-vs-nasa-model-outcome' : 'model-vs-nasa-model-value'}
                className={`mt-0.5 ${c.isExtinctionCheck ? 'text-xs' : 'font-mono text-sm tabular-nums'} font-semibold text-[#F4F4F5]`}
              >
                {c.isExtinctionCheck ? c.modelOutcomeText : c.modelSpreadText}
              </div>
              {c.isExtinctionCheck ? (
                <div data-testid="model-vs-nasa-model-value" className="mt-1 font-mono text-[10px] tabular-nums text-[#A1A1AA]">
                  {c.modelSpreadText}
                </div>
              ) : (
                c.signedErrorText &&
                c.ratioText && (
                  <div data-testid="model-vs-nasa-error-ratio" className="mt-1 font-mono text-[10px] tabular-nums text-[#D4D4D8]">
                    {c.signedErrorText} · {c.ratioText}
                  </div>
                )
              )}
            </div>
          </div>

          <div data-testid="model-vs-nasa-bars" className={`${GRID2} ${BOX}`}>
            {bars.map(([label, val, v, barBg, tid]) => (
              <div key={label} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-1 font-mono text-[10px] text-[#D4D4D8]">
                  <span>{label}</span>
                  <span className="tabular-nums">{val}</span>
                </div>
                <div className="h-2 w-full rounded bg-[#18181C] overflow-hidden">
                  <div data-testid={tid} style={{ width: `${Math.min(100, (v / scaleMax) * 100).toFixed(1)}%` }} className={`h-full ${barBg}`} />
                </div>
              </div>
            ))}
          </div>

          {heldOut && (
            <div data-testid="model-vs-nasa-heldout-mae" className="font-mono text-[10px] tabular-nums text-[#D4D4D8]">
              {heldOut.line}
            </div>
          )}

          <p data-testid="model-vs-nasa-footnote" className="text-[10px] leading-snug text-[#71717A] border-t border-[#1F1F24] pt-1.5">
            {NASA_COMPARISON_FOOTNOTE}
          </p>
        </div>
      )}
    </section>
  );
};
