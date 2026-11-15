import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDockCompactStateOnScroll,
  resolveDockCompactStateOnWheel,
} from './dockScrollState';

test('resolveDockCompactStateOnScroll compacts dock on upward scroll and restores normal state on downward scroll', () => {
  // Initial downward scroll from 0 -> 120 keeps dock in normal state
  const down1 = resolveDockCompactStateOnScroll({
    currentCompact: false,
    prevScrollTop: 0,
    nextScrollTop: 120,
  });
  assert.equal(down1.isCompact, false);
  assert.equal(down1.lastScrollTop, 120);

  // Scrolling up from 120 -> 70 (> 6px threshold) simplifies dock into compact mode
  const up1 = resolveDockCompactStateOnScroll({
    currentCompact: down1.isCompact,
    prevScrollTop: down1.lastScrollTop,
    nextScrollTop: 70,
  });
  assert.equal(up1.isCompact, true);
  assert.equal(up1.lastScrollTop, 70);

  // Small sub-threshold jitter (70 -> 73) preserves compact mode
  const jitter = resolveDockCompactStateOnScroll({
    currentCompact: up1.isCompact,
    prevScrollTop: up1.lastScrollTop,
    nextScrollTop: 73,
  });
  assert.equal(jitter.isCompact, true);
  assert.equal(jitter.lastScrollTop, 70);

  // Scrolling downward from 70 -> 110 restores normal dock state
  const down2 = resolveDockCompactStateOnScroll({
    currentCompact: jitter.isCompact,
    prevScrollTop: jitter.lastScrollTop,
    nextScrollTop: 110,
  });
  assert.equal(down2.isCompact, false);
  assert.equal(down2.lastScrollTop, 110);
});

test('resolveDockCompactStateOnWheel compacts on upward wheel delta and restores normal on downward wheel delta', () => {
  assert.equal(resolveDockCompactStateOnWheel(false, -80), true);
  assert.equal(resolveDockCompactStateOnWheel(true, 2), true);
  assert.equal(resolveDockCompactStateOnWheel(true, 80), false);
  assert.equal(resolveDockCompactStateOnWheel(false, -3), false);
});
