# Référence JSON — AdFormatGallery / AdFormatViewer

> **Document autonome** — conçu pour être copié et utilisé hors du dépôt Gravity. Tous les schémas, règles de validation, logique d’hydratation et exemples JSON complets sont inclus ci-dessous (§8 Annexes). Aucun lien vers le code source n’est requis pour produire un JSON d’import valide.

Ce document liste les **objets JSON** utilisés pour construire ou importer des formats publicitaires. Il distingue :

1. **Config format** (`config` sauvegardée / importée) — ce que vous écrivez dans un fichier `.json` (ex. upload Generic).
2. **État éditeur AFV** (`AFVFormConfig`) — structure interne avec `sections` + `widgets`, produite par l’éditeur ; **pas** le format d’import Generic.

### Pipeline format `generic` (résumé)

| Étape | Rôle |
|-------|------|
| Import | Valider le JSON (`getGenericConfigValidationError`) puis normaliser (`normalizeGenericConfig`) : calcule `bindingSchema` depuis le `html`. |
| Schéma HTML | Parser les `data-gv-bind` du HTML ; chaque clé de `fields` / `images` doit y correspondre. |
| Hydratation | Appliquer `fields`, `images`, `settings` sur le DOM via `[data-gv-bind="…"]` (preview et iframe). |
| Éditeur | Générer automatiquement les widgets texte/image à partir du `bindingSchema` — ne pas les inclure dans le JSON importé. |
| Iframe runtime | `getConfig()` expose la config ; `update()` ré-applique les bindings après chargement. |

Détail implémentation : **§8.1** (types), **§8.2** (hydratation), **§8.3–8.4** (exemples JSON), **§8.5** (réparation d’exports).

### Exemples JSON de référence (contenus intégrés)

| Exemple | Section | Usage |
|---------|---------|--------|
| Carousel 320×480 | §8.3 | Logo, `heroSlides`, textes composites (`headline` + `headlineAccent`), CTA, carousel `js` |
| Bannière statique 320×480 | §8.4 | Hero unique, pas de `slideInterval` |
| Point de départ auteur | §8.3 | Même structure que le carousel ; dupliquer et adapter les clés |

---

## 1. Types communs (config format)

### 1.1 `TextStyle` — texte stylé

Utilisé pour titres, CTA, mentions légales, etc. dans la config sauvegardée.

```json
{
  "text": "Mon texte",
  "font": "Inter",
  "size": 14,
  "weight": "600",
  "style": "normal",
  "color": "#FFFFFF"
}
```

| Champ    | Type     | Obligatoire | Description |
|----------|----------|-------------|-------------|
| `text`   | `string` | oui         | Contenu affiché. Peut contenir du HTML simple (`<br>`, `<span>`…) côté Generic. Voir §1.6 pour entités HTML et caractères spéciaux. |
| `font`   | `string` | oui         | Famille CSS (`Inter`, `Arial`, …). |
| `size`   | `number` | oui         | Taille en **px**. |
| `weight` | `string` | oui         | Graisse CSS (`400`, `600`, `700`, …). |
| `style`  | `string` | oui         | `normal` \| `italic`. |
| `color`  | `string` | oui         | Couleur CSS (`#RRGGBB`, `rgb()`, …). |

**Raccourci dans `fields`** : une chaîne seule est acceptée pour une clé de `fields` et normalisée en `TextStyle` complet.

```json
"fields": {
  "title": "Titre simple"
}
```

---

### 1.2 `AFVTextStyle` — style sans texte obligatoire

Même champs typographiques que `TextStyle`, mais `text` optionnel (ex. segments Wheel).

```json
{
  "font": "Arial",
  "size": 12,
  "weight": "700",
  "style": "normal",
  "color": "#000000"
}
```

---

### 1.3 Images dans la **config** (URLs)

Dans la config persistée, les images sont des **tableaux de chaînes** (URL http(s) ou `data:image/...`), pas des objets `files`.

```json
"images": {
  "logo": ["https://example.com/logo.png"],
  "heroSlides": [
    "data:image/svg+xml,...",
    "data:image/svg+xml,..."
  ]
}
```

| Forme              | Usage |
|--------------------|--------|
| `"cle": ["url"]`   | Image unique (logo, hero, …). |
| `"cle": ["u1","u2"]` | Liste / carousel — une URL par slide. |

Clés d’images Generic : **libres**, alignées sur `data-gv-bind` (`logo`, `heroSlides`, `hero`, …). Voir §2.6 et §2.8 si une clé `images` n’apparaît pas dans l’éditeur.

---

### 1.4 Paramètres globaux — format `generic` (`settings`)

Pour le format **generic**, le fond, le clic et le carousel ne sont **pas** à la racine du JSON : ils vont dans l’objet `settings` (obligatoire).

```json
"settings": {
  "backgroundColor": "#000000",
  "clickTag": "https://example.com",
  "slideInterval": 2800
}
```

| Champ             | Type     | Obligatoire | Description |
|-------------------|----------|-------------|-------------|
| `backgroundColor` | `string` | non         | Couleur de fond (appliquée si binding `background` ou `root`). |
| `clickTag`        | `string` | non         | URL du lien principal (binding `link`). |
| `slideInterval`   | `number` | non         | Intervalle carousel en **ms** — **uniquement** si le HTML contient un binding `data-gv-type="image-list"`. Sinon ignoré à la normalisation. |

Les autres formats (Wheel, Panorama, …) utilisent encore `backgroundColor` / `clickTag` à la racine via `BaseBannerConfig` ; **ne pas** mélanger avec le schéma generic.

---

### 1.5 Dimensions

```json
"dimensions": {
  "width": 320,
  "height": 480
}
```

`width` et `height` : nombres positifs en pixels.

---

### 1.6 Entités HTML et caractères spéciaux

À l’hydratation, la plateforme applique `fields.*.text` via `applyTextStyleToElement` (§8.2) :

| Condition sur `text` | API DOM utilisée | Comportement |
|----------------------|------------------|--------------|
| Ne contient **pas** de `<` | `textContent` | Chaîne affichée **telle quelle** — pas de décodage HTML |
| Contient au moins un `<` | `innerHTML` | HTML interprété ; entités (`&amp;`, `&nbsp;`, …) **décodées** |

`JSON.parse` ne décode que les échappements JSON (`\n`, `\u0026`, …), **pas** les entités HTML dans le contenu des chaînes.

#### Entités courantes — chemin plain-text (sans `<`)

