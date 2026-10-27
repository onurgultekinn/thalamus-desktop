#!/usr/bin/env node
// Kalite A/B harness'i (bagimliliksiz, yalnizca fetch).
//
// Once `cargo run --example bench_dump --release` ile bench/out/cases.json
// uretin, sonra:
//
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 MODEL=llama3.2 node scripts/bench-quality.mjs
//
// Ortam degiskenleri:
//   OPENAI_BASE_URL    OpenAI uyumlu uc nokta (Ollama/llama.cpp/LM Studio ya da
//                      bulut). Ornek: http://127.0.0.1:11434/v1
//   MODEL              Model kimligi (zorunlu)
//   OPENAI_API_KEY     Bulut saglayici icin (yerel modellerde bos olabilir)
//   REPEATS            Her soru icin tekrar sayisi (varsayilan 3)
//   CASES              Yalniz bu veri seti ad(lar)ini calistir (virgulle)
//
// Kosullar: RAW, COMPRESSED ve RAW_REPEAT (A/A gurultu tabani). temperature=0.
// Puanlama: normalize edilmis tam eslesme (bosluk, buyuk/kucuk harf, sayi
// bicimi). Sonuc: bench/results/quality-<tarih>.csv + ozet Markdown.
//
// Uc nokta yoksa ya da erisilemezse betik anlasilir bir hatayla cikar ve
// HICBIR sonuc yazmaz — sayi uydurulmaz.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const casesPath = join(root, 'bench', 'out', 'cases.json');
const baseUrl = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
const model = process.env.MODEL || '';
const apiKey = process.env.OPENAI_API_KEY || '';
const repeats = Math.max(1, Number(process.env.REPEATS || 3));

function die(msg) {
  console.error(`bench-quality: ${msg}`);
  process.exit(1);
}

if (!baseUrl) {
  die(
    'OPENAI_BASE_URL tanimli degil. Ornek:\n' +
      '  OPENAI_BASE_URL=http://127.0.0.1:11434/v1 MODEL=llama3.2 node scripts/bench-quality.mjs'
  );
}
if (!model) die('MODEL tanimli degil (or. MODEL=llama3.2).');
if (!existsSync(casesPath)) {
  die(
    `${casesPath} yok. Once su komutu calistirin:\n` +
      '  cargo run --manifest-path src-tauri/Cargo.toml --example bench_dump --release'
  );
}

const payload = JSON.parse(readFileSync(casesPath, 'utf8'));
let cases = payload.cases || [];
const only = process.env.CASES
  ? new Set(process.env.CASES.split(',').map((s) => s.trim().toLowerCase()))
  : null;
if (only) cases = cases.filter((c) => only.has(c.dataset.toLowerCase()));
if (!cases.length) die('calistirilacak vaka yok.');

/** Cevabi karsilastirmak icin normalize eder. */
function normalize(value) {
  let s = String(value ?? '')
    .replace(/^\s*`+|`+\s*$/g, '')
    .replace(/\*\*/g, '')
    .trim();
  // Yalnizca ilk satiri al: model bazen aciklama ekliyor.
  s = s.split('\n')[0].trim();
  // "1,234.50" / "1234,50" / "1 234" gibi bicimleri sadelestir.
  s = s.replace(/\s+(?=\d{3}\b)/g, '').replace(/,/g, '.');
  const numeric = Number(s);
  if (s !== '' && Number.isFinite(numeric)) {
    // Tam sayiysa ondalik sifirlarini at ("200" == "200.0").
    return String(Number(numeric.toFixed(6)));
  }
  return s.toLowerCase();
}

/** %95 Wilson guven araligi. */
function wilson(successes, n) {
  if (n === 0) return [0, 0];
  const z = 1.959963984540054;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

async function ask(prompt, question) {
  const body = {
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You answer questions about the data in the user message. ' +
          'Reply with ONLY the value — no explanation, no punctuation, no units.',
      },
      { role: 'user', content: `${prompt}\n\nQuestion: ${question}` },
    ],
  };
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

// Uc noktayi once tek bir hafif istekle dogrula: yoksa "sayi uydurma" yok.
try {
  await ask('ping', 'reply with ok');
} catch (err) {
  die(
    `uc noktaya ulasilamadi (${baseUrl}): ${err.message}\n` +
      'Sunucunun calistigini ve URL/model adini kontrol edin. Sonuc yazilmadi.'
  );
}

const rows = [];
const stats = new Map(); // key: cond|kind -> {ok, n}

