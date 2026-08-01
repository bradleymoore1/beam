import QRCode from "qrcode";
import { LTDecoder, LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, type FrameHeader } from "../shared/protocol";

const MAX_FILE_BYTES = 3 * 1024 * 1024;
type PrintProfileName = "reliable" | "dense";
const PRINT_PROFILES = {
  reliable: { frameBytes: 1465, codesPerPage: 12, ecc: "Q" as const, recommendedBytes: 100 * 1024 },
  dense: { frameBytes: 2300, codesPerPage: 20, ecc: "M" as const, recommendedBytes: 250 * 1024 },
};

const dropzone = document.getElementById("dropzone") as HTMLLabelElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const summary = document.getElementById("paper-summary") as HTMLElement;
const nameEl = document.getElementById("paper-name")!;
const hashEl = document.getElementById("paper-hash")!;
const sizeEl = document.getElementById("estimate-size")!;
const codesEl = document.getElementById("estimate-codes")!;
const pagesEl = document.getElementById("estimate-pages")!;
const recoveryEl = document.getElementById("estimate-recovery")!;
const redundancy = document.getElementById("redundancy") as HTMLSelectElement;
const profileSelect = document.getElementById("print-profile") as HTMLSelectElement;
const profileHint = document.getElementById("profile-hint")!;
const warning = document.getElementById("paper-warning")!;
const generate = document.getElementById("generate") as HTMLButtonElement;
const changeFile = document.getElementById("change-file") as HTMLButtonElement;
const output = document.getElementById("paper-output") as HTMLElement;
const outputTitle = document.getElementById("output-title")!;
const outputMeta = document.getElementById("output-meta")!;
const paperPages = document.getElementById("paper-pages")!;
const printNow = document.getElementById("print-now") as HTMLButtonElement;
const startOver = document.getElementById("start-over") as HTMLButtonElement;

let selectedFile: File | null = null;
let payload: Uint8Array | null = null;
let sha256 = "";
let paperObjectUrls: string[] = [];

fileInput.onchange = () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
};
dropzone.ondragover = (event) => {
  event.preventDefault();
  dropzone.classList.add("active");
};
dropzone.ondragleave = () => dropzone.classList.remove("active");
dropzone.ondrop = (event) => {
  event.preventDefault();
  dropzone.classList.remove("active");
  const file = event.dataTransfer?.files[0];
  if (file) void loadFile(file);
};
dropzone.onkeydown = (event) => {
  if (event.key === "Enter" || event.key === " ") fileInput.click();
};
redundancy.onchange = updateEstimate;
profileSelect.onchange = () => {
  syncProfileHint();
  updateEstimate();
};
changeFile.onclick = () => fileInput.click();
generate.onclick = () => void generatePacket();
printNow.onclick = () => window.print();
startOver.onclick = reset;

