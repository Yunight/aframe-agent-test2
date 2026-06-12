import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractLogoCandidatesFromHtml } from './core.mjs';

const REDBULL_HOME_SNIPPET = `
<a class="menu-header__logo-container" href="/" aria-label="Red Bull">
  <img class="menu-header__logo" src="https://www.redbull.com/v3/resources/images/client/header/redbullcom-logo_double-with-text.svg" alt="Logo Red Bull">
</a>
<img alt="Logo Red Bull King of the Mousse" class="tile-content__logo tile-content__logo--space-logo-available" src="https://img.redbull.com/images/c_limit,w_150,h_150/redbullcom/2026/5/26/ffbf69cfntxjucrn30zs/red-bull-king-of-the-mousse-logo">
`;

describe('extractLogoCandidatesFromHtml', () => {
  it('prefers nav header wordmark over campaign tile logos (Red Bull)', () => {
    const pageUrl = 'https://www.redbull.com/fr-fr';
    const hosts = [ 'www.redbull.com', 'redbull.com' ];
    const candidates = extractLogoCandidatesFromHtml(REDBULL_HOME_SNIPPET, pageUrl, hosts, {
      brandName: 'Red Bull'
    });
    assert.ok(candidates.length >= 1);
    const top = candidates[0]!;
    assert.match(top.url, /redbullcom-logo_double-with-text\.svg/iu);
    assert.ok(top.score > 200);
    assert.equal(
      candidates.some((c) => /king-of-the-mousse-logo/iu.test(c.url)),
      false
    );
  });

  it('detects BEM header logo classes that \\blogo\\b misses', () => {
    assert.equal(/\blogo\b/iu.test('menu-header__logo'), false);
    const html =
      '<img class="menu-header__logo" src="https://example.com/brand-wordmark.svg" alt="logo">';
    const candidates = extractLogoCandidatesFromHtml(html, 'https://example.com/', [ 'example.com' ]);
    assert.equal(candidates.length, 1);
    assert.match(candidates[0]!.url, /brand-wordmark\.svg/iu);
  });
});
