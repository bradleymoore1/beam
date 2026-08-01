export const BEAM_LIVE_PREFIX = "BL1";
export const BEAM_LIVE_VERSION = 1;
export const BEAM_LIVE_MAX_PACKET = 2400;

export type BeamExperienceKind =
  | "festival"
  | "conference"
  | "emergency"
  | "escape"
  | "art"
  | "parade"
  | "assembly"
  | "party";

export interface BeamLiveManifest {
  version: 1;
  id: string;
  kind: BeamExperienceKind;
  title: string;
  message: string;
  resource: string;
  startsAt: number;
  durationMs: number;
  bpm: number;
  seed: number;
  palette: [string, string, string];
  fragments: string[];
  relayHops: number;
  expiresAt: number;
}

export interface VerifiedBeamLivePacket {
  manifest: BeamLiveManifest;
  packet: string;
  sentAt: number;
  publisherKey: string;
  fingerprint: string;
  signatureValid: true;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cryptoBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid Beam encoding");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function validHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) : "";
}

function validateManifest(value: unknown): BeamLiveManifest {
  if (!value || typeof value !== "object") throw new Error("invalid Beam experience");
  const source = value as Partial<BeamLiveManifest>;
  const kinds: BeamExperienceKind[] = ["festival", "conference", "emergency", "escape", "art", "parade", "assembly", "party"];
  if (source.version !== 1 || !kinds.includes(source.kind as BeamExperienceKind)) throw new Error("unsupported Beam experience");
  if (!Array.isArray(source.palette) || source.palette.length !== 3 || !source.palette.every(validHexColor)) throw new Error("invalid Beam palette");
  const startsAt = Number(source.startsAt);
  const expiresAt = Number(source.expiresAt);
  const durationMs = Math.min(24 * 60 * 60 * 1000, Math.max(10_000, Number(source.durationMs) || 0));
  if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(expiresAt) || expiresAt < startsAt) throw new Error("invalid Beam timing");
  return {
    version: 1,
    id: cleanText(source.id, 32),
    kind: source.kind as BeamExperienceKind,
    title: cleanText(source.title, 72),
    message: cleanText(source.message, 420),
    resource: cleanText(source.resource, 180),
    startsAt,
    durationMs,
    bpm: Math.min(240, Math.max(40, Number(source.bpm) || 120)),
    seed: Number(source.seed) >>> 0,
    palette: source.palette as [string, string, string],
    fragments: Array.isArray(source.fragments) ? source.fragments.slice(0, 12).map((item) => cleanText(item, 120)).filter(Boolean) : [],
    relayHops: Math.min(16, Math.max(0, Number(source.relayHops) || 0)),
    expiresAt,
  };
}

export async function generateBeamPublisherKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
}

export async function publisherFingerprint(publicKeyBytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", cryptoBytes(publicKeyBytes)));
  return Array.from(digest.subarray(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("").match(/.{1,4}/g)!.join("·");
}

export async function signBeamLivePacket(
  manifest: BeamLiveManifest,
  keyPair: CryptoKeyPair,
  sentAt = Date.now(),
): Promise<string> {
  const safeManifest = validateManifest(manifest);
  const manifestPart = base64Url(encoder.encode(JSON.stringify(safeManifest)));
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const publicPart = base64Url(publicBytes);
  const signed = `${BEAM_LIVE_PREFIX}.${manifestPart}.${sentAt}.${publicPart}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, encoder.encode(signed)));
  const packet = `${signed}.${base64Url(signature)}`;
  if (packet.length > BEAM_LIVE_MAX_PACKET) throw new Error(`experience is too large (${packet.length}/${BEAM_LIVE_MAX_PACKET})`);
  return packet;
}

export async function verifyBeamLivePacket(packet: string): Promise<VerifiedBeamLivePacket> {
  const trimmed = packet.trim();
  if (trimmed.length > BEAM_LIVE_MAX_PACKET) throw new Error("Beam packet is too large");
  const parts = trimmed.split(".");
  if (parts.length !== 5 || parts[0] !== BEAM_LIVE_PREFIX) throw new Error("not a Beam Live packet");
  const [, manifestPart, sentPart, publicPart, signaturePart] = parts as [string, string, string, string, string];
  const sentAt = Number(sentPart);
  if (!Number.isSafeInteger(sentAt)) throw new Error("invalid Beam timestamp");
  const publicBytes = fromBase64Url(publicPart);
  const publicKey = await crypto.subtle.importKey("spki", cryptoBytes(publicBytes), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    cryptoBytes(fromBase64Url(signaturePart)),
    encoder.encode(`${BEAM_LIVE_PREFIX}.${manifestPart}.${sentPart}.${publicPart}`),
  );
  if (!valid) throw new Error("Beam signature failed");
  const manifest = validateManifest(JSON.parse(decoder.decode(fromBase64Url(manifestPart))) as unknown);
  if (Date.now() > manifest.expiresAt + 5 * 60 * 1000) throw new Error("Beam experience expired");
  return {
    manifest,
    packet: trimmed,
    sentAt,
    publisherKey: publicPart,
    fingerprint: await publisherFingerprint(publicBytes),
    signatureValid: true,
  };
}

export function createAudienceId(): string {
  const key = "beam-audience-id";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const created = base64Url(bytes);
    localStorage.setItem(key, created);
    return created;
  } catch {
    return base64Url(crypto.getRandomValues(new Uint8Array(8)));
  }
}

export function audienceRole(manifest: BeamLiveManifest, audienceId: string, count = 8): number {
  let hash = 0x811c9dc5 ^ manifest.seed;
  const bytes = encoder.encode(`${manifest.id}:${audienceId}`);
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % Math.max(1, count);
}

export function beamElapsed(manifest: BeamLiveManifest, clockOffsetMs = 0, now = Date.now()): number {
  return Math.max(0, Math.min(manifest.durationMs, now + clockOffsetMs - manifest.startsAt));
}

export function beamPhase(manifest: BeamLiveManifest, clockOffsetMs = 0, now = Date.now()): number {
  const beatMs = 60_000 / manifest.bpm;
  return (beamElapsed(manifest, clockOffsetMs, now) / beatMs) % 1;
}
