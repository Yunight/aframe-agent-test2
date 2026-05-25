import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REGEN_WATCH_FILES = [ 'index.html', 'styles.css', 'app.js' ] as const;

export type RegenDiffReport = {
  fileName: string;
  beforeLines: number;
  afterLines: number;
  changedLines: number;
  changeRatio: number;
};

export type RegenDiffSummary = {
  reports: RegenDiffReport[];
  maxChangeRatio: number;
  likelyFullRewrite: boolean;
};

function lineChangeCount (before: string, after: string): number {
  const a = before.split('\n');
  const b = after.split('\n');
  const max = Math.max(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? '') !== (b[i] ?? '')) {
      changed += 1;
    }
  }
  return changed;
}

function parseMaxChangeRatio (): number {
  const raw = process.env['CREATIVE_REGEN_DIFF_MAX_RATIO']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 0.5;
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.5;
}

export function isRegenDiffGuardEnabled (): boolean {
  return process.env['CREATIVE_REGEN_DIFF_GUARD']?.trim() !== '0';
}

/** Compare code/ files before vs after regen (snapshots must exist under review/). */
export function summarizeRegenDiff (
  codeDirectoryPath: string,
  beforeSnapshots: Readonly<Record<string, string>>
): RegenDiffSummary {
  const reports: RegenDiffReport[] = [];

  for (const fileName of REGEN_WATCH_FILES) {
    const before = beforeSnapshots[fileName];
    if (before === undefined) {
      continue;
    }
    const afterPath = join(codeDirectoryPath, fileName);
    let after: string;
    try {
      after = readFileSync(afterPath, { encoding: 'utf8' });
    } catch {
      continue;
    }
    const beforeLines = before.split('\n').length;
    const afterLines = after.split('\n').length;
    const changedLines = lineChangeCount(before, after);
    const denom = Math.max(beforeLines, afterLines, 1);
    reports.push({
      fileName,
      beforeLines,
      afterLines,
      changedLines,
      changeRatio: changedLines / denom
    });
  }

  const maxChangeRatio = reports.reduce((m, r) => Math.max(m, r.changeRatio), 0);
  const threshold = parseMaxChangeRatio();
  return {
    reports,
    maxChangeRatio,
    likelyFullRewrite: reports.length > 0 && maxChangeRatio > threshold
  };
}

export function snapshotCodeBundleForDiff (codeDirectoryPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const fileName of REGEN_WATCH_FILES) {
    try {
      out[fileName] = readFileSync(join(codeDirectoryPath, fileName), { encoding: 'utf8' });
    } catch {
      // skip missing
    }
  }
  return out;
}

export function logRegenDiffSummary (summary: RegenDiffSummary): void {
  if (summary.reports.length === 0) {
    return;
  }
  for (const r of summary.reports) {
    console.log(
      `[regen-diff] ${r.fileName}: ${String(Math.round(r.changeRatio * 100))}% lines changed `
        + `(${String(r.changedLines)}/${String(Math.max(r.beforeLines, r.afterLines))})`
    );
  }
  if (summary.likelyFullRewrite) {
    console.warn(
      `[regen-diff] Likely full rewrite (max ratio ${String(Math.round(summary.maxChangeRatio * 100))}% > threshold). `
        + 'Consider CREATIVE_REGEN_MODEL=claude-sonnet-4-6 or narrower UI review fix_hints.'
    );
  }
}
