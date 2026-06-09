function isRemoteOrDataRef (ref: string): boolean {
  const t = ref.trim();
  return t.startsWith('data:') || /^https?:\/\//iu.test(t);
}

export function isLocalAssetRef (ref: string): boolean {
  const t = ref.trim();
  return t.length > 0 && !isRemoteOrDataRef(t);
}

/** Nom de fichier plat pour un chemin local `./foo.png` (assets à la racine du bundle). */
export function normalizeLocalAssetFileName (ref: string): string {
  const trimmed = ref.trim().replace(/^\.\//u, '');
  const segments = trimmed.split(/[/\\]/u);
  return segments[segments.length - 1] ?? trimmed;
}

export function collectLocalAssetRefsFromSource (parts: {
  html?: string;
  css?: string;
  js?: string;
  imageUrls?: string[];
}): string[] {
  const seen = new Set<string>();
  const add = (ref: string | undefined): void => {
    if (ref !== undefined && isLocalAssetRef(ref)) {
      seen.add(ref);
    }
  };
  for (const u of parts.imageUrls ?? []) {
    add(u);
  }
  const html = parts.html ?? '';
  for (const m of html.matchAll(/\bsrc=["']([^"']+)["']/giu)) {
    add(m[1]);
  }
  for (const m of html.matchAll(/background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    add(m[1]);
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    add(m[1]);
  }
  const css = parts.css ?? '';
  const js = parts.js ?? '';
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    add(m[1]);
  }
  for (const m of js.matchAll(/["'](\.\/[^"']+)["']/giu)) {
    add(m[1]);
  }
  return [ ...seen ];
}
