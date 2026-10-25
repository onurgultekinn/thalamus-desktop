import {
  type ReactNode, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  ArrowLeft, ChevronDown, ChevronRight, Copy, Play, Plus, Redo2, Sparkles, Trash2, Undo2, X,
} from 'lucide-react';
import { PixelOffice, agentHeadDataUrl } from './PixelOffice';
import { AgentMesh } from './AgentMesh';
import { FlowEditorX6 } from './FlowEditorX6';
import { aiChat, getActiveProvider, type AiMessage } from '../services/aiClient';
import { getProviderModel, modelChoices } from '../lib/models';
import { getLang, useT, type Lang } from '../lib/i18n';

type View = 'plan' | 'chart' | 'office';
type TplKey = 'software' | 'content' | 'research';

export interface PlanAgent {
  id: string;
  parentId: string | null;
  name: string;
  role: string;
  mission: string;
  resp: string;
  model: string;
  /** Flow'da elle yerleştirilen konum; yoksa otomatik hiyerarşi kullanılır. */
  x?: number;
  y?: number;
}

/** Hiyerarşi dışı serbest bağ: "A → B ne yapar / ne için". */
export interface AgentLink {
  id: string;
  from: string;
  to: string;
  /** İlişkinin türü; hazır seçeneklerden ya da serbest metinden. */
  label: string;
  /** Bu bağlantının amacı. */
  note: string;
}

interface Plan {
  v: 2;
  name: string;
  agents: PlanAgent[];
  links: AgentLink[];
}

const REL_PRESETS = [
  'company.relDelegates',
  'company.relCoordinates',
  'company.relHandoff',
  'company.relReviews',
  'company.relInforms',
  'company.relConsults',
  'company.relDepends',
] as const;

interface TplAgent {
  name: string;
  role: string;
  mission: string;
  resp: string;
  parent: number | null;
}


const STORE = 'tlm_agent_company';
const VIEW_KEY = 'tlm_agent_company_view';
const NODE_W = 172;
const NODE_H = 56;
const GAP_X = 22;
const GAP_Y = 40;

const TB = 'flex h-6 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-[10.5px] text-[#A8A397] '
  + 'hover:bg-[#F2F0E5]/5 hover:text-[#F2F0E5] disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer';
const TBI = 'grid h-6 w-6 shrink-0 place-items-center rounded-[3px] text-[#A8A397] '
  + 'hover:bg-[#F2F0E5]/5 hover:text-[#F2F0E5] cursor-pointer';
const PRIMARY = 'flex h-6 shrink-0 items-center gap-1 rounded-[3px] bg-[#dcb67a] px-2 text-[10.5px] font-medium '
  + 'text-[#141210] hover:bg-[#EBCB99] disabled:cursor-default disabled:opacity-40';
/* Araç çubuğu düğmeleri için nötr stil: "Add agent" sarı PRIMARY kullanıyordu
   ve paleti bozuyordu; onay gerektiren iletiş kutuları sarı kalır. */
const NEUTRAL = 'flex h-6 shrink-0 items-center gap-1 rounded-[3px] border border-[#2A2825] bg-[#171614] px-2 '
  + 'text-[10.5px] font-medium text-[#E8E4DA] hover:border-[#3C3830] hover:bg-[#201E1B] '
  + 'disabled:cursor-default disabled:opacity-40';
const LABEL = 'mb-1 block text-[9px] uppercase tracking-[0.08em] text-[#7C776B]';
const FIELD = 'w-full min-w-0 rounded-[3px] border border-[#2A2825] bg-[#0F0E0E] px-2 py-1 text-[11px] '
  + 'text-[#E8E4DA] outline-none placeholder:text-[#565248] focus:border-[#dcb67a]/50';

const AI_SYSTEM = [
  'You are a senior org designer for AI agent companies.',
  'Turn the brief into a small operating model, not a list of job titles.',
  'Reply with JSON only. No markdown, no prose, no code fences.',
  'Schema: {"name":"...","agents":[{"name":"...","role":"...","mission":"...","responsibilities":["..."],"parent":null}],"links":[{"from":0,"to":1,"label":"...","note":"..."}]}.',
  '"parent" is the zero-based index of the parent agent, or null for the root.',
  '"links" are work relationships outside the hierarchy. from/to are agent indexes (names also work).',
  'Use one root, 4-9 agents, max depth 3, and 2-6 useful links. Every agent must be reachable from the root.',
  'Each role must own a distinct outcome; avoid overlapping missions.',
  'Model real handoffs: who gives what to whom, and who checks the result.',
  'Short names (1-3 words), one-sentence missions, 1-3 concrete responsibilities each.',
  'Link labels must be short verbs such as delegates, informs, reviews, consults or depends on.',
  'Do not add links to missing agents, duplicate a pair, or create cycles.',
  'If the brief is vague, make reasonable assumptions and still return a complete plan.',
].join(' ');

const TPL: Record<TplKey, Record<Lang, TplAgent[]>> = {
  software: {
    en: [
      { name: 'Founder', role: 'Strategy', mission: 'Sets the direction, scope and priorities.', resp: 'Define the goal\nPick the priorities', parent: null },
      { name: 'Product', role: 'Product', mission: 'Turns the goal into a concrete plan.', resp: 'Write the brief\nDefine what done means', parent: 0 },
      { name: 'Engineering', role: 'Engineering', mission: 'Builds and ships the work.', resp: 'Own the build\nKeep it shippable', parent: 0 },
      { name: 'Design', role: 'Design', mission: 'Shapes the experience and visuals.', resp: 'Wireframes\nVisual system', parent: 1 },
      { name: 'Backend', role: 'Backend', mission: 'Owns data, APIs and reliability.', resp: 'API and data model\nTests', parent: 2 },
      { name: 'Frontend', role: 'Frontend', mission: 'Owns the interface.', resp: 'Screens\nStates', parent: 2 },
      { name: 'QA', role: 'QA', mission: 'Checks the result against the brief.', resp: 'Test plan\nRelease check', parent: 2 },
    ],
    tr: [
      { name: 'Kurucu', role: 'Strateji', mission: 'Yönü, kapsamı ve öncelikleri belirler.', resp: 'Hedefi tanımla\nÖncelikleri seç', parent: null },
      { name: 'Ürün', role: 'Ürün', mission: 'Hedefi somut bir plana çevirir.', resp: 'Brief yaz\nBitti tanımını yap', parent: 0 },
      { name: 'Mühendislik', role: 'Mühendislik', mission: 'İşi kurar ve yayına alır.', resp: 'Yapımı sahiplen\nYayına hazır tut', parent: 0 },
      { name: 'Tasarım', role: 'Tasarım', mission: 'Deneyimi ve görsel dili şekillendirir.', resp: 'Kaba taslak\nGörsel sistem', parent: 1 },
      { name: 'Backend', role: 'Backend', mission: 'Veri, API ve güvenilirliği yönetir.', resp: 'API ve veri modeli\nTestler', parent: 2 },
      { name: 'Frontend', role: 'Frontend', mission: 'Arayüzü yönetir.', resp: 'Ekranlar\nDurumlar', parent: 2 },
      { name: 'Test', role: 'QA', mission: 'Sonucu brief ile karşılaştırır.', resp: 'Test planı\nYayın kontrolü', parent: 2 },
    ],
  },
  content: {
    en: [
      { name: 'Editor', role: 'Editorial', mission: 'Owns the editorial plan and quality.', resp: 'Plan the calendar\nEdit the drafts', parent: null },
      { name: 'Research', role: 'Research', mission: 'Finds and verifies the material.', resp: 'Source gathering\nFact check', parent: 0 },
      { name: 'Writer', role: 'Writing', mission: 'Turns research into clear drafts.', resp: 'Draft\nRevise', parent: 0 },
      { name: 'Visual', role: 'Design', mission: 'Makes the story look right.', resp: 'Cover\nLayout', parent: 0 },
      { name: 'Distribution', role: 'Growth', mission: 'Gets the work to the right people.', resp: 'Channels\nSchedule', parent: 0 },
    ],
    tr: [
      { name: 'Editör', role: 'Editoryal', mission: 'Yayın planını ve kaliteyi yönetir.', resp: 'Takvimi planla\nTaslakları düzenle', parent: null },
      { name: 'Araştırma', role: 'Araştırma', mission: 'Malzemeyi bulur ve doğrular.', resp: 'Kaynak topla\nDoğrula', parent: 0 },
      { name: 'Yazar', role: 'Yazı', mission: 'Araştırmayı net taslaklara çevirir.', resp: 'Taslak yaz\nRevize et', parent: 0 },
      { name: 'Görsel', role: 'Tasarım', mission: 'Hikayenin görünümünü kurar.', resp: 'Kapak\nYerleşim', parent: 0 },
      { name: 'Dağıtım', role: 'Büyüme', mission: 'İşi doğru kişilere ulaştırır.', resp: 'Kanallar\nZamanlama', parent: 0 },
    ],
  },
  research: {
    en: [
      { name: 'Lead', role: 'Research', mission: 'Frames the question and the method.', resp: 'Define the question\nChoose the method', parent: null },
      { name: 'Researcher', role: 'Research', mission: 'Collects primary evidence.', resp: 'Interviews\nSources', parent: 0 },
      { name: 'Analyst', role: 'Analysis', mission: 'Turns evidence into findings.', resp: 'Synthesis\nFindings', parent: 0 },
      { name: 'Writer', role: 'Writing', mission: 'Writes the report.', resp: 'Report\nSummary', parent: 0 },
      { name: 'Data', role: 'Data', mission: 'Keeps the data clean and checkable.', resp: 'Dataset\nSanity checks', parent: 0 },
    ],
    tr: [
      { name: 'Lider', role: 'Araştırma', mission: 'Soruyu ve yöntemi çerçeveler.', resp: 'Soruyu tanımla\nYöntemi seç', parent: null },
      { name: 'Araştırmacı', role: 'Araştırma', mission: 'Birincil kanıtı toplar.', resp: 'Görüşmeler\nKaynaklar', parent: 0 },
      { name: 'Analist', role: 'Analiz', mission: 'Kanıtı bulguya çevirir.', resp: 'Sentez\nBulgular', parent: 0 },
      { name: 'Yazar', role: 'Yazı', mission: 'Raporu yazar.', resp: 'Rapor\nÖzet', parent: 0 },
      { name: 'Veri', role: 'Veri', mission: 'Veriyi temiz ve denetlenebilir tutar.', resp: 'Veri seti\nTutarlılık kontrolü', parent: 0 },
    ],
  },
};

