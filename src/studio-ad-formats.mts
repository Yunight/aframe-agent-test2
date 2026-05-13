import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ArcheSpec {
  headerPx: number;
  gutterPx: number;
  mainFocusWidthPx: number;
  maxTotalWeightKB: number;
  allowedRasterMime: readonly string[];
  trackingNote: string;
  companionPresetIds: readonly string[];
}

export interface AdFormatPreset {
  id: string;
  width: number;
  height: number;
  label: string;
  arche?: ArcheSpec;
}

export interface AdFormatSelection {
  id: string;
  width: number;
  height: number;
  arche?: ArcheSpec;
}

const MIN_DIM = 16;
const MAX_DIM = 4096;
const MAX_FORMATS = 8;

function isPlainObject (v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseArcheSpec (value: unknown): ArcheSpec | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    throw new Error('Preset "arche" must be an object when present.');
  }
  const o = value;
  const headerPx = typeof o['headerPx'] === 'number' && Number.isInteger(o['headerPx']) ? o['headerPx'] : null;
  const gutterPx = typeof o['gutterPx'] === 'number' && Number.isInteger(o['gutterPx']) ? o['gutterPx'] : null;
  const mainFocusWidthPx =
    typeof o['mainFocusWidthPx'] === 'number' && Number.isInteger(o['mainFocusWidthPx']) ? o['mainFocusWidthPx'] : null;
  const maxTotalWeightKB =
    typeof o['maxTotalWeightKB'] === 'number' && Number.isInteger(o['maxTotalWeightKB']) ? o['maxTotalWeightKB'] : null;
  const trackingNote = typeof o['trackingNote'] === 'string' ? o['trackingNote'].trim() : '';
  const mimeRaw = o['allowedRasterMime'];
  if (
    headerPx === null ||
    gutterPx === null ||
    mainFocusWidthPx === null ||
    maxTotalWeightKB === null ||
    trackingNote.length === 0 ||
    !Array.isArray(mimeRaw)
  ) {
    throw new Error('Invalid "arche" object in ad-formats preset (missing fields).');
  }
  const allowedRasterMime = mimeRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  if (allowedRasterMime.length === 0) {
    throw new Error('Invalid "arche.allowedRasterMime" in ad-formats preset.');
  }
  const compRaw = o['companionPresetIds'];
  if (!Array.isArray(compRaw)) {
    throw new Error('Invalid "arche.companionPresetIds" in ad-formats preset.');
  }
  const companionPresetIds = compRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return {
    headerPx,
    gutterPx,
    mainFocusWidthPx,
    maxTotalWeightKB,
    allowedRasterMime,
    trackingNote,
    companionPresetIds
  };
}

