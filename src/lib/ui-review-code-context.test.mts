import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  buildUiReviewCodeAnnotations,
  formatBundleForUiReviewPrompt,
  isUiReviewIncludeCodeEnabled,
  loadCodeBundleForUiReview,
  type ExistingCodeBundle
} from './core.mjs';

const kusmiAppJs = `'use strict';
(function initHeadline() {
  var TEXT = 'MATCHA PREMIUM';
  function tick() { setTimeout(tick, 80); }
  setTimeout(tick, 500);
}());`;

const kusmiHtml = `<!DOCTYPE html>
<html lang="fr">
<body>
  <div id="ad-320x480">
    <img class="logo-img" src="./logo_black.svg" alt="logo">
    <img class="packshot-img" src="./product.png" alt="Matcha Premium">
    <h1 class="headline" id="kinetic-headline" aria-label="Matcha Premium"></h1>
    <a class="cta-btn" href="#"><span class="cta-label">Découvrir</span></a>
  </div>
  <script src="app.js" defer></script>
</body>
</html>`;

const kusmiCss = `.headline { font-size: 18px; }
.cta-btn { background: #8FB73E; }`;

function writeFixtureBundle (dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), kusmiHtml, 'utf8');
  writeFileSync(join(dir, 'styles.css'), kusmiCss, 'utf8');
  writeFileSync(join(dir, 'app.js'), kusmiAppJs, 'utf8');
}

describe('buildUiReviewCodeAnnotations', () => {
  it('includes kinetic headline and copy from JS', () => {
    const dir = join(tmpdir(), `ui-review-ann-${String(Date.now())}`);
    writeFixtureBundle(dir);
    try {
      const text = buildUiReviewCodeAnnotations(dir);
      assert.ok(text !== null);
      assert.match(text, /kinetic_headline: true/u);
      assert.match(text, /headline_copy_from_js: "MATCHA PREMIUM"/u);
      assert.match(text, /#ad-320x480/u);
      assert.match(text, /\.headline/u);
      assert.match(text, /cta_label: Découvrir/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('formatBundleForUiReviewPrompt', () => {
  it('includes all three bundle files with UI review header', () => {
    const bundle: ExistingCodeBundle = {
      files: [
        { fileName: 'index.html', fileContent: '<div id="ad-320x480"></div>', truncated: false },
        { fileName: 'styles.css', fileContent: '.headline {}', truncated: false },
        { fileName: 'app.js', fileContent: kusmiAppJs, truncated: false }
      ]
    };
    const text = formatBundleForUiReviewPrompt(bundle);
    assert.match(text, /SOURCE BUNDLE \(interpret screenshots with this code\)/u);
    assert.match(text, /### index\.html/u);
    assert.match(text, /### styles\.css/u);
    assert.match(text, /### app\.js/u);
    assert.match(text, /transient animation/u);
  });
});

describe('loadCodeBundleForUiReview', () => {
  it('loads bundle files from directory', () => {
    const dir = join(tmpdir(), `ui-review-load-${String(Date.now())}`);
    writeFixtureBundle(dir);
    try {
      const bundle = loadCodeBundleForUiReview(dir);
      assert.equal(bundle.files.length, 3);
      assert.equal(bundle.files.some((f) => f.fileName === 'app.js'), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isUiReviewIncludeCodeEnabled', () => {
  it('defaults to true when env unset', () => {
    const prev = process.env['CREATIVE_UI_REVIEW_INCLUDE_CODE'];
    delete process.env['CREATIVE_UI_REVIEW_INCLUDE_CODE'];
    try {
      assert.equal(isUiReviewIncludeCodeEnabled(), true);
    } finally {
      if (prev === undefined) {
        delete process.env['CREATIVE_UI_REVIEW_INCLUDE_CODE'];
      } else {
        process.env['CREATIVE_UI_REVIEW_INCLUDE_CODE'] = prev;
      }
    }
  });

  it('returns false when env is 0', () => {
    const prev = process.env['CREATIVE_UI_REVIEW_INCLUDE_CODE'];
    process.env['CREATIVE_UI_REVIEW_INCLUDE_CODE'] = '0';
    try {
      assert.equal(isUiReviewIncludeCodeEnabled(), false);
    } finally {
      if (prev === undefined) {
        delete process.env['CREATIVE_UI_REVIEW_INCLUDE_CODE'];
      } else {
        process.env['CREATIVE_UI_REVIEW_INCLUDE_CODE'] = prev;
      }
    }
  });
});