function uid() {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function linkUid() {
  return `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeLinks(v: unknown, ids: Set<string>): AgentLink[] {
  if (!Array.isArray(v)) return [];
  const out: AgentLink[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const l = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const from = str(l.from);
    const to = str(l.to);
    if (!from || !to || from === to || !ids.has(from) || !ids.has(to)) continue;
    const id = str(l.id) || linkUid();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, from, to, label: str(l.label), note: str(l.note) });
  }
  return out;
}

function str(v: unknown) {
  return typeof v === 'string' ? v : '';
}

function respStr(v: unknown) {
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join('\n');
  return str(v);
}


function flatten(list: PlanAgent[]): PlanAgent[] {
  const map = new Map(list.map((a) => [a.id, a]));
  const kids = new Map<string | null, PlanAgent[]>();
  for (const a of list) {
    const pid = a.parentId && map.has(a.parentId) ? a.parentId : null;
    const arr = kids.get(pid);
    if (arr) arr.push(a); else kids.set(pid, [a]);
  }
  const out: PlanAgent[] = [];
  const seen = new Set<string>();
  const walk = (pid: string | null) => {
    for (const a of kids.get(pid) ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
      walk(a.id);
    }
  };
  walk(null);
  for (const a of list) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push({ ...a, parentId: null });
    walk(a.id);
  }
  return out;
}

function sanitizeAgents(list: PlanAgent[]): PlanAgent[] {
  const seen = new Set<string>();
  const clean: PlanAgent[] = [];
  for (const a of list) {
    if (!a.id || seen.has(a.id)) continue;
    seen.add(a.id);
    clean.push({ ...a });
  }
  const map = new Map(clean.map((a) => [a.id, a]));
  for (const a of clean) {
    if (a.parentId && (!map.has(a.parentId) || a.parentId === a.id)) a.parentId = null;
  }
  for (const a of clean) {
    const chain = new Set<string>([a.id]);
    let p = a.parentId;
    while (p) {
      if (chain.has(p)) { a.parentId = null; break; }
      chain.add(p);
      p = map.get(p)?.parentId ?? null;
    }
  }
  return flatten(clean);
}

function childMap(agents: PlanAgent[]) {
  const ids = new Set(agents.map((a) => a.id));
  const map = new Map<string | null, PlanAgent[]>();
  for (const a of agents) {
    const pid = a.parentId && ids.has(a.parentId) ? a.parentId : null;
    const arr = map.get(pid);
    if (arr) arr.push(a); else map.set(pid, [a]);
  }
  return map;
}

function subtreeEnd(agents: PlanAgent[], start: number) {
  const allowed = new Set<string>([agents[start].id]);
  let end = start + 1;
  while (end < agents.length) {
    const a = agents[end];
    if (a.parentId && allowed.has(a.parentId)) {
      allowed.add(a.id);
      end++;
    } else break;
  }
  return end;
}

function normalizeAgent(v: unknown): PlanAgent {
  const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    id: str(a.id) || uid(),
    parentId: str(a.parentId) || null,
    name: str(a.name),
    role: str(a.role),
    mission: str(a.mission) || str(a.task),
    resp: respStr(a.resp) || respStr(a.instructions),
    model: str(a.model),
    ...(Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y))
      ? { x: Number(a.x), y: Number(a.y) }
      : {}),
  };
}

function deriveParents(agents: PlanAgent[], edges: unknown) {
  if (!Array.isArray(edges)) return;
  const ids = new Set(agents.map((a) => a.id));
  const parent = new Map<string, string>();
  for (const e of edges) {
    const edge = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const from = str(edge.from);
    const to = str(edge.to);
    if (!from || !to || from === to || !ids.has(from) || !ids.has(to) || parent.has(to)) continue;
    parent.set(to, from);
  }
  for (const a of agents) {
    const pid = parent.get(a.id);
    if (pid) a.parentId = pid;
  }
}

function emptyPlan(): Plan {
  return { v: 2, name: '', agents: [], links: [] };
}

function loadPlan(): Plan {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return emptyPlan();
    const data = JSON.parse(raw) as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return emptyPlan();
    const name = str(data.name);
    if (data.v === 2 && Array.isArray(data.agents)) {
      const agents = sanitizeAgents(data.agents.map(normalizeAgent));
      return { v: 2, name, agents, links: normalizeLinks(data.links, new Set(agents.map((a) => a.id))) };
    }
    if (Array.isArray(data.agents)) {
      const agents = data.agents.map(normalizeAgent);
      deriveParents(agents, data.edges);
      const clean = sanitizeAgents(agents);
      return { v: 2, name, agents: clean, links: normalizeLinks(data.links, new Set(clean.map((a) => a.id))) };
    }
    if (Array.isArray(data.nodes)) {
      const nodes = data.nodes.filter((n) => {
        const node = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
        return node.kind === 'agent' && typeof node.id === 'string';
      }) as Array<Record<string, unknown>>;
      const agents = nodes.map((n) => ({
        id: str(n.id),
        parentId: null,
        name: str(n.name),
        role: str(n.role),
        mission: str(n.task),
        resp: '',
        model: str(n.model),
      }));
      deriveParents(agents, data.edges);
      const clean = sanitizeAgents(agents);
      return { v: 2, name, agents: clean, links: normalizeLinks(data.links, new Set(clean.map((a) => a.id))) };
    }
  } catch {}
  return emptyPlan();
}

interface ParsedAiPlan {
  name: string;
  agents: PlanAgent[];
  links: AgentLink[];
}

function parseAiPlan(text: string): ParsedAiPlan | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const raw = Array.isArray(obj.agents) ? obj.agents : Array.isArray(data) ? data : [];
  const parsed = raw.slice(0, 24).map((v) => {
    const a = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const respRaw = a.responsibilities;
    const resp = (Array.isArray(respRaw) ? respRaw.map(str) : str(respRaw).split('\n'))
      .map((s) => s.trim()).filter(Boolean).join('\n').slice(0, 1400);
    const rawParent = a.parent;
    const parentNum = typeof rawParent === 'number' ? rawParent : typeof rawParent === 'string' && rawParent.trim() !== '' ? Number(rawParent) : NaN;
    return {
      name: str(a.name).trim().slice(0, 48),
      role: str(a.role).trim().slice(0, 48),
      mission: str(a.mission).trim().slice(0, 280),
      resp,
      parent: Number.isInteger(parentNum) ? parentNum : null,
    };
  });
  const kept: typeof parsed = [];
  const remap = new Map<number, number>();
  parsed.forEach((d, i) => {
    if (!d.name) return;
    remap.set(i, kept.length);
    kept.push(d);
  });
  if (!kept.length) return null;
  const ids = kept.map(() => uid());
  const mappedAgents: PlanAgent[] = kept.map((d, i) => {
    const mapped = d.parent !== null ? remap.get(d.parent) : undefined;
    return {
      id: ids[i],
      parentId: mapped !== undefined && mapped !== i ? ids[mapped] : null,
      name: d.name,
      role: d.role,
      mission: d.mission,
      resp: d.resp,
      model: '',
    };
  });
  const agents = sanitizeAgents(mappedAgents);
  const byIndex = new Map<number, string>();
  for (const [source, index] of remap) byIndex.set(source, ids[index]);
  const byName = new Map<string, string>();
  for (const a of agents) {
    const key = a.name.trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, a.id);
  }
  const resolveAgent = (v: unknown): string | undefined => {
    if (typeof v === 'number' && Number.isInteger(v)) return byIndex.get(v);
    if (typeof v !== 'string') return undefined;
    const value = v.trim();
    if (/^-?\d+$/.test(value)) return byIndex.get(Number(value));
    return byName.get(value.toLowerCase());
  };
  const links: AgentLink[] = [];
  const seenLinks = new Set<string>();
  const rawLinks = Array.isArray(obj.links) ? obj.links : [];
  for (const rawLink of rawLinks.slice(0, 16)) {
    const l = (rawLink && typeof rawLink === 'object' ? rawLink : {}) as Record<string, unknown>;
    const from = resolveAgent(l.from);
    const to = resolveAgent(l.to);
    if (!from || !to || from === to) continue;
    const key = `${from}>${to}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    links.push({
      id: linkUid(),
      from,
      to,
      label: (str(l.label) || str(l.relationship) || str(l.kind)).trim().slice(0, 48),
      note: (str(l.note) || str(l.purpose)).trim().slice(0, 200),
    });
  }
  return {
    name: str(obj.name).trim().slice(0, 80),
    agents,
    links,
  };
}

