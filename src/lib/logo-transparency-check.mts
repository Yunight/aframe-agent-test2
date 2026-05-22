import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ]);

export type LogoAssetValidation = {
  ok: boolean;
  issue: string;
  warn?: string;
  transparentRatio?: number;
};

/** @deprecated Use LogoAssetValidation */
export type LogoTransparencyResult = LogoAssetValidation;

function parseEnvFloat (name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export function logoMinTransparentRatio (): number {
  return parseEnvFloat('CREATIVE_ASSETS_LOGO_MIN_TRANSPARENT_RATIO', 0.02);
}

/** When `1`, reject JPEG/opaque PNG and enforce alpha ratio (legacy strict mode). */
export function logoRequireTransparency (): boolean {
  return process.env['CREATIVE_ASSETS_LOGO_REQUIRE_TRANSPARENT']?.trim() === '1';
}

/** Reject known low-quality third-party logo URLs (not JPEG — opaque official JPEG is OK). */
export function isUntrustedLogoUrl (url: string): boolean {
  const lower = url.toLowerCase();
  if (/kindpng|pngaaa|pngtree|freepng|clipart|stickpng|cleanpng/iu.test(lower)) {
    return true;
  }
  if (/favicon|sprite|emoji|avatar/iu.test(lower)) {
    return true;
  }
  return false;
}

/** @deprecated Use isUntrustedLogoUrl */
export function isOpaqueLogoUrl (url: string): boolean {
  return isUntrustedLogoUrl(url);
}

function isValidSvgMarkup (buffer: Buffer): boolean {
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 4096)).trim();
  return (
    head.includes('<svg') &&
    (head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!'))
  );
}

function paethPredictor (a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}

function unfilterScanline (
  filter: number,
  row: Buffer,
  prev: Buffer,
  bpp: number
): Buffer {
  const out = Buffer.from(row);
  const length = row.length;
  switch (filter) {
    case 0:
      return out;
    case 1:
      for (let i = bpp; i < length; i++) {
        const cur = out[i] ?? 0;
        const ref = out[i - bpp] ?? 0;
        out[i] = (cur + ref) & 0xff;
      }
      return out;
    case 2:
      for (let i = 0; i < length; i++) {
        const cur = out[i] ?? 0;
        out[i] = (cur + (prev[i] ?? 0)) & 0xff;
      }
      return out;
    case 3:
      for (let i = 0; i < length; i++) {
        const cur = out[i] ?? 0;
        const left = i >= bpp ? (out[i - bpp] ?? 0) : 0;
        const up = prev[i] ?? 0;
        out[i] = (cur + Math.floor((left + up) / 2)) & 0xff;
      }
      return out;
    case 4:
      for (let i = 0; i < length; i++) {
        const cur = out[i] ?? 0;
        const left = i >= bpp ? (out[i - bpp] ?? 0) : 0;
        const up = prev[i] ?? 0;
        const upLeft = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
        out[i] = (cur + paethPredictor(left, up, upLeft)) & 0xff;
      }
      return out;
    default:
      return out;
  }
}

function readPngChunks (buffer: Buffer): Map<string, Buffer[]> {
  const chunks = new Map<string, Buffer[]>();
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    const list = chunks.get(type) ?? [];
    list.push(data);
    chunks.set(type, list);
    offset += 12 + length;
    if (type === 'IEND') {
      break;
    }
  }
  return chunks;
}

function analyzePngTransparencyStrict (
  buffer: Buffer,
  minRatio: number
): LogoAssetValidation {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, issue: 'Not a valid PNG file.' };
  }

  const chunks = readPngChunks(buffer);
  const ihdr = chunks.get('IHDR')?.[0];
  if (ihdr === undefined || ihdr.length < 13) {
    return { ok: false, issue: 'Missing PNG IHDR chunk.' };
  }

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];

  if (bitDepth !== 8) {
    return {
      ok: false,
      issue: `PNG bit depth ${String(bitDepth)} not supported for transparency check (expected 8).`
    };
  }

  if (colorType === 2 || colorType === 0) {
    return {
      ok: false,
      issue: `PNG has no alpha channel (color type ${String(colorType)}); opaque RGB/gray file named .png.`
    };
  }

  const hasTrns = (chunks.get('tRNS')?.length ?? 0) > 0;
  if (colorType === 3 && !hasTrns) {
    return { ok: false, issue: 'Indexed PNG without tRNS chunk — no transparency.' };
  }

  if (colorType === 3 && hasTrns) {
    return { ok: true, issue: '', transparentRatio: 1 };
  }

  if (colorType !== 4 && colorType !== 6) {
    return {
      ok: false,
      issue: `Unsupported PNG color type ${String(colorType)} for logo transparency.`
    };
  }

  const idatParts = chunks.get('IDAT') ?? [];
  if (idatParts.length === 0) {
    return { ok: false, issue: 'PNG missing IDAT data.' };
  }

  const raw = inflateSync(Buffer.concat(idatParts));
  const bpp = colorType === 4 ? 2 : 4;
  const stride = width * bpp + 1;
  let transparent = 0;
  let total = 0;
  let prev = Buffer.alloc(width * bpp);

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    if (rowStart >= raw.length) {
      break;
    }
    const filter = raw[rowStart] ?? 0;
    const row = unfilterScanline(
      filter,
      raw.subarray(rowStart + 1, rowStart + stride),
      prev,
      bpp
    );
    prev = Buffer.from(row);
    for (let x = 0; x < width; x++) {
      const alphaByte = colorType === 4 ? (row[x * 2 + 1] ?? 255) : (row[x * 4 + 3] ?? 255);
      total += 1;
      if (alphaByte < 128) {
        transparent += 1;
      }
    }
  }

  const ratio = total > 0 ? transparent / total : 0;
  if (ratio < minRatio) {
    return {
      ok: false,
      issue:
        `PNG has alpha but only ${(ratio * 100).toFixed(1)}% transparent pixels (min ${(minRatio * 100).toFixed(1)}%). ` +
        'Likely fake transparency (solid or checkerboard background).',
      transparentRatio: ratio
    };
  }

  return { ok: true, issue: '', transparentRatio: ratio };
}

