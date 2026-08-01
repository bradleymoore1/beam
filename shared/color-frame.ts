import QRCode from "qrcode";
import { fnv1a } from "./protocol";

// A color burst keeps the QR finder/timing/alignment patterns and the
// luminance bitstream of a real QR symbol intact, so ZXing can still locate
// it. Each payload module has one of eight colors inside its light/dark
// class, carrying three extra bits. The carrier's luminance bit is reserved
// for QR detection, so this deliberately uses 16 physical colors (8 light
// and 8 dark) rather than pretending the carrier bit is free payload.

export const COLOR_CARRIER_TEXT = "BEAM-COLOR-CARRIER-2";
export const COLOR_VERSION = 40;
export const COLOR_PALETTE_BITS = 3;
export const COLOR_SYMBOL_COUNT = 1 << COLOR_PALETTE_BITS;
export const COLOR_HEADER_LEN = 10;
export const COLOR_CALIBRATION_COPIES = 2;
export const COLOR_CALIBRATION_COUNT = COLOR_SYMBOL_COUNT * 2 * COLOR_CALIBRATION_COPIES;

const MAGIC0 = 0xc7;
const MAGIC1 = 0x52;
const PROTOCOL_VERSION = 1;

export interface ColorMatrix {
  size: number;
  data: Uint8Array;
  reserved: Uint8Array;
  dataPositions: Uint32Array;
  dataRows: Uint16Array;
  dataColumns: Uint16Array;
  positionIndex: Uint32Array;
  calibrationPositions: Uint32Array;
  calibrationRows: Uint16Array;
  calibrationColumns: Uint16Array;
  calibrationIndex: Uint8Array;
  calibrationSymbols: Uint8Array;
}

export interface ColorHeader {
  rawLen: number;
  rawFnv: number;
}

export interface ColorPoint {
  x: number;
  y: number;
}

export interface ColorPosition {
  topLeft: ColorPoint;
  topRight: ColorPoint;
  bottomLeft: ColorPoint;
  bottomRight: ColorPoint;
}

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const matrixCache = new Map<number, ColorMatrix>();

// The first index is the QR carrier's base module (0 = light, 1 = dark),
// the second is the three-bit color symbol. All dark colors stay well below
// the grayscale threshold and all light colors stay well above it.
const PALETTE: readonly (readonly (readonly [number, number, number])[])[] = [
  [
    [246, 246, 240],
    [255, 160, 160],
    [255, 230, 128],
    [175, 245, 175],
    [145, 230, 235],
    [160, 190, 255],
    [210, 160, 245],
    [245, 155, 220],
  ],
  [
    [18, 20, 25],
    [130, 35, 50],
    [130, 85, 25],
    [25, 115, 65],
    [20, 105, 110],
    [35, 55, 145],
    [85, 35, 120],
    [130, 35, 100],
  ],
];

