# Migration backend — minimum fonctionnel + reviews Haiku

Intégration de :

1. **Génération du style guide** (Opus)
2. **Review assets** (Haiku) — logos, produits, descriptions
3. **Génération du format** (Opus)
4. **Review UI** (Haiku) — screenshots Playwright + corrections ciblées

**Hors scope** : studio UI, API Express, sélecteur de tailles, preview React, habillage, `style-guide-ui/`.

---

## Pipeline complet (4 commandes)

```text
Prompt (marque + contexte)
        │
        ▼
① gen-style-guide.mts                          [Opus]
  → style-guide.json + logos/ + products/
        │
        ▼
② run-style-guide-assets-review.mts            [Haiku]
  → review/assets-review-final.json (satisfied: true)
  → review/asset-descriptions.json
        │
        ▼
③ gen-creative-code-native.mts                 [Opus]
  → code/V1/index.html + styles.css + app.js
        │
        ▼
④ run-creative-native-ui-review.mts            [Haiku + regen Haiku/Sonnet]
  → review/screenshots/*.png
  → review/ui-review-final.json
  → code/V2/… si blockers corrigés
```

---

## Arborescence à copier

```text
<racine>/
├── .env
├── .env.default
├── package.json
├── package-lock.json
├── tsconfig.json
├── shared/
│   └── ad-formats.json
├── .claude/.skills/ui-design/     # 6 fichiers
├── output/                        # créé à l'exécution
└── src/
    ├── agents/                    # 6 fichiers
    └── lib/                       # 49 fichiers
```

---

## Fichiers `src/agents/` (6)

| Fichier | Modèle | Rôle |
|---------|--------|------|
| `gen-style-guide.mts` | Opus | Étape 1 — style guide + téléchargement assets |
| `run-style-guide-assets-review.mts` | Haiku | Étape 2 — review assets (gate obligatoire avant gen format) |
| `creative-native-assets-review.mts` | Haiku | Module agent review assets (importé par étape 2) |
| `gen-creative-code-native.mts` | Opus | Étape 3 — génération HTML/CSS/JS |
| `run-creative-native-ui-review.mts` | Haiku | Étape 4 — screenshots + review visuelle + boucle regen |
| `creative-native-ui-review.mts` | Haiku | Module agent review UI (importé par étape 4) |

---

## Fichiers `src/lib/` (49)

```text
src/lib/anthropic-retry.mts
src/lib/asset-descriptions-audit.mts
src/lib/asset-host-fail-fast.mts
src/lib/asset-sidecar-files.mts
src/lib/brave-image-assets.mts
src/lib/bundle-asset-refs.mts
src/lib/creative-asset-descriptions.mts
src/lib/creative-bundle-assets.mts
src/lib/creative-bundle-integrity.mts
src/lib/creative-code-versions.mts
src/lib/creative-native-ad-dom.mts
src/lib/creative-native-assets-deterministic.mts
src/lib/creative-native-codegen-loop.mts
src/lib/creative-native-codegen-parallel.mts
src/lib/creative-native-codegen-plan.mts
src/lib/creative-native-codegen-prompt.mts
src/lib/creative-native-codegen-regen.mts
src/lib/creative-native-generate.mts
src/lib/creative-native-playwright-screenshots.mts
src/lib/creative-native-regen-deterministic.mts
src/lib/creative-native-regen-diff.mts
src/lib/creative-native-skills-compact.mts
src/lib/creative-native-skills.mts
src/lib/creative-native-ui-review-regen.mts
src/lib/creative-pipeline-usage.mts
src/lib/generic-ad-config.mts
src/lib/image-mime-sniff.mts
src/lib/image-search-types.mts
src/lib/image-search.mts
src/lib/logo-asset-rules.mts
src/lib/logo-asset-sources.mts
src/lib/logo-lock.mts
src/lib/logo-pipeline.mts
src/lib/logo-rasterize.mts
src/lib/logo-search-names.mts
src/lib/logo-transparency-check.mts
src/lib/logo-vision-audit.mts
src/lib/official-fetch.mts
src/lib/official-site-logo-extract.mts
src/lib/product-asset-rules.mts
src/lib/product-asset-sources.mts
src/lib/reference-listing-urls.mts
src/lib/repo-paths.mts
src/lib/studio-ad-formats.mts
src/lib/style-guide-colors.mts
src/lib/style-guide-context.mts
src/lib/style-guide-schema.mts
src/lib/style-guide-typography.mts
src/lib/style-guide-urls.mts
```

> Liste vérifiée par trace d'imports depuis les 5 scripts d'entrée. Les `*.test.mts` sont optionnels.

### Fichiers lib ajoutés par les reviews Haiku (+5)

