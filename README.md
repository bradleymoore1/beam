# Beam: light-powered file transfer and Trail Beacon

Send a file between two devices using nothing but a **screen and a camera**.
One page displays the file as an endless stream of animated QR codes; another
device points its camera at it and reconstructs the file. **No network path
between the devices, no app, no pairing, no permissions beyond the camera.**
The payload travels as light.

The repo also includes companion firmware for the Waveshare ESP32-S3 1.69″
touch display. Flashing the separate `firmware/` project turns that board into
an always-on offline Trail Beacon: one person joins its Wi-Fi and publishes a
small local library, while visitors scan the display, join the same hotspot,
and download trail maps or other useful files. The standalone visitor portal
works even without Beam, and the app has a dedicated `Scan a Trail Beacon`
route.

This is a minimal proof of concept extracted from a larger
experiment that reached **128 KB/s phone-to-phone** with denser frames,
multi-code grids, and an error-corrected color channel. This version keeps
the essential trick and can transfer arbitrary files within the selected
QR profile and browser memory limits.

<p align="center">
  <img src="docs/receiving.jpg" width="420"
       alt="Phone receiving a 238 KB image over light: 129.2 KB/s goodput, decoding the sender's animated QR code" />
</p>
<p align="center"><em>Mid-transfer: a phone pulling an image out of the air at 129 KB/s.</em></p>

## Try it

```bash
npm install
npm run dev
```

- On the **sending** device (a laptop is ideal): open
  `https://localhost:5173/send/` and it starts streaming immediately. Max
  screen brightness helps.
- On the **receiving** device (a phone): open the `Network` URL Vite prints
  (`https://<lan-ip>:5173/receive/`), accept the certificate warning once,
  tap **Start camera**, use the on-screen **Zoom** control if the phone has
  trouble focusing, and point it at the code. The control uses camera zoom
  when the browser exposes it and falls back to a center crop otherwise.
- A few seconds later: *Transfer Complete!* and the received image, verified
  by hash.
- For a hardware beacon: open `/beacon/`, scan the display, join the Wi-Fi
  shown, and tap **Open trail library**.

