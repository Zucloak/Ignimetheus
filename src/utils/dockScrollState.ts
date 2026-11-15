export interface DockScrollInput {
  currentCompact: boolean;
  prevScrollTop: number;
  nextScrollTop: number;
  thresholdPx?: number;
}

export interface DockScrollResult {
  isCompact: boolean;
  lastScrollTop: number;
}

export const DEFAULT_DOCK_SCROLL_THRESHOLD_PX = 6;
export const DEFAULT_DOCK_WHEEL_THRESHOLD_PX = 6;

/**
 * Pure state transition for the floating CommandComposer dock when a scroll container moves.
 * - Scrolling UP (nextScrollTop < prevScrollTop - threshold) simplifies the dock (isCompact = true).
 * - Scrolling DOWN (nextScrollTop > prevScrollTop + threshold) restores normal state (isCompact = false).
 * - Micro-deltas within the threshold preserve current state without jitter.
 */
export function resolveDockCompactStateOnScroll(input: DockScrollInput): DockScrollResult {
  const threshold = input.thresholdPx ?? DEFAULT_DOCK_SCROLL_THRESHOLD_PX;
  const clampedNext = Math.max(0, input.nextScrollTop);
  const delta = clampedNext - input.prevScrollTop;

  if (delta < -threshold) {
    return {
      isCompact: true,
      lastScrollTop: clampedNext,
    };
  }

  if (delta > threshold) {
    return {
      isCompact: false,
      lastScrollTop: clampedNext,
    };
  }

  return {
    isCompact: input.currentCompact,
    lastScrollTop: input.prevScrollTop,
  };
}

/**
 * Pure state transition for wheel/trackpad gestures (works even when scrollHeight == clientHeight).
 * - Wheel UP (deltaY < -threshold) simplifies the dock (isCompact = true).
 * - Wheel DOWN (deltaY > threshold) restores normal state (isCompact = false).
 */
export function resolveDockCompactStateOnWheel(
  currentCompact: boolean,
  deltaY: number,
  thresholdPx: number = DEFAULT_DOCK_WHEEL_THRESHOLD_PX,
): boolean {
  if (deltaY < -thresholdPx) {
    return true;
  }
  if (deltaY > thresholdPx) {
    return false;
  }
  return currentCompact;
}
