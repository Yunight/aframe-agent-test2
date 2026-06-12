import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Page } from 'playwright';
import {
  attemptCreativeReviewReveal,
  auditContentGatingPattern,
  auditInteractionGatedReviewCapture,
  buildCreativeFormatFocusInstruction,
  CREATIVE_MOTION_INTERACTION_IDEAS,
  detectsContentGatingPattern,
  type ScreenshotManifest
} from './core.mjs';

function mockPage (evaluateImpl: () => { revealed: boolean }): Page {
  return {
    evaluate: async (_fn: () => { revealed: boolean }) => evaluateImpl()
  } as unknown as Page;
}

describe('attemptCreativeReviewReveal', () => {
  it('returns revealed false when the review hook is absent', async () => {
    const page = mockPage(() => {
      const win = globalThis as { __CREATIVE_REVIEW__?: { reveal?: () => void } };
      const reveal = win.__CREATIVE_REVIEW__?.reveal;
      if (typeof reveal !== 'function') {
        return { revealed: false };
      }
      reveal();
      return { revealed: true };
    });

    const result = await attemptCreativeReviewReveal(page);
    assert.equal(result.revealed, false);
  });

  it('returns revealed true when __CREATIVE_REVIEW__.reveal is defined', async () => {
    const win = globalThis as { __CREATIVE_REVIEW__?: { reveal?: () => void } };
    win.__CREATIVE_REVIEW__ = { reveal () {} };

    const page = mockPage(() => {
      const reveal = win.__CREATIVE_REVIEW__?.reveal;
      if (typeof reveal !== 'function') {
        return { revealed: false };
      }
      reveal();
      return { revealed: true };
    });

    try {
      const result = await attemptCreativeReviewReveal(page);
      assert.equal(result.revealed, true);
    } finally {
      delete win.__CREATIVE_REVIEW__;
    }
  });
});

describe('detectsContentGatingPattern', () => {
  it('detects triggerReveal and pre-reveal overlay', () => {
    assert.equal(
      detectsContentGatingPattern(
        'function triggerReveal() {}\nwindow.__CREATIVE_REVIEW__ = { reveal() {} };',
        '<div id="pre-reveal-overlay"></div>'
      ),
      true
    );
  });

  it('returns false for motion-only creatives', () => {
    assert.equal(
      detectsContentGatingPattern(
        'particles.forEach(function (p) { p.draw(ctx); });',
        '<img id="logo" src="./logo.svg"><img id="hero-img" src="./product.jpg">'
      ),
      false
    );
  });
});

describe('auditContentGatingPattern', () => {
  it('flags forbidden gating in bundle directory', () => {
    const bundleDir = join(tmpdir(), `content-gating-test-${String(Date.now())}`);
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, 'app.js'),
      'function triggerReveal() {}\nwindow.__CREATIVE_REVIEW__ = { reveal: triggerReveal };',
      'utf8'
    );
    writeFileSync(join(bundleDir, 'index.html'), '<div id="pre-reveal-overlay"></div>', 'utf8');

    try {
      const findings = auditContentGatingPattern(bundleDir, [ '320x480' ]);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.severity, 'blocker');
      assert.match(findings[0]?.issue ?? '', /content-gating/iu);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });
});

describe('buildCreativeFormatFocusInstruction', () => {
  it('promotes motion interactions without tap reveal', () => {
    const instruction = buildCreativeFormatFocusInstruction(1);
    assert.match(instruction, /kinetic headline/iu);
    assert.doesNotMatch(instruction, /tap\/swipe reveal/iu);
    assert.match(instruction, /DO NOT build two-stage ads/iu);
    assert.ok(CREATIVE_MOTION_INTERACTION_IDEAS.includes('CTA pulse'));
  });
});

describe('auditInteractionGatedReviewCapture', () => {
  const scratchAppJs = `
    var scratchCanvas = document.getElementById('scratchCanvas');
    function triggerReveal() {}
  `;

  const manifestWithoutRevealed: ScreenshotManifest = {
    captured_at: '2026-01-01T00:00:00.000Z',
    entry_html: '/tmp/code/index.html',
    entry_url: 'file:///tmp/code/index.html',
    formats: [
      {
        format_id: '320x480',
        width: 320,
        height: 480,
        selector: '#ad-320x480',
        error: null,
        shots: [
          {
            state: 'settled',
            fileName: '320x480__settled.png',
            relativePath: '320x480__settled.png',
            captured_at: '2026-01-01T00:00:00.000Z'
          }
        ]
      }
    ]
  };

  it('flags missing review hook on interaction-gated creatives', () => {
    const bundleDir = join(tmpdir(), `creative-review-test-${String(Date.now())}`);
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(join(bundleDir, 'app.js'), scratchAppJs, 'utf8');

    try {
      const findings = auditInteractionGatedReviewCapture(manifestWithoutRevealed, bundleDir);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.severity, 'blocker');
      assert.match(findings[0]?.issue ?? '', /__CREATIVE_REVIEW__/u);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });

  it('passes when a revealed screenshot exists', () => {
    const bundleDir = join(tmpdir(), `creative-review-test-${String(Date.now())}-ok`);
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, 'app.js'),
      `${scratchAppJs}\nwindow.__CREATIVE_REVIEW__ = { hasInteraction: true, reveal() { triggerReveal(); } };`,
      'utf8'
    );

    const manifestWithRevealed: ScreenshotManifest = {
      ...manifestWithoutRevealed,
      formats: [
        {
          ...manifestWithoutRevealed.formats[0]!,
          shots: [
            ...manifestWithoutRevealed.formats[0]!.shots,
            {
              state: 'revealed',
              fileName: '320x480__revealed.png',
              relativePath: '320x480__revealed.png',
              captured_at: '2026-01-01T00:00:00.000Z'
            }
          ]
        }
      ]
    };

    try {
      const findings = auditInteractionGatedReviewCapture(manifestWithRevealed, bundleDir);
      assert.equal(findings.length, 0);
    } finally {
      rmSync(bundleDir, { recursive: true, force: true });
    }
  });
});
