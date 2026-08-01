import QRCode from "qrcode";
import { fnv1a } from "./protocol";

// The tile mode is deliberately not a QR code. Four tiny standard QR symbols
// are locators only; the rest is a raw black/white field. Binary survives
// camera demosaicing, white balance, compression, and imperfect focus much
// better than the retired RGB carrier while reclaiming QR's format overhead.
// Tricolor is a separate, calibrated red/green/black experiment. It uses a
// real ternary code rather than pretending three states are two binary bits.
export const CUSTOM_GRID_SIZES = [176, 256, 352, 512] as const;
export type CustomGridSize = (typeof CUSTOM_GRID_SIZES)[number];
export const CUSTOM_DEFAULT_GRID_SIZE: CustomGridSize = 176;
export const CUSTOM_OUTER_MARGIN = 4;
export const CUSTOM_BINARY_SYMBOL_BITS = 1;
export const CUSTOM_BINARY_SYMBOL_COUNT = 2;
export const CUSTOM_TRICOLOR_SYMBOL_COUNT = 3;
export const CUSTOM_HEADER_LEN = 10;
export const CUSTOM_LOCATOR_VERSION = 1;
export const CUSTOM_LOCATOR_SIZE = 21;
export const CUSTOM_LOCATOR_QUIET = 4;
export const CUSTOM_LOCATOR_TOTAL = CUSTOM_LOCATOR_SIZE + CUSTOM_LOCATOR_QUIET * 2;
export const CUSTOM_LOCATOR_INSET = 6;
export const CUSTOM_CALIBRATION_COPIES = 4;

const MAGIC0 = 0xb3;
const MAGIC1 = 0x54;
const PROTOCOL_VERSION = 2;
const BORDER_CELLS = 2;

export type CustomPoint = { x: number; y: number };
export type CustomMode = "binary" | "tricolor";

export type CustomPosition = {
  topLeft: CustomPoint;
  topRight: CustomPoint;
  bottomLeft: CustomPoint;
  bottomRight: CustomPoint;
};

export type RgbaImage = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

export type CustomLayout = {
  mode: CustomMode;
  symbolCount: number;
  size: number;
  dataPositions: Uint32Array;
  dataRows: Uint16Array;
  dataColumns: Uint16Array;
  positionIndex: Uint32Array;
  reserved: Uint8Array;
  locatorCellIndex: Int32Array;
  locatorData: Uint8Array;
  locators: readonly CustomLocator[];
  calibrationPositions: Uint32Array;
  calibrationRows: Uint16Array;
  calibrationColumns: Uint16Array;
  calibrationIndex: Uint8Array;
  calibrationSymbols: Uint8Array;
};

export type CustomLocator = {
  x: number;
  y: number;
  codeX: number;
  codeY: number;
  centerX: number;
  centerY: number;
};

const cachedLayouts = new Map<string, CustomLayout>();

function locatorText(size: number, mode: CustomMode): string {
  return `${mode === "tricolor" ? "T" : "H"}${size}`;
}

function setReserved(layout: Uint8Array, size: number, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  layout[y * size + x] = 1;
}

