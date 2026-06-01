import type { UiReviewOutput } from '../agents/creative-native-ui-review.mts';
import type { AdFormatSelection } from './studio-ad-formats.mts';
import {
  appendAdFormatDimensionRules,
  ensureAdFormatDomIdsInHtml,
  formatIdToAdDomId,
  htmlContainsAdDomId
} from './creative-native-ad-dom.mts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CAPTURE_BLOCKER_RE =
  /\b(dom node|screenshot capture|id\s*=\s*["']ad-|#ad-|non-capturable|selector|not found for format)\b/iu;

export function isCaptureOrDomBlockerAudit (audit: UiReviewOutput): boolean {
  const blockers = audit.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length === 0) {
    return CAPTURE_BLOCKER_RE.test(audit.summary) || CAPTURE_BLOCKER_RE.test(audit.regeneration_prompt);
  }
  return blockers.every(
    (f) =>
      CAPTURE_BLOCKER_RE.test(f.issue) ||
      CAPTURE_BLOCKER_RE.test(f.fix_hint) ||
      f.format_id === 'capture'
  );
}

export type DeterministicUiFixResult = {
  applied: boolean;
  details: string[];
};

/** Patch index.html / styles.css without LLM when capture failed due to missing ad ids. */
export function tryDeterministicCaptureFixes (
  codeDirectoryPath: string,
  adFormats: readonly AdFormatSelection[]
): DeterministicUiFixResult {
  const indexPath = join(codeDirectoryPath, 'index.html');
  const stylesPath = join(codeDirectoryPath, 'styles.css');
  if (!existsSync(indexPath)) {
    return { applied: false, details: [ 'index.html missing' ] };
  }

  const details: string[] = [];
  let html = readFileSync(indexPath, { encoding: 'utf8' });
  const beforeIds = adFormats.filter((f) => htmlContainsAdDomId(html, formatIdToAdDomId(f.id))).length;

  const { html: patchedHtml, fixedFormatIds } = ensureAdFormatDomIdsInHtml(html, adFormats);
  html = patchedHtml;
  if (fixedFormatIds.length > 0) {
    details.push(`Added id on ad container for: ${fixedFormatIds.join(', ')}`);
  }

  const afterIds = adFormats.filter((f) => htmlContainsAdDomId(html, formatIdToAdDomId(f.id))).length;
  if (afterIds > beforeIds) {
    writeFileSync(indexPath, html, { encoding: 'utf8' });
  }

  if (existsSync(stylesPath)) {
    const css = readFileSync(stylesPath, { encoding: 'utf8' });
    const { css: patchedCss, appended } = appendAdFormatDimensionRules(css, adFormats);
    if (appended) {
      writeFileSync(stylesPath, patchedCss, { encoding: 'utf8' });
      details.push('Appended #ad-{formatId} dimension rules for capture');
    }
  }

  return { applied: details.length > 0, details };
}
