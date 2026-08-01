#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <DNSServer.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <qrcode.h>
#include <vector>

// Trail Beacon is intentionally a sibling firmware project. Flashing it
// replaces the app on the board, but does not touch the existing baby-girl-
// display checkout at /Users/bradleym.moore/Downloads/baby-girl-display.

namespace Board {
constexpr int LCD_DC = 4, LCD_CS = 5, LCD_CLK = 6, LCD_MOSI = 7, LCD_RST = 8;
constexpr int LCD_BL = 15, TOUCH_SCL = 10, TOUCH_SDA = 11, TOUCH_RST = 13;
constexpr int TOUCH_INT = 14, SIDE_BUTTON = 40;
constexpr int WIDTH = 240, HEIGHT = 280;
constexpr uint8_t TOUCH_ADDRESS = 0x15;
}  // namespace Board

namespace Color {
constexpr uint16_t NIGHT = 0x10A3;
constexpr uint16_t NIGHT_SOFT = 0x2148;
constexpr uint16_t PAPER = 0xFFFF;
constexpr uint16_t MINT = 0xA7F5;
constexpr uint16_t GOLD = 0xFDCB;
constexpr uint16_t CORAL = 0xFB4E;
constexpr uint16_t MUTED = 0x9B3B;
// Four bright and four dark states. Every state stays on the correct side of
// the QR luminance threshold, so the standard decoder remains a reliable
// fallback while playback visibly exercises the display's chroma channel.
constexpr uint16_t LIGHT_RGB[4] = {0xF79E, 0xFEDB, 0xDFFB, 0xDF3F};
constexpr uint16_t DARK_RGB[4] = {0x1083, 0x4003, 0x0204, 0x10AA};
}  // namespace Color

constexpr size_t MAX_FILES = 8;
constexpr size_t MAX_FILE_BYTES = 8 * 1024 * 1024;
constexpr char MANIFEST_PATH[] = "/manifest.tsv";
constexpr char TEMP_PATH[] = "/upload.tmp";
constexpr char PLAYBACK_PREFIX[] = "BEAM-FRAME-1:";
constexpr size_t FRAME_HEADER_LEN = 120;
// Keep the QR modules large enough for a phone camera on the 240px display.
// The base64 wrapper makes this smaller than the browser's monochrome frame.
constexpr size_t PLAYBACK_BLOCK_LEN = 700;
constexpr size_t PLAYBACK_BINARY_LEN = FRAME_HEADER_LEN + PLAYBACK_BLOCK_LEN;
constexpr size_t PLAYBACK_BASE64_LEN = ((PLAYBACK_BINARY_LEN + 2) / 3) * 4;
constexpr uint32_t PLAYBACK_INTERVAL_MS = 280;

Arduino_DataBus *displayBus =
    new Arduino_ESP32SPI(Board::LCD_DC, Board::LCD_CS, Board::LCD_CLK,
                         Board::LCD_MOSI);
Arduino_GFX *lcd = new Arduino_ST7789(
    displayBus, Board::LCD_RST, 0, true, Board::WIDTH, Board::HEIGHT, 0, 20, 0, 0);
Arduino_Canvas *display = new Arduino_Canvas(Board::WIDTH, Board::HEIGHT, lcd);

WebServer server(80);
DNSServer dnsServer;
Preferences preferences;

struct BeaconFile {
  uint32_t id = 0;
  size_t size = 0;
  String name;
  String mime;
};

BeaconFile files[MAX_FILES];
size_t fileCount = 0;
uint32_t nextFileId = 1;
String apSsid;
String apPassword;
bool apOpen = true;

fs::File uploadFile;
String uploadName;
String uploadMime;
uint32_t uploadId = 0;
size_t uploadedBytes = 0;
bool uploadRejected = false;
bool uploadOk = false;
String uploadError;

bool screenDirty = true;
bool stationWasPresent = false;

fs::File playbackFile;
String playbackName;
uint32_t playbackFileId = 0;
uint32_t playbackSize = 0;
uint32_t playbackFnv = 0;
uint32_t playbackK = 1;
uint16_t playbackSessionId = 0;
uint32_t playbackSeq = 0;
uint32_t playbackNextAt = 0;
bool playbackActive = false;
std::vector<double> playbackCdf;
std::vector<uint32_t> playbackIndices;
std::vector<uint32_t> playbackScratch;
uint8_t playbackSource[PLAYBACK_BLOCK_LEN] = {};
uint8_t playbackBlock[PLAYBACK_BLOCK_LEN] = {};
uint8_t playbackFrame[PLAYBACK_BINARY_LEN] = {};
char playbackQrPayload[sizeof(PLAYBACK_PREFIX) - 1 + PLAYBACK_BASE64_LEN + 1] = {};
int lastQrTotal = 0;

void startPlayback(uint32_t id);
void stopPlayback();

struct TouchState {
  bool active = false;
  uint16_t startX = 0;
  uint16_t startY = 0;
  uint16_t lastX = 0;
  uint16_t lastY = 0;
  uint32_t startedAt = 0;
  uint32_t lastReadAt = 0;
};

TouchState touch;
bool touchReady = false;

struct ButtonState {
  bool rawPressed = false;
  bool stablePressed = false;
  uint32_t changedAt = 0;
};

ButtonState sideButton;

