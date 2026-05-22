import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import { allowedImageMimeTypes } from './brave-image-assets.mts';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { imageSizeFromFile } from 'image-size/fromFile';
import mime from 'mime';
import { validateLogoAssetFile } from './logo-transparency-check.mts';

export type DeterministicFinding = {
  asset_id: string;
  severity: 'blocker' | 'warn';
  issue: string;
  fix_hint: string;
};

export type DeterministicAssetsCheckResult = {
  ok: boolean;
  findings: DeterministicFinding[];
};

function parseEnvInt (name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MIN_LOGO_W = () => parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_W', 120);
const MIN_LOGO_H = () => parseEnvInt('CREATIVE_ASSETS_MIN_LOGO_H', 40);
const MIN_PRODUCT_W = () => parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_W', 200);
const MIN_PRODUCT_H = () => parseEnvInt('CREATIVE_ASSETS_MIN_PRODUCT_H', 200);

export function getAssetMinDimensions (fileType: 'logos' | 'products'): {
  minW: number;
  minH: number;
} {
  if (fileType === 'logos') {
    return { minW: MIN_LOGO_W(), minH: MIN_LOGO_H() };
  }
  return { minW: MIN_PRODUCT_W(), minH: MIN_PRODUCT_H() };
}

export async function pruneUndersizedAssets (directoryPath: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  for (const fileType of [ 'logos', 'products' ] as const) {
    const { minW, minH } = getAssetMinDimensions(fileType);
    const subdirectoryPath = join(directoryPath, fileType);
    for (const fileName of listImageFiles(subdirectoryPath)) {
      if (fileType === 'logos' && extname(fileName).toLowerCase() === '.svg') {
        continue;
      }
      const filePath = join(subdirectoryPath, fileName);
      try {
        const { width, height } = await imageSizeFromFile(filePath);
        if (
          width !== undefined &&
          height !== undefined &&
          (width < minW || height < minH)
        ) {
          unlinkSync(filePath);
          removed.push(`${fileType}/${fileName}`);
          console.log(
            `[assets-prune] Removed undersized ${fileType}/${fileName} (${String(width)}×${String(height)}, min ${String(minW)}×${String(minH)})`
          );
        }
      } catch {
        /* corrupt files stay for deterministic to flag */
      }
    }
  }
  return { removed };
}

export async function pruneInvalidLogos (directoryPath: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const subdirectoryPath = join(directoryPath, 'logos');
  for (const fileName of listImageFiles(subdirectoryPath)) {
    const filePath = join(subdirectoryPath, fileName);
    const check = validateLogoAssetFile(filePath);
    if (!check.ok) {
      unlinkSync(filePath);
      removed.push(`logos/${fileName}`);
      console.log(`[assets-prune] Removed invalid logo ${fileName}: ${check.issue}`);
    }
  }
  return { removed };
}

const MAX_FILE_BYTES = () => parseEnvInt('CREATIVE_ASSETS_MAX_FILE_BYTES', 5 * 1024 * 1024);

function listImageFiles (subdirectoryPath: string): string[] {
  if (!existsSync(subdirectoryPath)) {
    return [];
  }
  return readdirSync(subdirectoryPath).filter((name) => !name.startsWith('.'));
}

async function checkLogoFiles (
  directoryPath: string,
  minW: number,
  minH: number
): Promise<DeterministicFinding[]> {
  const findings: DeterministicFinding[] = [];
  const subdirectoryPath = join(directoryPath, 'logos');
  const files = listImageFiles(subdirectoryPath);

  if (files.length === 0) {
    findings.push({
      asset_id: 'logos',
      severity: 'blocker',
      issue: 'No files in logos/ directory.',
      fix_hint: 'Run style guide generation or assets refresh to download at least one logo.'
    });
    return findings;
  }

  for (const fileName of files) {
    const assetId = `logos/${fileName}`;
    const filePath = join(subdirectoryPath, fileName);
    const fileMimeType = mime.getType(fileName);
    const ext = extname(fileName).toLowerCase();
    const isSvg = ext === '.svg' || fileMimeType === 'image/svg+xml';

    if (!isSvg && (fileMimeType === null || !allowedImageMimeTypes.has(fileMimeType))) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `Unsupported or unknown MIME type: ${fileMimeType ?? 'null'}.`,
        fix_hint: 'Replace with PNG, JPEG, WebP, or SVG from the official brand site.'
      });
      continue;
    }

    const sizeBytes = statSync(filePath).size;
    if (sizeBytes > MAX_FILE_BYTES()) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `File size ${String(sizeBytes)} bytes exceeds max ${String(MAX_FILE_BYTES())}.`,
        fix_hint: 'Use a smaller image or raise CREATIVE_ASSETS_MAX_FILE_BYTES.'
      });
    }

    const validation = validateLogoAssetFile(filePath);
    if (!validation.ok) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: validation.issue,
        fix_hint: 'Source the official brand logo from companyURL/brandURL (PNG, JPEG, WebP, or SVG).'
      });
      continue;
    }

    if (validation.warn !== undefined) {
      findings.push({
        asset_id: assetId,
        severity: 'warn',
        issue: validation.warn,
        fix_hint: 'Confirm this lockup is from the official brand website, not a third-party scraper.'
      });
    }

    if (isSvg) {
      continue;
    }

    try {
      const { width, height } = await imageSizeFromFile(filePath);
      if (width === undefined || height === undefined) {
        findings.push({
          asset_id: assetId,
          severity: 'blocker',
          issue: 'Could not read image dimensions.',
          fix_hint: 'Replace with a valid raster image file.'
        });
        continue;
      }
      if (width < minW || height < minH) {
        findings.push({
          asset_id: assetId,
          severity: 'blocker',
          issue: `Dimensions ${String(width)}×${String(height)} below minimum ${String(minW)}×${String(minH)}.`,
          fix_hint: 'Download a higher-resolution logo via Brave refresh (official site).'
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `Failed to read image: ${msg}`,
        fix_hint: 'Replace the corrupt file.'
      });
    }
  }

  return findings;
}

