import {
  type PointerEvent as RPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { ChevronDown, ChevronRight, Copy, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { PixelOffice } from './PixelOffice';
import { aiChat, getActiveProvider, type AiMessage } from '../services/aiClient';
import { getProviderModel, modelChoices } from '../lib/models';
import { getLang, useT, type Lang } from '../lib/i18n';

type View = 'plan' | 'chart' | 'office';
type TplKey = 'software' | 'content' | 'research';

interface PlanAgent {
  id: string;
  parentId: string | null;
  name: string;
  role: string;
  mission: string;
  resp: string;
  model: string;
}

interface Plan {
  v: 2;
  name: string;
  agents: PlanAgent[];
}

interface TplAgent {
  name: string;
  role: string;
  mission: string;
  resp: string;
  parent: number | null;
}

interface ChartNode {
  agent: PlanAgent;
  x: number;
  y: number;
  depth: number;
}

const STORE = 'tlm_agent_company';
const VIEW_KEY = 'tlm_agent_company_view';
const NODE_W = 172;
const NODE_H = 56;
const GAP_X = 22;
const GAP_Y = 40;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;

const TB = 'flex h-6 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-[10.5px] text-[#A8A397] '
  + 'hover:bg-[#F2F0E5]/5 hover:text-[#F2F0E5] disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer';
const TBI = 'grid h-6 w-6 shrink-0 place-items-center rounded-[3px] text-[#A8A397] '
  + 'hover:bg-[#F2F0E5]/5 hover:text-[#F2F0E5] cursor-pointer';
const PRIMARY = 'flex h-6 shrink-0 items-center gap-1 rounded-[3px] bg-[#dcb67a] px-2 text-[10.5px] font-medium '
  + 'text-[#141210] hover:bg-[#EBCB99] disabled:cursor-default disabled:opacity-40';
const LABEL = 'mb-1 block text-[9px] uppercase tracking-[0.08em] text-[#7C776B]';
const FIELD = 'w-full min-w-0 rounded-[3px] border border-[#2A2825] bg-[#0F0E0E] px-2 py-1 text-[11px] '
  + 'text-[#E8E4DA] outline-none placeholder:text-[#565248] focus:border-[#dcb67a]/50';

const AI_SYSTEM = [
  'You design the org plan of a small AI agent company.',
  'Reply with strict JSON only. No markdown, no prose.',
  'Shape: {"agents":[{"name":"...","role":"...","mission":"...","responsibilities":["..."],"parent":null}]}',
  '"parent" is the zero-based index of the parent agent in the array, or null for the root.',
  'Use 4 to 10 agents. Short names, one-sentence missions, 1-3 concrete responsibilities each.',
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

function str(v: unknown) {
  return typeof v === 'string' ? v : '';
}

function respStr(v: unknown) {
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join('\n');
  return str(v);
}

function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
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

function loadPlan(): Plan {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return { v: 2, name: '', agents: [] };
    const data = JSON.parse(raw) as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return { v: 2, name: '', agents: [] };
    const name = str(data.name);
    if (data.v === 2 && Array.isArray(data.agents)) {
      return { v: 2, name, agents: sanitizeAgents(data.agents.map(normalizeAgent)) };
    }
    if (Array.isArray(data.agents)) {
      const agents = data.agents.map(normalizeAgent);
      deriveParents(agents, data.edges);
      return { v: 2, name, agents: sanitizeAgents(agents) };
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
      return { v: 2, name, agents: sanitizeAgents(agents) };
    }
  } catch {}
  return { v: 2, name: '', agents: [] };
}

function parseAiPlan(text: string): PlanAgent[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let data: unknown;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch { return []; }
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
  if (!kept.length) return [];
  const ids = kept.map(() => uid());
  return sanitizeAgents(kept.map((d, i) => {
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
  }));
}

function toMarkdown(plan: Plan, companyFallback: string, agentFallback: string) {
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
  return `${lines.join('\n').trim()}\n`;
}

export function AgentCompany() {
  const t = useT();
  const lang = getLang();
  const [plan, setPlan] = useState<Plan>(() => loadPlan());
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === 'chart' || v === 'office' ? v : 'plan';
    } catch { return 'plan'; }
  });
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
  const [cam, setCam] = useState({ x: 0, y: 0, zoom: 1 });

  const canvasRef = useRef<HTMLDivElement>(null);
  const planScrollRef = useRef<HTMLDivElement>(null);
  const planRef = useRef(plan);
  planRef.current = plan;
  const aiAbort = useRef<AbortController | null>(null);
  const panRef = useRef<{ x: number; y: number; camX: number; camY: number } | null>(null);
  const fitRef = useRef<() => void>(() => {});

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

  const layout = useMemo(() => {
    const map = childMap(agents);
    const widths = new Map<string, number>();
    const measured = new Set<string>();
    const measure = (a: PlanAgent): number => {
      if (measured.has(a.id)) return NODE_W;
      measured.add(a.id);
      const ch = map.get(a.id) ?? [];
      let w = NODE_W;
      if (ch.length) w = Math.max(NODE_W, ch.reduce((s, c) => s + measure(c), 0) + GAP_X * (ch.length - 1));
      widths.set(a.id, w);
      return w;
    };
    const roots = map.get(null) ?? [];
    for (const r of roots) measure(r);
    const nodes: ChartNode[] = [];
    const placed = new Set<string>();
    const place = (a: PlanAgent, left: number, depth: number) => {
      if (placed.has(a.id)) return;
      placed.add(a.id);
      const w = widths.get(a.id) ?? NODE_W;
      nodes.push({ agent: a, x: left + (w - NODE_W) / 2, y: depth * (NODE_H + GAP_Y), depth });
      let cx = left;
      for (const c of map.get(a.id) ?? []) {
        place(c, cx, depth + 1);
        cx += (widths.get(c.id) ?? NODE_W) + GAP_X;
      }
    };
    let left = 0;
    for (const r of roots) {
      place(r, left, 0);
      left += (widths.get(r.id) ?? NODE_W) + GAP_X * 2;
    }
    const minX = nodes.length ? Math.min(...nodes.map((n) => n.x)) : 0;
    const minY = nodes.length ? Math.min(...nodes.map((n) => n.y)) : 0;
    for (const n of nodes) {
      n.x += 60 - minX;
      n.y += 60 - minY;
    }
    const pos = new Map(nodes.map((n) => [n.agent.id, n]));
    const edges: Array<{ from: ChartNode; to: ChartNode }> = [];
    for (const n of nodes) {
      for (const c of map.get(n.agent.id) ?? []) {
        const cn = pos.get(c.id);
        if (cn) edges.push({ from: n, to: cn });
      }
    }
    const maxX = nodes.length ? Math.max(...nodes.map((n) => n.x)) : 0;
    const maxY = nodes.length ? Math.max(...nodes.map((n) => n.y)) : 0;
    return {
      nodes,
      edges,
      w: Math.max(360, maxX - 60 + NODE_W + 120),
      h: Math.max(260, maxY - 60 + NODE_H + 120),
      empty: nodes.length === 0,
    };
  }, [agents]);

  const fitView = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const zoom = clampZoom(Math.min(1, (r.width - 48) / layout.w, (r.height - 48) / layout.h));
    setCam({ x: (r.width - layout.w * zoom) / 2, y: (r.height - layout.h * zoom) / 2, zoom });
  }, [layout]);
  fitRef.current = fitView;

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
    if (view !== 'chart') return;
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left;
        const py = e.clientY - r.top;
        setCam((c) => {
          const zoom = clampZoom(c.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
          const k = zoom / c.zoom;
          return { zoom, x: px - (px - c.x) * k, y: py - (py - c.y) * k };
        });
      } else {
        setCam((c) => ({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view]);

  useEffect(() => {
    if (view !== 'chart') return;
    const raf = window.requestAnimationFrame(() => fitRef.current());
    return () => window.cancelAnimationFrame(raf);
  }, [view]);

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

  const addAgent = (parentId: string | null, afterId?: string) => {
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
      list.splice(at, 0, agent);
      return { ...p, agents: list };
    });
    if (parentId) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(parentId);
        return next;
      });
    }
    setView('plan');
    setFocusId(id);
  };

  const addSibling = (id: string) => {
    const node = byId.get(id);
    if (node) addAgent(node.parentId, id);
  };

  const addChild = (id: string) => addAgent(id);

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
      };
    });
    setExpandedId((v) => (v === id ? null : v));
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

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
    setPlan((p) => ({ ...p, agents: agentsNext }));
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
      await navigator.clipboard.writeText(toMarkdown(plan, t('company.title'), t('company.newName')));
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
      if (!next.length) { setAiError(t('company.aiFailed')); return; }
      setPlan((p) => ({
        ...p,
        agents: next.map((a) => ({ ...a, model: a.model || activeModel })),
      }));
      setExpandedId(null);
      setCollapsed(new Set());
      setFocusId(null);
      setView('plan');
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

  const startPan = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panRef.current = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y };
  };

  const movePan = (e: RPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p) return;
    setCam((c) => ({ ...c, x: p.camX + e.clientX - p.x, y: p.camY + e.clientY - p.y }));
  };

  const endPan = (e: RPointerEvent<HTMLDivElement>) => {
    panRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
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
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-[#0F0E0E] text-[#E8E4DA]">
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
            {v === 'plan' ? t('company.plan') : v === 'chart' ? t('company.chart') : t('company.office')}
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
          <button type="button" onClick={() => addAgent(null)} className={PRIMARY}>
            <Plus size={12} />
            {t('company.add')}
          </button>
        </div>
      </div>

      {view === 'plan' ? (
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
      ) : view === 'chart' ? (
        <div
          ref={canvasRef}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          className="relative min-h-0 flex-1 cursor-grab select-none overflow-hidden bg-[#0D0C0C] active:cursor-grabbing"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px)',
            backgroundSize: '32px 32px',
          }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`, width: layout.w, height: layout.h }}
          >
            <svg width={layout.w} height={layout.h} className="absolute left-0 top-0 overflow-visible">
              {layout.edges.map((e) => {
                const x1 = e.from.x + NODE_W / 2;
                const y1 = e.from.y + NODE_H;
                const x2 = e.to.x + NODE_W / 2;
                const y2 = e.to.y;
                const mid = y1 + (y2 - y1) / 2;
                return (
                  <path
                    key={`${e.from.agent.id}-${e.to.agent.id}`}
                    d={`M ${x1} ${y1} V ${mid} H ${x2} V ${y2}`}
                    fill="none"
                    stroke="#2E2B26"
                    strokeWidth={1.25}
                  />
                );
              })}
            </svg>
            {layout.nodes.map((n) => {
              const root = !n.agent.parentId;
              return (
                <div
                  key={n.agent.id}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => openInPlan(n.agent.id)}
                  style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
                  className={`absolute flex cursor-pointer flex-col justify-center rounded-[4px] border bg-[#151412] px-2.5 hover:bg-[#191816] ${
                    root ? 'border-[#3A3429] hover:border-[#4E463A]' : 'border-[#282620] hover:border-[#3C3830]'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${root ? 'bg-[#dcb67a]' : 'bg-[#4385BE]'}`} />
                    <span className="truncate text-[11.5px] font-medium text-[#E8E4DA]">
                      {n.agent.name || t('company.newName')}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate pl-3 text-[9.5px] text-[#8C877B]">
                    {n.agent.role || t('company.roleDefault')}
                  </div>
                </div>
              );
            })}
          </div>
          {layout.empty && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 px-6 text-center">
              <p className="text-[11px] text-[#7C776B]">{t('company.emptyPlan')}</p>
              <button type="button" onClick={() => addAgent(null)} className={PRIMARY}>
                <Plus size={12} />
                {t('company.firstAgent')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden bg-[#20242c]">
          <PixelOffice
            agents={agents}
            selected={null}
            onSelect={(id) => { if (id) openInPlan(id); }}
          />
          {agents.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-[#6E6B66]">
              {t('company.emptyOffice')}
            </div>
          )}
        </div>
      )}

      <div className="flex h-6 shrink-0 items-center gap-2 border-t border-[#24221F] px-2 text-[9.5px] text-[#7C776B]">
        <span className="shrink-0 whitespace-nowrap">
          {t('company.agentCount', { n: agents.length })} · {t('company.levelCount', { n: levels })}
        </span>
        {copied && <span className="shrink-0 text-[#dcb67a]">{t('company.copied')}</span>}
        <span className="ml-auto flex min-w-0 items-center gap-2 overflow-hidden">
          {view === 'chart' && (
            <>
              <span className="shrink-0 tabular-nums">{Math.round(cam.zoom * 100)}%</span>
              <button type="button" onClick={fitView} className="shrink-0 hover:text-[#E8E4DA]">
                {t('company.fit')}
              </button>
            </>
          )}
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

