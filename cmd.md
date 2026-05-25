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
    → output/<brand-slug>-<uuid>/style-guide.json + logos/ + products/ (ex. `petit-bateau-5629c8bd-…`)
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

Fichier central : **`output/<brand-slug>-<uuid>/pipeline-usage.json`** — une entrée par action, avec tokens, `price_usd` et **durées**.

Par entrée :

- `duration_ms` — durée murale de l’étape (script complet)
- `api_call_timings[]` — une ligne par réponse Claude (`call_index`, `duration_ms`, `stop_reason`, `label`)

Totaux (`totals`) :

- `duration_ms` — somme des durées d’étapes
- `claude_api_duration_ms` — somme des appels Claude
- `wall_clock_ms` — écart entre premier et dernier `timestamp` des entrées

`run_summary` (fin de job studio ou fin de script `run-*`) :

- `wall_clock_ms` — chrono job studio ou script runner
- `claude_api_calls` / `claude_api_duration_ms`

Studio UI : panneau **Coûts et durées** après un job réussi (`GET /api/output/:folderName/pipeline-usage`).

| `action` | Agent / script | Modèle | Coût |
|----------|----------------|--------|------|
| `style_guide` | agents/gen-style-guide.mts | Opus | LLM |
| `assets_review` | agents/creative-native-assets-review.mts | Haiku | LLM |
| `assets_refresh` | lib/brave-image-assets.mts | — | 0 USD |
| `creative_generation` | agents/gen-creative-code-native.mts | `CREATIVE_MODEL` (déf. Opus) | LLM |
| `creative_regeneration` | agents/gen-creative-code-native.mts | Haiku (forcé en review UI) | LLM — patch du bundle `code/` existant |
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

**Recherche d’images** : les logos/produits sont trouvés à l’étape style guide (`web_search` Opus + **Brave Images API**), pas pendant `gen-creative-code-native`. La gen code n’utilise plus `web_search` — uniquement les assets locaux + le JSON style guide.

#### Profils de génération code (vitesse / coût / qualité)

| Profil | Variables suggérées | Usage |
|--------|---------------------|--------|
| **fast** | `CREATIVE_MODEL=claude-sonnet-4-6` `CREATIVE_THINKING_MODE=off` | Itération rapide |
| **balanced** | `CREATIVE_MODEL=claude-sonnet-4-6` (gen) + regen Haiku par défaut | Bon compromis |
| **quality** | défauts (`CREATIVE_MODEL=claude-opus-4-6`, thinking adaptive) | Livraison finale |

Dans le **studio UI**, le sélecteur « Profil génération code » envoie `creativeCodegenPreset` (`fast` \| `balanced` \| `quality`) à `POST /api/creative-code/run` (même mapping que le tableau ci-dessus).

Exemple profil balanced (1 format) :

```bash
set CREATIVE_MODEL=claude-sonnet-4-6
set CREATIVE_AD_FORMATS=[{"id":"320x480","width":320,"height":480}]
node src/agents/gen-creative-code-native.mts <directory-uuid> --asset-input url
```

### Variables d'environnement (génération code)

| Variable | Défaut | Rôle |
|----------|--------|------|
| `CREATIVE_MODEL` | `claude-opus-4-6` | Modèle génération initiale (non regen) |
| `CREATIVE_REGEN_MODEL` | (auto) | Si défini, force le modèle regen. Sinon : Haiku par défaut, **Sonnet** si &gt;2 blockers ou consignes « redesign ». |
| `CREATIVE_REGEN_MAX_FILE_CHARS` | `80000` | Taille max par fichier injecté en regen (index.html, styles.css, app.js) |
| `CREATIVE_REGEN_DIFF_GUARD` | activé | `0` = pas de comparaison avant/après regen |
| `CREATIVE_REGEN_DIFF_MAX_RATIO` | `0.5` | Alerte si &gt;50 % des lignes changées (signal refonte) |
| `CREATIVE_SCREENSHOT_PROFILE` | — | `dev` ou `fast` = 1 capture `settled` / format + délais réduits |
| `CREATIVE_THINKING_MODE` | `adaptive` | `adaptive` \| `budget` \| `off` — extended thinking en gen initiale |
| `CREATIVE_THINKING_BUDGET_TOKENS` | `32000` | Si `CREATIVE_THINKING_MODE=budget` |
| `CREATIVE_PROMPT_CACHE` | activé | `0` = désactive le prompt caching sur le bloc skills statique |
| `CREATIVE_USE_FULL_SKILLS` | — | `1` = injecte les 12 fichiers `.claude/.skills/` complets ; sinon checklist compacte |
| `CREATIVE_TWO_PHASE` | — | `1` = plan JSON structuré puis génération HTML/CSS/JS |
| `CREATIVE_PARALLEL_FORMATS` | — | `1` = une gen API par format IAB (2+ formats, hors arche), puis fusion |
| `CREATIVE_AD_FORMATS` | 1er preset | JSON array des formats IAB à produire |

Les métriques `duration_ms` / `turn_timings` / `api_call_timings` sont dans `creative-native-token-usage.json`, `review/*-token-usage.json` (`duration_ms` par round) et `pipeline-usage.json`.

#### Régénération après review UI (patch, pas refonte)

Quand `run-creative-native-ui-review.mts` relance `gen-creative-code-native.mts` :

1. Le script lit le **bundle actuel** dans `output/<uuid>/code/` (`index.html`, `styles.css`, `app.js`) et l’envoie au modèle.
2. Le system prompt regen demande une **édition minimale** (blockers uniquement), pas un nouveau concept créatif.
3. L’agent review UI produit un `regeneration_prompt` de correctifs ciblés (CSS, taille logo, overflow, etc.).

Logos : `gen-style-guide` ne garde qu’**un** wordmark (`targetCount: 1`) ; si SVG header officiel OK → Brave logos ignoré. Packshots dans `logos/` sont supprimés / bloqués (déterministe + prompt assets review).

Produits : scrape `og:image` / JSON-LD Product sur brandURL avant Brave ; la gen code exige un **héros produit** depuis `products/` (voir message utilisateur dans `gen-creative-code-native.mts`).

Tests unitaires : `npm test` (logo heuristics, extract HTML, compliance skills).

Pour forcer Sonnet en regen : `set CREATIVE_REGEN_MODEL=claude-sonnet-4-6` avant la review UI.

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
| `CREATIVE_OFFICIAL_LOGO_FETCH` | activé | `0` = ne pas scraper le logo/produit depuis les URLs officielles (Brave seul) |
| `CREATIVE_OFFICIAL_FETCH_FALLBACK` | activé | `0` = pas de repli si HTTP 403/401 sur le site officiel ; sinon Wikipedia (en/fr) + images Wikimedia |
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
| `CREATIVE_REGEN_MODEL` | `claude-haiku-4-5-20251001` | Modèle regen (patch bundle existant) |
| `CREATIVE_REGEN_MAX_FILE_CHARS` | `80000` | Limite caractères par fichier envoyé en regen |
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
