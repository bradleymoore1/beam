import QRCode from "qrcode";
import { LTEncoder } from "../shared/fountain";
import {
  HEADER_LEN,
  MAX_K,
  MAX_TOTAL_LEN,
  fnv1a,
  packFrame,
  type FrameHeader,
} from "../shared/protocol";
import {
  COLOR_HEADER_LEN,
  COLOR_VERSION,
  colorCapacity,
  colorFor,
  createColorEnvelope,
  createColorMatrix,
  rgba32,
  symbolAt,
} from "../shared/color-frame";
import {
  CUSTOM_GRID_SIZE,
  CUSTOM_HEADER_LEN,
  CUSTOM_RAW_FRAME_BYTES,
  CUSTOM_SAFE_RAW_FRAME_BYTES,
  CUSTOM_SAFE_SYMBOL_BITS,
  CUSTOM_TURBO_SYMBOL_BITS,
  createCustomEnvelope,
  createCustomLayout,
  customColorFor,
  customRgba32,
  customSymbolAt,
  customCapacityForBits,
} from "../shared/custom-frame";

const MARGIN = 4;
// Keep enough already-rendered frames queued to absorb a slow color/tile
// encode or a garbage-collection pause without starving the display clock.
const LOOKAHEAD = 6;

const dropzone = document.getElementById("dropzone")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const stage = document.getElementById("stage")!;
const canvas = document.getElementById("qr") as HTMLCanvasElement;
const specs = document.getElementById("specs")!;
const cfgMode = document.getElementById("cfg-mode") as HTMLSelectElement;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;
const tuningHint = document.getElementById("tuning-hint")!;

const MAX_FRAME_BYTES_BY_ECC = {
  L: 2833,
  M: 2331,
  Q: 1465,
  H: 1000,
} as const;

const CUSTOM_LAYOUT = createCustomLayout();
const COLOR_MATRIX = createColorMatrix(COLOR_VERSION);
const COLOR_RAW_FRAME_BYTES = colorCapacity(COLOR_MATRIX) - COLOR_HEADER_LEN;

type WakeLock = { release: () => Promise<void> };
let wakeLock: WakeLock | null = null;

let generation = 0;
let currentPayload: Uint8Array | null = null;
let currentFileName = "";

async function main() {
  syncTuningOptions();
  for (const el of [cfgMode, cfgFps, cfgBytes, cfgEcc, cfgSize]) {
    el.addEventListener("change", () => {
      syncTuningOptions();
      if (currentPayload) {
        void startStream(currentPayload).catch(showStreamError);
      }
    });
  }

  dropzone.addEventListener("click", () => {
    fileInput.value = "";
  });
  dropzone.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    fileInput.value = "";
    fileInput.click();
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "#fff";
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.style.borderColor = "#666";
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.style.borderColor = "#666";
    const file = e.dataTransfer?.files[0];
    if (file) {
      void handleFile(file);
    }
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) {
      void handleFile(file);
    }
  });

  window.addEventListener("pagehide", () => {
    generation++;
    void wakeLock?.release().catch(() => undefined);
    wakeLock = null;
  });
}

async function handleFile(file: File) {
  specs.textContent = `Loading ${file.name}...`;
  currentFileName = file.name;
  try {
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_TOTAL_LEN) {
      throw new Error(`file is too large (maximum ${Math.round(MAX_TOTAL_LEN / 1024 / 1024)} MB)`);
    }
    currentPayload = new Uint8Array(buffer);
  } catch (err) {
    currentPayload = null;
    specs.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  dropzone.style.display = "none";
  stage.style.display = "block";
  await startStream(currentPayload).catch(showStreamError);
}