| Dans le JSON | Rendu affiché |
|--------------|---------------|
| `&amp;` | `&amp;` (littéral) |
| `&nbsp;` | `&nbsp;` (littéral) |
| `&#233;` | `&#233;` (littéral) |

#### Recommandation (exports Generic)

Pour du texte **sans balises**, utiliser les **caractères Unicode réels** :

```json
"subhead": { "text": "Kit Pêche & Passion", "font": "Montserrat", "size": 10, "weight": "600", "style": "normal", "color": "#F9A03F" }
```

Espace insécable : caractère Unicode (`\u00A0` en JSON) plutôt que `&nbsp;`.

#### Alternative : forcer le chemin `innerHTML`

Si le créatif doit conserver des entités HTML, inclure au moins une balise :

```json
"subhead": { "text": "<span>Kit Pêche &amp; Passion</span>", "font": "Montserrat", "size": 10, "weight": "600", "style": "normal", "color": "#F9A03F" }
```

#### Piège : `text-transform: uppercase` en CSS

Si le CSS du créatif applique `text-transform: uppercase` sur l’élément lié (ex. `.subhead`, `.ad-footer span`), les entités HTML affichées littéralement deviennent encore plus visibles : `&amp;` → `&AMP;`, `&nbsp;` → `&NBSP;`.

**Ne pas** combiner entités HTML dans `fields.*.text` + `text-transform: uppercase` sur le même nœud sans l’une des solutions ci-dessus.

#### Exemple avant / après (plain-text)

| Champ | Incorrect | Correct |
|-------|-----------|---------|
| `subhead` | `"Kit Pêche &amp; Passion"` | `"Kit Pêche & Passion"` |
| `body_copy` | `"…chez vous&nbsp;!"` | `"…chez vous !"` ou `"…chez vous\u00A0!"` |
| `text_982` (footer) | `"kusmi.tea &nbsp;\|&nbsp; …"` | `"kusmi.tea | …"` (espaces normaux) |

---

## 2. Format `generic` — JSON attendu (schéma strict)

Seul ce schéma est accepté à l’**import** (upload `.json`) et à l’**ouverture** en galerie. Tout JSON avec des clés à la racine type `tagLine`, `headline`, `backgroundColor` est **refusé** (pas de migration automatique). Messages d’erreur : §2.8.

**Principe :** les noms de clés dans `fields` / `images` sont **libres** (`title`, `offer`, `heroSlides`, `brandLogo`, …). Chaque clé déclarée dans le JSON doit avoir un attribut `data-gv-bind` de même valeur dans le `html`. Les `id` / classes CSS (`#ad-320x480`, `.carousel-track`, …) servent au `js` / `css` du créatif uniquement — **pas** à l’édition plateforme.

**Règle clé :** remplir `images.logo` dans le JSON **sans** `<img data-gv-bind="logo">` dans le HTML ne crée **aucun** sélecteur d’image dans l’éditeur et n’hydrate pas la preview. Même logique pour `fields`.

### 2.1 Structure racine obligatoire

| Champ | Type | Requis | Description |
|-------|------|--------|-------------|
| `type` | `"generic"` | oui | Valeur fixe. |
| `dimensions` | `{ width, height }` | oui | Nombres positifs (px). |
| `html` | `string` | oui | Créatif vanilla ; **au moins un** `data-gv-bind`. |
| `fields` | `object` | oui | Peut être `{}`. Clés → textes / liens éditables. |
| `images` | `object` | oui | Peut être `{}`. Clés → URLs (`string[]`). |
| `settings` | `object` | oui | Fond, clic, intervalle carousel. |
| `css` | `string` | non | Feuille de style embarquée. |
| `js` | `string` | non | Script vanilla (UI, carousel, onglets…). |
| `bindingSchema` | `array` | non | Cache optionnel ; recalculé depuis le HTML à la normalisation. |

### 2.2 Exemple minimal (validé)

```json
{
  "type": "generic",
  "dimensions": { "width": 320, "height": 480 },
  "settings": {
    "backgroundColor": "#000000",
    "clickTag": "#"
  },
  "fields": {
    "title": {
      "text": "Titre",
      "font": "Inter",
      "size": 22,
      "weight": "700",
      "style": "normal",
      "color": "#FFFFFF"
    }
  },
  "images": {},
  "html": "<div data-gv-bind=\"canvas\" data-gv-type=\"root\"><p data-gv-bind=\"title\" data-gv-type=\"text\">Titre</p></div>"
}
```

Raccourci autorisé dans `fields` :

```json
"fields": {
  "title": "Titre simple"
}
```

→ normalisé en `TextStyle` complet à l’import.

### 2.3 Exemple complet (carousel + textes + images)

Structure type exemple carousel (§8.3) :

```json
{
  "type": "generic",
  "dimensions": { "width": 320, "height": 480 },
  "settings": {
    "backgroundColor": "#000000",
    "clickTag": "https://example.com",
    "slideInterval": 2800
  },
  "fields": {
    "tagLine": { "text": "Tag line", "font": "Inter", "size": 10, "weight": "600", "style": "normal", "color": "#B0B3B8" },
    "headline": { "text": "Titre", "font": "Inter", "size": 26, "weight": "700", "style": "normal", "color": "#FFFFFF" },
    "headlineAccent": { "text": "", "font": "Inter", "size": 26, "weight": "700", "style": "normal", "color": "#EC1C24" },
    "subhead": { "text": "Sous-titre", "font": "Inter", "size": 12, "weight": "500", "style": "normal", "color": "#B0B3B8" },
    "ctaText": { "text": "En savoir plus", "font": "Inter", "size": 13, "weight": "600", "style": "normal", "color": "#FFFFFF" },
    "legalText": { "text": "", "font": "Inter", "size": 8, "weight": "500", "style": "normal", "color": "#B0B3B8" }
  },
  "images": {
    "logo": ["data:image/svg+xml,..."],
    "heroSlides": ["data:image/svg+xml,...", "data:image/svg+xml,..."]
  },
  "html": "<div data-gv-bind=\"canvas\" data-gv-type=\"root\">…</div>",
  "css": "…",
  "js": "…"
}
```

HTML structurant du même exemple (extrait lisible — voir §8.3 pour le HTML complet) :

