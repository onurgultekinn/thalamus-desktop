/**
 * On-device vision (MediaPipe Tasks Vision): an object detector running
 * locally on WASM. Zero model-API calls, zero upload.
 *
 * Everything is lazy — the module, the wasm and the model load on first use,
 * so the startup bundle is untouched. The asset ships with the app under
 * public/mediapipe/, so in desktop mode nothing is fetched from the network.
 *
 * The detector's role: when it finds objects (COCO classes — person, laptop,
 * keyboard, phone…), the image is a real-world photo and the cheap tier is
 * safe. When it finds nothing, the image may still be a document/UI/diagram,
 * so the measurement-based heuristic decides. A failed detector must never
 * break attachments — callers transparently fall back to the heuristic.
 */

type Detector = import('@mediapipe/tasks-vision').ObjectDetector;

const WASM_PATH = '/mediapipe/wasm';
/** Version query keeps dev-server/proxy caches from serving stale bytes. */
const MODEL_V = 'v2';
const DETECTOR_PATH = `/mediapipe/models/object_detector.tflite?${MODEL_V}`;

let detectorPromise: Promise<Detector> | null = null;
let detectorBroken = false;
let lastError = '';

/** Last detector error, for debugging in the UI or console. */
export function lastVisionError(): string {
  return lastError;
}

export function onDeviceVisionAvailable(): boolean {
  return !detectorBroken;
}

async function getDetector(): Promise<Detector> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const tasks = await import('@mediapipe/tasks-vision');
      const fileset = await tasks.FilesetResolver.forVisionTasks(WASM_PATH);
      // Fetch + validate ourselves so a stale/cached or wrong response is
      // reported clearly instead of a cryptic wasm error.
      const res = await fetch(DETECTOR_PATH, { cache: 'no-store' });
      if (!res.ok) throw new Error(`model HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const magic = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
      if (magic !== 'TFL3') {
        throw new Error(`model file is not valid TFLite (magic "${magic || 'empty'}", ${bytes.length}B)`);
      }
      return tasks.ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: bytes },
        maxResults: 5,
        scoreThreshold: 0.4,
      });
    })();
  }
  return detectorPromise;
}

export interface OnDeviceBox {
  label: string;
  score: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OnDeviceAnalysis {
  /** True when recognizable real-world objects were found → likely a photo. */
  isPhoto: boolean;
  boxes: OnDeviceBox[];
}

/** Rejects after `ms`, leaving the underlying promise running (warm-up). */
function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${tag} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

/**
 * Runs object detection on-device. `isPhoto === true` means recognizable
 * objects were found, so the cheap detail tier is safe. Returns null when the
 * detector is broken — callers must treat null as "use the heuristic".
 *
 * Init is time-boxed: the first attach never waits for a slow wasm/model init —
 * it uses the heuristic while the detector keeps warming up in the background.
 */
export async function analyzeOnDevice(canvas: HTMLCanvasElement): Promise<OnDeviceAnalysis | null> {
  if (detectorBroken) return null;

  let detector: Detector;
  try {
    detector = await withTimeout(getDetector(), 6000, 'detector init');
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    lastError = 'detector init: ' + msg;
    (window as unknown as { __visionError?: string }).__visionError = lastError;
    if (!msg.includes('timed out')) {
      // A real error (not just a slow first init) → stop retrying.
      detectorBroken = true;
      detectorPromise = null;
    }
    return null;
  }

  const det = detector.detect(canvas);
  const boxes: OnDeviceBox[] = det.detections
    .filter((d) => d.boundingBox && d.categories[0]?.categoryName)
    .map((d) => ({
      label: d.categories[0]!.categoryName as string,
      score: d.categories[0]!.score,
      x: d.boundingBox!.originX,
      y: d.boundingBox!.originY,
      w: d.boundingBox!.width,
      h: d.boundingBox!.height,
    }))
    .sort((a, b) => b.score - a.score);

  // Confident everyday-object detections → almost certainly a photo.
  const strong = boxes.filter((b) => b.score >= 0.5);
  return { isPhoto: strong.length > 0, boxes };
}
