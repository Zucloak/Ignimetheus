export const ONBOARDING_STORAGE_KEY = 'ignimetheus_onboarding_v1';
export const MOBILE_ONBOARDING_MAX_WIDTH_PX = 430;

export type OnboardingUrlOverride = 'hide' | 'force' | null;
export type OnboardingMode = 'hidden' | 'welcome' | 'validation' | 'tour';

export interface OnboardingTourStep {
  id: string;
  label: string;
  selector: string;
  caption: string;
}

export const ONBOARDING_WELCOME_COPY = {
  title: 'Welcome to Ignimetheus',
  body: 'An offline, reduced-order flame-spread simulator for exploring how oxygen, flow, pressure and gravity affect fires in spacecraft. A screening and teaching tool, not validated for design, certification or crew-safety decisions.',
  tourButton: 'Take the 90-second tour',
  skipButton: 'Explore on my own',
  validationButton: "How it's validated",
} as const;

export const MOBILE_WHAT_TO_TRY_ITEMS = [
  'Pick a mission scenario in the menu to set O2, flow, pressure and gravity.',
  'Press Ignite, then toggle 1g Overlay to compare normal-gravity spread.',
  'Ask Telemetry Assistant about LOI margin, Da*, or why a run quenches.',
] as const;

export const ONBOARDING_TOUR_STEPS: readonly OnboardingTourStep[] = [
  {
    id: 'scenario-list',
    label: 'Scenario list',
    selector: '[data-tour="scenario-list"]',
    caption: 'Pick a mission scenario. Each one sets oxygen, flow, pressure and gravity.',
  },
  {
    id: 'sim-canvas',
    label: 'Simulation canvas',
    selector: '[data-tour="sim-canvas"]',
    caption:
      'Press Ignite to start a burn. Thermocouples (TC-1..6) and probes (P-n) read temperature along the duct.',
  },
  {
    id: 'toggle-1g-overlay',
    label: '0g vs 1g overlay toggle',
    selector: '[data-testid="dock-toggle-1g-overlay"]',
    caption: 'Toggle the 1g overlay to compare the same conditions in normal gravity.',
  },
  {
    id: 'right-inspector',
    label: 'Right inspector',
    selector: '[data-tour="right-inspector"]',
    caption:
      'LOI margin and Da* show how close the flame is to extinguishing. Da* is an index derived from LOI margin, not an independent Damkohler number.',
  },
  {
    id: 'reference-match',
    label: 'Reference match panel',
    selector: '[data-tour="reference-match"]',
    caption:
      'Closest NASA reference scenario. Some values are adapted; PSI IDs are pending verification.',
  },
  {
    id: 'telemetry-assistant',
    label: 'Telemetry Assistant',
    selector: '[data-tour="telemetry-assistant"]',
    caption:
      "Ask about this run, e.g. 'Why is spread so high?' or 'Compare 0g and 1g'. It explains the simulation; it can't assess safety.",
  },
  {
    id: 'run-nasa-experiment',
    label: "Run NASA's experiment",
    selector: '[data-tour="run-nasa-experiment"]',
    caption:
      "Load SAFFIRE-I-01 conditions and ignite to compare steady-state model spread with NASA's published table.",
  },
] as const;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseOnboardingOverride(search: string): OnboardingUrlOverride {
  if (!search) return null;
  const params = new URLSearchParams(search);
  const raw = params.get('onboarding');
  if (raw === '0') return 'hide';
  if (raw === '1') return 'force';
  return null;
}

export function isMobileOnboardingViewport(viewportWidthPx: number): boolean {
  return Number.isFinite(viewportWidthPx) && viewportWidthPx <= MOBILE_ONBOARDING_MAX_WIDTH_PX;
}

export function readOnboardingDismissed(storage?: StorageLike | null): {
  dismissed: boolean;
  storageFailed: boolean;
} {
  if (!storage) {
    return { dismissed: false, storageFailed: true };
  }
  try {
    const val = storage.getItem(ONBOARDING_STORAGE_KEY);
    return { dismissed: val === 'dismissed' || val === '1', storageFailed: false };
  } catch {
    return { dismissed: false, storageFailed: true };
  }
}

export function writeOnboardingDismissed(storage?: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ONBOARDING_STORAGE_KEY, 'dismissed');
    return true;
  } catch {
    return false;
  }
}

export function resolveInitialOnboardingMode(options: {
  search: string;
  storage?: StorageLike | null;
}): OnboardingMode {
  const override = parseOnboardingOverride(options.search);
  if (override === 'hide') return 'hidden';
  if (override === 'force') return 'welcome';
  const { dismissed } = readOnboardingDismissed(options.storage);
  return dismissed ? 'hidden' : 'welcome';
}

export function findVisibleTourStepIndex(
  steps: readonly OnboardingTourStep[],
  startIndex: number,
  direction: 'forward' | 'backward',
  isAvailable: (step: OnboardingTourStep) => boolean,
): number | null {
  if (steps.length === 0) return null;
  const delta = direction === 'forward' ? 1 : -1;
  for (let i = startIndex; i >= 0 && i < steps.length; i += delta) {
    if (isAvailable(steps[i])) {
      return i;
    }
  }
  return null;
}
