import QRCode from "qrcode";
import { fnv1a } from "./protocol";

// The tile mode is deliberately not a QR code. Four tiny standard QR symbols
// are locators only; the rest is a raw black/white field. Binary survives
// camera demosaicing, white balance, compression, and imperfect focus much
// better than the retired RGB carrier while reclaiming QR's format overhead.
export const CUSTOM_LOCATOR_TEXT = "BMB1";
export const CUSTOM_GRID_SIZE = 176;
export const CUSTOM_OUTER_MARGIN = 4;
export const CUSTOM_BINARY_SYMBOL_BITS = 1;
export const CUSTOM_SYMBOL_COUNT = 2;
export const CUSTOM_HEADER_LEN = 10;
export const CUSTOM_LOCATOR_VERSION = 1;
export const CUSTOM_LOCATOR_SIZE = 21;
export const CUSTOM_LOCATOR_QUIET = 4;
export const CUSTOM_LOCATOR_TOTAL = CUSTOM_LOCATOR_SIZE + CUSTOM_LOCATOR_QUIET * 2;
export const CUSTOM_LOCATOR_INSET = 6;
export const CUSTOM_CALIBRATION_X = Math.floor(CUSTOM_GRID_SIZE / 2) - CUSTOM_SYMBOL_COUNT / 2;
export const CUSTOM_CALIBRATION_Y = Math.floor(CUSTOM_GRID_SIZE / 2);
export const CUSTOM_CALIBRATION_COPIES = 4;

const MAGIC0 = 0xb3;
const MAGIC1 = 0x54;
const PROTOCOL_VERSION = 1;
const BORDER_CELLS = 2;

export type CustomPoint = { x: number; y: number };

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

let cachedLayout: CustomLayout | null = null;

function setReserved(layout: Uint8Array, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= CUSTOM_GRID_SIZE || y >= CUSTOM_GRID_SIZE) return;
  layout[y * CUSTOM_GRID_SIZE + x] = 1;
}

export function createCustomLayout(): CustomLayout {
  if (cachedLayout) return cachedLayout;

  const locator = QRCode.create(
    [{ data: new TextEncoder().encode(CUSTOM_LOCATOR_TEXT), mode: "byte" }],
    { version: CUSTOM_LOCATOR_VERSION, errorCorrectionLevel: "H", maskPattern: 4 },
  );
  const reserved = new Uint8Array(CUSTOM_GRID_SIZE * CUSTOM_GRID_SIZE);
  const locatorCellIndex = new Int32Array(CUSTOM_GRID_SIZE * CUSTOM_GRID_SIZE);
  locatorCellIndex.fill(-1);

  for (let row = 0; row < CUSTOM_GRID_SIZE; row++) {
    for (let column = 0; column < CUSTOM_GRID_SIZE; column++) {
      if (
        row < BORDER_CELLS ||
        column < BORDER_CELLS ||
        row >= CUSTOM_GRID_SIZE - BORDER_CELLS ||
        column >= CUSTOM_GRID_SIZE - BORDER_CELLS
      ) {
        setReserved(reserved, column, row);
      }
    }
  }

  const locatorOrigins = [
    { x: CUSTOM_LOCATOR_INSET, y: CUSTOM_LOCATOR_INSET },
    {
      x: CUSTOM_GRID_SIZE - CUSTOM_LOCATOR_INSET - CUSTOM_LOCATOR_TOTAL,
      y: CUSTOM_LOCATOR_INSET,
    },
    {
      x: CUSTOM_LOCATOR_INSET,
      y: CUSTOM_GRID_SIZE - CUSTOM_LOCATOR_INSET - CUSTOM_LOCATOR_TOTAL,
    },
    {
      x: CUSTOM_GRID_SIZE - CUSTOM_LOCATOR_INSET - CUSTOM_LOCATOR_TOTAL,
      y: CUSTOM_GRID_SIZE - CUSTOM_LOCATOR_INSET - CUSTOM_LOCATOR_TOTAL,
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
        setReserved(reserved, x, y);
        const qrColumn = column - CUSTOM_LOCATOR_QUIET;
        const qrRow = row - CUSTOM_LOCATOR_QUIET;
        if (
          qrColumn >= 0 &&
          qrColumn < CUSTOM_LOCATOR_SIZE &&
          qrRow >= 0 &&
          qrRow < CUSTOM_LOCATOR_SIZE
        ) {
          locatorCellIndex[y * CUSTOM_GRID_SIZE + x] = qrRow * CUSTOM_LOCATOR_SIZE + qrColumn;
        }
      }
    }
  }

  const calibrationPositions: number[] = [];
  const calibrationSymbols: number[] = [];
  const calibrationIndex = new Uint8Array(CUSTOM_GRID_SIZE * CUSTOM_GRID_SIZE);
  calibrationIndex.fill(0xff);
  for (let copy = 0; copy < CUSTOM_CALIBRATION_COPIES; copy++) {
    for (let symbol = 0; symbol < CUSTOM_SYMBOL_COUNT; symbol++) {
      const x = CUSTOM_CALIBRATION_X + symbol;
      const y = CUSTOM_CALIBRATION_Y + copy;
      const position = y * CUSTOM_GRID_SIZE + x;
      setReserved(reserved, x, y);
      calibrationIndex[position] = calibrationPositions.length;
      calibrationPositions.push(position);
      calibrationSymbols.push(symbol);
    }
  }

  const dataPositions: number[] = [];
  const dataRows: number[] = [];
  const dataColumns: number[] = [];
  const positionIndex = new Uint32Array(CUSTOM_GRID_SIZE * CUSTOM_GRID_SIZE);
  positionIndex.fill(0xffffffff);
  for (let row = 0; row < CUSTOM_GRID_SIZE; row++) {
    for (let column = 0; column < CUSTOM_GRID_SIZE; column++) {
      const position = row * CUSTOM_GRID_SIZE + column;
      if (reserved[position]) continue;
      positionIndex[position] = dataPositions.length;
      dataPositions.push(position);
      dataRows.push(row);
      dataColumns.push(column);
    }
  }

  const layout: CustomLayout = {
    size: CUSTOM_GRID_SIZE,
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
      Math.floor(position / CUSTOM_GRID_SIZE)),
    calibrationColumns: Uint16Array.from(calibrationPositions, (position) =>
      position % CUSTOM_GRID_SIZE),
    calibrationIndex,
    calibrationSymbols: Uint8Array.from(calibrationSymbols),
  };
  cachedLayout = layout;
  return layout;
}

