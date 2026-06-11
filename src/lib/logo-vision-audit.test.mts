import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasLogoBlockers,
  mergeLogoVisionIntoAudit,
  runLogoVisionAudit,
  useLogoVisionAudit
} from './logo-vision-audit.mts';
import { pruneVisionBlockedLogos } from './creative-native-assets-deterministic.mts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('useLogoVisionAudit is enabled by default', () => {
  const prev = process.env['CREATIVE_LOGO_VISION_AUDIT'];
  delete process.env['CREATIVE_LOGO_VISION_AUDIT'];
  assert.equal(useLogoVisionAudit(), true);
  process.env['CREATIVE_LOGO_VISION_AUDIT'] = '0';
  assert.equal(useLogoVisionAudit(), false);
  if (prev !== undefined) {
    process.env['CREATIVE_LOGO_VISION_AUDIT'] = prev;
  } else {
    delete process.env['CREATIVE_LOGO_VISION_AUDIT'];
  }
});

test('mergeLogoVisionIntoAudit combines logo blockers', () => {
  const merged = mergeLogoVisionIntoAudit(
    {
      satisfied: true,
      summary: 'Products OK.',
      findings: [],
      brave_retry_queries: { logos: [], products: [ 'site:brand.com product' ] }
    },
    {
      satisfied: false,
      summary: 'Wrong logo.',
      findings: [
        {
          asset_id: 'logos/NET_Logo_1970.svg',
          severity: 'blocker',
          issue: 'Logo is National Educational Television, not Matériel.net.',
          fix_hint: 'site:materiel.net logo'
        }
      ],
      brave_retry_queries: { logos: [ 'site:materiel.net logo png' ], products: [] }
    }
  );

  assert.equal(merged.satisfied, false);
  assert.equal(merged.findings.length, 1);
  assert.ok(merged.brave_retry_queries.logos.includes('site:materiel.net logo png'));
});

test('hasLogoBlockers detects empty logos folder and per-file blockers', () => {
  assert.equal(
    hasLogoBlockers([
      { severity: 'blocker', asset_id: 'logos' },
      { severity: 'blocker', asset_id: 'products/foo.jpg' }
    ]),
    true
  );
  assert.equal(
    hasLogoBlockers([
      { severity: 'blocker', asset_id: 'logos/lidl-logo.svg' }
    ]),
    true
  );
  assert.equal(
    hasLogoBlockers([
      { severity: 'blocker', asset_id: 'products/foo.jpg' }
    ]),
    false
  );
  assert.equal(
    hasLogoBlockers([
      { severity: 'warn', asset_id: 'logos/bad.svg' }
    ]),
    false
  );
});

test('runLogoVisionAudit reports blocker when logos folder is empty', async () => {
  const directoryPath = mkdtempSync(join(tmpdir(), 'logo-vision-empty-'));
  mkdirSync(join(directoryPath, 'logos'), { recursive: true });

  const { audit, usage } = await runLogoVisionAudit({
    anthropicClient: {} as never,
    directoryPath,
    prunedStyleGuide: {
      companyName: 'Nike, Inc.',
      companyContext: 'Sportswear',
      companyURL: 'https://www.nike.com/',
      brandName: 'Nike Football',
      brandContext: 'Football line',
      brandURL: 'https://www.nike.com/football',
      productName: 'Off-Pitch Looks France',
      primaryColorPalette: [ '#111111' ],
      secondaryColorPalette: [ '#FFFFFF' ],
      typography: [
        {
          fontFamily: 'Helvetica',
          fontWeight: 400,
          fontEffect: [],
          fontUses: 'body'
        }
      ],
      brandVision: 'Test',
      brandValues: 'Test',
      logoImageSearchQueries: [],
      productImageSearchQueries: []
    },
    reviewRound: 1
  });

  assert.equal(audit.satisfied, false);
  assert.equal(usage, null);
  assert.ok(
    audit.findings.some((f) => f.severity === 'blocker' && f.asset_id === 'logos'),
    `expected logos blocker, got ${JSON.stringify(audit.findings)}`
  );
});

test('pruneVisionBlockedLogos removes blocked logo files', () => {
  const directoryPath = mkdtempSync(join(tmpdir(), 'prune-logo-'));
  mkdirSync(join(directoryPath, 'logos'), { recursive: true });
  writeFileSync(join(directoryPath, 'logos', 'bad.svg'), '<svg></svg>');
  writeFileSync(join(directoryPath, 'logos', 'good.png'), 'fake');

  const { removed, excludedSourceUrls } = pruneVisionBlockedLogos(
    directoryPath,
    [
      {
        asset_id: 'logos/bad.svg',
        severity: 'blocker'
      }
    ],
    [ 'https://upload.wikimedia.org/wikipedia/commons/bad.svg' ]
  );

  assert.deepEqual(removed, [ 'logos/bad.svg' ]);
  assert.deepEqual(excludedSourceUrls, [ 'https://upload.wikimedia.org/wikipedia/commons/bad.svg' ]);
  assert.equal(existsSync(join(directoryPath, 'logos', 'bad.svg')), false);
  assert.equal(existsSync(join(directoryPath, 'logos', 'good.png')), true);
});
