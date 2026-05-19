import type { StyleGuide } from './gen-style-guide.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const designSkillFiles = [
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

export function loadDesignSkillGuidance (repoRoot?: string): string {
  const rootDir = repoRoot ?? join(import.meta.dirname, '..');
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

export interface AssetFile {
  fileName: string;
  filePath: string;
  fileType: 'logos' | 'products';
}

export function contains<T extends string>(array: readonly T[], value: string): value is T {
  return (array as readonly string[]).includes(value);
}

export const creativeNativeCodeFileEntrySchema = z
  .object({
    fileName: z.string().describe('File name'),
    fileContent: z.string().describe('File code content')
  })
  .strict()
  .describe('Code file details');

export const creativeNativeStructuredOutputFilesSchema = z
  .array(creativeNativeCodeFileEntrySchema)
  .describe('List of code files');

export type CreativeNativeCodeFileList = z.infer<typeof creativeNativeStructuredOutputFilesSchema>;

function normalizeHexColor (value: string): string {
  const normalized = value.trim().replace(/^#/, '').toUpperCase();
  return normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized;
}

function extractHexColorsFromCss (content: string): Set<string> {
  const matches = content.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  return new Set(
    matches
      .map((hexValue) => normalizeHexColor(hexValue))
      .filter((hexValue) => hexValue.length === 6)
  );
}

function extractFontFamiliesFromCss (content: string): Set<string> {
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

export function validateCreativeSkillCompliance (
  files: CreativeNativeCodeFileList,
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
