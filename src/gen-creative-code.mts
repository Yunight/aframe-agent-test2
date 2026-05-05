import type { StyleGuide } from './gen-style-guide.mjs';
import { join } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { imageSizeFromFile } from 'image-size/fromFile';
import mime from 'mime';
import puppeteer, { KnownDevices } from 'puppeteer';
import { z } from 'zod';

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
        console.warn(`[skills] Missing skill file: ${relativePath}`);
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
  const indexFile = files.find((file) => file.fileName.toLowerCase() === 'index.html');
  if (indexFile === undefined) {
    return { ok: false, issues: [ 'Missing index.html output file.' ] };
  }

  const issues: string[] = [];
  const htmlContent = indexFile.fileContent;
  const htmlLower = htmlContent.toLowerCase();

  const styleGuideFonts = new Set(
    currentStyleGuide.typography
      .map((item) => item.fontFamily.trim().toLowerCase())
      .filter((fontName) => fontName.length > 0)
  );
  const usedFonts = extractFontFamiliesFromCss(htmlContent);
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
  const usedHexColors = extractHexColorsFromCss(htmlContent);
  const unknownHexColors = Array.from(usedHexColors).filter((hexColor) => !allowedColors.has(hexColor));
  if (unknownHexColors.length > 0) {
    issues.push(`Contains colors outside style guide palettes: ${unknownHexColors.slice(0, 10).join(', ')}`);
  }

  if (!htmlLower.includes('vr-mode-ui="enabled: false"')) {
    issues.push('Missing required A-Frame setting vr-mode-ui="enabled: false".');
  }

  const logoAssets = assetFiles.filter((asset) => asset.fileType === 'logos');
  const productAssets = assetFiles.filter((asset) => asset.fileType === 'products');
  const hasLogoReference = logoAssets.some((asset) => htmlLower.includes(asset.fileName.toLowerCase()));
  const hasProductReference = productAssets.some((asset) => htmlLower.includes(asset.fileName.toLowerCase()));
  if (!hasLogoReference) {
    issues.push('Missing at least one local logo asset reference in index.html.');
  }
  if (!hasProductReference) {
    issues.push('Missing at least one local product asset reference in index.html.');
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true };
}

