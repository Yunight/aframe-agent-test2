import { join, basename, extname } from 'node:path';
import { mkdirSync, createWriteStream, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

interface BraveImageResult {
  type: 'image_result';
  title: string;
  url: string;
  source: string;
  page_fetched: string;
  thumbnail: { src: string };
  properties: {
    url: string;
    placeholder: string;
  };
  meta_url: {
    scheme: string;
    netloc: string;
    hostname: string;
    favicon: string;
    path: string;
  };
}
 
interface BraveImageSearchResponse {
  type: 'images';
  query: {
    original: string;
    altered?: string;
    spellcheck_off?: boolean;
    show_strict_warning?: boolean;
  };
  results: BraveImageResult[];
}

const allowedImageMimeTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

const mimeTypeToExtension: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const contextPrompt = `
  The brand is super mario galaxy the movie and the context is for the new movie they are launching.
`.trim();

const skillFiles = [
  '.claude/.skills/ui-design/commands/color-palette.md',
  '.claude/.skills/ui-design/commands/type-system.md',
  '.claude/.skills/ui-design/skills/color-system/SKILL.md',
  '.claude/.skills/ui-design/skills/dark-mode-design/SKILL.md',
  '.claude/.skills/ui-design/skills/typography-scale/SKILL.md',
  '.claude/.skills/ui-design/skills/visual-hierarchy/SKILL.md'
] as const;

function loadSkillGuidance (): string {
  const rootDir = join(import.meta.dirname, '..');
  const loadedSkills = skillFiles
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
    throw new Error('No local skill files were found in .claude/.skills.');
  }

  return loadedSkills.join('\n\n');
}

function sanitizeFilename (name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

async function downloadFileToFileSystem (url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      Accept: '*/*'
    }
  });

  if (!response.ok) {
    throw new Error(`Downloading of file at URL: ${url} failed with status: ${response.status}`);
  }

  const body = response.body;

  if (body === null) {
    throw new Error(`Downloading of file at URL: ${url} returned empty body`);
  }

  const fileFetchStream = Readable.fromWeb(body);
  const fileWriteStream = createWriteStream(destinationPath);
  await pipeline(fileFetchStream, fileWriteStream);
}

async function resolveRemoteImageMetadata(url: string): Promise<{ mimeType: string, extension: string }> {
  const headResponse = await fetch(url, {
    method: 'HEAD',
    headers: {
      Accept: 'image/*'
    }
  });

  if (!headResponse.ok) {
    throw new Error(`Unable to validate image URL ${url}. HEAD request failed with status ${headResponse.status}`);
  }

  const contentTypeHeader = headResponse.headers.get('content-type') ?? '';
  const mimeType = contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? '';

  if (!allowedImageMimeTypes.has(mimeType)) {
    throw new Error(`URL ${url} has unsupported content-type "${contentTypeHeader}"`);
  }

  const extension = mimeTypeToExtension[mimeType];
  if (extension === undefined) {
    throw new Error(`Unsupported MIME type "${mimeType}" for URL ${url}`);
  }

  return { mimeType, extension };
}

async function braveImageSearch (
  { query, num = 10 }:
  { query: string, num: number }
): Promise<BraveImageResult[]> {
    const params = new URLSearchParams();

    params.set('q', query);
    params.set('count', Math.min(Math.max(num, 1), 200).toString());
    params.set('search_lang', 'en');
    params.set('country', 'US');
    params.set('safesearch', 'strict');
    params.set('spellcheck', '0');
 
    const url = `https://api.search.brave.com/res/v1/images/search?${params.toString()}`;
 
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': process.env['BRAVE_API_KEY'] ?? '',
      }
    });
 
    if (!response.ok) {
      throw new Error(`Brave image search failed: ${response.status} and error: ${await response.text() ?? ''}`);
    }
 
    return ((await response.json()) as BraveImageSearchResponse).results;
}

const brandStyleGuideSchema = z.object({
  companyName: z.string().describe('Company name.'),
  companyContext: z.string().describe('What does the company do?'),
  companyURL: z.url().describe('URL of company.'),
  brandName: z.string().describe('Brand name.'),
  brandContext: z.string().describe('What does the brand do?'),
  brandURL: z.url().describe('URL of brand.'),
  logoFileUrls: z.array(z.url()).describe('List of brand image logo URLs in different variants.'),
  productName: z.string().describe('Name of product if one is specified'),
  productPictureUrls: z.array(z.url()).describe('List of product pictures or packshots URLs in different variants.'),
  primaryColorPalette: z.array(z.hex()).describe('List of hexadecimal codes for the colors of primary color palette in descending order of importants.'),
  secondaryColorPalette: z.array(z.hex()).describe('List of hexadecimal codes for the colors of secondary color palette in descending order of importants.'),
  typography: z.array(
    z.object({
      fontFamily: z.string().describe('Font family name'),
      fontWeight: z.number().describe('Font weight as used in CSS'),
      fontEffect: z.array(z.enum([ 'bold', 'italic', 'underline', 'strikethrough' ])).describe('Font effects'),
      fontUses: z.string().describe('Context in which to use said font setting. i.e: brand name, heading, text body, etc.')
    })
  ),
  brandVision: z.string().describe('Direction taken by the brand.'),
  brandValues: z.string().describe('What does the brand or company stand for?')
})
  .describe('Brand style guide object')
  .strict();

export type StyleGuide = z.infer<typeof brandStyleGuideSchema>;

