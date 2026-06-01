export function hostnameFromAssetUrl (url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** After `threshold` download failures on a hostname, skip further URLs on that host. */
export class AssetHostFailureTracker {
  private readonly failures = new Map<string, number>();
  private readonly blocked = new Set<string>();
  private readonly threshold: number;

  constructor (threshold: number = 2) {
    this.threshold = threshold;
  }

  isBlocked (url: string): boolean {
    const host = hostnameFromAssetUrl(url);
    return host !== null && this.blocked.has(host);
  }

  /** Returns true when the host just became blocked. */
  recordFailure (url: string): boolean {
    const host = hostnameFromAssetUrl(url);
    if (host === null) {
      return false;
    }
    const next = (this.failures.get(host) ?? 0) + 1;
    this.failures.set(host, next);
    if (next >= this.threshold && !this.blocked.has(host)) {
      this.blocked.add(host);
      return true;
    }
    return false;
  }

  blockedHostForLog (): string | null {
    const first = this.blocked.values().next().value;
    return first ?? null;
  }
}