const debugMode = process.env['DEBUG_RENDER'] === '1';
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
  const ensureSceneReady = input.ensureSceneReady ?? true;
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
    if (debugMode) {
      page.on('console', msg => {
        console.log(`[render:browser:console:${msg.type()}] ${msg.text()}`);
      });
      page.on('pageerror', err => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`[render:browser:pageerror] ${errorMessage}`);
      });
      page.on('requestfailed', req => {
        console.error(`[render:browser:requestfailed] ${req.url()} :: ${req.failure()?.errorText ?? 'Unknown error'}`);
      });
      page.on('response', res => {
        if (res.status() >= 400) {
          console.error(`[render:browser:http${res.status()}] ${res.url()}`);
        }
      });
    }

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
    if (debugMode) {
      console.log(`[render] Loaded entry URL: ${entryFileUrl}`);
      const imageDebug = await page.evaluate(() => {
        const doc = (globalThis as any).document as { images: ArrayLike<any> };
        return Array.from(doc.images as ArrayLike<any>).map((img: any) => ({
          src: img.currentSrc || img.src,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight
        }));
      });
      console.log(`[render] DOM image state: ${JSON.stringify(imageDebug)}`);
    }

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
              setTimeout(() => reject(new Error('A-Frame scene readiness timeout')), ms);
            })
          ]);
        };

        const doc = (globalThis as any).document as {
          querySelector: (selector: string) => any;
        };
        const scene = doc.querySelector('a-scene');
        const assets = scene?.querySelector('a-assets');

        if (scene === null) {
          throw new Error('Missing <a-scene> in entry file.');
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

console.log('Generating creative code ...');
console.log(`Asset input mode: ${assetInputMode}`);

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

    fileMessages.push({
      type: 'text',
      text:
        `- Asset: ${fileName}\n` +
        `  - Category: ${fileType === 'logos' ? 'logo' : 'product image'}\n` +
        `  - Local path to use in generated code: ./${fileName}\n` +
        `  - Dimensions: ${width}x${height}\n` +
        `  - ${assetDescription}\n` +
        `  - Required: describe this specific image before using it and integrate it visually in the creative.`,
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

while (true) {
  generationIndex += 1;
  if (generationIndex > maxGenerationTurns) {
    throw new Error(`Generation exceeded ${maxGenerationTurns} turns without valid output.`);
  }
  console.log(`Generating creative code ... (i=${generationIndex})`);

  const creativeCodeStream = await anthropicClient.messages.stream({
    max_tokens: 128_000,
    system: `
      You are an agent that invents cool 2D and 3D advertisement creatives.
      
      The technical stack that should be used to create these creatives is Mozilla's Aframe.
      It is a library that uses the Web Components API and the Entity Component System (ECS) paradigm to assemble Three.js (WebGL) scenes.

      Aframe GitHub repository : https://github.com/aframevr/aframe
      Aframe official documentation : https://aframe.io/docs/1.7.0/introduction/
      Aframe examples on GitHub : https://github.com/aframevr/aframe/tree/master/examples
      Aframe examples on official site : https://aframe.io/examples/showcase/helloworld/

      What is asked of you is to create a 2D advertisement creative of a new ad format you invented.
      The graphic elements (fonts, colors, pictures) of said ad creative should only be based on the JSON style guide passed as input by the user.
      The format, which is the way these graphic elements are articulated together is up to you.
      It should be fresh, modern, inovative, eye catching and should make the viewer want know more or buy the product.
      Ideally the format should be animated and be interactive for the user to make it fun.
      Logo and product images or pictures are available as local files and source URLs.
      You must use local file paths (for example: ./logo.png) in the final HTML/CSS/A-Frame output.

      The output should be a list of files and the code content they contain.
      All URL or path references should be relative to the root of the project.
      The project should have a flat file structure (no subfolders).

      The fonts used should be the ones defined in the style guide.
      The colors used should be the ones defined in the style guide.
      The text of the advertisement should be in french.
      The size of the advertisement should be 320x480.
      You must include at least one logo image and one product image from the provided assets.
      Do not return final output if no image asset is referenced in index.html.
      Never add browser-like controls, zoom buttons, fullscreen buttons, or VR mode toggles in the creative UI.
      Use A-Frame with vr-mode-ui disabled (vr-mode-ui="enabled: false").
      You can call render_creative_png when useful to quickly preview and improve your output.

      The local design skills below are mandatory constraints.
      Before returning final files, internally run a compliance check against these skills.
      If any skill rule is not satisfied, keep refining and do not finalize.
      Use only typography families listed in the style guide.
      Use only hex colors listed in the style guide primary/secondary palettes.
      Follow the local design skills below as mandatory constraints for layout, color, typography,
      hierarchy, animation, and interaction decisions:
      ${localDesignSkillGuidance}
    `.trim(),
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
              description: 'Wait for A-Frame scene/assets loaded events before screenshot. Defaults to true.'
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
  if (debugMode) {
    console.log(`[ai] stop_reason=${creativeCodeResponse.stop_reason ?? 'null'}`);
    console.log(`[ai] stop_details=${JSON.stringify(creativeCodeResponse.stop_details ?? null)}`);
    console.log(`[ai] parsed_output_count=${creativeCodeResponse.parsed_output?.length ?? 0}`);
    const contentDebug = creativeCodeResponse.content.map(block =>
      block.type === 'tool_use'
        ? { type: block.type, name: block.name, id: block.id }
        : { type: block.type }
    );
    console.log(`[ai] content_blocks=${JSON.stringify(contentDebug)}`);
  }
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
        if (debugMode) {
          console.log(`[tool] render_creative_png args=${JSON.stringify(args)}`);
        }
        const result = await renderCreativePng(args);
        if (debugMode) {
          console.log(`[tool] render_creative_png success outputPath=${result.outputPath}`);
        }
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

console.log(`${codeFileList.length} code files generated by AI`);

console.log(`Output code directory path: ${codeDirectoryPath}`);

mkdirSync(codeDirectoryPath, { recursive: true });

for (const codeFile of codeFileList) {
  const filePath = join(codeDirectoryPath, codeFile.fileName);

  console.log(`Writing file ${filePath} ...`);

 writeFileSync(filePath, codeFile.fileContent, { encoding: 'utf8' });
}

for (const assetFile of assetFiles) {
  const destinationPath = join(codeDirectoryPath, assetFile.fileName);
  console.log(`Copying asset ${assetFile.filePath} -> ${destinationPath} ...`);
  copyFileSync(assetFile.filePath, destinationPath);
}

const indexFilePath = join(codeDirectoryPath, 'index.html');
if (existsSync(indexFilePath)) {
  try {
    const finalPreview = await renderCreativePng({
      entryFile: 'index.html',
      outputFileName: 'final-preview.png',
      waitMs: 2_000,
      ensureSceneReady: true
    });
    console.log(`Final preview generated at ${finalPreview.outputPath}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Unable to generate final preview: ${message}`);
  }
}

console.log('End.');