const char UPLOAD_HTML[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Trail Beacon · Upload</title>
<style>
:root{color-scheme:dark;--bg:#081b1b;--panel:#102d2b;--line:#28504a;--text:#f4f0d4;--muted:#a9c4b5;--mint:#a7f5d9;--gold:#f9cd70}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 90% 0,#1d4b3d 0,#081b1b 44rem);color:var(--text);font:16px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(720px,100%);margin:0 auto;padding:28px 18px 56px}.eyebrow{color:var(--mint);font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.hero{display:flex;justify-content:space-between;gap:20px;align-items:end;margin:8px 0 22px}h1{font:800 clamp(34px,9vw,66px)/.95 Georgia,serif;letter-spacing:-.06em;margin:0}h2{font-size:19px;margin:0 0 12px}p{margin:0;color:var(--muted)}.panel{background:color-mix(in srgb,var(--panel) 90%,transparent);border:1px solid var(--line);border-radius:22px;padding:18px;margin-top:14px;box-shadow:0 14px 40px #0002}.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px}.fact{padding:12px;border:1px solid var(--line);border-radius:14px}.fact b{display:block;color:var(--mint);font-size:18px}.fact span{display:block;color:var(--muted);font-size:12px;margin-top:2px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}button,.button{border:0;border-radius:12px;padding:12px 16px;background:var(--mint);color:#09211c;font-weight:800;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}button.secondary,.button.secondary{background:transparent;color:var(--mint);border:1px solid var(--line)}button:disabled{opacity:.5;cursor:not-allowed}.drop{display:block;border:1px dashed #619c86;border-radius:18px;padding:24px;text-align:center;background:#0b2421;margin:12px 0}.drop input{display:block;width:100%;margin-top:12px}.status{min-height:22px;color:var(--gold);margin-top:10px}.file{display:flex;align-items:center;justify-content:space-between;gap:14px;border-top:1px solid var(--line);padding:14px 0}.file:first-child{border-top:0}.file strong{display:block;overflow-wrap:anywhere}.file small{color:var(--muted)}.foot{font-size:12px;color:var(--muted);margin-top:22px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mint);word-break:break-all}@media(max-width:480px){.facts{grid-template-columns:1fr}.hero{display:block}.hero p{margin-top:10px}}
</style></head><body><main>
<div class="eyebrow">Trail Beacon · public upload</div><div class="hero"><div><h1>Pack the trail.</h1><p>Share a map, guide, or any useful file with people nearby.</p></div><div class="eyebrow">LOCAL ONLY</div></div>
<section class="panel"><h2>Beacon details</h2><p>Anyone connected to this Wi‑Fi can publish a file. There is no internet account or PIN.</p><div class="facts"><div class="fact"><b id="ssid">—</b><span>Wi‑Fi network</span></div><div class="fact"><b id="ip">192.168.4.1</b><span>library address</span></div><div class="fact"><b id="capacity">—</b><span>local storage</span></div></div></section>
<section class="panel"><h2>Add a trail file</h2><p>The beacon will start looping the uploaded file as QR video frames as soon as publishing finishes.</p><form id="upload"><label class="drop">Choose a PDF, map, image, or any useful file<input id="file" type="file" required></label><button id="uploadButton" type="submit">Publish &amp; start QR broadcast</button></form><div id="uploadStatus" class="status"></div></section>
<section class="panel"><div class="row" style="justify-content:space-between"><h2>Visitor library</h2><a class="button secondary" href="/browse">Open download page</a></div><div id="files"><p>Loading…</p></div></section>
<div class="foot">Files are stored on this beacon. Downloads work directly over its Wi‑Fi, even with no internet service.</div>
</main><script>
const $=id=>document.getElementById(id);function fmt(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB'}function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function manifest(){const r=await fetch('/api/manifest',{cache:'no-store'});if(!r.ok)throw Error('Could not read the beacon');return r.json()}
function render(d){$('ssid').textContent=d.ssid;$('capacity').textContent=fmt(d.storage.total-d.storage.used)+' free';$('ip').textContent=d.host;$('files').innerHTML=d.files.length?d.files.map(f=>`<div class="file"><div><strong>${escapeHtml(f.name)}</strong><small>${fmt(f.size)} · ${f.mime}</small></div><a class="button secondary" href="/download?id=${f.id}">Download</a></div>`).join(''):'<p>No files yet. Add the first trail guide.</p>'}
async function refresh(){try{render(await manifest())}catch(e){$('files').innerHTML='<p>'+e.message+'</p>'}}
$('upload').onsubmit=async e=>{e.preventDefault();const f=$('file').files[0];if(!f)return;$('uploadButton').disabled=true;$('uploadStatus').textContent='Publishing '+f.name+'…';const body=new FormData();body.append('file',f);try{const r=await fetch('/api/upload',{method:'POST',body});let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||('HTTP '+r.status));$('uploadStatus').textContent='Published ✓ QR broadcast started.';$('file').value='';await refresh()}catch(err){$('uploadStatus').textContent=err.message}finally{$('uploadButton').disabled=false}};refresh();
</script></body></html>)HTML";

const char BROWSE_HTML[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Trail Beacon · Library</title>
<style>
:root{color-scheme:dark;--bg:#081b1b;--panel:#102d2b;--line:#28504a;--text:#f4f0d4;--muted:#a9c4b5;--mint:#a7f5d9;--gold:#f9cd70}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 10% 0,#225140 0,#081b1b 42rem);color:var(--text);font:16px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(680px,100%);margin:0 auto;padding:32px 18px 60px}.eyebrow{color:var(--mint);font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}h1{font:800 clamp(42px,12vw,82px)/.9 Georgia,serif;letter-spacing:-.07em;margin:8px 0 12px}p{color:var(--muted)}.hero{padding-bottom:16px}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:7px 10px;color:var(--gold);font-size:12px}.card{display:flex;align-items:center;gap:16px;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:17px;margin-top:12px;text-decoration:none;color:inherit;box-shadow:0 12px 30px #0002}.icon{width:44px;height:44px;flex:0 0 44px;border-radius:14px;display:grid;place-items:center;background:#214e40;color:var(--mint);font-weight:900}.meta{min-width:0;flex:1}.name{font-weight:800;overflow-wrap:anywhere}.size{font-size:13px;color:var(--muted);margin-top:2px}.arrow{color:var(--mint);font-size:24px}.empty{border:1px dashed #619c86;border-radius:20px;padding:24px;margin-top:14px}.foot{color:var(--muted);font-size:12px;margin-top:28px}
</style></head><body><main><section class="hero"><div class="eyebrow">Offline trail library</div><h1 id="title">A small signal.</h1><p id="intro">You are connected to a local beacon. Pick what you need and keep moving.</p><span class="pill" id="network">LOCAL ONLY</span></section><section id="files"><div class="empty">Loading the library…</div></section><div class="foot">Downloads come directly from the beacon. No cellular service or internet account required.</div></main><script>
function fmt(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB'}function icon(m){if(m==='application/pdf')return'PDF';if(m.startsWith('image/'))return'IMG';return'FILE'}fetch('/api/manifest').then(r=>r.json()).then(d=>{document.title=d.device+' · Library';$('network').textContent=d.ssid+' · '+d.files.length+' FILE'+(d.files.length===1?'':'S');$('files').innerHTML=d.files.length?d.files.map(f=>`<a class="card" href="/download?id=${f.id}"><div class="icon">${icon(f.mime)}</div><div class="meta"><div class="name">${escapeHtml(f.name)}</div><div class="size">${fmt(f.size)} · tap to download</div></div><div class="arrow">›</div></a>`).join(''):'<div class="empty"><b>The beacon is ready.</b><p>No trail files have been published yet.</p></div>'}).catch(()=>{$('files').innerHTML='<div class="empty">Could not read this beacon. Rejoin its Wi‑Fi and try again.</div>'});function $(id){return document.getElementById(id)}function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
</script></body></html>)HTML";

String jsonEscape(const String &value) {
  String escaped;
  escaped.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); ++i) {
    const char c = value[i];
    if (c == '"' || c == '\\') {
      escaped += '\\';
      escaped += c;
    } else if (c == '\n') {
      escaped += F("\\n");
    } else if (c == '\r') {
      escaped += F("\\r");
    } else if (static_cast<uint8_t>(c) < 0x20) {
      escaped += '_';
    } else {
      escaped += c;
    }
  }
  return escaped;
}

String sanitizeFileName(const String &input) {
  String source = input;
  const int slash = source.lastIndexOf('/');
  const int backslash = source.lastIndexOf('\\');
  const int cut = max(slash, backslash);
  if (cut >= 0) source = source.substring(cut + 1);
  String output;
  output.reserve(72);
  for (size_t i = 0; i < source.length() && output.length() < 72; ++i) {
    const char c = source[i];
    const bool safe = isAlphaNumeric(c) || c == ' ' || c == '.' || c == '_' ||
                      c == '-' || c == '(' || c == ')';
    if (safe) output += c;
  }
  output.trim();
  while (output.startsWith(".")) output.remove(0, 1);
  return output.length() ? output : String("trail-file");
}

String mimeForName(const String &name) {
  String lower = name;
  lower.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".gpx")) return "application/gpx+xml";
  if (lower.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

String filePath(uint32_t id) {
  return String("/files/") + String(id) + ".bin";
}

int findFile(uint32_t id) {
  for (size_t i = 0; i < fileCount; ++i)
    if (files[i].id == id) return static_cast<int>(i);
  return -1;
}

bool saveManifest() {
  fs::File file = LittleFS.open(MANIFEST_PATH, "w");
  if (!file) return false;
  for (size_t i = 0; i < fileCount; ++i) {
    file.print(files[i].id);
    file.print('\t');
    file.print(files[i].size);
    file.print('\t');
    file.print(files[i].mime);
    file.print('\t');
    file.println(files[i].name);
  }
  file.close();
  return true;
}

void loadManifest() {
  fileCount = 0;
  if (!LittleFS.exists(MANIFEST_PATH)) return;
  fs::File file = LittleFS.open(MANIFEST_PATH, "r");
  if (!file) return;
  uint32_t highestId = 0;
  while (file.available() && fileCount < MAX_FILES) {
    String line = file.readStringUntil('\n');
    line.trim();
    if (!line.length()) continue;
    const int first = line.indexOf('\t');
    const int second = first < 0 ? -1 : line.indexOf('\t', first + 1);
    const int third = second < 0 ? -1 : line.indexOf('\t', second + 1);
    if (first < 1 || second < 0 || third < 0) continue;
    BeaconFile &entry = files[fileCount];
    entry.id = static_cast<uint32_t>(line.substring(0, first).toInt());
    entry.size = static_cast<size_t>(line.substring(first + 1, second).toInt());
    entry.mime = line.substring(second + 1, third);
    entry.name = sanitizeFileName(line.substring(third + 1));
    if (!entry.id || !LittleFS.exists(filePath(entry.id))) continue;
    highestId = max(highestId, entry.id);
    ++fileCount;
  }
  file.close();
  nextFileId = highestId + 1;
  if (!nextFileId) nextFileId = 1;
}

String manifestJson() {
  String body;
  body.reserve(512 + fileCount * 140);
  body += F("{\"device\":\"Trail Beacon\",\"ssid\":\"");
  body += jsonEscape(apSsid);
  body += F("\",\"host\":\"http://192.168.4.1\",\"portal\":\"http://192.168.4.1/upload\",\"storage\":{\"used\":");
  body += String(LittleFS.usedBytes());
  body += F(",\"total\":");
  body += String(LittleFS.totalBytes());
  body += F("},\"files\":[");
  for (size_t i = 0; i < fileCount; ++i) {
    if (i) body += ',';
    body += F("{\"id\":");
    body += String(files[i].id);
    body += F(",\"name\":\"");
    body += jsonEscape(files[i].name);
    body += F("\",\"size\":");
    body += String(files[i].size);
    body += F(",\"mime\":\"");
    body += jsonEscape(files[i].mime);
    body += F("\",\"url\":\"/download?id=");
    body += String(files[i].id);
    body += F("\"}");
  }
  body += F("]}");
  return body;
}

double deterministicLog(double value) {
  int exponent = 0;
  double mantissa = value;
  while (mantissa >= 1.5) {
    mantissa /= 2.0;
    ++exponent;
  }
  while (mantissa < 0.75) {
    mantissa *= 2.0;
    --exponent;
  }
  const double z = (mantissa - 1.0) / (mantissa + 1.0);
  const double z2 = z * z;
  double term = z;
  double sum = 0.0;
  for (int n = 1; n <= 21; n += 2) {
    sum += term / static_cast<double>(n);
    term *= z2;
  }
  return static_cast<double>(exponent) * 0.6931471805599453 + 2.0 * sum;
}

bool buildPlaybackCdf() {
  playbackCdf.clear();
  playbackCdf.reserve(playbackK);
  if (playbackK == 1) {
    playbackCdf.push_back(1.0);
    return true;
  }
  constexpr double solitonC = 0.1;
  constexpr double solitonDelta = 0.5;
  const double root = sqrt(static_cast<double>(playbackK));
  const double R = max(1.0, solitonC * deterministicLog(
      static_cast<double>(playbackK) / solitonDelta) * root);
  const uint32_t spike = min(
      playbackK, static_cast<uint32_t>(ceil(static_cast<double>(playbackK) / R)));
  double total = 0.0;
  for (uint32_t degree = 1; degree <= playbackK; ++degree) {
    const double rho = degree == 1
      ? 1.0 / static_cast<double>(playbackK)
      : 1.0 / (static_cast<double>(degree) * static_cast<double>(degree - 1));
    double tau = 0.0;
    if (degree < spike) {
      tau = R / (static_cast<double>(degree) * static_cast<double>(playbackK));
    } else if (degree == spike) {
      tau = (R * max(0.0, deterministicLog(R / solitonDelta))) /
        static_cast<double>(playbackK);
    }
    total += rho + tau;
    playbackCdf.push_back(total);
  }
  if (total <= 0.0) return false;
  for (double &value : playbackCdf) value /= total;
  playbackCdf.back() = 1.0;
  return true;
}

struct PlaybackRng {
  uint32_t state;

  uint32_t next() {
    state += 0x9e3779b9u;
    uint32_t value = state ^ (state >> 16);
    value = static_cast<uint32_t>(value * 0x21f0aaadu);
    value ^= value >> 15;
    value = static_cast<uint32_t>(value * 0x735a2d97u);
    value ^= value >> 15;
    return value;
  }
};

uint32_t playbackFrameSeed(uint16_t sessionId, uint32_t sequence) {
  uint32_t hash = (static_cast<uint32_t>(sessionId + 1) * 0x9e3779b1u) ^
    (sequence + 0x85ebca6bu);
  hash = static_cast<uint32_t>((hash ^ (hash >> 13)) * 0xc2b2ae35u);
  return hash ^ (hash >> 16);
}

bool choosePlaybackIndices(uint32_t sequence) {
  playbackIndices.clear();
  if (!playbackK) return false;
  PlaybackRng rng{playbackFrameSeed(playbackSessionId, sequence)};
  const double unit = static_cast<double>(rng.next()) * 2.3283064365386963e-10;
  size_t low = 0;
  size_t high = playbackCdf.size() - 1;
  while (low < high) {
    const size_t middle = (low + high) >> 1;
    if (playbackCdf[middle] >= unit) high = middle;
    else low = middle + 1;
  }
  const uint32_t degree = min(
      playbackK, static_cast<uint32_t>(low + 1));
  if (degree > (playbackK >> 3)) {
    playbackScratch.resize(playbackK);
    for (uint32_t i = 0; i < playbackK; ++i) playbackScratch[i] = i;
    playbackIndices.reserve(degree);
    for (uint32_t i = 0; i < degree; ++i) {
      const uint32_t j = i + (rng.next() % (playbackK - i));
      const uint32_t temp = playbackScratch[i];
      playbackScratch[i] = playbackScratch[j];
      playbackScratch[j] = temp;
      playbackIndices.push_back(playbackScratch[i]);
    }
    return true;
  }
  playbackIndices.reserve(degree);
  while (playbackIndices.size() < degree) {
    const uint32_t candidate = rng.next() % playbackK;
    bool duplicate = false;
    for (uint32_t chosen : playbackIndices) {
      if (chosen == candidate) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) playbackIndices.push_back(candidate);
  }
  return true;
}

uint32_t fileFnv(fs::File &file) {
  uint32_t hash = 0x811c9dc5u;
  file.seek(0);
  while (file.available()) {
    const size_t count = file.read(playbackSource, PLAYBACK_BLOCK_LEN);
    for (size_t i = 0; i < count; ++i) {
      hash ^= playbackSource[i];
      hash = static_cast<uint32_t>(hash * 0x01000193u);
    }
  }
  file.seek(0);
  return hash;
}

void writeU16(uint8_t *target, uint16_t value) {
  target[0] = static_cast<uint8_t>(value);
  target[1] = static_cast<uint8_t>(value >> 8);
}

void writeU32(uint8_t *target, uint32_t value) {
  target[0] = static_cast<uint8_t>(value);
  target[1] = static_cast<uint8_t>(value >> 8);
  target[2] = static_cast<uint8_t>(value >> 16);
  target[3] = static_cast<uint8_t>(value >> 24);
}

size_t base64Encode(const uint8_t *source, size_t length, char *target, size_t capacity) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t output = 0;
  for (size_t offset = 0; offset < length; offset += 3) {
    const size_t remaining = length - offset;
    const uint32_t value = (static_cast<uint32_t>(source[offset]) << 16) |
      ((remaining > 1 ? source[offset + 1] : 0) << 8) |
      (remaining > 2 ? source[offset + 2] : 0);
    if (output + 4 >= capacity) return 0;
    target[output++] = alphabet[(value >> 18) & 0x3f];
    target[output++] = alphabet[(value >> 12) & 0x3f];
    target[output++] = remaining > 1 ? alphabet[(value >> 6) & 0x3f] : '=';
    target[output++] = remaining > 2 ? alphabet[value & 0x3f] : '=';
  }
  target[output] = '\0';
  return output;
}

