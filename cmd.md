# Pipeline créatif — commandes et fichiers `src/`

## Rôle de chaque fichier dans `src/`

| Fichier | Type | Rôle |
|---------|------|------|
| [`gen-style-guide.mts`](src/gen-style-guide.mts) | Script (entrée) | **Étape 1 — Style guide.** À partir du contexte marque/produit (`STYLE_GUIDE_CONTEXT`), appelle Claude pour produire `style-guide.json`, télécharge logos et visuels produit dans `output/<uuid>/logos/` et `products/`. |
| [`gen-creative-code-native.mts`](src/gen-creative-code-native.mts) | Script (entrée) | **Étape 2 — Génération créative native.** Agent **Opus** : génère `output/<uuid>/code/` (HTML/CSS/JS), formats IAB via `CREATIVE_AD_FORMATS`, validation skills. Accepte `CREATIVE_REGEN_FEEDBACK` pour une régénération pilotée par l’agent review. |
| [`run-creative-native-ui-review.mts`](src/run-creative-native-ui-review.mts) | Script (entrée) | **Étape 3 — Boucle review.** Orchestre screenshots → review Haiku → si blockers, relance `gen-creative-code-native.mts` (max `CREATIVE_UI_REVIEW_MAX_ROUNDS`, défaut 3). Écrit `review/`. |
| [`creative-native-playwright-screenshots.mts`](src/creative-native-playwright-screenshots.mts) | Module | **Captures d’écran** (pas d’LLM). Playwright ouvre `code/index.html`, PNG par format et par état (`initial`, `animated`, `settled`), manifeste `review/screenshots/manifest.json`. |
| [`creative-native-ui-review.mts`](src/creative-native-ui-review.mts) | Module | **Agent review UI** (Haiku + vision). Envoie les PNG + style guide + skills ; sortie structurée (`satisfied`, `findings`, `regeneration_prompt`). |
| [`creative-native-skills.mts`](src/creative-native-skills.mts) | Module | **Règles design** chargées depuis `.claude/.skills/`, schéma Zod des fichiers générés, `validateCreativeSkillCompliance()` (contrôles déterministes couleurs, typo, assets). |
| [`studio-ad-formats.mts`](src/studio-ad-formats.mts) | Module | **Formats pub** : lit `shared/ad-formats.json`, normalise `CREATIVE_AD_FORMATS`, blocs de consignes pour les prompts (`buildCreativeAdFormatInstructions`). |
| [`creative-pipeline-usage.mts`](src/creative-pipeline-usage.mts) | Module | **Ledger tokens/coûts** : `pipeline-usage.json`, tarifs Opus/Haiku, logs console uniformes. |
| [`style-guide-studio-api.mts`](src/style-guide-studio-api.mts) | Serveur | **API studio** (port 3001) : jobs SSE, lance les scripts, sert `output/`. Si review cochée : enchaîne gen native puis `run-creative-native-ui-review.mts`. |
| [`gen-creative-code-native_habillage.mts`](src/gen-creative-code-native_habillage.mts) | Script (hors pipeline) | **Cas habillage vidéo 16:9** (script séparé, sans agent review). Vidéo locale, formats habillage, même stack HTML/CSS/JS. |

### Pipeline native (ordre)

```text
gen-style-guide.mts
    → output/<uuid>/style-guide.json + logos/ + products/
gen-creative-code-native.mts
    → output/<uuid>/code/
run-creative-native-ui-review.mts   (optionnel, studio ou CLI)
    → Playwright (creative-native-playwright-screenshots.mts)
    → Review Haiku (creative-native-ui-review.mts)
    → regen gen-creative-code-native.mts si besoin (≤ 3 tours review)
```

Modules partagés : `creative-native-skills.mts`, `studio-ad-formats.mts`, `creative-pipeline-usage.mts`, `anthropic-retry.mts`.

---

## Logs review (ce qui ne va pas)

À chaque tour, l’agent review écrit :

- **Console / studio SSE** : `[ui-review] findings:` avec chaque `[blocker|warn]`, issue et fix_hint ; résumé et extrait du `regeneration_prompt`.
- **`review/ui-review.log`** : même contenu en texte (append par round).
- **`review/ui-review-round-N.json`** : audit structuré machine.
- **`review/ui-review-final.json`** : synthèse + lien vers `pipeline_totals_usd`.

---

## Coûts par action (`pipeline-usage.json`)

Fichier central : **`output/<uuid>/pipeline-usage.json`** — une entrée par action, avec tokens et `price_usd`.

