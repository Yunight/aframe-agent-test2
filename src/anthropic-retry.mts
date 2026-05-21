/**
 * Retry avec backoff pour erreurs Anthropic transitoires (overloaded, 529, 503).
 */

export function isRetriableAnthropicError (err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const o = err as {
    type?: string;
    status?: number;
    message?: string;
    error?: { type?: string; error?: { type?: string; message?: string } };
  };

  if (o.type === 'overloaded_error' || o.type === 'rate_limit_error') {
    return true;
  }

  const status = o.status;
  if (status === 529 || status === 503 || status === 502) {
    return true;
  }

  const nestedType = o.error?.type ?? o.error?.error?.type;
  if (nestedType === 'overloaded_error' || nestedType === 'rate_limit_error') {
    return true;
  }

  const msg = `${o.message ?? ''} ${o.error?.error?.message ?? ''}`.toLowerCase();
  if (msg.includes('overloaded') || msg.includes('rate limit')) {
    return true;
  }

  return false;
}

function parseRetryIntEnv (name: string, fallback: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(n, max);
}

function retryDelayMs (attempt: number, baseDelayMs: number): number {
  const exp = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 1500);
  return Math.min(exp + jitter, 120_000);
}

export async function withAnthropicRetry<T> (
  label: string,
  fn: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number }
): Promise<T> {
  const maxAttempts =
    options?.maxAttempts ?? parseRetryIntEnv('ANTHROPIC_RETRY_MAX_ATTEMPTS', 6, 12);
  const baseDelayMs =
    options?.baseDelayMs ?? parseRetryIntEnv('ANTHROPIC_RETRY_BASE_DELAY_MS', 8000, 60_000);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetriableAnthropicError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const waitMs = retryDelayMs(attempt, baseDelayMs);
      console.warn(
        `[anthropic-retry] ${label}: API temporairement surchargée (tentative ${String(attempt)}/${String(maxAttempts)}), nouvelle tentative dans ${String(Math.round(waitMs / 1000))}s…`
      );
      await new Promise((resolve) => {
        setTimeout(resolve, waitMs);
      });
    }
  }
  throw lastErr;
}
