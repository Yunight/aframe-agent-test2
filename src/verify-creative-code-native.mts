/**
 * Vérifie la sortie creative-native déjà écrite sous output/<uuid>/code (mêmes règles déterministes
 * que gen-creative-code-native.mts). Option --llm : audit qualitatif via les SKILL.md (.claude/.skills).
 *
 * Usage : node src/verify-creative-code-native.mts <directory-uuid> [--llm]
 * Env : ANTHROPIC_API_KEY (si --llm), VERIFY_CREATIVE_MODEL (défaut claude-sonnet-4-20250514),
 *       CREATIVE_AD_FORMATS (identique à la génération).
 */

import type { StyleGuide } from './gen-style-guide.mjs';
import {
  contains,
  designSkillFiles,
  loadDesignSkillGuidance,
  validateCreativeSkillCompliance,
  type AssetFile,
  type CreativeNativeCodeFileList
} from './creative-native-skills.mts';
import { buildCreativeAdFormatInstructions, loadAdFormatPresets, parseCreativeAdFormatsFromEnv } from './studio-ad-formats.mts';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { z } from 'zod';

const MAX_FILE_CHARS_FOR_LLM = 120_000;

const skillFindingSchema = z.object({
  skill_path: z.string(),
  status: z.enum([ 'pass', 'warn', 'fail' ]),
  notes: z.string()
});

const llmVerifyOutputSchema = z.object({
  overall_ok: z.boolean(),
  skill_findings: z.array(skillFindingSchema),
  summary: z.string()
});

function isProbablyBinaryExtension (leaf: string): boolean {
  const ext = extname(leaf).toLowerCase();
  return contains(
    [ '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.pdf' ] as const,
    ext
  );
}

function listAssetFiles (directoryPath: string, fileType: 'logos' | 'products'): AssetFile[] {
  const subdirectoryPath = join(directoryPath, fileType);
  if (!existsSync(subdirectoryPath)) {
    return [];
  }
  const out: AssetFile[] = [];
  for (const fileName of readdirSync(subdirectoryPath)) {
    if (fileName.startsWith('.')) {
      continue;
    }
    const filePath = join(subdirectoryPath, fileName);
    if (!statSync(filePath).isFile()) {
      continue;
    }
    out.push({ fileName, filePath, fileType });
  }
  return out;
}

function collectCodeFilesForValidation (
  codeDir: string,
  copiedAssetBasenames: ReadonlySet<string>
): CreativeNativeCodeFileList {
  const files: CreativeNativeCodeFileList = [];

  function walk (absoluteDir: string, relativePrefix: string): void {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const name = entry.name;
      if (name.startsWith('.')) {
        continue;
      }
      const abs = join(absoluteDir, name);
      const rel = relativePrefix.length === 0 ? name : `${relativePrefix}/${name}`;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (copiedAssetBasenames.has(name.toLowerCase())) {
        continue;
      }
      if (isProbablyBinaryExtension(name)) {
        continue;
      }
      const fileContent = readFileSync(abs, 'utf8');
      files.push({ fileName: rel.replace(/\\/g, '/'), fileContent });
    }
  }

  walk(codeDir, '');
  return files;
}

function truncateForLlm (relativePath: string, content: string): string {
  if (content.length <= MAX_FILE_CHARS_FOR_LLM) {
    return `--- ${relativePath} ---\n${content}`;
  }
  return (
    `--- ${relativePath} (tronqué à ${String(MAX_FILE_CHARS_FOR_LLM)} caractères) ---\n` +
    `${content.slice(0, MAX_FILE_CHARS_FOR_LLM)}\n… [fin du fichier omise]`
  );
}

loadDotenv({ path: join(import.meta.dirname, '..', '.env') });

const directoryUuid = process.argv[2];
if (directoryUuid === undefined || directoryUuid.startsWith('--')) {
  console.error('Usage: node src/verify-creative-code-native.mts <directory-uuid> [--llm]');
  process.exit(2);
}

let runLlm = false;
for (const arg of process.argv.slice(3)) {
  if (arg === '--llm') {
    runLlm = true;
    continue;
  }
  console.error(`Unknown argument "${arg}". Allowed: --llm`);
  process.exit(2);
}

