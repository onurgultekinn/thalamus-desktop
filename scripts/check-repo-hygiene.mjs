#!/usr/bin/env node
/**
 * Repo hijyen kapısı.
 *
 * Amaç: halka açık depoya yalnızca ÜRÜNE ait dosyaların girmesi. Yerel
 * çalışma alanı (iç ölçüm, denetim, yedek, kişisel not) ve sır içeren
 * dosyalar yanlışlıkla `git add` edilirse CI burada durur.
 *
 * Kapsam bilinçli olarak DAR: yalnız takip edilen yolları ve metin
 * dosyalarının içeriğini denetler. Çalışma anında üretilen çıktılar
 * (.gitignore'da) zaten takip edilmiyor.
 *
 * Kullanım: node scripts/check-repo-hygiene.mjs
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// Takip edilmemesi gereken yollar. Her biri gerçek bir olaydan geliyor:
// lab/ ve src-tauri/examples/lab.rs iç ölçüm alanıdır; _private/ kişisel
// çalışma alanıdır; _audit/_backups denetim ve yedek artefaktlarıdır;
// kalanlar geçici deneme dosyalarıdır.
const FORBIDDEN_PATHS = [
  { re: /^lab\//, why: 'iç ölçüm alanı (private)' },
  { re: /^_private\//, why: 'kişisel çalışma alanı' },
  { re: /^_audit\//, why: 'denetim artefaktları' },
  { re: /^_backups\//, why: 'yerel yedekler' },
  { re: /^(denetim|hatalar\.txt)$/, why: 'yerel not' },
  { re: /^_(preview_test|term_real|test_create)\./, why: 'geçici deneme dosyası' },
  { re: /^src-tauri\/examples\/(lab|e2e_evren)\.rs$/, why: 'iç ölçüm / kişisel e2e' },
  { re: /(^|\/)\.env(\.|$)/, why: 'ortam değişkeni dosyası' },
  { re: /\.(pem|key|pfx|p12)$/i, why: 'özel anahtar / sertifika' },
  { re: /(^|\/)\.DS_Store$/, why: 'işletim sistemi artığı' },
];

// İçerikte aranacak desenler. Metin dosyalarına uygulanır.
const CONTENT_RULES = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: 'gömülü özel anahtar' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS access key' },
  { re: /\bghp_[A-Za-z0-9]{36}\b/, why: 'GitHub personal access token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, why: 'Slack token' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, why: 'Google API key' },
  // Gerçek sağlayıcı anahtarı görünümü; test değişmezleri (MARKER/test/legacy)
  // bilinçli olarak hariç tutulur — onlar koda gömülü sahte değerlerdir.
  { re: /\bsk-(?!PLAINTEXT-MARKER|test|legacy|recover|abc)[A-Za-z0-9_-]{24,}/, why: 'API anahtarı görünümü' },
  { re: /C:\\Users\\[A-Za-z0-9._-]+\\/, why: 'kişisel mutlak yol' },
];

const TEXT_EXT = /\.(rs|ts|tsx|js|mjs|cjs|json|md|txt|toml|ya?ml|css|html|sh|ps1|py|gitignore|gitattributes|editorconfig|nvmrc)$/i;

function trackedFiles() {
  const out = execSync('git ls-files -z', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

const problems = [];
const files = trackedFiles();

for (const file of files) {
  const rel = file.split(path.sep).join('/');
  for (const rule of FORBIDDEN_PATHS) {
    if (rule.re.test(rel)) {
      problems.push({ kind: 'YOL', file: rel, why: rule.why });
    }
  }
  if (!TEXT_EXT.test(rel)) continue;
  let text;
  try {
    text = readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    continue;
  }
  // Büyük üretilmiş dosyalarda (ATTRIBUTIONS gibi) satır satır taramak yavaş;
  // yine de tarıyoruz ama yalnız ilk kural kümesiyle sınırlı değil.
  for (const rule of CONTENT_RULES) {
    if (!rule.re.test(text)) continue;
    // Hangi satırda olduğunu raporla (ilk eşleşme).
    const lines = text.split('\n');
    const idx = lines.findIndex((l) => rule.re.test(l));
    problems.push({
      kind: 'İÇERİK',
      file: rel,
      why: rule.why,
      at: idx >= 0 ? idx + 1 : undefined,
    });
  }
}

if (problems.length) {
  console.error(`Repo hijyen kapısı: ${problems.length} sorun`);
  for (const p of problems) {
    const where = p.at ? `${p.file}:${p.at}` : p.file;
    console.error(`  - [${p.kind}] ${where} — ${p.why}`);
  }
  console.error(
    '\nÇözüm: dosyayı `git rm --cached` ile takipten çıkarın ve .gitignore\'a ekleyin.\n' +
      'Bir metin eşleşmesi yanlış pozitifse kuralı gerekçesiyle daraltın.'
  );
  process.exit(1);
}

console.log(`Repo hijyen kapısı: temiz (${files.length} izlenen dosya).`);
