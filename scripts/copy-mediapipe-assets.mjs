// MediaPipe vision WASM'ını node_modules'tan public/mediapipe/wasm/ altına kopyalar.
// Tarayıcı/Tauri çevrimdışı çalıştığı için bu dosyalar yerelden servis edilir;
// repo'da tutulmaz (üretilen asset). dev/build öncesi otomatik çalışır.
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const target = join(root, 'public', 'mediapipe', 'wasm');
const stampPath = join(target, '.asset-stamp.json');

const FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

if (!existsSync(source)) {
  console.log('[mediapipe] @mediapipe/tasks-vision not installed; skipped');
  process.exit(0);
}

const signature = JSON.stringify(
  FILES.map((f) => {
    const p = join(source, f);
    return [f, existsSync(p) ? statSync(p).size : 0];
  })
);

let upToDate = false;
if (existsSync(stampPath)) {
  try {
    upToDate = readFileSync(stampPath, 'utf8') === signature;
  } catch {
    upToDate = false;
  }
}
if (upToDate && FILES.every((f) => existsSync(join(target, f)))) {
  console.log('[mediapipe] wasm up to date (copy skipped)');
  process.exit(0);
}

mkdirSync(target, { recursive: true });
for (const f of FILES) {
  const from = join(source, f);
  if (existsSync(from)) cpSync(from, join(target, f));
}
writeFileSync(stampPath, signature);
console.log(`[mediapipe] copied ${FILES.length} wasm files -> public/mediapipe/wasm`);
