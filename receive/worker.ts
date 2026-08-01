// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { decodeBeaconFrameText } from "../shared/beacon-frame";
import {
  createCustomLayout,
  customLocatorInfo,
  decodeCustomImage,
  type CustomMode,
  type CustomPosition,
} from "../shared/custom-frame";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : prefix + path,
  },
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

let trackedCustom: { size: number; mode: CustomMode; positions: CustomPosition[] } | null = null;

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, w, h } = e.data as { id: number; buf: ArrayBuffer; w: number; h: number };
  try {
    const img = new ImageData(new Uint8ClampedArray(buf), w, h);
    // Once a binary field is locked, its four locator positions are stable
    // across frames. Decode directly and only pay ZXing's full-frame search
    // again after motion, focus loss, or an integrity failure.
    if (trackedCustom) {
      const trackedBytes = decodeCustomImage(
        img,
        trackedCustom.positions,
        createCustomLayout(trackedCustom.size, trackedCustom.mode),
      );
      if (trackedBytes) {
        ctx.postMessage({ id, bytes: trackedBytes }, [trackedBytes.buffer]);
        return;
      }
      trackedCustom = null;
    }
    const results = await readBarcodes(img, {
      formats: ["QRCode"],
      maxNumberOfSymbols: 4,
      returnErrors: true,
    });
    const carriers = results.filter((x) => x.isValid && x.bytes.length > 0);
    const carrier = carriers[0];
    const beaconBytes = carrier ? decodeBeaconFrameText(carrier.text) : null;
    if (beaconBytes) {
      ctx.postMessage({ id, bytes: beaconBytes }, [beaconBytes.buffer]);
      return;
    }
    const customCarriers = carriers
      .map((result) => ({ result, info: customLocatorInfo(result.bytes) }))
      .filter((entry) => entry.info !== null);
    const customInfo = customCarriers[0]?.info;
    const customSize = customInfo?.size;
    const customMode = customInfo?.mode;
    const customLocators = customCarriers
      .filter((entry) => entry.info?.size === customSize && entry.info?.mode === customMode)
      .map((entry) => entry.result.position);
    if (customSize && customMode && customLocators.length >= 4) {
      trackedCustom = { size: customSize, mode: customMode, positions: customLocators };
      const bytes = decodeCustomImage(
        img,
        customLocators,
        createCustomLayout(customSize, customMode),
      );
      ctx.postMessage({ id, bytes });
      return;
    }
    ctx.postMessage({ id, bytes: carrier?.bytes ?? null });
  } catch {
    ctx.postMessage({ id, bytes: null });
  }
};

// warm the WASM so the first real frame doesn't pay instantiation
void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, bytes: null }));
