import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import { withAnthropicRetry } from './anthropic-retry.mts';
import {
  describeAssetsForReview,
  ENTERTAINMENT_PROMO_ASSET_KINDS,
  EXPERIENCE_PROMO_ASSET_KINDS,
  USABLE_PROMO_ASSET_KINDS,
  loadAssetDescriptions,
  type AssetDescriptionsFile,
  type AssetDescriptionEntry,
  type DescribeApprovedAssetsResult
} from './creative-asset-descriptions.mts';
import {
  appendPipelineUsage,
  entryFromSingleUsage,
  logPipelineUsageToConsole,
  priceUsdFromTokens,
  timedAnthropicCall,
  type PriceUsd
} from './creative-pipeline-usage.mts';
import {
  appendAssetsReviewLog,
  assetsReviewOutputSchema,
  logAssetsReviewAuditToConsole,
  type AssetsReviewOutput,
  type AssetsReviewUsageTotals
} from '../agents/creative-native-assets-review.mts';
import { listAssetImageFiles } from './asset-sidecar-files.mts';
import type { DeterministicFinding } from './creative-native-assets-deterministic.mts';
import {
  loadProductAssetSources,
  removeProductAssetSource
} from './product-asset-sources.mts';
import { existsSync, unlinkSync } from 'node:fs';
import { mergeLogoVisionIntoAudit, runLogoVisionAudit } from './logo-vision-audit.mts';
import {
  buildProductMatchFields,
  buildProductMatchTerms,
  buildRetailCampaignRelevanceTerms,
  resolveCampaignAssetProfile,
  type CampaignAssetProfile,
  type ProductMatchFields
} from './style-guide-context.mts';

export { buildRetailCampaignRelevanceTerms } from './style-guide-context.mts';
import { join } from 'node:path';
import type { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const DEFAULT_ASSETS_REVIEW_MODEL = 'claude-haiku-4-5-20251001';

const TEXT_ONLY_LAYOUT_HINTS = new Set([
  'categorie-banner',
  'texte-lisible',
  'hero-promo',
  'call-to-action',
  'large-text',
  'segment-focus',
  'categorie-coffrets',
  'categorie-thes'
]);

function parseEnvInt (name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function minPhysicalProductAssets (): number {
  return parseEnvInt('CREATIVE_ASSETS_MIN_PHYSICAL_PRODUCTS', 1);
}

export function minValidProductAssets (): number {
  return parseEnvInt('CREATIVE_ASSETS_MIN_VALID_PRODUCTS', 3);
}

export function maxValidProductAssets (): number {
  return parseEnvInt('CREATIVE_ASSETS_MAX_VALID_PRODUCTS', 5);
}

export function minDistinctProductAssets (): number {
  return parseEnvInt('CREATIVE_ASSETS_MIN_DISTINCT_PRODUCTS', 1);
}

export function requireDistinctWhenPhysicalCountGe (): number {
  return parseEnvInt('CREATIVE_ASSETS_REQUIRE_DISTINCT_WHEN_COUNT_GE', 2);
}

const VAGUE_PRODUCT_NAME_RE =
  /^(?:kusmi|the|thé|tea|produit|product|sélection|selection|collection|gamme|range|assortiment|various|divers)$/iu;

/** Normalize SKU label for deduplication (lowercase, no accents). */
export function normalizeProductName (name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, ' ');
}

function isIdentifiablePhysicalProduct (entry: AssetDescriptionEntry): boolean {
  return (
    entry.fileType === 'products' &&
    entry.shows_physical_product === true &&
    !isTextOnlyProductEntry(entry)
  );
}

function isConcreteProductName (name: string): boolean {
  const normalized = normalizeProductName(name);
  if (normalized.length < 2) {
    return false;
  }
  if (VAGUE_PRODUCT_NAME_RE.test(normalized)) {
    return false;
  }
  return true;
}

function distinctSkuKey (entry: AssetDescriptionEntry): string | null {
  if (!isIdentifiablePhysicalProduct(entry) || entry.is_generic_collection === true) {
    return null;
  }
  const name = entry.primary_product_name?.trim() ?? '';
  if (!isConcreteProductName(name)) {
    return null;
  }
  return normalizeProductName(name);
}

/** SKU diversity checks on structured describe fields. */
export function auditDistinctProducts (descriptions: AssetDescriptionsFile): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const physical = descriptions.assets.filter((e) => isIdentifiablePhysicalProduct(e));
  if (physical.length === 0) {
    return findings;
  }

  const skuKeys = physical.map((e) => distinctSkuKey(e));
  const identifiable = skuKeys.filter((k): k is string => k !== null);
  const distinct = new Set(identifiable);
  const genericCount = physical.filter((e) => e.is_generic_collection === true).length;
  const minDistinct = minDistinctProductAssets();
  const requireDistinctThreshold = requireDistinctWhenPhysicalCountGe();

  const missingName = physical.filter((e) => {
    const key = distinctSkuKey(e);
    return key === null && e.is_generic_collection !== true;
  });

  for (const entry of missingName) {
    const name = entry.primary_product_name?.trim() ?? '';
    if (name.length === 0) {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'blocker',
        issue: 'Physical product image has no primary_product_name — cannot verify distinct SKU.',
        fix_hint:
          'Re-describe or replace with a packshot/lifestyle image where the dominant product name is visible on packaging.'
      });
    } else if (!isConcreteProductName(name)) {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'blocker',
        issue: `primary_product_name "${name}" is too vague — need a concrete SKU/ritual/kit name.`,
        fix_hint: 'Use the exact product name printed on the pack (e.g. Sommeil, Kit Bubble Tea Litchi Rose).'
      });
    }
  }

  if (identifiable.length === 0 && genericCount < physical.length) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: 'No identifiable distinct product SKU among physical product images.',
      fix_hint:
        'Refresh with packshots where the product name is readable on the packaging, or distinct ritual/kit heroes.'
    });
  }

  if (identifiable.length > 0 && distinct.size < minDistinct) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `Need at least ${String(minDistinct)} distinct product SKU(s); found ${String(distinct.size)}.`,
      fix_hint: 'Add assets showing different named products from the brand range.'
    });
  }

  if (
    physical.length >= requireDistinctThreshold &&
    identifiable.length >= requireDistinctThreshold &&
    distinct.size === 1
  ) {
    const onlySku = [ ...distinct ][0] ?? '';
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `${String(physical.length)} physical product image(s) all depict the same SKU ("${onlySku}") — need distinct products for ad variety.`,
      fix_hint:
        'Refresh with Brave queries naming different SKUs from the range (not repeated packshots of the same product).'
    });
  }

  if (genericCount > 0 && genericCount >= Math.ceil(physical.length / 2) && distinct.size < minDistinct) {
    findings.push({
      asset_id: 'products',
      severity: 'warn',
      issue: 'Majority of physical product images are generic multi-SKU collections without a dominant named product.',
      fix_hint: 'Prefer packshots or lifestyle scenes with one clear hero SKU per image.'
    });
  }

  return findings;
}