export function loadAdFormatPresets (repoRoot: string): AdFormatPreset[] {
  const path = join(repoRoot, 'shared', 'ad-formats.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { presets?: unknown };
  if (!Array.isArray(raw.presets)) {
    throw new Error(`Invalid shared/ad-formats.json: missing presets array (${path}).`);
  }
  const out: AdFormatPreset[] = [];
  for (const row of raw.presets) {
    if (typeof row !== 'object' || row === null) {
      continue;
    }
    const o = row as Record<string, unknown>;
    const id = typeof o['id'] === 'string' ? o['id'].trim() : '';
    const width = typeof o['width'] === 'number' ? o['width'] : Number.NaN;
    const height = typeof o['height'] === 'number' ? o['height'] : Number.NaN;
    const label = typeof o['label'] === 'string' ? o['label'].trim() : '';
    if (
      id.length === 0 ||
      label.length === 0 ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < MIN_DIM ||
      width > MAX_DIM ||
      height < MIN_DIM ||
      height > MAX_DIM
    ) {
      continue;
    }
    const arche = o['arche'] === undefined ? undefined : parseArcheSpec(o['arche']);
    out.push({ id, width, height, label, ...(arche !== undefined ? { arche } : {}) });
  }
  if (out.length === 0) {
    throw new Error(`No valid presets in shared/ad-formats.json (${path}).`);
  }
  return out;
}

function coerceDimension (v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) {
    return v;
  }
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number.parseInt(v.trim(), 10);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

function selectionFromPreset (preset: AdFormatPreset): AdFormatSelection {
  return {
    id: preset.id,
    width: preset.width,
    height: preset.height,
    ...(preset.arche !== undefined ? { arche: preset.arche } : {})
  };
}

/** Normalize client JSON: array of { id, width, height } or partial + preset lookup. Arche metadata is taken only from server presets (never from client). */
export function normalizeApiAdFormats (
  raw: unknown,
  presets: readonly AdFormatPreset[]
): { ok: true; formats: AdFormatSelection[] } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: false, error: 'Missing adFormats (array of { id, width, height }).' };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'adFormats must be a JSON array.' };
  }
  if (raw.length === 0) {
    return { ok: false, error: 'adFormats must contain at least one format.' };
  }
  if (raw.length > MAX_FORMATS) {
    return { ok: false, error: `adFormats must contain at most ${String(MAX_FORMATS)} formats.` };
  }

  const presetById = new Map(presets.map((p) => [ p.id, p ]));
  const seen = new Set<string>();
  const formats: AdFormatSelection[] = [];

  for (const item of raw) {
    if (!isPlainObject(item)) {
      return { ok: false, error: 'Each adFormats entry must be an object.' };
    }
    const idRaw = typeof item['id'] === 'string' ? item['id'].trim() : '';
    let width = coerceDimension(item['width'] ?? item['w']);
    let height = coerceDimension(item['height'] ?? item['h']);
    let id = idRaw;

    if ((width === null || height === null) && idRaw.length > 0) {
      const preset = presetById.get(idRaw);
      if (preset === undefined) {
        return { ok: false, error: `Unknown preset id "${idRaw}".` };
      }
      width = preset.width;
      height = preset.height;
      id = preset.id;
    }

    if (width === null || height === null) {
      return { ok: false, error: 'Each format needs width and height (integers), or a known preset id.' };
    }
    if (width < MIN_DIM || width > MAX_DIM || height < MIN_DIM || height > MAX_DIM) {
      return {
        ok: false,
        error: `Dimensions out of range (${String(MIN_DIM)}–${String(MAX_DIM)} px): ${String(width)}×${String(height)}.`
      };
    }
    const key = `${width}x${height}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const finalId = id.length > 0 ? id : key;
    let presetMatch = presetById.get(finalId);
    if (presetMatch === undefined) {
      const byDims = presets.filter((p) => p.width === width && p.height === height);
      if (byDims.length === 1) {
        presetMatch = byDims[0];
      }
    }
    if (
      presetMatch !== undefined &&
      (presetMatch.width !== width || presetMatch.height !== height)
    ) {
      return {
        ok: false,
        error: `Dimensions mismatch for preset "${finalId}" (expected ${String(presetMatch.width)}×${String(presetMatch.height)}).`
      };
    }
    formats.push(
      presetMatch !== undefined
        ? selectionFromPreset(presetMatch)
        : { id: finalId, width, height }
    );
  }

  if (formats.length === 0) {
    return { ok: false, error: 'adFormats resolved to empty list (duplicates?).' };
  }
  return { ok: true, formats };
}

export function parseCreativeAdFormatsFromEnv (
  envValue: string | undefined,
  presets: readonly AdFormatPreset[]
): AdFormatSelection[] {
  const trimmed = envValue?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    const first = presets[0];
    if (first === undefined) {
      throw new Error('No presets loaded; cannot default ad formats.');
    }
    return [ selectionFromPreset(first) ];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error('CREATIVE_AD_FORMATS must be valid JSON.');
  }
  const normalized = normalizeApiAdFormats(parsed, presets);
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  return normalized.formats;
}
