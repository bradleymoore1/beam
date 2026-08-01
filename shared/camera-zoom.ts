export type CameraZoomElements = {
  controls: HTMLElement;
  range: HTMLInputElement;
  value: HTMLElement;
  mode: HTMLElement;
  minus: HTMLButtonElement;
  plus: HTMLButtonElement;
};

export type CameraZoomController = {
  drawFrame: (
    context: CanvasRenderingContext2D,
    video: HTMLVideoElement,
    width: number,
    height: number,
  ) => void;
  destroy: () => void;
};

type ZoomRange = { min: number; max: number; step?: number };

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatZoom(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}×`;
}

export function attachCameraZoom(
  track: MediaStreamTrack,
  video: HTMLVideoElement,
  elements: CameraZoomElements,
): CameraZoomController {
  const capabilities = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
    zoom?: ZoomRange;
  };
  const settings = track.getSettings() as MediaTrackSettings & { zoom?: number };
  const nativeRange = capabilities.zoom;
  let native = Boolean(nativeRange && nativeRange.max > nativeRange.min);
  let min = native ? numberOr(nativeRange?.min, 1) : 1;
  let max = native ? numberOr(nativeRange?.max, 1) : 4;
  let step = native ? numberOr(nativeRange?.step, 0.1) : 0.1;
  let current = native ? clamp(numberOr(settings.zoom, 1), min, max) : 1;
  let nativeApply = Promise.resolve();

  const configureRange = () => {
    elements.range.min = String(min);
    elements.range.max = String(max);
    elements.range.step = String(step);
    elements.range.value = String(current);
    elements.mode.textContent = native ? "camera zoom" : "digital crop";
    elements.value.textContent = formatZoom(current);
    elements.controls.hidden = false;
    elements.minus.disabled = current <= min + step / 2;
    elements.plus.disabled = current >= max - step / 2;
    video.style.transformOrigin = "center center";
    video.style.transform = native ? "" : `scale(${current})`;
  };

  const setZoom = (requested: number) => {
    current = clamp(requested, min, max);
    configureRange();
    if (!native) return;

    const wanted = current;
    nativeApply = nativeApply
      .catch(() => undefined)
      .then(async () => {
        if (!native) return;
        try {
          await track.applyConstraints({
            advanced: [{ zoom: wanted } as MediaTrackConstraintSet],
          });
        } catch {
          // Some iOS camera/browser combinations advertise zoom but reject
          // the constraint. Keep the selected magnification as a center crop
          // so the control remains useful.
          native = false;
          min = 1;
          max = 4;
          step = 0.1;
          current = clamp(wanted, min, max);
          configureRange();
        }
      });
  };

  elements.range.oninput = () => setZoom(Number(elements.range.value));
  elements.minus.onclick = () => setZoom(current - step);
  elements.plus.onclick = () => setZoom(current + step);
  configureRange();

  return {
    drawFrame(context, source, width, height) {
      if (native || current <= 1.001) {
        context.drawImage(source, 0, 0, width, height);
        return;
      }
      const sourceWidth = source.videoWidth / current;
      const sourceHeight = source.videoHeight / current;
      const sourceX = (source.videoWidth - sourceWidth) / 2;
      const sourceY = (source.videoHeight - sourceHeight) / 2;
      context.drawImage(
        source,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        width,
        height,
      );
    },
    destroy() {
      elements.range.oninput = null;
      elements.minus.onclick = null;
      elements.plus.onclick = null;
      elements.controls.hidden = true;
      video.style.transform = "";
    },
  };
}
