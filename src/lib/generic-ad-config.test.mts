import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyFieldStylesFromCss,
  buildGenericAdConfig,
  buildGenericAdConfigFromStrings,
  GENERIC_CONFIG_FILENAME,
  isGenericConfigFileFresh,
  writeGenericAdConfigFile,
  embedBundleAssetsInConfig,
  extractAdRootHtml,
  findFirstAdDomId,
  getBoundKeysInHtml,
  getUnboundGenericConfigKeysError,
  injectGenericBindings,
  normalizeTextStyle,
  parseCssRuleBlock,
  prepareCssForGalleryExport,
  restructureCtaLabelHtml,
  restructureHeadlineAccentHtml,
  resolveLocalAssetToDataUrl,
  serializeGenericAdConfig,
  splitHeadlineAccentFields,
  validateGenericAdConfig,
  type GenericAdConfig,
  type GenericTextField
} from './generic-ad-config.mts';
import { repoRootFromModuleDir } from './repo-paths.mts';

const repoRoot = repoRootFromModuleDir(import.meta.dirname);

function cfgField (cfg: GenericAdConfig, key: string): GenericTextField {
  const field = cfg.fields[key];
  assert.ok(field, key);
  return field;
}

function cfgFieldOpt (cfg: GenericAdConfig, key: string): GenericTextField | undefined {
  return cfg.fields[key];
}

function cfgImages (cfg: GenericAdConfig, key: string): string[] {
  const urls = cfg.images[key];
  assert.ok(urls, key);
  return urls;
}

function cfgImagesOpt (cfg: GenericAdConfig, key: string): string[] | undefined {
  return cfg.images[key];
}

const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const IKEA_INDEX = `<!DOCTYPE html>
<html lang="fr">
<head>
  <title>IKEA SÖDERHAMN – Publicité 300×250</title>
</head>
<body>
  <div id="ad-300x250">
    <div class="ad-header">
      <img src="./ikea.svg" alt="logo" class="ad-logo">
    </div>
    <div class="ad-carousel">
      <div class="carousel-track">
        <div class="carousel-slide active">
          <img src="./slide1.jpg" alt="">
        </div>
        <div class="carousel-slide">
          <img src="./slide2.jpg" alt="">
        </div>
      </div>
    </div>
    <div class="ad-copy">
      <p class="ad-headline" id="adHeadline">Vivez le confort</p>
      <p class="ad-sub" id="adSub">Canapés modulables</p>
    </div>
    <div class="ad-footer">
      <a class="ad-cta" href="https://www.ikea.com/fr/fr/cat/soederhamn-serie-22178/">Découvrir la série</a>
    </div>
  </div>
</body>
</html>`;

const IKEA_CSS = `#ad-300x250 {
  width: 300px;
  height: 250px;
  background: #F5F2EC;
}`;

const IKEA_JS = `(function () {
  var slideCopy = [
    { headline: 'Vivez le confort\\u00A0<br>à votre façon', sub: 'Canapés modulables – Configurez, changez, profitez.' }
  ];
  var INTERVAL = 3200;
  setInterval(function () {}, INTERVAL);
}());`;

test('findFirstAdDomId detects ad-300x250', () => {
  assert.equal(findFirstAdDomId(IKEA_INDEX), 'ad-300x250');
});

test('extractAdRootHtml returns ad wrapper markup', () => {
  const html = extractAdRootHtml(IKEA_INDEX, 'ad-300x250');
  assert.ok(html !== null);
  assert.match(html!, /id="ad-300x250"/u);
  assert.match(html!, /ad-cta/u);
});

test('injectGenericBindings adds data-gv-bind on ad root', () => {
  const raw = '<div id="ad-300x250"><p class="ad-headline">Hi</p></div>';
  const out = injectGenericBindings(raw);
  assert.match(out, /data-gv-bind="canvas"/u);
  assert.match(out, /data-gv-type="root"/u);
});

