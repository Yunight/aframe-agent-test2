import type { AdFormatSelection } from './studio-ad-formats.mts';
import {
  appendPipelineUsage,
  entryZeroCost,
  logPipelineUsageToConsole
} from './creative-pipeline-usage.mts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';

export type ScreenshotState = 'initial' | 'animated' | 'settled';

export type ScreenshotManifestEntry = {
  format_id: string;
  width: number;
  height: number;
  selector: string | null;
  error: string | null;
  shots: Array<{
    state: ScreenshotState;
    fileName: string;
    relativePath: string;
    captured_at: string;
  }>;
};

export type ScreenshotManifest = {
  captured_at: string;
  entry_html: string;
  entry_url: string;
  formats: ScreenshotManifestEntry[];
};

export type CaptureScreenshotsOptions = {
  codeDirectoryPath: string;
  adFormats: readonly AdFormatSelection[];
  outputScreensDir: string;
  /** Run root `output/<uuid>/` for pipeline-usage.json ledger. */
  directoryPath?: string;
  reviewRound?: number;
  initialWaitMs?: number;
  animatedWaitMs?: number;
  settledWaitMs?: number;
  viewportMarginPx?: number;
};

const SCREENSHOT_STATES: readonly ScreenshotState[] = [ 'initial', 'animated', 'settled' ];

function screenshotStatesForProfile (): readonly ScreenshotState[] {
  const profile = process.env['CREATIVE_SCREENSHOT_PROFILE']?.trim().toLowerCase();
  if (profile === 'dev' || profile === 'fast') {
    return [ 'settled' ];
  }
  return SCREENSHOT_STATES;
}

function parsePositiveIntEnv (name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(n, max);
}

function formatIdToDomId (formatId: string): string {
  return `ad-${formatId.replace(/×/g, 'x')}`;
}

function sanitizeFileSegment (value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
}

function buildSelectorCandidates (format: AdFormatSelection): string[] {
  const domId = formatIdToDomId(format.id);
  return [
    `#${domId}`,
    `#${domId.replace(/:/g, '\\:')}`,
    `[data-width="${String(format.width)}"][data-height="${String(format.height)}"] .ad-unit`,
    `.preview-wrapper[data-width="${String(format.width)}"][data-height="${String(format.height)}"] .ad-unit`,
    `.ad-unit[style*="width:${String(format.width)}px"][style*="height:${String(format.height)}px"]`
  ];
}

async function resolveAdUnitLocator (page: Page, format: AdFormatSelection): Promise<{ selector: string } | { error: string }> {
  for (const selector of buildSelectorCandidates(format)) {
    const locator = page.locator(selector).first();
    const count = await locator.count();
    if (count > 0) {
      return { selector };
    }
  }
  return {
    error: `No DOM node found for format "${format.id}" (tried ${buildSelectorCandidates(format).join(', ')})`
  };
}

type DomElementLike = {
  style: { transform: string; transformOrigin: string; overflow: string; width: string; height: string };
  offsetWidth: number;
  offsetHeight: number;
  closest: (selector: string) => DomElementLike | null;
  scrollIntoView: (options: { block: string; inline: string }) => void;
};

async function bypassPreviewScale (page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const doc = (globalThis as { document?: { querySelector: (s: string) => DomElementLike | null } }).document;
    if (doc === undefined) {
      return;
    }
    const el = doc.querySelector(sel);
    if (el === null) {
      return;
    }
    el.style.transform = 'none';
    el.style.transformOrigin = 'top left';
    const wrapper = el.closest('.preview-wrapper');
    if (wrapper !== null) {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      wrapper.style.transform = 'none';
      wrapper.style.width = `${String(w)}px`;
      wrapper.style.height = `${String(h)}px`;
      wrapper.style.overflow = 'visible';
    }
    const slot = el.closest('.ad-slot');
    if (slot !== null) {
      slot.style.overflow = 'visible';
    }
  }, selector);
}

async function scrollAdUnitIntoView (page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const doc = (globalThis as { document?: { querySelector: (s: string) => DomElementLike | null } }).document;
    if (doc === undefined) {
      return;
    }
    const el = doc.querySelector(sel);
    el?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, selector);
}