export function createCustomLayout(
  size: number = CUSTOM_DEFAULT_GRID_SIZE,
  mode: CustomMode = "binary",
): CustomLayout {
  if (!(CUSTOM_GRID_SIZES as readonly number[]).includes(size)) {
    throw new Error(`unsupported binary grid ${size}`);
  }
  const cacheKey = `${mode}:${size}`;
  const cached = cachedLayouts.get(cacheKey);
  if (cached) return cached;

  const locator = QRCode.create(
    [{ data: new TextEncoder().encode(locatorText(size, mode)), mode: "byte" }],
    { version: CUSTOM_LOCATOR_VERSION, errorCorrectionLevel: "H", maskPattern: 4 },
  );
  const reserved = new Uint8Array(size * size);
  const locatorCellIndex = new Int32Array(size * size);
  locatorCellIndex.fill(-1);

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (
        row < BORDER_CELLS ||
        column < BORDER_CELLS ||
        row >= size - BORDER_CELLS ||
        column >= size - BORDER_CELLS
      ) {
        setReserved(reserved, size, column, row);
      }
    }
  }

  const locatorOrigins = [
    { x: CUSTOM_LOCATOR_INSET, y: CUSTOM_LOCATOR_INSET },
    {
      x: size - CUSTOM_LOCATOR_INSET - CUSTOM_LOCATOR_TOTAL,
      y: CUSTOM_LOCATOR_INSET,
    },
    {
      x: CUSTOM_LOCATOR_INSET,
      y: size - CUSTOM_LOCATOR_INSET - CUSTOM_LOCATOR_TOTAL,
    },
    {
      x: size - CUSTOM_LOCATOR_INSET - CUSTOM_LOCATOR_TOTAL,
      y: size - CUSTOM_LOCATOR_INSET - CUSTOM_LOCATOR_TOTAL,
    },
  ];
  const locators = locatorOrigins.map(({ x, y }) => ({
    x,
    y,
    codeX: x + CUSTOM_LOCATOR_QUIET,
    codeY: y + CUSTOM_LOCATOR_QUIET,
    centerX: x + CUSTOM_LOCATOR_QUIET + CUSTOM_LOCATOR_SIZE / 2,
    centerY: y + CUSTOM_LOCATOR_QUIET + CUSTOM_LOCATOR_SIZE / 2,
  }));
  for (const locator of locators) {
    for (let row = 0; row < CUSTOM_LOCATOR_TOTAL; row++) {
      for (let column = 0; column < CUSTOM_LOCATOR_TOTAL; column++) {
        const x = locator.x + column;
        const y = locator.y + row;
        setReserved(reserved, size, x, y);
        const qrColumn = column - CUSTOM_LOCATOR_QUIET;
        const qrRow = row - CUSTOM_LOCATOR_QUIET;
        if (
          qrColumn >= 0 &&
          qrColumn < CUSTOM_LOCATOR_SIZE &&
          qrRow >= 0 &&
          qrRow < CUSTOM_LOCATOR_SIZE
        ) {
          locatorCellIndex[y * size + x] = qrRow * CUSTOM_LOCATOR_SIZE + qrColumn;
        }
      }
    }
  }

  const calibrationPositions: number[] = [];
  const calibrationSymbols: number[] = [];
  const calibrationIndex = new Uint8Array(size * size);
  calibrationIndex.fill(0xff);
  const symbolCount = mode === "tricolor"
    ? CUSTOM_TRICOLOR_SYMBOL_COUNT
    : CUSTOM_BINARY_SYMBOL_COUNT;
  const calibrationX = Math.floor(size / 2) - Math.floor(symbolCount / 2);
  const calibrationY = Math.floor(size / 2);
  for (let copy = 0; copy < CUSTOM_CALIBRATION_COPIES; copy++) {
    for (let symbol = 0; symbol < symbolCount; symbol++) {
      const x = calibrationX + symbol;
      const y = calibrationY + copy;
      const position = y * size + x;
      setReserved(reserved, size, x, y);
      calibrationIndex[position] = calibrationPositions.length;
      calibrationPositions.push(position);
      calibrationSymbols.push(symbol);
    }
  }

  const dataPositions: number[] = [];
  const dataRows: number[] = [];
  const dataColumns: number[] = [];
  const positionIndex = new Uint32Array(size * size);
  positionIndex.fill(0xffffffff);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const position = row * size + column;
      if (reserved[position]) continue;
      positionIndex[position] = dataPositions.length;
      dataPositions.push(position);
      dataRows.push(row);
      dataColumns.push(column);
    }
  }

  const layout: CustomLayout = {
    mode,
    symbolCount,
    size,
    dataPositions: Uint32Array.from(dataPositions),
    dataRows: Uint16Array.from(dataRows),
    dataColumns: Uint16Array.from(dataColumns),
    positionIndex,
    reserved,
    locatorCellIndex,
    locatorData: Uint8Array.from(locator.modules.data),
    locators,
    calibrationPositions: Uint32Array.from(calibrationPositions),
    calibrationRows: Uint16Array.from(calibrationPositions, (position) =>
      Math.floor(position / size)),
    calibrationColumns: Uint16Array.from(calibrationPositions, (position) =>
      position % size),
    calibrationIndex,
    calibrationSymbols: Uint8Array.from(calibrationSymbols),
  };
  cachedLayouts.set(cacheKey, layout);
  return layout;
}