bool encodePlaybackFrame() {
  if (!playbackActive || !playbackFile) return false;
  if (!choosePlaybackIndices(playbackSeq)) return false;
  memset(playbackBlock, 0, sizeof(playbackBlock));
  for (uint32_t blockIndex : playbackIndices) {
    memset(playbackSource, 0, sizeof(playbackSource));
    playbackFile.seek(static_cast<uint32_t>(blockIndex * PLAYBACK_BLOCK_LEN));
    const size_t count = playbackFile.read(playbackSource, PLAYBACK_BLOCK_LEN);
    if (count == 0 && blockIndex * PLAYBACK_BLOCK_LEN < playbackSize) return false;
    for (size_t i = 0; i < PLAYBACK_BLOCK_LEN; ++i)
      playbackBlock[i] ^= playbackSource[i];
  }

  memset(playbackFrame, 0, sizeof(playbackFrame));
  playbackFrame[0] = 0xd1;
  playbackFrame[1] = 0x0c;
  writeU16(playbackFrame + 2, playbackSessionId);
  writeU32(playbackFrame + 4, playbackSeq);
  writeU16(playbackFrame + 8, static_cast<uint16_t>(playbackK));
  writeU16(playbackFrame + 10, PLAYBACK_BLOCK_LEN);
  writeU32(playbackFrame + 12, playbackSize);
  writeU32(playbackFrame + 16, playbackFnv);
  const size_t nameLength = min(playbackName.length(), FRAME_HEADER_LEN - 20);
  playbackName.getBytes(playbackFrame + 20, nameLength + 1);
  memcpy(playbackFrame + FRAME_HEADER_LEN, playbackBlock, PLAYBACK_BLOCK_LEN);

  const size_t prefixLength = sizeof(PLAYBACK_PREFIX) - 1;
  memcpy(playbackQrPayload, PLAYBACK_PREFIX, prefixLength);
  if (!base64Encode(playbackFrame, sizeof(playbackFrame),
                    playbackQrPayload + prefixLength,
                    sizeof(playbackQrPayload) - prefixLength)) return false;
  return true;
}