async function loadFile(file: File) {
  if (file.size > MAX_FILE_BYTES) {
    showWarning(`That file is ${formatBytes(file.size)}. Beam Paper is capped at ${formatBytes(MAX_FILE_BYTES)} to keep packets practical.`);
    return;
  }
  selectedFile = file;
  payload = new Uint8Array(await file.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", payload);
  sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  nameEl.textContent = file.name;
  hashEl.textContent = `SHA-256 ${sha256}`;
  dropzone.hidden = true;
  summary.hidden = false;
  warning.hidden = true;
  updateEstimate();
}

function selectedProfile() {
  return PRINT_PROFILES[profileSelect.value as PrintProfileName] ?? PRINT_PROFILES.dense;
}

function syncProfileHint() {
  profileHint.textContent = profileSelect.value === "dense"
    ? "Maximum tested density: print at Actual Size on a 300 DPI or better printer; scan in Printed sheets mode at 1920-wide."
    : "Larger modules and stronger correction for ordinary printers, folds, dirt, and difficult lighting.";
}

function plannedPacketCount(k: number, codesPerPage: number): number {
  const margin = Number(redundancy.value) / 100;
  return Math.max(codesPerPage, Math.ceil(k * (1 + margin)) + 6);
}

function updateEstimate() {
  if (!selectedFile) return;
  const profile = selectedProfile();
  const blockLen = profile.frameBytes - HEADER_LEN;
  const k = Math.max(1, Math.ceil(selectedFile.size / blockLen));
  const packets = plannedPacketCount(k, profile.codesPerPage);
  sizeEl.textContent = formatBytes(selectedFile.size);
  codesEl.textContent = packets.toLocaleString();
  pagesEl.textContent = Math.ceil(packets / profile.codesPerPage).toLocaleString();
  recoveryEl.textContent = `${redundancy.value}%`;
  if (selectedFile.size > profile.recommendedBytes) {
    showWarning(`This is a large paper transfer. The estimate is real; screen transfer will be dramatically faster and use no paper.`);
  } else {
    warning.hidden = true;
  }
}

async function generatePacket() {
  if (!selectedFile || !payload) return;
  generate.disabled = true;
  generate.textContent = "Building packet…";
  try {
    const random = crypto.getRandomValues(new Uint32Array(1));
    const sessionId = (random[0]! & 0xffff) || 1;
    const profileName = profileSelect.value as PrintProfileName;
    const profile = selectedProfile();
    const blockLen = profile.frameBytes - HEADER_LEN;
    const encoder = new LTEncoder(payload, blockLen, sessionId);
    const header: FrameHeader = {
      sessionId,
      seq: 0,
      k: encoder.k,
      blockLen,
      totalLen: payload.length,
      payloadFnv: fnv1a(payload),
      name: selectedFile.name,
    };
    const frames: Uint8Array[] = [];
    const verifier = new LTDecoder(encoder.k, blockLen, sessionId, payload.length);
    let target = plannedPacketCount(encoder.k, profile.codesPerPage);
    for (let seq = 0; seq < target || !verifier.isComplete; seq++) {
      if (seq > encoder.k * 4 + 200) throw new Error("could not construct a finite recovery set");
      const block = encoder.encode(seq);
      frames.push(packFrame({ ...header, seq }, block));
      verifier.addFrame(seq, block);
      if (seq + 1 >= target && !verifier.isComplete) target++;
    }
    await renderPacket(frames, selectedFile, sha256, sessionId, profileName);
  } catch (error) {
    showWarning(error instanceof Error ? error.message : String(error));
  } finally {
    generate.disabled = false;
    generate.textContent = "Generate printable packet";
  }
}

async function renderPacket(
  frames: Uint8Array[],
  file: File,
  hash: string,
  sessionId: number,
  profileName: PrintProfileName,
) {
  const profile = PRINT_PROFILES[profileName];
  for (const url of paperObjectUrls) URL.revokeObjectURL(url);
  paperObjectUrls = [];
  paperPages.replaceChildren();
  const totalPages = Math.ceil(frames.length / profile.codesPerPage);
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
    const page = document.createElement("article");
    page.className = `print-page print-page-${profileName}`;
    const header = document.createElement("header");
    header.className = "print-page-header";
    const identity = document.createElement("div");
    identity.innerHTML = `<strong>BEAM PAPER</strong><span></span>`;
    identity.querySelector("span")!.textContent = file.name;
    const pageNumber = document.createElement("div");
    pageNumber.className = "print-page-number";
    pageNumber.textContent = `PAGE ${pageIndex + 1} / ${totalPages}`;
    header.append(identity, pageNumber);
    const meta = document.createElement("div");
    meta.className = "print-page-meta";
    meta.textContent = `${formatBytes(file.size)} · SHA-256 ${hash.slice(0, 16)}… · packet ${sessionId.toString(16).padStart(4, "0").toUpperCase()}`;
    const grid = document.createElement("div");
    grid.className = "print-qr-grid";
    const start = pageIndex * profile.codesPerPage;
    const end = Math.min(frames.length, start + profile.codesPerPage);
    for (let index = start; index < end; index++) {
      const card = document.createElement("figure");
      card.className = "print-qr-card";
      card.append(await renderQrPng(frames[index]!, profile.ecc));
      const caption = document.createElement("figcaption");
      caption.textContent = `${index + 1} / ${frames.length}`;
      card.append(caption);
      grid.append(card);
    }
    const footer = document.createElement("footer");
    footer.className = "print-page-footer";
    footer.textContent = "Scan with Beam Receive → Printed sheets. Codes may be scanned in any order.";
    page.append(header, meta, grid, footer);
    paperPages.append(page);
    generate.textContent = `Rendering page ${pageIndex + 1} / ${totalPages}…`;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  outputTitle.textContent = file.name;
  outputMeta.textContent = `${profileName} · ${frames.length} packets · ${totalPages} pages · SHA-256 ${hash}`;
  output.hidden = false;
  document.body.classList.add("paper-ready");
  output.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function renderQrPng(bytes: Uint8Array, ecc: "M" | "Q"): Promise<HTMLImageElement> {
  const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
    errorCorrectionLevel: ecc,
    maskPattern: 4,
  });
  const quiet = 4;
  const size = qr.modules.size;
  const total = size + quiet * 2;
  const scale = ecc === "M" ? 3 : 4;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = total * scale;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (qr.modules.data[row * size + column]) {
        context.fillRect((column + quiet) * scale, (row + quiet) * scale, scale, scale);
      }
    }
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("could not render QR image")), "image/png");
  });
  const url = URL.createObjectURL(blob);
  paperObjectUrls.push(url);
  const image = new Image();
  image.src = url;
  image.alt = "Beam printable QR packet";
  image.decoding = "async";
  return image;
}

function showWarning(message: string) {
  warning.textContent = message;
  warning.hidden = false;
}

function reset() {
  selectedFile = null;
  payload = null;
  sha256 = "";
  fileInput.value = "";
  dropzone.hidden = false;
  summary.hidden = true;
  output.hidden = true;
  paperPages.replaceChildren();
  for (const url of paperObjectUrls) URL.revokeObjectURL(url);
  paperObjectUrls = [];
  document.body.classList.remove("paper-ready");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

syncProfileHint();
