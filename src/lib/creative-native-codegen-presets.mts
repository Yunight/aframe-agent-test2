/**
 * Studio / CLI presets → env vars for creative codegen (gen-creative-code-native).
 */

export type CreativeCodegenPresetId = 'fast' | 'balanced' | 'quality';

export type CreativeCodegenPresetEnv = Record<string, string>;

const PRESETS: Record<CreativeCodegenPresetId, CreativeCodegenPresetEnv> = {
  fast: {
    CREATIVE_MODEL: 'claude-sonnet-4-6',
    CREATIVE_THINKING_MODE: 'off',
    CREATIVE_PROMPT_CACHE: '0'
  },
  balanced: {
    CREATIVE_MODEL: 'claude-sonnet-4-6',
    CREATIVE_THINKING_MODE: 'adaptive',
    CREATIVE_PROMPT_CACHE: '1'
  },
  quality: {
    CREATIVE_MODEL: 'claude-opus-4-6',
    CREATIVE_THINKING_MODE: 'adaptive',
    CREATIVE_PROMPT_CACHE: '1'
  }
};

export function isCreativeCodegenPresetId (value: string): value is CreativeCodegenPresetId {
  return value === 'fast' || value === 'balanced' || value === 'quality';
}

export function envForCreativeCodegenPreset (preset: CreativeCodegenPresetId): CreativeCodegenPresetEnv {
  return { ...PRESETS[preset] };
}

export function mergePresetIntoProcessEnv (
  preset: CreativeCodegenPresetId | undefined,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (preset === undefined) {
    return { ...base };
  }
  return { ...base, ...envForCreativeCodegenPreset(preset) };
}