function isTextOnlyProductEntry (entry: AssetDescriptionEntry): boolean {
  if (entry.fileType !== 'products') {
    return false;
  }
  if (entry.asset_kind === 'text_only_banner') {
    return true;
  }
  if (entry.asset_kind !== undefined && USABLE_PROMO_ASSET_KINDS.has(entry.asset_kind)) {
    return false;
  }
  const hints = entry.layout_hints.map((h) => h.toLowerCase());
  const hasTextNavHint = hints.some((h) => TEXT_ONLY_LAYOUT_HINTS.has(h));
  const hasPackshotHint = hints.some((h) =>
    /packshot|lifestyle|product-showcase|product-packshot|mise-en-scene|hero-image|ride-action|roller-coaster|park-setting|family-moment/iu.test(
      h
    )
  );
  if (hasPackshotHint) {
    return false;
  }
  if (hasTextNavHint && entry.shows_physical_product !== true) {
    return true;
  }
  const desc = entry.description.toLowerCase();
  if (
    /banni[eè]re promotionnelle|tuile (de )?cat[eé]gorie|navigation menu|texte seul|uniquement du texte/iu.test(
      desc
    ) &&
    entry.shows_physical_product !== true &&
    !/attraction|roller coaster|parc|man[eè]ge|ride|visiteur|famille|lifestyle/iu.test(desc)
  ) {
    return true;
  }
  return false;
}

/** Count product assets suitable as ad heroes (packshots, lifestyle, promo — not text-only tiles). */
export function countUsableProductAssets (descriptions: AssetDescriptionsFile): number {
  return descriptions.assets.filter(
    (e) => e.fileType === 'products' && !isTextOnlyProductEntry(e)
  ).length;
}

const BTS_LAYOUT_HINTS = /production-still|behind-the-scenes|clapperboard|on-set|bts/iu;

function isEntertainmentPromoVisual (entry: AssetDescriptionEntry): boolean {
  if (entry.fileType !== 'products') {
    return false;
  }
  if (entry.asset_kind !== undefined && ENTERTAINMENT_PROMO_ASSET_KINDS.has(entry.asset_kind)) {
    return true;
  }
  if (entry.asset_kind === 'text_only_banner') {
    return false;
  }
  const hints = entry.layout_hints.join(' ').toLowerCase();
  if (/theatrical-poster|key-art|film-poster|character-close-up|ensemble-cast|cast-photo/iu.test(hints)) {
    return true;
  }
  const desc = entry.description.toLowerCase();
  if (/affiche|poster|key art|film still|cast promo|title treatment/iu.test(desc)) {
    return true;
  }
  return false;
}

function isEntertainmentTextOnlyNavTile (entry: AssetDescriptionEntry): boolean {
  if (entry.fileType !== 'products' || entry.asset_kind !== 'text_only_banner') {
    return false;
  }
  const hints = entry.layout_hints.map((h) => h.toLowerCase());
  const hasNavHint = hints.some((h) => TEXT_ONLY_LAYOUT_HINTS.has(h));
  const desc = entry.description.toLowerCase();
  const navDesc =
    /banni[eè]re promotionnelle|tuile (de )?cat[eé]gorie|navigation menu|texte seul|uniquement du texte/iu.test(
      desc
    );
  const hasFilmImagery = /affiche|poster|film|cast|personnage|character/iu.test(desc);
  return (hasNavHint || navDesc) && !hasFilmImagery;
}