void stopPlayback() {
  playbackActive = false;
  if (playbackFile) playbackFile.close();
  playbackCdf.clear();
  playbackIndices.clear();
  playbackScratch.clear();
  playbackName = String();
  playbackFileId = 0;
  playbackSize = 0;
  playbackK = 1;
  playbackSeq = 0;
}

void startPlayback(uint32_t id) {
  stopPlayback();
  const int index = findFile(id);
  if (index < 0) return;
  playbackFile = LittleFS.open(filePath(id), "r");
  if (!playbackFile) {
    Serial.println("Playback file could not be opened");
    return;
  }
  playbackName = files[index].name;
  playbackFileId = id;
  playbackSize = files[index].size;
  playbackK = max<uint32_t>(1, (playbackSize + PLAYBACK_BLOCK_LEN - 1) / PLAYBACK_BLOCK_LEN);
  playbackFnv = fileFnv(playbackFile);
  playbackSessionId = static_cast<uint16_t>(esp_random() & 0xffffu);
  if (!playbackSessionId) playbackSessionId = 1;
  if (!buildPlaybackCdf()) {
    Serial.println("Playback fountain distribution could not be allocated");
    stopPlayback();
    return;
  }
  playbackSeq = 0;
  playbackNextAt = 0;
  playbackActive = true;
  screenDirty = true;
  Serial.printf("Playback started: %s · %u bytes · K=%u · block=%u\n",
                playbackName.c_str(), static_cast<unsigned>(playbackSize),
                static_cast<unsigned>(playbackK),
                static_cast<unsigned>(PLAYBACK_BLOCK_LEN));
}

