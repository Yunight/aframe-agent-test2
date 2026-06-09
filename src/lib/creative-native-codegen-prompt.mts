import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import type { AdFormatSelection } from './studio-ad-formats.mts';
import { buildCreativeAdFormatInstructions } from './studio-ad-formats.mts';
import { CREATIVE_DESIGN_SKILLS_COMPACT, isFullSkillsModeEnabled } from './creative-native-skills-compact.mts';
import { loadDesignSkillGuidance } from './creative-native-skills.mts';
import {
  buildStyleGuideColorConstraintText,
  type StyleGuideCodegenHints
} from './style-guide-colors.mts';
import { buildStyleGuideFontConstraintText } from './style-guide-typography.mts';
import type { Anthropic } from '@anthropic-ai/sdk';

export const DEFAULT_CREATIVE_MODEL = 'claude-opus-4-6';
export const DEFAULT_CREATIVE_REGEN_MODEL = 'claude-sonnet-4-6';

export function resolveCreativeModel (isRegen: boolean): string {
  if (isRegen) {
    return process.env['CREATIVE_REGEN_MODEL']?.trim() ?? DEFAULT_CREATIVE_REGEN_MODEL;
  }
  const fromEnv = process.env['CREATIVE_MODEL']?.trim();
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_CREATIVE_MODEL;
}

/** Campaign product visuals — integrate prominently; multi-asset layouts encouraged. */
export function buildCampaignProductHeroInstruction (
  prunedStyleGuide: Pick<StyleGuide, 'productName' | 'brandName'>
): string {
  const product = prunedStyleGuide.productName?.trim() ?? '';
  const brand = prunedStyleGuide.brandName?.trim() ?? '';
  const label = product.length > 0 ? product : brand;
  if (label.length === 0) {
    return (
      'Integrate at least one product visual from the provided assets in each ad format. '
      + 'When multiple product images are available, use them creatively (carousel, gallery, hero + vignettes, etc.).'
    );
  }
  return (
    `Campaign focus: "${label}". Each format must include at least one product visual from products/ `
    + '(relative path ./filename.jpg). When several assets are provided, combine them freely — '
    + 'carousel, slideshow, animated grid, or layered hero are all valid. '
    + 'Do not substitute unrelated stock imagery.'
  );
}

/** Positive instruction when multiple product assets are available. */
export function buildMultiAssetCreativeInstruction (productAssetCount: number): string {
  if (productAssetCount <= 1) {
    return '';
  }
  return (
    `You have ${String(productAssetCount)} validated product visuals. Use them freely: `
    + 'carousel, slideshow, animated grid, hero + thumbnails, crossfade, and similar dynamic layouts. '
    + 'Combine multiple images when the format supports it.'
  );
}

export function buildCreativeVersionsInstruction (formats: readonly AdFormatSelection[]): string {
  const n = formats.length;
  if (n <= 1) {
    return (
      'Create a dynamic, interactive creative layout for the required ad frame. ' +
      'Carousels, slideshows, animated reveals, and micro-interactions are encouraged when multiple product assets are available.'
    );
  }
  if (n === 2) {
    return (
      'Create **one distinct layout per required ad format** (2 total). ' +
      'Each format gets its own wrapper and composition adapted to its aspect ratio.'
    );
  }
  return (
    `Create **one distinct layout per required ad format** (${String(n)} formats). ` +
    'Each format should have unique features and look while sharing brand tokens from the style guide.'
  );
}

export function loadSkillsForCodegenPrompt (repoRoot: string): string {
  if (isFullSkillsModeEnabled()) {
    return loadDesignSkillGuidance(repoRoot);
  }
  return CREATIVE_DESIGN_SKILLS_COMPACT;
}

export type CodegenSystemParts = {
  staticBlock: string;
  dynamicBlock: string;
};