export function customCapacity(layout = createCustomLayout()): number {
  return customCapacityForBits(layout, CUSTOM_BINARY_SYMBOL_BITS);
}

export function customCapacityForBits(
  layout: CustomLayout = createCustomLayout(),
  symbolBits: number,
): number {
  if (symbolBits !== CUSTOM_BINARY_SYMBOL_BITS) throw new Error("unsupported custom symbol depth");
  // Extended Hamming(8,4) stores four protected payload bits in eight tiles.
  return Math.floor(layout.dataPositions.length / 16);
}

export function customCapacityForMode(layout: CustomLayout, mode: CustomMode): number {
  if (mode === "binary") return customCapacityForBits(layout, CUSTOM_BINARY_SYMBOL_BITS);
  const codewords = Math.floor(layout.dataPositions.length / 13);
  const fiveByteBlocks = Math.floor((codewords * 10) / 26);
  return fiveByteBlocks * 5;
}

function fillerSymbol(symbolIndex: number, seed: number, symbolBits: number): number {
  let value = (Math.imul(symbolIndex + 1, 0x9e3779b1) ^ seed) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value & ((1 << symbolBits) - 1);
}

export function customSymbolAt(
  bytes: Uint8Array,
  symbolIndex: number,
  symbolBits = CUSTOM_BINARY_SYMBOL_BITS,
  padSeed = 0,
): number {
  const bitOffset = symbolIndex * symbolBits;
  if (bitOffset >= bytes.length * 8) return fillerSymbol(symbolIndex, padSeed, symbolBits);
  let symbol = 0;
  for (let bit = 0; bit < symbolBits; bit++) {
    const offset = bitOffset + bit;
    const source = bytes[offset >> 3];
    const value = source === undefined
      ? ((fillerSymbol(symbolIndex, padSeed, symbolBits) >> (symbolBits - 1 - bit)) & 1)
      : ((source >> (7 - (offset & 7))) & 1);
    symbol = (symbol << 1) | value;
  }
  return symbol;
}

function fillerTrit(symbolIndex: number, seed: number): number {
  let value = (Math.imul(symbolIndex + 1, 0x9e3779b1) ^ seed) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return (value >>> 0) % 3;
}

export function tricolorSymbolAt(symbols: Uint8Array, symbolIndex: number, padSeed = 0): number {
  return symbols[symbolIndex] ?? fillerTrit(symbolIndex, padSeed);
}