function campaignTermMatchesEntry (
  entry: AssetDescriptionEntry,
  campaignTerms: readonly string[]
): boolean {
  const hay = normalizeProductName(
    `${entry.primary_product_name ?? ''} ${entry.description} ${entry.fileName}`
  );
  return campaignTerms.some((term) => {
    const t = normalizeProductName(term);
    if (t.length < 3) {
      return false;
    }
    if (/\d{3,}/u.test(t)) {
      return hay.includes(t);
    }
    return t.length >= 3 && hay.includes(t);
  });
}

function isUsableRetailProductEntry (entry: AssetDescriptionEntry): boolean {
  return entry.fileType === 'products' && !isTextOnlyProductEntry(entry);
}

/** Count product assets that match campaign subject terms. */
export function countRelevantRetailProductAssets (
  descriptions: AssetDescriptionsFile,
  campaignTerms: readonly string[]
): number {
  if (campaignTerms.length === 0) {
    return countUsableProductAssets(descriptions);
  }
  return descriptions.assets.filter(
    (e) => isUsableRetailProductEntry(e) && campaignTermMatchesEntry(e, campaignTerms)
  ).length;
}

function scoreProductForPrune (
  fileName: string,
  entry: AssetDescriptionEntry | undefined,
  campaignTerms: readonly string[],
  sourceUrl: string
): number {
  if (entry !== undefined) {
    if (campaignTerms.length > 0 && !campaignTermMatchesEntry(entry, campaignTerms)) {
      return 0;
    }
    if (entry.is_generic_collection === true) {
      return 1;
    }
    return 2;
  }
  if (campaignTerms.length > 0) {
    const hay = normalizeProductName(`${fileName} ${sourceUrl}`);
    const matches = campaignTerms.some((term) => {
      const t = normalizeProductName(term);
      return t.length >= 3 && hay.includes(t);
    });
    if (!matches) {
      return 0;
    }
  }
  return 1;
}

/** Remove lowest-priority product files when products/ exceeds max (off-topic first, then generic). */
export function pruneExcessProductAssets (
  directoryPath: string,
  options?: {
    max?: number;
    campaignTerms?: readonly string[];
    descriptions?: AssetDescriptionsFile | null;
  }
): { removed: string[] } {
  const max = options?.max ?? maxValidProductAssets();
  const files = listAssetImageFiles(directoryPath, 'products');
  if (files.length <= max) {
    return { removed: [] };
  }

  const descriptions = options?.descriptions ?? loadAssetDescriptions(directoryPath);
  const descByFile = new Map<string, AssetDescriptionEntry>();
  if (descriptions !== null) {
    for (const entry of descriptions.assets) {
      if (entry.fileType === 'products') {
        descByFile.set(entry.fileName, entry);
      }
    }
  }

  const sourceMap = loadProductAssetSources(directoryPath);
  const campaignTerms = options?.campaignTerms ?? [];
  const ranked = files.map((fileName) => ({
    fileName,
    score: scoreProductForPrune(
      fileName,
      descByFile.get(fileName),
      campaignTerms,
      sourceMap.get(fileName)?.sourceUrl?.trim() ?? ''
    )
  }));
  ranked.sort((a, b) => a.score - b.score);

  const removed: string[] = [];
  let remaining = files.length;
  for (const { fileName } of ranked) {
    if (remaining <= max) {
      break;
    }
    const filePath = join(directoryPath, 'products', fileName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      removeProductAssetSource(directoryPath, fileName);
      removed.push(`products/${fileName}`);
      remaining -= 1;
      console.log(`[assets-prune] Removed excess product: products/${fileName}`);
    }
  }

  return { removed };
}

