#!/usr/bin/env node
// Regenerates the favicon / PWA icon set from the master Mi Casa brand mark
// (public/assets/brand/mi-casa-icon-white.png — the "mc" mountain/stethoscope
// mark from the official brand cheat sheet). Re-run this after replacing the
// master asset; it overwrites every generated file listed below.
//
// Usage: node scripts/generate-brand-icons.mjs

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const brandDir = path.join(root, 'public/assets/brand');
const publicDir = path.join(root, 'public');
const iconsDir = path.join(publicDir, 'icons');

const BRAND_BROWN_DARK = '#5D440B';
const ICON_SRC = path.join(brandDir, 'mi-casa-icon-white.png');

async function squareIcon({ size, paddingRatio, background }) {
  const inner = Math.round(size * (1 - paddingRatio * 2));
  const mark = await sharp(ICON_SRC)
    .resize({ width: inner, height: inner, fit: 'inside' })
    .toBuffer();
  const markMeta = await sharp(mark).metadata();

  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background
    }
  })
    .composite([
      {
        input: mark,
        left: Math.round((size - markMeta.width) / 2),
        top: Math.round((size - markMeta.height) / 2)
      }
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// Simple ICO container embedding PNG frames directly (supported by every
// browser/OS since Windows Vista) — avoids adding an ico-encoding dependency.
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + dirEntrySize * count;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  for (const png of pngBuffers) {
    const entry = Buffer.alloc(dirEntrySize);
    // width/height 0 means 256px; our sizes are always < 256 here.
    entry.writeUInt8(0, 0); // width placeholder, set below
    entry.writeUInt8(0, 1); // height placeholder, set below
    entry.writeUInt8(0, 2); // color palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += png.length;
  }

  return { header, dirEntries };
}

async function writeIco(sizePaddings, outPath) {
  const pngs = [];
  const dims = [];
  for (const { size, paddingRatio } of sizePaddings) {
    const buf = await squareIcon({ size, paddingRatio, background: BRAND_BROWN_DARK });
    pngs.push(buf);
    dims.push(size);
  }
  const { header, dirEntries } = buildIco(pngs);
  dims.forEach((size, i) => {
    dirEntries[i].writeUInt8(size >= 256 ? 0 : size, 0);
    dirEntries[i].writeUInt8(size >= 256 ? 0 : size, 1);
  });
  const buffer = Buffer.concat([header, ...dirEntries, ...pngs]);
  await writeFile(outPath, buffer);
}

async function main() {
  await mkdir(iconsDir, { recursive: true });

  // Standard favicons — minimal padding so the fine linework in the mark
  // (mountain outline + stethoscope) reads as large as possible at tiny sizes.
  await writeFile(path.join(publicDir, 'favicon-16x16.png'), await squareIcon({ size: 16, paddingRatio: 0.06, background: BRAND_BROWN_DARK }));
  await writeFile(path.join(publicDir, 'favicon-32x32.png'), await squareIcon({ size: 32, paddingRatio: 0.08, background: BRAND_BROWN_DARK }));
  await writeIco([{ size: 16, paddingRatio: 0.06 }, { size: 32, paddingRatio: 0.08 }], path.join(publicDir, 'favicon.ico'));

  // Apple touch icon — iOS applies its own rounded-square mask, so keep
  // padding light and let the mark run close to the edge.
  await writeFile(path.join(publicDir, 'apple-touch-icon.png'), await squareIcon({ size: 180, paddingRatio: 0.12, background: BRAND_BROWN_DARK }));

  // Standard ("any") PWA icons.
  await writeFile(path.join(iconsDir, 'icon-192.png'), await squareIcon({ size: 192, paddingRatio: 0.16, background: BRAND_BROWN_DARK }));
  await writeFile(path.join(iconsDir, 'icon-512.png'), await squareIcon({ size: 512, paddingRatio: 0.16, background: BRAND_BROWN_DARK }));

  // Maskable PWA icons — generous padding so the mark stays inside the
  // ~80%-diameter safe zone once Android clips to its own shape.
  await writeFile(path.join(iconsDir, 'icon-maskable-192.png'), await squareIcon({ size: 192, paddingRatio: 0.28, background: BRAND_BROWN_DARK }));
  await writeFile(path.join(iconsDir, 'icon-maskable-512.png'), await squareIcon({ size: 512, paddingRatio: 0.28, background: BRAND_BROWN_DARK }));

  console.log('Brand icons generated from', ICON_SRC);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