async function checkImageFiles (
  fileType: 'logos' | 'products',
  directoryPath: string,
  minW: number,
  minH: number
): Promise<DeterministicFinding[]> {
  if (fileType === 'logos') {
    return checkLogoFiles(directoryPath, minW, minH);
  }
  const findings: DeterministicFinding[] = [];
  const subdirectoryPath = join(directoryPath, fileType);
  const files = listImageFiles(subdirectoryPath);

  if (files.length === 0) {
    findings.push({
      asset_id: fileType,
      severity: 'blocker',
      issue: `No files in ${fileType}/ directory.`,
      fix_hint: 'Run style guide generation or assets refresh to download at least one image.'
    });
    return findings;
  }

  for (const fileName of files) {
    const assetId = `${fileType}/${fileName}`;
    const filePath = join(subdirectoryPath, fileName);
    const fileMimeType = mime.getType(fileName);

    if (fileMimeType === null || !allowedImageMimeTypes.has(fileMimeType)) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `Unsupported or unknown MIME type: ${fileMimeType ?? 'null'}.`,
        fix_hint: 'Replace with JPEG, PNG, WebP, or GIF.'
      });
      continue;
    }

    const ext = extname(fileName).toLowerCase();
    const expectedExt = fileMimeType === 'image/jpeg' ? '.jpg' : `.${fileMimeType.split('/')[1]}`;
    if (ext !== expectedExt && !(fileMimeType === 'image/jpeg' && ext === '.jpeg')) {
      findings.push({
        asset_id: assetId,
        severity: 'warn',
        issue: `Extension ${ext} may not match MIME ${fileMimeType}.`,
        fix_hint: 'Use a consistent file extension for the image type.'
      });
    }

    const sizeBytes = statSync(filePath).size;
    if (sizeBytes > MAX_FILE_BYTES()) {
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `File size ${String(sizeBytes)} bytes exceeds max ${String(MAX_FILE_BYTES())}.`,
        fix_hint: 'Use a smaller image or raise CREATIVE_ASSETS_MAX_FILE_BYTES.'
      });
    }

    try {
      const { width, height } = await imageSizeFromFile(filePath);
      if (width === undefined || height === undefined) {
        findings.push({
          asset_id: assetId,
          severity: 'blocker',
          issue: 'Could not read image dimensions.',
          fix_hint: 'Replace with a valid raster image file.'
        });
        continue;
      }
      if (width < minW || height < minH) {
        findings.push({
          asset_id: assetId,
          severity: 'blocker',
          issue: `Dimensions ${String(width)}×${String(height)} below minimum ${String(minW)}×${String(minH)}.`,
          fix_hint: 'Download a higher-resolution asset via Brave refresh.'
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      findings.push({
        asset_id: assetId,
        severity: 'blocker',
        issue: `Failed to read image: ${msg}`,
        fix_hint: 'Replace the corrupt file.'
      });
    }
  }

  return findings;
}

function checkStyleGuideFields (styleGuide: StyleGuide): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];

  if (styleGuide.brandName.trim().length === 0) {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'brandName is empty.',
      fix_hint: 'Regenerate the style guide with a valid brand name.'
    });
  }

  if (styleGuide.primaryColorPalette.length < 1) {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'primaryColorPalette has no colors.',
      fix_hint: 'Regenerate the style guide with at least one primary hex color.'
    });
  }

  if (styleGuide.typography.length < 1) {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'typography array is empty.',
      fix_hint: 'Regenerate the style guide with typography entries.'
    });
  }

  const hexPattern = /^#[0-9A-Fa-f]{6}$/;
  for (const hex of [
    ...styleGuide.primaryColorPalette,
    ...styleGuide.secondaryColorPalette
  ]) {
    if (!hexPattern.test(hex)) {
      findings.push({
        asset_id: 'style_guide',
        severity: 'blocker',
        issue: `Invalid hex color: ${hex}`,
        fix_hint: 'Use #RRGGBB format in the style guide.'
      });
    }
  }

  return findings;
}