/** Entertainment audit — subject relevance, not retail SKU/physical product rules. */
export function deterministicFindingsFromEntertainmentDescriptions (
  descriptions: AssetDescriptionsFile,
  productFileCount: number,
  campaignTerms: readonly string[]
): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const productEntries = descriptions.assets.filter((e) => e.fileType === 'products');

  for (const entry of productEntries) {
    if (isEntertainmentTextOnlyNavTile(entry)) {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'blocker',
        issue:
          'Image is a text-only navigation/category tile with no film promotional imagery — not a usable promotional visual.',
        fix_hint:
          'Replace with official theatrical poster, key art, or cast promotional photo from IMDb/Allociné/official site.'
      });
    }
  }

  const promoVisuals = productEntries.filter(
    (e) => !isEntertainmentTextOnlyNavTile(e) && isEntertainmentPromoVisual(e)
  );
  const relevantPromo = promoVisuals.filter((e) => campaignTermMatchesEntry(e, campaignTerms));

  if (productFileCount > 0 && relevantPromo.length === 0 && promoVisuals.length === 0) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue:
        'No usable film promotional visual (poster, key art, or still) matching the campaign title.',
      fix_hint:
        'Refresh with Brave queries: site:imdb.com, site:allocine.fr, site:impawards.com + film title + poster/key art.'
    });
  }

  const btsOnly =
    productEntries.length > 0 &&
    promoVisuals.length > 0 &&
    promoVisuals.every((e) => {
      const hints = e.layout_hints.join(' ');
      const desc = e.description;
      return BTS_LAYOUT_HINTS.test(hints) || BTS_LAYOUT_HINTS.test(desc);
    }) &&
    !productEntries.some((e) => e.asset_kind === 'theatrical_poster' || e.asset_kind === 'key_art');

  if (btsOnly) {
    findings.push({
      asset_id: 'products',
      severity: 'warn',
      issue:
        'Portfolio contains only behind-the-scenes/production stills — consider adding an official theatrical poster or key art.',
      fix_hint:
        'Add site:impawards.com or site:allocine.fr queries for official theatrical poster.'
    });
  }

  return findings;
}

function isExperiencePromoVisual (entry: AssetDescriptionEntry): boolean {
  if (entry.fileType !== 'products') {
    return false;
  }
  if (entry.asset_kind !== undefined && EXPERIENCE_PROMO_ASSET_KINDS.has(entry.asset_kind)) {
    return true;
  }
  if (entry.asset_kind === 'mascot_brand') {
    return true;
  }
  if (entry.asset_kind === 'text_only_banner') {
    return false;
  }
  const hints = entry.layout_hints.join(' ').toLowerCase();
  if (
    /attraction|roller-coaster|ride-action|park-setting|family-moment|ticket-pass|venue-lifestyle|mascot/iu.test(
      hints
    )
  ) {
    return true;
  }
  const desc = entry.description.toLowerCase();
  if (/attraction|man[eè]ge|roller coaster|parc|famille|visiteur|billetterie|pass|ticket/iu.test(desc)) {
    return true;
  }
  return false;
}

function isExperienceTextOnlyNavTile (entry: AssetDescriptionEntry): boolean {
  if (entry.fileType !== 'products' || entry.asset_kind !== 'text_only_banner') {
    return false;
  }
  const hints = entry.layout_hints.map((h) => h.toLowerCase());
  const hasNavHint = hints.some((h) => TEXT_ONLY_LAYOUT_HINTS.has(h));
  const desc = entry.description.toLowerCase();
  const navDesc =
    /banni[eè]re promotionnelle|tuile (de )?cat[eé]gorie|navigation menu|texte seul|uniquement du texte/iu.test(
      desc
    );
  const hasParkImagery = /attraction|parc|man[eè]ge|famille|ride|roller coaster/iu.test(desc);
  return (hasNavHint || navDesc) && !hasParkImagery;
}

/** Experience audit — attractions, lifestyle, ticketing — not retail SKU rules. */
export function deterministicFindingsFromExperienceDescriptions (
  descriptions: AssetDescriptionsFile,
  productFileCount: number,
  campaignTerms: readonly string[]
): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const minValid = minValidProductAssets();
  const productEntries = descriptions.assets.filter((e) => e.fileType === 'products');

  for (const entry of productEntries) {
    if (isExperienceTextOnlyNavTile(entry)) {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'blocker',
        issue:
          'Image is a text-only navigation/category tile with no park or attraction imagery — not a usable promotional visual.',
        fix_hint:
          'Replace with official attraction photo, family lifestyle scene, or ticket/pass visual from the brand site.'
      });
    }
    if (entry.asset_kind === 'mascot_brand') {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'warn',
        issue: 'Mascot render is suitable as secondary accent — prefer attraction or lifestyle heroes as primary assets.',
        fix_hint: 'Keep mascot for corner/badge use; ensure at least 2 attraction or lifestyle heroes exist.'
      });
    }
  }

  const promoVisuals = productEntries.filter(
    (e) => !isExperienceTextOnlyNavTile(e) && isExperiencePromoVisual(e)
  );
  const usableCount = promoVisuals.length;
  const relevantPromo = promoVisuals.filter((e) => campaignTermMatchesEntry(e, campaignTerms));

  if (productFileCount > 0 && usableCount < minValid) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `Need at least ${String(minValid)} usable experience visual(s) (attraction, lifestyle, ticket); found ${String(usableCount)}.`,
      fix_hint:
        'Refresh with Brave queries naming attractions, summer campaign, or family park photos from the official site.'
    });
  } else if (
    productFileCount > 0 &&
    relevantPromo.length === 0 &&
    promoVisuals.length === 0 &&
    usableCount === 0
  ) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: 'No usable experience promotional visual matching the campaign context.',
      fix_hint:
        'Refresh with site:brand + attraction names, summer campaign, family lifestyle from official pages.'
    });
  }

  return findings;
}

