import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import mime from 'mime';
import {
  collectLocalAssetRefsFromSource,
  isLocalAssetRef
} from './bundle-asset-refs.mts';
import { syncBundleAssetsFromBundleSource } from './creative-bundle-assets.mts';
import { isSvgAssetFile, sniffImageMimeFromBuffer } from './image-mime-sniff.mts';

export { collectLocalAssetRefsFromSource, isLocalAssetRef, normalizeLocalAssetFileName } from './bundle-asset-refs.mts';
import {
  buildGoogleFontsCss2Url,
  collectUsedFontFamilies,
  normalizeFontFamilyName,
  resolveGoogleFontSubstitute
} from './style-guide-typography.mts';

export interface GenericTextField {
  text: string;
  font: string;
  size: number;
  weight: string;
  style: string;
  color: string;
}

/** Paramètres globaux — §1.4 / §2.4 (obligatoire, peut être `{}`). */
export interface GenericAdSettings {
  backgroundColor?: string;
  clickTag?: string;
  slideInterval?: number;
}

/** Config format `generic` — schéma strict ad-format-json-reference.md §2. */
export interface GenericAdConfig {
  type: 'generic';
  dimensions: { width: number; height: number };
  settings: GenericAdSettings;
  fields: Record<string, GenericTextField>;
  images: Record<string, string[]>;
  html: string;
  css?: string;
  js?: string;
}

/** Clés racine legacy refusées à l’import (§2.8). */
export const GENERIC_OBSOLETE_ROOT_KEYS = [
  'tagLine',
  'headline',
  'headlineAccent',
  'subhead',
  'ctaText',
  'legalText',
  'backgroundColor',
  'clickTag',
  'slideInterval',
  'bindings'
] as const;

interface StyleGuideSlice {
  brandURL?: string;
  primaryColorPalette?: string[];
  typography?: Array<{ fontFamily?: string; fontWeight?: number }>;
}

const DEFAULT_SLIDE_INTERVAL = 2800;
const DEFAULT_BG = '#000000';
const DEFAULT_CLICK = 'https://example.com';
const DEFAULT_FONT = 'Inter';
const DEFAULT_ACCENT_COLOR = '#EC1C24';
const DEFAULT_MUTED_COLOR = '#B0B3B8';
const DEFAULT_HEADLINE_COLOR = '#FFFFFF';

const HTML_VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
]);

const TEXT_DISCOVERY_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'span',
  'a',
  'button',
  'label',
  'li',
  'div'
]);

interface DiscoveredText {
  key: string;
  innerHtml: string;
  openTag: string;
  gvType: 'text' | 'link';
}

function defaultTextField (
  text: string,
  overrides: Partial<GenericTextField> = {}
): GenericTextField {
  return normalizeTextStyle({
    text,
    font: DEFAULT_FONT,
    size: 12,
    weight: '500',
    style: 'normal',
    color: DEFAULT_MUTED_COLOR,
    ...overrides
  });
}

/** TextStyle conforme §1.1 ad-format-json-reference.md */
export function normalizeTextStyle (field: GenericTextField): GenericTextField {
  const weightRaw = field.weight;
  const weight =
    typeof weightRaw === 'number'
      ? String(weightRaw)
      : typeof weightRaw === 'string' && weightRaw.trim().length > 0
        ? weightRaw.trim()
        : '400';
  const sizeRaw = field.size;
  const size =
    typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) && sizeRaw > 0
      ? Math.round(sizeRaw)
      : 12;
  return {
    text: typeof field.text === 'string' ? field.text : '',
    font: typeof field.font === 'string' && field.font.trim().length > 0 ? field.font.trim() : DEFAULT_FONT,
    size,
    weight,
    style: field.style === 'italic' ? 'italic' : 'normal',
    color:
      typeof field.color === 'string' && field.color.trim().length > 0
        ? field.color.trim()
        : DEFAULT_MUTED_COLOR
  };
}

export function htmlHasDataGvBind (html: string): boolean {
  return /\bdata-gv-bind=/iu.test(html);
}

export function htmlHasImageListBinding (html: string): boolean {
  return /data-gv-type=["']image-list["']/iu.test(html);
}

function validateTextStyleEntry (key: string, v: unknown): string | null {
  if (typeof v === 'string') {
    return null;
  }
  if (typeof v !== 'object' || v === null) {
    return `fields.${key} must be TextStyle or string.`;
  }
  const t = v as GenericTextField;
  if (typeof t.text !== 'string' || typeof t.font !== 'string' || typeof t.size !== 'number') {
    return `fields.${key}: invalid TextStyle (text, font, size required).`;
  }
  if (typeof t.weight !== 'string' || (t.style !== 'normal' && t.style !== 'italic')) {
    return `fields.${key}: invalid TextStyle (weight string, style normal|italic).`;
  }
  if (typeof t.color !== 'string') {
    return `fields.${key}: invalid TextStyle (color required).`;
  }
  return null;
}

/** Valide la config exportée (validateGenericConfig / référence §2). */
export function validateGenericAdConfig (
  config: unknown
): { ok: true; config: GenericAdConfig } | { ok: false; error: string } {
  if (typeof config !== 'object' || config === null) {
    return { ok: false, error: 'Config must be an object.' };
  }
  const o = config as Record<string, unknown>;
  if (o['type'] !== 'generic') {
    return { ok: false, error: 'type must be "generic".' };
  }
  for (const legacy of GENERIC_OBSOLETE_ROOT_KEYS) {
    if (legacy in o) {
      return {
        ok: false,
        error: `Schéma obsolète : la clé racine "${legacy}" n'est plus acceptée.`
      };
    }
  }
  const dims = o['dimensions'];
  if (typeof dims !== 'object' || dims === null) {
    return { ok: false, error: 'dimensions is required.' };
  }
  const d = dims as { width?: unknown; height?: unknown };
  if (
    typeof d.width !== 'number' ||
    typeof d.height !== 'number' ||
    !Number.isFinite(d.width) ||
    !Number.isFinite(d.height) ||
    d.width <= 0 ||
    d.height <= 0
  ) {
    return { ok: false, error: 'dimensions.width and dimensions.height must be positive numbers.' };
  }
  if (typeof o['settings'] !== 'object' || o['settings'] === null) {
    return { ok: false, error: 'settings is required.' };
  }
  if (typeof o['fields'] !== 'object' || o['fields'] === null) {
    return { ok: false, error: 'fields is required.' };
  }
  if (typeof o['images'] !== 'object' || o['images'] === null) {
    return { ok: false, error: 'images is required.' };
  }
  if (typeof o['html'] !== 'string' || o['html'].trim().length === 0) {
    return { ok: false, error: 'html is required and must be non-empty.' };
  }
  if (!htmlHasDataGvBind(o['html'])) {
    return { ok: false, error: 'html must contain at least one data-gv-bind attribute.' };
  }
  const settings = o['settings'] as Record<string, unknown>;
  if (
    settings['slideInterval'] !== undefined &&
    (typeof settings['slideInterval'] !== 'number' || settings['slideInterval'] < 0)
  ) {
    return { ok: false, error: 'settings.slideInterval must be a non-negative number when present.' };
  }
  const imgs = o['images'] as Record<string, unknown>;
  for (const [ key, val ] of Object.entries(imgs)) {
    if (!Array.isArray(val) || !val.every((u) => typeof u === 'string')) {
      return { ok: false, error: `images.${key} must be an array of strings.` };
    }
  }
  const fields = o['fields'] as Record<string, unknown>;
  for (const [ key, val ] of Object.entries(fields)) {
    const err = validateTextStyleEntry(key, val);
    if (err !== null) {
      return { ok: false, error: err };
    }
  }
  const unbound = getUnboundGenericConfigKeysError(config as GenericAdConfig);
  if (unbound !== null) {
    return { ok: false, error: unbound };
  }
  return { ok: true, config: config as GenericAdConfig };
}

const RESERVED_BIND_KEYS = new Set([ 'canvas', 'background' ]);

/** Clés `data-gv-bind` présentes dans le HTML (§2.7). */
export function getBoundKeysInHtml (html: string): Set<string> {
  const keys = new Set<string>();
  for (const m of html.matchAll(/\bdata-gv-bind=["']([^"']+)["']/giu)) {
    const key = m[1];
    if (key !== undefined && key.length > 0 && !RESERVED_BIND_KEYS.has(key)) {
      keys.add(key);
    }
  }
  return keys;
}

function htmlHasBindWithTypes (html: string, key: string, types: string[]): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const typeAlt = types.join('|');
  const re = new RegExp(
    `data-gv-bind=["']${esc}["'][^>]*data-gv-type=["'](${typeAlt})["']|data-gv-type=["'](${typeAlt})["'][^>]*data-gv-bind=["']${esc}["']`,
    'iu'
  );
  return re.test(html);
}

/** §2.8 — chaque clé `fields` / `images` doit avoir un binding HTML correspondant. */
export function getUnboundGenericConfigKeysError (config: GenericAdConfig): string | null {
  const html = config.html;
  for (const key of Object.keys(config.fields)) {
    if (!htmlHasBindWithTypes(html, key, [ 'text', 'link' ])) {
      return `La clé fields "${key}" n'a pas de data-gv-bind (type text ou link) dans le html.`;
    }
  }
  for (const key of Object.keys(config.images)) {
    if (!htmlHasBindWithTypes(html, key, [ 'image', 'image-list' ])) {
      return `La clé images "${key}" n'a pas de data-gv-bind (type image ou image-list) dans le html.`;
    }
  }
  return null;
}