export function buildRegenPatchSystemPrompt (params: {
  adFormats: readonly AdFormatSelection[];
  skillsText: string;
  styleGuide: StyleGuideCodegenHints;
}): string {
  return `You are patching an existing HTML5/CSS/JS advertisement bundle after a visual UI review.

The user message includes the CURRENT index.html, styles.css, and app.js. Your job is a **minimal corrective edit**, not a redesign.

Rules (strict):
- Fix ONLY issues described in the UI review feedback (blockers required; warns if easy).
- **Surgical patch only**: change the minimum lines needed (typically &lt; 5% of each file). Do NOT rewrite styles.css or index.html from scratch.
- If a fix is one CSS rule or one HTML attribute, change only that — leave all unrelated rules, selectors, animations, and copy unchanged.
- Preserve the existing creative concept, layout structure, DOM hierarchy, class names, and JS behavior unless a blocker requires a one-line structural fix.
- Do NOT invent a new format, new variant, or different visual concept.
- Do NOT add or remove IAB ad formats; keep the same format wrappers and ids (e.g. id="ad-{formatId}").
- Keep the same local asset paths (./logo.svg, product images) unless a blocker is about a wrong path.
- Return the complete updated index.html, styles.css, and app.js (structured output schema) — file bodies must be the existing code plus tiny edits, not a new design.
- When fixing capture/DOM issues: add or fix id="ad-{formatId}" and dimensions only — do not restyle the creative.

Stack: plain HTML5, CSS, JavaScript only. No React, bundlers, Tailwind, or npm. file:// compatible.

${buildCreativeAdFormatInstructions(params.adFormats)}

${buildStyleGuideColorConstraintText(params.styleGuide)}

${buildStyleGuideFontConstraintText(params.styleGuide)}

Ad copy in French.
Follow design skills for compliance on what you touch:
${params.skillsText}`.trim();
}

export function buildCodegenSystemParts (params: {
  isRegen: boolean;
  adFormats: readonly AdFormatSelection[];
  skillsText: string;
  styleGuide: StyleGuideCodegenHints;
  productAssetCount?: number;
}): CodegenSystemParts {
  if (params.isRegen) {
    return {
      staticBlock: buildRegenPatchSystemPrompt({
        adFormats: params.adFormats,
        skillsText: params.skillsText,
        styleGuide: params.styleGuide
      }),
      dynamicBlock: ''
    };
  }

  const productAssetCount = params.productAssetCount ?? 0;
  const multiAssetInstruction = buildMultiAssetCreativeInstruction(productAssetCount);

  const staticBlock = `You are an agent that invents modern interactive advertisement creatives.

Required stack: plain HTML5, CSS, and JavaScript only. No React, Vue, Svelte, no Vite/Webpack,
no Tailwind/DaisyUI/npm dependencies, no JSX/TSX, no build step. The result must open from disk
(file://) in a browser when index.html is loaded.

Assets: use ONLY the local logo and product files described in the user message (already downloaded and pre-described).
The "Visual description (authoritative)" lines in the user message are the ground truth for each asset — do NOT re-scan, re-describe, or infer new pixels; use only those descriptions and the local paths (e.g. ./product.jpg).
Do NOT search the web for new images, fonts, or brand facts — everything needed is in the style guide JSON and local assets.
${multiAssetInstruction.length > 0 ? `\n${multiAssetInstruction}\n` : ''}
${buildCreativeVersionsInstruction(params.adFormats)}

Graphic elements (fonts, colors, pictures) must follow only the JSON style guide from the user.
Layout and interaction design are your creative choice: fresh, modern, eye-catching — use animation,
carousels, transitions, and micro-interactions where they strengthen the ad.
Only use one logo image by default the light theme only; if the logo is not visible in the light theme, use the dark theme.
The logo should remain visible at a good scale; do not apply filters to the logo.
Logo and product images are local files copied next to index.html under code/. Reference them with
relative paths (e.g. ./brand-logo.svg or ./product.jpg). SVG logos: <img src="./filename.svg">.

Output: a list of files with their contents. Paths must be relative to the project root.

You MUST output exactly these root files (no subfolders required for these three):
- index.html — viewport meta width=device-width; link to styles.css; script src app.js (defer recommended).
- styles.css — all presentation (no preprocessor).
- app.js — vanilla DOM scripting only (no import maps to npm).

${buildCreativeAdFormatInstructions(params.adFormats)}

Optional: additional static assets only if needed (e.g. extra .svg), still no package.json or bundlers.

Fonts and colors: use ONLY hex colors from the closed allowlist in the user message and below.
For gradients/shadows use opacity or rgba() derived from a palette hex — never invent new hex codes.
Ad copy in French.
Include at least one logo and one product image from the provided assets in the HTML/CSS/JS.
Product visual integration is detailed in the user message (campaign product instruction).
Do not add browser chrome: no zoom, fullscreen, or VR toggles in the creative UI.

Gallery export (generic-config.json): follow style-guide-ui/public/ad-format-json-reference.md —
stable semantic classes: .eyebrow, .headline (accent inside <em> for headlineAccent), .subhead,
.body-copy, .ad-footer span for footer copy; plain Unicode in copy (no &amp; / &nbsp; in text nodes).
CTA: <a class="cta-btn" href="…"><span class="cta-label">Label</span></a> (export binds ctaText on the anchor only).
Skip non-editable chrome in the ad frame: no aria-hidden decorative layers (floating bubbles),
no ::before gradient strips on the ad root, no preview-only border-radius/box-shadow on the IAB wrapper.

The design skills below are brand compliance rules (colors, typography, logo visibility, IAB dimensions).
Prioritize creative layout and dynamic interactions; technical consistency is validated by the pipeline after generation.
Load brand typography via Google Fonts CDN only (see user message font constraints — no proprietary font names in CSS).
Follow the design skills below for brand compliance on color, typography, hierarchy, and interaction polish:
${params.skillsText}`.trim();

  const dynamicBlock = [
    buildStyleGuideColorConstraintText(params.styleGuide),
    buildStyleGuideFontConstraintText(params.styleGuide)
  ].join('\n\n');

  return { staticBlock, dynamicBlock };
}

