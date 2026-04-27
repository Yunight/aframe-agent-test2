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
}

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
  const waitMs = Math.max(0, Math.min(input.waitMs ?? 1_500, 30_000));
  const browser = await puppeteer.launch({ headless: true });

  try {
    const page = await browser.newPage();

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

while (true) {
  generationIndex += 1;
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
            }
          },
          required: [ 'entryFile' ]
        }
      }
    ]
  });
  const creativeCodeResponse = await creativeCodeStream.finalMessage();
  messages.push({ role: 'assistant', content: creativeCodeResponse.content });

  if (creativeCodeResponse.stop_reason !== 'tool_use') {
    codeFileList = creativeCodeResponse.parsed_output;
    break;
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

  messages.push({ role: 'user', content: toolResults });
}

if (codeFileList === null || codeFileList.length === 0) {
  throw new Error('Missing or empty code file list returned by AI.');
}

console.log(`${codeFileList} code files generated by AI`);

console.log(`Output code directory path: ${codeDirectoryPath}`);

mkdirSync(codeDirectoryPath);

for (const codeFile of codeFileList) {
  const filePath = join(codeDirectoryPath, codeFile.fileName);

  console.log(`Writing file ${filePath} ...`);

 writeFileSync(filePath, codeFile.fileContent, { encoding: 'utf8' });
}

console.log('End.');
