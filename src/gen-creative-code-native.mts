import type { StyleGuide } from './gen-style-guide.mjs';
import { basename, dirname, extname, join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { imageSizeFromFile } from 'image-size/fromFile';
import mime from 'mime';
import puppeteer, { KnownDevices } from 'puppeteer';
import { z } from 'zod';

// --- Tokens / coût (Claude Opus 4.7 Flagship : $5/M input, $25/M output) ---
const USD_PER_MILLION_INPUT_TOKENS = 5;
const USD_PER_MILLION_OUTPUT_TOKENS = 25;

type UsageLike = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

type UsageAccumulator = {
  api_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

function createEmptyUsageAccumulator (): UsageAccumulator {
  return {
    api_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
}

function addUsageToAccumulator (
  acc: UsageAccumulator,
  usage: UsageLike | null | undefined
): void {
  if (usage === null || usage === undefined) {
    return;
  }
  acc.api_calls += 1;
  acc.input_tokens += usage.input_tokens;
  acc.output_tokens += usage.output_tokens;
  acc.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
  acc.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
}

function billedInputTokens (acc: UsageAccumulator): number {
  return acc.input_tokens + acc.cache_creation_input_tokens + acc.cache_read_input_tokens;
}

function pricesUsdFromAccumulator (acc: UsageAccumulator): {
  billed_input_tokens: number;
  output_tokens: number;
  input_usd: number;
  output_usd: number;
  total_usd: number;
} {
  const billed_input_tokens = billedInputTokens(acc);
  const output_tokens = acc.output_tokens;
  const input_usd = (billed_input_tokens / 1_000_000) * USD_PER_MILLION_INPUT_TOKENS;
  const output_usd = (output_tokens / 1_000_000) * USD_PER_MILLION_OUTPUT_TOKENS;
  return {
    billed_input_tokens,
    output_tokens,
    input_usd,
    output_usd,
    total_usd: input_usd + output_usd
  };
}

function roundUsd6 (n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function logAnthropicUsageAndCost (scriptLabel: string, acc: UsageAccumulator): void {
  const p = pricesUsdFromAccumulator(acc);
  console.log(`--- ${scriptLabel} (cumulative) ---`);
  console.log(`call reason : ${acc.api_calls} réponse(s) API — Claude Opus 4.7 Flagship ($5/M input, $25/M output, cache inclus côté input)`);
  console.log(`input token : ${p.billed_input_tokens}`);
  console.log(`output token : ${p.output_tokens}`);
  console.log(`input price (USD) : ${roundUsd6(p.input_usd)}`);
  console.log(`output price (USD) : ${roundUsd6(p.output_usd)}`);
  console.log(`total price (USD) : ${roundUsd6(p.total_usd)}`);
  console.log('');
}
function billedInputFromUsage (usage: UsageLike): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
}

function logReadableAnthropicCall (callReason: string, usage: UsageLike | null | undefined): void {
  console.log(`call reason : ${callReason}`);
  if (usage === null || usage === undefined) {
    console.log('input token : —');
    console.log('output token : —');
    console.log('');
    return;
  }
  console.log(`input token : ${billedInputFromUsage(usage)}`);
  console.log(`output token : ${usage.output_tokens}`);
  console.log('');
}

function shortenForLog (s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length <= max) {
    return t;
  }
  return `${t.slice(0, max - 1)}…`;
}

function pickQueryFromUnknown (input: unknown): string | null {
  if (input === null || typeof input !== 'object') {
    return null;
  }
  const o = input as Record<string, unknown>;
  for (const key of [ 'query', 'search_query', 'q' ] as const) {
    const v = o[key];
    if (typeof v === 'string' && v.trim().length > 0) {
      return shortenForLog(v, 160);
    }
  }
  return null;
}

function describeClientToolUse (name: string, input: unknown): string {
  switch (name) {
    case 'web_search':
      return "recherche web (pages officielles, sources, vérification d'informations)";
    case 'google_image_search': {
      const q = pickQueryFromUnknown(input);
      if (q !== null) {
        return `recherche d'images Google — requête « ${q} »`;
      }
      return "recherche d'images Google (logos, produits, références visuelles)";
    }
    case 'render_creative_png': {
      const o = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : null;
      const entry = typeof o?.['entryFile'] === 'string' ? o['entryFile'] : '(fichier non précisé)';
      const preset = typeof o?.['devicePreset'] === 'string' ? o['devicePreset'] : null;
      const wait = typeof o?.['waitMs'] === 'number' ? `attente ${o['waitMs']} ms` : null;
      const bits = [ `entrée ${entry}` ];
      if (preset !== null) {
        bits.push(`appareil ${preset}`);
      }
      if (wait !== null) {
        bits.push(wait);
      }
      return `génération de prévisualisation PNG (Puppeteer) — ${bits.join(', ')} — pour contrôler la scène avant livraison des fichiers`;
    }
    default:
      return `outil personnalisé « ${name} »`;
  }
}

function describeServerToolUse (name: Anthropic.ServerToolUseBlock['name'], input: unknown): string {
  const q = pickQueryFromUnknown(input);
  const qSuffix = q !== null ? ` — requête « ${q} »` : '';
  switch (name) {
    case 'web_search':
      return `recherche web intégrée (serveur Anthropic)${qSuffix}`;
    case 'web_fetch':
      return `récupération de page distante (web_fetch)${qSuffix}`;
    case 'code_execution':
    case 'bash_code_execution':
    case 'text_editor_code_execution':
      return `exécution / édition côté serveur (${name})`;
    case 'tool_search_tool_regex':
    case 'tool_search_tool_bm25':
      return `recherche d'outils (${name})`;
    default:
      return `outil serveur « ${name} »${qSuffix}`;
  }
}

function describeAnthropicTurnForLogs (
  stopReason: Anthropic.Message['stop_reason'],
  content: Anthropic.Message['content']
): string {
  const segments: string[] = [];

  if (stopReason !== null && stopReason !== undefined) {
    segments.push(`arrêt: ${stopReason}`);
  }

  if (content.length === 0) {
    segments.push('aucun bloc de contenu');
    return segments.join(' — ');
  }

  const actions: string[] = [];
  let hasThinking = false;
  let hasText = false;

  for (const block of content) {
    if (block.type === 'tool_use') {
      actions.push(describeClientToolUse(block.name, block.input));
    } else if (block.type === 'server_tool_use') {
      actions.push(describeServerToolUse(block.name, block.input));
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      hasThinking = true;
    } else if (block.type === 'text') {
      hasText = true;
    }
  }

  if (actions.length > 0) {
    segments.push(`objectif du tour : ${actions.join(' | ')}`);
  }

  if (stopReason === 'tool_use' && actions.length === 0) {
    segments.push('arrêt tool_use sans blocs tool_use reconnus (vérifier la réponse)');
  }

  if (stopReason !== 'tool_use') {
    if (hasText && actions.length === 0) {
      segments.push('réponse textuelle ou JSON structuré (livraison ou étape intermédiaire)');
    }
    if (hasThinking && actions.length === 0 && !hasText) {
      segments.push('réflexion interne uniquement (extended thinking), sans texte ni outil client');
    }
    if (!hasText && actions.length === 0 && stopReason === 'end_turn') {
      segments.push('fin de tour (souvent JSON de guide de style ou liste de fichiers parsée)');
    }
  }

  if (hasThinking && actions.length > 0) {
    segments.push('inclut de la réflexion étendue');
  }

  return segments.join(' — ');
}



function contains<T extends string>(array: readonly T[], value: string): value is T {
  return (array as readonly string[]).includes(value);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

interface RenderCreativePngInput {
  entryFile: string;
  outputFileName?: string;
  devicePreset?: string;
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  };
  waitMs?: number;
  ensureSceneReady?: boolean;
  sceneReadyTimeoutMs?: number;
}

interface AssetFile {
  fileName: string;
  filePath: string;
  fileType: 'logos' | 'products';
}
function createAssetDescription(fileName: string, fileType: 'logos' | 'products'): string {
  const baseName = fileName.replace(/\.[^.]+$/, '');
  const keywordString = baseName
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const categoryLabel = fileType === 'logos' ? 'logo de marque' : 'visuel produit';
  const usageHint = fileType === 'logos'
    ? 'a utiliser en branding (header, badge, signature visuelle)'
    : 'a utiliser comme visuel hero ou element de scene principal';

  return `Description asset (${categoryLabel}): ${keywordString || baseName}. ${usageHint}.`;
}


interface RenderDefaults {
  devicePreset?: string;
  viewport?: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  };
}

type AssetInputMode = 'base64' | 'url';

const designSkillFiles = [
  '.claude/.skills/ui-design/commands/design-screen.md',
  '.claude/.skills/ui-design/commands/color-palette.md',
  '.claude/.skills/ui-design/commands/type-system.md',
  '.claude/.skills/ui-design/skills/color-system/SKILL.md',
  '.claude/.skills/ui-design/skills/dark-mode-design/SKILL.md',
  '.claude/.skills/ui-design/skills/layout-grid/SKILL.md',
  '.claude/.skills/ui-design/skills/responsive-design/SKILL.md',
  '.claude/.skills/ui-design/skills/typography-scale/SKILL.md',
  '.claude/.skills/ui-design/skills/visual-hierarchy/SKILL.md',
  '.claude/.skills/interaction-design/skills/animation-principles/SKILL.md',
  '.claude/.skills/interaction-design/skills/feedback-patterns/SKILL.md',
  '.claude/.skills/interaction-design/skills/micro-interaction-spec/SKILL.md'
] as const;

function loadDesignSkillGuidance(): string {
  const rootDir = join(import.meta.dirname, '..');
  const loadedSkills = designSkillFiles
    .map((relativePath) => {
      const absolutePath = join(rootDir, relativePath);

      if (!existsSync(absolutePath)) {
        return null;
      }

      const content = readFileSync(absolutePath, 'utf8').trim();
      return `### ${relativePath}\n${content}`;
    })
    .filter((value): value is string => value !== null);

  if (loadedSkills.length === 0) {
    throw new Error('No local design skill files were found in .claude/.skills.');
  }

  return loadedSkills.join('\n\n');
}

function normalizeHexColor(value: string): string {
  const normalized = value.trim().replace(/^#/, '').toUpperCase();
  return normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized;
}

function extractHexColorsFromCss(content: string): Set<string> {
  const matches = content.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  return new Set(
    matches
      .map((hexValue) => normalizeHexColor(hexValue))
      .filter((hexValue) => hexValue.length === 6)
  );
}

function extractFontFamiliesFromCss(content: string): Set<string> {
  const fontFamilyMatches = content.match(/font-family\s*:\s*([^;]+);/gi) ?? [];
  const familySet = new Set<string>();

  for (const declaration of fontFamilyMatches) {
    const declarationMatch = declaration.match(/font-family\s*:\s*([^;]+);/i);
    if (declarationMatch === null) {
      continue;
    }
    const list = declarationMatch[1] ?? '';
    for (const fontName of list.split(',')) {
      const cleaned = fontName.trim().replace(/^['"]|['"]$/g, '');
      if (cleaned.length > 0) {
        familySet.add(cleaned.toLowerCase());
      }
    }
  }

  return familySet;
}

function validateCreativeSkillCompliance(
  files: z.infer<typeof filesSchema>,
  currentStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>,
  assetFiles: AssetFile[]
): { ok: true } | { ok: false; issues: string[] } {
  const normalizeGeneratedPath = (fileName: string): string =>
    fileName.replace(/\\/g, '/').toLowerCase();

  const indexFile = files.find((file) => normalizeGeneratedPath(file.fileName) === 'index.html');
  if (indexFile === undefined) {
    return { ok: false, issues: [ 'Missing index.html at project root.' ] };
  }

  const stylesFile = files.find((file) => normalizeGeneratedPath(file.fileName) === 'styles.css');
  const appJsFile = files.find((file) => normalizeGeneratedPath(file.fileName) === 'app.js');
  if (stylesFile === undefined) {
    return { ok: false, issues: [ 'Missing styles.css at project root (CSS pur, sans préprocesseur).' ] };
  }
  if (appJsFile === undefined) {
    return { ok: false, issues: [ 'Missing app.js at project root (JavaScript vanilla, sans bundler).' ] };
  }

  const issues: string[] = [];
  const allContent = files.map((file) => file.fileContent).join('\n');
  const allContentLower = allContent.toLowerCase();

  const forbiddenLockfiles = new Set([
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb'
  ]);
  for (const file of files) {
    const base = (normalizeGeneratedPath(file.fileName).split('/').pop() ?? '');
    if (forbiddenLockfiles.has(base)) {
      issues.push(`Fichier interdit pour une sortie statique native : ${file.fileName}`);
    }
    const leaf = file.fileName.replace(/\\/g, '/').split('/').pop() ?? '';
    if (/^vite\.config\.(ts|js|mts|mjs|cjs)$/i.test(leaf)) {
      issues.push(`Configuration de build interdite : ${file.fileName}`);
    }
    if (/tailwind\.config\./i.test(leaf) || /postcss\.config\./i.test(leaf)) {
      issues.push(`Fichier d’outil CSS interdit : ${file.fileName}`);
    }
    if (/\.(jsx|tsx)$/i.test(file.fileName)) {
      issues.push(`Fichier React/JSX interdit : ${file.fileName} (utiliser uniquement .html et .js).`);
    }
  }

  if (!/(href|src)\s*=\s*["'][^"']*styles\.css["']/i.test(indexFile.fileContent)) {
    issues.push('index.html doit référencer styles.css (ex. <link rel="stylesheet" href="styles.css">).');
  }
  if (!/src\s*=\s*["'][^"']*app\.js["']/i.test(indexFile.fileContent)) {
    issues.push('index.html doit référencer app.js (ex. <script src="app.js" defer></script>).');
  }

  const forbiddenSnippets: Array<[ string, string ]> = [
    [ 'from "react"', 'React (import)' ],
    [ "from 'react'", 'React (import)' ],
    [ 'from "react-dom"', 'react-dom' ],
    [ "from 'react-dom'", 'react-dom' ],
    [ '@vitejs/', 'Vite' ],
    [ 'tailwindcss', 'Tailwind CSS' ],
    [ 'daisyui', 'DaisyUI' ],
    [ 'createRoot(', 'React createRoot' ],
    [ 'react/jsx-runtime', 'JSX runtime React' ]
  ];
  for (const [ needle, label ] of forbiddenSnippets) {
    if (allContentLower.includes(needle.toLowerCase())) {
      issues.push(`Le code ne doit pas dépendre de frameworks ou d’outils de build (détecté : ${label}).`);
    }
  }

  const styleGuideFonts = new Set(
    currentStyleGuide.typography
      .map((item) => item.fontFamily.trim().toLowerCase())
      .filter((fontName) => fontName.length > 0)
  );
  const usedFonts = extractFontFamiliesFromCss(allContent);
  const disallowedFonts = Array.from(usedFonts).filter((fontName) =>
    !styleGuideFonts.has(fontName) &&
    !contains([ 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui' ], fontName)
  );
  if (disallowedFonts.length > 0) {
    issues.push(`Contains font families outside style guide: ${disallowedFonts.join(', ')}`);
  }

  const allowedColors = new Set([
    ...currentStyleGuide.primaryColorPalette.map(normalizeHexColor),
    ...currentStyleGuide.secondaryColorPalette.map(normalizeHexColor)
  ]);
  const usedHexColors = extractHexColorsFromCss(allContent);
  const unknownHexColors = Array.from(usedHexColors).filter((hexColor) => !allowedColors.has(hexColor));
  if (unknownHexColors.length > 0) {
    issues.push(`Contains colors outside style guide palettes: ${unknownHexColors.slice(0, 10).join(', ')}`);
  }

  const logoAssets = assetFiles.filter((asset) => asset.fileType === 'logos');
  const productAssets = assetFiles.filter((asset) => asset.fileType === 'products');
  const hasLogoReference = logoAssets.some((asset) => allContentLower.includes(asset.fileName.toLowerCase()));
  const hasProductReference = productAssets.some((asset) => allContentLower.includes(asset.fileName.toLowerCase()));
  if (!hasLogoReference) {
    issues.push('Missing at least one local logo asset reference in generated files.');
  }
  if (!hasProductReference) {
    issues.push('Missing at least one local product asset reference in generated files.');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true };
}

loadDotenv({ path: join(import.meta.dirname, '..', '.env') });

const directoryUuid = process.argv[2];

if (directoryUuid === undefined) {
  throw new Error('Missing project directory UUID.');
}

const cliArguments = process.argv.slice(3);
const renderDefaults: RenderDefaults = {};
let assetInputMode: AssetInputMode = 'url';

for (let i = 0; i < cliArguments.length; i += 1) {
  const argument = cliArguments[i];

  if (argument === '--device') {
    const value = cliArguments[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('Missing value for --device');
    }
    renderDefaults.devicePreset = value;
    i += 1;
    continue;
  }

  if (argument === '--viewport') {
    const value = cliArguments[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('Missing value for --viewport. Expected format WIDTHxHEIGHT (example: 390x844).');
    }
    const viewportMatch = /^(\d+)x(\d+)$/i.exec(value);
    if (viewportMatch === null) {
      throw new Error(`Invalid --viewport value "${value}". Expected format WIDTHxHEIGHT (example: 390x844).`);
    }
    const widthMatch = viewportMatch[1];
    const heightMatch = viewportMatch[2];
    if (widthMatch === undefined || heightMatch === undefined) {
      throw new Error(`Invalid --viewport value "${value}". Expected format WIDTHxHEIGHT (example: 390x844).`);
    }
    const width = Number.parseInt(widthMatch, 10);
    const height = Number.parseInt(heightMatch, 10);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error(`Invalid --viewport dimensions "${value}". Width and height must be positive integers.`);
    }
    renderDefaults.viewport = { width, height };
    i += 1;
    continue;
  }

  if (argument === '--dpr') {
    const value = cliArguments[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('Missing value for --dpr (example: 2).');
    }
    const dpr = Number.parseFloat(value);
    if (!Number.isFinite(dpr) || dpr <= 0) {
      throw new Error(`Invalid --dpr value "${value}". DPR must be a positive number.`);
    }
    renderDefaults.viewport = {
      ...(renderDefaults.viewport ?? { width: 320, height: 480 }),
      deviceScaleFactor: dpr
    };
    i += 1;
    continue;
  }

  if (argument === '--asset-input') {
    const value = cliArguments[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('Missing value for --asset-input. Expected "base64" or "url".');
    }
    if (!contains([ 'base64', 'url' ] as const, value)) {
      throw new Error(`Invalid --asset-input value "${value}". Allowed values: base64, url.`);
    }
    assetInputMode = value;
    i += 1;
    continue;
  }

  throw new Error(`Unknown argument "${argument}". Allowed options: --device, --viewport, --dpr, --asset-input`);
}

if (renderDefaults.devicePreset !== undefined && renderDefaults.viewport !== undefined) {
  throw new Error('Do not use --device and --viewport together. Choose one simulation mode.');
}

const directoryPath = join(import.meta.dirname, '..', 'output', directoryUuid);
const codeDirectoryPath = join(directoryPath, 'code');
const previewDirectoryPath = join(directoryPath, 'preview');
const styleGuidePath = join(directoryPath, 'style-guide.json');
const styleGuide = JSON.parse(readFileSync(styleGuidePath, { encoding: 'utf8' })) as StyleGuide;

const filesSchema = z.array(
  z.object({
    fileName: z.string().describe('File name'),
    fileContent: z.string().describe('File code content')
  })
    .describe('Code file details')
    .strict()
)
  .describe('List of code files');

const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
  throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
}

const anthropicClient = new Anthropic({
  apiKey: anthropicApiKey
});
const localDesignSkillGuidance = loadDesignSkillGuidance();

async function renderCreativePng(input: RenderCreativePngInput): Promise<{ outputPath: string }> {
  const safeEntryFile = input.entryFile.replace(/\\/g, '/');
  const entryFileName = safeEntryFile.split('/').pop() ?? '';

  if (entryFileName.length === 0 || entryFileName === '.' || entryFileName === '..') {
    throw new Error('Invalid entryFile provided.');
  }

  const entryFilePath = join(codeDirectoryPath, entryFileName);
  const outputFileName = sanitizeFilename(input.outputFileName ?? `preview-${Date.now()}.png`);
  const outputPath = join(previewDirectoryPath, outputFileName.endsWith('.png') ? outputFileName : `${outputFileName}.png`);
  const waitMs = Math.max(0, Math.min(input.waitMs ?? 6_500, 30_000));
  const ensureSceneReady = input.ensureSceneReady ?? false;
  const sceneReadyTimeoutMs = Math.max(1_000, Math.min(input.sceneReadyTimeoutMs ?? 15_000, 60_000));
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--allow-file-access-from-files',
      '--disable-web-security'
    ]
  });

  try {
    const page = await browser.newPage();

    const effectiveDevicePreset = input.devicePreset ?? renderDefaults.devicePreset;
    const effectiveViewport = input.viewport ?? renderDefaults.viewport;

    if (effectiveDevicePreset !== undefined && effectiveDevicePreset.trim().length > 0) {
      const knownDevices = KnownDevices as Record<string, (typeof KnownDevices)[keyof typeof KnownDevices]>;
      const device = knownDevices[effectiveDevicePreset];

      if (device === undefined) {
        throw new Error(`Unknown device preset: ${effectiveDevicePreset}`);
      }

      await page.emulate(device);
    } else if (effectiveViewport !== undefined) {
      const { width, height, deviceScaleFactor } = effectiveViewport;
      await page.setViewport({
        width,
        height,
        deviceScaleFactor: deviceScaleFactor ?? 1
      });
    } else {
      await page.setViewport({
        width: 320,
        height: 480,
        deviceScaleFactor: 1
      });
    }

    const entryFileUrl = pathToFileURL(entryFilePath).toString();
    await page.goto(entryFileUrl, { waitUntil: 'networkidle2' });

    if (ensureSceneReady) {
      await page.evaluate((timeoutMs: number) => {
        const waitLoaded = (target: EventTarget): Promise<void> => {
          return new Promise(resolve => {
            const node = target as { hasLoaded?: boolean; addEventListener: EventTarget['addEventListener'] };

            if (node.hasLoaded === true) {
              resolve();
              return;
            }

            node.addEventListener('loaded', () => resolve(), { once: true });
          });
        };

        const withTimeout = (promise: Promise<void>, ms: number): Promise<void> => {
          return Promise.race([
            promise,
            new Promise<void>((_, reject) => {
              setTimeout(() => reject(new Error('DOM readiness timeout')), ms);
            })
          ]);
        };

        const doc = (globalThis as any).document as {
          querySelector: (selector: string) => any;
        };
        const scene = doc.querySelector('a-scene');
        const assets = scene?.querySelector('a-assets');

        if (scene === null) {
          return Promise.resolve();
        }

        const readyPromise = (async () => {
          await waitLoaded(scene);

          if (assets !== null) {
            await waitLoaded(assets);
          }
        })();

        return withTimeout(readyPromise, timeoutMs);
      }, sceneReadyTimeoutMs);
    }

    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    mkdirSync(previewDirectoryPath, { recursive: true });
    await page.screenshot({
      path: outputPath,
      type: 'png',
      fullPage: false
    });

    return { outputPath };
  } finally {
    await browser.close();
  }
}

const fileMessages: (Anthropic.ImageBlockParam | Anthropic.TextBlock)[] = [];
const assetFiles: AssetFile[] = [];

for (const fileType of [ 'logos', 'products' ] as const) {
  const subdirectoryPath = join(directoryPath, fileType);
  const fileList = readdirSync(subdirectoryPath);

  for (const fileName of fileList) {
    if (fileName.startsWith('.')) {
      continue;
    }

    const filePath = join(subdirectoryPath, fileName);
    const fileMimeType = mime.getType(fileName);
    const { width, height } = await imageSizeFromFile(filePath);
    const assetDescription = createAssetDescription(fileName, fileType);

    if (fileMimeType === null) {
      throw new Error(`Unable to determine MIME type for file ${fileName}`);
    } else if (!contains([ 'image/jpeg', 'image/png', 'image/gif', 'image/webp' ], fileMimeType)) {
      throw new Error(`Unsupported MIME type ${fileMimeType} for file ${fileName}`);
    }

    const textPayload =
      `- Asset: ${fileName}\n` +
      `  - Category: ${fileType === 'logos' ? 'logo' : 'product image'}\n` +
      `  - Local path to use in generated code: ./${fileName}\n` +
      `  - Dimensions: ${width}x${height}\n` +
      `  - ${assetDescription}\n` +
      `  - Required: describe this specific image before using it and integrate it visually in the creative.`;
    fileMessages.push({
      type: 'text',
      text: textPayload,
      citations: null
    });

    if (assetInputMode === 'base64') {
      const fileContentBase64 = readFileSync(filePath).toString('base64');
      fileMessages.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: fileMimeType,
          data: fileContentBase64
        }
      });
    }
    assetFiles.push({
      fileName,
      filePath,
      fileType
    });
  }
}