function toMarkdown(plan: Plan, companyFallback: string, agentFallback: string, connectionsTitle: string) {
  const kids = childMap(plan.agents);
  const lines = [`# ${plan.name.trim() || companyFallback}`, ''];
  const walk = (pid: string | null, depth: number) => {
    for (const a of kids.get(pid) ?? []) {
      lines.push(`${'#'.repeat(Math.min(6, depth + 2))} ${a.name.trim() || agentFallback}${a.role ? ` — ${a.role}` : ''}`);
      if (a.mission.trim()) lines.push(a.mission.trim());
      const resp = a.resp.split('\n').map((s) => s.trim()).filter(Boolean);
      if (resp.length) lines.push('', ...resp.map((r) => `- ${r}`));
      lines.push('');
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  if (plan.links.length) {
    const nameOf = (id: string) => plan.agents.find((a) => a.id === id)?.name.trim() || agentFallback;
    lines.push(`## ${connectionsTitle}`, '');
    for (const l of plan.links) {
      const label = l.label.trim();
      const note = l.note.trim();
      lines.push(`- ${nameOf(l.from)} → ${nameOf(l.to)}${label ? ` — ${label}` : ''}${note ? `: ${note}` : ''}`);
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

export function AgentCompany({ active = true }: { active?: boolean }) {
  const t = useT();
  const lang = getLang();
  const [plan, setPlan] = useState<Plan>(() => loadPlan());
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === 'chart' || v === 'office' ? v : 'plan';
    } catch { return 'plan'; }
  });

  /**
   * Flow (X6) editörünü boşta önceden kur. Plan ↔ Flow geçişinde editör
   * yeniden mount edilmediği için grafik kurulum maliyeti geçişe yansımaz.
   */
  const [chartReady, setChartReady] = useState(false);
  useEffect(() => {
    if (chartReady) return;
    if (view === 'chart') {
      setChartReady(true);
      return;
    }
    let idleId: number | undefined;
    const warm = () => setChartReady(true);
    if (typeof window.requestIdleCallback === 'function') {
      idleId = window.requestIdleCallback(warm, { timeout: 1500 });
    } else {
      idleId = window.setTimeout(warm, 600);
    }
    return () => {
      if (idleId === undefined) return;
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId);
      window.clearTimeout(idleId);
    };
  }, [view, chartReady]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [scrollId, setScrollId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'tpl' | 'ai' | null>(null);
  const [brief, setBrief] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [activeModel, setActiveModel] = useState('');
  /** Ofiste seçili ajan (inspector) ve hiyerarşide seçili düğüm. */
  const [selectedOffice, setSelectedOffice] = useState<string | null>(null);
  const [selectedChart, setSelectedChart] = useState<string | null>(null);
  /** Seçili bağlantı: hedef (çocuk) ajanın id'si. */
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  /** Seçili serbest bağlantı (hiyerarşi dışı ilişki). */
  const [selectedLink, setSelectedLink] = useState<string | null>(null);
  /** Flow içinde gerçek çok-ajan çalıştırma paneli. */
  const [showRun, setShowRun] = useState(false);
  /** Yeni Flow editöründe "sığdır" tetikleyicisi. */
  const [flowFitNonce, setFlowFitNonce] = useState(0);
  const planScrollRef = useRef<HTMLDivElement>(null);
  const planRef = useRef(plan);
  planRef.current = plan;
  const aiAbort = useRef<AbortController | null>(null);

  const agents = plan.agents;
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const kids = useMemo(() => childMap(agents), [agents]);
  const modelOptions = useMemo(() => modelChoices(providerId), [providerId]);

  const levels = useMemo(() => {
    let max = 0;
    for (const a of agents) {
      let depth = 1;
      let p = a.parentId;
      const seen = new Set<string>([a.id]);
      while (p && byId.has(p) && !seen.has(p)) {
        seen.add(p);
        depth++;
        p = byId.get(p)?.parentId ?? null;
      }
      if (depth > max) max = depth;
    }
    return max;
  }, [agents, byId]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      try { localStorage.setItem(STORE, JSON.stringify(plan)); } catch {}
    }, 300);
    return () => window.clearTimeout(id);
  }, [plan]);

  useEffect(() => {
    return () => {
      aiAbort.current?.abort();
      try { localStorage.setItem(STORE, JSON.stringify(planRef.current)); } catch {}
    };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch {}
    if (view !== 'chart') {
      setSelectedEdge(null);
      setSelectedLink(null);
      setSelectedChart(null);
    }
  }, [view]);

  useEffect(() => {
    let alive = true;
    getActiveProvider()
      .then((p) => {
        if (!alive) return;
        setProviderId(p?.id ?? '');
        setActiveModel(p?.model ?? (p ? getProviderModel(p.id) : ''));
      })
      .catch(() => { if (alive) { setProviderId(''); setActiveModel(''); } });
    return () => { alive = false; };
  }, []);





  useEffect(() => {
    if (view !== 'plan' || !focusId) return;
    const raf = window.requestAnimationFrame(() => {
      const el = document.getElementById(`agent-name-${focusId}`) as HTMLInputElement | null;
      if (el) { el.focus(); el.select(); }
      setFocusId(null);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [focusId, view]);

  useEffect(() => {
    if (view !== 'plan' || !scrollId) return;
    const raf = window.requestAnimationFrame(() => {
      document.getElementById(`agent-row-${scrollId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setScrollId(null);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [scrollId, view]);

  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dialog === 'ai') {
        aiAbort.current?.abort();
        aiAbort.current = null;
        setAiError(null);
        setAiLoading(false);
      }
      setDialog(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);

  const patch = (id: string, fields: Partial<PlanAgent>) => {
    setPlan((p) => ({ ...p, agents: p.agents.map((a) => (a.id === id ? { ...a, ...fields } : a)) }));
  };

  // ── Flow editörü ──────────────────────────────────────────────────────
  const historyRef = useRef<Plan[]>([]);
  /** Geri alınan işlemler: ileri (redo) için tutulur. */
  const redoRef = useRef<Plan[]>([]);
  const pushHistory = () => {
    historyRef.current.push(planRef.current);
    if (historyRef.current.length > 40) historyRef.current.shift();
    redoRef.current = [];
  };
  const undo = () => {
    const prev = historyRef.current.pop();
    if (!prev) return;
    redoRef.current.push(planRef.current);
    setPlan(prev);
  };
  const redo = () => {
    const next = redoRef.current.pop();
    if (!next) return;
    historyRef.current.push(planRef.current);
    setPlan(next);
  };
  /** Hedefin atalarında `candidate` varsa bağlantı çevrim oluşturur. */
  const isAncestor = (candidate: string, of: string) => {
    let p = byId.get(of)?.parentId ?? null;
    const seen = new Set<string>();
    while (p) {
      if (p === candidate) return true;
      if (seen.has(p)) break;
      seen.add(p);
      p = byId.get(p)?.parentId ?? null;
    }
    return false;
  };
  const connect = (from: string, to: string) => {
    if (!from || !to || from === to || isAncestor(to, from)) {
      return;
    }
    pushHistory();
    setPlan((p) => ({
      ...p,
      agents: p.agents.map((a) => (a.id === to ? { ...a, parentId: from } : a)),
    }));
    setSelectedEdge(to);
    setSelectedLink(null);
    setSelectedChart(null);
  };
  const detach = (childId: string) => {
    if (!byId.get(childId)?.parentId) return;
    pushHistory();
    setPlan((p) => ({
      ...p,
      agents: p.agents.map((a) => (a.id === childId ? { ...a, parentId: null } : a)),
    }));
    setSelectedEdge(null);
  };

  /** Hiyerarşi dışı bağ: karttan karta serbest ilişki. */
  const addLink = (from: string, to: string) => {
    if (!from || !to || from === to) return;
    const id = linkUid();
    pushHistory();
    setPlan((p) => ({ ...p, links: [...p.links, { id, from, to, label: '', note: '' }] }));
    setSelectedLink(id);
    setSelectedEdge(null);
    setSelectedChart(null);
  };
  const patchLink = (id: string, fields: Partial<AgentLink>) => {
    setPlan((p) => ({ ...p, links: p.links.map((l) => (l.id === id ? { ...l, ...fields } : l)) }));
  };
  const removeLink = (id: string) => {
    pushHistory();
    setPlan((p) => ({ ...p, links: p.links.filter((l) => l.id !== id) }));
    setSelectedLink(null);
  };

  const addAgent = (parentId: string | null, afterId?: string, stayInView = false) => {
    const id = uid();
    const agent: PlanAgent = {
      id,
      parentId,
      name: t('company.newName'),
      role: t('company.roleDefault'),
      mission: '',
      resp: '',
      model: activeModel,
    };
    pushHistory();
    setPlan((p) => {
      const list = [...p.agents];
      let at = list.length;
      if (afterId) {
        const i = list.findIndex((a) => a.id === afterId);
        if (i >= 0) at = subtreeEnd(list, i);
      } else if (parentId) {
        const i = list.findIndex((a) => a.id === parentId);
        if (i >= 0) at = subtreeEnd(list, i);
      }
      // Serbest konum modunda yeni ajanı ebeveyninin altına yerleştir;
      // aksi halde otomatik hiyerarşi konumlandırır.
      const nextAgent = { ...agent };
      if (p.agents.some((a) => Number.isFinite(a.x) && Number.isFinite(a.y))) {
        const parent = parentId ? p.agents.find((a) => a.id === parentId) : null;
        const siblings = p.agents.filter((a) => a.parentId === parentId);
        nextAgent.x = (parent?.x ?? 60) + siblings.length * (NODE_W + GAP_X);
        nextAgent.y = parent ? (parent.y ?? 60) + NODE_H + GAP_Y : 60;
      }
      list.splice(at, 0, nextAgent);
      return { ...p, agents: list };
    });
    if (parentId) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
    }
    if (!stayInView) setView('plan');
    else setFlowFitNonce((n) => n + 1);
    setSelectedChart(id);
    setFocusId(id);
  };

  const addSibling = (id: string) => {
    const node = byId.get(id);
    if (node) addAgent(node.parentId, id);
  };

  const addChild = (id: string) => addAgent(id);
  /** Flow'da kalarak alt ajan ekle. */
  const addChildInFlow = (id: string) => addAgent(id, undefined, true);

  const indent = (id: string) => {
    setPlan((p) => {
      const i = p.agents.findIndex((a) => a.id === id);
      if (i < 0) return p;
      const node = p.agents[i];
      let prev: PlanAgent | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (p.agents[j].parentId === node.parentId) { prev = p.agents[j]; break; }
      }
      if (!prev) return p;
      const end = subtreeEnd(p.agents, i);
      const block = p.agents.slice(i, end);
      block[0] = { ...block[0], parentId: prev.id };
      const rest = [...p.agents.slice(0, i), ...p.agents.slice(end)];
      const pi = rest.findIndex((a) => a.id === prev.id);
      const at = pi >= 0 ? subtreeEnd(rest, pi) : rest.length;
      rest.splice(at, 0, ...block);
      return { ...p, agents: rest };
    });
  };

  const outdent = (id: string) => {
    setPlan((p) => {
      const i = p.agents.findIndex((a) => a.id === id);
      if (i < 0) return p;
      const node = p.agents[i];
      if (!node.parentId) return p;
      const parent = p.agents.find((a) => a.id === node.parentId);
      const grand = parent?.parentId ?? null;
      const end = subtreeEnd(p.agents, i);
      const block = p.agents.slice(i, end);
      block[0] = { ...block[0], parentId: grand };
      const rest = [...p.agents.slice(0, i), ...p.agents.slice(end)];
      const pi = rest.findIndex((a) => a.id === node.parentId);
      const at = pi >= 0 ? subtreeEnd(rest, pi) : rest.length;
      rest.splice(at, 0, ...block);
      return { ...p, agents: rest };
    });
  };

  const moveSibling = (id: string, dir: -1 | 1) => {
    setPlan((p) => {
      const i = p.agents.findIndex((a) => a.id === id);
      if (i < 0) return p;
      const node = p.agents[i];
      const siblings = p.agents.filter((a) => a.parentId === node.parentId);
      const si = siblings.findIndex((a) => a.id === id);
      const target = siblings[si + dir];
      if (!target) return p;
      const end = subtreeEnd(p.agents, i);
      const block = p.agents.slice(i, end);
      const rest = [...p.agents.slice(0, i), ...p.agents.slice(end)];
      const ti = rest.findIndex((a) => a.id === target.id);
      if (ti < 0) return p;
      const at = dir < 0 ? ti : subtreeEnd(rest, ti);
      rest.splice(at, 0, ...block);
      return { ...p, agents: rest };
    });
  };

  const remove = (id: string) => {
    setPlan((p) => {
      const node = p.agents.find((a) => a.id === id);
      if (!node) return p;
      const parentId = node.parentId;
      return {
        ...p,
        agents: p.agents.filter((a) => a.id !== id).map((a) => (a.parentId === id ? { ...a, parentId } : a)),
        links: p.links.filter((l) => l.from !== id && l.to !== id),
      };
    });
    setExpandedId((v) => (v === id ? null : v));
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // Flow kısayolları: Ctrl+Z geri al, Delete seçili düğüm/bağlantıyı sil,
  // Esc bağlantı/ seçim modunu kapat. Input içinde yazarken dokunma.
  useEffect(() => {
    if (!active || view !== 'chart') return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === 'Escape') {
        setSelectedEdge(null);
        setSelectedLink(null);
        setSelectedChart(null);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedEdge) {
          e.preventDefault();
          detach(selectedEdge);
        } else if (selectedLink) {
          e.preventDefault();
          removeLink(selectedLink);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, active, selectedEdge, selectedLink, selectedChart]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const applyTemplate = (key: TplKey) => {
    const defs = TPL[key][lang];
    const ids = defs.map(() => uid());
    const agentsNext = sanitizeAgents(defs.map((d, i) => ({
      id: ids[i],
      parentId: d.parent === null ? null : ids[d.parent],
      name: d.name,
      role: d.role,
      mission: d.mission,
      resp: d.resp,
      model: activeModel,
    })));
    setPlan((p) => ({ ...p, agents: agentsNext, links: [] }));
    setExpandedId(null);
    setCollapsed(new Set());
    setFocusId(null);
    setView('plan');
    setDialog(null);
    window.requestAnimationFrame(() => { if (planScrollRef.current) planScrollRef.current.scrollTop = 0; });
  };

  const openInPlan = (id: string) => {
    setView('plan');
    setExpandedId(id);
    setScrollId(id);
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      let p = byId.get(id)?.parentId ?? null;
      const seen = new Set<string>();
      while (p && !seen.has(p)) {
        seen.add(p);
        next.delete(p);
        p = byId.get(p)?.parentId ?? null;
      }
      return next;
    });
  };

  const copyPlan = async () => {
    try {
      await navigator.clipboard.writeText(
        toMarkdown(plan, t('company.title'), t('company.newName'), t('company.connections'))
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const closeAi = () => {
    aiAbort.current?.abort();
    aiAbort.current = null;
    setAiLoading(false);
    setAiError(null);
    setDialog(null);
  };

  const generate = async () => {
    const b = brief.trim();
    if (!b || aiLoading) return;
    setAiError(null);
    setAiLoading(true);
    const ac = new AbortController();
    aiAbort.current = ac;
    try {
      const provider = await getActiveProvider().catch(() => null);
      if (ac.signal.aborted) return;
      if (!provider) { setAiError(t('company.noProvider')); return; }
      const messages: AiMessage[] = [
        { role: 'system', content: `${AI_SYSTEM} Write all text in ${lang === 'tr' ? 'Turkish' : 'English'}.` },
        { role: 'user', content: b },
      ];
      const res = await aiChat(messages, [], provider, ac.signal);
      if (ac.signal.aborted) return;
      const next = parseAiPlan(res.content);
      if (!next?.agents.length) { setAiError(t('company.aiFailed')); return; }
      setPlan((p) => ({
        ...p,
        name: next.name || p.name,
        agents: next.agents.map((a) => ({ ...a, model: a.model || activeModel })),
        links: next.links,
      }));
      setExpandedId(null);
      setCollapsed(new Set());
      setFocusId(null);
      setSelectedChart(null);
      setSelectedEdge(null);
      setSelectedLink(null);
      setView('chart');
      setFlowFitNonce((n) => n + 1);
      setDialog(null);
      setBrief('');
      window.requestAnimationFrame(() => { if (planScrollRef.current) planScrollRef.current.scrollTop = 0; });
    } catch (err) {
      if (!ac.signal.aborted) {
        const missingKey = err instanceof Error && err.message === 'API_KEY_MISSING';
        setAiError(missingKey ? t('company.noProvider') : t('company.aiFailed'));
      }
    } finally {
      if (aiAbort.current === ac) {
        aiAbort.current = null;
        setAiLoading(false);
      }
    }
  };

  const tplList: Array<{ key: TplKey; name: string; desc: string; count: number }> = [
    { key: 'software', name: t('company.templateSoftware'), desc: t('company.templateSoftwareDesc'), count: TPL.software[lang].length },
    { key: 'content', name: t('company.templateContent'), desc: t('company.templateContentDesc'), count: TPL.content[lang].length },
    { key: 'research', name: t('company.templateResearch'), desc: t('company.templateResearchDesc'), count: TPL.research[lang].length },
  ];

  const detail = (a: PlanAgent, depth: number) => {
    const parent = a.parentId ? byId.get(a.parentId) : null;
    const reports = kids.get(a.id)?.length ?? 0;
    return (
      <div
        className="mb-1 min-w-0 rounded-[3px] border border-[#201F1B] bg-[#121110] p-2.5"
        style={{ marginLeft: depth * 18 + 22, marginRight: 6 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
          <label className="block min-w-0">
            <span className={LABEL}>{t('company.role')}</span>
            <input
              className={FIELD}
              value={a.role}
              onChange={(e) => patch(a.id, { role: e.target.value })}
              placeholder={t('company.roleDefault')}
            />
          </label>
          <label className="block min-w-0">
            <span className={LABEL}>{t('company.model')}</span>
            <input
              className={FIELD}
              list="tlm-agent-models"
              value={a.model}
              onChange={(e) => patch(a.id, { model: e.target.value })}
              placeholder={activeModel || t('company.model')}
            />
          </label>
        </div>
        <label className="mt-2 block">
          <span className={LABEL}>{t('company.task')}</span>
          <textarea
            rows={2}
            className={`${FIELD} resize-none`}
            value={a.mission}
            onChange={(e) => patch(a.id, { mission: e.target.value })}
            placeholder={t('company.instructionsPlaceholder')}
          />
        </label>
        <label className="mt-2 block">
          <span className={LABEL}>{t('company.responsibilities')}</span>
          <textarea
            rows={4}
            className={`${FIELD} resize-none`}
            value={a.resp}
            onChange={(e) => patch(a.id, { resp: e.target.value })}
            placeholder={t('company.responsibilitiesHint')}
          />
        </label>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="truncate text-[9.5px] text-[#7C776B]">
            {parent ? `${t('company.reportsTo')}: ${parent.name || t('company.newName')}` : t('company.rootAgent')}
            {' · '}{t('company.directReports')}: {reports}
          </span>
          <button
            type="button"
            onClick={() => remove(a.id)}
            className="flex shrink-0 items-center gap-1 rounded-[3px] px-1.5 py-1 text-[10px] text-[#B98A82] hover:bg-[#2A1715] hover:text-[#E06C75]"
          >
            <Trash2 size={11} />
            {t('company.deleteAgent')}
          </button>
        </div>
      </div>
    );
  };

  const flowProps = {
    agents,
    links: plan.links,
    selectedNodeId: selectedChart,
    selectedEdgeId: selectedEdge,
    selectedLinkId: selectedLink,
    fitNonce: flowFitNonce,
    onSelectNode: (id: string | null) => { setSelectedChart(id); setSelectedEdge(null); setSelectedLink(null); },
    onSelectEdge: (childId: string | null) => { setSelectedEdge(childId); setSelectedChart(null); setSelectedLink(null); },
    onSelectLink: (id: string | null) => { setSelectedLink(id); setSelectedChart(null); setSelectedEdge(null); },
    onMove: (id: string, x: number, y: number) => patch(id, { x, y }),
    onDragStart: pushHistory,
    onLink: connect,
    onRequestLink: addLink,
    onDetach: detach,
    onDelete: (id: string) => { pushHistory(); remove(id); setSelectedChart(null); setSelectedLink(null); },
    onAdd: () => addAgent(null, undefined, true),
    onAddChild: addChildInFlow,
    onOpenPlan: openInPlan,
  };

  const rows: ReactNode[] = [];
  const walkRows = (pid: string | null, depth: number) => {
    const list = kids.get(pid) ?? [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const prevId = i > 0 ? list[i - 1].id : null;
      const isLast = i === list.length - 1;
      const hasKids = (kids.get(a.id)?.length ?? 0) > 0;
      const open = expandedId === a.id;
      rows.push(
        <div key={a.id} id={`agent-row-${a.id}`}>
          <div
            className={`group relative flex h-[34px] items-center gap-1.5 pr-1.5 text-left ${open ? 'bg-[#171614]' : 'hover:bg-[#141312]'}`}
            style={{ paddingLeft: depth * 18 }}
            title={a.mission || undefined}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('input,button,textarea')) return;
              setExpandedId(open ? null : a.id);
            }}
          >
            {depth > 0 && Array.from({ length: depth }).map((_, l) => {
              const half = l === depth - 1 && isLast;
              return (
                <span
                  key={l}
                  aria-hidden
                  className="pointer-events-none absolute w-px bg-[#2A2724]"
                  style={{ left: l * 18 + 8, top: 0, bottom: half ? '50%' : 0 }}
                />
              );
            })}
            {depth > 0 && (
              <span
                aria-hidden
                className="pointer-events-none absolute h-px bg-[#2A2724]"
                style={{ left: (depth - 1) * 18 + 8, top: '50%', width: 18 }}
              />
            )}
            <button
              type="button"
              tabIndex={-1}
              disabled={!hasKids}
              onClick={(e) => { e.stopPropagation(); toggleCollapse(a.id); }}
              className="grid h-4 w-4 shrink-0 place-items-center rounded-[2px] text-[#6B675D] hover:text-[#C9C5BA] disabled:cursor-default disabled:hover:text-[#6B675D]"
            >
              {hasKids
                ? (collapsed.has(a.id) ? <ChevronRight size={11} /> : <ChevronDown size={11} />)
                : <span className="h-[3px] w-[3px] rounded-full bg-[#34312A]" />}
            </button>
            <input
              id={`agent-name-${a.id}`}
              value={a.name}
              onChange={(e) => patch(a.id, { name: e.target.value })}
              onBlur={() => { if (!a.name.trim()) patch(a.id, { name: t('company.newName') }); }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addSibling(a.id);
                } else if (e.key === 'Tab') {
                  e.preventDefault();
                  if (e.shiftKey) outdent(a.id);
                  else if (prevId) indent(a.id);
                } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                  e.preventDefault();
                  moveSibling(a.id, e.key === 'ArrowUp' ? -1 : 1);
                } else if (e.key === 'Escape') {
                  e.currentTarget.blur();
                }
              }}
              placeholder={t('company.newName')}
              className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-[#E8E4DA] outline-none placeholder:text-[#565248]"
            />
            <span className="w-[88px] shrink-0 truncate text-right text-[10px] text-[#8B867A]">
              {a.role || '—'}
            </span>
            <button
              type="button"
              tabIndex={-1}
              title={t('company.addChild')}
              onClick={(e) => { e.stopPropagation(); addChild(a.id); }}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-[3px] text-[#6B675D] opacity-0 hover:bg-[#24221E] hover:text-[#E8E4DA] group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <Plus size={12} />
            </button>
          </div>
          {open && detail(a, depth)}
        </div>,
      );
      if (!collapsed.has(a.id)) walkRows(a.id, depth + 1);
    }
  };
  walkRows(null, 0);

  return (
    <div className="relative flex h-full w-full min-h-0 min-w-0 flex-1 flex-col bg-[#0F0E0E] text-[#E8E4DA]">
      <datalist id="tlm-agent-models">
        {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.label ?? m.id}</option>)}
      </datalist>

      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-[#24221F] px-1.5 py-1">
        {(['plan', 'chart', 'office'] as View[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`relative h-7 shrink-0 px-1.5 text-[10.5px] transition-colors ${
              view === v ? 'text-[#EDE9DD]' : 'text-[#87857F] hover:text-[#C9C5BA]'
            }`}
          >
            {v === 'plan' ? t('company.plan') : v === 'chart' ? t('company.flow') : t('company.office')}
            {view === v && <span className="absolute inset-x-1 -bottom-px h-[1.5px] bg-[#dcb67a]" />}
          </button>
        ))}
        <span className="mx-0.5 h-4 w-px shrink-0 bg-[#24221F]" />
        <input
          value={plan.name}
          onChange={(e) => setPlan((p) => ({ ...p, name: e.target.value }))}
          placeholder={t('company.companyName')}
          className="h-6 w-[150px] min-w-[56px] shrink rounded-[3px] border border-transparent bg-transparent px-1 text-[11px] text-[#E8E4DA] outline-none placeholder:text-[#565248] hover:border-[#24221F] focus:border-[#2F2D28]"
        />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {view === 'chart' && (
            <>
              <button type="button" onClick={undo} className={TBI} title={t('company.undo')}>
                <Undo2 size={12} />
              </button>
              <button type="button" onClick={redo} className={TBI} title={t('company.redo')}>
                <Redo2 size={12} />
              </button>
            </>
          )}
          {view !== 'office' && (
            <>
              <button type="button" onClick={() => setDialog('tpl')} className={TB}>
                {t('company.templates')}
                <ChevronDown size={10} />
              </button>
              <button
                type="button"
                onClick={() => { setAiError(null); setDialog('ai'); }}
                className={TB}
                title={t('company.aiPlan')}
              >
                <Sparkles size={11} />
                {t('company.aiShort')}
              </button>
              <button type="button" onClick={copyPlan} className={TBI} title={t('company.copyPlan')}>
                <Copy size={12} />
              </button>
            </>
          )}
          {/* Flow'da Run, Add agent'ın sağında aynı tasarımda durur (alt
              köşedeki minik yeşil çip yerine). */}
          {view === 'chart' && agents.length > 0 && (
            <button type="button" onClick={() => setShowRun(true)} className={NEUTRAL} title={t('company.runHint')}>
              <Play size={11} />
              {t('company.run')}
            </button>
          )}
          {view !== 'office' && (
            <button type="button" onClick={() => addAgent(null, undefined, view === 'chart')} className={NEUTRAL}>
              <Plus size={12} />
              {t('company.add')}
            </button>
          )}
        </div>
      </div>

      {view === 'plan' && (
        <div ref={planScrollRef} className="min-h-0 flex-1 overflow-y-auto">
          {agents.length === 0 ? (
            <div className="mx-auto flex min-h-full w-full max-w-[520px] flex-col justify-center px-5 py-12">
              <p className="text-[14px] font-medium text-[#E8E4DA]">{t('company.emptyPlan')}</p>
              <p className="mt-1.5 max-w-[420px] text-[11px] leading-relaxed text-[#8C877B]">
                {t('company.emptyPlanDesc')}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => addAgent(null)}
                  className={`${PRIMARY} h-7 px-2.5`}
                >
                  <Plus size={12} />
                  {t('company.firstAgent')}
                </button>
                <button
                  type="button"
                  onClick={() => { setAiError(null); setDialog('ai'); }}
                  className={`${TB} h-7 px-2`}
                >
                  <Sparkles size={11} />
                  {t('company.aiPlan')}
                </button>
              </div>
              <div className="mt-6 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[9px] uppercase tracking-[0.08em] text-[#6B675D]">
                  {t('company.templates')}
                </span>
                {tplList.map((tp) => (
                  <button
                    key={tp.key}
                    type="button"
                    onClick={() => applyTemplate(tp.key)}
                    className="h-7 rounded-[3px] px-2 text-[10.5px] text-[#A8A397] hover:bg-[#F2F0E5]/5 hover:text-[#E8E4DA]"
                  >
                    {tp.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto w-full max-w-[780px] px-4 py-3">{rows}</div>
          )}
        </div>
      )}

      {(chartReady || view === 'chart') && (
        <div className={`relative flex min-h-0 flex-1 flex-col ${view === 'chart' ? '' : 'hidden'}`}>
          <div className="min-h-0 flex-1">
            <FlowEditorX6 {...flowProps} />
          </div>

          {/* Flow içinde gerçek çok-ajan çalıştırma: ayrı sekme değil,
              aynı ajan yüzeyinin devamı. */}
          {showRun && (
            <div className="absolute inset-0 z-20 flex flex-col bg-[#0F0E0E]">
              <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[#24221F] px-2">
                <button type="button" onClick={() => setShowRun(false)} className={TB}>
                  <ArrowLeft size={11} /> {t('company.backToFlow')}
                </button>
                <span className="truncate text-[10px] text-[#87857F]">{t('company.runTitle')}</span>
              </div>
              <div className="flex min-h-0 flex-1">
                <AgentMesh
                  embedded
                  initialTask={agents.find((a) => !a.parentId)?.mission || plan.name}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {view === 'office' && (
        <div className="relative min-h-0 flex-1 overflow-hidden bg-[#20242c]">
          <PixelOffice
            agents={agents}
            selected={selectedOffice}
            onSelect={setSelectedOffice}
            onActivate={(id) => openInPlan(id)}
          />
          {agents.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-[#6E6B66]">
              {t('company.emptyOffice')}
            </div>
          )}
        </div>
      )}

      {/* Ajan düzenleme: akışın üstünde ortalanmış pencere. */}
      {view === 'chart' && selectedChart && (() => {
        const agent = byId.get(selectedChart);
        if (!agent) return null;
        return (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4"
            onMouseDown={(e) => { if (e.target === e.currentTarget) setSelectedChart(null); }}
          >
            <div
              className="flex max-h-[86vh] w-full max-w-[540px] flex-col overflow-hidden rounded-lg border border-[#34332F] bg-[#151412] shadow-2xl"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex shrink-0 items-center gap-2.5 border-b border-[#24221F] px-3 py-2.5">
                <img
                  src={agentHeadDataUrl(agent.id)}
                  alt=""
                  width={32}
                  height={32}
                  className="h-8 w-8 shrink-0 rounded-[4px] border border-black/40"
                  style={{ imageRendering: 'pixelated' }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-semibold text-[#EDE9DD]">
                    {agent.name || t('company.newName')}
                  </div>
                  <div className="truncate text-[10px] text-[#8C877B]">
                    {agent.role || t('company.roleDefault')}
                  </div>
                </div>
                <button type="button" onClick={() => setSelectedChart(null)} className={TBI} aria-label={t('company.cancel')}>
                  <X size={13} />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 pretty-scrollbar">
                <div className="grid grid-cols-2 gap-2">
                  <label className="block min-w-0">
                    <span className={LABEL}>{t('company.name')}</span>
                    <input className={FIELD} value={agent.name} onChange={(e) => patch(agent.id, { name: e.target.value })} />
                  </label>
                  <label className="block min-w-0">
                    <span className={LABEL}>{t('company.role')}</span>
                    <input
                      className={FIELD}
                      value={agent.role}
                      onChange={(e) => patch(agent.id, { role: e.target.value })}
                      placeholder={t('company.roleDefault')}
                    />
                  </label>
                </div>
                <label className="mt-2.5 block">
                  <span className={LABEL}>{t('company.task')}</span>
                  <textarea
                    rows={2}
                    className={`${FIELD} resize-none`}
                    value={agent.mission}
                    onChange={(e) => patch(agent.id, { mission: e.target.value })}
                    placeholder={t('company.instructionsPlaceholder')}
                  />
                </label>
                <label className="mt-2.5 block">
                  <span className={LABEL}>{t('company.responsibilities')}</span>
                  <textarea
                    rows={4}
                    className={`${FIELD} resize-none`}
                    value={agent.resp}
                    onChange={(e) => patch(agent.id, { resp: e.target.value })}
                    placeholder={t('company.responsibilitiesHint')}
                  />
                </label>
                <label className="mt-2.5 block">
                  <span className={LABEL}>{t('company.model')}</span>
                  <input
                    className={FIELD}
                    list="tlm-agent-models"
                    value={agent.model}
                    onChange={(e) => patch(agent.id, { model: e.target.value })}
                    placeholder={activeModel || t('company.model')}
                  />
                </label>
                <div className="mt-2.5 flex items-center justify-between gap-2 text-[9.5px] text-[#7C776B]">
                  <span className="truncate">
                    {agent.parentId
                      ? `${t('company.reportsTo')}: ${byId.get(agent.parentId)?.name || t('company.newName')}`
                      : t('company.rootAgent')}
                  </span>
                  <span className="shrink-0">{t('company.directReports')}: {kids.get(agent.id)?.length ?? 0}</span>
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-[#24221F] px-3 py-2">
                <button type="button" onClick={() => openInPlan(agent.id)} className={PRIMARY}>
                  {t('company.openPlan')}
                </button>
                <button type="button" onClick={() => addChildInFlow(agent.id)} className={NEUTRAL}>
                  <Plus size={10} /> {t('company.addChild')}
                </button>
                {agent.parentId && (
                  <button
                    type="button"
                    onClick={() => { pushHistory(); patch(agent.id, { parentId: null }); }}
                    className={NEUTRAL}
                  >
                    {t('company.makeRoot')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { pushHistory(); remove(agent.id); setSelectedChart(null); }}
                  className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-[#B98A82] hover:bg-[#2A1715] hover:text-[#E06C75] cursor-pointer"
                >
                  <Trash2 size={10} /> {t('company.deleteAgent')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Bağlantı düzenleme: sağ tıkla kurulan bağın anlamı ve amacı. */}
      {view === 'chart' && (() => {
        const link = selectedLink ? plan.links.find((l) => l.id === selectedLink) : null;
        const hierChild = !link && selectedEdge ? byId.get(selectedEdge) : null;
        const from = byId.get(link?.from ?? hierChild?.parentId ?? '');
        const to = byId.get(link?.to ?? hierChild?.id ?? '');
        if ((!link && !hierChild) || !from || !to) return null;
        const close = () => { setSelectedLink(null); setSelectedEdge(null); };
        return (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4"
            onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
          >
            <div
              className="w-full max-w-[460px] overflow-hidden rounded-lg border border-[#34332F] bg-[#151412] shadow-2xl"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 border-b border-[#24221F] px-3 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <img
                    src={agentHeadDataUrl(from.id)}
                    alt=""
                    width={26}
                    height={26}
                    className="h-[26px] w-[26px] shrink-0 rounded-[4px] border border-black/40"
                    style={{ imageRendering: 'pixelated' }}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-[11.5px] font-medium text-[#EDE9DD]">{from.name || t('company.newName')}</div>
                    <div className="truncate text-[9.5px] text-[#7C776B]">{from.role || t('company.roleDefault')}</div>
                  </div>
                  <span className="shrink-0 px-0.5 text-[#6B675D]">→</span>
                  <img
                    src={agentHeadDataUrl(to.id)}
                    alt=""
                    width={26}
                    height={26}
                    className="h-[26px] w-[26px] shrink-0 rounded-[4px] border border-black/40"
                    style={{ imageRendering: 'pixelated' }}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-[11.5px] font-medium text-[#EDE9DD]">{to.name || t('company.newName')}</div>
                    <div className="truncate text-[9.5px] text-[#7C776B]">{to.role || t('company.roleDefault')}</div>
                  </div>
                </div>
                <button type="button" onClick={close} className={TBI} aria-label={t('company.cancel')}>
                  <X size={13} />
                </button>
              </div>

              <div className="px-3 py-3">
                <div className="text-[9px] uppercase tracking-[0.08em] text-[#7C776B]">
                  {link ? t('company.connection') : t('company.chart')}
                </div>
                {link ? (
                  <>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {REL_PRESETS.map((key) => {
                        const text = t(key);
                        const active = link.label.trim() === text;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => patchLink(link.id, { label: text })}
                            className={`rounded border px-1.5 py-1 text-[10px] cursor-pointer ${
                              active
                                ? 'border-[#dcb67a]/60 bg-[#dcb67a]/10 text-[#EDE9DD]'
                                : 'border-[#2A2825] text-[#A8A397] hover:border-[#3C3830] hover:text-[#E8E4DA]'
                            }`}
                          >
                            {text}
                          </button>
                        );
                      })}
                    </div>
                    <label className="mt-2.5 block">
                      <span className={LABEL}>{t('company.linkLabel')}</span>
                      <input
                        className={FIELD}
                        value={link.label}
                        onChange={(e) => patchLink(link.id, { label: e.target.value })}
                        placeholder={t('company.linkLabelPlaceholder')}
                      />
                    </label>
                    <label className="mt-2.5 block">
                      <span className={LABEL}>{t('company.linkNote')}</span>
                      <textarea
                        rows={2}
                        className={`${FIELD} resize-none`}
                        value={link.note}
                        onChange={(e) => patchLink(link.id, { note: e.target.value })}
                        placeholder={t('company.linkNotePlaceholder')}
                      />
                    </label>
                  </>
                ) : (
                  <p className="mt-1.5 text-[11px] leading-snug text-[#A8A397]">
                    {t('company.linkHierarchyHint', {
                      from: from.name || t('company.newName'),
                      to: to.name || t('company.newName'),
                    })}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-1.5 border-t border-[#24221F] px-3 py-2">
                <button
                  type="button"
                  onClick={() => {
                    if (link) removeLink(link.id);
                    else if (hierChild) detach(hierChild.id);
                    close();
                  }}
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-[#B98A82] hover:bg-[#2A1715] hover:text-[#E06C75] cursor-pointer"
                >
                  <Trash2 size={10} /> {t('company.deleteEdge')}
                </button>
                <button type="button" onClick={close} className={`${NEUTRAL} ml-auto`}>
                  {link ? t('company.save') : t('company.cancel')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="flex h-6 shrink-0 items-center gap-2 border-t border-[#24221F] px-2 text-[10px] text-[#8C877B]">
        {/* Sayaç: sayılar belirgin, etiketler soluk — küçük gri satır değil. */}
        <span className="shrink-0 whitespace-nowrap">
          <span className="font-medium text-[#E8E4DA]">{agents.length}</span> {t('company.agentCount', { n: '' }).replace(/^\s*/, '')}
          {' · '}
          <span className="font-medium text-[#E8E4DA]">{levels}</span> {t('company.levelCount', { n: '' }).replace(/^\s*/, '')}
          {plan.links.length > 0 && (
            <>
              {' · '}
              <span className="font-medium text-[#E8E4DA]">{plan.links.length}</span>{' '}
              {t('company.linkCount', { n: '' }).replace(/^\s*/, '')}
            </>
          )}
        </span>
        {copied && <span className="shrink-0 text-[#dcb67a]">{t('company.copied')}</span>}
        <span className="ml-auto flex min-w-0 items-center gap-2 overflow-hidden">
          <span className="truncate">
            {view === 'plan' ? t('company.planHint') : view === 'chart' ? t('company.chartHint') : t('company.officeHint')}
          </span>
        </span>
      </div>

      {dialog === 'tpl' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setDialog(null); }}
        >
          <div className="w-[430px] max-w-full rounded-[6px] border border-[#2C2A26] bg-[#141312]">
            <div className="flex h-10 items-center justify-between border-b border-[#24221F] px-3.5">
              <span className="text-[12px] font-medium text-[#EDE9DD]">{t('company.templates')}</span>
              <button type="button" onClick={() => setDialog(null)} className={TBI}>
                <X size={13} />
              </button>
            </div>
            <div className="p-3">
              {agents.length > 0 && (
                <p className="mb-2 text-[9.5px] text-[#A8A397]">{t('company.replaceWarn')}</p>
              )}
              <div className="flex flex-col gap-1.5">
                {tplList.map((tp) => (
                  <button
                    key={tp.key}
                    type="button"
                    onClick={() => applyTemplate(tp.key)}
                    className="flex w-full items-start gap-3 rounded-[4px] border border-[#26241F] px-3 py-2 text-left hover:border-[#3C3830] hover:bg-[#181715]"
                  >
                    <span className="min-w-0">
                      <span className="block text-[11.5px] text-[#E8E4DA]">{tp.name}</span>
                      <span className="mt-0.5 block text-[9.5px] leading-relaxed text-[#8C877B]">{tp.desc}</span>
                    </span>
                    <span className="ml-auto shrink-0 pt-0.5 text-[9px] text-[#6B675D]">
                      {t('company.agentCount', { n: tp.count })}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {dialog === 'ai' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closeAi(); }}
        >
          <div className="w-[460px] max-w-full rounded-[6px] border border-[#2C2A26] bg-[#141312]">
            <div className="flex h-10 items-center justify-between border-b border-[#24221F] px-3.5">
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-[#EDE9DD]">
                <Sparkles size={13} />
                {t('company.aiPlan')}
              </span>
              <button
                type="button"
                onClick={closeAi}
                className={TBI}
              >
                <X size={13} />
              </button>
            </div>
            <div className="p-3.5">
              <p className="text-[10.5px] leading-relaxed text-[#8C877B]">{t('company.aiPlanDesc')}</p>
              <label className="mt-3 block">
                <span className={LABEL}>{t('company.aiBrief')}</span>
                <textarea
                  autoFocus
                  rows={3}
                  disabled={aiLoading}
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  placeholder={t('company.aiBriefPlaceholder')}
                  className={`${FIELD} resize-none`}
                />
              </label>
              {agents.length > 0 && (
                <p className="mt-1.5 text-[9.5px] text-[#A8A397]">{t('company.replaceWarn')}</p>
              )}
              {aiError && <p className="mt-1.5 text-[10px] text-[#E06C75]">{aiError}</p>}
              <div className="mt-3 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={closeAi}
                  className={`${TB} h-7 px-2.5`}
                >
                  {t('company.cancel')}
                </button>
                <button
                  type="button"
                  disabled={aiLoading || !brief.trim()}
                  onClick={generate}
                  className={`${PRIMARY} h-7 px-2.5`}
                >
                  <Sparkles size={11} />
                  {aiLoading ? t('company.generating') : t('company.generate')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