void sendJson(int code, const String &body) {
  server.sendHeader("Cache-Control", "no-store");
  server.send(code, "application/json; charset=utf-8", body);
}

void handleManifest() { sendJson(200, manifestJson()); }

void handleRoot() {
  server.sendHeader("Cache-Control", "no-store");
  server.send_P(200, "text/html; charset=utf-8", UPLOAD_HTML);
}

void handleBrowse() {
  server.send_P(200, "text/html; charset=utf-8", BROWSE_HTML);
}

void rejectUpload(const String &reason) {
  uploadRejected = true;
  uploadError = reason;
  if (uploadFile) uploadFile.close();
  LittleFS.remove(TEMP_PATH);
}

void handleUploadData() {
  HTTPUpload &upload = server.upload();
  if (upload.status == UPLOAD_FILE_START) {
    uploadOk = false;
    uploadRejected = false;
    uploadError = String();
    uploadedBytes = 0;
    uploadId = nextFileId;
    if (fileCount >= MAX_FILES) {
      rejectUpload("The beacon library is full");
      return;
    }
    uploadName = sanitizeFileName(upload.filename);
    uploadMime = mimeForName(uploadName);
    LittleFS.remove(TEMP_PATH);
    uploadFile = LittleFS.open(TEMP_PATH, "w");
    if (!uploadFile) rejectUpload("Could not open local storage");
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (uploadRejected || !uploadFile) return;
    if (uploadedBytes + upload.currentSize > MAX_FILE_BYTES) {
      rejectUpload("File exceeds the 8 MB beacon limit");
      return;
    }
    const size_t written = uploadFile.write(upload.buf, upload.currentSize);
    if (written != upload.currentSize) {
      rejectUpload("Local storage filled while writing");
      return;
    }
    uploadedBytes += written;
  } else if (upload.status == UPLOAD_FILE_END) {
    if (uploadRejected || !uploadFile) return;
    uploadFile.close();
    const String finalPath = filePath(uploadId);
    LittleFS.remove(finalPath);
    if (!LittleFS.rename(TEMP_PATH, finalPath)) {
      rejectUpload("Could not commit the uploaded file");
      return;
    }
    BeaconFile &entry = files[fileCount++];
    entry.id = uploadId;
    entry.size = uploadedBytes;
    entry.name = uploadName;
    entry.mime = uploadMime;
    nextFileId = uploadId + 1;
    if (!nextFileId || !saveManifest()) {
      LittleFS.remove(finalPath);
      --fileCount;
      uploadRejected = true;
      uploadError = "Could not save the file catalog";
      return;
    }
    preferences.putUInt("next-id", nextFileId);
    uploadOk = true;
  } else if (upload.status == UPLOAD_FILE_ABORTED) {
    rejectUpload("Upload was interrupted");
  }
}