export function createColorMatrix(version = COLOR_VERSION): ColorMatrix {
  const qr = QRCode.create(
    [{ data: new TextEncoder().encode(COLOR_CARRIER_TEXT), mode: "byte" }],
    // The carrier still occupies the same V40 footprint at every ECC level,
    // but H gives ZXing more tolerance while the RGB symbols carry the real
    // payload independently of the carrier's data bits.
    { version, errorCorrectionLevel: "H", maskPattern: 4 },
  );
  const allPositions: number[] = [];
  for (let row = 0; row < qr.modules.size; row++) {
    for (let column = 0; column < qr.modules.size; column++) {
      const index = row * qr.modules.size + column;
      if (!qr.modules.reservedBit[index]) allPositions.push(index);
    }
  }

  // Put two copies of every color symbol in each luminance class at
  // deterministic, well-spread data-module positions. The receiver samples
  // these cells first and uses their camera-observed RGB values as the
  // palette for the rest of the frame. This absorbs white-balance and
  // exposure shifts without changing the QR carrier's black/white pattern.
  const calibrationPositions: number[] = [];
  const calibrationSymbols: number[] = [];
  const used = new Set<number>();
  for (const base of [0, 1]) {
    for (let symbol = 0; symbol < COLOR_SYMBOL_COUNT; symbol++) {
      for (let copy = 0; copy < COLOR_CALIBRATION_COPIES; copy++) {
        const slot = (base * COLOR_SYMBOL_COUNT * COLOR_CALIBRATION_COPIES) +
          (symbol * COLOR_CALIBRATION_COPIES) + copy;
        const target = Math.floor(((slot + 0.5) * allPositions.length) / COLOR_CALIBRATION_COUNT);
        let found = -1;
        for (let delta = 0; delta < allPositions.length; delta++) {
          const candidates = [target + delta, target - delta];
          for (const candidate of candidates) {
            const position = allPositions[candidate];
            if (
              position !== undefined &&
              !used.has(position) &&
              Number(qr.modules.data[position]) === base
            ) {
              found = position;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Error("unable to place color calibration cells");
        used.add(found);
        calibrationPositions.push(found);
        calibrationSymbols.push(symbol);
      }
    }
  }

  const positions = allPositions.filter((position) => !used.has(position));
  const dataRows = positions.map((position) => Math.floor(position / qr.modules.size));
  const dataColumns = positions.map((position) => position % qr.modules.size);
  const positionIndex = new Uint32Array(qr.modules.size * qr.modules.size);
  positionIndex.fill(0xffffffff);
  for (let index = 0; index < positions.length; index++) {
    positionIndex[positions[index]!] = index;
  }
  const calibrationIndex = new Uint8Array(qr.modules.size * qr.modules.size);
  calibrationIndex.fill(0xff);
  for (let index = 0; index < calibrationPositions.length; index++) {
    calibrationIndex[calibrationPositions[index]!] = index;
  }
  const calibrationRows = calibrationPositions.map((position) =>
    Math.floor(position / qr.modules.size));
  const calibrationColumns = calibrationPositions.map((position) =>
    position % qr.modules.size);
  return {
    size: qr.modules.size,
    data: qr.modules.data,
    reserved: qr.modules.reservedBit,
    dataPositions: Uint32Array.from(positions),
    dataRows: Uint16Array.from(dataRows),
    dataColumns: Uint16Array.from(dataColumns),
    positionIndex,
    calibrationPositions: Uint32Array.from(calibrationPositions),
    calibrationRows: Uint16Array.from(calibrationRows),
    calibrationColumns: Uint16Array.from(calibrationColumns),
    calibrationIndex,
    calibrationSymbols: Uint8Array.from(calibrationSymbols),
  };
}

export function colorCapacity(matrix: ColorMatrix): number {
  return Math.floor((matrix.dataPositions.length * COLOR_PALETTE_BITS) / 8);
}

export function createColorEnvelope(raw: Uint8Array): Uint8Array {
  if (raw.length > 0xffff) throw new Error("color frame is too large");
  const out = new Uint8Array(COLOR_HEADER_LEN + raw.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, MAGIC0);
  view.setUint8(1, MAGIC1);
  view.setUint8(2, PROTOCOL_VERSION);
  view.setUint8(3, COLOR_PALETTE_BITS);
  view.setUint16(4, raw.length, true);
  view.setUint32(6, fnv1a(raw), true);
  out.set(raw, COLOR_HEADER_LEN);
  return out;
}

export function parseColorHeader(bytes: Uint8Array): ColorHeader | null {
  if (bytes.length < COLOR_HEADER_LEN) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MAGIC0 || view.getUint8(1) !== MAGIC1) return null;
  if (view.getUint8(2) !== PROTOCOL_VERSION || view.getUint8(3) !== COLOR_PALETTE_BITS) return null;
  return { rawLen: view.getUint16(4, true), rawFnv: view.getUint32(6, true) };
}

export function isColorCarrier(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes) === COLOR_CARRIER_TEXT;
}

export function colorFor(base: number, symbol: number): readonly [number, number, number] {
  return PALETTE[base ? 1 : 0]![symbol & (COLOR_SYMBOL_COUNT - 1)]!;
}

export function rgba32(red: number, green: number, blue: number): number {
  // ImageData is little-endian in the browser: this becomes [R,G,B,A].
  return (0xff000000 | (blue << 16) | (green << 8) | red) >>> 0;
}

function fillerSymbol(symbolIndex: number, seed: number): number {
  let value = (Math.imul(symbolIndex + 1, 0x9e3779b1) ^ seed) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value & (COLOR_SYMBOL_COUNT - 1);
}

export function symbolAt(bytes: Uint8Array, symbolIndex: number, padSeed = 0): number {
  const bitOffset = symbolIndex * COLOR_PALETTE_BITS;
  if (bitOffset >= bytes.length * 8) return fillerSymbol(symbolIndex, padSeed);
  let symbol = 0;
  for (let bit = 0; bit < COLOR_PALETTE_BITS; bit++) {
    const offset = bitOffset + bit;
    const source = bytes[offset >> 3];
    const value = source === undefined
      ? ((fillerSymbol(symbolIndex, padSeed) >> (COLOR_PALETTE_BITS - 1 - bit)) & 1)
      : ((source >> (7 - (offset & 7))) & 1);
    symbol = (symbol << 1) | value;
  }
  return symbol;
}

export function decodeColorEnvelope(symbols: Uint8Array): Uint8Array | null {
  const bytes = new Uint8Array(Math.floor((symbols.length * COLOR_PALETTE_BITS) / 8));
  for (let index = 0; index < bytes.length; index++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) {
      const offset = index * 8 + bit;
      const symbol = symbols[Math.floor(offset / COLOR_PALETTE_BITS)] ?? 0;
      value = (value << 1) | ((symbol >> (COLOR_PALETTE_BITS - 1 - (offset % COLOR_PALETTE_BITS))) & 1);
    }
    bytes[index] = value;
  }
  const header = parseColorHeader(bytes);
  if (!header || header.rawLen > bytes.length - COLOR_HEADER_LEN) return null;
  const raw = bytes.slice(COLOR_HEADER_LEN, COLOR_HEADER_LEN + header.rawLen);
  return fnv1a(raw) === header.rawFnv ? raw : null;
}

