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
  CUSTOM_BINARY_SYMBOL_BITS,
  CUSTOM_DEFAULT_GRID_SIZE,
  CUSTOM_GRID_SIZES,
  CUSTOM_HEADER_LEN,
  createCustomEnvelope,
  createTricolorEnvelope,
  createCustomLayout,
  customSymbolAt,
  customCapacityForMode,
  tricolorSymbolAt,
  type CustomMode,
} from "../shared/custom-frame";

const MARGIN = 4;
// Keep enough already-rendered frames queued to absorb a tile
// encode or a garbage-collection pause without starving the display clock.
const LOOKAHEAD = 6;

const dropzone = document.getElementById("dropzone")!;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const stage = document.getElementById("stage")!;
const canvas = document.getElementById("qr") as HTMLCanvasElement;
const specs = document.getElementById("specs")!;
const cfgMode = document.getElementById("cfg-mode") as HTMLSelectElement;
const cfgDensity = document.getElementById("cfg-density") as HTMLSelectElement;
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

type WakeLock = { release: () => Promise<void> };
let wakeLock: WakeLock | null = null;

let generation = 0;
let currentPayload: Uint8Array | null = null;
let currentFileName = "";

async function main() {
  syncTuningOptions();
  for (const el of [cfgMode, cfgDensity, cfgFps, cfgBytes, cfgEcc, cfgSize]) {
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
  const mode = cfgMode.value as "mono" | CustomMode;
  const txFps = Number(cfgFps.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const displayPx = Number(cfgSize.value);
  const customMode = mode === "mono" ? null : mode;
  const customLayout = customMode
    ? createCustomLayout(selectGridSize(displayPx), customMode)
    : null;
  const frameBytes = customLayout
    ? customCapacityForMode(customLayout, customMode!) - CUSTOM_HEADER_LEN
    : Number(cfgBytes.value);

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

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = modules + 2 * MARGIN;
    const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    // Integer backing pixels keep every binary cell crisp on Retina displays.
    const exactCssSize = (total * scale) / dpr;
    canvas.style.width = `${exactCssSize}px`;
    canvas.style.height = `${exactCssSize}px`;
  };

  if (customLayout) {
    const capacity = customCapacityForMode(customLayout, customMode!);
    if (CUSTOM_HEADER_LEN + frameBytes > capacity) {
      throw new Error(`tile carrier holds ${capacity - CUSTOM_HEADER_LEN} raw bytes/frame`);
    }
    modules = customLayout.size;
    sizeCanvas();
    specs.textContent =
      `${currentFileName} (${Math.round(payload.length / 1024)} KB) · ` +
      `${txFps} FPS · ${frameBytes} bytes/frame · ${customMode === "tricolor" ? "red/green/black" : "binary tiles"} · ` +
      `${customLayout.size}×${customLayout.size} · K=${encoder.k}`;
  }

  const makeFrame = (): ImageData => {
    const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
    nextSeq++;
    if (customLayout) {
      const capacity = customCapacityForMode(customLayout, customMode!);
      const envelope = customMode === "tricolor"
        ? createTricolorEnvelope(bytes, capacity)
        : createCustomEnvelope(bytes, capacity, CUSTOM_BINARY_SYMBOL_BITS);
      const padSeed = fnv1a(envelope);
      const total = customLayout.size + 2 * MARGIN;
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
          // payload cells touch the locator, ZXing loses the finder even
          // though the QR modules themselves are intact.
          if (customLayout.reserved[matrixIndex] && calibrationIndex === 0xff) {
            pixels[destination] = 0xffffffff;
            continue;
          }
          const symbol = calibrationIndex === 0xff
            ? customMode === "tricolor"
              ? tricolorSymbolAt(envelope, customLayout.positionIndex[matrixIndex] ?? 0, padSeed)
              : customSymbolAt(
                envelope,
                customLayout.positionIndex[matrixIndex] ?? 0,
                CUSTOM_BINARY_SYMBOL_BITS,
                padSeed,
              )
            : customLayout.calibrationSymbols[calibrationIndex] ?? 0;
          pixels[destination] = customMode === "tricolor"
            ? ([0xff0000ff, 0xff00ff00, 0xff000000] as const)[symbol]!
            : symbol ? 0xff000000 : 0xffffffff;
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
  const customMode = cfgMode.value === "mono" ? null : cfgMode.value as CustomMode;
  cfgDensity.disabled = !customMode;
  cfgBytes.disabled = Boolean(customMode);
  cfgEcc.disabled = Boolean(customMode);
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
  const selectedSize = selectGridSize(Number(cfgSize.value));
  const selectedLayout = createCustomLayout(selectedSize, customMode ?? "binary");
  const selectedBytes = customCapacityForMode(selectedLayout, customMode ?? "binary") - CUSTOM_HEADER_LEN;
  tuningHint.textContent = customMode
    ? `${customMode === "tricolor" ? "Tricolor red/green/black" : "Binary"} ${selectedSize}×${selectedSize}: ${selectedBytes.toLocaleString()} protected bytes/frame. Auto scales from phone to TV; 512 is manual for 4K plus 1920+ camera capture.`
    : `Standard monochrome QR compatibility mode. For ECC ${ecc}, the maximum profile is ${maxBytes} bytes/frame.`;
}

function selectGridSize(displayPx: number): number {
  const requested = cfgDensity.value;
  if (requested !== "auto") return Number(requested);
  const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
  // Auto stays conservative enough for the receiver's default 1280-wide
  // camera mode. The 512 profile is manual because it needs 1920+ capture.
  const candidates = CUSTOM_GRID_SIZES.filter((size) => size <= 352).reverse();
  return candidates.find((size) => cssBudget / (size + 2 * MARGIN) >= 3.2)
    ?? CUSTOM_DEFAULT_GRID_SIZE;
}

function showStreamError(err: unknown) {
  specs.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
  stage.style.display = "none";
  dropzone.style.display = "block";
}

void main();
