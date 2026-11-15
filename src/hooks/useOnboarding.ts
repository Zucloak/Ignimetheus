import { useCallback, useEffect, useState } from 'react';
import {
  findVisibleTourStepIndex,
  isMobileOnboardingViewport,
  ONBOARDING_TOUR_STEPS,
  parseOnboardingOverride,
  resolveInitialOnboardingMode,
  writeOnboardingDismissed,
  type OnboardingMode,
  type OnboardingTourStep,
  type StorageLike,
} from '../engine/onboarding';

function getStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function isDomTourTargetVisible(selector: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  const st = window.getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

const isStepVisible = (s: OnboardingTourStep) => isDomTourTargetVisible(s.selector);

export interface UseOnboardingResult {
  mode: OnboardingMode;
  isMobile: boolean;
  prefersReducedMotion: boolean;
  currentStepIndex: number;
  currentStep: OnboardingTourStep | null;
  visibleStepPosition: number;
  visibleStepCount: number;
  hasPrevStep: boolean;
  hasNextStep: boolean;
  openedFromHelp: boolean;
  openFromHelp: () => void;
  dismiss: () => void;
  startTour: () => void;
  openValidation: () => void;
  backToWelcome: () => void;
  nextStep: () => void;
  prevStep: () => void;
}

export function useOnboarding(): UseOnboardingResult {
  const [mode, setMode] = useState<OnboardingMode>(() =>
    typeof window === 'undefined'
      ? 'hidden'
      : resolveInitialOnboardingMode({ search: window.location.search, storage: getStorage() }),
  );
  const [openedFromHelp, setOpenedFromHelp] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [vw, setVw] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1280));
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  );

  const isMobile = isMobileOnboardingViewport(vw);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotion = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq?.addEventListener?.('change', onMotion);
    return () => {
      window.removeEventListener('resize', onResize);
      mq?.removeEventListener?.('change', onMotion);
    };
  }, []);

  useEffect(() => {
    if (mode !== 'tour') return;
    if (isMobile) {
      setMode('welcome');
      return;
    }
    const step = ONBOARDING_TOUR_STEPS[stepIdx];
    if (!step || !isDomTourTargetVisible(step.selector)) {
      const next = findVisibleTourStepIndex(ONBOARDING_TOUR_STEPS, stepIdx + 1, 'forward', isStepVisible);
      if (next !== null) setStepIdx(next);
      else setMode('hidden');
    }
  }, [mode, isMobile, stepIdx, vw]);

  const dismiss = useCallback(() => {
    writeOnboardingDismissed(getStorage());
    setMode('hidden');
  }, []);

  const openFromHelp = useCallback(() => {
    if (typeof window !== 'undefined' && parseOnboardingOverride(window.location.search) === 'hide') {
      return;
    }
    setOpenedFromHelp(true);
    setMode('welcome');
  }, []);

  const openValidation = useCallback(() => setMode('validation'), []);
  const backToWelcome = useCallback(() => setMode('welcome'), []);

  const startTour = useCallback(() => {
    if (isMobile) {
      setMode('welcome');
      return;
    }
    const first = findVisibleTourStepIndex(ONBOARDING_TOUR_STEPS, 0, 'forward', isStepVisible);
    if (first === null) {
      dismiss();
      return;
    }
    setStepIdx(first);
    setMode('tour');
  }, [dismiss, isMobile]);

  const nextStep = useCallback(() => {
    const next = findVisibleTourStepIndex(ONBOARDING_TOUR_STEPS, stepIdx + 1, 'forward', isStepVisible);
    if (next === null) dismiss();
    else setStepIdx(next);
  }, [dismiss, stepIdx]);

  const prevStep = useCallback(() => {
    const prev = findVisibleTourStepIndex(ONBOARDING_TOUR_STEPS, stepIdx - 1, 'backward', isStepVisible);
    if (prev !== null) setStepIdx(prev);
  }, [stepIdx]);

  const visibleIndices =
    mode === 'tour'
      ? ONBOARDING_TOUR_STEPS.reduce<number[]>((acc, s, i) => (isStepVisible(s) ? [...acc, i] : acc), [])
      : [];
  const pos = visibleIndices.indexOf(stepIdx);

  return {
    mode,
    isMobile,
    prefersReducedMotion: reduced,
    currentStepIndex: stepIdx,
    currentStep: mode === 'tour' ? (ONBOARDING_TOUR_STEPS[stepIdx] ?? null) : null,
    visibleStepPosition: pos >= 0 ? pos + 1 : 1,
    visibleStepCount: visibleIndices.length,
    hasPrevStep: pos > 0,
    hasNextStep: pos >= 0 && pos < visibleIndices.length - 1,
    openedFromHelp,
    openFromHelp,
    dismiss,
    startTour,
    openValidation,
    backToWelcome,
    nextStep,
    prevStep,
  };
}