```html
<div data-gv-bind="canvas" data-gv-type="root">
  <div class="ad-bg" data-gv-bind="background" data-gv-type="background"></div>
  <header class="ad-header">
    <img data-gv-bind="logo" data-gv-type="image" src="" alt="" class="ad-logo" />
  </header>
  <div class="hero-wrap">
    <div class="hero-track" data-gv-bind="heroSlides" data-gv-type="image-list">
      <div class="hero-slide"><img src="" alt="" class="hero-img" /></div>
      <div class="hero-slide"><img src="" alt="" class="hero-img" /></div>
    </div>
  </div>
  <div class="ad-content">
    <p data-gv-bind="tagLine" data-gv-type="text" class="tag-line"></p>
    <h1 class="headline">
      <span data-gv-bind="headline" data-gv-type="text"></span>
      <span data-gv-bind="headlineAccent" data-gv-type="text"></span>
    </h1>
    <p data-gv-bind="subhead" data-gv-type="text" class="subhead"></p>
    <a data-gv-bind="ctaText" data-gv-type="link" href="#" class="cta-btn">
      <span class="cta-label"></span>
    </a>
    <p data-gv-bind="legalText" data-gv-type="text" class="legal"></p>
  </div>
</div>
```

Les clés `tagLine`, `headline`, etc. dans cet exemple sont des **noms libres dans `fields`**, pas des champs racine legacy.

### 2.4 Objet `settings`

```json
"settings": {
  "backgroundColor": "#000000",
  "clickTag": "https://example.com",
  "slideInterval": 2800
}
```

| Champ | Quand l’utiliser |
|-------|------------------|
| `backgroundColor` | Si le HTML a `data-gv-type="background"` ou `"root"`. |
| `clickTag` | Si le HTML a un binding `data-gv-type="link"`. |
| `slideInterval` | **Seulement** si le HTML contient `data-gv-type="image-list"` (ex. clé `heroSlides`). Sinon la plateforme le supprime à la normalisation. |

### 2.5 Objet `fields`

Record clé → `TextStyle` (voir §1.1) ou `string` (raccourci).

| Binding HTML `data-gv-type` | Contenu `fields` |
|----------------------------|------------------|
| `text` | Texte + typo appliqués sur l’élément lié. |
| `link` | Texte **plain** du libellé CTA ; `settings.clickTag` pour le `href`. |

Exemple extrait HTML + JSON alignés :

```html
<p data-gv-bind="headline" data-gv-type="text"></p>
<a data-gv-bind="ctaText" data-gv-type="link" href="#"><span class="cta-label"></span></a>
```

```json
"fields": {
  "headline": { "text": "Mon titre", "font": "Inter", "size": 26, "weight": "700", "style": "normal", "color": "#FFFFFF" },
  "ctaText": { "text": "Découvrir", "font": "Inter", "size": 13, "weight": "600", "style": "normal", "color": "#FFFFFF" }
}
```

#### Convention CTA (`data-gv-type="link"`)

La plateforme applique le libellé ainsi (§8.2, branche `link`) :

1. `settings.clickTag` → attribut `href` sur le `<a>` lié.
2. Si un enfant `.cta-label` existe → `fields.<cle>.text` est injecté dans **cet enfant** (texte + typo).
3. Sinon → texte appliqué directement sur le `<a>`.

**HTML attendu :**

```html
<a data-gv-bind="ctaText" data-gv-type="link" href="#" class="cta-btn">
  <span class="cta-label"></span>
</a>
```

**`fields.ctaText.text`** : chaîne **plain** (`"Découvrir le kit"`), sans balises HTML.

| À éviter | Pourquoi |
|----------|----------|
| `"text": "<span class=\"cta-label\">Découvrir</span>"` dans `ctaText` | HTML imbriqué dans la valeur ; double span si `.cta-label` existe déjà dans le HTML |
| Deux clés `ctaText` + `cta_label` sur le même `<span class="cta-label">` | Bindings redondants ; un seul champ `ctaText` suffit (cf. §8.3) |

Pour un second libellé éditorial distinct, utiliser une clé et un `data-gv-bind` dédiés sur un nœud séparé — pas sur le même `.cta-label` que le lien principal.

### 2.6 Objet `images`

Record clé → tableau d’URLs (`http(s)://` ou `data:image/...`).

| Binding HTML `data-gv-type` | Forme `images` |
|----------------------------|----------------|
| `image` | `"cle": ["une-url"]` |
| `image-list` | `"cle": ["url1", "url2", ...]` — une entrée par `<img>` enfant du nœud lié |

```html
<img data-gv-bind="logo" data-gv-type="image" src="" alt="" />
<div data-gv-bind="heroSlides" data-gv-type="image-list">
  <img src="" class="hero-img" />
  <img src="" class="hero-img" />
</div>
```

```json
"images": {
  "logo": ["https://cdn.example/logo.png"],
  "heroSlides": ["https://cdn.example/s1.jpg", "https://cdn.example/s2.jpg"]
}
```

Chaque clé du tableau `images` doit exister comme `data-gv-bind` dans le HTML (sinon rejet à l’import, §2.8).

### 2.7 Liaison HTML — `data-gv-bind` (obligatoire)

Chaque zone éditable doit être déclarée dans le HTML importé.

| Attribut | Rôle |
|----------|------|
| `data-gv-bind` | Clé = nom dans `fields` ou `images` |
| `data-gv-type` | `text` \| `image` \| `image-list` \| `link` \| `background` \| `root` |

Si `data-gv-type` est absent, type **inféré** : `img` → `image` ; conteneur avec ≥2 `img` → `image-list` ; `a` → `link` ; sinon `text`.

Exemples de types :

```html
<div data-gv-bind="canvas" data-gv-type="root"></div>
<div data-gv-bind="background" data-gv-type="background" class="ad-bg"></div>
<h1 data-gv-bind="title" data-gv-type="text"></h1>
<img data-gv-bind="hero" data-gv-type="image" src="" />
<div data-gv-bind="slides" data-gv-type="image-list">...</div>
<a data-gv-bind="cta" data-gv-type="link" href="#">...</a>
```

**Ids et classes** : libres (`#ad-320x480`, `.hero-slide`, `#carouselTrack`, etc.) — la plateforme ne les utilise pas pour l’édition, seulement `data-gv-bind`. Le `js` peut continuer à utiliser `getElementById` ; pour le carousel, préférer aussi `document.querySelector('[data-gv-bind="heroSlides"]')` (voir `js` des exemples templates).

**Binding `canvas` / `root` :** obligatoire sur le conteneur principal ; ne compte pas comme entrée dans `fields` ni `images`.

### 2.8 Validation à l’import — messages d’erreur