const prunedStyleGuide = JSON.parse(JSON.stringify(styleGuide));
delete prunedStyleGuide.logoFileUrls;
delete prunedStyleGuide.productPictureUrls;

const messages: Anthropic.Messages.MessageParam[] = [{
  role: 'user',
  content: [
    ...fileMessages,
    {
      type: 'text',
      text: JSON.stringify(prunedStyleGuide)
    }
  ]
}];
let codeFileList: z.infer<typeof filesSchema> | null = null;
let generationIndex = 0;
const maxGenerationTurns = 8;
let structuredOutputRetryCount = 0;
const maxStructuredOutputRetries = 2;

const creativeUsageTotals = createEmptyUsageAccumulator();

while (true) {
  generationIndex += 1;
  if (generationIndex > maxGenerationTurns) {
    throw new Error(`Generation exceeded ${maxGenerationTurns} turns without valid output.`);
  }
  const systemPrompt = `
      You are an agent that invents modern interactive advertisement creatives.

      Required stack: plain HTML5, CSS, and JavaScript only. No React, Vue, Svelte, no Vite/Webpack,
      no Tailwind/DaisyUI/npm dependencies, no JSX/TSX, no build step. The result must open from disk
      (file://) in a browser when index.html is loaded.

      Create a 2D advertisement creative in a new format you invent.
      Graphic elements (fonts, colors, pictures) must follow only the JSON style guide from the user.
      The layout and interaction design are up to you: fresh, modern, eye-catching, with animation and
      interactivity where appropriate.

      Logo and product images are local files. Reference them with relative paths from the project root
      (for example: ./logo.png).

      Output: a list of files with their contents. Paths must be relative to the project root.

      You MUST output exactly these root files (no subfolders required for these three):
      - index.html — viewport meta width=device-width; link to styles.css; script src app.js (defer recommended).
      - styles.css — all presentation (no preprocessor). Center the 320x480 creative on the page
        (e.g. body as flex container min-height 100vh, align and justify center).
      - app.js — vanilla DOM scripting only (no import maps to npm).

      Optional: additional static assets only if needed (e.g. extra .svg), still no package.json or bundlers.

      Fonts and colors: only those defined in the style guide. Ad copy in French.
      Creative viewport area: 320x480 (the visible ad frame inside the page).
      Include at least one logo and one product image from the provided assets in the HTML/CSS/JS.
      Do not add browser chrome: no zoom, fullscreen, or VR toggles in the creative UI.
      You may call render_creative_png to preview; entryFile is index.html at project root.

      The local design skills below are mandatory constraints.
      Before returning final files, internally run a compliance check against these skills.
      If any skill rule is not satisfied, keep refining and do not finalize.
      Use only typography families listed in the style guide.
      Use only hex colors listed in the style guide primary/secondary palettes.
      Follow the local design skills below as mandatory constraints for layout, color, typography,
      hierarchy, animation, and interaction decisions:
      ${localDesignSkillGuidance}
    `.trim();

  const creativeCodeStream = await anthropicClient.messages.stream({
    max_tokens: 128_000,
    system: systemPrompt,
    messages,
    model: 'claude-opus-4-6',
    thinking: {
      type: 'enabled',
      budget_tokens: 100_000,
      display: 'omitted'
    },
    output_config: {
      format: zodOutputFormat(filesSchema)
    },
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 50
      },
      {
        name: 'render_creative_png',
        description: `
          Render a local creative file into a PNG screenshot.
          Use this to verify visual quality and composition while iterating.
        `.trim(),
        input_schema: {
          type: 'object',
          properties: {
            entryFile: {
              type: 'string',
              description: 'Entry HTML file located in the generated code directory (for example: index.html).'
            },
            outputFileName: {
              type: 'string',
              description: 'Optional PNG output file name.'
            },
            devicePreset: {
              type: 'string',
              description: 'Optional Puppeteer known device preset (for example: iPhone 14 Pro).'
            },
            viewport: {
              type: 'object',
              description: 'Optional viewport configuration used when devicePreset is not provided.',
              properties: {
                width: {
                  type: 'integer',
                  minimum: 1
                },
                height: {
                  type: 'integer',
                  minimum: 1
                },
                deviceScaleFactor: {
                  type: 'number',
                  minimum: 0.1
                }
              },
              required: [ 'width', 'height' ]
            },
            waitMs: {
              type: 'integer',
              minimum: 0,
              maximum: 30000,
              description: 'Optional wait after page load before screenshot, useful for animations.'
            },
            ensureSceneReady: {
              type: 'boolean',
              description: 'Optional DOM scene readiness check before screenshot. Defaults to false.'
            },
            sceneReadyTimeoutMs: {
              type: 'integer',
              minimum: 1000,
              maximum: 60000,
              description: 'Timeout for scene/assets readiness wait.'
            }
          },
          required: [ 'entryFile' ]
        }
      }
    ]
  });
  const creativeCodeResponse = await creativeCodeStream.finalMessage();
  addUsageToAccumulator(creativeUsageTotals, creativeCodeResponse.usage);
  logReadableAnthropicCall(
    describeAnthropicTurnForLogs(creativeCodeResponse.stop_reason, creativeCodeResponse.content),
    creativeCodeResponse.usage ?? undefined
  );
  messages.push({ role: 'assistant', content: creativeCodeResponse.content });

  if (creativeCodeResponse.stop_reason !== 'tool_use') {
    if (creativeCodeResponse.parsed_output !== null && creativeCodeResponse.parsed_output.length > 0) {
      const complianceCheck = validateCreativeSkillCompliance(creativeCodeResponse.parsed_output, prunedStyleGuide, assetFiles);
      if (complianceCheck.ok) {
        codeFileList = creativeCodeResponse.parsed_output;
        break;
      }

      structuredOutputRetryCount += 1;
      if (structuredOutputRetryCount > maxStructuredOutputRetries) {
        throw new Error(`AI output failed skill compliance checks: ${complianceCheck.issues.join(' | ')}`);
      }

      messages.push({
        role: 'user',
        content: `Your previous output is not compliant with mandatory skills/style-guide constraints: ${complianceCheck.issues.join(' ; ')}. Regenerate all files and fix every issue.`
      });
      continue;
    }

    structuredOutputRetryCount += 1;
    if (structuredOutputRetryCount > maxStructuredOutputRetries) {
      throw new Error('AI returned no structured code output after retries.');
    }

    messages.push({
      role: 'user',
      content: `Your previous response did not include the required structured file list. Respond now with only valid structured output matching the expected schema. Do not call tools.`
    });
    continue;
  }

  const toolResults: Anthropic.ToolResultBlockParam[] = [];

  for (const block of creativeCodeResponse.content) {
    if (block.type === 'tool_use' && block.name === 'render_creative_png') {
      const args = block.input as RenderCreativePngInput;

      try {
        const result = await renderCreativePng(args);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({
            success: true,
            outputPath: result.outputPath
          })
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: ${message}`,
          is_error: true
        });
      }
    }
  }

  if (toolResults.length === 0) {
    structuredOutputRetryCount += 1;
    if (structuredOutputRetryCount > maxStructuredOutputRetries) {
      throw new Error('Tool use response contained no executable tool calls.');
    }

    messages.push({
      role: 'user',
      content: `No valid tool call was executed. Continue and return valid structured file output now.`
    });
    continue;
  }

  messages.push({ role: 'user', content: toolResults });
}

if (codeFileList === null || codeFileList.length === 0) {
  throw new Error('Missing or empty code file list returned by AI.');
}

mkdirSync(codeDirectoryPath, { recursive: true });

for (const codeFile of codeFileList) {
  const filePath = join(codeDirectoryPath, codeFile.fileName);
  const fileDirectoryPath = dirname(filePath);

  mkdirSync(fileDirectoryPath, { recursive: true });
  writeFileSync(filePath, codeFile.fileContent, { encoding: 'utf8' });
}

for (const assetFile of assetFiles) {
  const destinationPath = join(codeDirectoryPath, assetFile.fileName);
  copyFileSync(assetFile.filePath, destinationPath);
}

const indexFilePath = join(codeDirectoryPath, 'index.html');
if (existsSync(indexFilePath)) {
  try {
    await renderCreativePng({
      entryFile: 'index.html',
      outputFileName: 'final-preview.png',
      waitMs: 2_000,
      ensureSceneReady: false
    });
  } catch {
  }
}

const sumReportedTokens =
  creativeUsageTotals.input_tokens +
  creativeUsageTotals.output_tokens +
  creativeUsageTotals.cache_creation_input_tokens +
  creativeUsageTotals.cache_read_input_tokens;

logAnthropicUsageAndCost(basename(import.meta.filename, extname(import.meta.filename)), creativeUsageTotals);

const cumulativePrices = pricesUsdFromAccumulator(creativeUsageTotals);
writeFileSync(
  join(directoryPath, 'creative-native-token-usage.json'),
  `${JSON.stringify({
    ...creativeUsageTotals,
    total_tokens_reported_sum: sumReportedTokens,
    price_usd: {
      input: cumulativePrices.input_usd,
      output: cumulativePrices.output_usd,
      total: cumulativePrices.total_usd
    }
  }, null, 2)}\n`,
  { encoding: 'utf8' }
);
