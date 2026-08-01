// Frame protocol: every QR frame is fully self-describing, so there is NO
// handshake — the receiver locks onto a stream mid-flight, and a new session
// id on any frame simply starts a fresh transfer.
//
// Layout (little-endian), 20 + 100 bytes, followed by `blockLen` payload:
//   0   u8   magic 0xD1
//   1   u8   magic 0x0C
//   2   u16  sessionId   random per sender start
//   4   u32  seq         drives the fountain PRNG (see fountain.ts)
//   8   u16  k           source block count
//  10   u16  blockLen    payload bytes per frame
//  12   u32  totalLen    file length in bytes
//  16   u32  payloadFnv  FNV-1a of the whole file — verified on completion
//  20  100B  name        original file name, UTF-8, NUL-padded
//        ↓                                        ↓
//        └──────── header(120) ────────────┘  blockLen
//
// The file name rides along so ANY file type — .mov, .docx, .app, whatever —
// is saved back with its real name, not a guess from magic bytes.

export const NAME_LEN = 100;
export const HEADER_LEN = 20 + NAME_LEN;
export const MAX_K = 0xffff;
export const MAX_TOTAL_LEN = 256 * 1024 * 1024;
const MAGIC0 = 0xd1;
const MAGIC1 = 0x0c;

const nameEncoder = new TextEncoder();
const nameDecoder = new TextDecoder("utf-8", { fatal: false });
const strictNameDecoder = new TextDecoder("utf-8", { fatal: true });

export interface FrameHeader {
  sessionId: number;
  seq: number;
  k: number;
  blockLen: number;
  totalLen: number;
  payloadFnv: number;
  name: string;
}

function encodeName(name: string): Uint8Array {
  const out = new Uint8Array(NAME_LEN);
  const raw = nameEncoder.encode(name);
  let len = Math.min(NAME_LEN, raw.length);
  while (len > 0) {
    try {
      strictNameDecoder.decode(raw.subarray(0, len));
      break;
    } catch {
      len--;
    }
  }
  out.set(raw.subarray(0, len));
  return out;
}

function decodeName(raw: Uint8Array): string {
  let end = NAME_LEN;
  while (end > 0 && raw[end - 1] === 0) end--;
  return nameDecoder.decode(raw.subarray(0, end));
}

export function packFrame(h: FrameHeader, block: Uint8Array): Uint8Array {
  if (h.k < 1 || h.k > MAX_K) throw new Error("invalid source block count");
  if (h.blockLen < 1 || h.blockLen > 0xffff) throw new Error("invalid block length");
  if (h.totalLen < 0 || h.totalLen > MAX_TOTAL_LEN) throw new Error("file is too large");
  if (h.k !== Math.max(1, Math.ceil(h.totalLen / h.blockLen))) {
    throw new Error("inconsistent frame metadata");
  }
  if (block.length !== h.blockLen) throw new Error("invalid frame payload length");
  const out = new Uint8Array(HEADER_LEN + block.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MAGIC0);
  dv.setUint8(1, MAGIC1);
  dv.setUint16(2, h.sessionId, true);
  dv.setUint32(4, h.seq, true);
  dv.setUint16(8, h.k, true);
  dv.setUint16(10, h.blockLen, true);
  dv.setUint32(12, h.totalLen, true);
  dv.setUint32(16, h.payloadFnv, true);
  out.set(encodeName(h.name), 20);
  out.set(block, HEADER_LEN);
  return out;
}

export function parseFrame(
  bytes: Uint8Array,
): { header: FrameHeader; block: Uint8Array } | null {
  if (bytes.length <= HEADER_LEN) return null;
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    sessionId: dv.getUint16(2, true),
    seq: dv.getUint32(4, true),
    k: dv.getUint16(8, true),
    blockLen: dv.getUint16(10, true),
    totalLen: dv.getUint32(12, true),
    payloadFnv: dv.getUint32(16, true),
    name: decodeName(bytes.subarray(20, 20 + NAME_LEN)),
  };
  if (header.blockLen === 0 || header.totalLen > MAX_TOTAL_LEN) return null;
  if (header.k !== Math.max(1, Math.ceil(header.totalLen / header.blockLen))) return null;
  if (bytes.length !== HEADER_LEN + header.blockLen) return null;
  return { header, block: bytes.subarray(HEADER_LEN) };
}

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** splitmix32 — deterministic across JS engines (integer ops only). */
export function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}
