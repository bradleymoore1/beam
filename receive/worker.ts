// QR decode worker: zxing-cpp compiled to WASM. (Safari has never shipped
// BarcodeDetector — WebKit bug 281848 — so WASM is the only portable way.)
// One frame in flight per worker; the main thread drops frames when all
// workers are busy. Frames are disposable — the fountain doesn't care.

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import { decodeBeaconFrameText } from "../shared/beacon-frame";
import { decodeCustomImage, isCustomLocator } from "../shared/custom-frame";

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

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, w, h } = e.data as { id: number; buf: ArrayBuffer; w: number; h: number };
  try {
    const img = new ImageData(new Uint8ClampedArray(buf), w, h);
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
    const customLocators = carriers
      .filter((x) => isCustomLocator(x.bytes))
      .map((x) => x.position);
    if (customLocators.length >= 4) {
      const bytes = decodeCustomImage(img, customLocators);
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
