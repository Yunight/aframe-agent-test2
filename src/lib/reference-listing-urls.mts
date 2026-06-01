/** Reference / listing page URL matching (shared by scrape boost and asset provenance). */

export type ReferenceListingFields = {
  campaignReferenceUrl?: string | null;
  campaignUrls?: readonly string[];
};

export function pageUrlsMatchForBoost (referenceRaw: string, fetchedPageUrl: string): boolean {
  try {
    const ref = new URL(referenceRaw.trim());
    const page = new URL(fetchedPageUrl);
    if (ref.origin !== page.origin) {
      return false;
    }
    const refPath = ref.pathname.replace(/\/+$/u, '') || '/';
    const pagePath = page.pathname.replace(/\/+$/u, '') || '/';
    return refPath === pagePath;
  } catch {
    return false;
  }
}

export function resolveReferenceListingUrls (fields: ReferenceListingFields): string[] {
  const urls: string[] = [];
  const ref = fields.campaignReferenceUrl?.trim() ?? '';
  if (ref.length > 0) {
    urls.push(ref);
  }
  for (const raw of fields.campaignUrls ?? []) {
    const u = raw.trim();
    if (u.length > 0) {
      urls.push(u);
    }
  }
  return [ ...new Set(urls) ];
}
