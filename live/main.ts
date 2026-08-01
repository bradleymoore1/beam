import QRCode from "qrcode";
import {
  generateBeamPublisherKey,
  publisherFingerprint,
  signBeamLivePacket,
  type BeamExperienceKind,
  type BeamLiveManifest,
} from "../shared/live-protocol";

const presets: Record<BeamExperienceKind, { title: string; message: string; resource: string; bpm: number; colors: [string, string] }> = {
  festival: { title: "WE ARE THE LIGHT", message: "Hold your phone high. Your screen, vibration, and color are now one part of the performance.", resource: "Stay present · the signal needs no internet", bpm: 124, colors: ["#9cf6d7", "#806dff"] },
  conference: { title: "TAKE THE WHOLE TALK", message: "Receive the source notes, citations, and next action directly from the stage.", resource: "Session resources · offline field drop", bpm: 90, colors: ["#72d6ff", "#5b7cfa"] },
  emergency: { title: "OFFICIAL FIELD UPDATE", message: "Remain calm. Follow the signed instructions shown on your phone and help nearby people receive them.", resource: "Proceed to the marked safe area", bpm: 60, colors: ["#ffcc4d", "#ff5f57"] },
  escape: { title: "THE ROOM HAS CHOSEN YOU", message: "Every receiver gets one fragment. The room only opens when the group combines them.", resource: "Speak your fragment aloud", bpm: 72, colors: ["#d4ff74", "#7bffba"] },
  art: { title: "A SIGNAL DREAMING", message: "The same seed is growing a different view of one living artwork on every screen.", resource: "Move through the room and watch it evolve", bpm: 84, colors: ["#ff82ca", "#846dff"] },
  parade: { title: "YOU CAUGHT THIS MOMENT", message: "A signed digital keepsake is passing from the float to everyone who can see it.", resource: "Collect the signal before it moves on", bpm: 112, colors: ["#ffcb69", "#ff6b8a"] },
  assembly: { title: "PUBLIC SIGNAL", message: "This message is locally broadcast and cryptographically signed. Verify the fingerprint with the organizer.", resource: "Share the facts · protect the people", bpm: 70, colors: ["#f2f2e8", "#4ee0a8"] },
  party: { title: "THE ROOM IS A GAME", message: "Your phone will assign a role, color, and beat. Find the other people carrying your signal.", resource: "No accounts · no names · just the room", bpm: 118, colors: ["#ff72dc", "#6ae4ff"] },
};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = byId<HTMLFormElement>("studio");
const kind = byId<HTMLSelectElement>("kind");
const title = byId<HTMLInputElement>("title");
const message = byId<HTMLTextAreaElement>("message");
const resource = byId<HTMLInputElement>("resource");
const fragments = byId<HTMLInputElement>("fragments");
const bpm = byId<HTMLInputElement>("bpm");
const duration = byId<HTMLSelectElement>("duration");
const color1 = byId<HTMLInputElement>("color1");
const color2 = byId<HTMLInputElement>("color2");
const audioToggle = byId<HTMLInputElement>("audio");
const launch = byId<HTMLButtonElement>("launch");
const stop = byId<HTMLButtonElement>("stop");
const fullscreen = byId<HTMLButtonElement>("fullscreen");
const status = byId<HTMLElement>("status");
const stage = byId<HTMLElement>("stage");
const stageLabel = byId<HTMLElement>("stage-label");
const stageTitle = byId<HTMLElement>("stage-title");
const canvas = byId<HTMLCanvasElement>("code");
const packetSize = byId<HTMLElement>("packet-size");
const fingerprint = byId<HTMLElement>("fingerprint");
const preview = byId<HTMLAnchorElement>("preview");

let generation = 0;
let heartbeatTimer = 0;
let audioContext: AudioContext | null = null;
let currentManifest: BeamLiveManifest | null = null;
const keyPairPromise = generateBeamPublisherKey();