Règles implémentées côté plateforme (`getGenericConfigValidationError`, `getUnboundGenericConfigKeysError`). En cas d’échec à l’import ou à l’ouverture, le message ci-dessous est affiché à l’utilisateur.

| Condition | Message (extrait) |
|-----------|-------------------|
| Objet racine invalide | `Le JSON doit être un objet.` |
| Clé legacy à la racine (`headline`, `backgroundColor`, …) | `Schéma obsolète : la clé racine "…" n'est plus acceptée` |
| `type` ≠ `"generic"` | `Le champ type doit être "generic".` |
| `dimensions` invalides | `dimensions doit contenir width et height (nombres positifs).` |
| `html` vide | `html est obligatoire et ne doit pas être vide.` |
| Aucun `data-gv-bind` dans `html` | `html doit contenir au moins un attribut data-gv-bind.` |
| Clé racine manquante | `Le champ "fields" est obligatoire.` (idem `images`, `settings`) |
| `fields` / `images` / `settings` mal typés | `fields doit être un objet.` / `Chaque entrée de images doit être un tableau de chaînes` |
| Clé `images.*` sans binding HTML | `La clé images "logo" n'a pas de data-gv-bind (type image ou image-list) dans le html.` |
| Clé `fields.*` sans binding HTML | `La clé fields "headline" n'a pas de data-gv-bind (type text ou link) dans le html.` |

**Cas valide mais incomplet (rejeté) :** JSON avec `images: { "logo": ["…"], "heroSlides": ["…","…"] }` et HTML ne contenant que `data-gv-bind="canvas"` — import OK sur l’ancienne règle « au moins un bind », mais **rejeté** dès qu’une clé `images` / `fields` n’est pas liée dans le HTML.

**Binding HTML sans entrée `fields` :** autorisé ; à la normalisation, le texte peut être bootstrapé depuis le DOM (`parseGenericHtmlSchema`). En revanche, toute clé **présente** dans `fields` ou `images` doit être liée.

**Binding sur nœud caché (non détecté comme erreur) :** un `data-gv-bind` placé sur un élément `hidden`, `display:none`, `aria-hidden="true"` ou dans un conteneur type `gv-field-bindings` **passe** la validation (la clé `fields` est bien liée dans le HTML). Le texte est hydraté et éditable dans l’AFV, mais **n’apparaît pas** dans la preview. Vérifier manuellement que chaque binding texte/link est sur un nœud **visible** dans le créatif (voir §2.13).

### 2.9 Clés racine interdites (schéma obsolète)

Rejet à l’import avec message du type : *« Schéma obsolète : la clé racine "…" n'est plus acceptée »*.

| Interdit à la racine | Remplacer par |
|---------------------|---------------|
| `tagLine`, `headline`, `headlineAccent`, `subhead`, `ctaText`, `legalText` | Entrée dans `fields` + `data-gv-bind` dans le HTML |
| `backgroundColor`, `clickTag`, `slideInterval` | Entrée dans `settings` |
| `bindings` | Attributs `data-gv-bind` directement dans le HTML |

Les configs déjà en base au ancien format ne s’ouvrent plus : réimport obligatoire au nouveau schéma.

### 2.10 Comportement plateforme (hors JSON)

| Étape | Comportement |
|-------|----------------|
| Import | `normalizeGenericConfig` → calcule `bindingSchema` depuis le HTML |
| Éditeur | `buildGenericState` : section `texts` si bindings `text`/`link` ; section `images` si bindings `image`/`image-list` ; `settings` si fond / lien / carousel |
| Preview | `hydrateGenericHtml` → `applyGenericBindings` : met à jour texte, `src`, `href`, fond via `[data-gv-bind="…"]` uniquement |
| Sauvegarde | `formatter` : état AFV → `fields` / `images` / `settings` dans la config persistée |
| Iframe | Injection de scripts runtime : `getConfig()` (config JSON + `bindingSchema`) puis `update()` qui ré-applique les bindings sur le document |

L’iframe n’exécute pas les modules TypeScript du bundler : seules les fonctions sérialisées via `.toString()` sont disponibles. D’où l’objet ordonné `genericIframeScripts` (helpers texte + bindings **avant** `update`). Le `bindingSchema` doit être présent dans la config normalisée passée à `getConfig()` — sinon `update()` n’applique aucun binding.

- **Ne pas** inclure les widgets §3 dans le JSON importé.
- **JS vanilla** : animations, carousel, onglets dans `js` ; pour textes dynamiques par slide, lire `window.getConfig().fields[cle]` plutôt qu’un objet local figé au build.

### 2.11 Assets embarqués et images

`html`, `css`, `js` sont injectés dans l’iframe via `FormatWrapper` + hydratation (`hydrateGenericHtml` / `update()`).

| Bonne pratique | Détail |
|----------------|--------|
| URLs d’images dans `images` | `images.logo`, `images.heroSlides` → `string[]` (http(s) ou `data:image/…`) |
| `src` dans le HTML | Laisser `src=""` sur les `<img>` liés ; la plateforme applique les URLs depuis `images` à la preview |
| Éviter les base64 dans `html` | Ne pas dupliquer de gros `data:image/…` inline dans le HTML **et** dans `images` — fichier JSON énorme, preview non synchronisée si pas de `data-gv-bind` |
| Nombre de slides | Une URL par `<img>` enfant du nœud `data-gv-type="image-list"` (ordre DOM = ordre du tableau) |

### 2.12 Export multi-marques (ex. carousel par classes)

Structure type export externe (ids + classes, peu de bindings) :

```html
<!-- Insuffisant pour l’éditeur -->
<div id="ad-320x480" data-gv-bind="canvas" data-gv-type="root">
  <img src="data:image/png;base64,..." class="logo" />
  <div id="carouselTrack" class="carousel-track">...</div>
</div>
```

Correction minimale (aligner sur les clés `images` / `fields` du JSON) :

```html
<div id="ad-320x480" data-gv-bind="canvas" data-gv-type="root">
  <img data-gv-bind="logo" data-gv-type="image" src="" alt="" class="logo" />
  <div id="carouselTrack" class="carousel-track" data-gv-bind="heroSlides" data-gv-type="image-list">
    <div class="slide active"><img src="" alt="" /></div>
    <div class="slide"><img src="" alt="" /></div>
  </div>
  <h1 data-gv-bind="headline" data-gv-type="text"></h1>
  <a id="ctaBtn" data-gv-bind="ctaBtn" data-gv-type="link" href="#"><span data-gv-bind="cta_text" data-gv-type="text"></span></a>
</div>
```