function analyzePngTransparencyRelaxed (buffer: Buffer, minRatio: number): LogoAssetValidation {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, issue: 'Not a valid PNG file.' };
  }

  const chunks = readPngChunks(buffer);
  const ihdr = chunks.get('IHDR')?.[0];
  if (ihdr === undefined || ihdr.length < 13) {
    return { ok: false, issue: 'Missing PNG IHDR chunk.' };
  }

  const colorType = ihdr[9];

  if (colorType === 2 || colorType === 0) {
    return {
      ok: true,
      issue: '',
      warn: 'Opaque PNG (no alpha channel); acceptable for official logos on solid backgrounds.'
    };
  }

  const strict = analyzePngTransparencyStrict(buffer, minRatio);
  if (!strict.ok && strict.transparentRatio !== undefined) {
    return {
      ok: true,
      issue: '',
      warn: strict.issue,
      transparentRatio: strict.transparentRatio
    };
  }

  return strict;
}

function analyzeWebpLogo (buffer: Buffer, strict: boolean): LogoAssetValidation {
  if (
    buffer.length < 12 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return { ok: false, issue: 'Not a valid WebP file.' };
  }

  let offset = 12;
  let hasAlphaFlag = false;
  while (offset + 8 <= buffer.length) {
    const chunk = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (chunk === 'VP8X' && offset + 9 <= buffer.length) {
      const flags = buffer[offset + 8] ?? 0;
      hasAlphaFlag = (flags & 0x10) !== 0;
    }
    offset += 8 + size + (size % 2);
  }

  if (strict && !hasAlphaFlag) {
    return {
      ok: false,
      issue: 'WebP without alpha channel (VP8X); not suitable for HTML5 logo overlay.'
    };
  }

  if (!hasAlphaFlag) {
    return {
      ok: true,
      issue: '',
      warn: 'Opaque WebP logo; acceptable when sourced from the official brand site.'
    };
  }

  return { ok: true, issue: '', transparentRatio: 1 };
}

export function validateLogoAssetBuffer (buffer: Buffer): LogoAssetValidation {
  const strict = logoRequireTransparency();
  const minRatio = logoMinTransparentRatio();

  const trimmed = buffer.toString('utf8', 0, Math.min(buffer.length, 256)).trim();
  if (trimmed.startsWith('<svg') || trimmed.startsWith('<?xml') || trimmed.includes('<svg')) {
    return isValidSvgMarkup(buffer)
      ? { ok: true, issue: '' }
      : { ok: false, issue: 'Invalid or unreadable SVG logo markup.' };
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    if (strict) {
      return {
        ok: false,
        issue: 'JPEG has no transparency channel; logos must be PNG or WebP with real alpha.'
      };
    }
    return {
      ok: true,
      issue: '',
      warn: 'JPEG logo (opaque); ensure it comes from the official brand site.'
    };
  }

  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return strict
      ? analyzePngTransparencyStrict(buffer, minRatio)
      : analyzePngTransparencyRelaxed(buffer, minRatio);
  }

  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    return analyzeWebpLogo(buffer, strict);
  }

  if (buffer.length >= 6 && buffer.toString('ascii', 0, 6) === 'GIF89a') {
    return {
      ok: false,
      issue: 'GIF is not accepted for logos; use PNG, JPEG, WebP, or SVG from official sources.'
    };
  }

  return {
    ok: false,
    issue: 'Unsupported logo format; use PNG, JPEG, WebP, or SVG from the official brand site.'
  };
}

export function validateLogoAssetFile (filePath: string): LogoAssetValidation {
  try {
    const buffer = readFileSync(filePath);
    return validateLogoAssetBuffer(buffer);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, issue: `Failed to read logo file: ${msg}` };
  }
}

/** @deprecated Use validateLogoAssetFile */
export function analyzeLogoTransparencyFile (filePath: string): LogoAssetValidation {
  return validateLogoAssetFile(filePath);
}

/** @deprecated Use validateLogoAssetBuffer */
export function analyzeLogoTransparencyBuffer (buffer: Buffer): LogoAssetValidation {
  return validateLogoAssetBuffer(buffer);
}
