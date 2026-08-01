export const BEACON_FRAME_PREFIX = "BEAM-FRAME-1:";

// The ESP32 QR encoder uses text mode, so it wraps the same binary Beam frame
// used by the browser sender in base64. Returning the original bytes keeps the
// existing fountain decoder and integrity checks unchanged.
export function decodeBeaconFrameText(text: string): Uint8Array | null {
  if (!text.startsWith(BEACON_FRAME_PREFIX)) return null;
  const encoded = text.slice(BEACON_FRAME_PREFIX.length);
  if (!encoded.length || encoded.length % 4 !== 0) return null;
  try {
    const decoded = atob(encoded);
    if (decoded.length < 120) return null;
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) {
      bytes[index] = decoded.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
