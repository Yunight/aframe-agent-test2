import { AssetHostFailureTracker } from './asset-host-fail-fast.mts';
import type { ImageSearchContext } from './brave-image-assets.mts';
import {
  clearAssetSubdirectory,
  downloadUrlsToAssetFolder,
  officialHostsFromContext,
  collectAndDownloadValidAssetUrls,
  braveLogoCandidatePool
} from './brave-image-assets.mts';
import { extractOfficialSiteLogoUrls, extractWikipediaLogoUrls } from './official-site-logo-extract.mts';
import { resolveImageSearchProvider } from './image-search.mts';
import { enforceSingleCanonicalLogo, CANONICAL_LOGO_COUNT } from './logo-asset-rules.mts';
import { pruneInvalidLogos, pruneNonWordmarkLogos } from './creative-native-assets-deterministic.mts';
import { listAssetImageFiles } from './asset-sidecar-files.mts';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

export type CollectSingleLogoResult = {
  downloadedUrls: string[];
  count: number;
  rejectedUrls: string[];
  source: 'official' | 'wikipedia' | 'brave' | null;
};

function countLogoFiles (directoryPath: string): number {
  const logosDir = join(directoryPath, 'logos');
  if (!existsSync(logosDir)) {
    return 0;
  }
  return listAssetImageFiles(directoryPath, 'logos').length;
}

async function tryLogoUrl (
  directoryPath: string,
  fileUrl: string,
  urlBySavedFile: Map<string, string>,
  rejectedUrls: string[]
): Promise<boolean> {
  const batch = await downloadUrlsToAssetFolder('logos', directoryPath, [ fileUrl ], {
    validateDimensions: true,
    rejectedUrls
  });
  if (batch.count === 0) {
    return false;
  }
  for (const name of listAssetImageFiles(directoryPath, 'logos')) {
    if (!urlBySavedFile.has(name)) {
      urlBySavedFile.set(name, fileUrl);
    }
  }
  return true;
}

/**
 * Acquire exactly one logo: transparent PNG/WebP (alpha) or SVG.
 * Sources in order: brand official site → Wikipedia/Wikimedia → Brave image search.
 */
export async function collectSingleTransparentLogo (
  directoryPath: string,
  context: ImageSearchContext,
  braveQueries: readonly string[],
  options?: { excludeUrls?: Set<string> }
): Promise<CollectSingleLogoResult> {
  const rejectedUrls: string[] = [];
  const excludeUrls = new Set(options?.excludeUrls ?? []);
  const urlBySavedFile = new Map<string, string>();
  let source: CollectSingleLogoResult['source'] = null;

  clearAssetSubdirectory(join(directoryPath, 'logos'));

  const officialHosts = officialHostsFromContext(context);
  const officialUrls = await extractOfficialSiteLogoUrls(context);
  console.log(
    `[logo] Phase 1 — official site (${String(officialUrls.length)} candidate URL(s))…`
  );
  const officialHostTracker = new AssetHostFailureTracker(2);
  for (const fileUrl of officialUrls) {
    if (countLogoFiles(directoryPath) >= CANONICAL_LOGO_COUNT) {
      break;
    }
    if (excludeUrls.has(fileUrl)) {
      continue;
    }
    if (officialHostTracker.isBlocked(fileUrl)) {
      continue;
    }
    const ok = await tryLogoUrl(directoryPath, fileUrl, urlBySavedFile, rejectedUrls);
    if (ok) {
      source = 'official';
      console.log(`[logo] Official site logo saved: ${fileUrl}`);
      break;
    }
    excludeUrls.add(fileUrl);
    rejectedUrls.push(fileUrl);
    if (officialHostTracker.recordFailure(fileUrl)) {
      const host = officialHostTracker.blockedHostForLog();
      console.log(
        `[logo] Skipping remaining official URLs on ${host ?? 'host'} (downloads blocked)`
      );
      break;
    }
  }

  if (countLogoFiles(directoryPath) < CANONICAL_LOGO_COUNT) {
    const wikiUrls = await extractWikipediaLogoUrls(context);
    console.log(
      `[logo] Phase 2 — Wikipedia / Wikimedia (${String(wikiUrls.length)} candidate URL(s))…`
    );
    const wikiHostTracker = new AssetHostFailureTracker(2);
    for (const fileUrl of wikiUrls) {
      if (countLogoFiles(directoryPath) >= CANONICAL_LOGO_COUNT) {
        break;
      }
      if (excludeUrls.has(fileUrl)) {
        continue;
      }
      if (wikiHostTracker.isBlocked(fileUrl)) {
        continue;
      }
      const ok = await tryLogoUrl(directoryPath, fileUrl, urlBySavedFile, rejectedUrls);
      if (ok) {
        source = 'wikipedia';
        console.log(`[logo] Wikipedia logo saved: ${fileUrl}`);
        break;
      }
      excludeUrls.add(fileUrl);
      rejectedUrls.push(fileUrl);
      if (wikiHostTracker.recordFailure(fileUrl)) {
        break;
      }
    }
  }

  if (countLogoFiles(directoryPath) < CANONICAL_LOGO_COUNT && braveQueries.length > 0) {
    console.log(`[logo] Phase 3 — image search (provider=${resolveImageSearchProvider()})…`);
    const brave = await collectAndDownloadValidAssetUrls('logos', directoryPath, braveQueries, {
      targetCount: CANONICAL_LOGO_COUNT,
      candidatePool: braveLogoCandidatePool(),
      excludeUrls,
      clearFolder: false,
      officialHosts,
      prioritizeUrls: [],
      logoScoring: {
        productName: context.productName,
        companyName: context.companyName,
        brandName: context.brandName
      }
    });
    rejectedUrls.push(...brave.rejectedUrls);
    if (brave.count > 0) {
      source = 'brave';
      for (const fileUrl of brave.downloadedUrls) {
        for (const name of listAssetImageFiles(directoryPath, 'logos')) {
          if (!urlBySavedFile.has(name)) {
            urlBySavedFile.set(name, fileUrl);
          }
        }
      }
    }
  }

  await pruneNonWordmarkLogos(directoryPath);
  await pruneInvalidLogos(directoryPath);
  const { kept, removed } = await enforceSingleCanonicalLogo(directoryPath);
  if (removed.length > 0) {
    console.log(`[logo] Canonical logo kept: ${kept ?? 'none'} (removed ${String(removed.length)} extra file(s))`);
  }

  let downloadedUrls: string[] = [];
  if (kept !== null) {
    const keptUrl = urlBySavedFile.get(basename(kept)) ?? urlBySavedFile.get(kept);
    if (keptUrl !== undefined) {
      downloadedUrls = [ keptUrl ];
    }
  }

  return {
    downloadedUrls,
    count: downloadedUrls.length,
    rejectedUrls,
    source
  };
}
