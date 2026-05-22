# Pipeline créatif — commandes et fichiers `src/`

## Arborescence `src/`

```text
src/
  agents/          # Scripts d’entrée + modules agents (LLM / orchestration)
  lib/             # Utilitaires partagés (Brave, skills, Playwright, ledger, retry)
  studio/          # API studio (Express, jobs SSE)
```

| Dossier | Contenu |
|---------|---------|
| [`src/agents/`](src/agents/) | `gen-style-guide.mts`, `gen-creative-code-native.mts`, `run-creative-native-*-review.mts`, modules review Haiku |
| [`src/lib/`](src/lib/) | `brave-image-assets.mts`, `creative-native-skills.mts`, `creative-pipeline-usage.mts`, `studio-ad-formats.mts`, `anthropic-retry.mts`, `repo-paths.mts`, … |
| [`src/studio/`](src/studio/) | `style-guide-studio-api.mts` |

## Rôle de chaque fichier

| Fichier | Type | Rôle |
|---------|------|------|
| [`agents/gen-style-guide.mts`](src/agents/gen-style-guide.mts) | Script (entrée) | **Étape 1 — Style guide.** Contexte `STYLE_GUIDE_CONTEXT` → `style-guide.json` + `logos/` + `products/`. |
| [`agents/run-creative-native-assets-review.mts`](src/agents/run-creative-native-assets-review.mts) | Script (entrée) | **Étape 2 — Review assets.** Déterministe + Haiku ; retry Brave. |
| [`agents/creative-native-assets-review.mts`](src/agents/creative-native-assets-review.mts) | Module agent | Review assets (Haiku + vision). |
| [`lib/creative-native-assets-deterministic.mts`](src/lib/creative-native-assets-deterministic.mts) | Module | Contrôles sans LLM. |
| [`lib/brave-image-assets.mts`](src/lib/brave-image-assets.mts) | Module | Recherche / téléchargement / refresh Brave. |
| [`agents/gen-creative-code-native.mts`](src/agents/gen-creative-code-native.mts) | Script (entrée) | **Étape 3 — Génération créative** (Opus). Garde `assets-review-final.json`. |
| [`agents/run-creative-native-ui-review.mts`](src/agents/run-creative-native-ui-review.mts) | Script (entrée) | **Étape 4 — Review UI** (optionnel). |
| [`lib/creative-native-playwright-screenshots.mts`](src/lib/creative-native-playwright-screenshots.mts) | Module | Captures Playwright. |
| [`agents/creative-native-ui-review.mts`](src/agents/creative-native-ui-review.mts) | Module agent | Review UI (Haiku + vision). |
| [`lib/creative-native-skills.mts`](src/lib/creative-native-skills.mts) | Module | Skills design + validation Zod. |
| [`lib/studio-ad-formats.mts`](src/lib/studio-ad-formats.mts) | Module | Formats IAB (`shared/ad-formats.json`). |
| [`lib/creative-pipeline-usage.mts`](src/lib/creative-pipeline-usage.mts) | Module | Ledger `pipeline-usage.json`. |
| [`lib/anthropic-retry.mts`](src/lib/anthropic-retry.mts) | Module | Retry API surchargée. |
| [`studio/style-guide-studio-api.mts`](src/studio/style-guide-studio-api.mts) | Serveur | API studio port 3001. |
| [`agents/gen-creative-code-native_habillage.mts`](src/agents/gen-creative-code-native_habillage.mts) | Script (hors pipeline) | Habillage vidéo 16:9. |

### Pipeline native (ordre)

```text
agents/gen-style-guide.mts
    → output/<uuid>/style-guide.json + logos/ + products/
agents/run-creative-native-assets-review.mts
    → review/assets-review-final.json
agents/gen-creative-code-native.mts
    → output/<uuid>/code/
agents/run-creative-native-ui-review.mts   (optionnel)
```

---

## Logs review assets (pre-flight)

À chaque tour de `run-creative-native-assets-review.mts` :

- **Console** : `[assets-review]` et `[assets-deterministic]` avec findings blocker/warn.
- **`review/assets-review.log`** : audit texte (append par round).
- **`review/assets-review-round-N.json`** : audit JSON + usage Haiku.
- **`review/assets-review-final.json`** : `satisfied`, synthèse, findings (requis pour la gen native).

## Logs review UI (ce qui ne va pas)

À chaque tour, l’agent review UI écrit :

- **Console / studio SSE** : `[ui-review] findings:` avec chaque `[blocker|warn]`, issue et fix_hint ; résumé et extrait du `regeneration_prompt`.
- **`review/ui-review.log`** : même contenu en texte (append par round).
- **`review/ui-review-round-N.json`** : audit structuré machine.
- **`review/ui-review-final.json`** : synthèse + lien vers `pipeline_totals_usd`.

---

## Coûts par action (`pipeline-usage.json`)

Fichier central : **`output/<uuid>/pipeline-usage.json`** — une entrée par action, avec tokens et `price_usd`.

