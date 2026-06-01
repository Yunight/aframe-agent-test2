import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendAdFormatDimensionRules,
  ensureAdFormatDomIdsInHtml,
  htmlContainsAdDomId
} from './creative-native-ad-dom.mts';

const format320x480 = { id: '320x480', width: 320, height: 480 } as const;

test('ensureAdFormatDomIdsInHtml adds id on ad-frame', () => {
  const html =
    '<div class="ad-wrapper"><div class="ad-frame"><p>Ad</p></div></div>';
  const { html: out, fixedFormatIds } = ensureAdFormatDomIdsInHtml(html, [ format320x480 ]);
  assert.deepEqual(fixedFormatIds, [ '320x480' ]);
  assert.equal(htmlContainsAdDomId(out, 'ad-320x480'), true);
});

test('appendAdFormatDimensionRules appends missing selector block', () => {
  const { css, appended } = appendAdFormatDimensionRules('body {}', [ format320x480 ]);
  assert.equal(appended, true);
  assert.match(css, /#ad-320x480/);
  assert.match(css, /320px/);
});
