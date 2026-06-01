import { repoRootFromModuleDir } from '../lib/repo-paths.mts';
import { runCreativeNativeGeneration } from '../lib/creative-native-generate.mts';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: join(repoRootFromModuleDir(import.meta.dirname), '.env') });

const directoryUuid = process.argv[2];

if (directoryUuid === undefined) {
  throw new Error('Missing project directory UUID.');
}

const cliArguments = process.argv.slice(3);
for (let i = 0; i < cliArguments.length; i += 1) {
  const argument = cliArguments[i];
  if (argument === '--asset-input') {
    const value = cliArguments[i + 1];
    if (value === 'base64') {
      console.warn(
        '[creative-native] --asset-input base64 is ignored; generation uses precomputed text descriptions only (no vision blocks to Opus).'
      );
    }
    i += 1;
    continue;
  }
  throw new Error(`Unknown argument "${argument}". Allowed option: --asset-input (url only effective).`);
}

await runCreativeNativeGeneration({
  directoryUuid,
  repoRoot: repoRootFromModuleDir(import.meta.dirname)
});
