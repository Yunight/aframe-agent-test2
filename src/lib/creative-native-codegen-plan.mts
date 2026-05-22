import type { AdFormatSelection } from './studio-ad-formats.mts';
import { z } from 'zod';

export const creativeNativePlanSchema = z
  .object({
    creativeConcept: z.string().describe('One-sentence creative concept in French'),
    formats: z
      .array(
        z
          .object({
            formatId: z.string(),
            layoutSummary: z.string(),
            keyInteractions: z.string(),
            headlineFrench: z.string(),
            ctaFrench: z.string()
          })
          .strict()
      )
      .min(1),
    colorUsageNotes: z.string(),
    typographyNotes: z.string()
  })
  .strict()
  .describe('Creative plan before HTML/CSS/JS implementation');

export type CreativeNativePlan = z.infer<typeof creativeNativePlanSchema>;

export function buildPlanPhaseUserMessage (adFormats: readonly AdFormatSelection[]): string {
  const sizes = adFormats.map((f) => `${f.id} (${String(f.width)}×${String(f.height)} px)`).join(', ');
  return (
    'Phase 1 — planning only. Using the style guide JSON and local assets above, produce a structured creative plan. '
    + `Cover every required format: ${sizes}. `
    + 'Do not output HTML/CSS/JS yet.'
  );
}

export function buildCodePhaseUserMessage (plan: CreativeNativePlan): string {
  return (
    'Phase 2 — implementation. Follow this approved creative plan exactly:\n\n'
    + `${JSON.stringify(plan, null, 2)}\n\n`
    + 'Now output the structured file list (index.html, styles.css, app.js) implementing the plan. '
    + 'Use only local asset paths and style guide colors/fonts.'
  );
}

export function isTwoPhaseCodegenEnabled (): boolean {
  return process.env['CREATIVE_TWO_PHASE']?.trim() === '1';
}
