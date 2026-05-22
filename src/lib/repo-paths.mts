import { join } from 'node:path';

/** Repository root (parent of `src/`). Pass `import.meta.dirname` from any file under `src/`. */
export function repoRootFromModuleDir (moduleDirname: string): string {
  return join(moduleDirname, '..', '..');
}