function record(cond, kind, ok) {
  const key = `${cond}|${kind}`;
  if (!stats.has(key)) stats.set(key, { ok: 0, n: 0 });
  const s = stats.get(key);
  s.n += 1;
  if (ok) s.ok += 1;
}

for (const c of cases) {
  for (const q of c.questions) {
    // RAW ve COMPRESSED ayniysa A/B farki anlamsizdir; yine de olcelim ki
    // A/A gurultu tabaniyla karsilastirilabilsin.
    const conditions = [
      ['RAW', c.raw_prompt],
      ['COMPRESSED', c.compressed_prompt],
      ['RAW_REPEAT', c.raw_prompt],
    ];
    for (const [cond, prompt] of conditions) {
      for (let r = 0; r < repeats; r++) {
        let answer = '';
        let ok = false;
        try {
          answer = await ask(prompt, q.text);
          ok = normalize(answer) === normalize(q.expected);
        } catch (err) {
          console.error(`  hata: ${c.dataset} / ${q.kind} / ${cond}: ${err.message}`);
        }
        record(cond, q.kind, ok);
        rows.push({
          dataset: c.dataset,
          kind: c.kind,
          question_kind: q.kind,
          condition: cond,
          repeat: r,
          expected: q.expected,
          answer: answer.replace(/\s+/g, ' ').slice(0, 120),
          correct: ok ? 1 : 0,
        });
        process.stderr.write('.');
      }
    }
  }
}
process.stderr.write('\n');

const stamp = new Date().toISOString().slice(0, 10);
const outDir = join(root, 'bench', 'results');
mkdirSync(outDir, { recursive: true });

const csvPath = join(outDir, `quality-${stamp}.csv`);
const header = 'dataset,kind,question_kind,condition,repeat,expected,answer,correct';
const csv = [header]
  .concat(
    rows.map((r) =>
      [
        r.dataset,
        r.kind,
        r.question_kind,
        r.condition,
        r.repeat,
        JSON.stringify(r.expected),
        JSON.stringify(r.answer),
        r.correct,
      ].join(',')
    )
  )
  .join('\n');
writeFileSync(csvPath, csv + '\n', 'utf8');

function rate(cond, kind) {
  const s = stats.get(`${cond}|${kind}`) || { ok: 0, n: 0 };
  if (s.n === 0) return { pct: '—', ci: '—', ok: 0, n: 0 };
  const [lo, hi] = wilson(s.ok, s.n);
  return {
    pct: ((100 * s.ok) / s.n).toFixed(1),
    ci: `${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)}`,
    ok: s.ok,
    n: s.n,
  };
}

const kinds = [...new Set(cases.flatMap((c) => c.questions.map((q) => q.kind)))];
const md = [];
md.push(`# Quality A/B — ${stamp}`);
md.push('');
md.push(`Model: \`${model}\` · endpoint: \`${baseUrl}\` · repeats: ${repeats}`);
md.push('');
md.push('| Question kind | RAW accuracy % (95% CI) | COMPRESSED % (95% CI) | RAW_REPEAT % (95% CI) | RAW−REPEAT | RAW−COMPRESSED |');
md.push('|---|---|---|---|---:|---:|');
for (const kind of kinds) {
  const raw = rate('RAW', kind);
  const comp = rate('COMPRESSED', kind);
  const rep = rate('RAW_REPEAT', kind);
  const dNoise =
    raw.n && rep.n ? (Number(raw.pct) - Number(rep.pct)).toFixed(1) : '—';
  const dEff =
    raw.n && comp.n ? (Number(raw.pct) - Number(comp.pct)).toFixed(1) : '—';
  md.push(
    `| ${kind} | ${raw.pct} (${raw.ci}) | ${comp.pct} (${comp.ci}) | ${rep.pct} (${rep.ci}) | ${dNoise} | ${dEff} |`
  );
}
md.push('');
md.push(
  '`RAW−REPEAT` is the A/A noise floor (same prompt twice). If `RAW−COMPRESSED` ' +
    'is within roughly that band, the difference should not be read as an effect.'
);
md.push('');
md.push(`Per-answer data: \`bench/results/quality-${stamp}.csv\``);

const mdPath = join(outDir, `quality-${stamp}.md`);
writeFileSync(mdPath, md.join('\n') + '\n', 'utf8');

console.log(md.join('\n'));
console.log(`\nYazildi: ${csvPath}\nYazildi: ${mdPath}`);
