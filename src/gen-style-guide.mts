import { join, basename } from 'node:path';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

// const contextPrompt = `
//   The brand is Red Bull and the context is the 2026 Winter Olympics in Milan.
// `.trim();
const contextPrompt = `
  The brand is Parkside (by Lidl) and the context is spring and summer DIYers.
`.trim();

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
    throw new Error(`Downloading of file at URL: ${url} failed with status: ${response.status} and error: ${await response.text()}`);
  }

  const body = response.body;

  if (body === null) {
    throw new Error(`Downloading of file at URL: ${url} returned empty body`);
  }

  const fileFetchStream = Readable.fromWeb(body);
  const fileWriteStream = createWriteStream(destinationPath);
  await pipeline(fileFetchStream, fileWriteStream);
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

console.log('Generating style guide ...');

const styleGuideStream = await anthropicClient.messages.stream({
  max_tokens: 128_000,
  system: `
    You are an agent that assembles brand style guides based on external information.
    The information should ideally be sourced from the brand or company's official websites.
    No information should come from the model memory. It should always be fetched remotely to ensure freshness.

    Make sure to understand who the company or brand is and what the context is.
    If a product name or category is specified analyse the problem with it in mind.

    When specifying URLs, always check that they exist and that they are images (JPG, PNG, WEBP, GIF).
    When specifying colors, always check that the color exists and matches the one described in the official sources.

    Find at least four versions of the logo (light theme / dark theme and with brand name / without brand name).
    Find at least four product pictures (light theme / dark theme and a few size and compositions variations).
    Make sure that both the logo and the product pictures have a transparent background.
  `.trim(),
  messages: [{
    role: 'user',
    content: contextPrompt
  }],
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
    }
  ]
});
const styleGuideResponse = await styleGuideStream.finalMessage();

console.log('Stop reason:', styleGuideResponse.stop_reason);
console.log('Stop details:', styleGuideResponse.stop_details);
console.log(styleGuideResponse.parsed_output);

const directoryUuid = randomUUID();
const directoryPath = join(import.meta.dirname, '..', 'output', directoryUuid);

console.log(`Output directory path: ${directoryPath}`);

mkdirSync(directoryPath);

for (const fileType of [ 'logos', 'products' ]) {
  const fileUrls = (fileType === 'logos'
    ? styleGuideResponse.parsed_output?.logoFileUrls
    : fileType === 'products'
      ? styleGuideResponse.parsed_output?.productPictureUrls
      : []
  ) ?? [];

  const subdirectoryPath = join(directoryPath, fileType);
  mkdirSync(subdirectoryPath);

  for (const fileUrl of fileUrls) {
    const logoFileName = basename(fileUrl);
    const logoFileNameSanitized = sanitizeFilename(logoFileName);
    
    const filePath = join(subdirectoryPath, logoFileNameSanitized);

    console.log(`Downloading ${filePath} ...`);

    try {
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
  `${JSON.stringify(styleGuideResponse.parsed_output, null, 2)}\n`,
  { encoding: 'utf8' }
);

console.log('End.');
