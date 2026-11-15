import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  MOBILE_WHAT_TO_TRY_ITEMS,
  ONBOARDING_WELCOME_COPY,
  type OnboardingMode,
  type OnboardingTourStep,
} from '../engine/onboarding';

interface OnboardingProps {
  mode: OnboardingMode;
  isMobile: boolean;
  prefersReducedMotion: boolean;
  currentStep: OnboardingTourStep | null;
  visibleStepPosition: number;
  visibleStepCount: number;
  hasPrevStep: boolean;
  hasNextStep: boolean;
  openedFromHelp: boolean;
  helpTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onDismiss: () => void;
  onStartTour: () => void;
  onOpenValidation: () => void;
  onBackToWelcome: () => void;
  onNextStep: () => void;
  onPrevStep: () => void;
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const CARD_W = 336;
const CARD_H = 188;
const M = 12;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const BTN_PRIMARY =
  'rounded-lg bg-[#F4F4F5] px-3 py-1.5 text-xs font-medium text-[#09090B] hover:bg-white cursor-pointer';
const BTN_SEC =
  'rounded-lg border border-[#27272A] bg-[#18181C] px-2.5 py-1.5 text-xs font-medium text-[#E4E4E7] hover:border-[#3F3F46] cursor-pointer';
const CARD_SURFACE =
  'pointer-events-auto fixed rounded-2xl border border-[#27272A] bg-[#111114]/96 shadow-2xl backdrop-blur-xl focus:outline-none';

function getTourCoords(r: Box, vw: number, vh: number): { top: number; left: number } {
  const w = Math.min(CARD_W, vw - M * 2);
  const maxL = Math.max(M, vw - w - M);
  const maxT = Math.max(M, vh - CARD_H - M);
  const need = CARD_H + M * 2;
  const needX = w + M * 2;

  if (r.height > vh * 0.42) {
    if (vw - (r.left + r.width) >= needX) {
      return { top: clamp(r.top + 8, M, maxT), left: clamp(r.left + r.width + M, M, maxL) };
    }
    if (r.left >= needX) {
      return { top: clamp(r.top + 8, M, maxT), left: clamp(r.left - w - M, M, maxL) };
    }
  }
  if (vh - (r.top + r.height) >= need) {
    return { top: clamp(r.top + r.height + M, M, maxT), left: clamp(r.left, M, maxL) };
  }
  if (r.top >= need) {
    return { top: clamp(r.top - CARD_H - M, M, maxT), left: clamp(r.left, M, maxL) };
  }
  if (vw - (r.left + r.width) >= needX) {
    return { top: clamp(r.top, M, maxT), left: clamp(r.left + r.width + M, M, maxL) };
  }
  return r.left >= needX
    ? { top: clamp(r.top, M, maxT), left: clamp(r.left - w - M, M, maxL) }
    : { top: maxT, left: M };
}

export const Onboarding: React.FC<OnboardingProps> = ({
  mode,
  isMobile,
  prefersReducedMotion,
  currentStep,
  visibleStepPosition,
  visibleStepCount,
  hasPrevStep,
  hasNextStep,
  openedFromHelp,
  helpTriggerRef,
  onDismiss,
  onStartTour,
  onOpenValidation,
  onBackToWelcome,
  onNextStep,
  onPrevStep,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  const handleClose = useCallback(() => {
    const inside = typeof document !== 'undefined' && cardRef.current?.contains(document.activeElement);
    onDismiss();
    if (openedFromHelp || inside) {
      window.requestAnimationFrame(() => helpTriggerRef.current?.focus());
    }
  }, [helpTriggerRef, onDismiss, openedFromHelp]);

  useEffect(() => {
    if (mode === 'hidden') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode, handleClose]);

  useEffect(() => {
    if (mode === 'welcome' && openedFromHelp) {
      window.requestAnimationFrame(() => cardRef.current?.focus());
    }
  }, [mode, openedFromHelp]);

  useLayoutEffect(() => {
    if (mode !== 'tour' || !currentStep || typeof document === 'undefined') {
      setBox(null);
      return;
    }
    const measure = () => {
      const el = document.querySelector(currentStep.selector);
      if (!(el instanceof HTMLElement)) return setBox(null);
      const r = el.getBoundingClientRect();
      setBox(r.width > 1 && r.height > 1 ? { top: r.top, left: r.left, width: r.width, height: r.height } : null);
    };
    const el = document.querySelector(currentStep.selector);
    if (el instanceof HTMLElement) {
      el.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const ro = el instanceof HTMLElement && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (el instanceof HTMLElement) ro?.observe(el);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      ro?.disconnect();
    };
  }, [mode, currentStep, prefersReducedMotion]);

  if (mode === 'hidden') return null;

  const anim = prefersReducedMotion ? '' : 'transition-all duration-150';

  if (mode === 'welcome' || mode === 'validation') {
    const isVal = mode === 'validation';
    return (
      <div className="pointer-events-none fixed inset-0 z-40" aria-live="polite">
        <div
          ref={cardRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="false"
          aria-labelledby="onboarding-dialog-title"
          data-testid={isVal ? 'onboarding-validation-card' : 'onboarding-welcome-card'}
          className={`${CARD_SURFACE} bottom-3 left-3 right-3 sm:right-auto sm:bottom-5 sm:left-5 sm:w-[404px] p-4 ${anim}`}
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id="onboarding-dialog-title" className="text-sm font-semibold tracking-tight text-[#F4F4F5]">
              {isVal ? 'Calibration & Limitations' : ONBOARDING_WELCOME_COPY.title}
            </h2>
            <button
              type="button"
              data-testid="onboarding-close-btn"
              onClick={handleClose}
              aria-label={isVal ? 'Close validation panel' : 'Skip onboarding'}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[#27272A] text-xs text-[#A1A1AA] hover:bg-[#1C1C20] hover:text-[#F4F4F5] cursor-pointer"
            >
              ×
            </button>
          </div>

          {!isVal ? (
            <>
              <p className="mt-2 text-xs leading-relaxed text-[#A1A1AA]">{ONBOARDING_WELCOME_COPY.body}</p>
              {isMobile && (
                <div data-testid="onboarding-mobile-what-to-try" className="mt-3 rounded-xl border border-[#1F1F24] bg-[#0C0C0E] p-2.5">
                  <div className="text-[10.5px] font-mono uppercase tracking-wider text-[#E4E4E7]">What to try</div>
                  <ol className="mt-1.5 flex flex-col gap-1 pl-4 text-[11.5px] leading-snug text-[#A1A1AA] list-decimal">
                    {MOBILE_WHAT_TO_TRY_ITEMS.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ol>
                </div>
              )}
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                {!isMobile && (
                  <button type="button" data-testid="onboarding-start-tour-btn" onClick={onStartTour} className={BTN_PRIMARY}>
                    {ONBOARDING_WELCOME_COPY.tourButton}
                  </button>
                )}
                <button type="button" data-testid="onboarding-skip-btn" onClick={handleClose} className={BTN_SEC}>
                  {ONBOARDING_WELCOME_COPY.skipButton}
                </button>
                <button
                  type="button"
                  data-testid="onboarding-validation-btn"
                  onClick={onOpenValidation}
                  className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#A1A1AA] hover:bg-[#18181C] hover:text-[#F4F4F5] cursor-pointer"
                >
                  {ONBOARDING_WELCOME_COPY.validationButton}
                </button>
              </div>
            </>
          ) : (
            <>
              <ul className="mt-2.5 flex flex-col gap-1.5 text-xs leading-relaxed text-[#A1A1AA]">
                <li>
                  <strong className="text-[#E4E4E7]">Calibration:</strong> Fitted to 3 Saffire sheet runs (18-point LOOCV MAPE 9.02%).
                </li>
                <li>
                  <strong className="text-[#E4E4E7]">Held-out checks:</strong> SAFFIRE-II-07 (Nomex) and SAFFIRE-II-01 (silicone) predict self-extinguishment (0.00 mm/s simulated).
                </li>
                <li>
                  <strong className="text-[#E4E4E7]">Scope:</strong> Not calibrated on BASS-II rods, FLEX droplets, or NASA-STD-6001 flame heights; not validated for design or certification.
                </li>
              </ul>
              <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#1F1F24] pt-2.5">
                <div className="flex items-center gap-2">
                  <button type="button" data-testid="onboarding-validation-back-btn" onClick={onBackToWelcome} className={BTN_SEC}>
                    Back
                  </button>
                  <button type="button" data-testid="onboarding-skip-btn" onClick={handleClose} className={BTN_PRIMARY}>
                    {ONBOARDING_WELCOME_COPY.skipButton}
                  </button>
                </div>
                <a
                  href="https://github.com/Zucloak/Ignimetheus#4-limitations"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] font-mono text-[#A1A1AA] underline decoration-[#3F3F46] underline-offset-2 hover:text-[#F4F4F5]"
                >
                  README Limitations
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!currentStep) return null;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const coords = getTourCoords(box ?? { top: vh * 0.4, left: vw * 0.3, width: 240, height: 120 }, vw, vh);

  return (
    <div className="pointer-events-none fixed inset-0 z-40" aria-live="polite">
      {box && (
        <div
          data-testid="onboarding-tour-highlight"
          aria-hidden="true"
          style={{ top: Math.max(2, box.top - 4), left: Math.max(2, box.left - 4), width: box.width + 8, height: box.height + 8 }}
          className={`pointer-events-none fixed rounded-xl border-2 border-[#F4F4F5] shadow-[0_0_0_1px_rgba(9,9,11,0.9),0_0_24px_rgba(244,244,245,0.16)] ${anim}`}
        />
      )}
      <div
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-labelledby="onboarding-tour-title"
        data-testid="onboarding-tour-card"
        style={{ top: coords.top, left: coords.left, width: Math.min(CARD_W, vw - M * 2) }}
        className={`${CARD_SURFACE} p-3.5 ${anim}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span data-testid="onboarding-tour-counter" className="rounded border border-[#27272A] bg-[#18181C] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-[#E4E4E7] shrink-0">
              {visibleStepPosition} / {visibleStepCount}
            </span>
            <h2 id="onboarding-tour-title" className="text-xs font-semibold text-[#F4F4F5] truncate">
              {currentStep.label}
            </h2>
          </div>
          <button
            type="button"
            data-testid="onboarding-tour-exit-x-btn"
            onClick={handleClose}
            aria-label="Exit guided tour"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[#27272A] text-xs text-[#A1A1AA] hover:bg-[#1C1C20] hover:text-[#F4F4F5] cursor-pointer"
          >
            ×
          </button>
        </div>
        <p data-testid="onboarding-tour-caption" className="mt-2 text-xs leading-relaxed text-[#A1A1AA]">
          {currentStep.caption}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-[#1F1F24] pt-2.5">
          <button
            type="button"
            data-testid="onboarding-tour-exit-btn"
            onClick={handleClose}
            className="rounded-md px-2 py-1 text-xs font-medium text-[#A1A1AA] hover:bg-[#18181C] hover:text-[#F4F4F5] cursor-pointer"
          >
            Exit
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="onboarding-tour-back-btn"
              onClick={onPrevStep}
              disabled={!hasPrevStep}
              className={`${BTN_SEC} py-1 disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              Back
            </button>
            <button type="button" data-testid="onboarding-tour-next-btn" onClick={onNextStep} className={`${BTN_PRIMARY} py-1`}>
              {hasNextStep ? 'Next' : 'Done'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
