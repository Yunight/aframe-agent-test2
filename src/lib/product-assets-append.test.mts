import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { AssetDescriptionsFile } from './core.mjs';
import {
  canReconcileAfterExcessProductPrune,
  isExcessProductCountOnlyBlocker,
  listAssetImageFiles,
  maxValidProductAssets,
  pruneExcessProductAssets,
  productAppendRefreshTargetCount,
  recordProductAssetSource
} from './core.mjs';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempCampaignDir (): string {
  const dir = join(tmpdir(), `product-assets-append-${String(Date.now())}-${String(Math.random())}`);
  mkdirSync(join(dir, 'products'), { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function touchProduct (directoryPath: string, fileName: string, sourceUrl = ''): void {
  writeFileSync(join(directoryPath, 'products', fileName), 'fake-image', 'utf8');
  if (sourceUrl.length > 0) {
    recordProductAssetSource(directoryPath, fileName, sourceUrl);
  }
}

function productEntry (
  fileName: string,
  primaryProductName: string
): AssetDescriptionsFile['assets'][number] {
  return {
    asset_id: `products/${fileName}`,
    fileName,
    fileType: 'products',
    description: `Packshot of ${primaryProductName}`,
    shows_physical_product: true,
    primary_product_name: primaryProductName,
    is_generic_collection: false,
    layout_hints: [ 'packshot-centre' ],
    dominant_colors: [ '#FFFFFF' ]
  };
}

describe('productAppendRefreshTargetCount', () => {
  it('returns room left when appending under max valid', () => {
    assert.equal(productAppendRefreshTargetCount(4, 5, 5), 1);
    assert.equal(productAppendRefreshTargetCount(0, 5, 5), 5);
    assert.equal(productAppendRefreshTargetCount(5, 5, 5), 0);
    assert.equal(productAppendRefreshTargetCount(6, 5, 5), 0);
  });

  it('never exceeds productMax', () => {
    assert.equal(productAppendRefreshTargetCount(0, 3, 5), 3);
  });
});

describe('isExcessProductCountOnlyBlocker', () => {
  it('detects sole excess-count blocker', () => {
    const findings = [
      {
        asset_id: 'products',
        severity: 'blocker',
        issue: 'Too many product files in products/ (maximum 5); found 6.'
      }
    ];
    assert.equal(isExcessProductCountOnlyBlocker(findings), true);
  });

  it('rejects mixed blockers', () => {
    assert.equal(
      isExcessProductCountOnlyBlocker([
        {
          asset_id: 'products',
          severity: 'blocker',
          issue: 'Too many product files in products/ (maximum 5); found 6.'
        },
        {
          asset_id: 'products/bad.jpg',
          severity: 'blocker',
          issue: 'Off-topic product image.'
        }
      ]),
      false
    );
  });
});

describe('canReconcileAfterExcessProductPrune', () => {
  it('approves when deterministic ok and count in range after prune', () => {
    assert.equal(
      canReconcileAfterExcessProductPrune({
        finalDeterministicOk: true,
        productFileCount: 5,
        lastAuditFindings: [
          {
            asset_id: 'products',
            severity: 'blocker',
            issue: 'Too many product files in products/ (maximum 5); found 6.'
          }
        ]
      }),
      true
    );
  });

  it('rejects when count still above max', () => {
    assert.equal(
      canReconcileAfterExcessProductPrune({
        finalDeterministicOk: true,
        productFileCount: 6,
        lastAuditFindings: [
          {
            asset_id: 'products',
            severity: 'blocker',
            issue: 'Too many product files in products/ (maximum 5); found 6.'
          }
        ]
      }),
      false
    );
  });
});

describe('pruneExcessProductAssets', () => {
  it('removes lowest-priority files when over max valid', () => {
    const directoryPath = makeTempCampaignDir();
    const max = maxValidProductAssets();
    const files = [
      'kusmi-packshot.png',
      'kusmi-lifestyle.jpg',
      'kusmi-nav.jpg',
      'kusmi-multi.jpg',
      'kusmi-detail.jpg',
      'offtopic-aromandise.webp'
    ];
    for (const fileName of files) {
      const sourceUrl =
        fileName === 'offtopic-aromandise.webp'
          ? 'https://www.aromandise.com/1536-large_default/unrelated.jpg'
          : `https://www.kusmitea.com/cdn/shop/files/${fileName}`;
      touchProduct(directoryPath, fileName, sourceUrl);
    }

    const descriptions: AssetDescriptionsFile = {
      generated_at: '2026-01-01T00:00:00.000Z',
      model: 'test',
      assets: files.map((fileName) =>
        fileName === 'offtopic-aromandise.webp'
          ? {
              ...productEntry(fileName, 'Other Brand Tea'),
              description: 'Unrelated retailer product photo'
            }
          : productEntry(fileName, 'Matcha Premium')
      )
    };

    const { removed } = pruneExcessProductAssets(directoryPath, {
      campaignTerms: [ 'matcha premium', 'kusmi tea' ],
      descriptions
    });

    assert.equal(listAssetImageFiles(directoryPath, 'products').length, max);
    assert.equal(removed.length, files.length - max);
    assert.ok(removed.some((id) => id === 'products/offtopic-aromandise.webp'));
    assert.ok(!listAssetImageFiles(directoryPath, 'products').includes('offtopic-aromandise.webp'));
  });
});