Réparation d’exports carousel multi-marques (ids/classes sans bindings) : procédure **§8.5.2**.

### 2.13 Titres et textes composites

**Règle :** un `data-gv-bind` lie **un seul nœud DOM**. À l’hydratation, `fields.<cle>.text` **remplace tout le contenu** de ce nœud (`textContent` ou `innerHTML` selon §1.6) — le markup HTML initial à l’intérieur du nœud lié est **écrasé**.

#### Pattern correct — un binding par segment visible

Pour un titre en plusieurs styles (ex. accent coloré + texte principal), placer **un binding par segment** dans le conteneur (pattern de référence §8.3 / §2.3) :

```html
<h1 class="headline">
  <span data-gv-bind="headline" data-gv-type="text"></span>
  <em><span data-gv-bind="headlineAccent" data-gv-type="text"></span></em>
</h1>
```

```json
"fields": {
  "headline": { "text": "Maison", "font": "Playfair Display", "size": 20, "weight": "700", "style": "normal", "color": "#1A1A1A" },
  "headlineAccent": { "text": "Bubble Tea", "font": "Playfair Display", "size": 20, "weight": "700", "style": "italic", "color": "#C8102E" }
}
```

Le style du segment accent peut aussi s’appuyer sur le CSS du créatif (ex. `.headline em { font-style: italic; color: #C8102E; }`) ; les champs `fields` restent la source éditable.

#### Anti-patterns

| Anti-pattern | Effet |
|--------------|-------|
| `data-gv-bind="headline"` sur le `<h1>` parent contenant `<em>Bubble Tea</em> Maison` | Seul `fields.headline.text` est injecté ; le `<em>` initial disparaît |
| `fields.headlineAccent` lié à un `<span hidden>` ou `<div class="gv-field-bindings" hidden>…</div>` | Import valide, texte invisible dans la bannière |
| Segment visible absent du HTML (`html` / `css` / `fields`) | Élément du mock non rendu (ex. badge promo `-10%` sans markup ni clé `fields`) |

#### Réparation d’exports existants

Procédure de réparation pour titres composites et CTA mal liés : **§8.5.1**.

#### Texte visible = markup + `fields`

Tout texte affiché dans le mock final doit avoir :

1. Un nœud HTML **visible** avec `data-gv-bind` + `data-gv-type="text"` (ou `link`).
2. Une entrée correspondante dans `fields` (ou bootstrap depuis le DOM à la normalisation).
3. Le style associé dans `css` si nécessaire.

Exemple badge promo éditable :

```html
<span class="promo-badge" data-gv-bind="promoBadge" data-gv-type="text">-10%</span>
```

```json
"fields": {
  "promoBadge": { "text": "-10%", "font": "Montserrat", "size": 8, "weight": "700", "style": "normal", "color": "#FFFFFF" }
}
```

---

## 3. Widgets AdFormatViewer (état éditeur)

Types de widgets générés par l’éditeur AdFormatViewer (non inclus dans le JSON importé). Structure d’une **section** :

```json
{
  "maSection": {
    "title": "Titre affiché dans l’éditeur",
    "widgets": {
      "nomWidget": { }
    }
  }
}
```

Chaque widget a toujours : `type`, `description`, `values` ; parfois `options`.

---

### 3.1 `text` — texte + typo

```json
{
  "type": "text",
  "description": "Titre principal",
  "values": {
    "text": "Hello",
    "font": "Inter",
    "size": 26,
    "weight": "700",
    "style": "normal",
    "color": "#FFFFFF"
  }
}
```

---

### 3.2 `style` — typo sans champ texte obligatoire

```json
{
  "type": "style",
  "description": "Style segment",
  "values": {
    "font": "Arial",
    "size": 12,
    "weight": "700",
    "style": "normal",
    "color": "#000000",
    "text": "optionnel"
  }
}
```

---

### 3.3 `color` — couleur

```json
{
  "type": "color",
  "description": "Couleur de fond",
  "values": {
    "color": "#000000"
  }
}
```

---

### 3.4 `link` — URL

```json
{
  "type": "link",
  "description": "Lien de clic",
  "values": {
    "url": "https://example.com"
  }
}
```

---

### 3.5 `number` — nombre

```json
{
  "type": "number",
  "description": "Largeur (px)",
  "values": {
    "number": "320",
    "min": 200,
    "max": 970,
    "step": 1
  }
}
```

Note : `number` est stocké comme **string** dans l’UI, converti en `number` au formatage.

---

### 3.6 `slider` — curseur

```json
{
  "type": "slider",
  "description": "Opacité",
  "values": {
    "number": "0.5",
    "min": 0,
    "max": 1,
    "step": 0.1
  }
}
```

---

### 3.7 `boolean` — interrupteur

```json
{
  "type": "boolean",
  "description": "Activer l’animation",
  "values": {
    "boolean": true
  }
}
```

---

### 3.8 `date` — date

```json
{
  "type": "date",
  "description": "Date de fin",
  "values": {
    "date": "2026-12-31T23:59:59"
  }
}
```

---

### 3.9 `field` — champ texte simple (sans typo)

```json
{
  "type": "field",
  "description": "Identifiant",
  "values": {
    "text": "valeur"
  },
  "options": {
    "placeholder": "Saisir…"
  }
}
```

---

### 3.10 `image` — sélecteur d’images (état éditeur)

Dans l’éditeur, les fichiers sont des objets ; à la sauvegarde le `formatter` les convertit en URLs dans `config.images`.

```json
{
  "type": "image",
  "description": "Logo",
  "options": {
    "fit": "contain",
    "maxHeight": 40,
    "maxWidth": 120,
    "min": 1,
    "max": 1
  },
  "values": {
    "files": [
      {
        "url": "blob:... ou data:... ou https://...",
        "text": "",
        "tmpId": "0"
      }
    ]
  }
}
```

**`AFVImageOptions`**

| Champ       | Type                    | Description |
|-------------|-------------------------|-------------|
| `fit`       | `"cover"` \| `"contain"` | Recadrage. |
| `min`       | `number`                | Nombre min de fichiers. |
| `max`       | `number`                | Nombre max de fichiers. |
| `maxHeight` | `number`                | Optionnel, preview. |
| `maxWidth`  | `number`                | Optionnel, preview. |
| `quality`   | `number`                | Optionnel, export. |
| `mimeType`  | `string`                | Optionnel, export. |
| `cropZones` | `[number, number][]`    | Zones de recadrage %. |

**`AFVFileObject`**

