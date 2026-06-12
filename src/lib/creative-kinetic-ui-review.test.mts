import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  copyReferencedCodegenAssets,
  detectsKineticTypingPattern,
  estimateKineticMinAnimatedWaitMs,
  estimateKineticTypingCompletionMs,
  suppressKineticAnimatedFalsePositives
} from './core.mjs';

const kusmiV2AppJs = `'use strict';

(function initHeadline() {
  var TEXT = 'MATCHA PREMIUM';
  var el = document.getElementById('kinetic-headline');
  if (!el) return;
  var idx = 0;
  function tick() {
    if (idx >= TEXT.length) return;
    var ch = TEXT[idx++];
    var span = document.createElement('span');
    span.className = 'char';
    span.textContent = ch;
    el.appendChild(span);
    setTimeout(tick, 80);
  }
  setTimeout(tick, 500);
}());`;

describe('detectsKineticTypingPattern', () => {
  it('detects JS character-by-character kinetic headline', () => {
    assert.equal(detectsKineticTypingPattern(kusmiV2AppJs), true);
  });

  it('returns false for motion-only creatives without headline typing', () => {
    assert.equal(
      detectsKineticTypingPattern('particles.forEach(function (p) { p.draw(ctx); });'),
      false
    );
  });
});

describe('estimateKineticTypingCompletionMs', () => {
  it('estimates duration for setTimeout tick kinetic headline', () => {
    const ms = estimateKineticTypingCompletionMs(kusmiV2AppJs);
    assert.ok(ms !== null);
    assert.equal(ms, 500 + 14 * 80 + 200);
  });

  it('computes min animated wait from initial wait', () => {
    const minAnimated = estimateKineticMinAnimatedWaitMs(kusmiV2AppJs, 200);
    assert.ok(minAnimated !== null);
    assert.equal(minAnimated, 500 + 14 * 80 + 200);
  });
});

describe('suppressKineticAnimatedFalsePositives', () => {
  it('downgrades animated kinetic truncation blocker when settled is OK', () => {
    const audit = {
      satisfied: false,
      summary:
        'Animated state shows truncated product name; settled state shows correct copy with MATCHA PREMIUM fully visible.',
      findings: [
        {
          format_id: '320x480',
          severity: 'blocker' as const,
          issue:
            "Animated state shows truncated product name 'MATCHA P' instead of full 'MATCHA PREMIUM'.",
          fix_hint: 'Reduce font-size on the animated headline keyframe.'
        }
      ],
      regeneration_prompt: 'Fix animated headline truncation.'
    };

    const result = suppressKineticAnimatedFalsePositives(audit, kusmiV2AppJs);
    assert.equal(result.suppressed, 1);
    assert.equal(audit.findings[0]?.severity, 'warn');
    assert.equal(audit.satisfied, true);
  });

  it('leaves unrelated blockers unchanged', () => {
    const audit = {
      satisfied: false,
      summary: 'Logo is missing on settled state.',
      findings: [
        {
          format_id: '320x480',
          severity: 'blocker' as const,
          issue: 'Logo is not visible on settled state.',
          fix_hint: 'Ensure .logo-img is visible.'
        }
      ],
      regeneration_prompt: 'Fix logo.'
    };

    const result = suppressKineticAnimatedFalsePositives(audit, kusmiV2AppJs);
    assert.equal(result.suppressed, 0);
    assert.equal(audit.findings[0]?.severity, 'blocker');
    assert.equal(audit.satisfied, false);
  });

  it('does nothing when bundle has no kinetic typing', () => {
    const audit = {
      satisfied: false,
      summary: 'Animated truncation issue.',
      findings: [
        {
          format_id: '320x480',
          severity: 'blocker' as const,
          issue: 'Animated state shows truncated headline.',
          fix_hint: 'Fix headline.'
        }
      ],
      regeneration_prompt: 'Fix headline.'
    };

    const result = suppressKineticAnimatedFalsePositives(audit, 'console.log("static");');
    assert.equal(result.suppressed, 0);
    assert.equal(audit.findings[0]?.severity, 'blocker');
  });
});

describe('copyReferencedCodegenAssets', () => {
  it('skips protected bundle files such as app.js', () => {
    const referenced = new Set([ 'app.js', 'logo_black.svg' ]);
    const { missing, copied } = copyReferencedCodegenAssets({
      bundleDir: '/tmp/unused',
      assetFiles: [],
      referencedNames: referenced
    });
    assert.equal(missing.includes('app.js'), false);
    assert.equal(copied.includes('app.js'), false);
    assert.equal(missing.includes('logo_black.svg'), true);
  });
});
