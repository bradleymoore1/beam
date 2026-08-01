# Beam: light-powered file transfer and Trail Beacon

## Beam Live: a crowd operating system

Beam Live turns one stage, television, projector, artwork, float, or public
display into a signed one-to-many local broadcast. The stage studio at
`/live/` creates festival, conference, emergency, escape-room, generative-art,
parade, public-assembly, and party experiences. Audience phones receive them
at `/live/audience/`, verify an ECDSA P-256 signature, synchronize to the
publisher timestamp, derive private deterministic roles, render coordinated
color/haptic/art effects, and can optically rebroadcast the exact signed
packet to another phone.

The reusable protocol lives in `shared/live-protocol.ts`. Event apps can use
the same packet creation, verification, audience-role, clock, and phase APIs
without adopting Beam's web UI. Beam Live commands are deliberately compact:
an event app can preload heavy art and audio, while the stage broadcasts only
signed state and timing. The web demo also supports an optional audible beat
as a redundant synchronization cue.

Send a file between two devices using a **screen and a camera**. The fast web
fast mode displays four ordinary QR codes per video frame; reliable mode uses
one larger ordinary QR. Beam Paper freezes the same fountain packets into
durable, scan-any-order printed sheets. Another device points its camera at
the carrier and reconstructs the file.
**No network path between the devices, no app, and no pairing.**

The repo also includes companion firmware for the Waveshare ESP32-S3 1.69″
touch display. Flashing the separate `firmware/` project turns that board into
an always-on offline Trail Beacon: one person joins its Wi-Fi and publishes a
small local library, while visitors scan the display, join the same hotspot,
and download trail maps or other useful files. The standalone visitor portal
works even without Beam, and the app has a dedicated `Scan a Trail Beacon`
route.

This is a minimal proof of concept extracted from a larger
experiment that reached **128 KB/s phone-to-phone**. This version keeps the
essential trick, adds protected experimental carriers, and can transfer
arbitrary files within browser memory and camera-resolution limits.

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
- For a paper packet: open `/print/`, choose a file up to 3 MB, review the
  page estimate, and print. On the receiver choose **Printed sheets** before
  starting the camera; it collects multiple QRs per camera frame in any order.

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
- **QR error correction and fountain redundancy solve different problems.**
  QR ECC repairs damage inside one frame; fountain packets absorb entirely
  missing frames. Live defaults to Q for reliability, and paper uses Q because
  toner defects, folds, and imperfect focus are expected.

## Tuning

Both pages have a collapsed **Settings** panel. On the sender: tx fps, bytes
per frame, error-correction level, and display size. Incompatible QR density
profiles are disabled automatically. Changing anything restarts the stream,
and the receiver resets automatically off the new session id. On the
receiver: capture width, capture fps, and decode worker count, applied when
the camera starts.

| setting | default | notes |
|---|---|---|
| channel | standard QR | proven default; 4× stacked standard QR is the fast option |
| tx fps | 20 | aligns cleanly with common 30/60 fps phone capture and yields a 29.3 KB/s raw QR ceiling |
| bytes / frame | automatic | binary mode selects 176², 256², or 352² from screen size; 512² is available manually for 4K |

The parent experiment's measured ceiling with this exact architecture plus
denser frames, a 120 fps ProMotion sender, and stacked codes: ~128 KB/s
handheld, ~186 KB/s propped.

### Stacked standard-QR video

Fast mode renders a 2×2 grid of four independent Version 23 QR codes at ECC M.
Each code carries a different 800-byte fountain frame, so one camera exposure
can contribute up to 3,200 raw bytes. At 20 display FPS the raw ceiling is
64 KB/s before fountain overhead and dropped symbols. The receiver asks
ZXing for eight candidates so a false finder cannot consume one of the four
valid result slots. Stress tests recover all four packets after 40% temporal
frame blending and from a 360-pixel-wide composite. A fountain simulation with
only 80% of QR tiles accepted yields roughly 32–39 KB/s depending on file size.

### Custom tile research

The repository retains an unexposed research mode that removes the full-frame QR carrier. Four small Version 1 QR
symbols remain at the corners only to give the receiver reliable frame
geometry. The field scales through 176², 256², 352², and 512² profiles,
carrying one hard black/white bit per tile plus repeated calibration cells.
The profile is encoded in every locator. After the first lock, workers reuse
the geometry and skip full-frame QR discovery until motion or an integrity
failure forces reacquisition.

Every binary frame now uses interleaved extended Hamming(8,4) protection. A
local blur is spread across many codewords, each of which corrects a single
bit, instead of one bad tile invalidating tens of thousands of otherwise good
bits. Protected raw capacities are 1,628, 3,748, 7,348, and 15,908 bytes.
At 20 displayed frames per second their ceilings are about 33 KB/s, 75 KB/s,
147 KB/s, and 318 KB/s before fountain overhead and dropped frames. The 512
profile needs a 4K-class sender and 1920-wide or better camera capture; it is
manual because the default 1280-wide phone capture does not resolve it reliably.

The opt-in tricolor carrier uses calibrated red, green, and black data tiles
while keeping locator quiet zones white. It encodes actual base-3 symbols with
an interleaved ternary Hamming(13,10) code, so one bad trit per codeword is
corrected. Protected capacities are 3,865, 8,880, 17,405, and 37,665 bytes per
frame: about 77 KB/s on the phone profile at 20 FPS before fountain overhead
and dropped frames. The receiver learns the observed RGB palette from repeated
calibration patches in each frame instead of assuming ideal display colors.
These carriers are intentionally absent from the normal UI because live iPhone
tests did not produce reliable goodput; synthetic codec success is not enough.

### Beam Paper

Beam Paper offers two measured profiles. Reliable uses 1,465-byte packets at
ECC Q in a 3×4 grid. Dense uses 2,300-byte Version 40 packets at ECC M in a
4×5 grid, which is the practical maximum at roughly three 300-DPI printer dots
per QR module. A finite fountain set is simulated before rendering so the
complete printed set is known to reconstruct the original file. The default
adds 35% extra packets plus a small fixed margin. The receiver's paper profile
requests 1920-wide, 30 FPS capture and asks ZXing for up to 24 symbols per
camera frame. A full dense sheet decoded 20/20 packets at 1920-wide in the
camera harness; 1280 recovered 15/20 and 960 was not viable. Dense mode is
roughly one page for a short message, four pages for 100 KB, and 98 pages for
the 3 MB hard limit.

This deliberately chooses fewer states with much wider signal margins. A
camera must distinguish each state under autofocus, motion blur, exposure,
white balance, display PWM, compression, glare, and perspective. RGB adds
nominal bits but sharply increases frame rejection on real phones. The binary
field instead spends the camera's spatial resolution on more independent
tiles and lets the fountain layer turn undecodable frames into harmless
erasures. Use a bright large screen, keep the whole square in view, and let
the receiver's zoom control fill the camera frame.

## Trail Beacon hardware

Build the board project without touching the existing web app:

```sh
cd firmware
pio run
```

The board first shows a Wi-Fi join QR. Its captive page accepts a file from
anyone connected to the hotspot, with no PIN or internet required. After an
upload the display shows a standard latest-file QR and transfers the payload
over local 802.11n HTTP with resumable byte ranges. This is dramatically faster
and more reliable than trying to resolve thousands of optical modules on a
240×280 display. It keeps one latest file up to 5 MB in internal flash, a
limit chosen so a replacement can be committed without deleting the current
file first. See
[`firmware/README.md`](firmware/README.md) for the deliberate flash step and
field workflow.

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