| Champ   | Type     | Description |
|---------|----------|-------------|
| `url`   | `string` | Source affichée / exportée. |
| `text`  | `string` | Libellé alternatif. |
| `tmpId` | `string` | Id temporaire UI. |
| `type`  | `string` | Optionnel (mime hint). |

---

### 3.11 `list` — liste répétable (carousel, slides, …)

```json
{
  "type": "list",
  "description": "Images du carousel",
  "options": {
    "minItems": 1,
    "maxItems": 8
  },
  "values": {
    "list": [
      {
        "position": 0,
        "key": "slide-0",
        "group": {
          "image": {
            "type": "image",
            "description": "Image du carousel",
            "options": { "fit": "cover", "maxHeight": 200, "maxWidth": 320, "min": 1, "max": 1 },
            "values": {
              "files": [{ "url": "...", "text": "", "tmpId": "0" }]
            }
          }
        }
      }
    ]
  }
}
```

| Champ liste   | Type     | Description |
|---------------|----------|-------------|
| `position`    | `number` | Ordre. |
| `key`         | `string` | Identifiant stable de l’item. |
| `group`       | `object` | Sous-widgets (définis par `builder` côté code). |

---

### 3.12 `model` — modèle 3D

```json
{
  "type": "model",
  "description": "Modèle 3D",
  "options": { "max": 1 },
  "values": {
    "files": [
      { "url": "/path/model.glb", "text": "", "tmpId": "0" }
    ]
  }
}
```

---

### 3.13 `coordinates` — position %

```json
{
  "type": "coordinates",
  "description": "Position hotspot",
  "options": {
    "resolveCaptureZoneCoordinates": "fonction — définie en code, pas en JSON"
  },
  "values": {
    "xy": [50, 30]
  }
}
```

`xy` : pourcentages `[x, y]` dans la zone de capture. Non sérialisable manuellement pour import JSON.

---

## 4. Objet sauvegardé API (`SavedConfigObject`)

Réponse après création / chargement d’un format personnalisé :

```json
{
  "id": "uuid",
  "name": "Mon format",
  "version": 1,
  "config": { }
}
```

`config` contient la **config format** du type correspondant (`generic`, `countdown`, …), pas l’état AFV complet.

---

## 5. Types de format (`type`)

Valeurs `EFormatType` :

| `type`           | Import JSON custom |
|------------------|--------------------|
| `generic`        | oui (upload `.json`) |
| `countdown`      | via éditeur / sauvegarde |
| `wheel`          | idem |
| `panorama`       | idem |
| `cuecard`        | idem |
| `parallax2d`     | idem |
| `parallax`       | idem |
| `parallax3dcar`  | idem |
| `hotspots`       | idem |
| `slidingproduct` | idem |

Seul **generic** accepte aujourd’hui un fichier JSON autonome avec `html` / `css` / `js` vanilla.

---

## 6. Cas d’usage Generic — extraits JSON

### Bannière statique (une image hero, pas de carousel)

Exemple complet : **§8.4**.

```json
{
  "type": "generic",
  "dimensions": { "width": 320, "height": 480 },
  "settings": {
    "backgroundColor": "#1A1A2E",
    "clickTag": "https://example.com"
  },
  "fields": {
    "title": { "text": "Titre principal", "font": "Inter", "size": 24, "weight": "700", "style": "normal", "color": "#FFFFFF" },
    "offer": { "text": "Offre limitée", "font": "Inter", "size": 13, "weight": "500", "style": "normal", "color": "#B0B3B8" },
    "ctaText": { "text": "Découvrir", "font": "Inter", "size": 13, "weight": "600", "style": "normal", "color": "#FFFFFF" }
  },
  "images": {
    "hero": ["https://cdn.example/hero.jpg"]
  },
  "html": "<div data-gv-bind=\"canvas\" data-gv-type=\"root\">…</div>",
  "css": "…"
}
```

Pas de `slideInterval` dans `settings` si aucun `data-gv-type="image-list"` dans le HTML.

### Carousel

```json
"settings": {
  "backgroundColor": "#000000",
  "clickTag": "https://example.com",
  "slideInterval": 2800
},
"images": {
  "heroSlides": [
    "https://cdn.example/slide1.jpg",
    "https://cdn.example/slide2.jpg"
  ]
}
```

HTML correspondant :

```html
<div data-gv-bind="heroSlides" data-gv-type="image-list">
  <img src="" alt="" />
  <img src="" alt="" />
</div>
```

Le comportement du carousel (dots, `transform`, pause) reste dans `js` / `css` du créatif.

### Texte avec HTML dans la chaîne

```json
"fields": {
  "headline": {
    "text": "NOUVELLE <span class=\"hl\">E-208</span>",
    "font": "Peugeot New",
    "size": 22,
    "weight": "700",
    "style": "normal",
    "color": "#FFFFFF"
  }
}
```

---

## 7. Checklist — construire un JSON d’import Generic

| Étape | Action |
|-------|--------|
| 1 | `type: "generic"` + `dimensions` |
| 2 | Ajouter `fields`, `images`, `settings` (objets ; `{}` autorisé si aucune zone de ce type) |
| 3 | Sur le conteneur principal : `data-gv-bind="canvas"` + `data-gv-type="root"` |
| 4 | Pour **chaque** clé de `fields` : nœud HTML avec `data-gv-bind="<cle>"` + `data-gv-type="text"` ou `"link"` |
| 5 | Pour **chaque** clé de `images` : `<img data-gv-bind="<cle>" data-gv-type="image">` ou conteneur `data-gv-type="image-list"` avec un `<img src="">` par slide |
| 6 | Mettre les URLs uniquement dans `images.<cle>[]` ; `src=""` dans le HTML |
| 7 | Fond / clic / intervalle dans `settings` (pas à la racine) |
| 8 | `slideInterval` seulement si binding `image-list` présent |
| 9 | Optionnel : `css`, `js` — carousel / animations ; cibler les bindings pour rester compatible avec `update()` |
| 10 | Tester l’import : en cas d’erreur, lire le toast (§2.8) |
| 11 | Chaque `data-gv-bind` texte/link sur un élément **visible** (pas `hidden` / `gv-field-bindings`) — §2.8, §2.13 |
| 12 | Pas d’entités HTML (`&amp;`, `&nbsp;`) dans les champs plain-text ; caractères Unicode — §1.6 |
| 13 | Titres multi-styles : un binding par segment (`headline` + `headlineAccent`, …) — §2.13 |
| 14 | Tout texte du mock (badges promo, mentions, …) : markup HTML + entrée `fields` — §2.13 |
| 15 | Si `text-transform: uppercase` en CSS sur un nœud lié : pas d’entités HTML dans son `fields.*.text` — §1.6 |
| 16 | CTA : `fields.ctaText` = texte plain ; `<span class="cta-label"></span>` vide dans le HTML — §2.5 |

