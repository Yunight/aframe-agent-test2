import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditCreativeBundleIntegrity } from './creative-bundle-integrity.mts';

const WALIBI_HTML = `<!DOCTYPE html><html><body><div id="ad-320x480">
  <div class="bg-slides">
    <div class="slide slide-1" style="background-image:url('./04-parcnov2021.jpg')"></div>
    <div class="slide slide-2" style="background-image:url('./07-parcnov2021.jpg')"></div>
    <div class="slide slide-3" style="background-image:url('./walibi-ra-2022-0017.jpg')"></div>
    <div class="slide slide-4" style="background-image:url('./tournage-walibi-0123.jpg')"></div>
  </div>
  <img src="./walibi-shooting-pub-2025---0031.jpg" alt="hero">
</div></body></html>`;

const WALIBI_JS = `(function () {
  var SLIDE_COUNT = 4;
  var dotsEl = document.createElement('div');
  dotsEl.className = 'slide-dots';
  for (var i = 0; i < SLIDE_COUNT; i++) {
    var dot = document.createElement('span');
    dot.className = 'dot';
  }
}());`;

test('auditCreativeBundleIntegrity flags missing carousel assets with pagination dots', () => {
  const bundleDir = mkdtempSync(join(tmpdir(), 'bundle-integrity-'));
  try {
    writeFileSync(join(bundleDir, 'index.html'), WALIBI_HTML);
    writeFileSync(join(bundleDir, 'app.js'), WALIBI_JS);
    writeFileSync(join(bundleDir, 'walibi-shooting-pub-2025---0031.jpg'), 'x');

    const findings = auditCreativeBundleIntegrity({
      bundleDir,
      adFormats: [ { id: '320x480', width: 320, height: 480 } ]
    });
    const blockers = findings.filter((f) => f.severity === 'blocker');
    assert.ok(blockers.some((f) => f.issue.includes('Referenced local assets missing')));
    assert.ok(blockers.some((f) => f.issue.includes('pagination dots') || f.issue.includes('Carousel pagination')));
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

test('auditCreativeBundleIntegrity flags orphan dots with single slide', () => {
  const bundleDir = mkdtempSync(join(tmpdir(), 'bundle-integrity-single-'));
  try {
    writeFileSync(
      join(bundleDir, 'index.html'),
      `<div id="ad-300x250"><div class="slide slide-1"></div><img src="./hero.jpg"></div>`
    );
    writeFileSync(join(bundleDir, 'app.js'), `var SLIDE_COUNT = 4; dotsEl.className = 'slide-dots';`);
    writeFileSync(join(bundleDir, 'hero.jpg'), 'x');

    const findings = auditCreativeBundleIntegrity({
      bundleDir,
      adFormats: [ { id: '300x250', width: 300, height: 250 } ]
    });
    assert.ok(findings.some((f) => f.issue.includes('at most one carousel slide')));
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
});