/** System param with prompt caching on the static skills/stack block. */
export function buildCachedSystemParam (
  parts: CodegenSystemParts,
  extraDynamic?: string
): string | Anthropic.Messages.TextBlockParam[] {
  const useCache = process.env['CREATIVE_PROMPT_CACHE']?.trim() !== '0';
  const dynamicText = [ parts.dynamicBlock, extraDynamic ].filter((s) => s !== undefined && s.length > 0).join('\n\n');

  if (!useCache) {
    return dynamicText.length > 0 ? `${parts.staticBlock}\n\n${dynamicText}` : parts.staticBlock;
  }

  const blocks: Anthropic.Messages.TextBlockParam[] = [
    {
      type: 'text',
      text: parts.staticBlock,
      cache_control: { type: 'ephemeral' }
    }
  ];
  if (dynamicText.length > 0) {
    blocks.push({ type: 'text', text: dynamicText });
  }
  return blocks;
}

export function buildInitialThinkingConfig (isRegen: boolean): Record<string, unknown> | undefined {
  if (isRegen) {
    return undefined;
  }
  const mode = process.env['CREATIVE_THINKING_MODE']?.trim() ?? 'adaptive';
  if (mode === 'off' || mode === 'disabled') {
    return undefined;
  }
  if (mode === 'budget') {
    const raw = process.env['CREATIVE_THINKING_BUDGET_TOKENS']?.trim() ?? '32000';
    const budget = Number.parseInt(raw, 10);
    return {
      thinking: {
        type: 'enabled' as const,
        budget_tokens: Number.isFinite(budget) && budget > 0 ? budget : 32_000,
        display: 'omitted' as const
      }
    };
  }
  return {
    thinking: {
      type: 'adaptive' as const,
      display: 'omitted' as const
    }
  };
}