async function startStream(payload: Uint8Array) {
  const gen = ++generation;
  const mode = cfgMode.value as "mono" | "color" | "custom-safe" | "custom";
  const txFps = Number(cfgFps.value);
  const frameBytes = mode === "color"
    ? COLOR_RAW_FRAME_BYTES
    : mode === "custom-safe"
      ? CUSTOM_SAFE_RAW_FRAME_BYTES
      : mode === "custom"
        ? CUSTOM_RAW_FRAME_BYTES
      : Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const displayPx = Number(cfgSize.value);

  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const sessionId = (random[0]! & 0xffff) || 1;
  const blockLen = frameBytes - HEADER_LEN;
  if (blockLen <= 0) throw new Error("bytes per frame is too small");
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  if (encoder.k > MAX_K) {
    throw new Error("file is too large for this bytes-per-frame setting");
  }
  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
    name: currentFileName,
  };

  let version: number | undefined;
  let modules = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const stagingCtx = staging.getContext("2d")!;
  const ctx = canvas.getContext("2d")!;
  const queue: ImageData[] = [];
  let nextSeq = 0;
  let pumpScheduled = false;
  const colorMatrix = mode === "color" ? COLOR_MATRIX : null;
  const customLayout = mode === "custom-safe" || mode === "custom" ? CUSTOM_LAYOUT : null;
  const customBits = mode === "custom-safe" ? CUSTOM_SAFE_SYMBOL_BITS : CUSTOM_TURBO_SYMBOL_BITS;

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = modules + 2 * MARGIN;
    const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    // Keep the visible frame size stable when a larger color carrier is
    // selected. The backing canvas remains integer-scaled for crisp modules,
    // while CSS presents the same display budget as monochrome mode.
    canvas.style.width = `${Math.floor(cssBudget)}px`;
    canvas.style.height = `${Math.floor(cssBudget)}px`;
  };

  if (colorMatrix) {
    const capacity = colorCapacity(colorMatrix);
    if (COLOR_HEADER_LEN + frameBytes > capacity) {
      throw new Error(`color carrier holds ${capacity - COLOR_HEADER_LEN} raw bytes/frame`);
    }
    version = COLOR_VERSION;
    modules = colorMatrix.size;
    sizeCanvas();
    specs.textContent =
      `${currentFileName} (${Math.round(payload.length / 1024)} KB) · ` +
      `${txFps} FPS · ${frameBytes} bytes/frame · RGB burst · V${COLOR_VERSION} · K=${encoder.k}`;
  }

  if (customLayout) {
    const capacity = customCapacityForBits(customLayout, customBits);
    if (CUSTOM_HEADER_LEN + frameBytes > capacity) {
      throw new Error(`tile carrier holds ${capacity - CUSTOM_HEADER_LEN} raw bytes/frame`);
    }
    modules = CUSTOM_GRID_SIZE;
    sizeCanvas();
    specs.textContent =
      `${currentFileName} (${Math.round(payload.length / 1024)} KB) · ` +
      `${txFps} FPS · ${frameBytes} bytes/frame · RGB tile ${customBits === 3 ? "safe" : "turbo"} · ` +
      `${CUSTOM_GRID_SIZE}×${CUSTOM_GRID_SIZE} · K=${encoder.k}`;
  }

  const makeFrame = (): ImageData => {
    const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    nextSeq++;
    if (customLayout) {
      const envelope = createCustomEnvelope(bytes, customBits);
      const colorPadSeed = fnv1a(envelope);
      const total = CUSTOM_GRID_SIZE + 2 * MARGIN;
      const img = new ImageData(total, total);
      const pixels = new Uint32Array(img.data.buffer);
      pixels.fill(0xffffffff);
      for (let row = 0; row < customLayout.size; row++) {
        for (let column = 0; column < customLayout.size; column++) {
          const matrixIndex = row * customLayout.size + column;
          const destination = (row + MARGIN) * total + column + MARGIN;
          const locatorCell = customLayout.locatorCellIndex[matrixIndex]!;
          if (locatorCell >= 0) {
            pixels[destination] = customLayout.locatorData[locatorCell]
              ? 0xff000000
              : 0xffffffff;
            continue;
          }
          const calibrationIndex = customLayout.calibrationIndex[matrixIndex] ?? 0xff;
          // QR quiet zones and the outer field border must stay white. If
          // payload colors touch the locator, ZXing loses the finder even
          // though the QR modules themselves are intact.
          if (customLayout.reserved[matrixIndex] && calibrationIndex === 0xff) {
            pixels[destination] = 0xffffffff;
            continue;
          }
          const symbol = calibrationIndex === 0xff
            ? customSymbolAt(
              envelope,
              customLayout.positionIndex[matrixIndex] ?? 0,
              customBits,
              colorPadSeed,
            )
            : customLayout.calibrationSymbols[calibrationIndex] ?? 0;
          const [red, green, blue] = customColorFor(symbol);
          pixels[destination] = customRgba32(red, green, blue);
        }
      }
      return img;
    }
    if (colorMatrix) {
      const envelope = createColorEnvelope(bytes);
      const colorPadSeed = fnv1a(envelope);
      const total = colorMatrix.size + 2 * MARGIN;
      const img = new ImageData(total, total);
      const pixels = new Uint32Array(img.data.buffer);
      pixels.fill(0xffffffff);
      for (let row = 0; row < colorMatrix.size; row++) {
        for (let column = 0; column < colorMatrix.size; column++) {
          const matrixIndex = row * colorMatrix.size + column;
          const destination = (row + MARGIN) * total + column + MARGIN;
          if (colorMatrix.reserved[matrixIndex]) {
            pixels[destination] = colorMatrix.data[matrixIndex]
              ? 0xff000000
              : 0xffffffff;
          } else {
            const calibrationIndex = colorMatrix.calibrationIndex[matrixIndex] ?? 0xff;
            const symbol = calibrationIndex === 0xff
              ? symbolAt(envelope, colorMatrix.positionIndex[matrixIndex] ?? 0, colorPadSeed)
              : colorMatrix.calibrationSymbols[calibrationIndex] ?? 0;
            const [red, green, blue] = colorFor(
              colorMatrix.data[matrixIndex] ?? 0,
              symbol,
            );
            pixels[destination] = rgba32(red, green, blue);
          }
        }
      }
      return img;
    }
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
    if (version === undefined) {
      version = qr.version;
      modules = qr.modules.size;
      sizeCanvas();
      specs.textContent =
        `${currentFileName} (${Math.round(payload.length / 1024)} KB) · ` +
        `${txFps} FPS · ${frameBytes} bytes/frame · V${version} · ECC ${ecc} · K=${encoder.k}`;
    }
    const size = qr.modules.size;
    const data = qr.modules.data;
    const total = size + 2 * MARGIN;
    const img = new ImageData(total, total);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    for (let y = 0; y < size; y++) {
      const row = (y + MARGIN) * total + MARGIN;
      const src = y * size;
      for (let x = 0; x < size; x++) {
        if (data[src + x]) px[row + x] = 0xff000000;
      }
    }
    return img;
  };

  const pump = () => {
    pumpScheduled = false;
    if (gen !== generation) return;
    try {
      while (queue.length < LOOKAHEAD) queue.push(makeFrame());
    } catch (err) {
      specs.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
      generation++;
      return;
    }
    if (queue.length < LOOKAHEAD) {
      pumpScheduled = true;
      setTimeout(pump, 0);
    }
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    if (gen !== generation) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    if (!img) {
      nextAt = now + interval;
      if (!pumpScheduled) {
        pumpScheduled = true;
        setTimeout(pump, 0);
      }
      return;
    }
    stagingCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    if (!pumpScheduled) {
      pumpScheduled = true;
      setTimeout(pump, 0);
    }
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval;
  };
  requestAnimationFrame(tick);

  try {
    const lockApi = (navigator as Navigator & {
      wakeLock?: { request(t: "screen"): Promise<WakeLock> };
    }).wakeLock;
    wakeLock = (await lockApi?.request("screen")) ?? null;
  } catch {
    wakeLock = null;
  }
}