| Besoin | Où le mettre | Binding HTML |
|--------|----------------|--------------|
| Texte stylé | `fields.<cle>` → `TextStyle` ou `string` (§1.1) | `data-gv-type="text"` |
| CTA + lien | `fields.<cle>` + `settings.clickTag` | `data-gv-type="link"` |
| Image unique | `images.<cle>` → `["url"]` (§1.3) | `data-gv-type="image"` |
| Carousel | `images.<cle>` → `["url1","url2",…]` | `data-gv-type="image-list"` |
| Fond | `settings.backgroundColor` | `background` ou `root` (optionnel) |
| Taille bannière | `dimensions` | — |
| Créatif | `html` (obligatoire), `css`, `js` (optionnels) | — |

Les widgets §3 (`text`, `image`, `list`, …) sont **générés automatiquement** par l’éditeur à partir du `bindingSchema` ; ne pas les inclure dans le fichier importé.

---

## 8. Annexes (document autonome)

### 8.1 Schéma TypeScript `GenericConfig`

```typescript
type GenericBindingKind =
  | 'text'
  | 'image'
  | 'image-list'
  | 'link'
  | 'background'
  | 'root';

interface GenericBindingSchema {
  key: string;
  kind: GenericBindingKind;
}

interface TextStyle {
  text: string;
  font: string;
  size: number;
  weight: string;
  style: string;
  color: string;
}

interface GenericSettings {
  backgroundColor?: string;
  clickTag?: string;
  slideInterval?: number;
}

interface GenericConfig {
  type: 'generic';
  dimensions: { width: number; height: number };
  settings: GenericSettings;
  fields: Record<string, TextStyle>;
  images: Record<string, string[]>;
  html: string;
  css?: string;
  js?: string;
  bindingSchema?: GenericBindingSchema[];
}
```

**Clés racine interdites** (schéma obsolète — doivent aller dans `fields`, `images` ou `settings`) :

`tagLine`, `headline`, `headlineAccent`, `subhead`, `legalText`, `ctaText`, `backgroundColor`, `clickTag`, `slideInterval`, `bindings`.

**Inférence de `data-gv-type`** si l’attribut est absent :

| Élément HTML | Type inféré |
|--------------|-------------|
| `<img>` | `image` |
| `<a>` | `link` |
| Conteneur avec ≥ 2 `<img>` | `image-list` |
| Autre | `text` |

---

### 8.2 Logique d’hydratation (`applyBindingSchemaToDocument`)

Pour chaque entrée du `bindingSchema`, la plateforme sélectionne `[data-gv-bind="<key>"]` et applique :

#### Texte (`text`)

```
applyTextStyleProperties(element, style)  // font, size, weight, style, color en inline style
si style.text contient '<' :
  element.innerHTML = style.text
sinon :
  element.textContent = style.text
```

#### Lien (`link`)

```
si settings.clickTag : element.href = clickTag
si enfant .cta-label existe :
  appliquer fields[key] sur .cta-label
sinon :
  appliquer fields[key] sur l'élément <a>
```

#### Image (`image`)

```
url = images[key][0]
si element est <img> : src = url
sinon : premier <img> enfant reçoit src = url
```

#### Liste d’images (`image-list`)

```
pour chaque <img> enfant, dans l'ordre DOM :
  src = images[key][index]
```

#### Fond (`background`)

```
si settings.backgroundColor : element.style.backgroundColor = backgroundColor
```

#### Racine (`root`)

```
element.style.width = dimensions.width + 'px'
element.style.height = dimensions.height + 'px'
si settings.backgroundColor : element.style.backgroundColor = backgroundColor
```

---

### 8.3 Exemple JSON — carousel 320×480 (référence complète)

`fields`, `settings`, `images` :

```json
{
  "type": "generic",
  "dimensions": { "width": 320, "height": 480 },
  "settings": {
    "backgroundColor": "#000000",
    "clickTag": "https://example.com",
    "slideInterval": 2800
  },
  "fields": {
    "tagLine": { "text": "Tag line", "font": "Inter", "size": 10, "weight": "600", "style": "normal", "color": "#B0B3B8" },
    "headline": { "text": "Titre", "font": "Inter", "size": 26, "weight": "700", "style": "normal", "color": "#FFFFFF" },
    "headlineAccent": { "text": "", "font": "Inter", "size": 26, "weight": "700", "style": "normal", "color": "#EC1C24" },
    "subhead": { "text": "Sous-titre", "font": "Inter", "size": 12, "weight": "500", "style": "normal", "color": "#B0B3B8" },
    "ctaText": { "text": "En savoir plus", "font": "Inter", "size": 13, "weight": "600", "style": "normal", "color": "#FFFFFF" },
    "legalText": { "text": "", "font": "Inter", "size": 8, "weight": "500", "style": "normal", "color": "#B0B3B8" }
  },
  "images": {
    "logo": ["https://cdn.example/logo.svg"],
    "heroSlides": ["https://cdn.example/slide1.jpg", "https://cdn.example/slide2.jpg"]
  }
}
```

`html` (une ligne en export ; structure ci-dessous) :

```html
<div data-gv-bind="canvas" data-gv-type="root">
  <div class="ad-bg" data-gv-bind="background" data-gv-type="background" aria-hidden="true"></div>
  <header class="ad-header">
    <img data-gv-bind="logo" data-gv-type="image" src="" alt="" class="ad-logo" />
  </header>
  <div class="hero-wrap">
    <div class="hero-track" data-gv-bind="heroSlides" data-gv-type="image-list">
      <div class="hero-slide"><img src="" alt="" class="hero-img" /></div>
      <div class="hero-slide"><img src="" alt="" class="hero-img" /></div>
    </div>
    <div class="carousel-dots">
      <button type="button" class="dot active" data-index="0" aria-label="Diapositive 1"></button>
      <button type="button" class="dot" data-index="1" aria-label="Diapositive 2"></button>
    </div>
  </div>
  <div class="ad-content">
    <p data-gv-bind="tagLine" data-gv-type="text" class="tag-line"></p>
    <h1 class="headline">
      <span data-gv-bind="headline" data-gv-type="text"></span>
      <span data-gv-bind="headlineAccent" data-gv-type="text" class="dmi"></span>
    </h1>
    <p data-gv-bind="subhead" data-gv-type="text" class="subhead"></p>
    <a data-gv-bind="ctaText" data-gv-type="link" href="#" class="cta-btn" target="_blank" rel="noopener noreferrer">
      <span class="cta-label"></span>
    </a>
    <p data-gv-bind="legalText" data-gv-type="text" class="legal"></p>
  </div>
</div>
```

