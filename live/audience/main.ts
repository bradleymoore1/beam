import QRCode from "qrcode";
import { attachCameraZoom, type CameraZoomController } from "../../shared/camera-zoom";
import {
  audienceRole,
  beamElapsed,
  beamPhase,
  createAudienceId,
  verifyBeamLivePacket,
  type BeamLiveManifest,
  type VerifiedBeamLivePacket,
} from "../../shared/live-protocol";

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const start = byId<HTMLButtonElement>("start");
const status = byId<HTMLElement>("status");
const preview = byId<HTMLElement>("preview");
const video = byId<HTMLVideoElement>("video");
const experience = byId<HTMLElement>("experience");
const art = byId<HTMLCanvasElement>("art");
const experienceKicker = byId<HTMLElement>("experience-kicker");
const experienceTitle = byId<HTMLElement>("experience-title");
const experienceMessage = byId<HTMLElement>("experience-message");
const resource = byId<HTMLElement>("experience-resource");
const role = byId<HTMLElement>("role");
const fragment = byId<HTMLElement>("fragment");
const trust = byId<HTMLElement>("trust");
const vibrate = byId<HTMLButtonElement>("vibrate");
const rebroadcast = byId<HTMLButtonElement>("rebroadcast");
const leave = byId<HTMLButtonElement>("leave");
const relay = byId<HTMLElement>("relay");
const relayCode = byId<HTMLCanvasElement>("relay-code");
const relayTitle = byId<HTMLElement>("relay-title");
const relayStatus = byId<HTMLElement>("relay-status");
const relayClose = byId<HTMLButtonElement>("relay-close");

let stream: MediaStream | null = null;
let worker: Worker | null = null;
let zoom: CameraZoomController | null = null;
let busy = false;
let captureGeneration = 0;
let frameId = 0;
let active: VerifiedBeamLivePacket | null = null;
let clockOffset = 0;
let animationFrame = 0;
let haptics = true;
let lastBeat = -1;
const audienceId = createAudienceId();