| Fichier | Review | Rôle |
|---------|--------|------|
| `creative-native-playwright-screenshots.mts` | UI | Captures PNG par format (Playwright) |
| `creative-bundle-integrity.mts` | UI | Vérifs carousel/slides/assets dans l'audit |
| `creative-native-ui-review-regen.mts` | UI | Choix modèle regen + consignes patch minimal |
| `creative-native-regen-deterministic.mts` | UI | Correctifs DOM sans LLM |
| `creative-native-regen-diff.mts` | UI | Garde-fou diff avant/après regen |

---

## Reviews Haiku — détail

### Review assets (étape 2)

Script : `run-style-guide-assets-review.mts`

| Action | Modèle | Entrées | Sorties |
|--------|--------|---------|---------|
| Contrôles déterministes | — | logos/, products/ | findings blocker/warn |
| Describe assets | Haiku | images locales | `review/asset-descriptions.json` |
| Vision audit logo | Haiku | logo SVG/PNG | `review/logo-lock.json` |
| Audit descriptions texte | Haiku | descriptions + contexte | `review/assets-review-final.json` |

Gate : la gen format (étape 3) refuse de tourner si `assets-review-final.json` → `"satisfied": false`.

### Review UI (étape 4)

Script : `run-creative-native-ui-review.mts`

| Action | Modèle | Entrées | Sorties |
|--------|--------|---------|---------|
| Screenshots Playwright | — | `code/Vn/index.html` | `review/screenshots/*.png` |
| Audit visuel | Haiku | screenshots + style guide | `review/ui-review-round-N.json` |
| Regen ciblée | Haiku/Sonnet | bundle existant + feedback | `code/V{n+1}/` |

Boucle jusqu'à `satisfied: true` ou `CREATIVE_UI_REVIEW_MAX_ROUNDS` atteint.

---

## Fichiers hors `src/`

### Obligatoires

| Fichier | Rôle |
|---------|------|
| `shared/ad-formats.json` | Presets IAB ; lu par gen format et review UI |
| `.env` | Clés API |
| `.env.default` | Template |

### Skills design (6 fichiers — style guide uniquement)

```text
.claude/.skills/ui-design/commands/color-palette.md
.claude/.skills/ui-design/commands/type-system.md
.claude/.skills/ui-design/skills/color-system/SKILL.md
.claude/.skills/ui-design/skills/dark-mode-design/SKILL.md
.claude/.skills/ui-design/skills/typography-scale/SKILL.md
.claude/.skills/ui-design/skills/visual-hierarchy/SKILL.md
```

### Config racine

| Fichier | Rôle |
|---------|------|
| `package.json` | Dépendances (sans `express`) |
| `package-lock.json` | Recommandé |
| `tsconfig.json` | Compilation TypeScript |

---

## `package.json` minimal

```json
{
  "module": true,
  "scripts": {
    "build": "tsc"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.89.0",
    "@resvg/resvg-js": "^2.6.2",
    "dotenv": "^17.4.2",
    "image-size": "^2.0.2",
    "mime": "^4.1.0",
    "playwright": "^1.58.2",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^25.6.0",
    "typescript": "^6.0.2"
  }
}
```

`playwright` requis pour :
- rasterisation SVG des logos (review assets),
- screenshots UI (review UI).

```bash
npm install
npx playwright install chromium
```

---

## Choisir le format sans UI

```bash
export CREATIVE_AD_FORMATS='[{"id":"320x480","width":320,"height":480}]'
```

Les `id` / dimensions doivent exister dans `shared/ad-formats.json`. Si absent, le **premier preset** est utilisé.

Pour un format unique figé, ne garder qu'un preset dans `shared/ad-formats.json` :

```json
{
  "presets": [
    { "id": "320x480", "width": 320, "height": 480, "label": "320×480" }
  ]
}
```

---

## Variables d'environnement

### Communes

| Variable | Obligatoire | Rôle |
|----------|-------------|------|
| `ANTHROPIC_API_KEY` | oui | Tous les appels Claude |
| `BRAVE_API_KEY` | oui | Recherche images logo/produits |
| `STYLE_GUIDE_CONTEXT` | oui (étape 1) | Prompt marque + contexte |
| `STYLE_GUIDE_REFERENCE_URL` | non | URL HTTPS campagne/produit |
| `CREATIVE_AD_FORMATS` | non* | Format(s) IAB (* défaut = 1er preset) |

### Review assets (étape 2)

| Variable | Défaut | Rôle |
|----------|--------|------|
| `CREATIVE_ASSETS_REVIEW_MODEL` | `claude-haiku-4-5-20251001` | Modèle Haiku review assets |
| `CREATIVE_ASSETS_REVIEW_MAX_ROUNDS` | `3` | Tours max review + refresh Brave |
| `CREATIVE_IMAGE_SEARCH_PROVIDER` | `brave` | Provider recherche images |

