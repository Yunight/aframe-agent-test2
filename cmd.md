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

Modules partagés : `creative-native-skills.mts`, `studio-ad-formats.mts` (importés par les scripts ci-dessus).

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
| `ANTHROPIC_API_KEY` | — | Requis pour tous les scripts Claude |

### Artefacts

| Chemin | Produit par |
|--------|-------------|
| `output/<uuid>/style-guide.json` | gen-style-guide |
| `output/<uuid>/code/` | gen-creative-code-native |
| `output/<uuid>/creative-native-ad-formats.json` | gen-creative-code-native |
| `output/<uuid>/review/screenshots/*.png` | Playwright (via run-creative-native-ui-review) |
| `output/<uuid>/review/ui-review-final.json` | run-creative-native-ui-review |
