import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Anthropic } from '@anthropic-ai/sdk';
import { Resvg } from '@resvg/resvg-js';
import { chromium } from 'playwright';
import { isSvgAssetFile, readFileAsAnthropicImageBlock, sniffImageMimeFromBuffer } from './image-mime-sniff.mts';

const SVG_RASTER_WIDTH = 800;
const SVG_RASTER_VIEWPORT = { width: 800, height: 400 };

function isPlaywrightMissingError (err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|npx playwright install/iu.test(msg);
}

function rasterizeSvgWithResvg (svgMarkup: string): Buffer {
  const resvg = new Resvg(svgMarkup, {
    background: '#ffffff',
    fitTo: { mode: 'width', value: SVG_RASTER_WIDTH }
  });
  return Buffer.from(resvg.render().asPng());
}

async function rasterizeSvgWithPlaywright (svgMarkup: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: SVG_RASTER_VIEWPORT
    });
    await page.setContent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head>` +
        `<body style="margin:0;padding:16px;background:#ffffff;display:flex;align-items:center;justify-content:center;">` +
        `${svgMarkup}</body></html>`,
      { waitUntil: 'load' }
    );
    const locator = page.locator('svg').first();
    await locator.waitFor({ state: 'visible', timeout: 10_000 });
    const png = await locator.screenshot({ type: 'png' });
    return Buffer.from(png);
  } finally {
    await browser.close();
  }
}

/** Rasterize an SVG logo to PNG so Haiku vision can inspect it. */
export async function rasterizeSvgLogoToPngBuffer (absolutePath: string): Promise<Buffer> {
  const svgMarkup = readFileSync(absolutePath, 'utf8');
  let resvgError: string | undefined;
  try {
    const png = rasterizeSvgWithResvg(svgMarkup);
    console.log(`[logo-rasterize] rasterized via resvg: ${absolutePath}`);
    return png;
  } catch (err: unknown) {
    resvgError = err instanceof Error ? err.message : String(err);
    console.warn(`[logo-rasterize] resvg failed for ${absolutePath}: ${resvgError}`);
  }

  try {
    const png = await rasterizeSvgWithPlaywright(svgMarkup);
    console.log(`[logo-rasterize] rasterized via playwright: ${absolutePath}`);
    return png;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = isPlaywrightMissingError(err)
      ? ' Install Chromium with: npx playwright install chromium'
      : '';
    throw new Error(
      `SVG rasterization failed (resvg: ${resvgError ?? 'unknown'}; playwright: ${msg}).${hint}`
    );
  }
}

/** Read a logo file as an Anthropic vision image block (raster or SVG rasterized to PNG). */
export async function readLogoFileAsAnthropicImageBlock (
  absolutePath: string
): Promise<Anthropic.ImageBlockParam | null> {
  const buf = readFileSync(absolutePath);
  const fileName = absolutePath.split(/[/\\]/u).pop() ?? '';
  if (isSvgAssetFile(fileName, buf) || extname(absolutePath).toLowerCase() === '.svg') {
    try {
      const png = await rasterizeSvgLogoToPngBuffer(absolutePath);
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: png.toString('base64')
        }
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[logo-rasterize] Failed to rasterize ${absolutePath}: ${msg}`);
      return null;
    }
  }

  const mimeType = sniffImageMimeFromBuffer(buf);
  if (mimeType !== null) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: buf.toString('base64')
      }
    };
  }

  return readFileAsAnthropicImageBlock(absolutePath);
}
