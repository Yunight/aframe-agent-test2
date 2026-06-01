import { resolveRemoteImageMetadata } from './brave-image-assets.mts';
import type { ImageSearchContext } from './brave-image-assets.mts';
import {
  extractLogoCandidatesFromHtml,
  extractProductCandidatesFromHtml,
  fetchOfficialPageHtml,
  hostsFromImageContext,
  isCrawlBlockedHttpStatus
} from './official-site-logo-extract.mts';
import { preflightCampaignReferenceUrl } from './style-guide-urls.mts';

const STUDIO_PREFLIGHT_BUDGET_MS = 28_000;
const IMAGE_PROBE_TIMEOUT_MS = 8_000;

export type ReferencePreflightStatus =
  | 'ok'
  | 'warning'
  | 'blocked'
  | 'unreachable'
  | 'invalid';

export type ReferencePreflightResult = {
  status: ReferencePreflightStatus;
  normalizedUrl: string;
  pageStatus: number | null;
  message: string;
  details?: {
    productProbeOk: boolean;
    logoProbeOk: boolean;
    candidateCount: number;
  };
};

function probeErrorIsBlocked (err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const statusMatch =
    /HEAD request failed with status (\d{3})/iu.exec(err.message) ??
    /failed with status[:\s]+(\d{3})/iu.exec(err.message);
  if (statusMatch !== null && statusMatch[1] !== undefined) {
    return isCrawlBlockedHttpStatus(Number.parseInt(statusMatch[1], 10));
  }
  return false;
}

async function probeImageUrl (url: string): Promise<{ ok: boolean; blocked: boolean }> {
  try {
    await Promise.race([
      resolveRemoteImageMetadata(url),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new Error('Image probe timed out'));
        }, IMAGE_PROBE_TIMEOUT_MS);
      })
    ]);
    return { ok: true, blocked: false };
  } catch (err: unknown) {
    return { ok: false, blocked: probeErrorIsBlocked(err) };
  }
}

async function withStudioPreflightBudget<T> (work: () => Promise<T>): Promise<T> {
  return Promise.race([
    work(),
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('STUDIO_PREFLIGHT_TIMEOUT'));
      }, STUDIO_PREFLIGHT_BUDGET_MS);
    })
  ]);
}

/**
 * Studio / API check before launching style-guide: page reachability + sample asset probes.
 */
export async function preflightReferenceUrlForStudio (
  rawUrl: string
): Promise<ReferencePreflightResult> {
  try {
    return await withStudioPreflightBudget(() => preflightReferenceUrlForStudioInner(rawUrl));
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'STUDIO_PREFLIGHT_TIMEOUT') {
      return {
        status: 'warning',
        normalizedUrl: rawUrl.trim(),
        pageStatus: null,
        message:
          'Délai dépassé lors de la vérification (site lent ou anti-bot). ' +
          'Vous pouvez lancer la génération — le pipeline tentera le crawl complet.'
      };
    }
    throw err;
  }
}

async function preflightReferenceUrlForStudioInner (
  rawUrl: string
): Promise<ReferencePreflightResult> {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return {
      status: 'invalid',
      normalizedUrl: trimmed,
      pageStatus: null,
      message: 'URL vide.'
    };
  }
  try {
    new URL(trimmed);
  } catch {
    return {
      status: 'invalid',
      normalizedUrl: trimmed,
      pageStatus: null,
      message: 'URL invalide.'
    };
  }

  const page = await preflightCampaignReferenceUrl(trimmed);
  if (page.timedOut) {
    return {
      status: 'warning',
      normalizedUrl: page.normalizedUrl,
      pageStatus: null,
      message:
        'Connexion au site trop lente (timeout, fréquent sur Uniqlo). ' +
        'Vous pouvez lancer la génération — le crawl complet sera tenté au lancement.'
    };
  }
  if (page.blocked) {
    return {
      status: 'blocked',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        `Ce site bloque l'accès automatique (HTTP ${String(page.status)}). ` +
        'Choisissez une autre URL de référence (autre domaine ou page produit).'
    };
  }
  if (!page.reachable) {
    return {
      status: 'unreachable',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        page.status === null
          ? "Impossible de joindre cette URL (réseau ou pare-feu). Vérifiez l'adresse."
          : `URL inaccessible (HTTP ${String(page.status)}). Vérifiez l'adresse.`
    };
  }

  const ctx: ImageSearchContext = {
    brandName: '',
    companyName: '',
    productName: '',
    brandURL: page.normalizedUrl,
    campaignReferenceUrl: page.normalizedUrl
  };
  const hosts = hostsFromImageContext(ctx);
  const { html, blocked, status } = await fetchOfficialPageHtml(
    page.normalizedUrl,
    'preflight-reference'
  );

  if (blocked) {
    return {
      status: 'blocked',
      normalizedUrl: page.normalizedUrl,
      pageStatus: status,
      message:
        `La page répond mais bloque le crawl (HTTP ${String(status)}). Utilisez une autre URL.`
    };
  }
  if (html === null || html.length < 200) {
    return {
      status: 'unreachable',
      normalizedUrl: page.normalizedUrl,
      pageStatus: status,
      message:
        'Page atteinte mais contenu HTML insuffisant pour extraire des visuels. Essayez une page produit plus détaillée.'
    };
  }

  const products = extractProductCandidatesFromHtml(html, page.normalizedUrl, hosts);
  const logos = extractLogoCandidatesFromHtml(html, page.normalizedUrl, hosts);
  const topProduct = products[0]?.url;
  const topLogo = logos[0]?.url;

  let productProbeOk = false;
  let logoProbeOk = false;
  let anyProbeBlocked = false;

  if (topProduct !== undefined) {
    const probe = await probeImageUrl(topProduct);
    productProbeOk = probe.ok;
    anyProbeBlocked = anyProbeBlocked || probe.blocked;
  }
  if (topLogo !== undefined) {
    const probe = await probeImageUrl(topLogo);
    logoProbeOk = probe.ok;
    anyProbeBlocked = anyProbeBlocked || probe.blocked;
  }

  const candidateCount = products.length + logos.length;
  const details = { productProbeOk, logoProbeOk, candidateCount };

  if (candidateCount === 0) {
    return {
      status: 'warning',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        "Page accessible mais aucune image produit/logo détectée. La génération utilisera surtout la recherche d'images.",
      details
    };
  }

  if (!productProbeOk && !logoProbeOk && anyProbeBlocked) {
    return {
      status: 'blocked',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        "Les ressources images de cette page sont bloquées pour le téléchargement automatique. Changez d'URL ou utilisez un site miroir.",
      details
    };
  }

  if (!productProbeOk && !logoProbeOk) {
    return {
      status: 'warning',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        'Page accessible mais les images officielles ne sont pas téléchargeables. Wikipedia / Brave seront utilisés.',
      details
    };
  }

  if (productProbeOk && !logoProbeOk) {
    return {
      status: 'warning',
      normalizedUrl: page.normalizedUrl,
      pageStatus: page.status,
      message:
        'Produits OK sur cette page ; logo officiel peut nécessiter Wikipedia / Brave.',
      details
    };
  }

  return {
    status: 'ok',
    normalizedUrl: page.normalizedUrl,
    pageStatus: page.status,
    message: 'URL de référence accessible ; ressources images utilisables.',
    details
  };
}
