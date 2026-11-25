// Generates crisp 16x16, 48x48, and 128x128 PNG icons for Favorsite
// from .design/references/logo.png (auto-cropping outer white/transparent margins
// to a square with subtle rounded corners). Zero external dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(filePath) {
  const buf = fs.readFileSync(filePath);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType})`);
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const inflated = zlib.inflateSync(Buffer.concat(idatParts));
  const raw = Buffer.alloc(width * height * bpp);

  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const val = inflated[rowStart + x];
      const a = x >= bpp ? raw[outStart + x - bpp] : 0;
      const b = y > 0 ? raw[outStart - stride + x] : 0;
      const c = x >= bpp && y > 0 ? raw[outStart - stride + x - bpp] : 0;
      let recon = val;
      if (filter === 1) recon = (val + a) & 0xff;
      else if (filter === 2) recon = (val + b) & 0xff;
      else if (filter === 3) recon = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) recon = (val + paethPredictor(a, b, c)) & 0xff;
      raw[outStart + x] = recon;
    }
  }

  // Normalize to RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = raw[i * bpp];
    rgba[i * 4 + 1] = raw[i * bpp + 1];
    rgba[i * 4 + 2] = raw[i * bpp + 2];
    rgba[i * 4 + 3] = bpp === 4 ? raw[i * 4 + 3] : 255;
  }
  return { width, height, rgba };
}

function findTrimmedSquareBox({ width, height, rgba }) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      const a = rgba[idx + 3];
      const isTransparent = a < 20;
      const isPureWhiteBg = a > 200 && r > 245 && g > 245 && b > 245;
      if (!isTransparent && !isPureWhiteBg) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    const s = Math.min(width, height);
    return {
      x: Math.floor((width - s) / 2),
      y: Math.floor((height - s) / 2),
      size: s,
    };
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const side = Math.min(bw, bh);
  // Inset by 1px to avoid any light anti-aliased fringe around the cropped square
  const inset = side > 24 ? 1 : 0;
  return {
    x: minX + Math.floor((bw - side) / 2) + inset,
    y: minY + Math.floor((bh - side) / 2) + inset,
    size: side - inset * 2,
  };
}

function areaDownsampleSquare(src, box, targetSize) {
  const out = Buffer.alloc(targetSize * targetSize * 4);
  const scale = box.size / targetSize;
  const radius = targetSize * 0.2;

  for (let ty = 0; ty < targetSize; ty++) {
    const sy0 = box.y + ty * scale;
    const sy1 = box.y + (ty + 1) * scale;
    for (let tx = 0; tx < targetSize; tx++) {
      const sx0 = box.x + tx * scale;
      const sx1 = box.x + (tx + 1) * scale;

      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;
      let wSum = 0;

      const yStart = Math.max(0, Math.floor(sy0));
      const yEnd = Math.min(src.height - 1, Math.floor(sy1));
      const xStart = Math.max(0, Math.floor(sx0));
      const xEnd = Math.min(src.width - 1, Math.floor(sx1));

      for (let sy = yStart; sy <= yEnd; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = xStart; sx <= xEnd; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const idx = (sy * src.width + sx) * 4;
          rSum += src.rgba[idx] * w;
          gSum += src.rgba[idx + 1] * w;
          bSum += src.rgba[idx + 2] * w;
          aSum += src.rgba[idx + 3] * w;
          wSum += w;
        }
      }

      // Compute smooth anti-aliased rounded square alpha mask
      const px = tx + 0.5;
      const py = ty + 0.5;
      const cx =
        px < radius ? radius : px > targetSize - radius ? targetSize - radius : px;
      const cy =
        py < radius ? radius : py > targetSize - radius ? targetSize - radius : py;
      const dist = Math.hypot(px - cx, py - cy);
      const maskAlpha =
        dist <= radius - 0.5
          ? 1
          : dist >= radius + 0.5
            ? 0
            : radius + 0.5 - dist;

      const outIdx = (ty * targetSize + tx) * 4;
      if (wSum > 0 && maskAlpha > 0) {
        out[outIdx] = Math.round(rSum / wSum);
        out[outIdx + 1] = Math.round(gSum / wSum);
        out[outIdx + 2] = Math.round(bSum / wSum);
        out[outIdx + 3] = Math.round((aSum / wSum) * maskAlpha);
      } else {
        out[outIdx] = 0;
        out[outIdx + 1] = 0;
        out[outIdx + 2] = 0;
        out[outIdx + 3] = 0;
      }
    }
  }
  return out;
}

const logoPath = path.resolve(process.cwd(), '.design/references/logo.png');
const outDir = path.resolve(process.cwd(), 'public/icons');
fs.mkdirSync(outDir, { recursive: true });

if (!fs.existsSync(logoPath)) {
  throw new Error(`Missing source logo at ${logoPath}`);
}

const src = decodePng(logoPath);
const box = findTrimmedSquareBox(src);
console.log(
  `Source logo ${src.width}x${src.height} -> cropped square (${box.x}, ${box.y}, ${box.size}x${box.size})`,
);

for (const size of [16, 48, 128]) {
  const rgba = areaDownsampleSquare(src, box, size);
  const png = encodePng(size, size, rgba);
  const filePath = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Generated ${filePath} (${size}x${size}, ${png.length} bytes)`);
}