export async function runDeterministicAssetsCheck (
  directoryPath: string,
  styleGuide: StyleGuide
): Promise<DeterministicAssetsCheckResult> {
  const styleGuidePath = join(directoryPath, 'style-guide.json');
  const findings: DeterministicFinding[] = [];

  if (!existsSync(styleGuidePath)) {
    return {
      ok: false,
      findings: [
        {
          asset_id: 'style_guide',
          severity: 'blocker',
          issue: 'Missing style-guide.json.',
          fix_hint: 'Run src/agents/gen-style-guide.mts first.'
        }
      ]
    };
  }

  try {
    JSON.parse(readFileSync(styleGuidePath, 'utf8'));
  } catch {
    findings.push({
      asset_id: 'style_guide',
      severity: 'blocker',
      issue: 'style-guide.json is not valid JSON.',
      fix_hint: 'Fix or regenerate the style guide file.'
    });
  }

  findings.push(...checkStyleGuideFields(styleGuide));
  findings.push(
    ...(await checkImageFiles('logos', directoryPath, MIN_LOGO_W(), MIN_LOGO_H()))
  );
  findings.push(
    ...(await checkImageFiles('products', directoryPath, MIN_PRODUCT_W(), MIN_PRODUCT_H()))
  );

  const blockers = findings.filter((f) => f.severity === 'blocker');
  return {
    ok: blockers.length === 0,
    findings
  };
}

export function logDeterministicFindings (findings: DeterministicFinding[]): void {
  if (findings.length === 0) {
    console.log('[assets-deterministic] (no issues)');
    return;
  }
  console.log(`[assets-deterministic] findings (${String(findings.length)}):`);
  for (const f of findings) {
    console.log(`[assets-deterministic]   [${f.severity}] ${f.asset_id}: ${f.issue}`);
    console.log(`[assets-deterministic]     fix: ${f.fix_hint}`);
  }
}
