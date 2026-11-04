/**
 * One attachment pipeline for every upload surface (main composer, Copilot,
 * drag&drop). It classifies a file, reads what the model can actually use and
 * keeps a preview handle for the rest — instead of each component inventing its
 * own subset of "supported" formats.
 */
import type { PreviewItem } from '../components/FilePreviewDrawer';
import {
  prepareImageFile,
  DEFAULT_IMAGE_MODE,
  type AttachedImage,
  type ImageMode,
} from './imageAttach';
import { readAttachedFiles } from './workspace';

export type AttachmentKind =
  | 'text'
  | 'image'
  | 'pdf'
  | 'office'
  | 'spreadsheet'
  | 'audio'
  | 'video'
  | 'archive'
  | 'binary'
  | 'large';

export type AttachmentStatus = 'reading' | 'ready' | 'error';

export interface Attachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  ext: string;
  kind: AttachmentKind;
  status: AttachmentStatus;
  /** Extracted text sent to the model as a code/context block. */
  text?: string;
  chars?: number;
  truncated?: boolean;
  /** Why the file could not be read (never silently dropped). */
  error?: string;
  /** Local blob URL for image/audio/video/pdf preview. */
  url?: string;
  /** Raw bytes for @file-viewer (office, archives, pdf…). */
  buffer?: ArrayBuffer;
  /** Vision attachment (images only). */
  image?: AttachedImage;
  /** True when `text` (or `image`) is actually sent to the model. */
  modelReadable: boolean;
  /** Workspace path when the attachment came from the @-mention menu. */
  path?: string;
}

export const ATTACH_MAX_BYTES = 8 * 1024 * 1024;
export const ATTACH_MAX_TEXT = 200_000;
const STRUCTURED_EXT = /\.(json|jsonl|ndjson|csv|tsv|logfmt|xml|ya?ml|toml|ini|sql)$/i;

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'sql', 'graphql',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'java', 'kt', 'kts',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php', 'swift', 'css', 'scss',
  'sass', 'less', 'html', 'htm', 'vue', 'svelte', 'sh', 'bash', 'zsh', 'ps1',
  'bat', 'cmd', 'dockerfile', 'makefile', 'gradle', 'tex', 'svg',
]);

const OFFICE_EXT = new Set([
  'doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'odp', 'pages', 'key',
]);

const SHEET_EXT = new Set(['xls', 'xlsx', 'ods', 'numbers', 'csv']);

const ARCHIVE_EXT = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab', 'iso',
]);

const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'wma']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'wmv', 'flv', 'ogv']);

let seq = 0;

function newId(name: string): string {
  seq += 1;
  return `${name}-${Date.now()}-${seq}`;
}

export function fileExt(name: string): string {
  const clean = name.replace(/\\/g, '/').split('/').pop() || name;
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(dot + 1).toLowerCase() : clean.toLowerCase();
}

export function baseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function classifyAttachment(name: string, mime = ''): AttachmentKind {
  const ext = fileExt(name);
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio';
  if (mime.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (SHEET_EXT.has(ext) && ext !== 'csv') return 'spreadsheet';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (mime.startsWith('text/') || TEXT_EXT.has(ext)) return 'text';
  return 'binary';
}

/** Text and vision are sent to the model; PDFs become extracted text. */
export function isModelReadable(kind: AttachmentKind): boolean {
  return kind === 'text' || kind === 'image' || kind === 'pdf';
}

/** Head+tail truncation: keeps imports and the file's final exports/main. */
export function smartTruncate(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const headChars = Math.floor(limit * 0.7);
  const tailChars = limit - headChars;
  const removed = text.length - limit;
  const marker = `

[... ${removed.toLocaleString()} chars omitted (file is ${text.length.toLocaleString()} chars) — ask for a specific line range or a definition to see it ...]

`;
  return {
    text: text.slice(0, headChars) + marker + text.slice(text.length - tailChars),
    truncated: true,
  };
}

function looksBinary(buffer: ArrayBuffer): boolean {
  const probe = new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength));
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) return true;
  return false;
}

let pdfWorkerReady = false;

/** Extracts selectable text from a PDF (pdf.js). Returns '' when none. */
async function extractPdfText(buffer: ArrayBuffer, maxChars = 60_000): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfWorkerReady) {
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    pdfWorkerReady = true;
  }
  // pdfjs v6: destroy() lives on the loading task, not on PDFDocumentProxy.
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  const doc = await task.promise;
  const pages: string[] = [];
  let chars = 0;
  const pageCount = Math.min(doc.numPages, 80);
  for (let p = 1; p <= pageCount && chars < maxChars; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) {
      pages.push(line);
      chars += line.length;
    }
  }
  await task.destroy();
  return pages.join('\n\n').slice(0, maxChars);
}