loadDotenv({ path: join(import.meta.dirname, '..', '.env') });
const anthropicApiKey = process.env['ANTHROPIC_API_KEY'];
if (anthropicApiKey === undefined || anthropicApiKey.trim().length === 0) {
  throw new Error('Missing ANTHROPIC_API_KEY. Set it in project root .env or export it in your shell.');
}

const anthropicClient = new Anthropic({
  apiKey: anthropicApiKey
});
const messages: Anthropic.Messages.MessageParam[] = [{
  role: 'user',
  content: contextPrompt
}];
let finalMessageContent = null;
const localSkillGuidance = loadSkillGuidance();

let i = 0;

while (true) {
  i += 1;

  console.log(`Generating style guide ... (i=${i})`);

  const styleGuideStream = await anthropicClient.messages.stream({
    max_tokens: 128_000,
    system: `
      You are an agent that assembles brand style guides based on external information.
      The information should ideally be sourced from the brand or company's official websites.
      No information should come from the model memory. It should always be fetched remotely to ensure freshness.

      Make sure to understand who the company or brand is and what the context is.
      If a product name or category is specified analyse the problem with it in mind.

      When specifying URLs, always check that they exist and that they are images (JPG, PNG, WEBP, GIF), filetype must be one of the following: JPG, PNG, WEBP, GIF, the logo should always be a transparent PNG file, even if the filename ends with .png you have to check that it is a transparent PNG file.
      the logo should always be a transparent PNG file.

      When specifying colors, always check that the color exists and matches the one described in the official sources.

      Find at least four versions of the logo (light theme / dark theme and with brand name / without brand name).
      Find at least four product pictures (light theme / dark theme and a few size and compositions variations).

      Search for images using the Google Image Search tool.

      The local design skills below are mandatory constraints.
      Before returning final JSON, internally run a compliance check against these skills.
      If any skill rule is not satisfied, keep searching and refining, and do not finalize yet.
      ${localSkillGuidance}
    `.trim(),
    messages,
    model: 'claude-opus-4-6',
    thinking: {
      type: 'enabled',
      budget_tokens: 100_000,
      display: 'omitted'
    },
    output_config: {
      format: zodOutputFormat(brandStyleGuideSchema)
    },
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 25
      },
      {
        name: 'google_image_search',
        description: `
          Search Google Images and return a list of matching images
          (title, direct image URL, source page, dimensions).
          Use this when the user asks for pictures, references, or visual examples of something.
        `.trim(),
        input_schema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query.',
            },
            num: {
              type: 'integer',
              description: 'How many results to return (1-10).',
              minimum: 1,
              maximum: 20,
            }
          },
          required: [ 'query' ]
        }
      }
    ]
  });
  const styleGuideResponse = await styleGuideStream.finalMessage();

  messages.push({ role: 'assistant', content: styleGuideResponse.content });

  console.log('[Claude]', JSON.stringify(styleGuideResponse.content).slice(0, 100), '...');

  if (styleGuideResponse.stop_reason !== 'tool_use') {
    console.log('Stop reason:', styleGuideResponse.stop_reason);
    console.log('Stop details:', styleGuideResponse.stop_details);
    console.log(styleGuideResponse.parsed_output);
    finalMessageContent = styleGuideResponse.parsed_output;
    break;
  }

  const toolResults: Anthropic.ToolResultBlockParam[] = [];

  for (const block of styleGuideResponse.content) {
    if (block.type === 'tool_use' && block.name === 'google_image_search') {
      const args = block.input as Parameters<typeof braveImageSearch>[0];

      try {
        const result = await braveImageSearch(args);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error(`Error while fetching Google Images with query ${args.query} ${err.name}:${err.message}\n${err.stack ?? ''}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `Error: ${err.message}`,
            is_error: true,
          });
        }
      }
    }
  }

  messages.push({ role: 'user', content: toolResults });
}

if (finalMessageContent === null) {
  throw new Error('Empty style guide response');
}

const directoryUuid = randomUUID();
const directoryPath = join(import.meta.dirname, '..', 'output', directoryUuid);

console.log(`Output directory path: ${directoryPath}`);

mkdirSync(directoryPath);

for (const fileType of [ 'logos', 'products' ]) {
  const fileUrls = (fileType === 'logos'
    ? finalMessageContent?.logoFileUrls
    : fileType === 'products'
      ? finalMessageContent?.productPictureUrls
      : []
  ) ?? [];

  const subdirectoryPath = join(directoryPath, fileType);
  mkdirSync(subdirectoryPath);

  for (const fileUrl of fileUrls) {
    const logoFileName = basename(fileUrl);
    const logoFileNameSanitized = sanitizeFilename(logoFileName);
    const originalExtension = extname(logoFileNameSanitized).toLowerCase();

    try {
      const { mimeType, extension } = await resolveRemoteImageMetadata(fileUrl);
      const resolvedFileName = originalExtension === extension
        ? logoFileNameSanitized
        : `${logoFileNameSanitized.replace(/\.[^.]+$/, '')}${extension}`;
      const filePath = join(subdirectoryPath, resolvedFileName);

      if (originalExtension !== extension) {
        console.warn(`[download] Extension mismatch for ${fileUrl}. Original "${originalExtension || 'none'}", remote "${mimeType}". Saving as ${resolvedFileName}.`);
      }

      console.log(`Downloading ${filePath} ...`);
      await downloadFileToFileSystem(fileUrl, filePath);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error(err);
      }
    }
  }
}

const styleGuideFilePath = join(directoryPath, 'style-guide.json');
writeFileSync(
  styleGuideFilePath,
  `${JSON.stringify(finalMessageContent, null, 2)}\n`,
  { encoding: 'utf8' }
);

console.log('End.');