### Génération format (étape 3)

| Variable | Défaut | Rôle |
|----------|--------|------|
| `CREATIVE_MODEL` | `claude-opus-4-6` | Modèle gen initiale |
| `CREATIVE_UI_REVIEW_MAX_ROUNDS` | `0` | Mettre `0` si review UI lancée séparément (étape 4) |

### Review UI (étape 4)

| Variable | Défaut | Rôle |
|----------|--------|------|
| `CREATIVE_UI_REVIEW_MAX_ROUNDS` | `2` | Tours screenshot + review + regen |
| `CREATIVE_UI_REVIEW_MODEL` | `claude-haiku-4-5-20251001` | Modèle audit visuel |
| `CREATIVE_UI_REVIEW_INCLUDE_CODE` | `1` | Injecte annotations + bundle HTML/CSS/JS dans le prompt reviewer |
| `CREATIVE_UI_REVIEW_MAX_FILE_CHARS` | `20000` | Troncature max par fichier de code dans le prompt reviewer |
| `CREATIVE_REGEN_MODEL` | `claude-haiku-4-5-20251001` | Modèle patch regen |
| `CREATIVE_SCREENSHOT_PROFILE` | `fast` | `fast` = 1 capture/format ; `full` = initial + animated + settled |

---

## Intégration avec votre prompt

### Construire le contexte

```typescript
function buildStyleGuideContext(brand: string, context: string): string {
  const b = brand.trim();
  const c = context.trim();
  if (b && c) return `The brand is ${b} and the context is ${c}`;
  if (b) return `The brand is ${b} and the context is not specified beyond the brand; infer positioning from official sites and current campaigns.`;
  if (c) return `No commercial brand was specified. The context is ${c}. Infer visuals, tone, typography, and color direction from official trailers, key art, and distributor or studio materials only.`;
  throw new Error('brand or context required');
}
```

### Orchestration complète (spawn Node)

```typescript
import { spawn } from 'node:child_process';

async function runScript(script: string, args: string[], env: Record<string, string>) {
  return new Promise<{ exitCode: number; stdout: string }>((resolve, reject) => {
    let stdout = '';
    const child = spawn(process.execPath, [script, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (b) => { stdout += b.toString(); });
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout }));
    child.on('error', reject);
  });
}

const formats = JSON.stringify([{ id: '320x480', width: 320, height: 480 }]);
const ctx = buildStyleGuideContext('Nike', 'football summer 2026');

// ① Style guide
const step1 = await runScript('src/agents/gen-style-guide.mts', [], {
  STYLE_GUIDE_CONTEXT: ctx,
});
const folder = /Output directory path:\s*(.+)/.exec(step1.stdout)?.[1]?.trim().split(/[/\\]/).pop()!;

// ② Review assets (Haiku)
await runScript('src/agents/run-style-guide-assets-review.mts', [folder], {});

// ③ Génération format (Opus) — pas de review UI intégrée
await runScript('src/agents/gen-creative-code-native.mts', [folder], {
  CREATIVE_AD_FORMATS: formats,
  CREATIVE_UI_REVIEW_MAX_ROUNDS: '0',
});

// ④ Review UI (Haiku) — screenshots + corrections
await runScript('src/agents/run-creative-native-ui-review.mts', [folder], {
  CREATIVE_AD_FORMATS: formats,
  CREATIVE_UI_REVIEW_MAX_ROUNDS: '2',
  CREATIVE_SCREENSHOT_PROFILE: 'fast',
});
```

### Artefacts à récupérer

| Chemin | Étape |
|--------|-------|
| `output/<folder>/style-guide.json` | ① |
| `output/<folder>/logos/`, `products/` | ① |
| `output/<folder>/review/assets-review-final.json` | ② |
| `output/<folder>/review/asset-descriptions.json` | ② |
| `output/<folder>/code/V1/index.html` (+ css, js) | ③ |
| `output/<folder>/code/V1/generic-config.json` | ③ |
| `output/<folder>/review/screenshots/*.png` | ④ |
| `output/<folder>/review/ui-review-final.json` | ④ |
| `output/<folder>/code/V2/…` | ④ (si regen) |
| `output/<folder>/pipeline-usage.json` | toutes (coûts) |

---

## Script de copie (PowerShell)