const repoRoot = join(import.meta.dirname, '..');
const directoryPath = join(repoRoot, 'output', directoryUuid);
const codeDirectoryPath = join(directoryPath, 'code');
const styleGuidePath = join(directoryPath, 'style-guide.json');

if (!existsSync(styleGuidePath)) {
  console.error(`Missing style guide: ${styleGuidePath}`);
  process.exit(2);
}
if (!existsSync(codeDirectoryPath)) {
  console.error(`Missing code directory: ${codeDirectoryPath}`);
  process.exit(2);
}

const styleGuide = JSON.parse(readFileSync(styleGuidePath, { encoding: 'utf8' })) as StyleGuide;

const prunedStyleGuide = JSON.parse(JSON.stringify(styleGuide)) as Omit<
StyleGuide,
'logoFileUrls' | 'productPictureUrls'
>;

const assetFiles: AssetFile[] = [
  ...listAssetFiles(directoryPath, 'logos'),
  ...listAssetFiles(directoryPath, 'products')
];
const copiedAssetBasenames = new Set(assetFiles.map((a) => a.fileName.toLowerCase()));

const codeFiles = collectCodeFilesForValidation(codeDirectoryPath, copiedAssetBasenames);
const deterministic = validateCreativeSkillCompliance(codeFiles, prunedStyleGuide, assetFiles);

type VerifyReport = {
  directoryUuid: string;
  deterministic_ok: boolean;
  deterministic_issues: string[];
  code_file_count: number;
  llm_audit?: z.infer<typeof llmVerifyOutputSchema>;
  llm_model?: string;
};

const report: VerifyReport = {
  directoryUuid,
  deterministic_ok: deterministic.ok,
  deterministic_issues: deterministic.ok ? [] : deterministic.issues,
  code_file_count: codeFiles.length
};

if (runLlm) {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    console.error('Missing ANTHROPIC_API_KEY (required with --llm).');
    process.exit(2);
  }

  const model = process.env['VERIFY_CREATIVE_MODEL']?.trim() || 'claude-opus-4-7';
  const adFormatPresets = loadAdFormatPresets(repoRoot);
  const adFormats = parseCreativeAdFormatsFromEnv(process.env['CREATIVE_AD_FORMATS'], adFormatPresets);
  const skillGuidance = loadDesignSkillGuidance(repoRoot);
  const expectedSkillPaths = [ ...designSkillFiles ];

  const userCodeBundle = codeFiles
    .map((f) => truncateForLlm(f.fileName, f.fileContent))
    .join('\n\n');

  const systemPrompt = [
    'You are a strict design and implementation auditor for static HTML/CSS/JS advertisement creatives.',
    'You receive: (1) mandatory local design skills as markdown, (2) ad format requirements, (3) a pruned JSON style guide, (4) generated source files.',
    'Evaluate qualitative compliance with EACH skill document. Deterministic checks may already have passed; still report skill-level pass/warn/fail honestly.',
    `You MUST output skill_findings with exactly one object per skill path, in this order, with skill_path equal to the string exactly as listed:\n${expectedSkillPaths.map((p) => `- ${p}`).join('\n')}`,
    'overall_ok must be true only if there are no fail statuses and at most minor warns.',
    '',
    '--- Ad format requirements ---',
    buildCreativeAdFormatInstructions(adFormats),
    '',
    '--- Pruned style guide JSON ---',
    JSON.stringify(prunedStyleGuide),
    '',
    '--- Local design skills (mandatory) ---',
    skillGuidance
  ].join('\n');

  const client = new Anthropic({ apiKey: apiKey });
  const msg = await client.messages.parse({
    model,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Audit the following generated files. Respond with structured output only.\n\n' +
              userCodeBundle
          }
        ]
      }
    ],
    output_config: {
      format: zodOutputFormat(llmVerifyOutputSchema)
    }
  });

  const parsed = msg.parsed_output;
  if (parsed === null) {
    console.error('LLM returned no structured audit output.');
    process.exit(1);
  }
  report.llm_audit = parsed;
  report.llm_model = model;
}

console.log(`${JSON.stringify(report, null, 2)}\n`);

let exitCode = 0;
if (!deterministic.ok) {
  exitCode = 1;
} else if (runLlm) {
  const llm = report.llm_audit;
  if (llm !== undefined && llm.overall_ok === false) {
    exitCode = 1;
  }
}

process.exit(exitCode);