void handleUploadDone() {
  if (!uploadOk) {
    sendJson(400, String(F("{\"error\":\"")) + jsonEscape(uploadError.length() ? uploadError : String("Upload failed")) + F("\"}"));
    return;
  }
  screenDirty = true;
  if (uploadOk) startPlayback(uploadId);
  sendJson(201, String(F("{\"ok\":true,\"name\":\"")) + jsonEscape(uploadName) + F("\"}"));
}

void handleDelete() {
  sendJson(405, F("{\"error\":\"File deletion is disabled on the public beacon\"}"));
}

void handleDownload() {
  const uint32_t id = static_cast<uint32_t>(server.arg("id").toInt());
  const int index = findFile(id);
  if (index < 0) {
    server.send(404, "text/plain; charset=utf-8", "File not found");
    return;
  }
  fs::File file = LittleFS.open(filePath(id), "r");
  if (!file) {
    server.send(404, "text/plain; charset=utf-8", "File not found");
    return;
  }
  server.sendHeader("Content-Disposition", String("attachment; filename=\"") + files[index].name + "\"");
  server.sendHeader("Cache-Control", "no-store");
  server.streamFile(file, files[index].mime);
  file.close();
}

bool readRegisters(uint8_t address, uint8_t reg, uint8_t *data, size_t length) {
  Wire.beginTransmission(address);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(address, static_cast<uint8_t>(length)) != length)
    return false;
  for (size_t i = 0; i < length; ++i) data[i] = Wire.read();
  return true;
}

bool initializeTouch() {
  pinMode(Board::TOUCH_INT, INPUT_PULLUP);
  pinMode(Board::TOUCH_RST, OUTPUT);
  digitalWrite(Board::TOUCH_RST, HIGH);
  delay(30);
  digitalWrite(Board::TOUCH_RST, LOW);
  delay(10);
  digitalWrite(Board::TOUCH_RST, HIGH);
  delay(180);
  uint8_t chipId = 0;
  if (!readRegisters(Board::TOUCH_ADDRESS, 0xA7, &chipId, 1)) return false;
  Serial.printf("Touch ready, chip 0x%02X\n", chipId);
  return true;
}

struct TouchPoint {
  bool active = false;
  uint16_t x = 0;
  uint16_t y = 0;
};

TouchPoint readTouch() {
  TouchPoint point;
  uint8_t packet[6] = {};
  if (!readRegisters(Board::TOUCH_ADDRESS, 0x01, packet, sizeof(packet)))
    return point;
  point.active = (packet[1] & 0x0F) > 0;
  if (point.active) {
    point.x = constrain(((packet[2] & 0x0F) << 8) | packet[3], 0,
                        Board::WIDTH - 1);
    point.y = constrain(((packet[4] & 0x0F) << 8) | packet[5], 0,
                        Board::HEIGHT - 1);
  }
  return point;
}

void updateTouch(uint32_t now) {
  if (!touchReady || now - touch.lastReadAt < 25) return;
  if (!touch.active && digitalRead(Board::TOUCH_INT) == HIGH) return;
  touch.lastReadAt = now;
  const TouchPoint point = readTouch();
  if (point.active) {
    if (!touch.active) {
      touch.active = true;
      touch.startedAt = now;
      touch.startX = touch.lastX = point.x;
      touch.startY = touch.lastY = point.y;
    } else {
      touch.lastX = point.x;
      touch.lastY = point.y;
    }
    return;
  }
  if (!touch.active) return;
  const int dx = static_cast<int>(touch.lastX) - touch.startX;
  const int dy = static_cast<int>(touch.lastY) - touch.startY;
  const uint32_t duration = now - touch.startedAt;
  touch.active = false;
  (void)duration;
  (void)dx;
  (void)dy;
}

void updateSideButton(uint32_t now) {
  const bool pressed = digitalRead(Board::SIDE_BUTTON) == LOW;
  if (pressed != sideButton.rawPressed) {
    sideButton.rawPressed = pressed;
    sideButton.changedAt = now;
  }
  if (pressed != sideButton.stablePressed && now - sideButton.changedAt >= 35) {
    sideButton.stablePressed = pressed;
  }
}

void drawCentered(const String &text, int y, uint16_t color, uint8_t size = 1) {
  display->setTextSize(size);
  display->setTextColor(color);
  const int width = text.length() * 6 * size;
  display->setCursor(max(3, (Board::WIDTH - width) / 2), y);
  display->print(text);
}

