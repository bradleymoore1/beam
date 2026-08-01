# Trail Beacon firmware

This is the hardware side of Beam for the Waveshare ESP32-S3 Development Board
with the onboard 1.69-inch touch LCD. It turns the display into a small,
always-on offline library:

- the board starts an open local Wi-Fi hotspot;
- the screen first shows a standard Wi-Fi QR that phones can scan;
- after a phone joins, the screen switches to a second QR for the local upload page;
- visitors land on a local `/browse` library and download published files;
- the public `/upload` portal accepts files from anyone connected to the hotspot;
- each successful upload atomically replaces the previous trail file;
- after an upload, the display shows a standard QR that downloads the latest
  file over the local Wi-Fi link;
- pressing the physical side button toggles the latest-file QR on or off;
- a captive-portal DNS responder makes the library easy to find after joining;
- files survive normal firmware updates in the filesystem.

The board has 16 MB flash and no SD card in this hardware configuration. The
custom partition gives the app 5 MB and the local LittleFS library about 10.9
MB. The firmware currently caps the latest file at 8 MB and keeps one
published file so storage use and the public experience stay predictable. A
future SD-card hardware revision can remove that ceiling without changing the
visitor portal contract.

## Build

```sh
cd "/Users/bradleym.moore/Desktop/secure file transfer QR/firmware"
pio run
```

The connected board is identified as `/dev/cu.usbmodem21101` on this Mac. This
project uses the board's USB JTAG/OpenOCD uploader, matching the existing
Waveshare firmware project.

## Flash — deliberate action

Flashing this project replaces the app currently on the board. The existing
pregnancy display remains safe in its separate checkout at
`/Users/bradleym.moore/Downloads/baby-girl-display`, but it will no longer be
the app running on the physical board until flashed back.

After confirming that replacement is wanted:

```sh
pio run -t upload --upload-port /dev/cu.usbmodem21101
pio device monitor --port /dev/cu.usbmodem21101
```

The first boot prints the generated hotspot name. Uploads are intentionally
PIN-free for public trail use; destructive file deletion is not exposed by the
public page.

## Field workflow

1. Power the board from USB.
2. Scan the first QR to join the displayed `TRAIL-…` hotspot.
3. Wait for the board to detect the connection, then scan the second QR to
   open `http://192.168.4.1/upload`.
4. Upload a compact trail map, PDF, image, GPX file, or other useful local
   guide. No PIN or internet connection is required.
5. After the upload completes, the display shows a download QR for the latest
   file. Scan it while connected to the hotspot; the payload then moves over
   local 802.11n HTTP with resumable byte ranges instead of through the camera.
6. Press the side button to toggle the latest-file QR. It remains visible until
   the button is pressed again.

The board's captive upload/library page is intentionally standalone, so the
experience works with a normal phone camera and browser. Beam's separate
optical sender remains available for TVs, laptops, tablets, and phones where a
large, bright screen can carry a dense binary tile stream.
