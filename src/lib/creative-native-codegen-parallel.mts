import type { CreativeNativeCodeFileList } from './creative-native-skills.mts';
import type { AdFormatSelection } from './studio-ad-formats.mts';

export function isParallelFormatCodegenEnabled (): boolean {
  return process.env['CREATIVE_PARALLEL_FORMATS']?.trim() === '1';
}

export function shouldUseParallelFormatCodegen (formats: readonly AdFormatSelection[]): boolean {
  return isParallelFormatCodegenEnabled() && formats.length > 1 && formats.every((f) => f.arche === undefined);
}

/**
 * Merge per-format file bundles into one multi-format creative (prototype).
 * Expects each bundle's index.html to contain a single ad unit; rewrites ids and concatenates CSS/JS.
 */
export function mergeParallelFormatBundles (
  bundles: Array<{ format: AdFormatSelection; files: CreativeNativeCodeFileList }>
): CreativeNativeCodeFileList {
  if (bundles.length === 0) {
    throw new Error('mergeParallelFormatBundles: empty bundles');
  }
  if (bundles.length === 1) {
    return bundles[0]!.files;
  }

  const htmlParts: string[] = [];
  const cssParts: string[] = [ '/* Merged multi-format creative (parallel generation) */' ];
  const jsParts: string[] = [ '(function () { "use strict";' ];

  for (const { format, files } of bundles) {
    const idx = files.find((f) => f.fileName.replace(/\\/g, '/').toLowerCase() === 'index.html');
    const css = files.find((f) => f.fileName.replace(/\\/g, '/').toLowerCase() === 'styles.css');
    const js = files.find((f) => f.fileName.replace(/\\/g, '/').toLowerCase() === 'app.js');
    const wrapperId = `ad-${format.id}`;

    if (idx !== undefined) {
      const bodyMatch = idx.fileContent.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const inner = bodyMatch !== null ? bodyMatch[1]!.trim() : idx.fileContent;
      htmlParts.push(
        `<section class="format-unit" id="${wrapperId}" data-format="${format.id}" aria-label="${format.id} ${String(format.width)}×${String(format.height)}">`,
        inner,
        '</section>'
      );
    }

    if (css !== undefined) {
      cssParts.push(`\n/* --- ${format.id} --- */\n`, css.fileContent);
    }
    if (js !== undefined) {
      jsParts.push(`\n/* --- ${format.id} --- */\n`, js.fileContent);
    }
  }

  const indexHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Creative native — multi-format</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="formats-gallery">
${htmlParts.map((p) => `    ${p}`).join('\n')}
  </div>
  <script src="app.js" defer></script>
</body>
</html>`;

  const stylesCss =
    '.formats-gallery { display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 24px; min-height: 100vh; box-sizing: border-box; }\n'
    + '.format-unit { flex-shrink: 0; }\n'
    + cssParts.join('\n');

  const appJs = jsParts.join('\n') + '\n})();';

  return [
    { fileName: 'index.html', fileContent: indexHtml },
    { fileName: 'styles.css', fileContent: stylesCss },
    { fileName: 'app.js', fileContent: appJs }
  ];
}
