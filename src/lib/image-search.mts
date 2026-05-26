import type { ImageSearchProviderId, ImageSearchRow } from './image-search-types.mts';

export type { ImageSearchProviderId, ImageSearchRow } from './image-search-types.mts';

export function resolveImageSearchProvider (override?: string): ImageSearchProviderId {
  const raw = (override ?? process.env['CREATIVE_IMAGE_SEARCH_PROVIDER'] ?? 'brave').trim().toLowerCase();
  if (raw === 'brave' || raw === 'anthropic') {
    return raw;
  }
  throw new Error(
    `Invalid CREATIVE_IMAGE_SEARCH_PROVIDER "${raw}". Allowed values: brave, anthropic.`
  );
}

export function imageSearchLogPrefix (provider?: ImageSearchProviderId): string {
  const p = provider ?? resolveImageSearchProvider();
  return p === 'brave' ? '[Brave images]' : '[Anthropic images]';
}

export function assertImageSearchProviderConfigured (provider?: ImageSearchProviderId): void {
  const p = provider ?? resolveImageSearchProvider();
  const anthropicKey = process.env['ANTHROPIC_API_KEY']?.trim();
  if (anthropicKey === undefined || anthropicKey.length === 0) {
    throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
  }
  if (p === 'brave') {
    const braveKey = process.env['BRAVE_API_KEY']?.trim();
    if (braveKey === undefined || braveKey.length === 0) {
      throw new Error(
        'Missing BRAVE_API_KEY for Brave image search. Set CREATIVE_IMAGE_SEARCH_PROVIDER=anthropic to use Claude web_search instead.'
      );
    }
  }
}

export async function imageSearch (params: {
  query: string;
  num?: number;
  assetKind?: 'logo' | 'product';
  officialHosts?: readonly string[];
  provider?: ImageSearchProviderId;
}): Promise<ImageSearchRow[]> {
  const provider = params.provider ?? resolveImageSearchProvider();
  const num = params.num ?? 10;

  if (provider === 'brave') {
    const { braveImageSearch } = await import('./brave-image-assets.mts');
    const rows = await braveImageSearch({ query: params.query, num });
    return rows.map((row) => ({
      url: row.url,
      title: row.title ?? '',
      source: row.source ?? '',
      page_fetched: row.page_fetched,
      thumbnail: row.thumbnail,
      properties: row.properties
    }));
  }

  const { anthropicImageSearch } = await import('./anthropic-image-search.mts');
  return anthropicImageSearch({
    query: params.query,
    num,
    assetKind: params.assetKind ?? 'product',
    officialHosts: params.officialHosts ?? []
  });
}