```powershell
$SRC = "C:\Users\Ben\Desktop\formats_creator\aframe-agent-test2\aframe-agent-test2"
$DEST = "C:\chemin\vers\nouveau-projet"

Copy-Item "$SRC\package.json", "$SRC\package-lock.json", "$SRC\tsconfig.json", "$SRC\.env.default" -Destination $DEST
New-Item -ItemType Directory -Force -Path "$DEST\shared", "$DEST\src\agents", "$DEST\src\lib", "$DEST\output" | Out-Null
Copy-Item "$SRC\shared\ad-formats.json" -Destination "$DEST\shared\"

# Agents (6)
$agents = @(
  "gen-style-guide.mts",
  "run-style-guide-assets-review.mts",
  "creative-native-assets-review.mts",
  "gen-creative-code-native.mts",
  "run-creative-native-ui-review.mts",
  "creative-native-ui-review.mts"
)
foreach ($a in $agents) { Copy-Item "$SRC\src\agents\$a" -Destination "$DEST\src\agents\" }

# Lib (49)
$libs = @(
  "anthropic-retry.mts","asset-descriptions-audit.mts","asset-host-fail-fast.mts",
  "asset-sidecar-files.mts","brave-image-assets.mts","bundle-asset-refs.mts",
  "creative-asset-descriptions.mts","creative-bundle-assets.mts","creative-bundle-integrity.mts",
  "creative-code-versions.mts","creative-native-ad-dom.mts","creative-native-assets-deterministic.mts",
  "creative-native-codegen-loop.mts","creative-native-codegen-parallel.mts",
  "creative-native-codegen-plan.mts","creative-native-codegen-prompt.mts",
  "creative-native-codegen-regen.mts","creative-native-generate.mts",
  "creative-native-playwright-screenshots.mts","creative-native-regen-deterministic.mts",
  "creative-native-regen-diff.mts","creative-native-skills-compact.mts",
  "creative-native-skills.mts","creative-native-ui-review-regen.mts",
  "creative-pipeline-usage.mts","generic-ad-config.mts","image-mime-sniff.mts",
  "image-search-types.mts","image-search.mts","logo-asset-rules.mts",
  "logo-asset-sources.mts","logo-lock.mts","logo-pipeline.mts","logo-rasterize.mts",
  "logo-search-names.mts","logo-transparency-check.mts","logo-vision-audit.mts",
  "official-fetch.mts","official-site-logo-extract.mts","product-asset-rules.mts",
  "product-asset-sources.mts","reference-listing-urls.mts","repo-paths.mts",
  "studio-ad-formats.mts","style-guide-colors.mts","style-guide-context.mts",
  "style-guide-schema.mts","style-guide-typography.mts","style-guide-urls.mts"
)
foreach ($l in $libs) { Copy-Item "$SRC\src\lib\$l" -Destination "$DEST\src\lib\" }

# Skills (6)
$skills = @(
  ".claude\.skills\ui-design\commands\color-palette.md",
  ".claude\.skills\ui-design\commands\type-system.md",
  ".claude\.skills\ui-design\skills\color-system\SKILL.md",
  ".claude\.skills\ui-design\skills\dark-mode-design\SKILL.md",
  ".claude\.skills\ui-design\skills\typography-scale\SKILL.md",
  ".claude\.skills\ui-design\skills\visual-hierarchy\SKILL.md"
)
foreach ($s in $skills) {
  $target = Join-Path $DEST (Split-Path $s -Parent)
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item (Join-Path $SRC $s) -Destination (Join-Path $DEST $s)
}
```

Puis : `npm install`, créer `.env`, `npx playwright install chromium`.

---

## Exclu explicitement

| Élément | Raison |
|---------|--------|
| `src/studio/` | API Express — orchestration UI |
| `style-guide-ui/` | Frontend React |
| `gen-creative-code-native_habillage.mts` | Habillage arche (pipeline séparé) |
| `run-creative-native-assets-review.mts` | Legacy, remplacé par `run-style-guide-assets-review` |
| `express` dans `package.json` | Studio API uniquement |
| Reste de `.claude/.skills/` | Non importé |

---

## Validation

```bash
export STYLE_GUIDE_CONTEXT="The brand is Nike and the context is football summer 2026"
node src/agents/gen-style-guide.mts

node src/agents/run-style-guide-assets-review.mts <folder>

export CREATIVE_AD_FORMATS='[{"id":"320x480","width":320,"height":480}]'
export CREATIVE_UI_REVIEW_MAX_ROUNDS=0
node src/agents/gen-creative-code-native.mts <folder>

export CREATIVE_UI_REVIEW_MAX_ROUNDS=2
export CREATIVE_SCREENSHOT_PROFILE=fast
node src/agents/run-creative-native-ui-review.mts <folder>
```

Succès si :

- `review/assets-review-final.json` → `"satisfied": true`
- `code/V1/index.html` existe
- `review/ui-review-final.json` → `"satisfied": true` (ou blockers résiduels documentés)
