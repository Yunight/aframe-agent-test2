import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_FILES = [ 'index.html', 'styles.css', 'app.js' ] as const;

export type CodeBundleFile = {
  fileName: (typeof ROOT_FILES)[number];
  fileContent: string;
  truncated: boolean;
};

export type ExistingCodeBundle = {
  files: CodeBundleFile[];
};

function regenMaxFileChars (): number {
  const raw = process.env['CREATIVE_REGEN_MAX_FILE_CHARS']?.trim();
  if (raw === undefined || raw.length === 0) {
    return 80_000;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 1000 ? n : 80_000;
}

function truncateContent (content: string, maxChars: number): { text: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { text: content, truncated: false };
  }
  return {
    text: `${content.slice(0, maxChars)}\n\n/* … truncated for prompt (${String(content.length)} chars total) */`,
    truncated: true
  };
}

/** Load index.html, styles.css, app.js from code/ for corrective regen. */
export function loadExistingCodeBundle (codeDirectoryPath: string): ExistingCodeBundle {
  const maxChars = regenMaxFileChars();
  const files: CodeBundleFile[] = [];

  for (const fileName of ROOT_FILES) {
    const filePath = join(codeDirectoryPath, fileName);
    if (!existsSync(filePath)) {
      throw new Error(
        `Regeneration requires existing ${fileName} at ${filePath}. Run initial generation first.`
      );
    }
    const raw = readFileSync(filePath, { encoding: 'utf8' });
    const { text, truncated } = truncateContent(raw, maxChars);
    files.push({ fileName, fileContent: text, truncated });
  }

  return { files };
}

/** Format bundle for injection into the regen user message. */
export function formatExistingBundleForPrompt (bundle: ExistingCodeBundle): string {
  const anyTruncated = bundle.files.some((f) => f.truncated);
  const header =
    '--- EXISTING CODE BUNDLE (patch this; do NOT replace with a new design or layout) ---' +
    (anyTruncated ? '\n(Some files were truncated for context limits; preserve structure and fix blockers.)' : '');

  const sections = bundle.files.map(
    (f) => `### ${f.fileName}\n\`\`\`\n${f.fileContent}\n\`\`\``
  );

  return `${header}\n\n${sections.join('\n\n')}`;
}
