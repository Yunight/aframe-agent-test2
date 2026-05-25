import type { UiReviewOutput } from '../agents/creative-native-ui-review.mts';

const REDESIGN_RE =
  /\b(redesign|rebuild|replace entire|from scratch|new layout|new concept|start over|refonte complète)\b/iu;

/** Use Sonnet for heavy patch rounds when Haiku would rewrite the whole bundle. */
export function resolveRegenModelFromUiAudit (audit: UiReviewOutput): string {
  const forced = process.env['CREATIVE_REGEN_MODEL']?.trim();
  if (forced !== undefined && forced.length > 0) {
    return forced;
  }

  const blockers = audit.findings.filter((f) => f.severity === 'blocker');
  const heavyText = [
    audit.regeneration_prompt,
    ...blockers.map((f) => `${f.issue} ${f.fix_hint}`)
  ].join('\n');

  if (blockers.length > 2 || REDESIGN_RE.test(heavyText)) {
    return 'claude-sonnet-4-6';
  }
  return 'claude-haiku-4-5-20251001';
}
