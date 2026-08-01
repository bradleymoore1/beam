import { attachCameraZoom, type CameraZoomController } from "../shared/camera-zoom";

// A small companion scanner for the hardware Trail Beacon. The same ZXing
// worker used by the Beam receiver decodes the board's standard WIFI QR.

const startButton = document.getElementById("start") as HTMLButtonElement;
const status = document.getElementById("status")!;
const preview = document.getElementById("preview") as HTMLElement;
const video = document.getElementById("video") as HTMLVideoElement;
const zoomControls = document.getElementById("zoom-controls") as HTMLElement;
const zoomRange = document.getElementById("zoom-range") as HTMLInputElement;
const zoomValue = document.getElementById("zoom-value") as HTMLElement;
const zoomMode = document.getElementById("zoom-mode") as HTMLElement;
const zoomMinus = document.getElementById("zoom-minus") as HTMLButtonElement;
const zoomPlus = document.getElementById("zoom-plus") as HTMLButtonElement;
const result = document.getElementById("result") as HTMLElement;
const ssidEl = document.getElementById("ssid")!;
const passwordEl = document.getElementById("password")!;
const copyButton = document.getElementById("copy") as HTMLButtonElement;
const openButton = document.getElementById("open") as HTMLButtonElement;

let stream: MediaStream | null = null;
let worker: Worker | null = null;
let frameId = 0;
let busy = false;
let captureGen = 0;
let scanInFlight = false;
let cameraZoom: CameraZoomController | null = null;

startButton.onclick = () => {
  if (stream) stop();
  else void start();
};

copyButton.onclick = async () => {
  try {
    await navigator.clipboard.writeText(passwordEl.textContent ?? "");
    copyButton.textContent = "Copied ✓";
    window.setTimeout(() => (copyButton.textContent = "Copy password"), 1600);
  } catch {
    status.textContent = "Select and copy the password above.";
  }
};

openButton.onclick = () => {
  window.location.href = "http://192.168.4.1/browse";
};

async function start() {
  if (scanInFlight) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = "Camera access needs HTTPS or the installed home-screen app.";
    return;
  }
  scanInFlight = true;
  startButton.disabled = true;
  status.textContent = "Requesting camera…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
    });
    worker = new Worker(new URL("../receive/worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      busy = false;
      const bytes = (event.data as { id: number; bytes: Uint8Array | null }).bytes;
      if (bytes) onDecoded(bytes);
    };
    worker.onerror = () => {
      busy = false;
      status.textContent = "The QR decoder stopped. Tap scan to try again.";
      stop();
    };
    preview.hidden = false;
    result.hidden = true;
    startButton.textContent = "Stop scanning";
    startButton.disabled = false;
    status.textContent = "Aim at the beacon’s bright QR code…";
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("No camera track was returned");
    cameraZoom = attachCameraZoom(track, video, {
      controls: zoomControls,
      range: zoomRange,
      value: zoomValue,
      mode: zoomMode,
      minus: zoomMinus,
      plus: zoomPlus,
    });
    captureGen++;
    scheduleFrame(captureGen);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    status.textContent = `Camera unavailable: ${error instanceof Error ? error.message : String(error)}`;
    startButton.textContent = "Scan beacon";
  } finally {
    scanInFlight = false;
    startButton.disabled = false;
  }
}

function stop() {
  captureGen++;
  cameraZoom?.destroy();
  cameraZoom = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  worker?.terminate();
  worker = null;
  busy = false;
  preview.hidden = true;
  startButton.textContent = "Scan beacon";
  status.textContent = "Camera is off.";
}

type VideoRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
};

function scheduleFrame(gen: number) {
  if (!stream || gen !== captureGen || result.hidden === false) return;
  const next = () => {
    if (!stream || gen !== captureGen || result.hidden === false) return;
    captureFrame();
    scheduleFrame(gen);
  };
  const candidate = video as VideoRVFC;
  if (candidate.requestVideoFrameCallback) candidate.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const canvas = document.createElement("canvas");

function captureFrame() {
  if (!worker || busy || !video.videoWidth || !video.videoHeight) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  cameraZoom?.drawFrame(context, video, video.videoWidth, video.videoHeight);
  const image = context.getImageData(0, 0, video.videoWidth, video.videoHeight);
  busy = true;
  worker.postMessage({ id: frameId++, buf: image.data.buffer, w: image.width, h: image.height }, [image.data.buffer]);
}

function onDecoded(bytes: Uint8Array) {
  const payload = new TextDecoder().decode(bytes).trim();
  const beacon = parseBeaconPayload(payload);
  if (!beacon) return;
  stop();
  ssidEl.textContent = beacon.ssid;
  passwordEl.textContent = beacon.password ?? "No password";
  copyButton.hidden = !beacon.password;
  result.hidden = false;
  status.textContent = "Beacon ready. Join its Wi‑Fi, then open the local library.";
}

function parseBeaconPayload(payload: string): { ssid: string; password: string | null } | null {
  if (!payload.startsWith("WIFI:")) return null;
  const fields = new Map<string, string>();
  let key = "";
  let value = "";
  let escaped = false;
  const commit = () => {
    if (key) fields.set(key, unescapeWifi(value));
    key = "";
    value = "";
  };
  for (const char of payload.slice(5)) {
    if (escaped) {
      value += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === ":" && !key) {
      key = value;
      value = "";
    } else if (char === ";") {
      commit();
    } else {
      value += char;
    }
  }
  commit();
  const ssid = fields.get("S") ?? "";
  const password = fields.get("P") ?? "";
  const security = fields.get("T") ?? "WPA";
  if (!ssid) return null;
  if (security === "nopass") return { ssid, password: null };
  return password ? { ssid, password } : null;
}

function unescapeWifi(value: string): string {
  return value.replace(/\\([\\;,:])/g, "$1");
}

window.addEventListener("pagehide", stop);