function syncTuningOptions() {
  const color = cfgMode.value === "color";
  const custom = cfgMode.value === "custom" || cfgMode.value === "custom-safe";
  cfgBytes.disabled = color || custom;
  cfgEcc.disabled = color || custom;
  const ecc = cfgEcc.value as keyof typeof MAX_FRAME_BYTES_BY_ECC;
  const maxBytes = MAX_FRAME_BYTES_BY_ECC[ecc];
  let frameBytes = Number(cfgBytes.value);
  if (frameBytes > maxBytes) {
    const valid = [...cfgBytes.options]
      .map((option) => Number(option.value))
      .filter((value) => value <= maxBytes);
    frameBytes = Math.max(...valid);
    cfgBytes.value = String(frameBytes);
  }
  for (const option of [...cfgBytes.options]) {
    option.disabled = Number(option.value) > maxBytes;
  }
  for (const option of [...cfgEcc.options]) {
    const optionEcc = option.value as keyof typeof MAX_FRAME_BYTES_BY_ECC;
    option.disabled = MAX_FRAME_BYTES_BY_ECC[optionEcc] < frameBytes;
  }
  tuningHint.textContent = color
    ? `Experimental color burst: V${COLOR_VERSION}, calibrated RGB palette, ${COLOR_RAW_FRAME_BYTES} raw bytes/frame. Keep the phone steady and close. Format is intentionally opt-in.`
    : custom
      ? cfgMode.value === "custom-safe"
        ? `Safe RGB tile video: ${CUSTOM_GRID_SIZE}×${CUSTOM_GRID_SIZE} calibrated 8-color field, ${CUSTOM_SAFE_RAW_FRAME_BYTES} raw bytes/frame. The small QR is only a locator; keep the phone close and steady.`
        : `Turbo RGB tile video: ${CUSTOM_GRID_SIZE}×${CUSTOM_GRID_SIZE} calibrated 16-color field, ${CUSTOM_RAW_FRAME_BYTES} raw bytes/frame. The small QR is only a locator; keep the phone close and steady.`
    : `For ECC ${ecc}, the maximum reliable payload profile here is ${maxBytes} bytes/frame.`;
}

function showStreamError(err: unknown) {
  specs.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
  stage.style.display = "none";
  dropzone.style.display = "block";
}

void main();