void drawQr(esp_qrcode_handle_t code) {
  const int modules = esp_qrcode_get_size(code);
  if (playbackActive) {
    // Playback frames are intentionally dense. An integer-only scale would
    // collapse them to a tiny 1px QR, as happened on the physical display.
    // Fill the usable square with nearest-neighbor module boundaries instead;
    // the resulting 1.5–2px modules preserve the payload and use the screen.
    const int total = min(Board::WIDTH, Board::HEIGHT) - 8;
    const float moduleScale = static_cast<float>(total) /
                              static_cast<float>(modules + 8);
    lastQrTotal = total;
    const int x = (Board::WIDTH - total) / 2;
    const int y = (Board::HEIGHT - total) / 2;
    display->fillRect(x, y, total, total, Color::PAPER);
    for (int row = 0; row < modules; ++row) {
      for (int column = 0; column < modules; ++column) {
        const bool dark = esp_qrcode_get_module(code, column, row);
        const size_t sampleIndex = static_cast<size_t>(row * modules + column);
        const uint8_t source = playbackFrame[sampleIndex % sizeof(playbackFrame)];
        const uint8_t shift = static_cast<uint8_t>((sampleIndex & 3u) * 2u);
        const uint8_t chroma = (source >> shift) & 3u;
        const int left = x + static_cast<int>((column + 4) * moduleScale + 0.5f);
        const int right = x + static_cast<int>((column + 5) * moduleScale + 0.5f);
        const int top = y + static_cast<int>((row + 4) * moduleScale + 0.5f);
        const int bottom = y + static_cast<int>((row + 5) * moduleScale + 0.5f);
        display->fillRect(left, top, max(1, right - left), max(1, bottom - top),
                          dark ? Color::DARK_RGB[chroma] : Color::LIGHT_RGB[chroma]);
      }
    }
    return;
  }
  const int scale = max(1, min(5, (Board::WIDTH - 16) / (modules + 8)));
  const int total = (modules + 8) * scale;
  lastQrTotal = total;
  const int x = (Board::WIDTH - total) / 2;
  const int y = 4;
  display->fillRect(x, y, total, total, Color::PAPER);
  for (int row = 0; row < modules; ++row) {
    for (int column = 0; column < modules; ++column) {
      if (esp_qrcode_get_module(code, column, row))
        display->fillRect(x + (column + 4) * scale, y + (row + 4) * scale,
                          scale, scale, Color::NIGHT);
    }
  }
}

esp_err_t drawTextQr(const char *payload, int maxVersion, int eccLevel) {
  esp_qrcode_config_t config = ESP_QRCODE_CONFIG_DEFAULT();
  config.display_func = drawQr;
  config.max_qrcode_version = maxVersion;
  config.qrcode_ecc_level = eccLevel;
  return esp_qrcode_generate(&config, payload);
}

void drawJoinScreen() {
  display->fillScreen(Color::NIGHT);
  char payload[140] = {};
  if (apOpen) {
    snprintf(payload, sizeof(payload), "WIFI:T:nopass;S:%s;;", apSsid.c_str());
  } else {
    snprintf(payload, sizeof(payload), "WIFI:T:WPA;S:%s;P:%s;;", apSsid.c_str(),
             apPassword.c_str());
  }
  const esp_err_t result = drawTextQr(payload, 8, ESP_QRCODE_ECC_MED);
  if (result != ESP_OK) {
    display->fillRoundRect(10, 24, 220, 150, 20, Color::PAPER);
    drawCentered("QR ERROR", 80, Color::CORAL, 2);
  }
  drawCentered("SCAN TO JOIN WI-FI", 210, Color::MINT, 1);
  drawCentered(apSsid, 228, Color::PAPER, 1);
  drawCentered("then wait for upload QR", 246, Color::MUTED, 1);
  drawCentered(String(fileCount) + (fileCount == 1 ? " FILE READY" : " FILES READY"),
               264, Color::MUTED, 1);
  display->flush();
  Serial.printf("Join QR: %s / %s\n", apSsid.c_str(), apPassword.c_str());
}

void drawPortalScreen() {
  display->fillScreen(Color::NIGHT);
  const esp_err_t result = drawTextQr("http://192.168.4.1/upload", 8, ESP_QRCODE_ECC_MED);
  if (result != ESP_OK) {
    display->fillRoundRect(10, 24, 220, 150, 20, Color::PAPER);
    drawCentered("QR ERROR", 80, Color::CORAL, 2);
  }
  drawCentered("SCAN TO UPLOAD", 210, Color::MINT, 1);
  drawCentered("192.168.4.1/upload", 228, Color::PAPER, 1);
  drawCentered("local webpage · no PIN", 246, Color::MUTED, 1);
  drawCentered(String(fileCount) + (fileCount == 1 ? " FILE READY" : " FILES READY"),
               264, Color::MUTED, 1);
  display->flush();
  Serial.println("Portal QR: http://192.168.4.1/upload");
}

void drawPlaybackScreen() {
  display->fillScreen(Color::NIGHT);
  if (!encodePlaybackFrame()) {
    display->fillRoundRect(10, 24, 220, 150, 20, Color::PAPER);
    drawCentered("FRAME ERROR", 80, Color::CORAL, 2);
    display->flush();
    return;
  }
  const esp_err_t result = drawTextQr(playbackQrPayload, 30, ESP_QRCODE_ECC_LOW);
  if (result != ESP_OK) {
    display->fillRoundRect(10, 24, 220, 150, 20, Color::PAPER);
    drawCentered("QR ERROR", 80, Color::CORAL, 2);
  } else if (lastQrTotal <= 224) {
    drawCentered("SCAN TO RECEIVE", 232, Color::MINT, 1);
    drawCentered(playbackName, 250, Color::PAPER, 1);
  }
  display->flush();
  if (playbackSeq == 0) {
    Serial.printf("Playback QR ready: payload=%u chars, QR=%d px\n",
                  static_cast<unsigned>(strlen(playbackQrPayload)), lastQrTotal);
  }
  ++playbackSeq;
}