| `action` | Agent / script | Modèle | Coût |
|----------|----------------|--------|------|
| `style_guide` | agents/gen-style-guide.mts | Opus | LLM |
| `assets_review` | agents/creative-native-assets-review.mts | Haiku | LLM |
| `assets_refresh` | lib/brave-image-assets.mts | — | 0 USD |
| `creative_generation` | agents/gen-creative-code-native.mts | Opus | LLM |
| `creative_regeneration` | agents/gen-creative-code-native.mts | Haiku | LLM (ajustement après review UI) |
| `screenshots` | lib/creative-native-playwright-screenshots.mts | — | 0 USD |
| `ui_review` | agents/creative-native-ui-review.mts | Haiku | LLM |

En fin de `run-creative-native-ui-review.mts`, un récap **`=== pipeline usage totals ===`** s’affiche en console.

Tarifs (USD / million tokens, surchargeables) :

| Variable | Défaut | Usage |
|----------|--------|--------|
| `CREATIVE_OPUS_INPUT_USD_PER_M` | `5` | gen-style-guide, gen-creative-code-native (génération initiale) |
| `CREATIVE_OPUS_OUTPUT_USD_PER_M` | `25` | idem |
| `CREATIVE_HAIKU_INPUT_USD_PER_M` | `1` | review assets, review UI, regen créative |
| `CREATIVE_HAIKU_OUTPUT_USD_PER_M` | `5` | idem |

**Retry API Anthropic** (`lib/anthropic-retry.mts`) : en cas de `overloaded_error` / rate limit / 529–503, les appels stream/parse sont relancés avec backoff exponentiel. Console : `[anthropic-retry] … nouvelle tentative dans Xs…`.

| Variable | Défaut | Usage |
|----------|--------|--------|
| `ANTHROPIC_RETRY_MAX_ATTEMPTS` | `6` | Nombre max de tentatives par appel |
| `ANTHROPIC_RETRY_BASE_DELAY_MS` | `8000` | Délai de base (×2 par tentative, plafond 120 s) |

Fichiers complémentaires : `creative-native-token-usage.json` (dernière gen), `review/ui-review-token-usage.json` (cumul review seul).

---

## Commandes

### Style guide

```bash
node src/agents/gen-style-guide.mts
```

### Review assets (obligatoire avant gen native)

```bash
node src/agents/run-creative-native-assets-review.mts <directory-uuid>
```

Prérequis : `output/<uuid>/style-guide.json`, `logos/`, `products/`, `BRAVE_API_KEY`, `ANTHROPIC_API_KEY`.

### Code créatif native (génération seule)

```bash
node src/agents/run-creative-native-assets-review.mts <directory-uuid>
set CREATIVE_AD_FORMATS=[{"id":"320x480","width":320,"height":480},{"id":"300x250","width":300,"height":250}]
node src/agents/gen-creative-code-native.mts <directory-uuid> --asset-input url
```

Bypass garde (déconseillé) : `set CREATIVE_ASSETS_REVIEW_SKIP=1` avant la gen.

### Habillage vidéo 16:9 (à part)

```bash
node src/agents/gen-creative-code-native_habillage.mts <directory-uuid> --asset-input url
```

### Agent review UI (screenshots + Haiku, régénération optionnelle)

Après un dossier `code/` existant :

```bash
set CREATIVE_UI_REVIEW_MAX_ROUNDS=3
node src/agents/run-creative-native-ui-review.mts <directory-uuid>
```

Pipeline complet en CLI :

```bash
node src/agents/gen-style-guide.mts
node src/agents/run-creative-native-assets-review.mts <directory-uuid>
set CREATIVE_UI_REVIEW_MAX_ROUNDS=0
node src/agents/gen-creative-code-native.mts <directory-uuid> --asset-input url
set CREATIVE_UI_REVIEW_MAX_ROUNDS=3
node src/agents/run-creative-native-ui-review.mts <directory-uuid>
```

### Studio UI

```bash
node src/studio/style-guide-studio-api.mts
```

Puis lancer `style-guide-ui` (Vite).

**Section « Marque ou contenu »** (`POST /api/style-guide/run`) :

- **`assetsReviewAfterGeneration`** (checkbox UI, défaut coché) : après `gen-style-guide.mts`, enchaîne `run-creative-native-assets-review.mts` sur le dossier créé.

**Section « Code créatif »** (`POST /api/creative-code/run`, script `gen-creative-code-native.mts`) :

- **`assetsReviewBeforeGeneration`** : review assets puis gen (si pas déjà validé).
- **`uiReviewAfterGeneration`** : gen puis review UI.

### Variables d'environnement (review assets)