`js` (carousel minimal — intervalle aligné sur `settings.slideInterval`) :

```javascript
(function () {
  'use strict';
  var track = document.querySelector('[data-gv-bind="heroSlides"]');
  var dots = document.querySelectorAll('.carousel-dots .dot');
  var TOTAL = dots.length || 2;
  var current = 0;
  var timer = null;
  var isPaused = false;
  function goTo(i) {
    if (!track) return;
    current = ((i % TOTAL) + TOTAL) % TOTAL;
    track.style.transform = 'translateX(-' + (current * (100 / TOTAL)) + '%)';
    dots.forEach(function (d, idx) {
      d.classList.toggle('active', idx === current);
    });
  }
  function startTimer() {
    timer = setInterval(function () {
      if (!isPaused) goTo(current + 1);
    }, 2800);
  }
  dots.forEach(function (d) {
    d.addEventListener('click', function () {
      goTo(parseInt(d.getAttribute('data-index') || '0', 10));
    });
  });
  var wrap = track && track.closest('.hero-wrap');
  if (wrap) {
    wrap.addEventListener('mouseenter', function () { isPaused = true; });
    wrap.addEventListener('mouseleave', function () { isPaused = false; });
  }
  goTo(0);
  startTimer();
})();
```

---

### 8.4 Exemple JSON — bannière statique 320×480

```json
{
  "type": "generic",
  "dimensions": { "width": 320, "height": 480 },
  "settings": {
    "backgroundColor": "#1A1A2E",
    "clickTag": "https://example.com"
  },
  "fields": {
    "title": { "text": "Titre principal", "font": "Inter", "size": 24, "weight": "700", "style": "normal", "color": "#FFFFFF" },
    "offer": { "text": "Offre limitée", "font": "Inter", "size": 13, "weight": "500", "style": "normal", "color": "#B0B3B8" },
    "ctaText": { "text": "Découvrir", "font": "Inter", "size": 13, "weight": "600", "style": "normal", "color": "#FFFFFF" }
  },
  "images": {
    "hero": ["https://cdn.example/hero.jpg"]
  },
  "html": "<div data-gv-bind=\"canvas\" data-gv-type=\"root\"><div data-gv-bind=\"background\" data-gv-type=\"background\" class=\"bg\"></div><img data-gv-bind=\"hero\" data-gv-type=\"image\" class=\"hero\" src=\"\" alt=\"\" /><div class=\"content\"><h1 data-gv-bind=\"title\" data-gv-type=\"text\"></h1><p data-gv-bind=\"offer\" data-gv-type=\"text\"></p><a data-gv-bind=\"ctaText\" data-gv-type=\"link\" class=\"cta\" href=\"#\"><span class=\"cta-label\"></span></a></div></div>",
  "css": "[data-gv-bind=\"canvas\"]{width:320px;height:480px;position:relative;overflow:hidden;font-family:Inter,sans-serif;color:#fff}.bg{position:absolute;inset:0}.hero{width:100%;height:240px;object-fit:cover;display:block}.content{padding:16px}.cta{display:inline-block;margin-top:12px;padding:10px 16px;background:#EC1C24;color:#fff;text-decoration:none;border-radius:4px}"
}
```

Pas de `slideInterval` dans `settings` : aucun binding `image-list` dans le HTML.

---

### 8.5 Réparation d’exports JSON défectueux

Procédures à appliquer manuellement (ou via script) lorsqu’un export externe manque de bindings ou casse le rendu à l’import.

#### 8.5.1 Titres composites + CTA (cas type Kusmi)

**Symptômes :** `headline` lié sur tout le `<h1>` avec HTML inline ; `headlineAccent` dans un bloc `hidden` ; entités `&amp;` / `&nbsp;` dans les champs plain-text.

**Corrections HTML :**

1. Remplacer le bloc titre par des bindings **visibles** par segment :

```html
<h1 class="headline">
  <span data-gv-bind="headline" data-gv-type="text">Maison</span>
  <em><span data-gv-bind="headlineAccent" data-gv-type="text">Bubble Tea</span></em>
</h1>
```

2. Supprimer tout conteneur `gv-field-bindings` / `hidden` utilisé uniquement pour satisfaire la validation.

3. CTA : un seul binding `ctaText` sur le `<a>`, libellé plain dans `fields`, span vide :

```html
<a data-gv-bind="ctaText" data-gv-type="link" href="#" class="cta-btn">
  <span class="cta-label"></span>
</a>
```

```json
"ctaText": { "text": "Découvrir le kit", "font": "Montserrat", "size": 12, "weight": "700", "style": "normal", "color": "#FFFFFF" }
```

4. Remplacer les entités HTML par des caractères Unicode dans `fields` (§1.6).

5. Footer avec HTML riche : inclure une balise pour activer `innerHTML`, ex. :

```json
"text_982": { "text": "kusmi<strong>tea</strong>.com | Fait en France | Bio certifié", "font": "Montserrat", "size": 8, "weight": "400", "style": "normal", "color": "rgba(255,255,255,0.7)" }
```

#### 8.5.2 Carousel multi-marques (cas type Decathlon)

**Symptômes :** logo et slides en `src` inline base64 ; carousel ciblé par `id` / classes sans `data-gv-bind`.

**Corrections :**

1. Logo : ajouter `data-gv-bind="logo" data-gv-type="image"` sur le `<img>`, vider `src=""`, URL dans `images.logo[]`.

2. Carousel : ajouter `data-gv-bind="heroSlides" data-gv-type="image-list"` sur le conteneur des slides ; une URL par `<img>` enfant dans `images.heroSlides[]`.

3. Textes : ajouter `data-gv-bind="<cle>" data-gv-type="text"` sur chaque zone éditable (titres, prix, légal, …).

4. CTA : `data-gv-bind="ctaBtn" data-gv-type="link"` sur le `<a>` ; libellé dans `fields.ctaBtn` ou enfant `.cta-label`.

5. Compléter `fields` et `settings` (`slideInterval` si `image-list` présent).
