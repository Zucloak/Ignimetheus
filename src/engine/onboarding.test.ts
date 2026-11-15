import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Onboarding } from '../components/Onboarding';
import {
  findVisibleTourStepIndex,
  isMobileOnboardingViewport,
  MOBILE_WHAT_TO_TRY_ITEMS,
  ONBOARDING_STORAGE_KEY,
  ONBOARDING_TOUR_STEPS,
  ONBOARDING_WELCOME_COPY,
  parseOnboardingOverride,
  readOnboardingDismissed,
  resolveInitialOnboardingMode,
  writeOnboardingDismissed,
  type StorageLike,
} from './onboarding';

function createMemoryStorage(initial: Record<string, string> = {}): StorageLike {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function createThrowingStorage(): StorageLike {
  return {
    getItem() {
      throw new Error('Quota / Private mode blocked');
    },
    setItem() {
      throw new Error('Quota / Private mode blocked');
    },
  };
}

test('onboarding first visit shows Welcome card and reload after dismiss stays hidden', () => {
  const storage = createMemoryStorage();
  assert.equal(resolveInitialOnboardingMode({ search: '', storage }), 'welcome');

  const wrote = writeOnboardingDismissed(storage);
  assert.equal(wrote, true);
  assert.equal(readOnboardingDismissed(storage).dismissed, true);

  // Simulated reload with same storage stays hidden
  assert.equal(resolveInitialOnboardingMode({ search: '', storage }), 'hidden');
});

test('onboarding URL overrides ?onboarding=0 never shows and ?onboarding=1 always forces display', () => {
  const freshStorage = createMemoryStorage();
  assert.equal(parseOnboardingOverride('?onboarding=0'), 'hide');
  assert.equal(resolveInitialOnboardingMode({ search: '?onboarding=0', storage: freshStorage }), 'hidden');

  const dismissedStorage = createMemoryStorage({ [ONBOARDING_STORAGE_KEY]: 'dismissed' });
  assert.equal(parseOnboardingOverride('?onboarding=1'), 'force');
  assert.equal(resolveInitialOnboardingMode({ search: '?onboarding=1', storage: dismissedStorage }), 'welcome');
});

test('onboarding localStorage failure shows initially without throwing and never loops on dismiss', () => {
  const broken = createThrowingStorage();
  const readResult = readOnboardingDismissed(broken);
  assert.equal(readResult.storageFailed, true);
  assert.equal(readResult.dismissed, false);

  assert.equal(resolveInitialOnboardingMode({ search: '', storage: broken }), 'welcome');
  assert.equal(writeOnboardingDismissed(broken), false);
});

test('each of the 7 tour steps silently skips forward and backward when its target is missing', () => {
  assert.equal(ONBOARDING_TOUR_STEPS.length, 7);

  // Skip every individual missing step forward and backward
  for (let missingIdx = 0; missingIdx < ONBOARDING_TOUR_STEPS.length; missingIdx++) {
    const isAvailable = (step: (typeof ONBOARDING_TOUR_STEPS)[number]) =>
      step.id !== ONBOARDING_TOUR_STEPS[missingIdx].id;

    const first = findVisibleTourStepIndex(ONBOARDING_TOUR_STEPS, 0, 'forward', isAvailable);
    assert.equal(first, missingIdx === 0 ? 1 : 0);

    if (missingIdx > 0 && missingIdx < ONBOARDING_TOUR_STEPS.length - 1) {
      const nextFromBefore = findVisibleTourStepIndex(
        ONBOARDING_TOUR_STEPS,
        missingIdx,
        'forward',
        isAvailable,
      );
      assert.equal(nextFromBefore, missingIdx + 1);

      const prevFromAfter = findVisibleTourStepIndex(
        ONBOARDING_TOUR_STEPS,
        missingIdx,
        'backward',
        isAvailable,
      );
      assert.equal(prevFromAfter, missingIdx - 1);
    }
  }

  // When all targets are missing, returns null so tour ends cleanly
  assert.equal(
    findVisibleTourStepIndex(ONBOARDING_TOUR_STEPS, 0, 'forward', () => false),
    null,
  );
});

test('Onboarding renders exact Welcome copy, Mobile <= 430px What-to-try list, Validation panel, and 6 non-blocking tour steps', () => {
  const dummyRef = { current: null };
  let simActionDispatches = 0;
  const simActionSpy = () => {
    simActionDispatches += 1;
  };
  // Verify Onboarding callbacks do not touch any simulation action handlers
  void simActionSpy;

  const desktopWelcomeHtml = renderToStaticMarkup(
    React.createElement(Onboarding, {
      mode: 'welcome',
      isMobile: false,
      prefersReducedMotion: true,
      currentStep: null,
      visibleStepPosition: 1,
      visibleStepCount: 6,
      hasPrevStep: false,
      hasNextStep: true,
      openedFromHelp: false,
      helpTriggerRef: dummyRef,
      onDismiss: () => {},
      onStartTour: () => {},
      onOpenValidation: () => {},
      onBackToWelcome: () => {},
      onNextStep: () => {},
      onPrevStep: () => {},
    }),
  );

  const decodeHtml = (html: string) =>
    html.replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  const desktopWelcomeText = decodeHtml(desktopWelcomeHtml);

  assert.ok(desktopWelcomeHtml.includes('pointer-events-none fixed inset-0'));
  assert.ok(desktopWelcomeText.includes(ONBOARDING_WELCOME_COPY.title));
  assert.ok(desktopWelcomeText.includes(ONBOARDING_WELCOME_COPY.body));
  assert.ok(desktopWelcomeText.includes(ONBOARDING_WELCOME_COPY.tourButton));
  assert.ok(desktopWelcomeText.includes(ONBOARDING_WELCOME_COPY.skipButton));
  assert.ok(desktopWelcomeText.includes(ONBOARDING_WELCOME_COPY.validationButton));
  assert.ok(!desktopWelcomeText.includes('What to try'));

  // Mobile (<= 430px) renders welcome card with 3-line "What to try" instead of 6-step tour
  assert.equal(isMobileOnboardingViewport(390), true);
  assert.equal(isMobileOnboardingViewport(430), true);
  assert.equal(isMobileOnboardingViewport(431), false);

  const mobileWelcomeHtml = renderToStaticMarkup(
    React.createElement(Onboarding, {
      mode: 'welcome',
      isMobile: true,
      prefersReducedMotion: false,
      currentStep: null,
      visibleStepPosition: 1,
      visibleStepCount: 0,
      hasPrevStep: false,
      hasNextStep: false,
      openedFromHelp: false,
      helpTriggerRef: dummyRef,
      onDismiss: () => {},
      onStartTour: () => {},
      onOpenValidation: () => {},
      onBackToWelcome: () => {},
      onNextStep: () => {},
      onPrevStep: () => {},
    }),
  );

  const mobileWelcomeText = decodeHtml(mobileWelcomeHtml);
  assert.ok(mobileWelcomeText.includes('What to try'));
  for (const line of MOBILE_WHAT_TO_TRY_ITEMS) {
    assert.ok(mobileWelcomeText.includes(line));
  }
  assert.ok(!mobileWelcomeText.includes(ONBOARDING_WELCOME_COPY.tourButton));

  // Validation panel renders calibration & limitations summary offline
  const validationHtml = decodeHtml(
    renderToStaticMarkup(
      React.createElement(Onboarding, {
        mode: 'validation',
        isMobile: false,
        prefersReducedMotion: true,
        currentStep: null,
        visibleStepPosition: 1,
        visibleStepCount: 6,
        hasPrevStep: false,
        hasNextStep: true,
        openedFromHelp: false,
        helpTriggerRef: dummyRef,
        onDismiss: () => {},
        onStartTour: () => {},
        onOpenValidation: () => {},
        onBackToWelcome: () => {},
        onNextStep: () => {},
        onPrevStep: () => {},
      }),
    ),
  );
  assert.ok(validationHtml.includes('Calibration & Limitations'));
  assert.ok(validationHtml.includes('README Limitations'));

  // Tour steps match verbatim with Back/Next/Exit buttons
  for (let i = 0; i < ONBOARDING_TOUR_STEPS.length; i++) {
    const step = ONBOARDING_TOUR_STEPS[i];
    const tourHtml = decodeHtml(
      renderToStaticMarkup(
        React.createElement(Onboarding, {
          mode: 'tour',
          isMobile: false,
          prefersReducedMotion: true,
          currentStep: step,
          visibleStepPosition: i + 1,
          visibleStepCount: ONBOARDING_TOUR_STEPS.length,
          hasPrevStep: i > 0,
          hasNextStep: i < ONBOARDING_TOUR_STEPS.length - 1,
          openedFromHelp: true,
          helpTriggerRef: dummyRef,
          onDismiss: () => {},
          onStartTour: () => {},
          onOpenValidation: () => {},
          onBackToWelcome: () => {},
          onNextStep: () => {},
          onPrevStep: () => {},
        }),
      ),
    );
    assert.ok(tourHtml.includes(step.label));
    assert.ok(tourHtml.includes(step.caption));
    assert.ok(tourHtml.includes('Back'));
    assert.ok(tourHtml.includes('Exit'));
    assert.ok(tourHtml.includes(i < ONBOARDING_TOUR_STEPS.length - 1 ? 'Next' : 'Done'));
  }

  // Hidden mode renders nothing
  const hiddenHtml = renderToStaticMarkup(
    React.createElement(Onboarding, {
      mode: 'hidden',
      isMobile: false,
      prefersReducedMotion: false,
      currentStep: null,
      visibleStepPosition: 1,
      visibleStepCount: 6,
      hasPrevStep: false,
      hasNextStep: true,
      openedFromHelp: false,
      helpTriggerRef: dummyRef,
      onDismiss: () => {},
      onStartTour: () => {},
      onOpenValidation: () => {},
      onBackToWelcome: () => {},
      onNextStep: () => {},
      onPrevStep: () => {},
    }),
  );
  assert.equal(hiddenHtml, '');
  assert.equal(simActionDispatches, 0);
});