function applyPreset() {
  const preset = presets[kind.value as BeamExperienceKind];
  title.value = preset.title;
  message.value = preset.message;
  resource.value = preset.resource;
  bpm.value = String(preset.bpm);
  color1.value = preset.colors[0];
  color2.value = preset.colors[1];
  stage.style.setProperty("--c1", preset.colors[0]);
  stage.style.setProperty("--c2", preset.colors[1]);
  byId<HTMLElement>("fragments-field").classList.toggle("hidden", kind.value !== "escape");
  if (kind.value === "escape" && !fragments.value) fragments.value = "NORTH WALL | 7 · 3 · 8 · 2 | BENEATH THE RED LIGHT | TURN TOGETHER";
}

kind.onchange = applyPreset;
color1.oninput = () => stage.style.setProperty("--c1", color1.value);
color2.oninput = () => stage.style.setProperty("--c2", color2.value);
applyPreset();

form.onsubmit = (event) => {
  event.preventDefault();
  void startBroadcast();
};

stop.onclick = stopBroadcast;
fullscreen.onclick = () => void stage.requestFullscreen?.();

async function startBroadcast() {
  const gen = ++generation;
  launch.disabled = true;
  status.textContent = "Signing the first crowd packet…";
  const random = crypto.getRandomValues(new Uint32Array(2));
  const startsAt = Date.now() + 2500;
  const durationMs = Number(duration.value);
  currentManifest = {
    version: 1,
    id: `${random[0]!.toString(36)}${random[1]!.toString(36)}`,
    kind: kind.value as BeamExperienceKind,
    title: title.value,
    message: message.value,
    resource: resource.value,
    startsAt,
    durationMs,
    bpm: Number(bpm.value),
    seed: random[1]!,
    palette: [color1.value, color2.value, "#ffb667"],
    fragments: fragments.value.split("|").map((part) => part.trim()).filter(Boolean),
    relayHops: 8,
    expiresAt: startsAt + durationMs,
  };
  stageTitle.textContent = currentManifest.title;
  stageLabel.textContent = `BEAM LIVE · ${currentManifest.kind.toUpperCase()}`;
  stop.classList.remove("hidden");
  fullscreen.classList.remove("hidden");
  launch.classList.add("hidden");
  preview.classList.remove("hidden");
  const keyPair = await keyPairPromise;
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  fingerprint.textContent = `publisher ${await publisherFingerprint(publicBytes)}`;
  if (audioToggle.checked) startHeartbeat(currentManifest.bpm);
  const render = async () => {
    if (gen !== generation || !currentManifest) return;
    try {
      const packet = await signBeamLivePacket(currentManifest, keyPair);
      await QRCode.toCanvas(canvas, packet, { errorCorrectionLevel: "M", margin: 3, width: 560, color: { dark: "#07100d", light: "#ffffff" } });
      packetSize.textContent = `${packet.length} signed characters · ${currentManifest.bpm} BPM`;
      preview.href = `./audience/#${encodeURIComponent(packet)}`;
      status.textContent = "Signal live · every scan is signed and clock-synchronized.";
    } catch (error) {
      status.textContent = `Signal error: ${error instanceof Error ? error.message : String(error)}`;
    }
    window.setTimeout(() => void render(), 650);
  };
  await render();
}

function stopBroadcast() {
  generation++;
  currentManifest = null;
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = 0;
  void audioContext?.close();
  audioContext = null;
  stop.classList.add("hidden");
  fullscreen.classList.add("hidden");
  preview.classList.add("hidden");
  launch.classList.remove("hidden");
  launch.disabled = false;
  stageLabel.textContent = "BEAM LIVE · READY";
  stageTitle.textContent = "Your room is the network.";
  fingerprint.textContent = "publisher stopped";
  packetSize.textContent = "signed local broadcast";
  status.textContent = "Signal stopped.";
}

function startHeartbeat(rate: number) {
  audioContext = new AudioContext();
  const interval = 60_000 / rate;
  const beat = () => {
    if (!audioContext) return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 1320;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, audioContext.currentTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.055);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.06);
  };
  beat();
  heartbeatTimer = window.setInterval(beat, interval);
}

window.addEventListener("pagehide", stopBroadcast);

