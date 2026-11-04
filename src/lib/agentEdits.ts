/**
 * Ajan koşusunun ürettiği dosya düzenlemelerini toplar ve uygular.
 *
 * Sözleşme dürüsttür: SEARCH metni dosyada bulunamazsa düzenleme
 * SESSİZCE atlanmaz — `ok:false` ve gerekçe döner, arayüz bunu gösterir.
 * Eşleştirme önce birebir, sonra satır sonu/baş boşluk toleransıyla denenir
 * (Windows CRLF ve modelin boşluk tercihleri gerçek dünyada farklıdır).
 */

export interface AgentEditRecord {
  task: string;
  file: string;
  op: 'replace' | 'create';
  search: string;
  body: string;
  /** Bu düzenlemeyi öneren düğüm (UI iz çipi için). */
  from: string;
}

export interface EditApplyResult {
  ok: boolean;
  code: string;
  error?: string;
}

export interface RawMessageLike {
  kind: string;
  raw: unknown;
  /** Zarfı gönderen düğüm — değişiklik/bulgu/plan izi için. */
  from?: string;
}

/** Planlayıcının ürettiği adımlar — UI'da okunabilir "Plan" bölümü. */
export interface PlanStep {
  id: string;
  title: string;
  files: string;
  deps: string;
  est: number | null;
  risk: string;
  /** Bu planı üreten düğüm. */
  from: string;
}

/** Koşudaki `plan` zarflarından adımları çıkarır (birden çok planlayıcı olabilir). */
export function extractPlanSteps(messages: RawMessageLike[]): PlanStep[] {
  const out: PlanStep[] = [];
  for (const msg of messages) {
    if (msg.kind !== 'plan') continue;
    const payload = (msg.raw as { payload?: unknown } | null)?.payload;
    if (!Array.isArray(payload)) continue;
    for (const rec of payload) {
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as Record<string, unknown>;
      const title = typeof r.title === 'string' ? r.title.trim() : '';
      const id = typeof r.id === 'string' ? r.id.trim() : '';
      if (!title && !id) continue;
      out.push({
        id,
        title: title || id,
        files: typeof r.files === 'string' ? r.files : '',
        deps: typeof r.deps === 'string' ? r.deps : '',
        est: typeof r.est === 'number' ? r.est : null,
        risk: typeof r.risk === 'string' ? r.risk : '',
        from: msg.from ?? '',
      });
    }
  }
  return out;
}

/** Koşudaki `result` zarflarından uygulanabilir düzenlemeleri çıkarır. */
export function extractEdits(messages: RawMessageLike[]): AgentEditRecord[] {
  const out: AgentEditRecord[] = [];
  for (const msg of messages) {
    if (msg.kind !== 'result') continue;
    const payload = (msg.raw as { payload?: unknown } | null)?.payload;
    if (!Array.isArray(payload)) continue;
    for (const rec of payload) {
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as Record<string, unknown>;
      const file = typeof r.file === 'string' ? r.file.trim() : '';
      if (!file) continue;
      const body = typeof r.body === 'string' ? r.body : '';
      const search = typeof r.search === 'string' ? r.search : '';
      const opRaw = typeof r.op === 'string' ? r.op.toLowerCase() : '';
      // `create` yalnızca açıkça istenirse; aksi halde arama metni varsa replace.
      const op: 'replace' | 'create' = opRaw === 'create' || (!search && !opRaw) ? 'create' : 'replace';
      out.push({
        task: typeof r.task === 'string' ? r.task : '',
        file: file.replace(/\\/g, '/'),
        op,
        search,
        body,
        from: msg.from ?? '',
      });
    }
  }
  return out;
}

function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

function detectEol(code: string): string {
  return code.includes('\r\n') ? '\r\n' : '\n';
}