function normalizeSettings (settings: GenericAdSettings, html: string): GenericAdSettings {
  const out: GenericAdSettings = {};
  if (typeof settings.backgroundColor === 'string' && settings.backgroundColor.trim().length > 0) {
    out.backgroundColor = settings.backgroundColor.trim();
  }
  if (typeof settings.clickTag === 'string' && settings.clickTag.trim().length > 0) {
    out.clickTag = settings.clickTag.trim();
  }
  if (
    htmlHasImageListBinding(html) &&
    typeof settings.slideInterval === 'number' &&
    settings.slideInterval > 0
  ) {
    out.slideInterval = Math.round(settings.slideInterval);
  }
  return out;
}

const PLAIN_TEXT_HTML_ENTITIES: ReadonlyArray<[ string, string ]> = [
  [ '&amp;', '&' ],
  [ '&nbsp;', ' ' ],
  [ '&lt;', '<' ],
  [ '&gt;', '>' ],
  [ '&quot;', '"' ],
  [ '&#39;', "'" ],
  [ '&apos;', "'" ]
];

/** §1.6 — decode HTML entities in plain-text field values (no `<`). */
function decodeHtmlEntitiesInPlainText (text: string): string {
  if (/<[a-z]/iu.test(text)) {
    return text;
  }
  let out = text;
  for (const [ entity, ch ] of PLAIN_TEXT_HTML_ENTITIES) {
    out = out.split(entity).join(ch);
  }
  out = out.replace(/&#(\d+);/gu, (_, n) => String.fromCharCode(Number(n)));
  out = out.replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return out;
}

function getVisibleBoundKeysInHtml (html: string): Set<string> {
  const withoutHidden = html.replace(
    /<div class="gv-field-bindings"[\s\S]*?<\/div>/giu,
    ''
  );
  return getBoundKeysInHtml(withoutHidden);
}

/** §8.5.1 — remove hidden bindings for keys already bound in visible markup. */
export function stripRedundantGvFieldBindings (html: string): string {
  const visible = getVisibleBoundKeysInHtml(html);
  return html.replace(
    /<div class="gv-field-bindings"[^>]*>([\s\S]*?)<\/div>/giu,
    (full, inner) => {
      const cleaned = inner.replace(
        /<span\b[^>]*\bdata-gv-bind=["']([^"']+)["'][^>]*>[\s\S]*?<\/span>/giu,
        (span: string, key: string) => (visible.has(key) ? '' : span)
      );
      if (!/\bdata-gv-bind=/iu.test(cleaned)) {
        return '';
      }
      return full.replace(inner, cleaned);
    }
  );
}

/** §2.5 / §8.5.1 — plain `ctaText`, drop redundant `cta_label`, decode entities. */
function sanitizeFieldsForReference (
  fields: Record<string, GenericTextField>
): Record<string, GenericTextField> {
  const out: Record<string, GenericTextField> = {};
  for (const [ key, field ] of Object.entries(fields)) {
    if (key === 'cta_label') {
      continue;
    }
    let text = field.text;
    if (key === 'ctaText' && /<[a-z]/iu.test(text)) {
      text = stripHtmlTags(text);
    }
    text = decodeHtmlEntitiesInPlainText(text);
    out[key] = normalizeTextStyle({ ...field, text });
  }
  if (fields['ctaText'] === undefined && fields['cta_label'] !== undefined) {
    let text = fields['cta_label'].text;
    if (/<[a-z]/iu.test(text)) {
      text = stripHtmlTags(text);
    }
    out['ctaText'] = normalizeTextStyle({
      ...fields['cta_label'],
      text: decodeHtmlEntitiesInPlainText(text)
    });
  }
  return out;
}

function stripCtaLabelChildBindings (html: string): string {
  return html.replace(
    /<span\b([^>]*)\bclass=["'][^"']*\bcta-label\b[^"']*["']([^>]*)>/giu,
    () => '<span class="cta-label">'
  );
}

/** Align export HTML/fields with ad-format-json-reference.md (§1.6, §2.5, §8.5.1). */
function conformGenericConfigToReference (draft: GenericAdConfig): GenericAdConfig {
  let html = draft.html.trim();
  html = restructureHeadlineAccentHtml(html);
  html = restructureCtaLabelHtml(html);
  html = stripCtaLabelChildBindings(html);
  html = stripRedundantGvFieldBindings(html);
  const fields = sanitizeFieldsForReference(draft.fields);
  return {
    ...draft,
    html,
    fields,
    settings: normalizeSettings(draft.settings, html)
  };
}

function normalizeImages (images: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [ key, urls ] of Object.entries(images)) {
    if (urls.length > 0) {
      out[key] = urls;
    }
  }
  return out;
}

/** Sérialise en JSON d’import strict (§2.1 + ad-format-json-reference.md). */
export function serializeGenericAdConfig (draft: GenericAdConfig): GenericAdConfig {
  const conformed = conformGenericConfigToReference(draft);
  const html = conformed.html.trim();
  if (html.length === 0) {
    throw new Error('html must be non-empty for generic config export.');
  }
  if (!htmlHasDataGvBind(html)) {
    throw new Error('html must contain at least one data-gv-bind attribute.');
  }

  const out: GenericAdConfig = {
    type: 'generic',
    dimensions: {
      width: Math.max(1, Math.round(conformed.dimensions.width)),
      height: Math.max(1, Math.round(conformed.dimensions.height))
    },
    settings: conformed.settings,
    fields: conformed.fields,
    images: normalizeImages(conformed.images),
    html
  };

  const css = conformed.css?.trim() ?? '';
  const js = conformed.js?.trim() ?? '';
  if (css.length > 0) {
    out.css = css;
  }
  if (js.length > 0) {
    out.js = js;
  }

  const validated = validateGenericAdConfig(out);
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  return validated.config;
}

type GvBindingType = 'text' | 'image' | 'image-list' | 'link' | 'background' | 'root';

interface BindingRule {
  bind: string;
  gvType: GvBindingType;
  match: (tagName: string, attrs: string) => boolean;
}

const GENERIC_BINDING_RULES: BindingRule[] = [
  {
    bind: 'canvas',
    gvType: 'root',
    match: (tag, attrs) => tag === 'div' && /\bid=["']ad[-A-Za-z0-9]*["']/iu.test(attrs)
  },
  {
    bind: 'canvas',
    gvType: 'root',
    match: (tag, attrs) => tag === 'div' && /\bid=["']adFrame["']/iu.test(attrs)
  },
  {
    bind: 'background',
    gvType: 'background',
    match: (_tag, attrs) => /\bad-bg\b/iu.test(attrs) || /\bbg-glow\b/iu.test(attrs)
  },
  {
    bind: 'tagLine',
    gvType: 'text',
    match: (_tag, attrs) =>
      /\bid=["']tagLine["']/iu.test(attrs)
      || /\btag-line\b/iu.test(attrs)
      || /\bad-tagline\b/iu.test(attrs)
      || /\bad-tag\b/iu.test(attrs)
      || /\bv1-tag\b/iu.test(attrs)
      || /\bv3-label\b/iu.test(attrs)
  },
  {
    bind: 'headline',
    gvType: 'text',
    match: (tag, attrs) =>
      (tag === 'p' || tag === 'h1' || tag === 'h2' || tag === 'span')
      && (
        /\bad-headline\b/iu.test(attrs)
        || /\bid=["']ad-headline["']/iu.test(attrs)
        || /\bid=["']adHeadline["']/iu.test(attrs)
        || /\bid=["']headlineMain["']/iu.test(attrs)
        || (/\bheadline\b/iu.test(attrs) && !/\bheadline-accent\b/iu.test(attrs) && !/\bdmi\b/iu.test(attrs))
        || /\bv1-title\b/iu.test(attrs)
        || /\bv4-headline\b/iu.test(attrs)
      )
  },
  {
    bind: 'headlineAccent',
    gvType: 'text',
    match: (_tag, attrs) =>
      /\bid=["']headlineAccent["']/iu.test(attrs)
      || /\bdmi\b/iu.test(attrs)
      || /\bheadline-accent\b/iu.test(attrs)
  },
  {
    bind: 'subhead',
    gvType: 'text',
    match: (tag, attrs) =>
      (tag === 'p' || tag === 'span')
      && (
        /\bad-sub\b/iu.test(attrs)
        || /\bid=["']ad-sub["']/iu.test(attrs)
        || /\bid=["']adSub["']/iu.test(attrs)
        || /\bid=["']subhead["']/iu.test(attrs)
        || /\bsubhead\b/iu.test(attrs)
        || /\bv1-sub\b/iu.test(attrs)
        || /\bv4-body\b/iu.test(attrs)
      )
  },
  {
    bind: 'price',
    gvType: 'text',
    match: (tag, attrs) =>
      (tag === 'p' || tag === 'span')
      && (/\bad-price\b/iu.test(attrs) || /\bid=["']ad-price["']/iu.test(attrs))
  },
  {
    bind: 'ctaText',
    gvType: 'link',
    match: (tag, attrs) =>
      tag === 'a'
      && (/\bad-cta\b/iu.test(attrs) || /\bcta-btn\b/iu.test(attrs) || /\bcta\b/iu.test(attrs))
  },
  {
    bind: 'legalText',
    gvType: 'text',
    match: (tag, attrs) =>
      (tag === 'p' || tag === 'span')
      && (/\bid=["']legalText["']/iu.test(attrs) || /\blegal\b/iu.test(attrs) || /\bad-legal\b/iu.test(attrs))
  },
  {
    bind: 'logo',
    gvType: 'image',
    match: (tag, attrs) =>
      tag === 'img'
      && (
        /\bad-logo\b/iu.test(attrs)
        || /\blogo-img\b/iu.test(attrs)
        || /\blogo-main\b/iu.test(attrs)
        || (/\blogo\b/iu.test(attrs) && !/\bwm-logo\b/iu.test(attrs))
      )
  },
  {
    bind: 'heroSlides',
    gvType: 'image-list',
    match: (tag, attrs) => isHeroSlidesContainerTag(tag, attrs)
  }
];

const HERO_SLIDES_BIND_KEY = 'heroSlides';
const HERO_BIND_KEY = 'hero';

const STATIC_HERO_IMG_CLASS_HINTS = [
  'product-img',
  'hero-img',
  'product-image',
  'ad-product'
] as const;

/** §2.6 / §2.12 — conteneur carousel (pas les `<img>` enfants). */
function isHeroSlidesContainerTag (tag: string, attrs: string): boolean {
  if (tag !== 'div') {
    return false;
  }
  return (
    /\bad-carousel\b/iu.test(attrs)
    || /\bhero-wrap\b/iu.test(attrs)
    || /\bhero-track\b/iu.test(attrs)
    || /\bcarousel-track\b/iu.test(attrs)
    || /\bcarousel-wrapper\b/iu.test(attrs)
    || /\bslide-track\b/iu.test(attrs)
    || /\bslides-track\b/iu.test(attrs)
    || /\bslider-track\b/iu.test(attrs)
    || /\bslides-wrapper\b/iu.test(attrs)
    || /\bproduct-slider\b/iu.test(attrs)
    || /\bid=["']carousel["']/iu.test(attrs)
    || /\bid=["']slideTrack["']/iu.test(attrs)
    || (/\bcarousel\b/iu.test(attrs) && !/\bnav-btn\b/iu.test(attrs))
  );
}

function scoreHeroSlidesContainer (attrs: string, imgCount: number): number {
  let priority = 0;
  if (/\bslide-track\b/iu.test(attrs)) {
    priority = 100;
  } else if (/\bslides-track\b/iu.test(attrs)) {
    priority = 95;
  } else if (/\bid=["']slideTrack["']/iu.test(attrs)) {
    priority = 94;
  } else if (/\bcarousel-wrapper\b/iu.test(attrs)) {
    priority = 90;
  } else if (/\bad-carousel\b/iu.test(attrs)) {
    priority = 92;
  } else if (/\bcarousel-track\b/iu.test(attrs)) {
    priority = 88;
  } else if (/\bhero-track\b/iu.test(attrs)) {
    priority = 85;
  } else if (/\bid=["']carousel["']/iu.test(attrs)) {
    priority = 84;
  } else if (/\bcarousel\b/iu.test(attrs)) {
    priority = 50;
  } else if (/\bclass=["'][^"']*\bslide\b/iu.test(attrs)) {
    priority = 12;
  }
  return priority * 1000 + imgCount;
}

/** outerHTML from an opening tag at `start` (balanced close for same tag name). */
function extractOuterHtmlFromOpenTag (html: string, start: number, tagName: string): string | null {
  const tagRe = new RegExp(`<(/?)(${tagName})\\b[^>]*>`, 'giu');
  tagRe.lastIndex = start;
  let depth = 0;
  let end = -1;
  for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
    if (m.index === undefined) {
      break;
    }
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    } else if (!/\/\s*>$/u.test(m[0])) {
      const innerTag = m[2]!.toLowerCase();
      if (!HTML_VOID_ELEMENTS.has(innerTag)) {
        depth += 1;
      }
    }
  }
  if (end < 0) {
    return null;
  }
  return html.slice(start, end);
}

/** §2.8 — injecte `heroSlides` + `image-list` sur le meilleur conteneur carousel. */
export function ensureHeroSlidesImageListBinding (html: string): string {
  if (htmlHasBindWithTypes(html, HERO_SLIDES_BIND_KEY, [ 'image-list' ])) {
    return html;
  }
  const openTagRe = /<([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/giu;
  let best: {
    index: number;
    length: number;
    tagName: string;
    attrs: string;
    selfClose: string;
    score: number;
  } | null = null;

  for (const m of html.matchAll(openTagRe)) {
    if (m.index === undefined || m[1] === undefined) {
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? '';
    const selfClose = m[3] ?? '';
    if (!isHeroSlidesContainerTag(tag, attrs)) {
      continue;
    }
    if (/\bdata-gv-bind=["']heroSlides["']/iu.test(attrs)) {
      return html;
    }
    const outer =
      selfClose === '/'
        ? null
        : extractOuterHtmlFromOpenTag(html, m.index, tag);
    const imgCount = outer?.match(/<img\b/giu)?.length ?? 0;
    const score = scoreHeroSlidesContainer(attrs, imgCount);
    if (best === null || score > best.score) {
      best = {
        index: m.index,
        length: m[0].length,
        tagName: m[1],
        attrs,
        selfClose,
        score
      };
    }
  }

  if (best === null) {
    return html;
  }

  const inject = ` data-gv-bind="${HERO_SLIDES_BIND_KEY}" data-gv-type="image-list"`;
  const replacement = `<${best.tagName}${best.attrs}${inject}${best.selfClose}>`;
  return html.slice(0, best.index) + replacement + html.slice(best.index + best.length);
}

/** Injecte data-gv-bind / data-gv-type sur les nœuds qui n’en ont pas encore (§2.7). */
export function injectGenericBindings (html: string): string {
  return html.replace(
    /<([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/giu,
    (full, tagName, attrs, selfClose) => {
      if (/\bdata-gv-bind=/iu.test(attrs)) {
        return full;
      }
      const tag = tagName.toLowerCase();
      for (const rule of GENERIC_BINDING_RULES) {
        if (rule.match(tag, attrs)) {
          const inject = ` data-gv-bind="${rule.bind}" data-gv-type="${rule.gvType}"`;
          return `<${tagName}${attrs}${inject}${selfClose}>`;
        }
      }
      return full;
    }
  );
}

function readUtf8 (path: string): string {
  return readFileSync(path, { encoding: 'utf8' }).replace(/^\uFEFF/u, '').trim();
}

export function findFirstAdDomId (html: string): string | null {
  const iab = /\bid=["'](ad-[^"']+)["']/iu.exec(html);
  if (iab?.[1] !== undefined) {
    return iab[1];
  }
  const frame = /\bid=["'](adFrame)["']/iu.exec(html);
  if (frame?.[1] !== undefined) {
    return frame[1];
  }
  const other = /\bid=["'](ad[a-zA-Z][a-zA-Z0-9_-]*)["']/iu.exec(html);
  return other?.[1] ?? null;
}

/** Extract outerHTML of the element with the given id (first match). */
export function extractAdRootHtml (html: string, domId: string): string | null {
  const idRe = new RegExp(
    `<([a-z][a-z0-9]*)\\b[^>]*\\bid=["']${domId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`,
    'iu'
  );
  const openMatch = idRe.exec(html);
  if (openMatch === null || openMatch.index === undefined) {
    return null;
  }
  const tagName = openMatch[1]!.toLowerCase();
  const start = openMatch.index;
  let depth = 0;
  const tagRe = new RegExp(`<(/?)(${tagName})\\b[^>]*>`, 'giu');
  tagRe.lastIndex = start;
  let end = -1;
  for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
    if (m.index === undefined) {
      break;
    }
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    } else if (!/\/\s*>$/u.test(m[0])) {
      const innerTag = m[2]!.toLowerCase();
      if (!HTML_VOID_ELEMENTS.has(innerTag)) {
        depth += 1;
      }
    }
  }
  if (end < 0) {
    return null;
  }
  return html.slice(start, end).replace(/\s+/gu, ' ').trim();
}

/** Fragment pub (#ad-*) fiable pour extraction texte + export HTML. */
export function getAdFragmentForExtraction (indexHtml: string, domId: string): string {
  const extracted =
    extractAdRootHtml(indexHtml, domId)
    ?? (domId !== 'ad-generic' ? extractAdRootHtml(indexHtml, 'ad-generic') : null);
  const full = indexHtml.trim();
  if (extracted === null || extracted.length === 0) {
    return full;
  }
  const markers = [
    'ad-headline',
    'adHeadline',
    'ad-copy',
    'cta-btn',
    'ad-cta',
    'ad-tagline',
    'ad-price'
  ];
  for (const mk of markers) {
    if (full.includes(mk) && !extracted.includes(mk)) {
      return full;
    }
  }
  return extracted;
}

function parseDimensionsFromFormatsFile (outputRunDir: string): { width: number; height: number } | null {
  const path = join(outputRunDir, 'creative-native-ad-formats.json');
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = JSON.parse(readUtf8(path)) as { adFormats?: unknown };
    const first = Array.isArray(raw.adFormats) ? raw.adFormats[0] : null;
    if (typeof first !== 'object' || first === null) {
      return null;
    }
    const w = (first as { width?: unknown }).width;
    const h = (first as { height?: unknown }).height;
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
      return { width: w, height: h };
    }
  } catch {
    return null;
  }
  return null;
}

function cssSelectorsForDomId (domId: string): string[] {
  const escaped = domId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selectors = [ `#${escaped}` ];
  if (domId === 'adFrame') {
    selectors.push('\\.ad-frame');
  }
  return selectors;
}

function readCssBlock (css: string, selectorPattern: string): string | null {
  const blockRe = new RegExp(`${selectorPattern}\\s*\\{([^}]+)\\}`, 'iu');
  return blockRe.exec(css)?.[1] ?? null;
}

function parseDimensionsFromCss (css: string, domId: string): { width: number; height: number } | null {
  for (const sel of cssSelectorsForDomId(domId)) {
    const body = readCssBlock(css, sel);
    if (body === null) {
      continue;
    }
    const w = /width\s*:\s*(\d+(?:\.\d+)?)\s*px/iu.exec(body);
    const h = /height\s*:\s*(\d+(?:\.\d+)?)\s*px/iu.exec(body);
    if (w?.[1] !== undefined && h?.[1] !== undefined) {
      return { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) };
    }
  }
  return null;
}

/** Lit `ad-300x250` / `ad-970x250` depuis l’id racine du créatif. */
function parseDimensionsFromDomId (domId: string): { width: number; height: number } | null {
  const m = /^ad-(\d+)x(\d+)$/iu.exec(domId);
  if (m?.[1] === undefined || m[2] === undefined) {
    return null;
  }
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function parseDimensionsFromTitle (html: string): { width: number; height: number } | null {
  const m = /<title\b[^>]*>[\s\S]*?(\d+)\s*[×x]\s*(\d+)/iu.exec(html);
  if (m?.[1] !== undefined && m[2] !== undefined) {
    return { width: Number(m[1]), height: Number(m[2]) };
  }
  return null;
}

function parseBackgroundFromCss (css: string, domId: string): string | null {
  for (const sel of cssSelectorsForDomId(domId)) {
    const body = readCssBlock(css, sel);
    if (body === null) {
      continue;
    }
    const solid = /background(?:-color)?\s*:\s*(#[0-9A-Fa-f]{3,8})/iu.exec(body);
    if (solid?.[1] !== undefined) {
      return solid[1];
    }
  }
  return null;
}

function resolveSafeBundlePath (bundleDir: string, ref: string): string | null {
  const trimmed = ref.trim().replace(/^\.\//u, '');
  if (
    trimmed.length === 0 ||
    trimmed.includes('..') ||
    trimmed.startsWith('/') ||
    /^[a-z][a-z0-9+.-]*:/iu.test(trimmed)
  ) {
    return null;
  }
  const bundleResolved = resolve(bundleDir);
  const abs = resolve(bundleResolved, trimmed);
  const rel = relative(bundleResolved, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }
  return abs;
}

export function resolveLocalAssetToDataUrl (bundleDir: string, ref: string): string | null {
  if (!isLocalAssetRef(ref)) {
    return null;
  }
  const abs = resolveSafeBundlePath(bundleDir, ref);
  if (abs === null || !existsSync(abs)) {
    return null;
  }
  const buf = readFileSync(abs);
  const name = basename(abs);
  if (isSvgAssetFile(name, buf)) {
    return `data:image/svg+xml,${encodeURIComponent(buf.toString('utf8'))}`;
  }
  const mimeType = sniffImageMimeFromBuffer(buf) ?? mime.getType(abs);
  if (mimeType === null || !mimeType.startsWith('image/')) {
    return null;
  }
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}

function collectLocalAssetRefs (config: GenericAdConfig): string[] {
  const imageUrls: string[] = [];
  for (const urls of Object.values(config.images)) {
    imageUrls.push(...urls);
  }
  return collectLocalAssetRefsFromSource({
    html: config.html,
    ...(config.css !== undefined ? { css: config.css } : {}),
    ...(config.js !== undefined ? { js: config.js } : {}),
    imageUrls
  });
}

function replaceAllLiteral (content: string, from: string, to: string): string {
  if (!content.includes(from)) {
    return content;
  }
  return content.split(from).join(to);
}

export function embedBundleAssetsInConfig (
  config: GenericAdConfig,
  bundleDir: string
): GenericAdConfig {
  const urlMap = new Map<string, string>();
  for (const ref of collectLocalAssetRefs(config)) {
    const dataUrl = resolveLocalAssetToDataUrl(bundleDir, ref);
    if (dataUrl !== null) {
      urlMap.set(ref, dataUrl);
    }
  }
  if (urlMap.size === 0) {
    return config;
  }
  // Clear bound <img src> while paths are still short — never inline data URLs into html
  // (base64 payloads contain character sequences that break tag-boundary heuristics).
  const html = stripBoundImageDataUrlsFromHtml(config.html, Object.keys(config.images));
  let css = config.css;
  let js = config.js;
  for (const [ from, to ] of urlMap) {
    if (css !== undefined) {
      css = replaceAllLiteral(css, from, to);
    }
    if (js !== undefined) {
      js = replaceAllLiteral(js, from, to);
    }
  }
  const remap = (list: string[]): string[] => list.map((u) => urlMap.get(u) ?? u);
  const images: Record<string, string[]> = {};
  for (const [ key, urls ] of Object.entries(config.images)) {
    images[key] = remap(urls);
  }

  return {
    ...config,
    html,
    images,
    ...(css !== undefined ? { css } : {}),
    ...(js !== undefined ? { js } : {})
  };
}

function stripSrcOnDirectImageBinds (html: string, bindKey: string): string {
  const esc = bindKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = html;
  out = out.replace(
    new RegExp(`<img\\b([^>]*?)\\bdata-gv-bind=["']${esc}["']([^>]*?)>`, 'giu'),
    (full) => full.replace(/\bsrc=["'][^"']*["']/iu, 'src=""')
  );
  out = out.replace(
    new RegExp(`<img\\b([^>]*?)\\bsrc=["'][^"']*["']([^>]*?)\\bdata-gv-bind=["']${esc}["']([^>]*?)>`, 'giu'),
    (full) => full.replace(/\bsrc=["'][^"']*["']/iu, 'src=""')
  );
  return out;
}

/** §2.11 — vider `src` sur les `<img>` enfants d’un conteneur `image-list`. */
function stripSrcOnImageListContainer (html: string, bindKey: string): string {
  const esc = bindKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bindOnContainer = new RegExp(
    `data-gv-bind=["']${esc}["'][^>]*data-gv-type=["']image-list["']|data-gv-type=["']image-list["'][^>]*data-gv-bind=["']${esc}["']`,
    'iu'
  );
  const openTagRe = /<([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/giu;
  let best: { start: number; end: number; replacement: string; span: number } | null = null;

  for (const m of html.matchAll(openTagRe)) {
    if (m.index === undefined || m[1] === undefined || (m[3] ?? '') === '/') {
      continue;
    }
    const attrs = m[2] ?? '';
    if (!bindOnContainer.test(attrs)) {
      continue;
    }
    const tag = m[1].toLowerCase();
    const outer = extractOuterHtmlFromOpenTag(html, m.index, tag);
    if (outer === null) {
      continue;
    }
    const stripped = outer.replace(
      /<img\b([^>]*)>/giu,
      (full) => full.replace(/\bsrc=["'][^"']*["']/iu, 'src=""')
    );
    if (stripped === outer) {
      continue;
    }
    const span = outer.length;
    if (best === null || span > best.span) {
      best = {
        start: m.index,
        end: m.index + outer.length,
        replacement: stripped,
        span
      };
    }
  }

  if (best === null) {
    return html;
  }
  return html.slice(0, best.start) + best.replacement + html.slice(best.end);
}

/** §2.11 — URLs d’images dans `images.*` uniquement ; `src=""` sur les `<img>` liés. */
export function stripBoundImageDataUrlsFromHtml (
  html: string,
  imageKeys: string[]
): string {
  let out = html;
  for (const key of imageKeys) {
    if (htmlHasBindWithTypes(out, key, [ 'image-list' ])) {
      out = stripSrcOnImageListContainer(out, key);
    }
    out = stripSrcOnDirectImageBinds(out, key);
  }
  out = out.replace(
    /<img\b([^>]*)\bsrc=["']data:image[^"']*["']([^>]*)>/giu,
    '<img$1src=""$2>'
  );
  return out;
}

/** §2.8 — bindings HTML pour chaque clé `fields` sans nœud visible (variantes JS, etc.). */
export function appendHiddenFieldBindings (
  html: string,
  fields: Record<string, GenericTextField>
): string {
  const bound = getBoundKeysInHtml(html);
  const missing = Object.keys(fields).filter(
    (k) => fields[k] !== undefined && fields[k].text.trim().length > 0 && !bound.has(k)
  );
  if (missing.length === 0) {
    return html;
  }
  const nodes = missing
    .map((k) => {
      const gvType = k === 'ctaText' || k.startsWith('cta') ? 'link' : 'text';
      const text = fields[k]!.text;
      return `<span data-gv-bind="${k}" data-gv-type="${gvType}">${text}</span>`;
    })
    .join('');
  return `${html}<div class="gv-field-bindings" aria-hidden="true" hidden style="display:none">${nodes}</div>`;
}

function parseSlideInterval (js: string): number {
  const intervalConst = /INTERVAL\s*=\s*(\d+)/iu.exec(js);
  if (intervalConst?.[1] !== undefined) {
    return Number(intervalConst[1]);
  }
  const setInterval = /setInterval\s*\([^,]+,\s*(\d+)/iu.exec(js);
  if (setInterval?.[1] !== undefined) {
    return Number(setInterval[1]);
  }
  return DEFAULT_SLIDE_INTERVAL;
}

function stripHtmlTags (s: string): string {
  return s.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** Split `<em>` accent out of a combined headline field (e.g. Préparez votre + Bubble Tea). */
export function splitHeadlineAccentFields (
  fields: Record<string, GenericTextField>,
  styleForKey: (key: string) => Partial<GenericTextField>
): void {
  const headline = fields['headline'];
  if (headline === undefined || fields['headlineAccent'] !== undefined) {
    return;
  }
  const emRe = /<em\b[^>]*>([\s\S]*?)<\/em>/iu;
  const emMatch = emRe.exec(headline.text);
  if (emMatch?.[1] === undefined) {
    return;
  }
  const accentText = stripHtmlTags(emMatch[1]);
  if (accentText.length === 0) {
    return;
  }
  let mainHtml = headline.text;
  const brEm = /<br\s*\/?>\s*<em\b/iu.exec(mainHtml);
  if (brEm?.index !== undefined) {
    mainHtml = mainHtml.slice(0, brEm.index);
  } else {
    mainHtml = mainHtml.replace(emRe, '');
  }
  const hasBr = /<br\s*\/?>/iu.test(headline.text);
  const mainText = stripHtmlTags(mainHtml.replace(/<br\s*\/?>/giu, ' ')).trim();
  if (mainText.length === 0) {
    return;
  }
  fields['headline'] = {
    ...headline,
    text: hasBr ? mainText : mainText
  };
  fields['headlineAccent'] = defaultTextField(accentText, styleForKey('headlineAccent'));
}

/** Move headline bindings onto inner spans; accent lives inside `<em>` (gallery import shape). */
export function restructureHeadlineAccentHtml (html: string): string {
  return html.replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/giu, (full, attrs, inner) => {
    if (
      !/\bclass=["'][^"']*\bheadline\b/iu.test(attrs)
      && !/\bdata-gv-bind=["']headline["']/iu.test(full)
    ) {
      return full;
    }
    if (/\bdata-gv-bind=["']headlineAccent["']/iu.test(full)) {
      return full;
    }
    const emRe = /<em\b[^>]*>([\s\S]*?)<\/em>/iu;
    const emMatch = emRe.exec(inner);
    if (emMatch?.[1] === undefined || emMatch.index === undefined) {
      return full;
    }
    const before = inner.slice(0, emMatch.index).trim();
    const accentText = stripHtmlTags(emMatch[1]) || emMatch[1].trim();
    let headlineText = stripHtmlTags(before.replace(/<br\s*\/?>/giu, ' ')).trim();
    let emFirst = false;
    if (headlineText.length === 0 && accentText.length > 0) {
      const after = inner.slice(emMatch.index + emMatch[0].length).trim();
      headlineText = stripHtmlTags(after.replace(/<br\s*\/?>/giu, ' ')).trim();
      emFirst = headlineText.length > 0;
    }
    if (headlineText.length === 0 || accentText.length === 0) {
      return full;
    }
    const hasBr = emFirst
      ? /<br\s*\/?>/iu.test(inner.slice(emMatch.index + emMatch[0].length))
      : /<br\s*\/?>/iu.test(before);
    const newInner = hasBr
      ? `<span data-gv-bind="headline" data-gv-type="text">${headlineText}</span><br><em><span data-gv-bind="headlineAccent" data-gv-type="text">${accentText}</span></em>`
      : `<span data-gv-bind="headline" data-gv-type="text">${headlineText}</span> <em><span data-gv-bind="headlineAccent" data-gv-type="text">${accentText}</span></em>`;
    const newAttrs = attrs
      .replace(/\s*data-gv-bind=["']headline["']/giu, '')
      .replace(/\s*data-gv-type=["']text["']/giu, '');
    return `<h1${newAttrs}>${newInner}</h1>`;
  });
}

/** Remove decorative `aria-hidden` blocks from the exported ad fragment. */
export function stripDecorativeAriaHidden (html: string): string {
  let out = html;
  let prev = '';
  while (out !== prev) {
    prev = out;
    out = out.replace(
      /<([a-z][a-z0-9]*)\b[^>]*\baria-hidden=["']true["'][^>]*>[\s\S]*?<\/\1>/giu,
      ''
    );
  }
  return out
    .replace(/<!--\s*Background bubbles\s*-->/giu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

type ParsedCssTextDecl = {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: 'normal' | 'italic';
  color?: string;
};

const GENERIC_FONT_FALLBACKS = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui'
]);

function escapeCssSelectorForRegex (selector: string): string {
  return selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract typographic declarations from a simple CSS rule block. */
export function parseCssRuleBlock (css: string, selector: string): ParsedCssTextDecl | null {
  const esc = escapeCssSelectorForRegex(selector.trim());
  const re = new RegExp(`${esc}\\s*\\{([^}]+)\\}`, 'iu');
  const body = re.exec(css)?.[1];
  if (body === undefined || body.length === 0) {
    return null;
  }
  const decl: ParsedCssTextDecl = {};
  const ff = /font-family\s*:\s*([^;]+);/iu.exec(body);
  if (ff?.[1] !== undefined) {
    const first =
      ff[1]
        .split(',')[0]
        ?.trim()
        .replace(/^["']|["']$/gu, '') ?? '';
    if (first.length > 0) {
      decl.fontFamily = first;
    }
  }
  const fs = /font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/iu.exec(body);
  if (fs?.[1] !== undefined) {
    decl.fontSize = Math.round(Number(fs[1]));
  }
  const fw = /font-weight\s*:\s*([^;]+);/iu.exec(body);
  if (fw?.[1] !== undefined) {
    decl.fontWeight = fw[1].trim();
  }
  const fst = /font-style\s*:\s*([^;]+);/iu.exec(body);
  if (fst?.[1] !== undefined) {
    decl.fontStyle = fst[1].trim().toLowerCase() === 'italic' ? 'italic' : 'normal';
  }
  const col = /color\s*:\s*([^;]+);/iu.exec(body);
  if (col?.[1] !== undefined) {
    decl.color = col[1].trim();
  }
  return Object.keys(decl).length > 0 ? decl : null;
}

function cssDeclToFieldPartial (decl: ParsedCssTextDecl): Partial<GenericTextField> {
  const out: Partial<GenericTextField> = {};
  if (decl.fontFamily !== undefined) {
    out.font = decl.fontFamily;
  }
  if (decl.fontSize !== undefined) {
    out.size = decl.fontSize;
  }
  if (decl.fontWeight !== undefined) {
    out.weight = decl.fontWeight;
  }
  if (decl.fontStyle !== undefined) {
    out.style = decl.fontStyle;
  }
  if (decl.color !== undefined) {
    out.color = decl.color;
  }
  return out;
}

const FIELD_CSS_SELECTORS: Record<string, string[]> = {
  eyebrow: [ '.eyebrow' ],
  headline: [ '.headline' ],
  headlineAccent: [ '.headline em' ],
  subhead: [ '.subhead' ],
  body_copy: [ '.body-copy' ],
  ctaText: [ '.cta-btn' ],
  legalText: [ '.ad-legal', '.ad-footer span' ]
};

function selectorsForFieldKey (key: string): string[] | null {
  if (FIELD_CSS_SELECTORS[key] !== undefined) {
    return FIELD_CSS_SELECTORS[key]!;
  }
  if (key.startsWith('text_')) {
    return [ '.ad-footer span', '.ad-legal' ];
  }
  return null;
}

/** Merge TextStyle from bundle CSS onto discovered `fields` (keeps `text`). */
export function applyFieldStylesFromCss (
  fields: Record<string, GenericTextField>,
  css: string
): void {
  for (const [ key, field ] of Object.entries(fields)) {
    const selectors = selectorsForFieldKey(key);
    if (selectors === null) {
      continue;
    }
    for (const selector of selectors) {
      const decl = parseCssRuleBlock(css, selector);
      if (decl === null) {
        continue;
      }
      const partial = cssDeclToFieldPartial(decl);
      if (Object.keys(partial).length === 0) {
        continue;
      }
      fields[key] = normalizeTextStyle({ ...field, ...partial });
      break;
    }
  }
}

/** §2.5 — CTA binding on `<a>` with empty `.cta-label` child (hydration injects label). */
export function restructureCtaLabelHtml (html: string): string {
  return html.replace(
    /<a\b([^>]*)\bdata-gv-bind=["']ctaText["']([^>]*)>([\s\S]*?)<\/a>/giu,
    (full, before, after) => {
      const gvType = /\bdata-gv-type=["']link["']/iu.test(full) ? '' : ' data-gv-type="link"';
      return `<a${before}data-gv-bind="ctaText"${after}${gvType}><span class="cta-label"></span></a>`;
    }
  );
}

function buildGalleryFontsImportUrl (css: string, sg: StyleGuideSlice): string {
  const used = collectUsedFontFamilies(css);
  const params: string[] = [];
  const seen = new Set<string>();
  const addParam = (param: string): void => {
    if (!seen.has(param)) {
      seen.add(param);
      params.push(param);
    }
  };

  const accentDecl = parseCssRuleBlock(css, '.headline em');
  const needsPlayfairItalic = accentDecl?.fontStyle === 'italic';

  for (const font of used) {
    const norm = normalizeFontFamilyName(font);
    if (GENERIC_FONT_FALLBACKS.has(norm)) {
      continue;
    }
    if (norm === 'montserrat') {
      addParam('family=Montserrat:wght@400;600;700');
    } else if (norm === 'playfair display') {
      addParam(
        needsPlayfairItalic
          ? 'family=Playfair+Display:ital,wght@0,700;1,700'
          : 'family=Playfair+Display:wght@400;600;700'
      );
    } else {
      const sub = resolveGoogleFontSubstitute(font);
      const encoded = sub.googleFamily.trim().replace(/\s+/gu, '+');
      addParam(`family=${encoded}:wght@${sub.weights}`);
    }
  }

  if (params.length === 0 && Array.isArray(sg.typography) && sg.typography.length > 0) {
    const substitutes = sg.typography
      .map((row) => resolveGoogleFontSubstitute(row.fontFamily ?? DEFAULT_FONT))
      .filter((sub, idx, arr) => arr.findIndex((s) => s.googleFamily === sub.googleFamily) === idx);
    return buildGoogleFontsCss2Url(substitutes);
  }

  if (params.length === 0) {
    return buildGoogleFontsCss2Url([ { googleFamily: 'Inter', weights: '400;600;700' } ]);
  }

  return `https://fonts.googleapis.com/css2?${params.join('&')}&display=swap`;
}

function stripCssDeclaration (block: string, property: string): string {
  const re = new RegExp(`\\s*${property}\\s*:[^;]+;`, 'giu');
  return block.replace(re, '');
}

/** Remove one `@keyword name { … }` block with balanced braces. */
function removeCssAtBlock (css: string, keyword: string, name: string): string {
  const startRe = new RegExp(`@${keyword}\\s+${escapeCssSelectorForRegex(name)}\\b[^\\{]*\\{`, 'iu');
  const start = startRe.exec(css);
  if (start?.index === undefined) {
    return css;
  }
  const openBrace = css.indexOf('{', start.index);
  if (openBrace < 0) {
    return css;
  }
  let depth = 0;
  for (let i = openBrace; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(0, start.index) + css.slice(i + 1);
      }
    }
  }
  return css;
}

/** Remove `@media` blocks whose body only references removed decorative selectors. */
function removeEmptyOrBubbleMediaQueries (css: string): string {
  return css.replace(/@media[^{]+\{([\s\S]*?)\}/giu, (full, body) => {
    const trimmed = body.replace(/\s+/gu, '');
    if (trimmed.length === 0) {
      return '';
    }
    if (/\.bubble\b/iu.test(body) && !/\.\w+-\w+/iu.test(body.replace(/\.bubble\b/giu, ''))) {
      return '';
    }
    return full;
  });
}

/** Gallery-ready CSS: Google Fonts @import, no decorative-only rules from preview chrome. */
export function prepareCssForGalleryExport (
  css: string,
  styleGuide: StyleGuideSlice,
  domId: string
): string {
  let out = css.trim();
  const escId = escapeCssSelectorForRegex(domId);

  out = out.replace(/\/\*[\s\S]*?Animated Background Bubbles[\s\S]*?\*\/\s*/giu, '');
  out = out.replace(/\/\*[\s\S]*?Colour stripe divider[\s\S]*?\*\/\s*/giu, '');
  out = out.replace(/\.bg-bubbles\s*\{[^}]*\}/giu, '');
  out = out.replace(/\.bubble\s*\{[^}]*\}/giu, '');
  out = out.replace(/\.b[1-7]\s*\{[^}]*\}/giu, '');
  out = removeCssAtBlock(out, 'keyframes', 'floatUp');
  out = removeEmptyOrBubbleMediaQueries(out);
  out = out.replace(new RegExp(`#${escId}::before\\s*\\{[^}]*\\}`, 'giu'), '');

  out = out.replace(/(\.ad-header\s*\{)([^}]*)(\})/giu, (_m, open, body, close) => {
    return `${open}${stripCssDeclaration(body, 'border-bottom')}${close}`;
  });

  out = out.replace(new RegExp(`(#${escId}\\s*\\{)([^}]*)(\\})`, 'giu'), (_m, open, body, close) => {
    let cleaned = stripCssDeclaration(body, 'border-radius');
    cleaned = stripCssDeclaration(cleaned, 'box-shadow');
    return `${open}${cleaned}${close}`;
  });

  if (!/@import\s+url\(/iu.test(out)) {
    const importUrl = buildGalleryFontsImportUrl(out, styleGuide);
    out = `@import url('${importUrl}');\n\n${out}`;
  }

  return out.replace(/\n{3,}/gu, '\n\n').trim();
}

function readHtmlAttr (attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${name}=["']([^"']*)["']`, 'iu');
  return re.exec(attrs)?.[1] ?? null;
}

function hasClassToken (attrs: string, token: string): boolean {
  const cls = readHtmlAttr(attrs, 'class');
  if (cls === null) {
    return false;
  }
  return cls.split(/\s+/u).includes(token);
}

function unescapeJsString (raw: string): string {
  return raw
    .replace(/\\u00A0/gu, '\u00A0')
    .replace(/\\n/gu, '\n')
    .replace(/\\'/gu, "'")
    .replace(/\\"/gu, '"');
}

/** Lit une chaîne JS littérale (quotes simples ou doubles) dans un bloc objet. */
function readJsObjectStringField (body: string, field: string): string | null {
  const re = new RegExp(
    `${field}\\s*:\\s*(['"])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1`,
    'iu'
  );
  const m = re.exec(body);
  if (m?.[2] === undefined) {
    return null;
  }
  return unescapeJsString(m[2]);
}

/** Extrait le HTML intérieur d’une balise ouvrante à l’index donné (fermeture équilibrée). */
function extractBalancedInnerHtml (
  html: string,
  openIndex: number
): { inner: string; openTag: string } | null {
  const slice = html.slice(openIndex);
  const openMatch = /^<([a-z][a-z0-9]*)\b([^>]*)(\/?)>/iu.exec(slice);
  if (openMatch === null) {
    return null;
  }
  const tag = openMatch[1]!.toLowerCase();
  const openTag = openMatch[0];
  if (HTML_VOID_ELEMENTS.has(tag) || openMatch[3] === '/') {
    return { inner: '', openTag };
  }
  const contentStart = openIndex + openTag.length;
  let depth = 1;
  const tagRe = /<\/?([a-z][a-z0-9]*)\b[^>]*>/giu;
  tagRe.lastIndex = contentStart;
  let closeEnd = -1;
  for (let m = tagRe.exec(html); m !== null; m = tagRe.exec(html)) {
    if (m.index === undefined) {
      break;
    }
    const t = m[1]!.toLowerCase();
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        closeEnd = m.index;
        break;
      }
    } else if (!HTML_VOID_ELEMENTS.has(t) && !/\/\s*>$/u.test(m[0])) {
      depth += 1;
    }
  }
  if (closeEnd < 0) {
    return null;
  }
  return { inner: html.slice(contentStart, closeEnd).trim(), openTag };
}

function findParentDataSlide (fragment: string, beforeIndex: number): string | null {
  const head = fragment.slice(0, beforeIndex);
  const matches = [ ...head.matchAll(/data-slide=["']([^"']+)["']/giu) ];
  return matches.at(-1)?.[1] ?? null;
}

function resolveCanonicalFieldKey (
  tag: string,
  attrs: string,
  fragment: string,
  openIndex: number
): string | null {
  if (tag === 'span' && hasClassToken(attrs, 'hl')) {
    return null;
  }
  const id = readHtmlAttr(attrs, 'id');
  const variant = readHtmlAttr(attrs, 'data-variant');

  if (id === 'ad-headline' || id === 'adHeadline' || id === 'headlineMain') {
    return 'headline';
  }
  if (id === 'ad-sub' || id === 'adSub' || id === 'subhead') {
    return 'subhead';
  }
  if (id === 'ad-price') {
    return 'price';
  }
  if (id === 'headlineAccent') {
    return 'headlineAccent';
  }
  if (id === 'tagLine' || id === 'legalText') {
    return id;
  }
  if (hasClassToken(attrs, 'ad-headline') || hasClassToken(attrs, 'v1-title') || hasClassToken(attrs, 'v4-headline')) {
    return 'headline';
  }
  if (hasClassToken(attrs, 'ad-sub') || hasClassToken(attrs, 'v1-sub') || hasClassToken(attrs, 'v4-body')) {
    return 'subhead';
  }
  if (hasClassToken(attrs, 'ad-price')) {
    return 'price';
  }
  if (
    hasClassToken(attrs, 'ad-tagline')
    || hasClassToken(attrs, 'tag-line')
    || hasClassToken(attrs, 'ad-tag')
    || hasClassToken(attrs, 'v1-tag')
    || hasClassToken(attrs, 'v3-label')
  ) {
    return 'tagLine';
  }
  if (hasClassToken(attrs, 'ad-legal') || hasClassToken(attrs, 'legal')) {
    return 'legalText';
  }
  if (hasClassToken(attrs, 'headline-accent') || hasClassToken(attrs, 'dmi')) {
    return 'headlineAccent';
  }
  if (tag === 'a' && (hasClassToken(attrs, 'cta-btn') || hasClassToken(attrs, 'ad-cta') || hasClassToken(attrs, 'cta'))) {
    return 'ctaText';
  }
  if (tag === 'button' && hasClassToken(attrs, 'tab-btn') && variant !== null) {
    return `tab_${variant}`;
  }
  if (hasClassToken(attrs, 'hero-badge')) {
    const slide = findParentDataSlide(fragment, openIndex);
    if (slide !== null) {
      return `badge_${slide}`;
    }
  }

  if (id !== null && id.length > 0) {
    return id.replace(/-/gu, '_');
  }
  const cls = readHtmlAttr(attrs, 'class');
  if (cls !== null) {
    const first = cls.split(/\s+/u)[0]?.replace(/-/gu, '_');
    if (first !== undefined && first.length > 0 && first !== 'active') {
      return first;
    }
  }
  return `text_${openIndex}`;
}

function isDecorativeTextNode (attrs: string): boolean {
  if (/\baria-hidden=["']true["']/iu.test(attrs)) {
    return true;
  }
  if (hasClassToken(attrs, 'wm-logo') || hasClassToken(attrs, 'lion-watermark')) {
    return true;
  }
  return false;
}

/** Passe B — découverte exhaustive des textes dans le fragment pub. */
export function discoverTextFieldsFromHtml (fragment: string): DiscoveredText[] {
  const out: DiscoveredText[] = [];
  const seenKeys = new Set<string>();
  const tagAlt = [ ...TEXT_DISCOVERY_TAGS ].join('|');
  const openRe = new RegExp(`<(${tagAlt})\\b([^>]*)>`, 'giu');
  for (let m = openRe.exec(fragment); m !== null; m = openRe.exec(fragment)) {
    if (m.index === undefined || m[1] === undefined || m[2] === undefined) {
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    if (isDecorativeTextNode(attrs)) {
      continue;
    }
    if (tag === 'div' && !hasClassToken(attrs, 'hero-badge')) {
      continue;
    }
    if (tag === 'span' && hasClassToken(attrs, 'cta-label')) {
      continue;
    }
    const balanced = extractBalancedInnerHtml(fragment, m.index);
    if (balanced === null) {
      continue;
    }
    const plain = stripHtmlTags(balanced.inner);
    if (plain.length === 0) {
      continue;
    }
    const key = resolveCanonicalFieldKey(tag, attrs, fragment, m.index);
    if (key === null) {
      continue;
    }
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    const richTag = tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'p' || tag === 'span' || tag === 'a';
    const innerHtml = richTag ? balanced.inner : plain;
    out.push({
      key,
      innerHtml,
      openTag: balanced.openTag,
      gvType: key === 'ctaText' ? 'link' : 'text'
    });
  }
  return out;
}

/** Passe C — textes dans app.js (variants, slideCopy). */
export function parseVariantTextsFromJs (js: string): Record<string, string> {
  const out: Record<string, string> = {};
  const variantsBlock = /(?:const|let|var)\s+variants\s*=\s*\{([\s\S]*?)\}\s*;/iu.exec(js);
  if (variantsBlock?.[1] !== undefined) {
    for (const vm of variantsBlock[1].matchAll(/(\w+)\s*:\s*\{([^}]*)\}/giu)) {
      const variantKey = vm[1];
      const body = vm[2] ?? '';
      if (variantKey === undefined || body.length === 0) {
        continue;
      }
      const headline = readJsObjectStringField(body, 'headline');
      const sub = readJsObjectStringField(body, 'sub');
      const price = readJsObjectStringField(body, 'price');
      if (headline !== null) {
        out[`headline_${variantKey}`] = headline;
      }
      if (sub !== null) {
        out[`subhead_${variantKey}`] = sub;
      }
      if (price !== null) {
        out[`price_${variantKey}`] = price;
      }
    }
  }
  const slideBlock = /slideCopy\s*=\s*\[([\s\S]*?)\];/iu.exec(js);
  if (slideBlock?.[1] !== undefined) {
    let idx = 0;
    for (const item of slideBlock[1].matchAll(/\{([\s\S]*?)\}/giu)) {
      const body = item[1] ?? '';
      const headline = readJsObjectStringField(body, 'headline');
      const sub = readJsObjectStringField(body, 'sub');
      if (headline !== null) {
        out[idx === 0 ? 'headline' : `headline_slide_${idx}`] = headline;
      }
      if (sub !== null) {
        out[idx === 0 ? 'subhead' : `subhead_slide_${idx}`] = sub;
      }
      idx += 1;
    }
  }
  return out;
}

function injectBindingsForDiscovered (html: string, discovered: DiscoveredText[]): string {
  let out = html;
  for (const d of discovered) {
    if (new RegExp(`data-gv-bind=["']${d.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'iu').test(out)) {
      continue;
    }
    if (!out.includes(d.openTag)) {
      continue;
    }
    const injected = d.openTag.replace(
      />$/u,
      ` data-gv-bind="${d.key}" data-gv-type="${d.gvType}">`
    );
    out = out.replace(d.openTag, injected);
  }
  return out;
}

function fieldStyleDefaults (
  key: string,
  sg: StyleGuideSlice,
  primaryFont: string,
  accentColor: string
): Partial<GenericTextField> {
  if (key === 'tagLine' || key.startsWith('tab_')) {
    return { size: 10, weight: '600', font: primaryFont };
  }
  if (key === 'headline' || key.startsWith('headline')) {
    return {
      size: 26,
      weight: fontWeightFromStyleGuide(sg, 0, '700'),
      color: DEFAULT_HEADLINE_COLOR,
      font: primaryFont
    };
  }
  if (key === 'headlineAccent') {
    return {
      size: 26,
      weight: fontWeightFromStyleGuide(sg, 0, '700'),
      color: accentColor,
      font: primaryFont
    };
  }
  if (key === 'subhead' || key.startsWith('subhead')) {
    return { size: 12, weight: fontWeightFromStyleGuide(sg, 2, '500'), font: primaryFont };
  }
  if (key === 'price' || key.startsWith('price_')) {
    return { size: 11, weight: '600', font: primaryFont, color: DEFAULT_HEADLINE_COLOR };
  }
  if (key.startsWith('badge_')) {
    return { size: 9, weight: '700', font: primaryFont, color: DEFAULT_HEADLINE_COLOR };
  }
  if (key === 'ctaText') {
    return {
      size: 13,
      weight: fontWeightFromStyleGuide(sg, 2, '600'),
      color: DEFAULT_HEADLINE_COLOR,
      font: primaryFont
    };
  }
  if (key === 'legalText') {
    return { size: 8, weight: '500', font: primaryFont };
  }
  return { size: 12, weight: '500', font: primaryFont };
}

function buildFieldsFromCreative (params: {
  fragment: string;
  appJs: string;
  sg: StyleGuideSlice;
  primaryFont: string;
  accentColor: string;
}): { fields: Record<string, GenericTextField>; discovered: DiscoveredText[] } {
  const { fragment, appJs, sg, primaryFont, accentColor } = params;
  const textByKey: Record<string, string> = {};
  const discovered = discoverTextFieldsFromHtml(fragment);
  for (const d of discovered) {
    textByKey[d.key] = d.innerHtml;
  }
  for (const [ key, text ] of Object.entries(parseVariantTextsFromJs(appJs))) {
    if (text.trim().length > 0) {
      textByKey[key] = text;
    }
  }
  const slideCopy = parseSlideCopyFromJs(appJs);
  if (slideCopy !== null) {
    if (slideCopy.headline.trim().length > 0) {
      textByKey['headline'] = slideCopy.headline;
    }
    if (slideCopy.sub.trim().length > 0) {
      textByKey['subhead'] = slideCopy.sub;
    }
  }
  for (const base of [ 'headline', 'subhead', 'price' ] as const) {
    if ((textByKey[base]?.trim() ?? '').length === 0) {
      const electric = textByKey[`${base}_electric`];
      if (electric !== undefined && electric.trim().length > 0) {
        textByKey[base] = electric;
      }
    }
  }

  const fields: Record<string, GenericTextField> = {};
  for (const [ key, text ] of Object.entries(textByKey)) {
    if (text.trim().length === 0) {
      continue;
    }
    fields[key] = defaultTextField(text, fieldStyleDefaults(key, sg, primaryFont, accentColor));
  }
  return { fields, discovered };
}

function fontWeightFromStyleGuide (sg: StyleGuideSlice, index: number, fallback: string): string {
  const row = sg.typography?.[index];
  if (row !== undefined && typeof row.fontWeight === 'number' && Number.isFinite(row.fontWeight)) {
    return String(row.fontWeight);
  }
  return fallback;
}

function extractImgSrcs (fragment: string, ...classHints: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const classHint of classHints) {
    const re = new RegExp(
      `<img\\b[^>]*\\bclass=["'][^"']*${classHint}[^"']*["'][^>]*\\bsrc=["']([^"']+)["']`,
      'giu'
    );
    for (const m of fragment.matchAll(re)) {
      if (m[1] !== undefined && m[1].length > 0 && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
    const re2 = new RegExp(
      `<img\\b[^>]*\\bsrc=["']([^"']+)["'][^>]*\\bclass=["'][^"']*${classHint}`,
      'giu'
    );
    for (const m of fragment.matchAll(re2)) {
      if (m[1] !== undefined && m[1].length > 0 && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
  }
  return out;
}

function extractHeroSlideSrcs (fragment: string): string[] {
  const openTagRe = /<([a-z][a-z0-9]*)\b([^>]*?)(\/?)>/giu;
  let best: { index: number; tagName: string; score: number } | null = null;

  for (const m of fragment.matchAll(openTagRe)) {
    if (m.index === undefined || m[1] === undefined) {
      continue;
    }
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? '';
    const selfClose = m[3] ?? '';
    if (!isHeroSlidesContainerTag(tag, attrs) || selfClose === '/') {
      continue;
    }
    const outer = extractOuterHtmlFromOpenTag(fragment, m.index, tag);
    const imgCount = outer?.match(/<img\b/giu)?.length ?? 0;
    const score = scoreHeroSlidesContainer(attrs, imgCount);
    if (best === null || score > best.score) {
      best = { index: m.index, tagName: tag, score };
    }
  }

  if (best === null) {
    return [];
  }

  const outer = extractOuterHtmlFromOpenTag(fragment, best.index, best.tagName);
  if (outer === null) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of outer.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/giu)) {
    const src = m[1];
    if (src !== undefined && src.length > 0 && !seen.has(src)) {
      seen.add(src);
      out.push(src);
    }
  }
  return out;
}

function isStaticHeroImageAttrs (attrs: string): boolean {
  if (/\bdata-gv-bind=/iu.test(attrs) || /\blogo\b/iu.test(attrs)) {
    return false;
  }
  return STATIC_HERO_IMG_CLASS_HINTS.some((hint) => new RegExp(`\\b${hint}\\b`, 'iu').test(attrs));
}

function extractStaticHeroSrcs (fragment: string): string[] {
  return extractImgSrcs(fragment, ...STATIC_HERO_IMG_CLASS_HINTS);
}

/** §2.6 — image produit unique (hors carousel `heroSlides`). */
export function ensureStaticHeroImageBinding (html: string): string {
  if (htmlHasBindWithTypes(html, HERO_BIND_KEY, [ 'image' ])) {
    return html;
  }
  let bound = false;
  return html.replace(
    /<img\b([^>]*?)(\/?)>/giu,
    (full, attrs, selfClose) => {
      if (bound || !isStaticHeroImageAttrs(attrs)) {
        return full;
      }
      bound = true;
      const inject = ` data-gv-bind="${HERO_BIND_KEY}" data-gv-type="image"`;
      return `<img${attrs}${inject}${selfClose}>`;
    }
  );
}

function extractClickTag (fragment: string): string | null {
  const patterns = [
    /<a\b[^>]*\bclass=["'][^"']*(?:cta|ad-cta)[^"']*["'][^>]*\bhref=["']([^"']+)["']/iu,
    /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\bclass=["'][^"']*(?:cta|ad-cta)[^"']*["']/iu,
    /<a\b[^>]*\bclass=["'][^"']*cta-btn[^"']*["'][^>]*\bhref=["']([^"']+)["']/iu,
    /<a\b[^>]*\bhref=["']([^"#][^"']*)["']/iu
  ];
  for (const re of patterns) {
    const m = re.exec(fragment);
    if (m?.[1] !== undefined && m[1].length > 0 && m[1] !== '#') {
      return m[1];
    }
  }
  return null;
}

function extractCtaText (fragment: string): string {
  const m =
    /<a\b[^>]*\bclass=["'][^"']*(?:cta|ad-cta)[^"']*["'][^>]*>([\s\S]*?)<\/a>/iu.exec(fragment)
    ?? /<a\b[^>]*\bclass=["'][^"']*cta-btn[^"']*["'][^>]*>([\s\S]*?)<\/a>/iu.exec(fragment);
  if (m?.[1] !== undefined) {
    const inner = stripHtmlTags(m[1]);
    if (inner.length > 0) {
      return inner;
    }
  }
  return '';
}

function parseSlideCopyFromJs (js: string): { headline: string; sub: string } | null {
  const block = /slideCopy\s*=\s*\[([\s\S]*?)\];/iu.exec(js);
  if (block?.[1] === undefined) {
    return null;
  }
  const first = /\{\s*headline\s*:\s*['"]([^'"]*)['"]\s*,\s*sub\s*:\s*['"]([^'"]*)['"]/iu.exec(block[1]);
  if (first?.[1] !== undefined && first[2] !== undefined) {
    return {
      headline: first[1].replace(/\\u00A0/gu, '\u00A0').replace(/\\n/gu, '\n'),
      sub: first[2]
    };
  }
  const firstHtml = /\{\s*headline\s*:\s*['"]([^'"]*(?:\\.[^'"]*)*)['"]/iu.exec(block[1]);
  const subM = /sub\s*:\s*['"]([^'"]*)['"]/iu.exec(block[1]);
  if (firstHtml?.[1] !== undefined) {
    return {
      headline: firstHtml[1].replace(/\\u00A0/gu, '\u00A0'),
      sub: subM?.[1] ?? ''
    };
  }
  return null;
}

function readStyleGuideSlice (outputRunDir: string): StyleGuideSlice {
  const path = join(outputRunDir, 'style-guide.json');
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readUtf8(path)) as StyleGuideSlice;
  } catch {
    return {};
  }
}

function primaryFontFromStyleGuide (sg: StyleGuideSlice): string {
  const first = sg.typography?.[0]?.fontFamily;
  return typeof first === 'string' && first.length > 0 ? first : DEFAULT_FONT;
}

function accentColorFromStyleGuide (sg: StyleGuideSlice): string {
  const palette = sg.primaryColorPalette;
  if (Array.isArray(palette) && palette.length > 1 && typeof palette[1] === 'string') {
    return palette[1];
  }
  return DEFAULT_ACCENT_COLOR;
}

export function buildGenericAdConfigFromStrings (params: {
  indexHtml: string;
  stylesCss: string;
  appJs: string;
  outputRunDir?: string;
}): GenericAdConfig {
  const { indexHtml, stylesCss, appJs, outputRunDir } = params;
  const sg = outputRunDir !== undefined ? readStyleGuideSlice(outputRunDir) : {};
  const primaryFont = primaryFontFromStyleGuide(sg);
  const accentColor = accentColorFromStyleGuide(sg);

  const domId = findFirstAdDomId(indexHtml) ?? 'ad-generic';
  const fragment = getAdFragmentForExtraction(indexHtml, domId);
  if (fragment.length === 0) {
    throw new Error('Cannot export generic config: ad HTML root is empty.');
  }

  const dimensions =
    parseDimensionsFromCss(stylesCss, domId)
    ?? parseDimensionsFromDomId(domId)
    ?? parseDimensionsFromTitle(indexHtml)
    ?? (outputRunDir !== undefined ? parseDimensionsFromFormatsFile(outputRunDir) : null)
    ?? { width: 320, height: 480 };

  const backgroundColor =
    parseBackgroundFromCss(stylesCss, domId)
    ?? (Array.isArray(sg.primaryColorPalette) && typeof sg.primaryColorPalette[0] === 'string'
      ? sg.primaryColorPalette[0]
      : DEFAULT_BG);

  const clickTag =
    extractClickTag(fragment)
    ?? (typeof sg.brandURL === 'string' && sg.brandURL.length > 0 ? sg.brandURL : DEFAULT_CLICK);

  const logoImgs = extractImgSrcs(fragment, 'logo');
  const logo = logoImgs.length > 0 ? logoImgs : extractImgSrcs(fragment, 'ad-logo-img', 'ad-logo');
  const heroSlides = extractHeroSlideSrcs(fragment);
  const hasCarousel = heroSlides.length > 0;
  const staticHeroSrcs = hasCarousel ? [] : extractStaticHeroSrcs(fragment);

  const { fields, discovered } = buildFieldsFromCreative({
    fragment,
    appJs,
    sg,
    primaryFont,
    accentColor
  });

  if (fields['ctaText'] === undefined) {
    const ctaText = extractCtaText(fragment);
    if (ctaText.length > 0) {
      fields['ctaText'] = defaultTextField(ctaText, fieldStyleDefaults('ctaText', sg, primaryFont, accentColor));
    }
  }

  splitHeadlineAccentFields(fields, (key) =>
    fieldStyleDefaults(key, sg, primaryFont, accentColor)
  );
  applyFieldStylesFromCss(fields, stylesCss);

  const images: Record<string, string[]> = {};
  if (logo.length > 0) {
    images['logo'] = logo;
  }
  if (hasCarousel) {
    images['heroSlides'] = heroSlides;
  } else if (staticHeroSrcs.length > 0) {
    images[HERO_BIND_KEY] = [ staticHeroSrcs[0]! ];
  }

  const settings: GenericAdSettings = {};
  if (backgroundColor.length > 0) {
    settings.backgroundColor = backgroundColor;
  }
  if (clickTag.length > 0) {
    settings.clickTag = clickTag;
  }

  let htmlWithBindings = stripDecorativeAriaHidden(injectGenericBindings(fragment));
  htmlWithBindings = injectBindingsForDiscovered(htmlWithBindings, discovered);
  if (fields['headlineAccent'] !== undefined) {
    htmlWithBindings = restructureHeadlineAccentHtml(htmlWithBindings);
  }
  htmlWithBindings = restructureCtaLabelHtml(htmlWithBindings);
  htmlWithBindings = appendHiddenFieldBindings(htmlWithBindings, fields);
  if (hasCarousel && !htmlHasBindWithTypes(htmlWithBindings, HERO_SLIDES_BIND_KEY, [ 'image-list' ])) {
    htmlWithBindings = ensureHeroSlidesImageListBinding(htmlWithBindings);
  }
  const hasHeroSlidesBinding = htmlHasBindWithTypes(htmlWithBindings, HERO_SLIDES_BIND_KEY, [ 'image-list' ]);
  if (!hasHeroSlidesBinding) {
    delete images['heroSlides'];
  } else if (images['heroSlides'] !== undefined) {
    settings.slideInterval = parseSlideInterval(appJs);
  }
  if (!hasCarousel && images[HERO_BIND_KEY] !== undefined) {
    htmlWithBindings = ensureStaticHeroImageBinding(htmlWithBindings);
  }
  if (!htmlHasBindWithTypes(htmlWithBindings, HERO_BIND_KEY, [ 'image' ])) {
    delete images[HERO_BIND_KEY];
  }

  const draft: GenericAdConfig = {
    type: 'generic',
    dimensions,
    settings,
    fields,
    images,
    html: htmlWithBindings,
    css: prepareCssForGalleryExport(stylesCss, sg, domId),
    js: appJs
  };

  return serializeGenericAdConfig(draft);
}

export function buildGenericAdConfig (params: {
  bundleDir: string;
  outputRunDir: string;
}): GenericAdConfig {
  const indexPath = join(params.bundleDir, 'index.html');
  const cssPath = join(params.bundleDir, 'styles.css');
  const jsPath = join(params.bundleDir, 'app.js');
  for (const p of [ indexPath, cssPath, jsPath ]) {
    if (!existsSync(p)) {
      throw new Error(`Missing required file: ${p}`);
    }
  }
  const indexHtml = readUtf8(indexPath);
  const stylesCss = readUtf8(cssPath);
  const appJs = readUtf8(jsPath);
  syncBundleAssetsFromBundleSource({
    bundleDir: params.bundleDir,
    html: indexHtml,
    css: stylesCss,
    js: appJs
  });
  const base = buildGenericAdConfigFromStrings({
    indexHtml,
    stylesCss,
    appJs,
    outputRunDir: params.outputRunDir
  });
  const embedded = embedBundleAssetsInConfig(base, params.bundleDir);
  return serializeGenericAdConfig(embedded);
}

/** Nom du fichier JSON galerie écrit dans chaque `code/Vn/`. */
export const GENERIC_CONFIG_FILENAME = 'generic-config.json';

export function genericConfigFilePath (bundleDir: string): string {
  return join(bundleDir, GENERIC_CONFIG_FILENAME);
}

/** True when `generic-config.json` exists and is at least as new as `index.html`. */
export function isGenericConfigFileFresh (bundleDir: string): boolean {
  const jsonPath = genericConfigFilePath(bundleDir);
  const indexPath = join(bundleDir, 'index.html');
  if (!existsSync(jsonPath) || !existsSync(indexPath)) {
    return false;
  }
  return statSync(jsonPath).mtimeMs >= statSync(indexPath).mtimeMs;
}

export function readGenericAdConfigFile (bundleDir: string): GenericAdConfig {
  const validated = validateGenericAdConfig(
    JSON.parse(readFileSync(genericConfigFilePath(bundleDir), 'utf8')) as unknown
  );
  if (!validated.ok) {
    throw new Error(validated.error);
  }
  return validated.config;
}

export function writeGenericAdConfigFile (params: {
  bundleDir: string;
  outputRunDir: string;
  outPath?: string;
}): { path: string; config: GenericAdConfig } {
  const config = buildGenericAdConfig({
    bundleDir: params.bundleDir,
    outputRunDir: params.outputRunDir
  });
  const outPath = params.outPath ?? genericConfigFilePath(params.bundleDir);
  writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8' });
  return { path: outPath, config };
}