export function createCustomEnvelope(
  raw: Uint8Array,
  decodedCapacity: number,
  symbolBits = CUSTOM_BINARY_SYMBOL_BITS,
): Uint8Array {
  if (symbolBits !== CUSTOM_BINARY_SYMBOL_BITS) throw new Error("unsupported custom symbol depth");
  if (raw.length > 0xffff) throw new Error("custom frame is too large");
  if (CUSTOM_HEADER_LEN + raw.length > decodedCapacity) throw new Error("custom frame exceeds carrier");
  const decoded = new Uint8Array(decodedCapacity);
  const padSeed = fnv1a(raw);
  for (let index = 0; index < decoded.length; index++) {
    decoded[index] = fillerSymbol(index, padSeed, 8);
  }
  const view = new DataView(decoded.buffer);
  view.setUint8(0, MAGIC0);
  view.setUint8(1, MAGIC1);
  view.setUint8(2, PROTOCOL_VERSION);
  view.setUint8(3, symbolBits);
  view.setUint16(4, raw.length, true);
  view.setUint32(6, fnv1a(raw), true);
  decoded.set(raw, CUSTOM_HEADER_LEN);

  // Interleave codeword bit planes across the whole field. A local blur then
  // flips at most one bit in many codewords instead of several bits in one,
  // which lets Hamming correct the burst rather than rejecting the frame.
  const codewordCount = decoded.length * 2;
  const encoded = new Uint8Array(decoded.length * 2);
  for (let codewordIndex = 0; codewordIndex < codewordCount; codewordIndex++) {
    const source = decoded[codewordIndex >> 1]!;
    const nibble = codewordIndex & 1 ? source & 0x0f : source >>> 4;
    const codeword = encodeHamming84(nibble);
    for (let plane = 0; plane < 8; plane++) {
      const outputBit = plane * codewordCount + codewordIndex;
      const bit = (codeword >> (7 - plane)) & 1;
      encoded[outputBit >> 3] |= bit << (7 - (outputBit & 7));
    }
  }
  return encoded;
}

const TERNARY_COLUMNS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [1, 0, 1], [1, 0, 2], [1, 1, 0], [1, 1, 1],
  [1, 1, 2], [1, 2, 0], [1, 2, 1], [1, 2, 2],
  [0, 1, 1], [0, 1, 2],
];

function encodeTernaryHamming(data: Uint8Array): Uint8Array {
  const codeword = new Uint8Array(13);
  codeword.set(data.subarray(0, 10), 3);
  for (let row = 0; row < 3; row++) {
    let sum = 0;
    for (let column = 3; column < 13; column++) {
      sum += TERNARY_COLUMNS[column]![row]! * codeword[column]!;
    }
    codeword[row] = (3 - (sum % 3)) % 3;
  }
  return codeword;
}

function decodeTernaryHamming(codeword: Uint8Array): Uint8Array | null {
  const syndrome = [0, 0, 0];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 13; column++) {
      syndrome[row] = (syndrome[row]! + TERNARY_COLUMNS[column]![row]! * codeword[column]!) % 3;
    }
  }
  if (syndrome[0] || syndrome[1] || syndrome[2]) {
    let corrected = false;
    for (let column = 0; column < 13 && !corrected; column++) {
      for (let error = 1; error <= 2; error++) {
        const basis = TERNARY_COLUMNS[column]!;
        if (
          syndrome[0] === (basis[0] * error) % 3 &&
          syndrome[1] === (basis[1] * error) % 3 &&
          syndrome[2] === (basis[2] * error) % 3
        ) {
          codeword[column] = (codeword[column]! + 3 - error) % 3;
          corrected = true;
          break;
        }
      }
    }
    if (!corrected) return null;
  }
  return codeword.slice(3);
}

function bytesToTrits(bytes: Uint8Array): Uint8Array {
  if (bytes.length % 5 !== 0) throw new Error("tricolor payload must use five-byte blocks");
  const trits = new Uint8Array((bytes.length / 5) * 26);
  for (let block = 0; block < bytes.length / 5; block++) {
    let value = 0n;
    for (let index = 0; index < 5; index++) {
      value = (value << 8n) | BigInt(bytes[block * 5 + index]!);
    }
    for (let digit = 25; digit >= 0; digit--) {
      trits[block * 26 + digit] = Number(value % 3n);
      value /= 3n;
    }
  }
  return trits;
}

