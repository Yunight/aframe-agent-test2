import { withAnthropicRetry } from './anthropic-retry.mts';
import type { StyleGuide } from '../agents/gen-style-guide.mjs';
import {
  creativeNativeStructuredOutputFilesSchema,
  validateCreativeSkillCompliance,
  type AssetFile,
  type CreativeNativeCodeFileList
} from './creative-native-skills.mts';
import {
  buildCachedSystemParam,
  buildCodegenSystemParts,
  buildInitialThinkingConfig,
  type CodegenSystemParts
} from './creative-native-codegen-prompt.mts';
import { buildComplianceRetryHint } from './style-guide-colors.mts';
import {
  buildCodePhaseUserMessage,
  buildPlanPhaseUserMessage,
  creativeNativePlanSchema,
  isTwoPhaseCodegenEnabled,
  type CreativeNativePlan
} from './creative-native-codegen-plan.mts';
import {
  mergeParallelFormatBundles,
  shouldUseParallelFormatCodegen
} from './creative-native-codegen-parallel.mts';
import type { AdFormatSelection } from './studio-ad-formats.mts';
import { buildCreativeAdFormatInstructions } from './studio-ad-formats.mts';
import {
  addUsageToAccumulator,
  createEmptyUsageAccumulator,
  formatDurationMinSec,
  mergeUsageAccumulators,
  type UsageAccumulator
} from './creative-pipeline-usage.mts';
import type { Anthropic } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

const CREATIVE_OPUS_MAX_OUTPUT_TOKENS = 128_000;
const CREATIVE_HAIKU_MAX_OUTPUT_TOKENS = 64_000;

export function maxOutputTokensForModel (model: string): number {
  return model.toLowerCase().includes('haiku')
    ? CREATIVE_HAIKU_MAX_OUTPUT_TOKENS
    : CREATIVE_OPUS_MAX_OUTPUT_TOKENS;
}

export type CodegenTurnTiming = {
  turn: number;
  duration_ms: number;
  stop_reason: string | null;
  /** Set when formats are generated in parallel (e.g. `banner 300x250`). */
  format_label?: string;
};

export type CodegenLoopResult = {
  files: CreativeNativeCodeFileList;
  usage: UsageAccumulator;
  timings: CodegenTurnTiming[];
  duration_ms_total: number;
};

function describeTurnForLogs (stopReason: Anthropic.Message['stop_reason']): string {
  return stopReason !== null && stopReason !== undefined ? `arrêt: ${stopReason}` : 'réponse API';
}