start.onclick = () => stream ? stopCamera() : void startCamera();
leave.onclick = leaveExperience;
vibrate.onclick = () => {
  haptics = !haptics;
  vibrate.textContent = haptics ? "Haptics on" : "Haptics off";
};
rebroadcast.onclick = () => void openRelay();
relayClose.onclick = () => relay.classList.add("hidden");

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    status.textContent = "Camera access requires HTTPS or the installed Beam app.";
    return;
  }
  start.disabled = true;
  status.textContent = "Requesting the rear camera…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 30 } } });
    worker = new Worker(new URL("../../receive/worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent) => {
      busy = false;
      const data = event.data as { id: number; bytes?: Uint8Array | null; frames?: Uint8Array[] };
      if (data.id === -1) return;
      if (data.bytes) void acceptBytes(data.bytes);
      for (const frame of data.frames ?? []) void acceptBytes(frame);
    };
    worker.onerror = () => {
      status.textContent = "The decoder stopped. Restart the camera.";
      stopCamera();
    };
    video.srcObject = stream;
    await video.play();
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("No camera track returned");
    zoom = attachCameraZoom(track, video, {
      controls: byId("zoom-controls"), range: byId<HTMLInputElement>("zoom-range"), value: byId("zoom-value"), mode: byId("zoom-mode"), minus: byId<HTMLButtonElement>("zoom-minus"), plus: byId<HTMLButtonElement>("zoom-plus"), focus: byId<HTMLButtonElement>("focus-camera"),
    });
    preview.classList.remove("hidden");
    start.textContent = "Stop camera";
    status.textContent = "Searching for a signed Beam Live signal…";
    captureGeneration++;
    scheduleCapture(captureGeneration);
  } catch (error) {
    stopCamera();
    status.textContent = `Camera unavailable: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    start.disabled = false;
  }
}

function stopCamera() {
  captureGeneration++;
  zoom?.destroy();
  zoom = null;
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  worker?.terminate();
  worker = null;
  busy = false;
  video.srcObject = null;
  preview.classList.add("hidden");
  start.textContent = "Start camera";
}

type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
const grab = document.createElement("canvas");

function scheduleCapture(generation: number) {
  if (!stream || generation !== captureGeneration) return;
  const next = () => {
    if (!stream || generation !== captureGeneration) return;
    captureFrame();
    scheduleCapture(generation);
  };
  const source = video as FrameVideo;
  if (source.requestVideoFrameCallback) source.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

function captureFrame() {
  if (!worker || busy || !video.videoWidth || !video.videoHeight) return;
  grab.width = video.videoWidth;
  grab.height = video.videoHeight;
  const context = grab.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  zoom?.drawFrame(context, video, grab.width, grab.height);
  const image = context.getImageData(0, 0, grab.width, grab.height);
  busy = true;
  worker.postMessage({ id: frameId++, buf: image.data.buffer, w: image.width, h: image.height, maxSymbols: 2 }, [image.data.buffer]);
}

async function acceptBytes(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes).trim();
  if (!text.startsWith("BL1.")) return;
  try {
    const verified = await verifyBeamLivePacket(text);
    clockOffset = Math.max(-30_000, Math.min(30_000, verified.sentAt - Date.now()));
    if (active?.manifest.id !== verified.manifest.id) launchExperience(verified);
    else active = verified;
  } catch (error) {
    status.textContent = `Rejected signal: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function launchExperience(packet: VerifiedBeamLivePacket) {
  active = packet;
  stopCamera();
  const manifest = packet.manifest;
  const assigned = audienceRole(manifest, audienceId, 8);
  experience.style.setProperty("--x1", manifest.palette[0]);
  experience.style.setProperty("--x2", manifest.palette[1]);
  experience.style.setProperty("--x3", manifest.palette[2]);
  experienceKicker.textContent = `BEAM ${manifest.kind.toUpperCase()} · ROLE ${assigned + 1}`;
  experienceTitle.textContent = manifest.title;
  experienceMessage.textContent = manifest.message;
  role.textContent = roleLabel(manifest, assigned);
  fragment.classList.toggle("hidden", manifest.kind !== "escape");
  fragment.textContent = manifest.fragments.length ? manifest.fragments[assigned % manifest.fragments.length]! : `FRAGMENT ${assigned + 1}`;
  resource.textContent = manifest.resource;
  trust.textContent = `SIGNATURE VERIFIED · ${packet.fingerprint}`;
  experience.classList.remove("hidden");
  drawExperience();
}

function roleLabel(manifest: BeamLiveManifest, assigned: number): string {
  const labels: Record<BeamLiveManifest["kind"], string[]> = {
    festival: ["MINT WAVE", "VIOLET WAVE", "GOLD WAVE", "BASS PULSE", "SKY WAVE", "HEARTBEAT", "STROBE-FREE GLOW", "HORIZON"],
    conference: ["SOURCE KEEPER", "QUESTION FINDER", "NOTE RELAY", "CONNECTOR", "SYNTHESIZER", "BUILDER", "CHALLENGER", "ARCHIVIST"],
    emergency: ["CHECK LEFT", "CHECK RIGHT", "ASSIST", "TRANSLATE", "WAYFIND", "FIRST AID", "RELAY", "STAY VISIBLE"],
    escape: ["FRAGMENT KEEPER", "FRAGMENT KEEPER", "FRAGMENT KEEPER", "FRAGMENT KEEPER", "FRAGMENT KEEPER", "FRAGMENT KEEPER", "FRAGMENT KEEPER", "FRAGMENT KEEPER"],
    art: ["ORBIT", "TIDE", "EMBER", "SPORE", "ECHO", "ROOT", "AURORA", "DREAM"],
    parade: ["GOLD SIGNAL", "CORAL SIGNAL", "MINT SIGNAL", "VIOLET SIGNAL", "SKY SIGNAL", "ROSE SIGNAL", "EMBER SIGNAL", "MOON SIGNAL"],
    assembly: ["WITNESS", "RELAY", "WAYFINDER", "CARE", "DOCUMENT", "VERIFY", "TRANSLATE", "SUPPORT"],
    party: ["FIND YOUR TWIN", "START A WAVE", "TRADE A STORY", "FORM A CIRCLE", "MAKE A TOAST", "CHOOSE THE NEXT SONG", "LIGHT THE ROOM", "PASS THE SIGNAL"],
  };
  return labels[manifest.kind][assigned] ?? `ROLE ${assigned + 1}`;
}

function drawExperience() {
  cancelAnimationFrame(animationFrame);
  const context = art.getContext("2d")!;
  const points = Array.from({ length: 72 }, (_, index) => ({
    x: ((Math.imul((active?.manifest.seed ?? 1) ^ index, 2654435761) >>> 0) % 10_000) / 10_000,
    y: ((Math.imul((active?.manifest.seed ?? 1) + index * 97, 2246822519) >>> 0) % 10_000) / 10_000,
    r: 1 + (index % 5),
  }));
  const paint = () => {
    if (!active || experience.classList.contains("hidden")) return;
    const manifest = active.manifest;
    const width = window.innerWidth * devicePixelRatio;
    const height = window.innerHeight * devicePixelRatio;
    if (art.width !== width || art.height !== height) { art.width = width; art.height = height; }
    const phase = beamPhase(manifest, clockOffset);
    const elapsed = beamElapsed(manifest, clockOffset);
    experience.style.setProperty("--beat", String(1 - phase));
    context.clearRect(0, 0, width, height);
    if (manifest.kind === "art" || manifest.kind === "festival" || manifest.kind === "party" || manifest.kind === "parade") {
      context.globalCompositeOperation = "screen";
      for (let index = 0; index < points.length; index++) {
        const point = points[index]!;
        const x = ((point.x + elapsed / 120_000 * (0.03 + (index % 7) / 90)) % 1) * width;
        const y = (point.y + Math.sin(elapsed / 1300 + index) * 0.025) * height;
        context.beginPath();
        context.fillStyle = manifest.palette[index % 3]! + "88";
        context.arc(x, y, point.r * devicePixelRatio * (1 + (1 - phase)), 0, Math.PI * 2);
        context.fill();
      }
    }
    const beatIndex = Math.floor(elapsed / (60_000 / manifest.bpm));
    if (haptics && beatIndex !== lastBeat && phase < 0.18) {
      lastBeat = beatIndex;
      navigator.vibrate?.(manifest.kind === "emergency" ? [80, 70, 80] : 45);
    }
    animationFrame = requestAnimationFrame(paint);
  };
  paint();
}

async function openRelay() {
  if (!active) return;
  relayTitle.textContent = active.manifest.title;
  relayStatus.textContent = `Verified publisher ${active.fingerprint} · relay allowance ${active.manifest.relayHops}`;
  await QRCode.toCanvas(relayCode, active.packet, { errorCorrectionLevel: "M", margin: 3, width: 600, color: { dark: "#07100d", light: "#ffffff" } });
  relay.classList.remove("hidden");
}

function leaveExperience() {
  active = null;
  cancelAnimationFrame(animationFrame);
  experience.classList.add("hidden");
  relay.classList.add("hidden");
  status.textContent = "Signal closed. Start the camera to receive another.";
}

async function loadPreviewPacket() {
  if (!location.hash.slice(1)) return;
  try {
    const packet = decodeURIComponent(location.hash.slice(1));
    const verified = await verifyBeamLivePacket(packet);
    clockOffset = verified.sentAt - Date.now();
    launchExperience(verified);
    history.replaceState(null, "", location.pathname + location.search);
  } catch (error) {
    status.textContent = `Preview could not open: ${error instanceof Error ? error.message : String(error)}`;
  }
}

void loadPreviewPacket();
window.addEventListener("hashchange", () => void loadPreviewPacket());
window.addEventListener("pagehide", () => { stopCamera(); cancelAnimationFrame(animationFrame); });
