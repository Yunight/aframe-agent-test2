import { readFileSync } from 'node:fs';
import type { Anthropic } from '@anthropic-ai/sdk';

export type AnthropicImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export function isSvgAssetFile (fileName: string, buf?: Buffer): boolean {
  if (fileName.toLowerCase().endsWith('.svg')) {
    return true;
  }
  if (buf !== undefined && buf.length > 0) {
    const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).trim();
    return head.includes('<svg');
  }
  return false;
}

/** Detect raster MIME from magic bytes (not file extension). */
export function sniffImageMimeFromBuffer (buf: Buffer): AnthropicImageMediaType | null {
  if (buf.length < 3) {
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function readFileAsAnthropicImageBlock (absolutePath: string): Anthropic.ImageBlockParam | null {
  const buf = readFileSync(absolutePath);
  const mediaType = sniffImageMimeFromBuffer(buf);
  if (mediaType === null) {
    return null;
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: buf.toString('base64')
    }
  };
}