async function captureFormatScreenshots (
  format: AdFormatSelection,
  entryUrl: string,
  outputScreensDir: string,
  waits: { initial: number; animated: number; settled: number },
  viewportMarginPx: number
): Promise<ScreenshotManifestEntry> {
  const browser = await chromium.launch({
    headless: true,
    args: [ '--allow-file-access-from-files', '--disable-web-security' ]
  });

  const shots: ScreenshotManifestEntry['shots'] = [];
  let resolvedSelector: string | null = null;
  let resolveError: string | null = null;

  try {
    const context = await browser.newContext({
      viewport: {
        width: Math.min(format.width + viewportMarginPx * 2, 4096),
        height: Math.min(format.height + viewportMarginPx * 2, 4096)
      },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();
    await page.goto(entryUrl, { waitUntil: 'networkidle', timeout: 60_000 });

    const resolved = await resolveAdUnitLocator(page, format);
    if ('error' in resolved) {
      resolveError = resolved.error;
      return {
        format_id: format.id,
        width: format.width,
        height: format.height,
        selector: null,
        error: resolveError,
        shots: []
      };
    }

    resolvedSelector = resolved.selector;
    const locator = page.locator(resolvedSelector).first();
    await locator.waitFor({ state: 'visible', timeout: 15_000 });

    for (const state of screenshotStatesForProfile()) {
      await bypassPreviewScale(page, resolvedSelector);
      await scrollAdUnitIntoView(page, resolvedSelector);

      if (state === 'initial') {
        if (waits.initial > 0) {
          await page.waitForTimeout(waits.initial);
        }
      } else if (state === 'animated') {
        await page.waitForTimeout(waits.animated);
      } else {
        await page.waitForTimeout(waits.settled);
      }

      await bypassPreviewScale(page, resolvedSelector);

      const fileName = `${sanitizeFileSegment(format.id)}__${state}.png`;
      const absolutePath = join(outputScreensDir, fileName);
      await locator.screenshot({ path: absolutePath, type: 'png' });
      shots.push({
        state,
        fileName,
        relativePath: fileName,
        captured_at: new Date().toISOString()
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }

  return {
    format_id: format.id,
    width: format.width,
    height: format.height,
    selector: resolvedSelector,
    error: resolveError,
    shots
  };
}

export async function captureCreativeNativeScreenshots (
  options: CaptureScreenshotsOptions
): Promise<ScreenshotManifest> {
  const {
    codeDirectoryPath,
    adFormats,
    outputScreensDir
  } = options;

  const entryHtmlPath = join(codeDirectoryPath, 'index.html');
  if (!existsSync(entryHtmlPath)) {
    throw new Error(`Missing index.html in code directory: ${entryHtmlPath}`);
  }

  mkdirSync(outputScreensDir, { recursive: true });

  const devProfile = process.env['CREATIVE_SCREENSHOT_PROFILE']?.trim().toLowerCase() === 'dev'
    || process.env['CREATIVE_SCREENSHOT_PROFILE']?.trim().toLowerCase() === 'fast';
  const initialWaitMs =
    options.initialWaitMs
    ?? parsePositiveIntEnv('CREATIVE_SCREENSHOT_INITIAL_WAIT_MS', devProfile ? 200 : 600, 30_000);
  const animatedWaitMs =
    options.animatedWaitMs
    ?? parsePositiveIntEnv('CREATIVE_SCREENSHOT_ANIMATED_WAIT_MS', devProfile ? 800 : 2500, 60_000);
  const settledWaitMs =
    options.settledWaitMs
    ?? parsePositiveIntEnv('CREATIVE_SCREENSHOT_SETTLED_WAIT_MS', devProfile ? 1500 : 5000, 120_000);
  const viewportMarginPx = options.viewportMarginPx ?? 48;

  const entryUrl = pathToFileURL(entryHtmlPath).toString();
  const waits = { initial: initialWaitMs, animated: animatedWaitMs, settled: settledWaitMs };

  console.log(`[screenshots] Capturing ${String(adFormats.length)} format(s) → ${outputScreensDir}`);
  const startedAt = Date.now();

  const formatEntries = await Promise.all(
    adFormats.map((format) =>
      captureFormatScreenshots(format, entryUrl, outputScreensDir, waits, viewportMarginPx)
    )
  );

  const manifest: ScreenshotManifest = {
    captured_at: new Date().toISOString(),
    entry_html: entryHtmlPath,
    entry_url: entryUrl,
    formats: formatEntries
  };

  const manifestPath = join(outputScreensDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' });
  console.log(`[screenshots] Manifest written: ${manifestPath}`);

  const pngCount = formatEntries.reduce((n, f) => n + f.shots.length, 0);
  const captureErrors = formatEntries.filter((f) => f.error !== null).length;
  const durationMs = Date.now() - startedAt;
  const ledgerDir = options.directoryPath;
  if (ledgerDir !== undefined && ledgerDir.length > 0) {
    const notes = `${String(pngCount)} PNG, ${String(adFormats.length)} format(s), ${String(captureErrors)} capture error(s), ${String(durationMs)} ms`;
    const file = appendPipelineUsage(
      ledgerDir,
      entryZeroCost({
        action: 'screenshots',
        agent: 'lib/creative-native-playwright-screenshots.mts',
        review_round: options.reviewRound ?? null,
        notes,
        duration_ms: durationMs
      })
    );
    logPipelineUsageToConsole(file.entries[file.entries.length - 1]!);
  }

  return manifest;
}