/** Retail audit — packshot rules plus per-asset campaign subject relevance (3–5 products). */
export function deterministicFindingsFromRetailDescriptions (
  descriptions: AssetDescriptionsFile,
  productFileCount: number,
  campaignTerms: readonly string[]
): DeterministicFinding[] {
  const findings: DeterministicFinding[] = [];
  const minValid = minValidProductAssets();
  const maxValid = maxValidProductAssets();
  const usableCount = countUsableProductAssets(descriptions);
  const relevantCount = countRelevantRetailProductAssets(descriptions, campaignTerms);

  for (const entry of descriptions.assets) {
    if (entry.fileType !== 'products') {
      continue;
    }
    if (isTextOnlyProductEntry(entry)) {
      findings.push({
        asset_id: entry.asset_id,
        severity: usableCount >= minValid ? 'warn' : 'blocker',
        issue:
          'Product image is a text-only category/promo banner (no photographed product) — not usable as ad hero.',
        fix_hint:
          'Replace with official packshots or lifestyle scenes showing physical products (site:brand packshot).'
      });
      continue;
    }
    if (campaignTerms.length > 0 && !campaignTermMatchesEntry(entry, campaignTerms)) {
      findings.push({
        asset_id: entry.asset_id,
        severity: 'blocker',
        issue:
          'Product image is off-topic — description and primary_product_name do not match the campaign subject.',
        fix_hint:
          'Remove and replace with on-campaign packshots or lifestyle scenes from the official reference page.'
      });
    }
  }

  const physicalCount = descriptions.assets.filter(
    (e) => e.fileType === 'products' && e.shows_physical_product === true
  ).length;

  if (productFileCount > maxValid) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `Too many product files in products/ (maximum ${String(maxValid)}); found ${String(productFileCount)}.`,
      fix_hint: 'Prune off-topic or excess assets so only 3–5 on-campaign product images remain.'
    });
  }

  if (productFileCount > 0 && relevantCount < minValid) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `Need at least ${String(minValid)} on-campaign product image(s); found ${String(relevantCount)} matching campaign terms (${String(usableCount)} usable, ${String(physicalCount)} with visible physical product).`,
      fix_hint:
        'Refresh products with Brave queries naming concrete on-campaign SKUs from the official site.'
    });
  } else if (productFileCount > 0 && usableCount < minValid) {
    findings.push({
      asset_id: 'products',
      severity: 'blocker',
      issue: `Need at least ${String(minValid)} usable product image(s) (packshot/lifestyle/promo); found ${String(usableCount)} (${String(physicalCount)} with visible physical product).`,
      fix_hint:
        'Refresh products with Brave queries naming concrete SKUs, attractions, or lifestyle scenes from the official site.'
    });
  }

  findings.push(...auditDistinctProducts(descriptions));

  return findings;
}

/** Programmatic audit on structured describe fields — robust against euphemistic prose. */
export function deterministicFindingsFromAssetDescriptions (
  descriptions: AssetDescriptionsFile,
  productFileCount: number,
  options?: { profile?: CampaignAssetProfile; campaignTerms?: readonly string[] }
): DeterministicFinding[] {
  const profile = options?.profile ?? 'retail';
  const campaignTerms = options?.campaignTerms ?? [];

  if (profile === 'entertainment') {
    return deterministicFindingsFromEntertainmentDescriptions(
      descriptions,
      productFileCount,
      campaignTerms
    );
  }
  if (profile === 'experience') {
    return deterministicFindingsFromExperienceDescriptions(
      descriptions,
      productFileCount,
      campaignTerms
    );
  }

  return deterministicFindingsFromRetailDescriptions(descriptions, productFileCount, campaignTerms);
}

function deterministicToReviewFindings (
  findings: DeterministicFinding[]
): AssetsReviewOutput['findings'] {
  return findings.map((f) => ({
    asset_id: f.asset_id,
    severity: f.severity,
    issue: f.issue,
    fix_hint: f.fix_hint
  }));
}

function sanitizeLlmFindings (
  findings: AssetsReviewOutput['findings'],
  profile: CampaignAssetProfile = 'retail'
): AssetsReviewOutput['findings'] {
  let filtered = findings.filter((f) => !(f.asset_id.startsWith('logos/') && f.severity === 'blocker'));
  if (profile === 'entertainment' || profile === 'experience') {
    filtered = filtered.filter((f) => {
      if (f.severity !== 'blocker') {
        return true;
      }
      const issue = f.issue.toLowerCase();
      if (
        /physical product|packshot|same sku|distinct product|ad hero|shows_physical_product|sku variety|merchandise display|identical primary_product_name|concrete sku|product-focused ad|product display standard/iu.test(
          issue
        )
      ) {
        return false;
      }
      return true;
    });
  }
  return filtered;
}

