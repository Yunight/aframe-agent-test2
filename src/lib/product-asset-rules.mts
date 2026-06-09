/**
 * Download-only heuristics: filter category nav tile URLs before scrape/download.
 * Not used for final asset validation — that relies on describe + descriptions audit.
 */

/** True when URL or filename looks like a text-only category/menu tile (e.g. Shopify MENU_vp_*). */
export function isTextOnlyCategoryNavProductAsset (urlOrFileName: string): boolean {
  const lower = urlOrFileName.toLowerCase();
  if (/menu[_-]?vp/iu.test(lower)) {
    return true;
  }
  if (/menu[_-]?coffret/iu.test(lower)) {
    return true;
  }
  if (/menu[_-]?gamme/iu.test(lower)) {
    return true;
  }
  if (/menu[_-]?access/iu.test(lower)) {
    return true;
  }
  if (/\/menu[_-]/iu.test(lower) && /banner|tile|nav|category/iu.test(lower)) {
    return true;
  }
  return false;
}