export function customCapacity(layout = createCustomLayout()): number {
  return customCapacityForBits(layout, CUSTOM_BINARY_SYMBOL_BITS);
}

export function customCapacityForBits(
  layout: CustomLayout = createCustomLayout(),
  symbolBits: number,
): number {
  return Math.floor((layout.dataPositions.length * symbolBits) / 8);
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

export function createCustomEnvelope(
  raw: Uint8Array,
  symbolBits = CUSTOM_BINARY_SYMBOL_BITS,
): Uint8Array {
  if (symbolBits !== CUSTOM_BINARY_SYMBOL_BITS) throw new Error("unsupported custom symbol depth");
  if (raw.length > 0xffff) throw new Error("custom frame is too large");
  const out = new Uint8Array(CUSTOM_HEADER_LEN + raw.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, MAGIC0);
  view.setUint8(1, MAGIC1);
  view.setUint8(2, PROTOCOL_VERSION);
  view.setUint8(3, symbolBits);
  view.setUint16(4, raw.length, true);
  view.setUint32(6, fnv1a(raw), true);
  out.set(raw, CUSTOM_HEADER_LEN);
  return out;
}

function parseCustomHeader(
  bytes: Uint8Array,
): { rawLen: number; rawFnv: number; symbolBits: number } | null {
  if (bytes.length < CUSTOM_HEADER_LEN) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint8(0) !== MAGIC0 ||
    view.getUint8(1) !== MAGIC1 ||
    view.getUint8(2) !== PROTOCOL_VERSION ||
    view.getUint8(3) !== CUSTOM_BINARY_SYMBOL_BITS
  ) return null;
  return {
    rawLen: view.getUint16(4, true),
    rawFnv: view.getUint32(6, true),
    symbolBits: view.getUint8(3),
  };
}

export function decodeCustomEnvelope(symbols: Uint8Array, symbolBits: number): Uint8Array | null {
  const bytes = new Uint8Array(Math.floor((symbols.length * symbolBits) / 8));
  for (let index = 0; index < bytes.length; index++) {
    let value = 0;
    for (let bit = 0; bit < 8; bit++) {
      const offset = index * 8 + bit;
      const symbol = symbols[Math.floor(offset / symbolBits)] ?? 0;
      value = (value << 1) |
        ((symbol >> (symbolBits - 1 - (offset % symbolBits))) & 1);
    }
    bytes[index] = value;
  }
  const header = parseCustomHeader(bytes);
  if (!header || header.rawLen > bytes.length - CUSTOM_HEADER_LEN) return null;
  const raw = bytes.slice(CUSTOM_HEADER_LEN, CUSTOM_HEADER_LEN + header.rawLen);
  return header.symbolBits === symbolBits && fnv1a(raw) === header.rawFnv ? raw : null;
}

export function isCustomLocator(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes) === CUSTOM_LOCATOR_TEXT;
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
  const levels = new Float32Array(CUSTOM_SYMBOL_COUNT);
  const paletteCounts = new Uint8Array(CUSTOM_SYMBOL_COUNT);
  for (let index = 0; index < layout.calibrationPositions.length; index++) {
    const symbol = layout.calibrationSymbols[index]!;
    const sample = sampleRgb(
      image,
      mapper,
      layout.calibrationRows[index]!,
      layout.calibrationColumns[index]!,
    );
    levels[symbol] += luminance(sample);
    paletteCounts[symbol] = (paletteCounts[symbol] ?? 0) + 1;
  }
  for (let index = 0; index < CUSTOM_SYMBOL_COUNT; index++) {
    const count = paletteCounts[index] || 1;
    levels[index] /= count;
  }
  // Symbol 0 is white and symbol 1 is black. Reject badly blurred/exposed
  // frames before they can poison the fountain decoder.
  if (levels[0]! - levels[1]! < 36) return null;
  const threshold = (levels[0]! + levels[1]!) / 2;
  const symbols = new Uint8Array(layout.dataPositions.length);
  for (let index = 0; index < layout.dataPositions.length; index++) {
    const sample = sampleRgb(
      image,
      mapper,
      layout.dataRows[index]!,
      layout.dataColumns[index]!,
    );
    symbols[index] = luminance(sample) < threshold ? 1 : 0;
  }
  return decodeCustomEnvelope(symbols, CUSTOM_BINARY_SYMBOL_BITS);
}