/** Satır bazlı, baş/son boşluk toleranslı arama. Dönüş: [baş, son) aralığı. */
function findLoose(haystack: string[], needle: string[]): [number, number] | null {
  if (needle.length === 0) return null;
  const want = needle.map((l) => l.trim());
  // Tamamen boş arama metinleri eşleşme sayılmaz.
  if (want.every((l) => l === '')) return null;
  for (let i = 0; i + want.length <= haystack.length; i++) {
    let hit = true;
    for (let j = 0; j < want.length; j++) {
      if (haystack[i + j].trim() !== want[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return [i, i + want.length];
  }
  return null;
}

/**
 * Tek bir search/replace düzenlemesini koda uygular.
 * Önce birebir, sonra toleranslı eşleşme; hiçbiri yoksa hata döner.
 */
export function applySearchReplace(code: string, search: string, replace: string): EditApplyResult {
  const cleanSearch = normalizeEol(search).replace(/^\n+|\n+$/g, '');
  const cleanReplace = normalizeEol(replace).replace(/^\n+|\n+$/g, '');
  if (!cleanSearch.trim()) {
    return { ok: false, code, error: 'empty-search' };
  }
  const src = normalizeEol(code);
  const eol = detectEol(code);

  // 1) Birebir.
  const direct = src.indexOf(cleanSearch);
  if (direct >= 0) {
    const next = src.slice(0, direct) + cleanReplace + src.slice(direct + cleanSearch.length);
    return { ok: true, code: eol === '\n' ? next : next.replace(/\n/g, eol) };
  }

  // 2) Satır bazlı tolerans (baş/son boşluk farkları).
  const lines = src.split('\n');
  const needle = cleanSearch.split('\n');
  const range = findLoose(lines, needle);
  if (!range) {
    return { ok: false, code, error: 'search-not-found' };
  }
  const before = lines.slice(0, range[0]);
  const after = lines.slice(range[1]);
  const next = [...before, ...cleanReplace.split('\n'), ...after].join('\n');
  return { ok: true, code: eol === '\n' ? next : next.replace(/\n/g, eol) };
}

/** Aynı dosyaya gelen düzenlemeleri sırayla uygular; ilk hata sonucu taşır. */
export function applyFileEdits(
  original: string,
  edits: AgentEditRecord[]
): { code: string; applied: number; errors: string[] } {
  let code = original;
  let applied = 0;
  const errors: string[] = [];
  for (const e of edits) {
    if (e.op === 'create') {
      // Dosya zaten varsa create onu EZMEZ; boşsa doğrudan yazılır.
      if (code.trim() === '') {
        code = e.body;
        applied++;
      } else {
        errors.push(`${e.file}: create skipped, file is not empty`);
      }
      continue;
    }
    const r = applySearchReplace(code, e.search, e.body);
    if (r.ok) {
      code = r.code;
      applied++;
    } else {
      errors.push(`${e.file}: ${r.error}`);
    }
  }
  return { code, applied, errors };
}

/** Düzenlemeleri dosya yoluna göre gruplar (arayüzün değişiklik listesi). */
export function groupEditsByFile(edits: AgentEditRecord[]): Map<string, AgentEditRecord[]> {
  const map = new Map<string, AgentEditRecord[]>();
  for (const e of edits) {
    const list = map.get(e.file) || [];
    list.push(e);
    map.set(e.file, list);
  }
  return map;
}

/** `result` dışındaki zarflardan denetim bulgularını çıkarır. */
export interface AgentFinding {
  severity: string;
  code: string;
  message: string;
  file: string;
  task: string;
  /** Bu bulguyu yazan denetçi düğümü (UI iz çipi/filtre için). */
  from: string;
}

export function extractFindings(messages: RawMessageLike[]): AgentFinding[] {
  const out: AgentFinding[] = [];
  for (const msg of messages) {
    if (msg.kind !== 'review') continue;
    const payload = (msg.raw as { payload?: unknown } | null)?.payload;
    if (!Array.isArray(payload)) continue;
    for (const rec of payload) {
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as Record<string, unknown>;
      out.push({
        severity: typeof r.severity === 'string' ? r.severity : 'info',
        code: typeof r.code === 'string' ? r.code : '',
        message: typeof r.message === 'string' ? r.message : '',
        file: typeof r.file === 'string' ? r.file : '',
        task: typeof r.task === 'string' ? r.task : '',
        from: msg.from ?? '',
      });
    }
  }
  return out;
}

/** Rapor zarfındaki metrik kayıtları. */
export function extractReport(messages: RawMessageLike[]): { metric: string; value: string }[] {
  const out: { metric: string; value: string }[] = [];
  for (const msg of messages) {
    if (msg.kind !== 'report') continue;
    const payload = (msg.raw as { payload?: unknown } | null)?.payload;
    if (!Array.isArray(payload)) continue;
    for (const rec of payload) {
      if (!rec || typeof rec !== 'object') continue;
      const r = rec as Record<string, unknown>;
      if (typeof r.metric !== 'string') continue;
      out.push({ metric: r.metric, value: String(r.value ?? '') });
    }
  }
  return out;
}
