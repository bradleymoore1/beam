#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <DNSServer.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_system.h>
#include <qrcode.h>

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
}  // namespace Color

constexpr size_t MAX_FILES = 8;
constexpr size_t MAX_FILE_BYTES = 8 * 1024 * 1024;
constexpr uint8_t STORAGE_LAYOUT_VERSION = 2;
constexpr char MANIFEST_PATH[] = "/manifest.tsv";
constexpr char MANIFEST_TEMP_PATH[] = "/manifest.new";
constexpr char MANIFEST_BACKUP_PATH[] = "/manifest.bak";
constexpr char TEMP_PATH[] = "/upload.tmp";

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
bool latestScreenOverride = false;
uint32_t latestScreenUntil = 0;

uint8_t downloadBuffer[16 * 1024] = {};

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

volatile bool sideButtonEvent = false;
uint32_t sideButtonHandledAt = 0;

void IRAM_ATTR onSideButtonPress() { sideButtonEvent = true; }

const char UPLOAD_HTML[] PROGMEM = R"HTML(<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Trail Beacon · Upload</title>
<style>
:root{color-scheme:dark;--bg:#081b1b;--panel:#102d2b;--line:#28504a;--text:#f4f0d4;--muted:#a9c4b5;--mint:#a7f5d9;--gold:#f9cd70}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 90% 0,#1d4b3d 0,#081b1b 44rem);color:var(--text);font:16px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(720px,100%);margin:0 auto;padding:28px 18px 56px}.eyebrow{color:var(--mint);font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.hero{display:flex;justify-content:space-between;gap:20px;align-items:end;margin:8px 0 22px}h1{font:800 clamp(34px,9vw,66px)/.95 Georgia,serif;letter-spacing:-.06em;margin:0}h2{font-size:19px;margin:0 0 12px}p{margin:0;color:var(--muted)}.panel{background:color-mix(in srgb,var(--panel) 90%,transparent);border:1px solid var(--line);border-radius:22px;padding:18px;margin-top:14px;box-shadow:0 14px 40px #0002}.facts{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px}.fact{padding:12px;border:1px solid var(--line);border-radius:14px}.fact b{display:block;color:var(--mint);font-size:18px}.fact span{display:block;color:var(--muted);font-size:12px;margin-top:2px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}button,.button{border:0;border-radius:12px;padding:12px 16px;background:var(--mint);color:#09211c;font-weight:800;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}button.secondary,.button.secondary{background:transparent;color:var(--mint);border:1px solid var(--line)}button:disabled{opacity:.5;cursor:not-allowed}.drop{display:block;border:1px dashed #619c86;border-radius:18px;padding:24px;text-align:center;background:#0b2421;margin:12px 0}.drop input{display:block;width:100%;margin-top:12px}.status{min-height:22px;color:var(--gold);margin-top:10px}.file{display:flex;align-items:center;justify-content:space-between;gap:14px;border-top:1px solid var(--line);padding:14px 0}.file:first-child{border-top:0}.file strong{display:block;overflow-wrap:anywhere}.file small{color:var(--muted)}.foot{font-size:12px;color:var(--muted);margin-top:22px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--mint);word-break:break-all}@media(max-width:480px){.facts{grid-template-columns:1fr}.hero{display:block}.hero p{margin-top:10px}}
</style></head><body><main>
<div class="eyebrow">Trail Beacon · public upload</div><div class="hero"><div><h1>Pack the trail.</h1><p>Share a map, guide, or any useful file with people nearby.</p></div><div class="eyebrow">LOCAL ONLY</div></div>
<section class="panel"><h2>Beacon details</h2><p>Anyone connected to this Wi‑Fi can publish a file. There is no internet account or PIN.</p><div class="facts"><div class="fact"><b id="ssid">—</b><span>Wi‑Fi network</span></div><div class="fact"><b id="ip">192.168.4.1</b><span>library address</span></div><div class="fact"><b id="capacity">—</b><span>local storage</span></div></div></section>
<section class="panel"><h2>Publish the latest file</h2><p>A successful upload safely replaces the previous file. Visitors download it directly over this local Wi‑Fi—the fastest and most reliable path.</p><form id="upload"><label class="drop">Choose a PDF, map, image, or any useful file<input id="file" type="file" required></label><button id="uploadButton" type="submit">Publish latest file</button></form><div id="uploadStatus" class="status"></div></section>
<section class="panel"><div class="row" style="justify-content:space-between"><h2>Current trail file</h2><a class="button secondary" href="/browse">Open download page</a></div><div id="files"><p>Loading…</p></div></section>
<div class="foot">Files are stored on this beacon. Downloads work directly over its Wi‑Fi, even with no internet service.</div>
</main><script>
const $=id=>document.getElementById(id);function fmt(n){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB'}function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function manifest(){const r=await fetch('/api/manifest',{cache:'no-store'});if(!r.ok)throw Error('Could not read the beacon');return r.json()}
function render(d){$('ssid').textContent=d.ssid;$('capacity').textContent=fmt(d.storage.total-d.storage.used)+' free';$('ip').textContent=d.host;$('files').innerHTML=d.files.length?d.files.map(f=>`<div class="file"><div><strong>${escapeHtml(f.name)}</strong><small>${fmt(f.size)} · ${f.mime}</small></div><a class="button secondary" href="/download?id=${f.id}">Download</a></div>`).join(''):'<p>No files yet. Add the first trail guide.</p>'}
async function refresh(){try{render(await manifest())}catch(e){$('files').innerHTML='<p>'+e.message+'</p>'}}
$('upload').onsubmit=async e=>{e.preventDefault();const f=$('file').files[0];if(!f)return;$('uploadButton').disabled=true;$('uploadStatus').textContent='Publishing '+f.name+'…';const body=new FormData();body.append('file',f);try{const r=await fetch('/api/upload',{method:'POST',body});let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||('HTTP '+r.status));$('uploadStatus').textContent='Published ✓ Ready for fast local download.';$('file').value='';await refresh()}catch(err){$('uploadStatus').textContent=err.message}finally{$('uploadButton').disabled=false}};refresh();
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

bool saveLatestManifest(const BeaconFile &entry) {
  LittleFS.remove(MANIFEST_TEMP_PATH);
  fs::File file = LittleFS.open(MANIFEST_TEMP_PATH, "w");
  if (!file) return false;
  file.print(entry.id);
  file.print('\t');
  file.print(entry.size);
  file.print('\t');
  file.print(entry.mime);
  file.print('\t');
  file.println(entry.name);
  file.close();
  LittleFS.remove(MANIFEST_BACKUP_PATH);
  if (LittleFS.exists(MANIFEST_PATH) &&
      !LittleFS.rename(MANIFEST_PATH, MANIFEST_BACKUP_PATH)) return false;
  if (!LittleFS.rename(MANIFEST_TEMP_PATH, MANIFEST_PATH)) {
    if (LittleFS.exists(MANIFEST_BACKUP_PATH))
      LittleFS.rename(MANIFEST_BACKUP_PATH, MANIFEST_PATH);
    return false;
  }
  LittleFS.remove(MANIFEST_BACKUP_PATH);
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
    screenDirty = true;
    uploadOk = false;
    uploadRejected = false;
    uploadError = String();
    uploadedBytes = 0;
    uploadId = nextFileId;
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
    BeaconFile entry;
    entry.id = uploadId;
    entry.size = uploadedBytes;
    entry.name = uploadName;
    entry.mime = uploadMime;
    nextFileId = uploadId + 1;
    if (!nextFileId || !saveLatestManifest(entry)) {
      LittleFS.remove(finalPath);
      uploadRejected = true;
      uploadError = "Could not save the file catalog";
      return;
    }
    // This beacon intentionally keeps one authoritative file. Delete older
    // payloads only after the new payload and manifest are safely committed.
    for (size_t index = 0; index < fileCount; ++index) {
      if (files[index].id != entry.id) LittleFS.remove(filePath(files[index].id));
    }
    files[0] = entry;
    fileCount = 1;
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
  const size_t total = file.size();
  size_t start = 0;
  size_t end = total ? total - 1 : 0;
  bool partial = false;
  const String range = server.header("Range");
  if (range.startsWith("bytes=")) {
    const int dash = range.indexOf('-', 6);
    if (dash > 6) {
      start = static_cast<size_t>(strtoul(range.substring(6, dash).c_str(), nullptr, 10));
      if (dash + 1 < static_cast<int>(range.length()))
        end = static_cast<size_t>(strtoul(range.substring(dash + 1).c_str(), nullptr, 10));
      end = min(end, total ? total - 1 : 0);
      partial = start < total && start <= end;
    }
  }
  if (range.length() && !partial) {
    file.close();
    server.sendHeader("Content-Range", String("bytes */") + String(total));
    server.send(416, "text/plain; charset=utf-8", "Invalid byte range");
    return;
  }
  const size_t length = total ? end - start + 1 : 0;
  if (start) file.seek(start);
  server.sendHeader("Content-Disposition", String("attachment; filename=\"") + files[index].name + "\"");
  server.sendHeader("Accept-Ranges", "bytes");
  server.sendHeader("Cache-Control", "private, max-age=31536000, immutable");
  if (partial)
    server.sendHeader("Content-Range", String("bytes ") + String(start) + "-" + String(end) + "/" + String(total));
  server.setContentLength(length);
  server.send(partial ? 206 : 200, files[index].mime, "");
  WiFiClient client = server.client();
  size_t remaining = length;
  while (remaining && client.connected()) {
    const size_t wanted = min(remaining, sizeof(downloadBuffer));
    const size_t count = file.read(downloadBuffer, wanted);
    if (!count) break;
    size_t sent = 0;
    while (sent < count && client.connected()) {
      const size_t written = client.write(downloadBuffer + sent, count - sent);
      if (!written) break;
      sent += written;
    }
    remaining -= sent;
    if (sent != count) break;
    delay(0);
  }
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
  noInterrupts();
  const bool pressed = sideButtonEvent;
  sideButtonEvent = false;
  interrupts();
  if (!pressed || now - sideButtonHandledAt < 250) return;
  sideButtonHandledAt = now;
  if (fileCount > 0) {
    latestScreenOverride = true;
    latestScreenUntil = now + 30000;
    screenDirty = true;
    Serial.printf("Side button: showing latest file %s\n",
                  files[fileCount - 1].name.c_str());
  } else {
    screenDirty = true;
    Serial.println("Side button: no uploaded file yet");
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
  const int scale = max(1, min(5, (Board::WIDTH - 16) / (modules + 8)));
  const int total = (modules + 8) * scale;
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
  Serial.printf("Join QR: %s (open)\n", apSsid.c_str());
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

void drawLatestScreen() {
  display->fillScreen(Color::NIGHT);
  char payload[96] = {};
  snprintf(payload, sizeof(payload), "http://192.168.4.1/download?id=%lu",
           static_cast<unsigned long>(files[fileCount - 1].id));
  const esp_err_t result = drawTextQr(payload, 8, ESP_QRCODE_ECC_MED);
  if (result != ESP_OK) {
    display->fillRoundRect(10, 24, 220, 150, 20, Color::PAPER);
    drawCentered("QR ERROR", 80, Color::CORAL, 2);
  }
  drawCentered("DOWNLOAD LATEST", 210, Color::MINT, 1);
  drawCentered(files[fileCount - 1].name, 228, Color::PAPER, 1);
  drawCentered(String(files[fileCount - 1].size / 1024) + " KB · LOCAL WI-FI", 246,
               Color::MUTED, 1);
  drawCentered("fast HTTP transfer", 264, Color::GOLD, 1);
  display->flush();
  Serial.printf("Latest QR: %s\n", payload);
}

void drawCurrentScreen() {
  if (fileCount > 0 && latestScreenOverride) {
    drawLatestScreen();
  } else if (WiFi.softAPgetStationNum() == 0) {
    drawJoinScreen();
  } else if (fileCount > 0) {
    drawLatestScreen();
  } else {
    drawPortalScreen();
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
  esp_wifi_set_protocol(WIFI_IF_AP,
                        WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
  esp_wifi_set_bandwidth(WIFI_IF_AP, WIFI_BW_HT20);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  delay(200);
  Serial.printf("SoftAP ready at %s on channel 6, clients=%u\n",
                WiFi.softAPIP().toString().c_str(),
                static_cast<unsigned>(WiFi.softAPgetStationNum()));
  dnsServer.start(53, "*", WiFi.softAPIP());
}

void setupServer() {
  server.enableCORS(true);
  const char *headers[] = {"Range"};
  server.collectHeaders(headers, 1);
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

void clearStoredFiles() {
  fs::File directory = LittleFS.open("/files");
  if (directory && directory.isDirectory()) {
    fs::File entry = directory.openNextFile();
    while (entry) {
      const String path = entry.path();
      entry.close();
      if (path.length()) LittleFS.remove(path);
      entry = directory.openNextFile();
    }
    directory.close();
  }
  LittleFS.remove(TEMP_PATH);
  LittleFS.remove(MANIFEST_TEMP_PATH);
  LittleFS.remove(MANIFEST_BACKUP_PATH);
  LittleFS.remove(MANIFEST_PATH);
  fileCount = 0;
  nextFileId = 1;
  saveManifest();
  preferences.putUInt("next-id", nextFileId);
  preferences.putUChar("storage-ver", STORAGE_LAYOUT_VERSION);
  Serial.println("Storage reset: previous dummy files removed");
}

void setupStorage() {
  if (!LittleFS.begin(true, "/littlefs", 10, "spiffs")) {
    Serial.println("LittleFS failed");
    return;
  }
  if (!LittleFS.exists("/files")) LittleFS.mkdir("/files");
  loadManifest();
  if (preferences.getUChar("storage-ver", 0) != STORAGE_LAYOUT_VERSION)
    clearStoredFiles();
}

void setupPreferences() {
  preferences.begin("beacon", false);
  const uint32_t storedNext = preferences.getUInt("next-id", 0);
  if (storedNext > nextFileId) nextFileId = storedNext;
}

void setup() {
  pinMode(Board::LCD_BL, OUTPUT);
  pinMode(Board::SIDE_BUTTON, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(Board::SIDE_BUTTON), onSideButtonPress, FALLING);
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

  Serial.printf("Reset reason=%d · heap=%u/%u · largest=%u · PSRAM=%u\n",
                static_cast<int>(esp_reset_reason()),
                static_cast<unsigned>(ESP.getFreeHeap()),
                static_cast<unsigned>(ESP.getHeapSize()),
                static_cast<unsigned>(ESP.getMaxAllocHeap()),
                static_cast<unsigned>(ESP.getPsramSize()));

  setupPreferences();
  setupStorage();
  setupWifi();
  setupServer();
  screenDirty = true;
  Serial.printf("AP %s (open) · %u files · %u/%u bytes used · touch %s\n",
                apSsid.c_str(), static_cast<unsigned>(fileCount),
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
  if (latestScreenOverride && static_cast<int32_t>(now - latestScreenUntil) >= 0) {
    latestScreenOverride = false;
    screenDirty = true;
  }
  const bool stationPresent = WiFi.softAPgetStationNum() > 0;
  if (stationPresent != stationWasPresent) {
    stationWasPresent = stationPresent;
    screenDirty = true;
    Serial.printf("Station %s · %u connected\n",
                  stationPresent ? "connected" : "disconnected",
                  static_cast<unsigned>(WiFi.softAPgetStationNum()));
  }
  if (screenDirty) {
    screenDirty = false;
    drawCurrentScreen();
  }
  delay(2);
}
