export const OFFICIAL_SCRAPE_USER_AGENT =
  'Mozilla/5.0 (compatible; AframeCreativeAssetBot/1.0; +https://github.com/)';

export function officialPageFetchHeaders (): Record<string, string> {
  return {
    Accept: 'text/html,application/xhtml+xml',
    'User-Agent': OFFICIAL_SCRAPE_USER_AGENT
  };
}

export function officialImageFetchHeaders (): Record<string, string> {
  return {
    Accept: 'image/*,*/*;q=0.8',
    'User-Agent': OFFICIAL_SCRAPE_USER_AGENT
  };
}

/** HEAD statuses where many CDNs still allow a small GET for content-type. */
export function shouldRetryImageMetadataWithGet (status: number): boolean {
  return status === 401 || status === 403 || status === 405;
}
