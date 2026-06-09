import type { AdFormatSelection } from './studio-ad-formats.mts';
import { collectReferencedAssetFileNamesFromBundleSource } from './creative-bundle-assets.mts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type BundleIntegrityFinding = {
  format_id: string;
  severity: 'blocker' | 'warn';
  issue: string;
  fix_hint: string;
};

function readBundleSource (bundleDir: string): { html: string; css: string; js: string } | null {
  const indexPath = join(bundleDir, 'index.html');
  if (!existsSync(indexPath)) {
    return null;
  }
  const html = readFileSync(indexPath, { encoding: 'utf8' });
  const stylesPath = join(bundleDir, 'styles.css');
  const jsPath = join(bundleDir, 'app.js');
  return {
    html,
    css: existsSync(stylesPath) ? readFileSync(stylesPath, { encoding: 'utf8' }) : '',
    js: existsSync(jsPath) ? readFileSync(jsPath, { encoding: 'utf8' }) : ''
  };
}

function countHtmlSlides (html: string): number {
  const classMatches = html.match(/\bclass=["'][^"']*\bslide\b[^"']*["']/giu) ?? [];
  return classMatches.length;
}

function extractJsSlideCount (js: string): number | null {
  const match = js.match(/\bSLIDE_COUNT\s*=\s*(\d+)/u);
  if (match === null) {
    return null;
  }
  const n = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

function jsCreatesPaginationDots (js: string): boolean {
  return /\bslide-dots\b/u.test(js) || /\bclassName\s*=\s*['"]dot['"]/u.test(js);
}

function formatIdsFromBundle (html: string, adFormats: readonly AdFormatSelection[]): string[] {
  const fromDom = adFormats
    .map((f) => f.id)
    .filter((id) => new RegExp(`\\bid=["']ad-${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}["']`, 'iu').test(html));
  return fromDom.length > 0 ? fromDom : adFormats.map((f) => f.id);
}

/** Deterministic bundle checks before UI vision review. */
export function auditCreativeBundleIntegrity (params: {
  bundleDir: string;
  adFormats: readonly AdFormatSelection[];
}): BundleIntegrityFinding[] {
  const source = readBundleSource(params.bundleDir);
  if (source === null) {
    return [
      {
        format_id: 'bundle',
        severity: 'blocker',
        issue: 'index.html missing from code bundle',
        fix_hint: 'Ensure codegen writes index.html into the active code version directory.'
      }
    ];
  }

  const findings: BundleIntegrityFinding[] = [];
  const formatIds = formatIdsFromBundle(source.html, params.adFormats);
  const primaryFormatId = formatIds[0] ?? 'bundle';

  const referencedNames = collectReferencedAssetFileNamesFromBundleSource(source);
  const missingInBundle: string[] = [];
  for (const refName of referencedNames) {
    if (!existsSync(join(params.bundleDir, refName))) {
      missingInBundle.push(refName);
    }
  }
  if (missingInBundle.length > 0) {
    findings.push({
      format_id: primaryFormatId,
      severity: 'blocker',
      issue: `Referenced local assets missing from bundle: ${missingInBundle.join(', ')}`,
      fix_hint:
        'Copy each missing file into the code bundle (same folder as index.html) or update HTML/CSS/JS '
        + 'to reference only assets present in the bundle. For carousels, ensure every background-image and src path resolves.'
    });
  }

  const htmlSlideCount = countHtmlSlides(source.html);
  const jsSlideCount = extractJsSlideCount(source.js);
  const hasDots = jsCreatesPaginationDots(source.js);

  if (hasDots && htmlSlideCount <= 1) {
    findings.push({
      format_id: primaryFormatId,
      severity: 'blocker',
      issue: 'Pagination dots are rendered but the HTML defines at most one carousel slide',
      fix_hint:
        'Either add multiple .slide elements with working background images, or remove slide-dots from app.js '
        + 'when slide count <= 1. Derive slide count from DOM: document.querySelectorAll(".bg-slides .slide").length.'
    });
  }

  if (hasDots && jsSlideCount !== null && htmlSlideCount > 0 && jsSlideCount !== htmlSlideCount) {
    findings.push({
      format_id: primaryFormatId,
      severity: 'blocker',
      issue: `SLIDE_COUNT (${String(jsSlideCount)}) does not match HTML slide elements (${String(htmlSlideCount)})`,
      fix_hint:
        'Set SLIDE_COUNT from the DOM slide count instead of a hardcoded number, e.g. '
        + 'var SLIDE_COUNT = document.querySelectorAll(".bg-slides .slide").length; hide dots when SLIDE_COUNT <= 1.'
    });
  }

  if (hasDots && htmlSlideCount >= 2 && missingInBundle.length > 0) {
    findings.push({
      format_id: primaryFormatId,
      severity: 'blocker',
      issue: 'Carousel pagination dots are shown but one or more slide background images are missing from the bundle',
      fix_hint:
        'Copy missing slide images into the bundle or remove pagination dots until all carousel assets load.'
    });
  }

  return findings;
}

export function mergeBundleIntegrityIntoUiAudit<T extends {
  satisfied: boolean;
  findings: Array<{ format_id: string; severity: 'blocker' | 'warn'; issue: string; fix_hint: string }>;
  regeneration_prompt: string;
}> (
  audit: T,
  integrityFindings: BundleIntegrityFinding[]
): T {
  const blockers = integrityFindings.filter((f) => f.severity === 'blocker');
  if (blockers.length === 0) {
    return audit;
  }
  audit.satisfied = false;
  audit.findings = [ ...audit.findings, ...blockers ];
  if (audit.regeneration_prompt.trim().length === 0) {
    audit.regeneration_prompt = blockers.map((f) => `${f.format_id}: ${f.fix_hint}`).join('\n');
  } else {
    audit.regeneration_prompt = `${audit.regeneration_prompt}\n\n${blockers.map((f) => f.fix_hint).join('\n')}`;
  }
  return audit;
}