function make(
  base: Pick<Attachment, 'id' | 'name' | 'size' | 'mime' | 'ext' | 'kind'>,
  patch: Partial<Attachment> = {},
): Attachment {
  return {
    status: 'ready',
    modelReadable: isModelReadable(base.kind),
    ...base,
    ...patch,
  };
}

/**
 * Reads a browser `File` (file picker / drag&drop) into the common shape.
 * Never throws for a single unreadable file: the error is carried on the
 * attachment so the UI can show it.
 */
export async function prepareAttachment(
  file: File,
  opts: { imageMode?: ImageMode; perFileChars?: number } = {},
): Promise<Attachment> {
  const ext = fileExt(file.name);
  const mime = file.type || '';
  let kind = classifyAttachment(file.name, mime);
  const base = { id: newId(file.name), name: file.name, size: file.size, mime, ext, kind };

  if (kind === 'image') {
    try {
      const image = await prepareImageFile(file, opts.imageMode ?? DEFAULT_IMAGE_MODE);
      return make(base, { image, url: image.url, modelReadable: true });
    } catch (err) {
      return make(base, {
        status: 'error',
        modelReadable: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (file.size > ATTACH_MAX_BYTES) {
    return make({ ...base, kind: 'large' }, {
      kind: 'large',
      modelReadable: false,
      url: URL.createObjectURL(file),
    });
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    return make(base, {
      status: 'error',
      modelReadable: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (kind === 'text' && looksBinary(buffer)) kind = 'binary';
  const withKind = { ...base, kind };

  if (kind === 'text') {
    const limit = STRUCTURED_EXT.test(file.name) ? ATTACH_MAX_TEXT * 4 : ATTACH_MAX_TEXT;
    const decoded = new TextDecoder().decode(buffer);
    const { text, truncated } = smartTruncate(decoded, limit);
    return make(withKind, {
      text,
      chars: text.length,
      truncated,
      modelReadable: true,
    });
  }

  if (kind === 'pdf') {
    const url = URL.createObjectURL(file);
    let text = '';
    let error: string | undefined;
    try {
      text = await extractPdfText(buffer, opts.perFileChars ?? 60_000);
      if (!text.trim()) error = 'PDF has no selectable text (scanned image?)';
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return make(withKind, {
      buffer,
      url,
      text: text || undefined,
      chars: text.length || undefined,
      modelReadable: !!text,
      ...(error ? { error } : {}),
    });
  }

  if (kind === 'audio' || kind === 'video') {
    return make(withKind, { url: URL.createObjectURL(file), modelReadable: false });
  }

  return make(withKind, { buffer, modelReadable: false });
}

/** Workspace (@-mention) path: text is read through the sandboxed backend. */
export async function preparePathAttachment(path: string): Promise<Attachment> {
  const name = baseName(path);
  const ext = fileExt(name);
  const kind = classifyAttachment(name);
  const base = { id: newId(path), name, size: 0, mime: '', ext, kind, path };
  const [read] = await readAttachedFiles([path], { perFileChars: 60_000, totalChars: 180_000 });
  if (read?.body) {
    return make(base, {
      text: read.body,
      chars: read.body.length,
      truncated: read.truncated,
      modelReadable: true,
    });
  }
  return make(base, {
    status: 'error',
    modelReadable: false,
    error: read?.error ?? 'File could not be read from the workspace',
  });
}

/** Preview payload understood by FilePreviewDrawer. */
export function attachmentPreview(a: Attachment): PreviewItem {
  const size = a.size ? formatBytes(a.size) : undefined;
  if (a.kind === 'image' && a.url) {
    return { name: a.name, kind: 'image', url: a.url, size };
  }
  if (a.kind === 'text') {
    return {
      name: a.name,
      kind: 'text',
      body: a.text ?? (a.error ? `// ${a.error}` : ''),
      path: a.path,
      size,
    };
  }
  if (a.kind === 'pdf') {
    return { name: a.name, kind: 'pdf', buffer: a.buffer, url: a.url, mime: a.mime, size };
  }
  if (a.kind === 'audio' || a.kind === 'video') {
    return { name: a.name, kind: a.kind, url: a.url, mime: a.mime, size };
  }
  if (a.kind === 'large') {
    return { name: a.name, kind: 'large', url: a.url, mime: a.mime, size };
  }
  return { name: a.name, kind: 'binary', buffer: a.buffer, mime: a.mime, size };
}

/** Context block for the model; null when the file has no usable text. */
export function attachmentCodeBlock(a: Attachment): { name: string; body: string } | null {
  if (a.kind === 'text' && a.text) return { name: a.name, body: a.text };
  if (a.kind === 'pdf' && a.text) return { name: `${a.name}.txt`, body: a.text };
  return null;
}

export function attachmentError(a: Attachment): string | undefined {
  return a.error;
}
