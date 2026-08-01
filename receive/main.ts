// Receiver: camera → WASM QR decode in workers → fountain decoder → file.
//
// Field lessons baked in:
// - iOS treats `frameRate: {ideal: 60}` as a suggestion and delivers 30.
//   Demand `exact` first (it works at 1280-wide), fall back to `ideal`.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress must track frames COLLECTED: LT peeling back-loads its solve
//   cascade, so blocks-solved looks stalled and then teleports to done.

import { LTDecoder } from "../shared/fountain";
import { fnv1a, parseFrame, type FrameHeader } from "../shared/protocol";
import { attachCameraZoom, type CameraZoomController } from "../shared/camera-zoom";

const OVERHEAD_EST = 1.18; // expected frames ≈ K × this (robust-soliton ε)

const startBtn = document.getElementById("start") as HTMLButtonElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const stats = document.getElementById("stats")!;
const zoomControls = document.getElementById("zoom-controls") as HTMLElement;
const zoomRange = document.getElementById("zoom-range") as HTMLInputElement;
const zoomValue = document.getElementById("zoom-value") as HTMLElement;
const zoomMode = document.getElementById("zoom-mode") as HTMLElement;
const zoomMinus = document.getElementById("zoom-minus") as HTMLButtonElement;
const zoomPlus = document.getElementById("zoom-plus") as HTMLButtonElement;
const focusButton = document.getElementById("focus-camera") as HTMLButtonElement;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const result = document.getElementById("result")!;
const settings = document.getElementById("settings") as HTMLDetailsElement;
const metricsEl = document.getElementById("metrics")!;
const metric = (id: string) => document.getElementById(id)!;
const scanSourceSelect = document.getElementById("cfg-source") as HTMLSelectElement;
const captureWidthSelect = document.getElementById("cfg-width") as HTMLSelectElement;
const captureFpsSelect = document.getElementById("cfg-capfps") as HTMLSelectElement;

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let activeHeader: FrameHeader | null = null;
let sessionId = 0;
let startTs = 0;
let captureGen = 0;
let done = false;
let startInFlight = false;
let statsTimer: number | null = null;
let resultUrl: string | null = null;
let cameraZoom: CameraZoomController | null = null;
let scanMaxSymbols = 4;

type WakeLock = { release: () => Promise<void> };
let wakeLock: WakeLock | null = null;

const workers: Worker[] = [];
const busy: boolean[] = [];
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

startBtn.onclick = () => void start();
scanSourceSelect.onchange = () => {
  if (scanSourceSelect.value === "paper") {
    captureWidthSelect.value = "1920";
    captureFpsSelect.value = "30";
    stats.textContent = "paper mode — move across the sheet; codes scan in any order";
  } else {
    captureWidthSelect.value = "1280";
    captureFpsSelect.value = "60";
    stats.textContent = "point the camera at the sender's code";
  }
};

async function start() {
  if (startInFlight || stream) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    // On insecure origins the API doesn't exist AT ALL. The camera requires
    // a secure context: the app must be opened from its installed home
    // screen icon (it's served over real HTTPS, then runs fully offline).
    stats.textContent =
      "✗ camera needs a secure context — open Beam from the home screen " +
      "icon, or from the https:// page it was installed from.";
    return;
  }
  startInFlight = true;
  stopCapture();
  resetTransfer();
  const captureWidth = Number(captureWidthSelect.value);
  const captureFps = Number(captureFpsSelect.value);
  const workerCount = Number((document.getElementById("cfg-workers") as HTMLSelectElement).value);
  const scanSource = scanSourceSelect.value;
  scanMaxSymbols = scanSource === "paper" ? 12 : 4;
  startBtn.disabled = true;
  stats.textContent = "Requesting camera…";
  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: captureWidth },
    height: { ideal: Math.round((captureWidth * 3) / 4) },
  };
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps } },
      });
    }
  } catch (err) {
    startInFlight = false;
    showReady(`✗ camera: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  startInFlight = false;
  done = false;
  settings.style.display = "none";
  startBtn.style.display = "none";
  preview.style.display = "block";
  metricsEl.style.display = "grid";
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopCapture();
    startInFlight = false;
    showReady("✗ no camera track was returned");
    return;
  }
  cameraZoom = attachCameraZoom(track, video, {
    controls: zoomControls,
    range: zoomRange,
    value: zoomValue,
    mode: zoomMode,
    minus: zoomMinus,
    plus: zoomPlus,
    focus: focusButton,
  });
  stats.textContent = `camera ${stream.getVideoTracks()[0]?.getSettings().width}×${stream.getVideoTracks()[0]?.getSettings().height}@${stream.getVideoTracks()[0]?.getSettings().frameRate} — searching for a stream…`;

  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot = i;
    w.onmessage = (e: MessageEvent) => {
      const { id, bytes, frames } = e.data as {
        id: number;
        bytes?: Uint8Array | null;
        frames?: Uint8Array[];
      };
      if (id === -1) return; // warm-up
      busy[slot] = false;
      if (bytes) onDecoded(bytes);
      for (const frame of frames ?? []) {
        if (done) break;
        onDecoded(frame);
      }
    };
    w.onerror = () => {
      busy[slot] = false;
      stopCapture();
      done = false;
      showReady("✗ decoder worker stopped — restart the camera");
    };
    w.onmessageerror = () => {
      busy[slot] = false;
      stopCapture();
      done = false;
      showReady("✗ decoder worker message failed — restart the camera");
    };
    workers.push(w);
    busy.push(false);
  }

  captureGen++;
  scheduleFrame(captureGen);
  statsTimer = window.setInterval(updateStats, 500);
  try {
    const lockApi = (navigator as Navigator & {
      wakeLock?: { request(t: "screen"): Promise<WakeLock> };
    }).wakeLock;
    wakeLock = (await lockApi?.request("screen")) ?? null;
  } catch {
    wakeLock = null;
  }
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  const slot = busy.indexOf(false);
  if (slot === -1) return; // all workers busy — drop the frame, no harm done
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  cameraZoom?.drawFrame(ctx, video, vw, vh);
  const img = ctx.getImageData(0, 0, vw, vh);
  busy[slot] = true;
  workers[slot]!.postMessage(
    { id: frameId++, buf: img.data.buffer, w: vw, h: vh, maxSymbols: scanMaxSymbols },
    [img.data.buffer],
  );
}

function onDecoded(bytes: Uint8Array) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  if (!decoder || sessionId !== header.sessionId) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    activeHeader = { ...header };
    sessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = "block";
  } else if (!activeHeader || !sameTransfer(activeHeader, header)) {
    stopCapture();
    showReady("✗ inconsistent frame metadata — restart the camera");
    return;
  }
  try {
    decoder.addFrame(header.seq, block);
  } catch (err) {
    stopCapture();
    showReady(`✗ decoder: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const progress = Math.min(0.99, decoder.framesNew / (decoder.k * OVERHEAD_EST));
  bar.style.width = `${(progress * 100).toFixed(1)}%`;

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    if (!ok) {
      stopCapture();
      done = false;
      progressEl.style.display = "none";
      bar.style.width = "0%";
      showReady("✗ integrity check failed — no file was saved; try again");
      return;
    }
    finish(payload, header, ok, seconds);
  }
}