| Variable | Défaut | Rôle |
|----------|--------|------|
| `CREATIVE_ASSETS_REVIEW_MAX_ROUNDS` | `3` | Tours review assets + retry Brave max |
| `CREATIVE_ASSETS_REVIEW_MODEL` | `claude-haiku-4-5-20251001` | Modèle review assets |
| `CREATIVE_ASSETS_REVIEW_SKIP` | — | `1` = bypass garde dans gen-creative-code-native |
| `CREATIVE_ASSETS_MIN_LOGO_W` | `120` | Largeur min logo (px) |
| `CREATIVE_ASSETS_MIN_LOGO_H` | `40` | Hauteur min logo (px) |
| `CREATIVE_ASSETS_MIN_PRODUCT_W` | `200` | Largeur min produit (px) |
| `CREATIVE_ASSETS_MIN_PRODUCT_H` | `200` | Hauteur min produit (px) |
| `CREATIVE_ASSETS_MAX_FILE_BYTES` | `5242880` | Taille max fichier (5 Mo) |
| `BRAVE_API_KEY` | — | Requis pour refresh images |
| `BRAVE_PRODUCT_CANDIDATE_POOL` | `20` | Candidats URL Brave avant filtre download (produits) |
| `BRAVE_PRODUCT_TARGET_COUNT` | `6` | Nombre cible de fichiers produit valides (≥ min px) |
| `BRAVE_PRODUCT_MIN_CONTENT_LENGTH` | `30000` | Ignore URLs produit dont le HEAD `Content-Length` est trop petit (thumbs) |
| `BRAVE_LOGO_CANDIDATE_POOL` | `30` | Candidats URL logo avant téléchargement |
| `BRAVE_PRODUCT_MIN_REPORTED_W` | `400` | Bonus score Brave si `properties.width` ≥ cette valeur |
| `BRAVE_PRODUCT_MIN_REPORTED_H` | `300` | Bonus score Brave si `properties.height` ≥ cette valeur |
| `CREATIVE_ASSETS_LOGO_MIN_TRANSPARENT_RATIO` | `0.02` | Seuil faux « transparent » en mode strict uniquement |
| `CREATIVE_ASSETS_LOGO_REQUIRE_TRANSPARENT` | — | `1` = mode strict (rejette JPEG/opaque PNG) ; défaut = logos opaques et SVG OK |

### Variables d'environnement (review UI)

| Variable | Défaut | Rôle |
|----------|--------|------|
| `CREATIVE_UI_REVIEW_MAX_ROUNDS` | `3` | Tours screenshot + review + regen max |
| `CREATIVE_UI_REVIEW_MODEL` | `claude-haiku-4-5-20251001` | Modèle review visuelle |
| `CREATIVE_SCREENSHOT_INITIAL_WAIT_MS` | `600` | Délai capture `initial` |
| `CREATIVE_SCREENSHOT_ANIMATED_WAIT_MS` | `2500` | Délai capture `animated` |
| `CREATIVE_SCREENSHOT_SETTLED_WAIT_MS` | `5000` | Délai capture `settled` |
| `CREATIVE_REGEN_FEEDBACK` | — | Message injecté dans gen (usage interne, regen après review) |
| `CREATIVE_REGEN_MODEL` | `claude-haiku-4-5-20251001` | Modèle regen créative (ajustement post-review UI) |
| `CREATIVE_REGEN_REVIEW_ROUND` | — | Numéro de tour review pour l’entrée `creative_regeneration` |
| `CREATIVE_OPUS_INPUT_USD_PER_M` | `5` | Tarif input Opus (pipeline-usage.json) |
| `CREATIVE_OPUS_OUTPUT_USD_PER_M` | `25` | Tarif output Opus |
| `CREATIVE_HAIKU_INPUT_USD_PER_M` | `1` | Tarif input Haiku (review + regen) |
| `CREATIVE_HAIKU_OUTPUT_USD_PER_M` | `5` | Tarif output Haiku |
| `ANTHROPIC_API_KEY` | — | Requis pour tous les scripts Claude |
| `ANTHROPIC_RETRY_MAX_ATTEMPTS` | `6` | Retries sur surcharge API (`overloaded_error`, etc.) |
| `ANTHROPIC_RETRY_BASE_DELAY_MS` | `8000` | Délai initial entre tentatives (ms) |

### Artefacts

| Chemin | Produit par |
|--------|-------------|
| `output/<uuid>/style-guide.json` | gen-style-guide |
| `output/<uuid>/pipeline-usage.json` | Tous les agents (append cumulatif) |
| `output/<uuid>/code/` | gen-creative-code-native |
| `output/<uuid>/creative-native-ad-formats.json` | gen-creative-code-native |
| `output/<uuid>/creative-native-token-usage.json` | Dernière exécution gen native |
| `output/<uuid>/review/screenshots/*.png` | Playwright (via run-creative-native-ui-review) |
| `output/<uuid>/review/assets-review-final.json` | Synthèse review assets (gate gen) |
| `output/<uuid>/review/assets-review.log` | Logs review assets |
| `output/<uuid>/review/assets-review-round-N.json` | Audit JSON assets par tour |
| `output/<uuid>/review/brave-excluded-urls.json` | URLs rejetées (thumb / sous-dimension) pour ne pas les re-télécharger |
| `output/<uuid>/review/ui-review-round-N.json` | Audit JSON UI par tour |
| `output/<uuid>/review/ui-review-token-usage.json` | Tokens review UI (avec `price_usd`) |
