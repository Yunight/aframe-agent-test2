import 'dotenv/config';
import type { StyleGuide } from './gen-style-guide.mjs';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
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

const debugMode = process.env['DEBUG_RENDER'] === '1';

const directoryUuid = process.argv[2];

if (directoryUuid === undefined) {
  throw new Error('Missing project directory UUID.');
}

const directoryPath = join(import.meta.dirname, '..', '..', 'output', directoryUuid);
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

const anthropicClient = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY']
});

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

    if (input.devicePreset !== undefined && input.devicePreset.trim().length > 0) {
      const knownDevices = KnownDevices as Record<string, (typeof KnownDevices)[keyof typeof KnownDevices]>;
      const device = knownDevices[input.devicePreset];

      if (device === undefined) {
        throw new Error(`Unknown device preset: ${input.devicePreset}`);
      }

      await page.emulate(device);
    } else if (input.viewport !== undefined) {
      const { width, height, deviceScaleFactor } = input.viewport;
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

const fileMessages: (Anthropic.ImageBlockParam | Anthropic.TextBlock)[] = [];

for (const fileType of [ 'logos', 'products' ]) {
  const subdirectoryPath = join(directoryPath, fileType);
  const fileList = readdirSync(subdirectoryPath);

  for (const fileName of fileList) {
    if (fileName.startsWith('.')) {
      continue;
    }

    const filePath = join(subdirectoryPath, fileName);
    const fileMimeType = mime.getType(fileName);
    const fileContentBase64 = readFileSync(filePath).toString('base64');
    const { width, height } = await imageSizeFromFile(filePath);

    if (fileMimeType === null) {
      throw new Error(`Unable to determine MIME type for file ${fileName}`);
    } else if (!contains([ 'image/jpeg', 'image/png', 'image/gif', 'image/webp' ], fileMimeType)) {
      throw new Error(`Unsupported MIME type ${fileMimeType} for file ${fileName}`);
    }

    fileMessages.push({
      type: 'text',
      text: `- The ${fileName} file is a ${fileType.slice(0, -1)} with the dimensions ${width}x${height}.`,
      citations: null
    });
    fileMessages.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: fileMimeType,
        data: fileContentBase64
      }
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

      What is asked of you is to create a 2D or 3D advertisement creative of a new ad format you invented.
      The graphic elements (fonts, colors, pictures) of said ad creative should only be based on the JSON style guide passed as input by the user.
      The format, which is the way these graphic elements are articulated together is up to you.
      It should be fresh, inovative, eye catching and should make the viewer want know more or buy the product.
      Ideally the format should be animated and be interactive for the user to make it fun.
      Logo and product images or pictures are passed as URLs.

      The output should be a list of files and the code content they contain.
      All URL or path references should be relative to the root of the project.
      The project should have a flat file structure (no subfolders).

      The fonts used should be the ones defined in the style guide.
      The colors used should be the ones defined in the style guide.
      The text of the advertisement should be in french.
      The size of the advertisement should be 320x480.
      You can call render_creative_png when useful to quickly preview and improve your output.
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
      codeFileList = creativeCodeResponse.parsed_output;
      break;
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

console.log('End.');