function tritsToBytes(trits: Uint8Array): Uint8Array | null {
  if (trits.length % 26 !== 0) return null;
  const bytes = new Uint8Array((trits.length / 26) * 5);
  for (let block = 0; block < trits.length / 26; block++) {
    let value = 0n;
    for (let digit = 0; digit < 26; digit++) {
      value = value * 3n + BigInt(trits[block * 26 + digit]!);
    }
    if (value >= (1n << 40n)) return null;
    for (let index = 4; index >= 0; index--) {
      bytes[block * 5 + index] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return bytes;
}

export function createTricolorEnvelope(raw: Uint8Array, decodedCapacity: number): Uint8Array {
  if (raw.length > 0xffff) throw new Error("tricolor frame is too large");
  if (decodedCapacity % 5 !== 0) throw new Error("invalid tricolor carrier capacity");
  if (CUSTOM_HEADER_LEN + raw.length > decodedCapacity) throw new Error("tricolor frame exceeds carrier");
  const decoded = new Uint8Array(decodedCapacity);
  const padSeed = fnv1a(raw);
  for (let index = 0; index < decoded.length; index++) decoded[index] = fillerSymbol(index, padSeed, 8);
  const view = new DataView(decoded.buffer);
  view.setUint8(0, MAGIC0);
  view.setUint8(1, MAGIC1);
  view.setUint8(2, 3);
  view.setUint8(3, CUSTOM_TRICOLOR_SYMBOL_COUNT);
  view.setUint16(4, raw.length, true);
  view.setUint32(6, fnv1a(raw), true);
  decoded.set(raw, CUSTOM_HEADER_LEN);

  const dataTrits = bytesToTrits(decoded);
  const codewordCount = Math.ceil(dataTrits.length / 10);
  const encoded = new Uint8Array(codewordCount * 13);
  for (let codewordIndex = 0; codewordIndex < codewordCount; codewordIndex++) {
    const data = new Uint8Array(10);
    for (let index = 0; index < 10; index++) {
      data[index] = dataTrits[codewordIndex * 10 + index] ?? fillerTrit(codewordIndex * 10 + index, padSeed);
    }
    const codeword = encodeTernaryHamming(data);
    for (let position = 0; position < 13; position++) {
      encoded[position * codewordCount + codewordIndex] = codeword[position]!;
    }
  }
  return encoded;
}

function encodeHamming84(nibble: number): number {
  const bits = new Uint8Array(9);
  bits[3] = (nibble >> 3) & 1;
  bits[5] = (nibble >> 2) & 1;
  bits[6] = (nibble >> 1) & 1;
  bits[7] = nibble & 1;
  bits[1] = bits[3]! ^ bits[5]! ^ bits[7]!;
  bits[2] = bits[3]! ^ bits[6]! ^ bits[7]!;
  bits[4] = bits[5]! ^ bits[6]! ^ bits[7]!;
  bits[8] = bits[1]! ^ bits[2]! ^ bits[3]! ^ bits[4]! ^ bits[5]! ^ bits[6]! ^ bits[7]!;
  let codeword = 0;
  for (let position = 1; position <= 8; position++) codeword = (codeword << 1) | bits[position]!;
  return codeword;
}

function decodeHamming84(codeword: number): number {
  const bits = new Uint8Array(9);
  for (let position = 1; position <= 8; position++) {
    bits[position] = (codeword >> (8 - position)) & 1;
  }
  const syndrome =
    (bits[1]! ^ bits[3]! ^ bits[5]! ^ bits[7]!) |
    ((bits[2]! ^ bits[3]! ^ bits[6]! ^ bits[7]!) << 1) |
    ((bits[4]! ^ bits[5]! ^ bits[6]! ^ bits[7]!) << 2);
  const overall = bits[1]! ^ bits[2]! ^ bits[3]! ^ bits[4]! ^
    bits[5]! ^ bits[6]! ^ bits[7]! ^ bits[8]!;
  if (syndrome && overall) bits[syndrome] ^= 1;
  else if (syndrome && !overall) return -1;
  return (bits[3]! << 3) | (bits[5]! << 2) | (bits[6]! << 1) | bits[7]!;
}

function parseCustomHeader(
  bytes: Uint8Array,
  version: number,
  symbolCount: number,
): { rawLen: number; rawFnv: number; symbolBits: number } | null {
  if (bytes.length < CUSTOM_HEADER_LEN) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint8(0) !== MAGIC0 ||
    view.getUint8(1) !== MAGIC1 ||
    view.getUint8(2) !== version ||
    view.getUint8(3) !== symbolCount
  ) return null;
  return {
    rawLen: view.getUint16(4, true),
    rawFnv: view.getUint32(6, true),
    symbolBits: view.getUint8(3),
  };
}

export function decodeCustomEnvelope(symbols: Uint8Array, symbolBits: number): Uint8Array | null {
  if (symbolBits !== CUSTOM_BINARY_SYMBOL_BITS) return null;
  const decodedCapacity = Math.floor(symbols.length / 16);
  const codewordCount = decodedCapacity * 2;
  const bytes = new Uint8Array(decodedCapacity);
  for (let codewordIndex = 0; codewordIndex < codewordCount; codewordIndex++) {
    let codeword = 0;
    for (let plane = 0; plane < 8; plane++) {
      codeword = (codeword << 1) | (symbols[plane * codewordCount + codewordIndex] ?? 0);
    }
    const nibble = decodeHamming84(codeword);
    if (nibble < 0) return null;
    const byteIndex = codewordIndex >> 1;
    if (codewordIndex & 1) bytes[byteIndex] |= nibble;
    else bytes[byteIndex] = nibble << 4;
  }
  const header = parseCustomHeader(bytes, PROTOCOL_VERSION, CUSTOM_BINARY_SYMBOL_BITS);
  if (!header || header.rawLen > bytes.length - CUSTOM_HEADER_LEN) return null;
  const raw = bytes.slice(CUSTOM_HEADER_LEN, CUSTOM_HEADER_LEN + header.rawLen);
  return header.symbolBits === symbolBits && fnv1a(raw) === header.rawFnv ? raw : null;
}

export function decodeTricolorEnvelope(symbols: Uint8Array, decodedCapacity: number): Uint8Array | null {
  const dataTritCount = (decodedCapacity / 5) * 26;
  const codewordCount = Math.ceil(dataTritCount / 10);
  if (symbols.length < codewordCount * 13) return null;
  const dataTrits = new Uint8Array(codewordCount * 10);
  for (let codewordIndex = 0; codewordIndex < codewordCount; codewordIndex++) {
    const codeword = new Uint8Array(13);
    for (let position = 0; position < 13; position++) {
      codeword[position] = symbols[position * codewordCount + codewordIndex]!;
    }
    const decoded = decodeTernaryHamming(codeword);
    if (!decoded) return null;
    dataTrits.set(decoded, codewordIndex * 10);
  }
  const bytes = tritsToBytes(dataTrits.slice(0, dataTritCount));
  if (!bytes) return null;
  const header = parseCustomHeader(bytes, 3, CUSTOM_TRICOLOR_SYMBOL_COUNT);
  if (!header || header.rawLen > bytes.length - CUSTOM_HEADER_LEN) return null;
  const raw = bytes.slice(CUSTOM_HEADER_LEN, CUSTOM_HEADER_LEN + header.rawLen);
  return fnv1a(raw) === header.rawFnv ? raw : null;
}

export function customLocatorInfo(bytes: Uint8Array): { size: number; mode: CustomMode } | null {
  const text = new TextDecoder().decode(bytes);
  const match = /^([HT])(\d{3})$/.exec(text);
  if (!match) return null;
  const size = Number(match[2]);
  if (!(CUSTOM_GRID_SIZES as readonly number[]).includes(size)) return null;
  return { size, mode: match[1] === "T" ? "tricolor" : "binary" };
}

export function customGridSizeFromLocator(bytes: Uint8Array): number | null {
  return customLocatorInfo(bytes)?.size ?? null;
}

export function isCustomLocator(bytes: Uint8Array): boolean {
  return customGridSizeFromLocator(bytes) !== null;
}

function lerp(a: CustomPoint, b: CustomPoint, amount: number): CustomPoint {
  return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount };
}