| `action` | Agent / script | Modèle | Coût |
|----------|----------------|--------|------|
| `style_guide` | gen-style-guide.mts | Opus | LLM |
| `creative_generation` | gen-creative-code-native.mts | Opus | LLM |
| `creative_regeneration` | gen-creative-code-native.mts | Opus | LLM (après review) |
| `screenshots` | creative-native-playwright-screenshots.mts | — | 0 USD |
| `ui_review` | creative-native-ui-review.mts | Haiku | LLM |

En fin de `run-creative-native-ui-review.mts`, un récap **`=== pipeline usage totals ===`** s’affiche en console.

Tarifs (USD / million tokens, surchargeables) :

| Variable | Défaut | Usage |
|----------|--------|--------|
| `CREATIVE_OPUS_INPUT_USD_PER_M` | `5` | gen-style-guide, gen-creative-code-native |
| `CREATIVE_OPUS_OUTPUT_USD_PER_M` | `25` | idem |
| `CREATIVE_HAIKU_INPUT_USD_PER_M` | `1` | review UI |
| `CREATIVE_HAIKU_OUTPUT_USD_PER_M` | `5` | review UI |

**Retry API Anthropic** (`anthropic-retry.mts`) : en cas de `overloaded_error` / rate limit / 529–503, les appels stream/parse sont relancés avec backoff exponentiel. Console : `[anthropic-retry] … nouvelle tentative dans Xs…`.

| Variable | Défaut | Usage |
|----------|--------|--------|
| `ANTHROPIC_RETRY_MAX_ATTEMPTS` | `6` | Nombre max de tentatives par appel |
| `ANTHROPIC_RETRY_BASE_DELAY_MS` | `8000` | Délai de base (×2 par tentative, plafond 120 s) |

Fichiers complémentaires : `creative-native-token-usage.json` (dernière gen), `review/ui-review-token-usage.json` (cumul review seul).

---

## Commandes

### Style guide

```bash
node src/gen-style-guide.mts
```

### Code créatif native (génération seule)

```bash
set CREATIVE_AD_FORMATS=[{"id":"320x480","width":320,"height":480},{"id":"300x250","width":300,"height":250}]
node src/gen-creative-code-native.mts <directory-uuid> --asset-input url
```

### Habillage vidéo 16:9 (à part)

```bash
node src/gen-creative-code-native_habillage.mts <directory-uuid> --asset-input url
```

### Agent review UI (screenshots + Haiku, régénération optionnelle)

Après un dossier `code/` existant :

```bash
set CREATIVE_UI_REVIEW_MAX_ROUNDS=3
node src/run-creative-native-ui-review.mts <directory-uuid>
```

Pipeline complet en CLI (génération puis review) :

```bash
set CREATIVE_UI_REVIEW_MAX_ROUNDS=0
node src/gen-creative-code-native.mts <directory-uuid> --asset-input url
set CREATIVE_UI_REVIEW_MAX_ROUNDS=3
node src/run-creative-native-ui-review.mts <directory-uuid>
```

### Studio UI

```bash
node src/style-guide-studio-api.mts
```

Puis lancer `style-guide-ui` (Vite). Cocher **Review UI après génération** sur `gen-creative-code-native.mts` enchaîne gen + review dans un seul job.

### Variables d'environnement (review)

| Variable | Défaut | Rôle |
|----------|--------|------|
| `CREATIVE_UI_REVIEW_MAX_ROUNDS` | `3` | Tours screenshot + review + regen max |
| `CREATIVE_UI_REVIEW_MODEL` | `claude-haiku-4-5-20251001` | Modèle review visuelle |
| `CREATIVE_SCREENSHOT_INITIAL_WAIT_MS` | `600` | Délai capture `initial` |
| `CREATIVE_SCREENSHOT_ANIMATED_WAIT_MS` | `2500` | Délai capture `animated` |
| `CREATIVE_SCREENSHOT_SETTLED_WAIT_MS` | `5000` | Délai capture `settled` |
| `CREATIVE_REGEN_FEEDBACK` | — | Message injecté dans gen (usage interne, regen après review) |
| `CREATIVE_REGEN_REVIEW_ROUND` | — | Numéro de tour review pour l’entrée `creative_regeneration` |
| `CREATIVE_OPUS_INPUT_USD_PER_M` | `5` | Tarif input Opus (pipeline-usage.json) |
| `CREATIVE_OPUS_OUTPUT_USD_PER_M` | `25` | Tarif output Opus |
| `CREATIVE_HAIKU_INPUT_USD_PER_M` | `1` | Tarif input Haiku (review) |
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
| `output/<uuid>/review/ui-review.log` | Logs review lisibles |
| `output/<uuid>/review/ui-review-round-N.json` | Audit JSON par tour |
| `output/<uuid>/review/ui-review-token-usage.json` | Tokens review (avec `price_usd`) |
| `output/<uuid>/review/ui-review-final.json` | run-creative-native-ui-review |