async function runSingleCodegenLoop (params: {
  anthropicClient: Anthropic;
  model: string;
  isRegen: boolean;
  systemParts: CodegenSystemParts;
  messages: Anthropic.Messages.MessageParam[];
  adFormats: readonly AdFormatSelection[];
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  assetFiles: AssetFile[];
  extraSystemDynamic?: string;
}): Promise<CodegenLoopResult> {
  const filesSchema = creativeNativeStructuredOutputFilesSchema;
  const usage = createEmptyUsageAccumulator();
  const timings: CodegenTurnTiming[] = [];
  const loopStart = Date.now();

  let codeFileList: CreativeNativeCodeFileList | null = null;
  let generationIndex = 0;
  const maxGenerationTurns = 8;
  let structuredOutputRetryCount = 0;
  const maxStructuredOutputRetries = 2;
  const messages = [ ...params.messages ];

  while (true) {
    generationIndex += 1;
    if (generationIndex > maxGenerationTurns) {
      throw new Error(`Generation exceeded ${maxGenerationTurns} turns without valid output.`);
    }

    const turnStart = Date.now();
    const thinkingConfig = buildInitialThinkingConfig(params.isRegen);

    const creativeCodeResponse = await withAnthropicRetry('creative generation', async () => {
      const streamParams: Anthropic.Messages.MessageCreateParams = {
        max_tokens: maxOutputTokensForModel(params.model),
        system: buildCachedSystemParam(params.systemParts, params.extraSystemDynamic),
        messages,
        model: params.model,
        output_config: {
          format: zodOutputFormat(filesSchema)
        },
        ...(thinkingConfig ?? {})
      };
      const stream = await params.anthropicClient.messages.stream(streamParams);
      return await stream.finalMessage();
    });

    const turnMs = Date.now() - turnStart;
    timings.push({
      turn: generationIndex,
      duration_ms: turnMs,
      stop_reason: creativeCodeResponse.stop_reason
    });
    const cacheRead = creativeCodeResponse.usage.cache_read_input_tokens ?? 0;
    const cacheCreate = creativeCodeResponse.usage.cache_creation_input_tokens ?? 0;
    console.log(
      `[creative-native] Turn ${String(generationIndex)}: ${formatDurationMinSec(turnMs)} — ${describeTurnForLogs(creativeCodeResponse.stop_reason)}`
        + (cacheRead > 0 || cacheCreate > 0
          ? ` (cache read ${String(cacheRead)}, create ${String(cacheCreate)})`
          : '')
    );

    addUsageToAccumulator(usage, creativeCodeResponse.usage);
    messages.push({ role: 'assistant', content: creativeCodeResponse.content });

    if (creativeCodeResponse.stop_reason !== 'tool_use') {
      const parsedFiles = creativeCodeResponse.parsed_output as CreativeNativeCodeFileList | null;
      if (parsedFiles !== null && parsedFiles.length > 0) {
        const complianceCheck = validateCreativeSkillCompliance(
          parsedFiles,
          params.prunedStyleGuide,
          params.assetFiles,
          params.adFormats
        );
        if (complianceCheck.ok) {
          codeFileList = parsedFiles;
          break;
        }

        structuredOutputRetryCount += 1;
        if (structuredOutputRetryCount > maxStructuredOutputRetries) {
          throw new Error(`AI output failed skill compliance checks: ${complianceCheck.issues.join(' | ')}`);
        }

        const regenHint = params.isRegen
          ? 'Apply a minimal patch to the existing bundle; do not rewrite unrelated CSS/HTML.'
          : 'Regenerate all files and fix every issue.';
        messages.push({
          role: 'user',
          content:
            `Your previous output is not compliant with mandatory skills/style-guide constraints: ${complianceCheck.issues.join(' ; ')}. `
            + `${regenHint} Required ad sizes (px): ${params.adFormats.map((f) => `${String(f.width)}×${String(f.height)}`).join(', ')}.`
            + buildComplianceRetryHint(complianceCheck.issues, params.prunedStyleGuide)
        });
        continue;
      }

      structuredOutputRetryCount += 1;
      if (structuredOutputRetryCount > maxStructuredOutputRetries) {
        throw new Error('AI returned no structured code output after retries.');
      }

      messages.push({
        role: 'user',
        content:
          'Your previous response did not include the required structured file list. Respond now with only valid structured output matching the expected schema.'
      });
      continue;
    }

    messages.push({
      role: 'user',
      content:
        'Continue: return the structured file list (index.html, styles.css, app.js) matching the schema. '
        + `Respect every required ad size: ${params.adFormats.map((f) => `${String(f.width)}×${String(f.height)}`).join(', ')}.`
    });
  }

  if (codeFileList === null || codeFileList.length === 0) {
    throw new Error('Missing or empty code file list returned by AI.');
  }

  return {
    files: codeFileList,
    usage,
    timings,
    duration_ms_total: Date.now() - loopStart
  };
}

async function runPlanPhase (params: {
  anthropicClient: Anthropic;
  model: string;
  systemParts: CodegenSystemParts;
  baseMessages: Anthropic.Messages.MessageParam[];
  adFormats: readonly AdFormatSelection[];
}): Promise<{ plan: CreativeNativePlan; usage: UsageAccumulator }> {
  const usage = createEmptyUsageAccumulator();
  const messages: Anthropic.Messages.MessageParam[] = [
    ...params.baseMessages,
    { role: 'user', content: buildPlanPhaseUserMessage(params.adFormats) }
  ];

  const planStart = Date.now();
  const planThinking = buildInitialThinkingConfig(false);
  const response = await withAnthropicRetry('creative plan phase', async () => {
    const stream = await params.anthropicClient.messages.stream({
      max_tokens: Math.min(16_000, maxOutputTokensForModel(params.model)),
      system: buildCachedSystemParam(params.systemParts),
      messages,
      model: params.model,
      output_config: { format: zodOutputFormat(creativeNativePlanSchema) },
      ...(planThinking ?? {})
    });
    return await stream.finalMessage();
  });
  console.log(`[creative-native] Plan phase: ${formatDurationMinSec(Date.now() - planStart)}`);

  addUsageToAccumulator(usage, response.usage);
  if (response.parsed_output === null) {
    throw new Error('Two-phase codegen: plan phase returned no structured output.');
  }
  return { plan: response.parsed_output, usage };
}