test('buildGenericAdConfigFromStrings ikea-like strict schema', () => {
  const cfg = buildGenericAdConfigFromStrings({
    indexHtml: IKEA_INDEX,
    stylesCss: IKEA_CSS,
    appJs: IKEA_JS
  });

  assert.equal(cfg.type, 'generic');
  assert.deepEqual(cfg.dimensions, { width: 300, height: 250 });
  assert.equal(cfg.settings.slideInterval, 3200);
  assert.equal(cfg.settings.backgroundColor, '#F5F2EC');
  assert.equal(cfg.settings.clickTag, 'https://www.ikea.com/fr/fr/cat/soederhamn-serie-22178/');
  assert.match(cfgField(cfg, 'headline').text, /Vivez le confort/u);
  assert.match(cfgField(cfg, 'headline').text, /<br>/u);
  assert.match(cfgField(cfg, 'subhead').text, /Canapés modulables/u);
  assert.equal(cfgField(cfg, 'ctaText').text, 'Découvrir la série');
  assert.deepEqual(cfgImages(cfg, 'logo'), [ './ikea.svg' ]);
  assert.equal(cfgImages(cfg, 'heroSlides').length, 2);
  assert.match(cfg.html, /data-gv-bind=/u);
  assert.match(cfg.html, /data-gv-type="image-list"/u);
  assert.ok(cfg.css!.length > 0);
  assert.ok(cfg.js!.length > 0);
  assert.equal(validateGenericAdConfig(cfg).ok, true);
  assert.equal(validateGenericAdConfig({ type: 'generic', headline: {} }).ok, false);
  for (const key of Object.keys(cfg.fields)) {
    assert.ok(getBoundKeysInHtml(cfg.html).has(key), `missing bind for fields.${key}`);
  }
  for (const key of Object.keys(cfg.images)) {
    assert.ok(getBoundKeysInHtml(cfg.html).has(key), `missing bind for images.${key}`);
  }
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

test('serializeGenericAdConfig omits slideInterval without image-list binding', () => {
  const cfg = serializeGenericAdConfig({
    type: 'generic',
    dimensions: { width: 300, height: 250 },
    settings: { backgroundColor: '#000000', slideInterval: 3000 },
    fields: {
      title: normalizeTextStyle({
        text: 'Titre',
        font: 'Inter',
        size: 26,
        weight: '700',
        style: 'normal',
        color: '#FFFFFF'
      })
    },
    images: {},
    html: '<div data-gv-bind="canvas" data-gv-type="root"><p data-gv-bind="title" data-gv-type="text">Titre</p></div>'
  });
  assert.equal(cfg.settings.slideInterval, undefined);
});

test('normalizeTextStyle coerces weight to string', () => {
  const t = normalizeTextStyle({
    text: 'x',
    font: 'Inter',
    size: 14,
    weight: 600 as unknown as string,
    style: 'normal',
    color: '#fff'
  });
  assert.equal(t.weight, '600');
});

test('resolveLocalAssetToDataUrl encodes PNG as base64 data URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'generic-ad-config-'));
  try {
    writeFileSync(join(dir, 'pixel.png'), Buffer.from(PNG_1X1_BASE64, 'base64'));
    const url = resolveLocalAssetToDataUrl(dir, './pixel.png');
    assert.ok(url !== null);
    assert.match(url!, /^data:image\/png;base64,/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveLocalAssetToDataUrl embeds images larger than 2 MB', () => {
  const dir = mkdtempSync(join(tmpdir(), 'generic-ad-config-'));
  try {
    const largePng = Buffer.alloc(2 * 1024 * 1024 + 1, 0);
    largePng[0] = 0x89;
    largePng[1] = 0x50;
    largePng[2] = 0x4e;
    largePng[3] = 0x47;
    writeFileSync(join(dir, 'large.png'), largePng);
    const url = resolveLocalAssetToDataUrl(dir, './large.png');
    assert.ok(url !== null);
    assert.match(url!, /^data:image\/png;base64,/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const KUSMI_HEADLINE_INDEX = `<div id="ad-300x600">
  <img src="./logo.png" alt="Kusmi Tea" class="logo">
  <div class="hero-wrap">
    <div class="slide active"><img src="./a.jpg" class="hero-img"></div>
  </div>
  <h1 class="headline">Préparez votre<br><em>Bubble Tea</em></h1>
  <a href="https://www.kusmitea.com" class="cta-btn">Découvrir</a>
</div>`;

test('splitHeadlineAccentFields and restructureHeadlineAccentHtml split em accent', () => {
  const fields: Record<string, import('./generic-ad-config.mts').GenericTextField> = {
    headline: {
      text: 'Préparez votre<br><em>Bubble Tea</em>',
      font: 'Inter',
      size: 26,
      weight: '700',
      style: 'normal',
      color: '#FFFFFF'
    }
  };
  splitHeadlineAccentFields(fields, () => ({ color: '#C8102E' }));
  assert.equal(fields['headline']?.text, 'Préparez votre');
  assert.equal(fields['headlineAccent']?.text, 'Bubble Tea');
  const html = injectGenericBindings(KUSMI_HEADLINE_INDEX);
  const restructured = restructureHeadlineAccentHtml(html);
  assert.match(restructured, /data-gv-bind="headlineAccent"/u);
  assert.match(restructured, /data-gv-bind="headline"[^>]*>Préparez votre</u);
});

test('embedBundleAssetsInConfig inlines local images in html and images.*', () => {
  const dir = mkdtempSync(join(tmpdir(), 'generic-ad-config-'));
  try {
    writeFileSync(join(dir, 'pixel.png'), Buffer.from(PNG_1X1_BASE64, 'base64'));
    const base = buildGenericAdConfigFromStrings({
      indexHtml: `<div id="ad-300x250"><img src="./pixel.png" class="ad-logo"></div>`,
      stylesCss: '#ad-300x250{width:300px;height:250px}',
      appJs: 'var INTERVAL=2800;'
    });
    const cfg = embedBundleAssetsInConfig(base, dir);
    assert.match(cfgImages(cfg, 'logo')[0] ?? '', /^data:image\/png;base64,/u);
    assert.match(cfg.html, /<img[^>]*\bdata-gv-bind="logo"[^>]*>/u);
    assert.match(cfg.html, /<img[^>]*\bsrc=""/u);
    assert.doesNotMatch(cfg.html, /\bsrc=["']data:image/iu);
    assert.doesNotMatch(cfg.html, /\.\/pixel\.png/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PEUGEOT_INDEX = `<!DOCTYPE html>
<html lang="fr">
<body>
  <div id="ad-320x480">
    <header class="ad-header">
      <span class="ad-tagline">ALLURE · POWER · EXCELLENCE</span>
    </header>
    <div class="variant-tabs">
      <button class="tab-btn active" data-variant="electric">E-208</button>
      <button class="tab-btn" data-variant="hybrid">Hybride</button>
      <button class="tab-btn" data-variant="puretech">PureTech</button>
    </div>
    <div class="hero-wrap">
      <div class="hero-slide active" data-slide="electric">
        <div class="hero-badge electric-badge">100% Électrique</div>
      </div>
      <div class="hero-slide" data-slide="hybrid">
        <div class="hero-badge hybrid-badge">Hybride</div>
      </div>
      <div class="hero-slide" data-slide="puretech">
        <div class="hero-badge puretech-badge">PureTech</div>
      </div>
    </div>
    <div class="ad-copy">
      <h1 class="ad-headline" id="ad-headline">NOUVELLE <span class="hl">208</span></h1>
      <p class="ad-sub" id="ad-sub">Le choix de la puissance,<br>100% électrique.</p>
      <p class="ad-price" id="ad-price">À partir de <strong>179 €/mois</strong><sup>*</sup></p>
    </div>
    <div class="ad-footer">
      <a href="https://www.peugeot.fr/offres/208.html" class="cta-btn">Découvrir l'offre</a>
      <p class="ad-legal">*Offre sous conditions.</p>
    </div>
  </div>
</body>
</html>`;

const PEUGEOT_JS = `(function () {
  const variants = {
    electric: {
      headline: 'NOUVELLE <span class="hl">E-208</span>',
      sub: 'Zéro émission,<br>100% plaisir.',
      price: 'À partir de <strong>179 €/mois</strong><sup>*</sup>',
    },
    hybrid: {
      headline: 'NOUVELLE <span class="hl">208</span>',
      sub: 'La perfection<br>hybride.',
      price: 'À partir de <strong>199 €/mois</strong><sup>*</sup>',
    },
    puretech: {
      headline: 'NOUVELLE <span class="hl">208</span>',
      sub: 'PureTech thermique.',
      price: 'À partir de <strong>149 €/mois</strong><sup>*</sup>',
    },
  };
}());`;

test('buildGenericAdConfigFromStrings peugeot exports all text fields', () => {
  const cfg = buildGenericAdConfigFromStrings({
    indexHtml: PEUGEOT_INDEX,
    stylesCss: '#ad-320x480{width:320px;height:480px}',
    appJs: PEUGEOT_JS
  });
  const nonEmpty = Object.values(cfg.fields).filter((f) => f.text.trim().length > 0);
  assert.ok(nonEmpty.length >= 15);
  assert.match(cfgField(cfg, 'tagLine').text, /ALLURE/u);
  assert.match(cfgField(cfg, 'headline').text, /NOUVELLE/u);
  assert.match(cfgField(cfg, 'subhead').text, /puissance|plaisir|Zéro/iu);
  assert.match(cfgField(cfg, 'price').text, /179 €\/mois/u);
  assert.equal(cfgField(cfg, 'tab_hybrid').text, 'Hybride');
  assert.match(cfgField(cfg, 'badge_electric').text, /Électrique/u);
  assert.match(cfgField(cfg, 'headline_electric').text, /E-208/u);
  assert.match(cfgField(cfg, 'headline_hybrid').text, /208/u);
  assert.match(cfgField(cfg, 'price_puretech').text, /149 €\/mois/u);
  assert.equal(cfgField(cfg, 'ctaText').text, "Découvrir l'offre");
  assert.match(cfg.html, /data-gv-bind="headline_electric"/u);
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

test('discovery exports generic paragraphs without standard class names', () => {
  const cfg = buildGenericAdConfigFromStrings({
    indexHtml: `<div id="ad-300x250">
      <p class="copy-a">Texte A</p>
      <p class="copy-b">Texte B</p>
      <p class="copy-c">Texte C</p>
    </div>`,
    stylesCss: '#ad-300x250{width:300px;height:250px}',
    appJs: ''
  });
  const texts = Object.values(cfg.fields).map((f) => f.text);
  assert.ok(texts.includes('Texte A'));
  assert.ok(texts.includes('Texte B'));
  assert.ok(texts.includes('Texte C'));
  assert.ok(Object.keys(cfg.fields).length >= 3);
});

test('buildGenericAdConfig embeds assets from real bundle files', () => {
  const runDir = join(
    repoRoot,
    'output',
    'ikea-15dbc26d-c234-4591-bee3-9e88461516ff'
  );
  const bundleDir = join(runDir, 'code', 'V4');
  if (!existsSync(join(bundleDir, 'index.html'))) {
    return;
  }
  const cfg = buildGenericAdConfig({ bundleDir, outputRunDir: runDir });
  assert.ok(cfg.settings.backgroundColor !== undefined || cfg.settings.clickTag !== undefined);
  assert.ok(cfgImages(cfg, 'logo')[0]?.startsWith('data:image/'));
  assert.ok(cfgImages(cfg, 'heroSlides').every((u) => u.startsWith('data:image/')));
  assert.doesNotMatch(cfg.html, /src="\.\//u);
  assert.match(cfg.html, /data-gv-bind=/u);
  assert.match(cfg.html, /data-gv-bind="logo"/u);
  assert.match(cfg.html, /<img[^>]*\bdata-gv-bind="logo"[^>]*>/u);
  assert.doesNotMatch(cfg.html, /\bsrc=["']data:image/iu);
  assert.equal(cfgFieldOpt(cfg, 'headline') !== undefined, true);
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

test('writeGenericAdConfigFile writes valid generic-config.json', () => {
  const runDir = join(
    repoRoot,
    'output',
    'ikea-15dbc26d-c234-4591-bee3-9e88461516ff'
  );
  const bundleDir = join(runDir, 'code', 'V4');
  if (!existsSync(join(bundleDir, 'index.html'))) {
    return;
  }
  const outDir = mkdtempSync(join(tmpdir(), 'generic-config-write-'));
  const outPath = join(outDir, GENERIC_CONFIG_FILENAME);
  try {
    const { path, config } = writeGenericAdConfigFile({
      bundleDir,
      outputRunDir: runDir,
      outPath
    });
    assert.equal(path, outPath);
    assert.ok(existsSync(outPath));
    const parsed = JSON.parse(readFileSync(outPath, 'utf8')) as unknown;
    const validated = validateGenericAdConfig(parsed);
    assert.equal(validated.ok, true);
    assert.equal(validated.ok && validated.config.type, 'generic');
    assert.equal(config.type, 'generic');
    assert.equal(getUnboundGenericConfigKeysError(config), null);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('isGenericConfigFileFresh false when index.html is newer than json', () => {
  const runDir = join(
    repoRoot,
    'output',
    'ikea-15dbc26d-c234-4591-bee3-9e88461516ff'
  );
  const sourceBundle = join(runDir, 'code', 'V4');
  if (!existsSync(join(sourceBundle, 'index.html'))) {
    return;
  }
  const tmpBundle = mkdtempSync(join(tmpdir(), 'generic-config-fresh-'));
  try {
    for (const name of [ 'index.html', 'styles.css', 'app.js' ] as const) {
      copyFileSync(join(sourceBundle, name), join(tmpBundle, name));
    }
    writeGenericAdConfigFile({ bundleDir: tmpBundle, outputRunDir: runDir });
    assert.equal(isGenericConfigFileFresh(tmpBundle), true);
    const futureSec = Math.floor(Date.now() / 1000) + 60;
    utimesSync(join(tmpBundle, 'index.html'), futureSec, futureSec);
    assert.equal(isGenericConfigFileFresh(tmpBundle), false);
  } finally {
    rmSync(tmpBundle, { recursive: true, force: true });
  }
});

const NIKE_LIKE_INDEX = `<!DOCTYPE html>
<html lang="fr"><head><title>Nike 320x480</title></head><body>
<div id="ad-320x480">
  <header class="ad-header">
    <img src="./langfr-250px-Logo_NIKE.svg.png" alt="Nike" class="nike-logo">
    <span class="badge">NOUVEAUTÉS</span>
  </header>
  <h1 class="headline">TOUT NOUVEAU</h1>
  <div class="carousel-wrapper">
    <div class="carousel" id="carousel">
      <div class="slide active"><img src="./a.jpg" alt="A" class="product-img"></div>
      <div class="slide"><img src="./b.jpg" alt="B" class="product-img"></div>
    </div>
  </div>
  <a href="https://www.nike.com/fr/" class="cta-btn">Découvrir</a>
</div>
<script src="app.js" defer></script>
</body></html>`;

test('buildGenericAdConfigFromStrings nike-like carousel binds heroSlides', () => {
  const cfg = buildGenericAdConfigFromStrings({
    indexHtml: NIKE_LIKE_INDEX,
    stylesCss: '#ad-320x480{width:320px;height:480px;background:#111111}',
    appJs: 'const SLIDE_INTERVAL = 4000;'
  });
  assert.ok(cfg.images['heroSlides'] !== undefined);
  assert.ok(cfg.images['heroSlides']!.length >= 2);
  assert.match(cfg.html, /data-gv-bind="heroSlides"/u);
  assert.match(cfg.html, /data-gv-type="image-list"/u);
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

const NIKE_V3_SLIDE_TRACK = `<!DOCTYPE html>
<html lang="fr"><head><title>Nike 300x600</title></head><body>
<div id="ad-300x600">
  <div class="ad-header">
    <img src="./langfr-250px-Logo_NIKE.svg.png" alt="Nike" class="nike-logo">
    <span class="nouveautes-tag">NOUVEAUTÉS</span>
  </div>
  <div class="slide-track" id="slideTrack">
    <div class="slide" data-index="0"><img src="./NIKE_MIND_001.jpg" class="product-img" alt="A"></div>
    <div class="slide" data-index="1"><img src="./W_NIKE_MIND_001.jpg" class="product-img" alt="B"></div>
    <div class="slide" data-index="2"><img src="./W_NK_STDO_FLC_MW_MR_STD_4_SHRT.jpg" class="product-img" alt="C"></div>
    <div class="slide" data-index="3"><img src="./W_NK_STDO_FLC_MW_MR_STD_OH_PNT.jpg" class="product-img" alt="D"></div>
  </div>
  <a href="https://www.nike.com/fr/w/nouveau-3n82y" class="cta-btn">Découvrir</a>
</div>
<script src="app.js" defer></script>
</body></html>`;

test('buildGenericAdConfigFromStrings nike V3 slide-track conforms to reference', () => {
  const cfg = buildGenericAdConfigFromStrings({
    indexHtml: NIKE_V3_SLIDE_TRACK,
    stylesCss: '#ad-300x600{width:300px;height:600px;background:#111111}',
    appJs: 'const SLIDE_INTERVAL = 3500;'
  });
  assert.equal(cfg.type, 'generic');
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
  assert.match(cfg.html, /data-gv-bind="heroSlides"[^>]*data-gv-type="image-list"|data-gv-type="image-list"[^>]*data-gv-bind="heroSlides"/u);
  assert.match(cfg.html, /class="slide-track"[^>]*data-gv-bind="heroSlides"|data-gv-bind="heroSlides"[^>]*class="slide-track"/u);
  assert.equal(cfg.images['heroSlides']!.length, 4);
  assert.equal(cfg.settings.slideInterval !== undefined, true);
});

test('buildGenericAdConfig nike V3 bundle heroSlides binding', () => {
  const runDir = join(
    repoRoot,
    'output',
    'nike-21f06d24-5fbb-4fc2-9894-c600aa5abe4b'
  );
  const bundleDir = join(runDir, 'code', 'V3');
  const indexPath = join(bundleDir, 'index.html');
  if (!existsSync(indexPath)) {
    return;
  }
  const cfg = buildGenericAdConfig({ bundleDir, outputRunDir: runDir });
  assert.ok(cfg.images['heroSlides'] !== undefined);
  assert.equal(cfg.images['heroSlides']!.length, 4);
  assert.match(cfg.html, /data-gv-bind="heroSlides"/u);
  assert.match(cfg.html, /data-gv-type="image-list"/u);
  assert.doesNotMatch(cfg.html, /\bsrc=["']data:image/iu);
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

test('buildGenericAdConfig nike V2 bundle heroSlides binding', () => {
  const runDir = join(
    repoRoot,
    'output',
    'nike-21f06d24-5fbb-4fc2-9894-c600aa5abe4b'
  );
  const bundleDir = join(runDir, 'code', 'V2');
  const indexPath = join(bundleDir, 'index.html');
  if (!existsSync(indexPath)) {
    return;
  }
  const cfg = buildGenericAdConfig({ bundleDir, outputRunDir: runDir });
  assert.ok(cfg.images['heroSlides'] !== undefined);
  assert.ok(cfg.images['heroSlides']!.length >= 2);
  assert.match(cfg.html, /data-gv-bind="heroSlides"/u);
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

const KUSMI_COPY_CSS = `
.eyebrow { font-family: "Montserrat", sans-serif; font-weight: 600; font-size: 9px; color: #F9A03F; }
.headline { font-family: "Playfair Display", sans-serif; font-weight: 700; font-size: 26px; color: #1A1A1A; }
.headline em { font-style: italic; color: #C8102E; }
.subhead { font-family: "Montserrat", sans-serif; font-weight: 600; font-size: 9px; color: #1A1A1A; }
.body-copy { font-family: "Montserrat", sans-serif; font-weight: 400; font-size: 11px; color: #1A1A1A; }
.cta-btn { font-family: "Montserrat", sans-serif; font-weight: 700; font-size: 12px; color: #FFFFFF; }
.ad-footer span { font-family: "Montserrat", sans-serif; font-weight: 400; font-size: 8px; color: rgba(255, 255, 255, 0.7); }
`;

test('parseCssRuleBlock reads typographic declarations', () => {
  const decl = parseCssRuleBlock(KUSMI_COPY_CSS, '.eyebrow');
  assert.equal(decl?.fontFamily, 'Montserrat');
  assert.equal(decl?.fontSize, 9);
  assert.equal(decl?.fontWeight, '600');
  assert.equal(decl?.color, '#F9A03F');
});

test('applyFieldStylesFromCss merges CSS onto fields', () => {
  const fields = {
    eyebrow: {
      text: 'Nouveauté été',
      font: 'Inter',
      size: 12,
      weight: '500',
      style: 'normal' as const,
      color: '#B0B3B8'
    }
  };
  applyFieldStylesFromCss(fields, KUSMI_COPY_CSS);
  assert.equal(fields.eyebrow.font, 'Montserrat');
  assert.equal(fields.eyebrow.size, 9);
  assert.equal(fields.eyebrow.color, '#F9A03F');
});

test('restructureCtaLabelHtml uses empty cta-label per reference §2.5', () => {
  const html =
    '<a href="#" class="cta-btn" data-gv-bind="ctaText" data-gv-type="link">Découvrir</a>';
  const out = restructureCtaLabelHtml(html);
  assert.match(out, /<span class="cta-label"><\/span>/u);
});

test('prepareCssForGalleryExport strips bubbles and adds @import', () => {
  const raw = `
.bg-bubbles { position: absolute; }
.bubble { opacity: 0.2; }
#ad-300x600::before { content: ''; height: 3px; }
#ad-300x600 { border-radius: 4px; box-shadow: 0 8px 40px #000; }
.ad-header { border-bottom: 2px solid red; padding: 8px; }
.headline { font-family: "Playfair Display", serif; color: #1A1A1A; }
.headline em { font-style: italic; color: #C8102E; }
body { font-family: "Montserrat", sans-serif; }
`;
  const out = prepareCssForGalleryExport(raw, {}, 'ad-300x600');
  assert.match(out, /^@import url\('/u);
  assert.doesNotMatch(out, /bg-bubbles/u);
  assert.doesNotMatch(out, /::before/u);
  assert.doesNotMatch(out, /border-radius/u);
  assert.doesNotMatch(out, /box-shadow/u);
  assert.doesNotMatch(out, /border-bottom/u);
});

test('buildGenericAdConfig kusmi V2 matches gallery field styles', () => {
  const runDir = join(
    repoRoot,
    'output',
    'kusmi-tea-ef487823-9c9e-4a4d-b3b9-6c39c80c9717'
  );
  const bundleDir = join(runDir, 'code', 'V2');
  if (!existsSync(join(bundleDir, 'index.html'))) {
    return;
  }
  const cfg = buildGenericAdConfig({ bundleDir, outputRunDir: runDir });
  assert.equal(cfgFieldOpt(cfg, 'eyebrow')?.font, 'Montserrat');
  assert.equal(cfgFieldOpt(cfg, 'eyebrow')?.size, 9);
  assert.equal(cfgFieldOpt(cfg, 'eyebrow')?.weight, '600');
  assert.equal(cfgFieldOpt(cfg, 'eyebrow')?.color, '#F9A03F');
  assert.equal(cfgFieldOpt(cfg, 'headline')?.text, 'Préparez votre');
  assert.equal(cfgFieldOpt(cfg, 'headline')?.font, 'Playfair Display');
  assert.equal(cfgFieldOpt(cfg, 'headline')?.size, 26);
  assert.equal(cfgFieldOpt(cfg, 'headline')?.weight, '700');
  assert.equal(cfgFieldOpt(cfg, 'headline')?.color, '#1A1A1A');
  assert.equal(cfgFieldOpt(cfg, 'headlineAccent')?.text, 'Bubble Tea');
  assert.equal(cfgFieldOpt(cfg, 'headlineAccent')?.style, 'italic');
  assert.equal(cfgFieldOpt(cfg, 'headlineAccent')?.color, '#C8102E');
  assert.equal(cfgFieldOpt(cfg, 'subhead')?.font, 'Montserrat');
  assert.equal(cfgFieldOpt(cfg, 'subhead')?.size, 9);
  assert.equal(cfgFieldOpt(cfg, 'body_copy')?.size, 11);
  assert.equal(cfgFieldOpt(cfg, 'ctaText')?.font, 'Montserrat');
  assert.equal(cfgFieldOpt(cfg, 'ctaText')?.size, 12);
  assert.equal(cfgFieldOpt(cfg, 'ctaText')?.weight, '700');
  assert.equal(cfgFieldOpt(cfg, 'ctaText')?.color, '#FFFFFF');
  assert.match(cfgFieldOpt(cfg, 'text_2010')?.color ?? '', /rgba\(255,\s*255,\s*255,\s*0\.7\)/u);
  assert.match(cfg.html, /data-gv-bind="headlineAccent"/u);
  assert.match(cfg.html, /<span class="cta-label"><\/span>/u);
  assert.match(cfg.css ?? '', /^@import url\('/u);
  assert.doesNotMatch(cfg.css ?? '', /bg-bubbles/u);
  assert.doesNotMatch(cfg.css ?? '', /#ad-300x600::before/u);
  assert.equal(cfgImagesOpt(cfg, 'heroSlides')?.length, 3);
  assert.ok(cfgImagesOpt(cfg, 'heroSlides')?.every((u) => u.startsWith('data:image/')));
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

test('buildGenericAdConfigFromStrings ignores product-hero for heroSlides', () => {
  const cfg = buildGenericAdConfigFromStrings({
    indexHtml: `<!DOCTYPE html><html><body><div id="ad-300x250">
      <div class="product-hero"><img src="./kit.png" alt="Kit" class="product-img"></div>
      <a href="https://example.com" class="cta-btn"><span class="cta-label">Découvrir</span></a>
    </div></body></html>`,
    stylesCss: '#ad-300x250{width:300px;height:250px}',
    appJs: ''
  });
  assert.equal(cfg.images['heroSlides'], undefined);
  assert.equal(cfg.images['hero']?.length, 1);
  assert.match(cfg.html, /data-gv-bind="hero"/u);
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

test('buildGenericAdConfigFromStrings hero-wrap extracts heroSlides', () => {
  const cfg = buildGenericAdConfigFromStrings({
    indexHtml: `<!DOCTYPE html><html><body><div id="ad-300x250">
      <div class="hero-wrap">
        <div class="slide"><img src="./a.jpg" class="hero-img" alt="A"></div>
        <div class="slide"><img src="./b.jpg" class="hero-img" alt="B"></div>
      </div>
      <a href="https://example.com" class="cta-btn"><span class="cta-label">Découvrir</span></a>
    </div></body></html>`,
    stylesCss: '#ad-300x250{width:300px;height:250px}',
    appJs: 'const SLIDE_INTERVAL = 3000;'
  });
  assert.equal(cfg.images['heroSlides']?.length, 2);
  assert.match(cfg.html, /data-gv-bind="heroSlides"/u);
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

test('buildGenericAdConfig kusmi V5 exports without heroSlides', () => {
  const runDir = join(
    repoRoot,
    'output',
    'kusmi-tea-ef487823-9c9e-4a4d-b3b9-6c39c80c9717'
  );
  const bundleDir = join(runDir, 'code', 'V5');
  if (!existsSync(join(bundleDir, 'index.html'))) {
    return;
  }
  const cfg = buildGenericAdConfig({ bundleDir, outputRunDir: runDir });
  assert.equal(cfg.dimensions.width, 300);
  assert.equal(cfg.dimensions.height, 250);
  assert.equal(cfg.images['heroSlides'], undefined);
  assert.ok(cfg.images['hero']?.[0]?.startsWith('data:image/'));
  assert.match(cfg.html, /data-gv-bind="hero"[^>]*data-gv-type="image"|data-gv-type="image"[^>]*data-gv-bind="hero"/u);
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

test('buildGenericAdConfig kusmi V5 conforms to ad-format-json-reference', () => {
  const runDir = join(
    repoRoot,
    'output',
    'kusmi-tea-ef487823-9c9e-4a4d-b3b9-6c39c80c9717'
  );
  const bundleDir = join(runDir, 'code', 'V5');
  if (!existsSync(join(bundleDir, 'index.html'))) {
    return;
  }
  const cfg = buildGenericAdConfig({ bundleDir, outputRunDir: runDir });
  assert.equal(cfgFieldOpt(cfg, 'headline')?.text, 'Maison');
  assert.equal(cfgFieldOpt(cfg, 'headlineAccent')?.text, 'Bubble Tea');
  assert.equal(cfgFieldOpt(cfg, 'subhead')?.text, 'Kit Pêche & Passion');
  assert.equal(cfgFieldOpt(cfg, 'body_copy')?.text, 'Préparez votre bubble tea fruité bio chez vous !');
  assert.equal(cfgFieldOpt(cfg, 'ctaText')?.text, 'Découvrir le kit');
  assert.equal(cfg.fields['cta_label'], undefined);
  assert.doesNotMatch(cfgFieldOpt(cfg, 'ctaText')?.text ?? '', /<[a-z]/iu);
  assert.doesNotMatch(cfgFieldOpt(cfg, 'subhead')?.text ?? '', /&amp;/u);
  assert.doesNotMatch(cfgFieldOpt(cfg, 'body_copy')?.text ?? '', /&nbsp;/u);
  assert.match(
    cfg.html,
    /<span data-gv-bind="headline"[^>]*>[\s\S]*?<\/span>\s*<em><span data-gv-bind="headlineAccent"/u
  );
  assert.match(cfg.html, /<span class="cta-label"><\/span>/u);
  assert.doesNotMatch(cfg.html, /gv-field-bindings/u);
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});

test('buildGenericAdConfigFromStrings prefers bundle CSS over campaign formats file', () => {
  const runDir = join(
    repoRoot,
    'output',
    'kusmi-tea-ef487823-9c9e-4a4d-b3b9-6c39c80c9717'
  );
  const bundleDir = join(runDir, 'code', 'V5');
  if (!existsSync(join(bundleDir, 'index.html'))) {
    return;
  }
  const indexHtml = readFileSync(join(bundleDir, 'index.html'), { encoding: 'utf8' });
  const stylesCss = readFileSync(join(bundleDir, 'styles.css'), { encoding: 'utf8' });
  const appJs = readFileSync(join(bundleDir, 'app.js'), { encoding: 'utf8' });
  const cfg = buildGenericAdConfigFromStrings({
    indexHtml,
    stylesCss,
    appJs,
    outputRunDir: runDir
  });
  assert.equal(cfg.dimensions.width, 300);
  assert.equal(cfg.dimensions.height, 250);
});

test('buildGenericAdConfig peugeot bundle completeness', () => {
  const runDir = join(
    repoRoot,
    'output',
    'peugeot-d7f60ad8-94a7-4af3-bb04-2477ec001ec2'
  );
  const bundleDir = join(runDir, 'code', 'V1');
  if (!existsSync(join(bundleDir, 'index.html'))) {
    return;
  }
  const cfg = buildGenericAdConfig({ bundleDir, outputRunDir: runDir });
  const nonEmpty = Object.keys(cfg.fields).filter((k) => cfg.fields[k]!.text.trim().length > 0);
  assert.ok(nonEmpty.length >= 15);
  assert.match(cfgField(cfg, 'tagLine').text, /ALLURE/u);
  assert.match(cfgField(cfg, 'headline').text, /NOUVELLE/u);
  assert.match(cfgField(cfg, 'headline_electric').text, /E-208/u);
  assert.match(cfg.html, /<img[^>]*\bdata-gv-bind="logo"[^>]*>/u);
  assert.doesNotMatch(cfg.html, /\bsrc=["']data:image/iu);
  assert.equal(getUnboundGenericConfigKeysError(cfg), null);
});
