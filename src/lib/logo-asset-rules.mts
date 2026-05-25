/**
 * Heuristics: logos/ should contain brand wordmarks only, not product packshots.
 */

export function isOfficialLogoSvgUrl (url: string): boolean {
  return /\.svg($|[?#])/iu.test(url.trim());
}

export function officialUrlsIncludeSvg (urls: readonly string[]): boolean {
  return urls.some((u) => isOfficialLogoSvgUrl(u));
}

/** True when filename looks like a product SKU / packshot misplaced in logos/. */
export function looksLikeProductPackshotInLogosFolder (fileName: string): boolean {
  const base = fileName.replace(/\\/gu, '/').split('/').pop() ?? fileName;
  const lower = base.toLowerCase();

  if (lower.endsWith('.svg')) {
    return false;
  }

  if (/logo|wordmark|marque|brand|lockup|sigle/iu.test(lower)) {
    return false;
  }

  if (/packshot|product|prod_|_prod|catalogue|thumb|sku/iu.test(lower)) {
    return true;
  }

  // Fashion e-commerce refs: A04P501D.jpg, 5093200.jpg
  if (/^[a-z]?\d{2,}[a-z0-9]*\.(jpe?g|png|webp|gif)$/iu.test(lower)) {
    return true;
  }

  if (/^[a-z]{1,3}\d{3,}[a-z]?\d*\.(jpe?g|png|webp)$/iu.test(lower)) {
    return true;
  }

  return false;
}