function averagePoint(points: readonly CustomPoint[]): CustomPoint {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function locatorCenter(position: CustomPosition): CustomPoint {
  return averagePoint([
    position.topLeft,
    position.topRight,
    position.bottomLeft,
    position.bottomRight,
  ]);
}

type GridMapper = {
  point: (row: number, column: number) => CustomPoint;
  radius: number;
};

function createGridMapper(
  positions: readonly CustomPosition[],
  layout: CustomLayout,
): GridMapper | null {
  if (positions.length < 4) return null;
  const centers = positions.map((position) => ({ position, center: locatorCenter(position) }));
  let xBasisX = 0;
  let xBasisY = 0;
  let yBasisX = 0;
  let yBasisY = 0;
  for (const { position } of centers) {
    xBasisX += position.topRight.x - position.topLeft.x;
    xBasisY += position.topRight.y - position.topLeft.y;
    yBasisX += position.bottomLeft.x - position.topLeft.x;
    yBasisY += position.bottomLeft.y - position.topLeft.y;
  }
  const xBasisLength = Math.hypot(xBasisX, xBasisY) || 1;
  const yBasisLength = Math.hypot(yBasisX, yBasisY) || 1;
  xBasisX /= xBasisLength;
  xBasisY /= xBasisLength;
  yBasisX /= yBasisLength;
  yBasisY /= yBasisLength;
  const centroid = averagePoint(centers.map(({ center }) => center));
  const projection = (center: CustomPoint) => ({
    x: (center.x - centroid.x) * xBasisX + (center.y - centroid.y) * xBasisY,
    y: (center.x - centroid.x) * yBasisX + (center.y - centroid.y) * yBasisY,
  });
  centers.sort((a, b) => projection(a.center).y - projection(b.center).y);
  const top = centers.slice(0, 2).sort((a, b) => projection(a.center).x - projection(b.center).x);
  const bottom = centers.slice(-2).sort((a, b) => projection(a.center).x - projection(b.center).x);
  const ordered = [top[0], top[1], bottom[0], bottom[1]];
  if (ordered.some((entry) => !entry)) return null;
  const [topLeft, topRight, bottomLeft, bottomRight] = ordered as [
    { position: CustomPosition; center: CustomPoint },
    { position: CustomPosition; center: CustomPoint },
    { position: CustomPosition; center: CustomPoint },
    { position: CustomPosition; center: CustomPoint },
  ];
  const logicalTopLeft = layout.locators[0]!;
  const logicalTopRight = layout.locators[1]!;
  const logicalBottomLeft = layout.locators[2]!;
  const xSpan = logicalTopRight.centerX - logicalTopLeft.centerX;
  const ySpan = logicalBottomLeft.centerY - logicalTopLeft.centerY;
  if (xSpan <= 0 || ySpan <= 0) return null;
  const horizontalPixels = Math.hypot(
    topRight.center.x - topLeft.center.x,
    topRight.center.y - topLeft.center.y,
  );
  const verticalPixels = Math.hypot(
    bottomLeft.center.x - topLeft.center.x,
    bottomLeft.center.y - topLeft.center.y,
  );
  const radius = Math.min(
    2,
    Math.floor(Math.min(horizontalPixels / xSpan, verticalPixels / ySpan) * 0.16),
  );
  return {
    point(row, column) {
      const u = (column + 0.5 - logicalTopLeft.centerX) / xSpan;
      const v = (row + 0.5 - logicalTopLeft.centerY) / ySpan;
      const topPoint = lerp(topLeft.center, topRight.center, u);
      const bottomPoint = lerp(bottomLeft.center, bottomRight.center, u);
      return lerp(topPoint, bottomPoint, v);
    },
    radius,
  };
}

function sampleRgb(
  image: RgbaImage,
  mapper: GridMapper,
  row: number,
  column: number,
): readonly [number, number, number] {
  const center = mapper.point(row, column);
  const radius = mapper.radius;
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
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

function luminance(sample: readonly [number, number, number]): number {
  return 0.2126 * sample[0] + 0.7152 * sample[1] + 0.0722 * sample[2];
}

export function decodeCustomImage(
  image: RgbaImage,
  positions: readonly CustomPosition[],
  layout = createCustomLayout(),
): Uint8Array | null {
  const mapper = createGridMapper(positions, layout);
  if (!mapper) return null;
  const levels = new Float32Array(layout.symbolCount);
  const paletteRgb = new Float32Array(layout.symbolCount * 3);
  const paletteCounts = new Uint8Array(layout.symbolCount);
  for (let index = 0; index < layout.calibrationPositions.length; index++) {
    const symbol = layout.calibrationSymbols[index]!;
    const sample = sampleRgb(
      image,
      mapper,
      layout.calibrationRows[index]!,
      layout.calibrationColumns[index]!,
    );
    levels[symbol] += luminance(sample);
    paletteRgb[symbol * 3] += sample[0];
    paletteRgb[symbol * 3 + 1] += sample[1];
    paletteRgb[symbol * 3 + 2] += sample[2];
    paletteCounts[symbol] = (paletteCounts[symbol] ?? 0) + 1;
  }
  for (let index = 0; index < layout.symbolCount; index++) {
    const count = paletteCounts[index] || 1;
    levels[index] /= count;
    paletteRgb[index * 3] /= count;
    paletteRgb[index * 3 + 1] /= count;
    paletteRgb[index * 3 + 2] /= count;
  }
  const symbols = new Uint8Array(layout.dataPositions.length);
  if (layout.mode === "binary") {
    // Symbol 0 is white and symbol 1 is black. Reject badly blurred/exposed
    // frames before they can poison the fountain decoder.
    if (levels[0]! - levels[1]! < 36) return null;
    const threshold = (levels[0]! + levels[1]!) / 2;
    for (let index = 0; index < layout.dataPositions.length; index++) {
      const sample = sampleRgb(image, mapper, layout.dataRows[index]!, layout.dataColumns[index]!);
      symbols[index] = luminance(sample) < threshold ? 1 : 0;
    }
    return decodeCustomEnvelope(symbols, CUSTOM_BINARY_SYMBOL_BITS);
  }

  // Tricolor symbols are red, green, and black. Learn their observed RGB
  // centroids from this exact camera exposure and classify by nearest color.
  // The minimum separation rejects clipped or badly defocused frames.
  let minimumDistance = Number.POSITIVE_INFINITY;
  for (let a = 0; a < layout.symbolCount; a++) {
    for (let b = a + 1; b < layout.symbolCount; b++) {
      const dr = paletteRgb[a * 3]! - paletteRgb[b * 3]!;
      const dg = paletteRgb[a * 3 + 1]! - paletteRgb[b * 3 + 1]!;
      const db = paletteRgb[a * 3 + 2]! - paletteRgb[b * 3 + 2]!;
      minimumDistance = Math.min(minimumDistance, Math.hypot(dr, dg, db));
    }
  }
  if (minimumDistance < 54) return null;
  for (let index = 0; index < layout.dataPositions.length; index++) {
    const sample = sampleRgb(image, mapper, layout.dataRows[index]!, layout.dataColumns[index]!);
    let bestSymbol = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let symbol = 0; symbol < layout.symbolCount; symbol++) {
      const dr = sample[0] - paletteRgb[symbol * 3]!;
      const dg = sample[1] - paletteRgb[symbol * 3 + 1]!;
      const db = sample[2] - paletteRgb[symbol * 3 + 2]!;
      const distance = dr * dr + dg * dg + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestSymbol = symbol;
      }
    }
    symbols[index] = bestSymbol;
  }
  return decodeTricolorEnvelope(symbols, customCapacityForMode(layout, "tricolor"));
}