function mergeAudits (
  deterministic: DeterministicFinding[],
  llm: AssetsReviewOutput | null,
  profile: CampaignAssetProfile = 'retail'
): AssetsReviewOutput {
  const detReview = deterministicToReviewFindings(deterministic);
  const llmFindings = sanitizeLlmFindings(llm?.findings ?? [], profile);
  const seen = new Set<string>();
  const merged: AssetsReviewOutput['findings'] = [];

  for (const f of [ ...detReview, ...llmFindings ]) {
    const key = `${f.asset_id}::${f.issue}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(f);
  }

  const blockers = merged.filter((f) => f.severity === 'blocker');
  const satisfied = blockers.length === 0;
  const summary =
    llm?.summary ??
    (satisfied
      ? 'Asset descriptions audit passed (deterministic).'
      : `Asset descriptions audit failed: ${String(blockers.length)} blocker(s).`);

  return {
    satisfied,
    summary,
    findings: merged,
    brave_retry_queries: llm?.brave_retry_queries ?? { logos: [], products: [] }
  };
}

export type RunAssetDescriptionsAuditOptions = {
  anthropicClient: Anthropic;
  directoryPath: string;
  descriptions: AssetDescriptionsFile;
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  reviewRound: number;
  productFileCount: number;
  model?: string;
};

export async function runAssetDescriptionsAudit (
  options: RunAssetDescriptionsAuditOptions
): Promise<{ audit: AssetsReviewOutput; usage: AssetsReviewUsageTotals }> {
  const { directoryPath, descriptions, prunedStyleGuide, reviewRound, productFileCount } = options;
  const reviewDir = join(directoryPath, 'review');
  const model =
    options.model ?? process.env['CREATIVE_ASSETS_REVIEW_MODEL']?.trim() ?? DEFAULT_ASSETS_REVIEW_MODEL;

  const profile = resolveCampaignAssetProfile(buildProductMatchFields({
    campaignContext: prunedStyleGuide.campaignContext ?? null,
    productName: prunedStyleGuide.productName,
    brandName: prunedStyleGuide.brandName,
    brandContext: prunedStyleGuide.brandContext,
    brandURL: prunedStyleGuide.brandURL,
    campaignAssetProfile: prunedStyleGuide.campaignAssetProfile
  }));
  console.log(`[asset-descriptions-audit] Campaign asset profile: ${profile}`);

  const matchFields: ProductMatchFields = {
    campaignContext: prunedStyleGuide.campaignContext ?? null,
    productName: prunedStyleGuide.productName,
    brandName: prunedStyleGuide.brandName,
    brandContext: prunedStyleGuide.brandContext,
    brandURL: prunedStyleGuide.brandURL
  };
  const campaignTerms =
    profile === 'retail'
      ? buildRetailCampaignRelevanceTerms(matchFields)
      : buildProductMatchTerms(matchFields);

  const deterministic = deterministicFindingsFromAssetDescriptions(descriptions, productFileCount, {
    profile,
    campaignTerms
  });
  if (deterministic.length > 0) {
    console.log(
      `[asset-descriptions-audit] Deterministic pre-check: ${String(deterministic.length)} finding(s)`
    );
    for (const f of deterministic) {
      console.log(`[asset-descriptions-audit]   [${f.severity}] ${f.asset_id}: ${f.issue}`);
    }
  }

  const minValid = minValidProductAssets();
  const maxValid = maxValidProductAssets();

  const retailSystemPrompt = [
    'You audit pre-generated asset descriptions (JSON) before HTML5 ad code generation.',
    'You receive NO images — only structured descriptions with shows_physical_product, asset_kind, primary_product_name, is_generic_collection.',
    'Evaluate product relevance for the campaign in the style guide.',
    'Rules:',
    '- BLOCKER for products/ where asset_kind is text_only_banner or the description is a category navigation tile.',
    `- BLOCKER when fewer than ${String(minValid)} or more than ${String(maxValid)} on-campaign product assets exist in products/.`,
    '- BLOCKER when any products/ asset is clearly off-topic (wrong franchise, sport, unrelated brand line) vs brandName, productName, campaignContext, or brandContext.',
    '- BLOCKER when primary_product_name is missing, vague, or inconsistent with the description for physical products.',
    '- BLOCKER when 2+ physical product assets share the exact same primary_product_name (same SKU repeated). Different flavor/variant names (e.g. Litchi vs Pêche kits) are distinct — do not treat as duplicates.',
    '- BLOCKER when no distinct identifiable SKUs exist among physical product assets.',
    '- Accept is_generic_collection=true only if at least one other asset has a concrete primary_product_name.',
    '- Listing campaigns: accept multiple SKUs from the same campaign line only — never other ranges from the same retailer (e.g. FIFA or Star Wars on a Pokémon campaign).',
    '- Trust deterministic subject-relevance and SKU pre-checks — do not downgrade off-topic assets to warnings.',
    '- WARN only for minor logo padding issues (logos are validated by a separate Haiku vision audit).',
    '- Accept packshots, lifestyle scenes with visible merchandise, and product group shots when on-campaign.',
    `Set satisfied to true when ${String(minValid)}–${String(maxValid)} on-campaign retail product assets exist and zero blockers.`,
    'For blockers, suggest concrete Brave image search queries in brave_retry_queries.products naming different on-campaign SKUs.',
    '',
    '--- Style guide JSON ---',
    JSON.stringify(prunedStyleGuide),
    '',
    '--- Asset descriptions JSON ---',
    JSON.stringify(descriptions)
  ].join('\n');

  const entertainmentSystemPrompt = [
    'You audit pre-generated asset descriptions (JSON) for a film/series entertainment campaign before HTML5 ad code generation.',
    'You receive NO images — only structured descriptions with shows_physical_product, asset_kind, primary_product_name.',
    'Evaluate promotional visual relevance for the film in the style guide — NOT retail packshot rules.',
    'Rules:',
    '- ACCEPT theatrical_poster, key_art, film_still, promotional_photo with shows_physical_product=false — this is normal for film campaigns.',
    '- ACCEPT multiple assets sharing the same primary_product_name (film title) — duplicate film titles are NOT a blocker.',
    '- Do NOT require distinct SKUs, physical merchandise, or packshot variety.',
    '- BLOCKER only for text_only_banner category navigation tiles with no film imagery.',
    '- BLOCKER when assets clearly depict the wrong film installment/franchise opus (e.g. Scary Movie 4 when campaign is Scary Movie 6 / 2026).',
    '- BLOCKER when no asset is a usable promotional visual for the campaign film (no poster, key art, or relevant still).',
    '- WARN (not blocker) when portfolio is only BTS/clapperboard with no poster — suggest poster retry queries.',
    '- WARN only for minor logo issues (logos validated separately by vision audit).',
    'Set satisfied to true when at least one promotional visual matches the campaign and zero blockers exist.',
    'For blockers, suggest Brave queries: site:imdb.com, site:allocine.fr, site:impawards.com + film title + poster/key art.',
    '',
    '--- Style guide JSON ---',
    JSON.stringify(prunedStyleGuide),
    '',
    '--- Asset descriptions JSON ---',
    JSON.stringify(descriptions)
  ].join('\n');

  const experienceSystemPrompt = [
    'You audit pre-generated asset descriptions (JSON) for a theme park / leisure / destination experience campaign before HTML5 ad code generation.',
    'You receive NO images — only structured descriptions with shows_physical_product, asset_kind, primary_product_name.',
    'Evaluate promotional visual relevance for the campaign in the style guide — NOT retail packshot or SKU rules.',
    'Rules:',
    '- ACCEPT attraction_photo, venue_lifestyle, lifestyle_scene, ticket_pass, promotional_photo with shows_physical_product=false — normal for parks and destinations.',
    '- ACCEPT ticket_pass and gift cards with shows_physical_product=true.',
    '- ACCEPT generic primary_product_name (Visite Famille, campaign season name, attraction name).',
    '- Do NOT require distinct SKUs, retail packshots, or physical merchandise variety.',
    '- WARN (not blocker) for mascot_brand assets — secondary accent only.',
    '- BLOCKER only for text_only_banner category navigation tiles with no park/attraction imagery.',
    '- BLOCKER when fewer than 2 usable experience visuals exist (attraction, lifestyle, ticket).',
    '- BLOCKER when assets clearly unrelated to the campaign park/destination in the style guide.',
    '- WARN only for minor logo issues (logos validated separately by vision audit).',
    'Set satisfied to true when at least 2 relevant experience visuals exist and zero blockers.',
    'For blockers, suggest Brave queries: site:{brandURL-host} + attraction names + summer campaign + family park.',
    '',
    '--- Style guide JSON ---',
    JSON.stringify(prunedStyleGuide),
    '',
    '--- Asset descriptions JSON ---',
    JSON.stringify(descriptions)
  ].join('\n');

  const systemPrompt =
    profile === 'entertainment'
      ? entertainmentSystemPrompt
      : profile === 'experience'
        ? experienceSystemPrompt
        : retailSystemPrompt;

  const retailUserContent =
    `Audit round ${String(reviewRound)}. Review the asset descriptions JSON for retail ad suitability. ` +
    'Reject text-only category banners and any off-topic product even if from the official retailer CDN. ' +
    `Pass only when ${String(minValid)}–${String(maxValid)} products/ assets each match the campaign subject. ` +
    'Different named variants are acceptable; only identical primary_product_name across 2+ assets is a duplicate blocker.';

  const entertainmentUserContent =
    `Audit round ${String(reviewRound)}. Review asset descriptions for film promotional suitability. ` +
    'Do NOT apply retail packshot or distinct-SKU rules. ' +
    'Accept posters, key art, and film stills even when shows_physical_product=false. ' +
    'Same film title on all assets is OK. ' +
    'Block only wrong franchise opus, text-only nav tiles, or assets unrelated to the campaign film. ' +
    'Trust deterministic pre-checks — do not invent duplicate-SKU or physical-product blockers.';

  const experienceUserContent =
    `Audit round ${String(reviewRound)}. Review asset descriptions for theme park / destination campaign suitability. ` +
    'Do NOT apply retail packshot, SKU, or shows_physical_product rules for attraction/lifestyle photos. ' +
    'Accept roller coasters, family scenes, passes, and generic visit labels. ' +
    'Block only text-only nav tiles or assets unrelated to the campaign. ' +
    'Trust deterministic pre-checks — do not invent retail-product blockers.';

  const userContent =
    profile === 'entertainment'
      ? entertainmentUserContent
      : profile === 'experience'
        ? experienceUserContent
        : retailUserContent;

  console.log(`[asset-descriptions-audit] Round ${String(reviewRound)} — model ${model} (text-only)`);

  const roundStart = Date.now();
  const { result: msg, duration_ms: apiDurationMs } = await timedAnthropicCall(
    `asset-descriptions-audit round ${String(reviewRound)}`,
    async () =>
      await withAnthropicRetry(`asset-descriptions-audit round ${String(reviewRound)}`, async () => {
        return await options.anthropicClient.messages.parse({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: userContent
            }
          ],
          output_config: {
            format: zodOutputFormat(assetsReviewOutputSchema)
          }
        });
      })
  );
  const stepDurationMs = Date.now() - roundStart;

  const llmParsed = msg.parsed_output;
  if (llmParsed === null) {
    throw new Error('Asset descriptions audit returned no structured output.');
  }

  const audit = mergeAudits(deterministic, llmParsed, profile);
  const blockers = audit.findings.filter((f) => f.severity === 'blocker');
  if (blockers.length > 0) {
    audit.satisfied = false;
  }

  const billedInput =
    msg.usage.input_tokens +
    (msg.usage.cache_creation_input_tokens ?? 0) +
    (msg.usage.cache_read_input_tokens ?? 0);
  const price_usd: PriceUsd = priceUsdFromTokens(billedInput, msg.usage.output_tokens, model);

  const usage: AssetsReviewUsageTotals = {
    api_calls: 1,
    input_tokens: msg.usage.input_tokens,
    output_tokens: msg.usage.output_tokens,
    cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
    model,
    billed_input_tokens: billedInput,
    price_usd,
    duration_ms: stepDurationMs
  };

  console.log(
    `[asset-descriptions-audit] satisfied=${String(audit.satisfied)} blockers=${String(blockers.length)}`
  );
  logAssetsReviewAuditToConsole(audit, reviewRound);
  appendAssetsReviewLog(reviewDir, audit, reviewRound);

  const pipelineEntry = entryFromSingleUsage({
    action: 'assets_review',
    agent: 'lib/asset-descriptions-audit.mts',
    model,
    usage: msg.usage,
    review_round: reviewRound,
    duration_ms: stepDurationMs,
    api_call_timings: [
      {
        call_index: 1,
        duration_ms: apiDurationMs,
        stop_reason: msg.stop_reason,
        label: `asset-descriptions-audit round ${String(reviewRound)}`
      }
    ]
  });
  logPipelineUsageToConsole(appendPipelineUsage(directoryPath, pipelineEntry).entries.at(-1)!);

  return { audit, usage };
}

export function useDescriptionsBasedAssetsReview (): boolean {
  const mode = process.env['CREATIVE_ASSETS_REVIEW_MODE']?.trim().toLowerCase();
  return mode !== 'vision';
}

export type DescriptionsBasedReviewResult = {
  audit: AssetsReviewOutput;
  descriptions: AssetDescriptionsFile | null;
  describeUsage: DescribeApprovedAssetsResult['usage'] | null;
  auditUsage: AssetsReviewUsageTotals;
  logoVisionUsage: AssetsReviewUsageTotals | null;
};

/** Vision describe + deterministic pre-check + text-only Haiku audit (no second image pass). */
export async function runDescriptionsBasedAssetsReview (options: {
  anthropicClient: Anthropic;
  directoryPath: string;
  styleGuide: StyleGuide;
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  reviewRound: number;
  productFileCount: number;
  phase?: 'style_guide' | 'creative';
}): Promise<DescriptionsBasedReviewResult> {
  const describeResult = await describeAssetsForReview({
    anthropicClient: options.anthropicClient,
    directoryPath: options.directoryPath,
    styleGuide: options.styleGuide,
    reviewRound: options.reviewRound,
    phase: options.phase ?? 'style_guide'
  });

  if (describeResult === null) {
    throw new Error('Asset describe step returned null — cannot run descriptions audit.');
  }

  const { audit, usage: auditUsage } = await runAssetDescriptionsAudit({
    anthropicClient: options.anthropicClient,
    directoryPath: options.directoryPath,
    descriptions: describeResult.file,
    prunedStyleGuide: options.prunedStyleGuide,
    reviewRound: options.reviewRound,
    productFileCount: options.productFileCount
  });

  const { audit: logoVisionAudit, usage: logoVisionUsage } = await runLogoVisionAudit({
    anthropicClient: options.anthropicClient,
    directoryPath: options.directoryPath,
    prunedStyleGuide: options.prunedStyleGuide,
    reviewRound: options.reviewRound,
    phase: options.phase ?? 'style_guide'
  });

  const mergedAudit = mergeLogoVisionIntoAudit(audit, logoVisionAudit);

  return {
    audit: mergedAudit,
    descriptions: describeResult.file,
    describeUsage: describeResult.usage,
    auditUsage,
    logoVisionUsage
  };
}