function lerp(a: ColorPoint, b: ColorPoint, amount: number): ColorPoint {
  return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount };
}

function sampleRgb(
  image: RgbaImage,
  position: ColorPosition,
  size: number,
  row: number,
  column: number,
  radius: number,
): readonly [number, number, number] {
  const u = (column + 0.5) / size;
  const v = (row + 0.5) / size;
  const top = lerp(position.topLeft, position.topRight, u);
  const bottom = lerp(position.bottomLeft, position.bottomRight, u);
  const center = lerp(top, bottom, v);
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      // ZXing reports the QR bounds on pixel edges. Convert the sampled
      // coordinate back to an ImageData pixel index without rounding into
      // the next module (especially visible on 1px/module test frames).
      const x = Math.max(0, Math.min(image.width - 1, Math.floor(center.x + dx)));
      const y = Math.max(0, Math.min(image.height - 1, Math.floor(center.y + dy)));
      const offset = (y * image.width + x) * 4;
      red += image.data[offset] ?? 0;
      green += image.data[offset + 1] ?? 0;
      blue += image.data[offset + 2] ?? 0;
      count++;
    }
  }
  return [red / count, green / count, blue / count];
}

function colorDistance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const red = a[0] - b[0];
  const green = a[1] - b[1];
  const blue = a[2] - b[2];
  return red * red + green * green + blue * blue;
}