**Why the dev server is https-only:** the receiver uses `getUserMedia`, and
browsers remove that API entirely on insecure origins: a phone reaching
your dev server over plain http has no camera, full stop (`localhost` is
exempt, but your phone isn't localhost). That's a web platform rule, not a
choice. The dev server therefore ships with a self-signed certificate
(`@vitejs/plugin-basic-ssl`); the browser will warn on first visit. Tap
"Show Details" then "visit this website" (iOS) or "Advanced" then "Proceed"
(Android/desktop), and the page is still a secure context, so the camera
works. The odd-looking `lvh.me` hosts Vite prints are a public convenience
domain that resolves to 127.0.0.1 (same machine, nothing extra running).

Hold the phone steady, or better, prop it against something. Camera
autofocus hunting from hand tremor is the #1 throughput killer. The same Zoom
control is available in the `/beacon/` scanner.

## How it works

**The one-way channel problem.** A screen-to-camera link has no back-channel:
the receiver can't ask for retransmission, and it will inevitably miss frames
(blur, refresh straddling, autofocus). Looping the frames and hoping is
miserable: miss one frame and you wait a full cycle for it to come around.

**Fountain codes fix this completely.** The sender never sends the file's
blocks directly. Each frame is the XOR of a pseudorandom *subset* of blocks;
the subset is derived deterministically from the frame's sequence number,
with subset sizes drawn from a robust-soliton distribution ([Luby transform
coding](https://en.wikipedia.org/wiki/Luby_transform_code)). The receiver
collects **any** ~K·1.15 distinct frames, in any order, and peels the file
out of them. Dropped frames cost a little time, never correctness. Sender
and receiver frame rates don't need to match at all.

**Every frame is self-describing.** A 120-byte frame header carries the
20-byte fixed metadata plus the original filename, session id, sequence
number, block count/size, file length, and a hash. There is no handshake: the
receiver locks onto a stream mid-flight, and restarting the sender (new
session id) automatically resets the receiver.

**Decoding.** Safari has never shipped `BarcodeDetector` (WebKit bug 281848),
so decoding is [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) compiled
to WASM, running in workers fed by `requestVideoFrameCallback`. Busy workers
mean dropped frames, which the fountain happily absorbs.

## Hard-won details baked into this PoC

- **JS engines disagree about `Math.log`** (it's implementation-approximated).
  Sender and receiver must build bit-identical soliton distributions, so
  `fountain.ts` includes a deterministic log built from exactly-specified
  IEEE-754 ops. V8 vs JavaScriptCore desync is a silent, total failure mode.
- **iOS lies about camera frame rate.** `frameRate: {ideal: 60}` silently
  delivers 30; you must demand `{exact: 60}` (works at 1280-wide capture)
  and fall back. Always read back `getSettings()`.
- **`requestVideoFrameCallback` chains outlive their stream** and resume on
  the next one; without a generation counter, every stop/start leaks a
  zombie capture loop.
- **Progress bars must track frames collected, not blocks solved.** LT
  peeling back-loads its solve cascade: block-count progress looks stalled
  for most of the transfer, then teleports to 100%.
- **QR error correction is set to the minimum (L).** In-frame ECC and the
  fountain layer solve different problems (corruption vs erasure), but at
  these frame sizes level L plus frame disposal is the better trade.

## Tuning

Both pages have a collapsed **Settings** panel. On the sender: tx fps, bytes
per frame, error-correction level, and display size. Incompatible QR density
profiles are disabled automatically. Changing anything restarts the stream,
and the receiver resets automatically off the new session id. On the
receiver: capture width, capture fps, and decode worker count, applied when
the camera starts.

| setting | default | notes |
|---|---|---|
| channel | monochrome QR | **RGB tile safe/turbo** modes use small QR locators plus a calibrated color field |
| tx fps | 30 | each frame owns at least 2 refresh cycles on a 60 Hz display |
| bytes / frame | 1465 (QR v27) | denser is faster if the receiver still decodes it; 2833 total frame bytes (V40/L) works phone-to-phone at close range |

The parent experiment's measured ceiling with this exact architecture plus
denser frames, a 120 fps ProMotion sender, and stacked codes: ~128 KB/s
handheld, ~186 KB/s propped.

### Experimental color burst

The sender's **color burst** mode keeps a real V40 QR carrier underneath, so
the existing ZXing detector still finds and locks onto the frame. Each payload
module uses one of eight light colors or eight dark colors: three extra bits
per module. That is 16 physical states, not an exponential throughput gain—
the state count grows exponentially with bits, while payload grows linearly
with bits. Thirty-two calibration modules are fixed inside the carrier and
sampled by the receiver first, which compensates for the camera's white
balance and exposure. The integrity hash then rejects any frame whose color
symbols were misread, while the fountain stream supplies the missing frame
recovery.

The unused tail of the color field is filled with seeded palette symbols so
the whole data area stays chromatic instead of falling back to neutral black
and white. QR structural modules such as finder, timing, and alignment
patterns remain monochrome so the detector keeps the same geometry.

The QR-compatible profile sends **11,096 raw frame bytes** at a time (10,976
file bytes after the fixed frame header). That is about **7.6× the default
1,465-byte profile** or **3.9× the V40 monochrome profile** before camera
losses and fountain overhead. It is intentionally opt-in: use a bright,
steady display and keep the receiver close. The monochrome path remains the
compatibility and long-distance fallback.

### RGB tile video

The **RGB tile safe/turbo** modes remove the full-frame QR carrier. Four small
V3 QR symbols remain at the corners only to give ZXing the frame geometry;
the rest of the 176×176 field is calibrated RGB data. The safe profile uses
eight colors (3 bits/tile); turbo uses sixteen colors (4 bits/tile). The
receiver auto-detects the profile and reconstructs the screen with the four
locators, so moderate camera rotation and perspective do not require a fixed
phone angle.

The current turbo profile carries **12,028 raw frame bytes** (11,908 file
bytes) at 30 FPS in the ideal path; safe carries **9,018 raw bytes** (8,898
file bytes) with a wider color margin. These are optical-channel ceilings, not promises of wired
Ethernet speed: camera exposure, focus, display refresh, QR locator misses,
and fountain overhead determine real goodput.

## Trail Beacon hardware

Build the board project without touching the existing web app:

```sh
cd firmware
pio run
```

The board first shows a Wi-Fi join QR, then switches to an upload-page QR after
it detects a connected phone. The public upload page at
`http://192.168.4.1/upload` accepts a file from anyone connected to the hotspot,
with no PIN or internet required; after upload, the board continuously displays
Beam-compatible QR video frames for phone-camera recovery. It also keeps the local
`http://192.168.4.1/browse` library, storing up to eight files (8 MB each) in
internal flash. See [`firmware/README.md`](firmware/README.md) for the
deliberate flash step and field workflow. Flashing replaces the app on the
physical board; the prior display firmware remains intact in its separate
checkout at `/Users/bradleym.moore/Downloads/baby-girl-display`.

## Similar projects

The concept here was arrived at independently. It turns out
several people have had similar ideas, and their takes are all
worth a look:

- [mohankumarelec/airgapped-qr-code-transfer](https://github.com/mohankumarelec/airgapped-qr-code-transfer):
  browser-based QR file transfer with compression and sequential chunking.
  Discovered after publicly demoing this project; convergent evolution in
  action.
- [divan/txqr](https://github.com/divan/txqr) (2018): animated QR plus
  fountain codes in Go, with two excellent write-ups on why fountain coding
  beats sequential looping.
- [sz3/libcimbar](https://github.com/sz3/libcimbar): goes past QR entirely
  with a custom high-density color code purpose-built for this channel.

Built with [node-qrcode](https://github.com/soldair/node-qrcode) and
[zxing-wasm](https://github.com/Sec-ant/zxing-wasm).

## License

MIT