function sameTransfer(a: FrameHeader, b: FrameHeader): boolean {
  return a.sessionId === b.sessionId &&
    a.k === b.k &&
    a.blockLen === b.blockLen &&
    a.totalLen === b.totalLen &&
    a.payloadFnv === b.payloadFnv &&
    a.name === b.name;
}

function detectMime(bytes: Uint8Array): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "application/zip";
  return "application/octet-stream";
}

function guessExtension(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/gif") return "gif";
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/zip") return "zip";
  return "bin";
}

function finish(payload: Uint8Array, header: FrameHeader, hashOk: boolean, seconds: number) {
  done = true;
  stopCapture();
  preview.style.display = "none";
  bar.style.width = "100%";
  const kb = Math.round(header.totalLen / 1024);
  const rate = (header.totalLen / 1024 / seconds).toFixed(1);
  const mime = detectMime(payload);
  const name = safeFileName(
    header.name && !header.name.includes("\uFFFD") ? header.name : `received_file.${guessExtension(mime)}`,
    `received_file.${guessExtension(mime)}`,
  );
  stats.textContent = `${name} · ${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · hash ${hashOk ? "verified ✓" : "MISMATCH ✗"}`;

  navigator.vibrate?.(200);

  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Transfer Complete!";

  clearResult();
  const file = new File([payload as BlobPart], name, { type: mime });
  const url = URL.createObjectURL(file);
  resultUrl = url;

  const actions = document.createElement("div");
  actions.className = "result-actions";

  const downloadBtn = document.createElement("a");
  downloadBtn.href = url;
  downloadBtn.download = name;
  downloadBtn.className = "button";
  downloadBtn.textContent = "Download";
  downloadBtn.style.flex = "1";
  actions.append(downloadBtn);

  // iOS Safari ignores the download attribute — the share sheet is the
  // reliable "Save to Files" path on iPhone.
  let canShare = false;
  try {
    canShare = typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }) === true;
  } catch {
    canShare = false;
  }
  if (canShare) {
    const shareBtn = document.createElement("button");
    shareBtn.className = "button button-secondary";
    shareBtn.textContent = "Share / Save";
    shareBtn.style.flex = "1";
    shareBtn.onclick = () => {
      void navigator.share({ files: [file] }).catch(() => undefined);
    };
    actions.append(shareBtn);
  }

  result.append(heading, actions);

  if (file.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "received";
    img.alt = name;
    img.src = url;
    result.append(img);
  }
  showReady("Transfer complete — ready for another file");
}

function safeFileName(name: string, fallback: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, 255);
  return clean || fallback;
}

function clearResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  result.replaceChildren();
}

function resetTransfer() {
  done = false;
  decoder = null;
  activeHeader = null;
  sessionId = 0;
  startTs = 0;
  captureTimes.length = 0;
  decodeTimes.length = 0;
  progressEl.style.display = "none";
  bar.style.width = "0%";
  clearResult();
}

function stopCapture() {
  captureGen++;
  cameraZoom?.destroy();
  cameraZoom = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  while (workers.length > 0) workers.pop()?.terminate();
  busy.length = 0;
  if (statsTimer !== null) {
    window.clearInterval(statsTimer);
    statsTimer = null;
  }
  const lock = wakeLock;
  wakeLock = null;
  void lock?.release().catch(() => undefined);
}

function showReady(message?: string) {
  settings.style.display = "";
  startBtn.style.display = "";
  startBtn.disabled = false;
  startBtn.textContent = "Start camera";
  preview.style.display = "none";
  metricsEl.style.display = "none";
  if (message) stats.textContent = message;
}

window.addEventListener("pagehide", stopCapture);

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - 2000) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  metric("m-cap").textContent = (captureTimes.length / 2).toFixed(0);
  metric("m-dec").textContent = (decodeTimes.length / 2).toFixed(1);
  if (!decoder) return;
  const elapsed = (now - startTs) / 1000;
  const kbs = (decoder.framesNew * decoder.blockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed);
  metric("m-rate").textContent = `${kbs.toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent = `${Math.round(decoder.totalLen / 1024)} KB`;
}