void drawCurrentScreen() {
  if (playbackActive) {
    drawPlaybackScreen();
  } else if (WiFi.softAPgetStationNum() > 0) {
    drawPortalScreen();
  } else {
    drawJoinScreen();
  }
}

void setupWifi() {
  const uint64_t mac = ESP.getEfuseMac();
  char suffix[9] = {};
  snprintf(suffix, sizeof(suffix), "%08lX", static_cast<unsigned long>(mac & 0xffffffffULL));
  apSsid = String("TRAIL-") + String(suffix).substring(4) + String("-OPEN");
  apPassword = String("trail") + String(suffix).substring(2);
  WiFi.mode(WIFI_AP);
  WiFi.setSleep(false);
  const IPAddress ip(192, 168, 4, 1);
  const bool configOk = WiFi.softAPConfig(ip, ip, IPAddress(255, 255, 255, 0));
  // ESP32 Arduino supports up to four AP stations here. Passing six can make
  // the AP configuration fail even though the rest of the beacon boots.
  const char *password = apOpen ? nullptr : apPassword.c_str();
  const bool apStarted = configOk && WiFi.softAP(apSsid.c_str(), password, 6, false, 4);
  if (!apStarted) {
    Serial.printf("SoftAP start failed (config=%s)\n", configOk ? "ok" : "failed");
    return;
  }
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  delay(200);
  Serial.printf("SoftAP ready at %s on channel 6, clients=%u\n",
                WiFi.softAPIP().toString().c_str(),
                static_cast<unsigned>(WiFi.softAPgetStationNum()));
  dnsServer.start(53, "*", WiFi.softAPIP());
}

void setupServer() {
  server.enableCORS(true);
  // The OS captive-portal mini browser is the shortest path into the beacon.
  // Make every connectivity probe and unknown GET land directly on upload.
  server.on("/", HTTP_GET, handleRoot);
  server.on("/upload", HTTP_GET, handleRoot);
  server.on("/admin", HTTP_GET, handleRoot);
  server.on("/browse", HTTP_GET, handleBrowse);
  server.on("/api/manifest", HTTP_GET, handleManifest);
  server.on("/api/upload", HTTP_POST, handleUploadDone, handleUploadData);
  server.on("/api/file", HTTP_DELETE, handleDelete);
  server.on("/download", HTTP_GET, handleDownload);
  server.on("/generate_204", HTTP_GET, handleRoot);
  server.on("/hotspot-detect.html", HTTP_GET, handleRoot);
  server.on("/connecttest.txt", HTTP_GET, handleRoot);
  server.on("/ncsi.txt", HTTP_GET, handleRoot);
  server.on("/fwlink", HTTP_GET, handleRoot);
  server.onNotFound([]() {
    if (server.method() == HTTP_GET) {
      handleRoot();
    } else {
      server.send(404, "text/plain; charset=utf-8", "Not found");
    }
  });
  server.begin();
}

void setupStorage() {
  if (!LittleFS.begin(true, "/littlefs", 10, "spiffs")) {
    Serial.println("LittleFS failed");
    return;
  }
  if (!LittleFS.exists("/files")) LittleFS.mkdir("/files");
  loadManifest();
}

void setupPreferences() {
  preferences.begin("beacon", false);
  const uint32_t storedNext = preferences.getUInt("next-id", 0);
  if (storedNext > nextFileId) nextFileId = storedNext;
}

void setup() {
  pinMode(Board::LCD_BL, OUTPUT);
  pinMode(Board::SIDE_BUTTON, INPUT_PULLUP);
  digitalWrite(Board::LCD_BL, LOW);
  Serial.begin(115200);
  delay(350);
  Serial.println("\nTrail Beacon waking...");

  Wire.begin(Board::TOUCH_SDA, Board::TOUCH_SCL, 400000);
  touchReady = initializeTouch();
  if (!display->begin(80000000)) {
    Serial.println("Display init failed");
    while (true) delay(1000);
  }
  digitalWrite(Board::LCD_BL, HIGH);

  setupStorage();
  setupPreferences();
  setupWifi();
  setupServer();
  screenDirty = true;
  Serial.printf("AP %s / %s · %u files · %u/%u bytes used · touch %s\n",
                apSsid.c_str(), apPassword.c_str(), static_cast<unsigned>(fileCount),
                static_cast<unsigned>(LittleFS.usedBytes()),
                static_cast<unsigned>(LittleFS.totalBytes()),
                touchReady ? "ready" : "missing");
  stationWasPresent = WiFi.softAPgetStationNum() > 0;
  drawCurrentScreen();
}

void loop() {
  const uint32_t now = millis();
  dnsServer.processNextRequest();
  server.handleClient();
  updateSideButton(now);
  updateTouch(now);
  const bool stationPresent = WiFi.softAPgetStationNum() > 0;
  if (stationPresent != stationWasPresent) {
    stationWasPresent = stationPresent;
    screenDirty = true;
    Serial.printf("Station %s · %u connected\n",
                  stationPresent ? "connected" : "disconnected",
                  static_cast<unsigned>(WiFi.softAPgetStationNum()));
  }
  if (playbackActive &&
      (playbackNextAt == 0 || static_cast<int32_t>(now - playbackNextAt) >= 0)) {
    playbackNextAt = now + PLAYBACK_INTERVAL_MS;
    screenDirty = true;
  }
  if (screenDirty) {
    screenDirty = false;
    drawCurrentScreen();
  }
  delay(2);
}
