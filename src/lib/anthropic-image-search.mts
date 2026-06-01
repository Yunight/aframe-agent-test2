import type { ImageSearchRow } from './image-search-types.mts';
import { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const anthropicImageSearchSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            url: z.string().url(),
            title: z.string().optional(),
            source: z.string().optional()
          })
          .strict()
      )
      .describe('Direct HTTPS image URLs only (png, webp, jpg, jpeg, svg, gif)')
  })
  .strict();

function parseModelFromEnv (): string {
  const raw = process.env['CREATIVE_ANTHROPIC_IMAGE_SEARCH_MODEL']?.trim();
  return raw !== undefined && raw.length > 0 ? raw : DEFAULT_MODEL;
}

function looksLikeDirectImageUrl (url: string): boolean {
  const lower = url.toLowerCase();
  if (!/^https:\/\//iu.test(lower)) {
    return false;
  }
  return (
    /\.(png|jpe?g|webp|svg|gif)(\?|#|$)/iu.test(lower) ||
    /\/material\/|packshot|logo|wordmark|hero|banner/iu.test(lower)
  );
}

function buildUserPrompt (
  query: string,
  num: number,
  assetKind: 'logo' | 'product'
): string {
  const kindLabel = assetKind === 'logo' ? 'brand logo (transparent SVG or PNG preferred)' : 'product packshot / hero image';
  return (
    `Find up to ${String(num)} direct HTTPS image URLs for: ${query}\n\n` +
    `Asset type: ${kindLabel}.\n` +
    'Use web_search to find official or Wikimedia sources.\n' +
    'Return ONLY direct image file URLs (not HTML pages). Prefer official brand sites.\n' +
    'Each result must be a full URL starting with https:// ending with an image path or extension.'
  );
}

export async function anthropicImageSearch (params: {
  query: string;
  num: number;
  assetKind: 'logo' | 'product';
  officialHosts: readonly string[];
}): Promise<ImageSearchRow[]> {
  const apiKey = process.env['ANTHROPIC_API_KEY']?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('Missing ANTHROPIC_API_KEY for Anthropic image search.');
  }

  const model = parseModelFromEnv();
  const maxUses = Math.min(8, Math.max(2, Math.ceil(params.num / 2)));
  const client = new Anthropic({ apiKey });

  const webSearchTool = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: maxUses,
    ...(params.officialHosts.length > 0 ? { allowed_domains: [ ...params.officialHosts ] } : {})
  } as unknown as Anthropic.Messages.Tool;

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: 'user',
      content: buildUserPrompt(params.query, params.num, params.assetKind)
    }
  ];

  console.log(`[Anthropic images] query="${params.query}" model=${model} max_uses=${String(maxUses)}`);

  for (let turn = 0; turn < 6; turn += 1) {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      tools: [ webSearchTool ],
      messages
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'tool_use') {
      messages.push({
        role: 'user',
        content:
          'Continue searching if needed, then respond with the structured JSON list of direct image URLs only.'
      });
      continue;
    }

    const parseResponse = await client.messages.parse({
      model,
      max_tokens: 2048,
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            `Output the final structured JSON with up to ${String(params.num)} direct image URLs from your search. No HTML page URLs.`
        }
      ],
      output_config: {
        format: zodOutputFormat(anthropicImageSearchSchema)
      }
    });

    const parsed = parseResponse.parsed_output;
    if (parsed === null || parsed.results.length === 0) {
      console.warn(`[Anthropic images] No structured URLs for "${params.query}"`);
      return [];
    }

    const rows: ImageSearchRow[] = [];
    for (const item of parsed.results) {
      if (!looksLikeDirectImageUrl(item.url)) {
        continue;
      }
      rows.push({
        url: item.url,
        title: item.title ?? '',
        source: item.source ?? 'anthropic-web-search',
        properties: { url: item.url, placeholder: '' }
      });
      if (rows.length >= params.num) {
        break;
      }
    }

    console.log(`[Anthropic images] ${String(rows.length)} URL(s) for "${params.query}"`);
    return rows;
  }

  console.warn(`[Anthropic images] Exceeded turns for "${params.query}"`);
  return [];
}