export async function runCreativeCodegen (params: {
  anthropicClient: Anthropic;
  model: string;
  isRegen: boolean;
  repoRoot: string;
  skillsText: string;
  baseMessages: Anthropic.Messages.MessageParam[];
  adFormats: readonly AdFormatSelection[];
  prunedStyleGuide: Omit<StyleGuide, 'logoFileUrls' | 'productPictureUrls'>;
  assetFiles: AssetFile[];
}): Promise<CodegenLoopResult> {
  const productAssetCount = params.assetFiles.filter((a) => a.fileType === 'products').length;
  const systemParts = buildCodegenSystemParts({
    isRegen: params.isRegen,
    adFormats: params.adFormats,
    skillsText: params.skillsText,
    styleGuide: params.prunedStyleGuide,
    productAssetCount
  });

  if (params.isRegen) {
    return runSingleCodegenLoop({
      anthropicClient: params.anthropicClient,
      model: params.model,
      isRegen: true,
      systemParts,
      messages: params.baseMessages,
      adFormats: params.adFormats,
      prunedStyleGuide: params.prunedStyleGuide,
      assetFiles: params.assetFiles
    });
  }

  if (shouldUseParallelFormatCodegen(params.adFormats)) {
    console.log(`[creative-native] Parallel format generation (${String(params.adFormats.length)} formats)`);
    const totalUsage = createEmptyUsageAccumulator();
    const allTimings: CodegenTurnTiming[] = [];
    const loopStart = Date.now();
    const bundles: Array<{ format: AdFormatSelection; files: CreativeNativeCodeFileList }> = [];

    const results = await Promise.all(
      params.adFormats.map(async (format) => {
        const singleFormat = [ format ] as const;
        const parts = buildCodegenSystemParts({
          isRegen: false,
          adFormats: singleFormat,
          skillsText: params.skillsText,
          styleGuide: params.prunedStyleGuide,
          productAssetCount
        });
        const formatInstructions = buildCreativeAdFormatInstructions(singleFormat);
        const extraDynamic = `Generate ONLY for this single format. ${formatInstructions}`;
        const result = await runSingleCodegenLoop({
          anthropicClient: params.anthropicClient,
          model: params.model,
          isRegen: false,
          systemParts: parts,
          messages: [ ...params.baseMessages ],
          adFormats: singleFormat,
          prunedStyleGuide: params.prunedStyleGuide,
          assetFiles: params.assetFiles,
          extraSystemDynamic: extraDynamic
        });
        return { format, result };
      })
    );

    for (const { format, result } of results) {
      mergeUsageAccumulators(totalUsage, result.usage);
      const formatLabel = `${format.id} ${String(format.width)}x${String(format.height)}`;
      for (const t of result.timings) {
        allTimings.push({ ...t, format_label: formatLabel });
      }
      bundles.push({ format, files: result.files });
    }

    const merged = mergeParallelFormatBundles(bundles);
    const compliance = validateCreativeSkillCompliance(
      merged,
      params.prunedStyleGuide,
      params.assetFiles,
      params.adFormats
    );
    if (!compliance.ok) {
      console.warn('[creative-native] Merged parallel bundle failed compliance; running single-pass fallback.');
    } else {
      return {
        files: merged,
        usage: totalUsage,
        timings: allTimings,
        duration_ms_total: Date.now() - loopStart
      };
    }
  }

  if (isTwoPhaseCodegenEnabled()) {
    console.log('[creative-native] Two-phase generation (plan → code)');
    const { plan, usage: planUsage } = await runPlanPhase({
      anthropicClient: params.anthropicClient,
      model: params.model,
      systemParts,
      baseMessages: params.baseMessages,
      adFormats: params.adFormats
    });

    const codeMessages: Anthropic.Messages.MessageParam[] = [
      ...params.baseMessages,
      { role: 'user', content: buildCodePhaseUserMessage(plan) }
    ];

    const codeResult = await runSingleCodegenLoop({
      anthropicClient: params.anthropicClient,
      model: params.model,
      isRegen: false,
      systemParts,
      messages: codeMessages,
      adFormats: params.adFormats,
      prunedStyleGuide: params.prunedStyleGuide,
      assetFiles: params.assetFiles
    });

    mergeUsageAccumulators(planUsage, codeResult.usage);
    return {
      files: codeResult.files,
      usage: planUsage,
      timings: codeResult.timings,
      duration_ms_total: codeResult.duration_ms_total
    };
  }

  return runSingleCodegenLoop({
    anthropicClient: params.anthropicClient,
    model: params.model,
    isRegen: false,
    systemParts,
    messages: params.baseMessages,
    adFormats: params.adFormats,
    prunedStyleGuide: params.prunedStyleGuide,
    assetFiles: params.assetFiles
  });
}