export function classifyRgb(red: number, green: number, blue: number): { base: number; symbol: number } {
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const base = luminance < 132 ? 1 : 0;
  const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
  if (spread < (base ? 28 : 22)) return { base, symbol: 0 };
  if (red >= green && red >= blue) return { base, symbol: 1 };
  if (green >= red && green >= blue) return { base, symbol: 2 };
  return { base, symbol: 3 };
}

export function decodeColorImage(
  image: RgbaImage,
  position: ColorPosition,
  version: number,
): Uint8Array | null {
  if (version < 1 || version > 40) return null;
  let matrix = matrixCache.get(version);
  if (!matrix) {
    matrix = createColorMatrix(version);
    matrixCache.set(version, matrix);
  }
  const moduleWidth = Math.hypot(
    position.topRight.x - position.topLeft.x,
    position.topRight.y - position.topLeft.y,
  ) / matrix.size;
  const sampleRadius = Math.min(2, Math.floor(moduleWidth * 0.16));
  const palette: [number, number, number][] = Array.from(
    { length: COLOR_SYMBOL_COUNT * 2 },
    () => [0, 0, 0] as [number, number, number],
  );
  const paletteCounts = new Uint8Array(palette.length);
  matrix.calibrationPositions.forEach((moduleIndex, calibrationIndex) => {
    const row = matrix.calibrationRows[calibrationIndex]!;
    const column = matrix.calibrationColumns[calibrationIndex]!;
    const base = calibrationIndex < COLOR_SYMBOL_COUNT * COLOR_CALIBRATION_COPIES ? 0 : 1;
    const symbol = matrix.calibrationSymbols[calibrationIndex]!;
    const paletteIndex = base * COLOR_SYMBOL_COUNT + symbol;
    const sample = sampleRgb(image, position, matrix.size, row, column, sampleRadius);
    palette[paletteIndex]![0] += sample[0];
    palette[paletteIndex]![1] += sample[1];
    palette[paletteIndex]![2] += sample[2];
    paletteCounts[paletteIndex] = (paletteCounts[paletteIndex] ?? 0) + 1;
  });
  for (let index = 0; index < palette.length; index++) {
    const count = paletteCounts[index] || 1;
    palette[index]![0] /= count;
    palette[index]![1] /= count;
    palette[index]![2] /= count;
  }
  let lightLuminance = 0;
  let darkLuminance = 0;
  for (let symbol = 0; symbol < COLOR_SYMBOL_COUNT; symbol++) {
    lightLuminance += 0.2126 * palette[symbol]![0] +
      0.7152 * palette[symbol]![1] + 0.0722 * palette[symbol]![2];
    darkLuminance += 0.2126 * palette[COLOR_SYMBOL_COUNT + symbol]![0] +
      0.7152 * palette[COLOR_SYMBOL_COUNT + symbol]![1] +
      0.0722 * palette[COLOR_SYMBOL_COUNT + symbol]![2];
  }
  const luminanceThreshold = (lightLuminance + darkLuminance) / (COLOR_SYMBOL_COUNT * 2);
  const symbols = new Uint8Array(matrix.dataPositions.length);
  for (let index = 0; index < matrix.dataPositions.length; index++) {
    const observed = sampleRgb(
      image,
      position,
      matrix.size,
      matrix.dataRows[index]!,
      matrix.dataColumns[index]!,
      sampleRadius,
    );
    const luminance = 0.2126 * observed[0] + 0.7152 * observed[1] + 0.0722 * observed[2];
    const base = luminance < luminanceThreshold ? 1 : 0;
    const paletteStart = base * COLOR_SYMBOL_COUNT;
    let closest = paletteStart;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let symbol = 0; symbol < COLOR_SYMBOL_COUNT; symbol++) {
      const paletteIndex = paletteStart + symbol;
      const distance = colorDistance(observed, palette[paletteIndex]!);
      if (distance < closestDistance) {
        closest = paletteIndex;
        closestDistance = distance;
      }
    }
    symbols[index] = closest - paletteStart;
  }
  return decodeColorEnvelope(symbols);
}
