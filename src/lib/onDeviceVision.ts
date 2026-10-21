/**
 * On-device vision (MediaPipe Tasks Vision) — object detection on WASM.
 * Zero model-API calls, zero upload.
 *
 * Used by image attachments: if recognizable everyday objects are found, the
 * image is a real-world photo and the cheap detail tier is safe. When nothing
 * is found, the measurement heuristic decides. A failed detector must never
 * break attachments — the caller transparently falls back.
 *
 * The live-camera parts (frame loop, scene classifier, ImageNet labels) were
 * extracted to the separate camera project: thalamus_camera_ai/legacy/.
 */

type Detector = import('@mediapipe/tasks-vision').ObjectDetector;
type Fileset = Awaited<ReturnType<typeof import('@mediapipe/tasks-vision')['FilesetResolver']['forVisionTasks']>>;

const WASM_PATH = '/mediapipe/wasm';
/** Version query keeps dev-server/proxy caches from serving stale bytes. */
const MODEL_V = 'v3';
const DETECTOR_PATH = `/mediapipe/models/object_detector.tflite?${MODEL_V}`;

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

let filesetPromise: Promise<Fileset> | null = null;
let detector: Detector | null = null;
let detectorPromise: Promise<Detector | null> | null = null;
let detectorBroken = false;
let lastError = '';

/** Last detector error, for debugging in the UI or console. */
export function lastVisionError(): string {
  return lastError;
}

function noteError(tag: string, err: unknown) {
  const msg = String((err as Error)?.message || err);
  lastError = `${tag}: ${msg}`;
  (window as unknown as { __visionError?: string }).__visionError = lastError;
}

function getFileset(): Promise<Fileset> {
  if (!filesetPromise) {
    filesetPromise = (async () => {
      const tasks = await import('@mediapipe/tasks-vision');
      return tasks.FilesetResolver.forVisionTasks(WASM_PATH);
    })().catch((err) => {
      // Allow a later retry after a transient failure.
      filesetPromise = null;
      throw err;
    });
  }
  return filesetPromise;
}

/** Fetches the model and verifies the TFLite magic so a stale/HTML response is reported clearly. */
async function loadModelBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const magic = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (magic !== 'TFL3') {
    throw new Error(`model file is not valid TFLite (magic "${magic || 'empty'}", ${bytes.length}B)`);
  }
  return bytes;
}

async function createDetector(): Promise<Detector | null> {
  if (detector) return detector;
  if (detectorBroken) return null;
  if (detectorPromise) return detectorPromise;
  detectorPromise = (async () => {
    try {
      const [tasks, fileset, bytes] = await Promise.all([
        import('@mediapipe/tasks-vision'),
        getFileset(),
        loadModelBytes(DETECTOR_PATH),
      ]);
      const d = await tasks.ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: bytes },
        maxResults: 8,
        scoreThreshold: 0.35,
      });
      detector = d;
      return d;
    } catch (err) {
      detectorBroken = true;
      detectorPromise = null;
      noteError('detector', err);
      return null;
    }
  })();
  return detectorPromise;
}

function toBoxes(raw: import('@mediapipe/tasks-vision').Detection[]): OnDeviceBox[] {
  return raw
    .filter((d) => d.boundingBox && d.categories[0])
    .map((d) => ({
      label: d.categories[0]!.categoryName || `#${d.categories[0]!.index}`,
      score: d.categories[0]!.score,
      x: d.boundingBox!.originX,
      y: d.boundingBox!.originY,
      w: d.boundingBox!.width,
      h: d.boundingBox!.height,
    }))
    .sort((a, b) => b.score - a.score);
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

  let det: Detector | null;
  try {
    det = await withTimeout(createDetector(), 6000, 'detector init');
  } catch (err) {
    const msg = String((err as Error)?.message || err);
    if (!msg.includes('timed out')) noteError('detector init', err);
    return null;
  }
  if (!det) return null;

  try {
    const result = det.detect(canvas);
    const boxes = toBoxes(result.detections);
    // Confident everyday-object detections → almost certainly a photo.
    const strong = boxes.filter((b) => b.score >= 0.5);
    return { isPhoto: strong.length > 0, boxes };
  } catch (err) {
    detectorBroken = true;
    detector = null;
    noteError('detector', err);
    return null;
  }
}
