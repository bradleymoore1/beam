import QRCode from "qrcode";
import { LTDecoder, LTEncoder } from "../shared/fountain";
import { HEADER_LEN, fnv1a, packFrame, type FrameHeader } from "../shared/protocol";

const MAX_FILE_BYTES = 250 * 1024;
const RECOMMENDED_FILE_BYTES = 100 * 1024;
const FRAME_BYTES = 1465;
const BLOCK_LEN = FRAME_BYTES - HEADER_LEN;
const CODES_PER_PAGE = 12;

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

function plannedPacketCount(k: number): number {
  const margin = Number(redundancy.value) / 100;
  return Math.max(CODES_PER_PAGE, Math.ceil(k * (1 + margin)) + 6);
}

function updateEstimate() {
  if (!selectedFile) return;
  const k = Math.max(1, Math.ceil(selectedFile.size / BLOCK_LEN));
  const packets = plannedPacketCount(k);
  sizeEl.textContent = formatBytes(selectedFile.size);
  codesEl.textContent = packets.toLocaleString();
  pagesEl.textContent = Math.ceil(packets / CODES_PER_PAGE).toLocaleString();
  recoveryEl.textContent = `${redundancy.value}%`;
  if (selectedFile.size > RECOMMENDED_FILE_BYTES) {
    showWarning("This will work, but it is beyond the recommended paper size. Optical screen transfer will be much faster and use no paper.");
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
    const encoder = new LTEncoder(payload, BLOCK_LEN, sessionId);
    const header: FrameHeader = {
      sessionId,
      seq: 0,
      k: encoder.k,
      blockLen: BLOCK_LEN,
      totalLen: payload.length,
      payloadFnv: fnv1a(payload),
      name: selectedFile.name,
    };
    const frames: Uint8Array[] = [];
    const verifier = new LTDecoder(encoder.k, BLOCK_LEN, sessionId, payload.length);
    let target = plannedPacketCount(encoder.k);
    for (let seq = 0; seq < target || !verifier.isComplete; seq++) {
      if (seq > encoder.k * 4 + 200) throw new Error("could not construct a finite recovery set");
      const block = encoder.encode(seq);
      frames.push(packFrame({ ...header, seq }, block));
      verifier.addFrame(seq, block);
      if (seq + 1 >= target && !verifier.isComplete) target++;
    }
    renderPacket(frames, selectedFile, sha256, sessionId);
  } catch (error) {
    showWarning(error instanceof Error ? error.message : String(error));
  } finally {
    generate.disabled = false;
    generate.textContent = "Generate printable packet";
  }
}

function renderPacket(frames: Uint8Array[], file: File, hash: string, sessionId: number) {
  paperPages.replaceChildren();
  const totalPages = Math.ceil(frames.length / CODES_PER_PAGE);
  for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
    const page = document.createElement("article");
    page.className = "print-page";
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
    const start = pageIndex * CODES_PER_PAGE;
    const end = Math.min(frames.length, start + CODES_PER_PAGE);
    for (let index = start; index < end; index++) {
      const card = document.createElement("figure");
      card.className = "print-qr-card";
      card.append(renderQrSvg(frames[index]!));
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
  }
  outputTitle.textContent = file.name;
  outputMeta.textContent = `${frames.length} packets · ${totalPages} pages · SHA-256 ${hash}`;
  output.hidden = false;
  document.body.classList.add("paper-ready");
  output.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderQrSvg(bytes: Uint8Array): SVGSVGElement {
  const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
    errorCorrectionLevel: "Q",
    maskPattern: 4,
  });
  const quiet = 4;
  const size = qr.modules.size;
  const total = size + quiet * 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${total} ${total}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Beam printable QR packet");
  const background = document.createElementNS(svg.namespaceURI, "rect");
  background.setAttribute("width", String(total));
  background.setAttribute("height", String(total));
  background.setAttribute("fill", "#fff");
  let pathData = "";
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      if (qr.modules.data[row * size + column]) pathData += `M${column + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", pathData);
  path.setAttribute("fill", "#000");
  svg.append(background, path);
  return svg;
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
  document.body.classList.remove("paper-ready");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
