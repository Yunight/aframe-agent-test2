import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import {
  allowsTierBOpaque,
  logoRequireTransparency,
  validateLogoAssetBuffer
} from './logo-transparency-check.mts';

/** Minimal 1×1 opaque RGB PNG (IHDR color type 2, no alpha). */
function minimalOpaqueRgbPng (): Buffer {
  const signature = Buffer.from([ 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a ]);
  const ihdrData = Buffer.from([ 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0 ]);
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR');
  const ihdrCrc = Buffer.alloc(4);
  ihdrCrc.writeUInt32BE(crc32(Buffer.concat([ ihdrType, ihdrData ])), 0);

  const raw = Buffer.from([ 0, 255, 0, 0 ]);
  const idatPayload = deflateSync(raw);
  const idatLen = Buffer.alloc(4);
  idatLen.writeUInt32BE(idatPayload.length, 0);
  const idatType = Buffer.from('IDAT');
  const idatCrc = Buffer.alloc(4);
  idatCrc.writeUInt32BE(crc32(Buffer.concat([ idatType, idatPayload ])), 0);

  const iendLen = Buffer.alloc(4);
  const iendType = Buffer.from('IEND');
  const iendCrc = Buffer.alloc(4);
  iendCrc.writeUInt32BE(crc32(iendType), 0);

  return Buffer.concat([
    signature,
    ihdrLen,
    ihdrType,
    ihdrData,
    ihdrCrc,
    idatLen,
    idatType,
    idatPayload,
    idatCrc,
    iendLen,
    iendType,
    iendCrc
  ]);
}

function crc32 (buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i] ?? 0;
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('logoRequireTransparency is strict by default', () => {
  const prev = process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'];
  delete process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'];
  assert.equal(logoRequireTransparency(), true);
  process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'] = '1';
  assert.equal(logoRequireTransparency(), false);
  if (prev === undefined) {
    delete process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'];
  } else {
    process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'] = prev;
  }
});

test('validateLogoAssetBuffer accepts minimal SVG', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>', 'utf8');
  const result = validateLogoAssetBuffer(svg);
  assert.equal(result.ok, true);
});

test('validateLogoAssetBuffer rejects JPEG by default', () => {
  const jpeg = Buffer.from([ 0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10 ]);
  const result = validateLogoAssetBuffer(jpeg);
  assert.equal(result.ok, false);
  assert.match(result.issue, /JPEG/iu);
});

test('validateLogoAssetBuffer accepts Tier B opaque PNG from official logo path', () => {
  const prev = process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'];
  delete process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'];
  assert.equal(logoRequireTransparency(), true);

  const opaquePng = minimalOpaqueRgbPng();
  const withoutContext = validateLogoAssetBuffer(opaquePng);
  assert.equal(withoutContext.ok, false);

  const officialContext = {
    sourceUrl: 'https://media.materiel.net/logos/logo-site-matnet-homepage.png',
    officialHosts: [ 'materiel.net', 'media.materiel.net' ],
    sourcePhase: 'official' as const
  };
  assert.equal(allowsTierBOpaque(officialContext), true);

  const tierB = validateLogoAssetBuffer(opaquePng, officialContext);
  assert.equal(tierB.ok, true);
  assert.equal(tierB.tier, 'B');
  assert.ok(tierB.warn);

  const wikipediaContext = {
    sourceUrl: 'https://upload.wikimedia.org/wikipedia/commons/NET_Logo_1970.svg',
    officialHosts: [ 'materiel.net' ],
    sourcePhase: 'wikipedia' as const
  };
  assert.equal(allowsTierBOpaque(wikipediaContext), false);
  const wikiResult = validateLogoAssetBuffer(opaquePng, wikipediaContext);
  assert.equal(wikiResult.ok, false);

  if (prev === undefined) {
    delete process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'];
  } else {
    process.env['CREATIVE_ASSETS_LOGO_ALLOW_OPAQUE'] = prev;
  }
});
