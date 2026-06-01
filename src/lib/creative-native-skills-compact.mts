/**
 * Condensed design constraints for creative-native LLM prompts.
 * Full skill files remain in .claude/.skills/ for optional CREATIVE_USE_FULL_SKILLS=1.
 */
export const CREATIVE_DESIGN_SKILLS_COMPACT = `
## Mandatory design checklist (compact)

### Layout and hierarchy
- One clear focal point per ad frame; logo visible at readable scale (not tiny, not dominant).
- Respect exact IAB pixel dimensions per format wrapper; center single-format demos on the page.
- Use consistent spacing scale (4/8/12/16/24 px); avoid cramped or floating elements.
- Safe margins inside the ad frame: leave visible breathing room on all sides; the primary CTA must not sit flush against the bottom edge of #ad-{formatId} (footer padding or margin on the CTA).

### Color
- Use ONLY hex colors from the style guide primary and secondary palettes in CSS.
- Gradients/shadows: only palette hex + opacity or rgba(); never darken/lighten into a new hex.
- Sufficient contrast for text on backgrounds (WCAG-minded: avoid light-on-light).
- One accent color for CTA; do not invent new brand colors.

### Typography
- Use ONLY font families listed in the style guide typography array.
- Clear hierarchy: headline > subhead > body > legal/CTA; limit to 2–3 sizes per frame.
- French ad copy; short punchy headlines.

### Motion and interaction
- Subtle CSS animations (transitions, keyframes); no dependency on external animation libraries.
- Provide visible feedback on hover/tap where interactive (buttons, carousel).
- Respect reduced-motion: avoid seizure-inducing flashes; keep loops smooth.

### Assets
- Reference ONLY local ./filename paths for logos and products provided in the user message.
- Do not fetch or embed remote images, fonts, or scripts.
- SVG logos via <img src="./file.svg">; no filters on logos.

### Dark mode
- If a dark palette exists in the style guide, ensure logo remains visible (swap theme if needed).

### Output discipline
- Plain HTML5 + CSS + JS only; file:// compatible; no build tools, React, Tailwind, or npm.
`.trim();

export function isFullSkillsModeEnabled (): boolean {
  return process.env['CREATIVE_USE_FULL_SKILLS']?.trim() === '1';
}
