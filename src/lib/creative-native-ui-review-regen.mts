import type { UiReviewOutput } from '../agents/creative-native-ui-review.mts';

const REDESIGN_RE =
  /\b(redesign|rebuild|replace entire|from scratch|new layout|new concept|start over|refonte complète)\b/iu;

const CAPTURE_BLOCKER_RE =
  /\b(dom node|screenshot capture|id\s*=\s*["']ad-|#ad-|non-capturable|selector)\b/iu;

export function buildStrictMinimalRegenSuffix (): string {
  return (
    '\n\nSTRICT MINIMAL PATCH (mandatory):\n' +
    '- Change only the lines required by the blockers above (often 1–10 lines total across all files).\n' +
    '- Do NOT rewrite styles.css or restructure the layout. Keep every unrelated rule and animation.\n' +
    '- Prefer editing existing selectors over adding new sections or renaming classes.\n' +
    '- If the only issue is capture/DOM id, add id="ad-{formatId}" and width/height on that selector only.'
  );
}

/** Prefer Sonnet for regen; Haiku only when explicitly requested. */
export function resolveRegenModelFromUiAudit (
  audit: UiReviewOutput,
  options?: { strictMinimalRetry?: boolean }
): string {
  const forced = process.env['CREATIVE_REGEN_MODEL']?.trim();
  if (forced !== undefined && forced.length > 0) {
    return forced;
  }

  if (process.env['CREATIVE_REGEN_USE_HAIKU']?.trim() === '1') {
    return 'claude-haiku-4-5-20251001';
  }

  if (options?.strictMinimalRetry === true) {
    return 'claude-sonnet-4-6';
  }

  const blockers = audit.findings.filter((f) => f.severity === 'blocker');
  const heavyText = [
    audit.regeneration_prompt,
    ...blockers.map((f) => `${f.issue} ${f.fix_hint}`)
  ].join('\n');

  const captureLike =
    blockers.length > 0 &&
    blockers.every(
      (f) =>
        CAPTURE_BLOCKER_RE.test(f.issue) ||
        CAPTURE_BLOCKER_RE.test(f.fix_hint) ||
        f.format_id === 'capture'
    );

  if (captureLike || blockers.length > 2 || REDESIGN_RE.test(heavyText)) {
    return 'claude-sonnet-4-6';
  }

  return 'claude-sonnet-4-6';
}
