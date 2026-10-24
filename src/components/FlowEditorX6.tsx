/**
 * X6 tabanlı Flow editörü (MIT, attribution gerektirmez).
 *
 * Aynı veri modelini kullanır: ajanlar ağaçtır (parentId). X6 node'ları
 * React ile çizilir (`@antv/x6-react-shape`), portlar X6'nın kendi port
 * sistemiyle gelir; sürükleme/bağlama/seçme X6 olaylarıyla plana yazılır.
 *
 * React Flow sürümü (FlowEditor.tsx) karşılaştırma için duruyor;
 * AgentCompany'de USE_X6_FLOW ile seçilir.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Graph, Shape, type Edge as X6Edge, type Node as X6Node } from '@antv/x6';
import { register } from '@antv/x6-react-shape';
import dagre from '@dagrejs/dagre';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { useT } from '../lib/i18n';
import { agentHeadDataUrl } from './PixelOffice';
import type { AgentLink, PlanAgent } from './AgentCompany';

const NODE_W = 216;
const NODE_H = 82;
const GRID = 16;
/* Göz aldan "yapay zekâ gökkuşağı" paleti kaldırıldı: düğümler tek bir sıcak
   kalem (altın) + nötr taş tonlarıyla çizilir; ajanın yüzü OFİSTEKİ pixel-art
   kimliğidir (PixelOffice sprite'ının baş bölümü) — aynı ajan = aynı yüz. */
const ACCENT = '#dcb67a';
const EDGE_COLOR = '#514E48';
const LINK_COLOR = '#57534A';

type AgentData = { agent: PlanAgent; selected: boolean; order: number; linking: boolean };

const headUrlCache = new Map<string, string>();
function headUrl(id: string): string {
  const hit = headUrlCache.get(id);
  if (hit) return hit;
  const url = agentHeadDataUrl(id);
  headUrlCache.set(id, url);
  return url;
}

function AgentCard({ node }: { node: X6Node }) {
  const t = useT();
  const data = (node.getData() || {}) as Partial<AgentData>;
  const agent = data.agent;
  if (!agent) return null;
  const selected = !!data.selected;
  const linking = !!data.linking;
  return (
    <div
      data-flow-node={agent.id}
      title={agent.mission || agent.name}
      className={`relative flex h-full w-full items-center gap-2.5 rounded-md border bg-[#161513] px-3 py-2.5 shadow-[0_10px_28px_-18px_rgba(0,0,0,0.95)] ${
        linking ? 'cursor-crosshair' : ''
      }`}
      style={{
        borderColor: selected || linking ? ACCENT : '#2A2825',
        boxShadow: selected || linking ? `0 0 0 1px ${ACCENT}55, 0 10px 28px -18px rgba(0,0,0,.95)` : undefined,
      }}
    >
      {/* Yüz + hiyerarşi sırası: numara avatarın sol üst köşesine bitişik. */}
      <span className="relative shrink-0">
        <img
          src={headUrl(agent.id)}
          alt=""
          width={36}
          height={36}
          className="h-9 w-9 rounded-[5px] border border-black/40"
          style={{ imageRendering: 'pixelated' }}
        />
        <span
          title={t('company.rankTitle')}
          className="absolute -left-2 -top-2 grid h-[18px] min-w-[18px] place-items-center rounded-[4px] border border-[#3A3835] bg-[#0F0E0E] px-1 text-[8.5px] font-medium leading-none tabular-nums text-[#C9C4B8]"
        >
          {data.order}
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-semibold leading-tight text-[#EDE9DD]">{agent.name || '—'}</div>
        <div className="truncate text-[10px] leading-tight text-[#8C877B]">{agent.role || t('company.roleDefault')}</div>
        {agent.mission && (
          <div className="mt-1 line-clamp-2 text-[9.5px] leading-snug text-[#6B675D]">{agent.mission}</div>
        )}
      </div>
    </div>
  );
}

let registered = false;
function ensureShape() {
  if (registered) return;
  registered = true;
  register({
    shape: 'thalamus-agent',
    width: NODE_W,
    height: NODE_H,
    component: AgentCard,
    effect: ['data'],
    attrs: { body: { fill: 'transparent', stroke: 'none' } },
  } as never);
}

const PORT_CONFIG = {
  groups: {
    in: {
      position: 'top',
      attrs: {
        /* r 4.5 → 5.5: ufak port noktasını hedeflemek kolaylaşsın; snap
           radius + magnet vurgusu ile birlikte "nokta atışı" bağlanır. */
        circle: { r: 5.5, magnet: true, stroke: '#0F0E0E', strokeWidth: 2, fill: '#57544E', cursor: 'crosshair' },
      },
    },
    out: {
      position: 'bottom',
      attrs: {
        circle: { r: 5.5, magnet: true, stroke: '#0F0E0E', strokeWidth: 2, fill: '#dcb67a', cursor: 'crosshair' },
      },
    },
  },
  items: [
    { id: 'in', group: 'in' },
    { id: 'out', group: 'out' },
  ],
};

/** X6 3.x bazı remove/add döngülerinde edge view'ını DOM'da bırakıyor.
 *  Model doğru olduğu için view'ı modele senkronluyoruz. Kopyalardan
 *  X6'nın sahibi olduğu CANLI view (findViewByCell) tutulur; bayat olan
 *  silinir. İlkini tutarsak canlı view'ın DOM'u gidiyor ve X6 artık
 *  görünmeyen elemanı güncellediği için çizgi eski yerinde donuk kalıyor. */
function syncEdgeViews(graph: Graph) {
  const live = new Set<Element>();
  for (const e of graph.getEdges()) {
    const view = graph.findViewByCell(e);
    const el = (view as { container?: Element } | null)?.container;
    if (el) live.add(el);
  }
  for (const el of Array.from(document.querySelectorAll<Element>('.x6-thalamus .x6-edge'))) {
    if (!live.has(el)) el.remove();
  }
}

function labelItem(text: string) {
  return {
    attrs: {
      label: {
        text,
        fill: '#BDB6A8',
        fontSize: 9.5,
        textAnchor: 'middle',
        textVerticalAnchor: 'middle',
        pointerEvents: 'none',
      },
      body: { fill: '#111010', stroke: '#2A2825', rx: 4, ry: 4 },
    },
    position: 0.5,
  };
}

/** Kart verisini yalnız gerçekten değişen düğümlere yaz (seçim/link modu
 *  değişiminde tüm kartların yeniden render edilmesini önler). */
function syncNodeData(graph: Graph, agents: PlanAgent[], make: (a: PlanAgent) => AgentData) {
  for (const a of agents) {
    const cell = graph.getCellById(a.id);
    if (!cell || !cell.isNode()) continue;
    const next = make(a);
    const prev = cell.getData() as AgentData | undefined;
    if (
      prev
      && prev.agent === next.agent
      && prev.selected === next.selected
      && prev.order === next.order
      && prev.linking === next.linking
    ) continue;
    (cell as X6Node).setData(next);
  }
}

function replaceEdges(
  graph: Graph,
  agents: PlanAgent[],
  links: AgentLink[],
  selectedEdgeId: string | null,
  selectedLinkId: string | null
) {
  const ids = new Set(agents.map((a) => a.id));
  const desired = new Map<string, PlanAgent>();
  for (const a of agents) {
    if (a.parentId && ids.has(a.parentId)) desired.set(a.id, a);
  }
  const desiredLinks = new Map<string, AgentLink>();
  for (const l of links) {
    if (ids.has(l.from) && ids.has(l.to) && l.from !== l.to) desiredLinks.set(l.id, l);
  }
  const existing = new Map<string, X6Edge>();
  const existingLinks = new Map<string, X6Edge>();
  let mutated = false;
  for (const e of graph.getEdges()) {
    const d = (e.getData() || {}) as { childId?: string; linkId?: string };
    if (d.linkId && desiredLinks.has(d.linkId) && !existingLinks.has(d.linkId)) {
      existingLinks.set(d.linkId, e);
      continue;
    }
    if (d.childId && desired.has(d.childId) && !existing.has(d.childId)) {
      existing.set(d.childId, e);
      continue;
    }
    graph.removeEdge(e);
    mutated = true;
  }
  for (const [childId, a] of desired) {
    const selected = selectedEdgeId === childId;
    const stroke = selected ? '#D14D41' : EDGE_COLOR;
    const existingEdge = existing.get(childId);
    if (existingEdge) {
      // Silip yeniden eklemek X6 view'ında kopya bırakıyor; yerinde güncelle.
      if (existingEdge.getSourceCellId() !== a.parentId) {
        existingEdge.setSource({ cell: a.parentId as string, port: 'out' });
      }
      if (existingEdge.getTargetCellId() !== childId) {
        existingEdge.setTarget({ cell: childId, port: 'in' });
      }
      if (existingEdge.attr('line/stroke') !== stroke) {
        existingEdge.attr('line/stroke', stroke);
        existingEdge.attr('line/strokeWidth', selected ? 2 : 1.4);
      }
      continue;
    }
    graph.addEdge({
      id: `${a.parentId}->${a.id}`,
      source: { cell: a.parentId as string, port: 'out' },
      target: { cell: a.id, port: 'in' },
      data: { childId: a.id },
      connector: { name: 'smooth' },
      attrs: {
        line: {
          stroke,
          strokeWidth: selected ? 2 : 1.4,
          /* X6 varsayılan klasik ok başını kapat. */
          targetMarker: null,
        },
      },
    });
    mutated = true;
  }
  for (const [id, l] of desiredLinks) {
    const selected = selectedLinkId === id;
    const stroke = selected ? ACCENT : LINK_COLOR;
    const labelText = l.label.trim();
    const ex = existingLinks.get(id);
    if (ex) {
      if (ex.getSourceCellId() !== l.from) ex.setSource({ cell: l.from });
      if (ex.getTargetCellId() !== l.to) ex.setTarget({ cell: l.to });
      if (ex.attr('line/stroke') !== stroke) {
        ex.attr('line/stroke', stroke);
        ex.attr('line/strokeWidth', selected ? 2 : 1.2);
        ex.attr('line/targetMarker/fill', stroke);
      }
      const first = ex.getLabels()[0] as { attrs?: { label?: { text?: string } } } | undefined;
      if ((first?.attrs?.label?.text ?? '') !== labelText) {
        ex.setLabels(labelText ? [labelItem(labelText)] : []);
      }
      continue;
    }
    graph.addEdge({
      id: `link:${id}`,
      source: { cell: l.from },
      target: { cell: l.to },
      data: { linkId: id },
      connector: { name: 'smooth' },
      attrs: {
        line: {
          stroke,
          strokeWidth: selected ? 2 : 1.2,
          strokeDasharray: '5 4',
          sourceMarker: null,
          targetMarker: { name: 'classic', size: 7, fill: stroke },
        },
      },
      labels: labelText ? [labelItem(labelText)] : [],
    });
    mutated = true;
  }
  if (mutated) {
    window.setTimeout(() => syncEdgeViews(graph), 0);
    window.setTimeout(() => syncEdgeViews(graph), 90);
  }
}

function computePositions(agents: PlanAgent[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const ids = new Set(agents.map((a) => a.id));
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 44, ranksep: 74, marginx: 24, marginy: 24 });
  for (const a of agents) g.setNode(a.id, { width: NODE_W, height: NODE_H });
  for (const a of agents) if (a.parentId && ids.has(a.parentId)) g.setEdge(a.parentId, a.id);
  dagre.layout(g);
  for (const a of agents) {
    const n = g.node(a.id);
    positions.set(a.id, { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 });
  }
  for (const a of agents) {
    if (Number.isFinite(a.x) && Number.isFinite(a.y)) positions.set(a.id, { x: a.x as number, y: a.y as number });
  }
  return positions;
}

export interface FlowEditorX6Props {
  agents: PlanAgent[];
  links: AgentLink[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  selectedLinkId: string | null;
  fitNonce: number;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (childId: string | null) => void;
  onSelectLink: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onDragStart: () => void;
  onLink: (from: string, to: string) => void;
  onRequestLink: (from: string, to: string) => void;
  onDetach: (childId: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onAddChild: (id: string) => void;
  onOpenPlan: (id: string) => void;
}

export function FlowEditorX6(props: FlowEditorX6Props) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const [ready, setReady] = useState(false);
  const propsRef = useRef(props);
  propsRef.current = props;
  const selectedNodeRef = useRef(props.selectedNodeId);
  selectedNodeRef.current = props.selectedNodeId;
  const selectedEdgeRef = useRef(props.selectedEdgeId);
  selectedEdgeRef.current = props.selectedEdgeId;
  /** Sağ tıkla başlatılan bağlantının kaynağı. */
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const linkFromRef = useRef<string | null>(null);
  linkFromRef.current = linkFrom;
  const applyingRef = useRef(false);
  const dragTimerRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  /** En son uygulanan hiyerarşi/konum anahtarı (link değişiminde dagre'yi atla). */
  const appliedLayoutKeyRef = useRef<string | null>(null);

  /* Numaralandırma: seviye sırasına göre tekil sıra. En üst hiyerarşi 1,
     alt seviyelere indikçe sayı artar. Aynı seviyede soldan sağa ilerler. */
  const orderMap = useMemo(() => {
    const m = new Map<string, number>();
    const ids = new Set(props.agents.map((a) => a.id));
    const kids = new Map<string | null, PlanAgent[]>();
    for (const a of props.agents) {
      const pid = a.parentId && a.parentId !== a.id && ids.has(a.parentId) ? a.parentId : null;
      const arr = kids.get(pid);
      if (arr) arr.push(a); else kids.set(pid, [a]);
    }
    const seen = new Set<string>();
    let frontier = kids.get(null) ?? [];
    let n = 1;
    while (frontier.length) {
      const next: PlanAgent[] = [];
      for (const a of frontier) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        m.set(a.id, n++);
        next.push(...(kids.get(a.id) ?? []));
      }
      frontier = next;
    }
    for (const a of props.agents) if (!m.has(a.id)) m.set(a.id, n++);
    return m;
  }, [props.agents]);

  const nodeData = useCallback(
    (a: PlanAgent): AgentData => ({
      agent: a,
      selected: selectedNodeRef.current === a.id,
      order: orderMap.get(a.id) ?? 0,
      linking: linkFromRef.current === a.id,
    }),
    [orderMap]
  );

  // Graph bir kez kurulur; olaylar propsRef üzerinden güncel callbacks'e gider.
  useEffect(() => {
    ensureShape();
    const container = containerRef.current;
    if (!container) return;
    const graph = new Graph({
      container,
      autoResize: true,
      background: { color: '#0D0C0C' },
      grid: { size: GRID, visible: true, type: 'dot', args: { color: '#2A2927' } },
      panning: { enabled: true, eventTypes: ['leftMouseDown'] },
      mousewheel: { enabled: true, modifiers: [], minScale: 0.2, maxScale: 2, zoomAtMousePosition: true },
      interacting: { edgeMovable: false, nodeMovable: true, edgeLabelMovable: false },
      connecting: {
        /* Port çapına yakınınca hat port ortasına kilitlenir. */
        snap: { radius: 44 },
        allowBlank: false,
        allowLoop: false,
        allowNode: false,
        allowMulti: false,
        highlight: false,
        connector: { name: 'smooth' },
        anchor: 'center',
        connectionPoint: 'anchor',
        /* Sürükleme önizlemesinde de ok başı olmasın. */
        createEdge: () => new Shape.Edge({
          attrs: {
            line: {
              stroke: ACCENT,
              strokeWidth: 1.4,
              targetMarker: null,
            },
          },
          connector: { name: 'smooth' },
        }),
        validateConnection: ({ sourceCell, targetCell, sourcePort, targetPort }) => {
          if (!sourceCell || !targetCell || sourceCell.id === targetCell.id) return false;
          if (sourcePort !== 'out' || targetPort !== 'in') return false;
          const agents = propsRef.current.agents;
          const parent = new Map(agents.map((a) => [a.id, a.parentId]));
          let p = parent.get(sourceCell.id) ?? null;
          const seen = new Set<string>();
          while (p) {
            if (p === targetCell.id) return false;
            if (seen.has(p)) break;
            seen.add(p);
            p = parent.get(p) ?? null;
          }
          return true;
        },
      },
    });
    graphRef.current = graph;
    setReady(true);

    graph.on('node:click', ({ node }) => {
      const from = linkFromRef.current;
      if (from && from !== node.id) {
        /* Sağ tıkla başlatılan bağlantı hedefe tıklayınca kurulur. */
        setLinkFrom(null);
        propsRef.current.onRequestLink(from, node.id);
        return;
      }
      if (from === node.id) {
        setLinkFrom(null);
        return;
      }
      propsRef.current.onSelectNode(node.id);
    });
    graph.on('node:contextmenu', ({ e, node }) => {
      e.preventDefault();
      /* Aynı karta sağ tık: bağlantı modunu kapat. */
      setLinkFrom((cur) => (cur === node.id ? null : node.id));
      propsRef.current.onSelectNode(null);
      propsRef.current.onSelectEdge(null);
      propsRef.current.onSelectLink(null);
    });
    graph.on('blank:contextmenu', ({ e }) => {
      e.preventDefault();
      if (linkFromRef.current) setLinkFrom(null);
    });
    graph.on('edge:click', ({ edge }) => {
      if (linkFromRef.current) {
        setLinkFrom(null);
        return;
      }
      const d = (edge.getData() || {}) as { childId?: string; linkId?: string };
      if (d.linkId) propsRef.current.onSelectLink(d.linkId);
      else if (d.childId) propsRef.current.onSelectEdge(d.childId);
    });
    graph.on('blank:click', () => {
      if (linkFromRef.current) {
        setLinkFrom(null);
        return;
      }
      propsRef.current.onSelectNode(null);
      propsRef.current.onSelectEdge(null);
      propsRef.current.onSelectLink(null);
    });
    graph.on('node:change:position', ({ node }) => {
      if (applyingRef.current) return;
      if (!draggingRef.current) {
        draggingRef.current = true;
        propsRef.current.onDragStart();
      }
      if (dragTimerRef.current !== null) window.clearTimeout(dragTimerRef.current);
      dragTimerRef.current = window.setTimeout(() => {
        dragTimerRef.current = null;
        draggingRef.current = false;
        const p = node.position();
        propsRef.current.onMove(node.id, Math.round(p.x), Math.round(p.y));
      }, 160);
    });
    graph.on('edge:connected', ({ edge, isNew }) => {
      if (!isNew) return;
      setLinkFrom(null);
      const source = edge.getSourceCellId();
      const target = edge.getTargetCellId();
      // X6'ın geçici kenarını SENKRON kaldır; aksi halde view'da kopya kalıyor.
      try { edge.remove(); } catch { /* already gone */ }
      window.setTimeout(() => syncEdgeViews(graph), 220);
      if (source && target) propsRef.current.onLink(source, target);
    });

    const timer = window.setTimeout(() => {
      graph.zoomToFit({ padding: 32, maxScale: 1 });
    }, 120);

    /* Kapsayıcı yeniden boyutlandığında (ör. sağ panel katlanınca flow
       büyür) X6 canvas'ı YENİDEN BOYUTLANDIR ve içeriği görünüme sığdır.
       X6'nın autoResize'i yalnız pencere resize'ını dinler; panel katlanması
       pencere resize'ı olmadığı için canvas eski boyutta kalıyordu ve
       genişleyen alan boş görünüyordu. */
    let refitTimer: number | undefined;
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      /* Gizliyken (0×0) boyut değişimi sayılmaz; görünür olunca sığdır. */
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      graph.resize(rect.width, rect.height);
      const firstReveal = lastW === 0;
      const sizeChanged = firstReveal
        || Math.abs(rect.width - lastW) > 1
        || Math.abs(rect.height - lastH) > 1;
      lastW = rect.width;
      lastH = rect.height;
      /* Yalnız görünürlük değiştiyse kullanıcının pan/zoom'u korunur. */
      if (!sizeChanged) return;
      if (propsRef.current.agents.length === 0) return;
      /* İlk görünürlükte beklemeden sığdır (flash olmasın). */
      if (firstReveal) {
        graph.zoomToFit({ padding: 32, maxScale: 1 });
        return;
      }
      if (refitTimer !== undefined) window.clearTimeout(refitTimer);
      refitTimer = window.setTimeout(() => {
        graph.zoomToFit({ padding: 32, maxScale: 1 });
      }, 180);
    });
    ro.observe(container);

    return () => {
      window.clearTimeout(timer);
      if (refitTimer !== undefined) window.clearTimeout(refitTimer);
      ro.disconnect();
      if (dragTimerRef.current !== null) window.clearTimeout(dragTimerRef.current);
      graph.dispose();
      graphRef.current = null;
      setReady(false);
    };
  }, []);

  const agentsKey = props.agents
    .map((a) => `${a.id}|${a.parentId ?? ''}|${a.x ?? ''},${a.y ?? ''}`)
    .join(';');
  const linksKey = props.links
    .map((l) => `${l.id}|${l.from}|${l.to}|${l.label}`)
    .join(';');
  const structuralKey = `${agentsKey}||${linksKey}`;
  const dataKey = props.agents.map((a) => `${a.id}|${a.name}|${a.role}|${a.model}|${a.mission}`).join(';');

  // Node/edge iskeleti: yalnız yapı/konum değişince.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    applyingRef.current = true;
    try {
      /* Yalnız hiyerarşi/konum değiştiyse dagre + düğüm işlemleri.
         Link etiketi/durumu değişimi yalnız kenarları günceller. */
      if (appliedLayoutKeyRef.current !== agentsKey) {
        appliedLayoutKeyRef.current = agentsKey;
        const ids = new Set(props.agents.map((a) => a.id));
        for (const n of graph.getNodes()) if (!ids.has(n.id)) graph.removeNode(n);
        /* Kenarları burada toplu silip yeniden eklemiyoruz: her sürükleme
           bırakışında remove/add döngüsü X6 3.x'te bayat view bırakıp çizgileri
           eski konumda donduruyor. replaceEdges farkı yerinde günceller. */
        const positions = computePositions(props.agents);
        for (const a of props.agents) {
          const pos = positions.get(a.id) ?? { x: 24, y: 24 };
          const existing = graph.getCellById(a.id);
          if (existing && existing.isNode()) {
            const n = existing as X6Node;
            if (Math.round(n.position().x) !== Math.round(pos.x) || Math.round(n.position().y) !== Math.round(pos.y)) {
              n.position(pos.x, pos.y);
            }
          } else {
            graph.addNode({
              id: a.id,
              shape: 'thalamus-agent',
              x: pos.x,
              y: pos.y,
              width: NODE_W,
              height: NODE_H,
              data: nodeData(a),
              ports: PORT_CONFIG,
            });
          }
        }
      }
      syncNodeData(graph, props.agents, nodeData);
      replaceEdges(graph, props.agents, props.links, selectedEdgeRef.current, propsRef.current.selectedLinkId);
    } finally {
      applyingRef.current = false;
    }
  }, [structuralKey, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Metin/rol/model değişimi: node'ları yeniden kurmadan data güncelle.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    syncNodeData(graph, props.agents, nodeData);
  }, [dataKey, nodeData, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bağlantı modu: kaynak kartın vurgusu ve imleç.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    syncNodeData(graph, props.agents, nodeData);
  }, [linkFrom, props.agents, nodeData, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seçim yalnız data/attr günceller.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    syncNodeData(graph, props.agents, nodeData);
    for (const e of graph.getEdges()) {
      const d = (e.getData() || {}) as { childId?: string; linkId?: string };
      if (d.linkId) {
        const sel = d.linkId === props.selectedLinkId;
        const stroke = sel ? ACCENT : LINK_COLOR;
        if (e.attr('line/stroke') !== stroke) {
          e.attr('line/stroke', stroke);
          e.attr('line/strokeWidth', sel ? 2 : 1.2);
          e.attr('line/targetMarker/fill', stroke);
        }
        continue;
      }
      const sel = !!d.childId && d.childId === props.selectedEdgeId;
      const stroke = sel ? '#D14D41' : EDGE_COLOR;
      if (e.attr('line/stroke') !== stroke) {
        e.attr('line/stroke', stroke);
        e.attr('line/strokeWidth', sel ? 2 : 1.4);
      }
    }
  }, [props.selectedNodeId, props.selectedEdgeId, props.selectedLinkId, nodeData, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready || !props.fitNonce) return;
    const id = window.setTimeout(() => graph.zoomToFit({ padding: 32, maxScale: 1 }), 80);
    return () => window.clearTimeout(id);
  }, [props.fitNonce, ready]);

  useEffect(() => {
    if (!linkFrom) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLinkFrom(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linkFrom]);

  const fit = useCallback(() => graphRef.current?.zoomToFit({ padding: 32, maxScale: 1 }), []);
  const zoom = useCallback((delta: number) => graphRef.current?.zoom(delta), []);
  const linkSource = linkFrom ? props.agents.find((a) => a.id === linkFrom) : null;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className={`x6-thalamus h-full w-full ${linkFrom ? 'cursor-crosshair' : ''}`} />

      <div className="pointer-events-none absolute left-2 top-2 z-10 max-w-[250px] rounded-md border border-[#2C2A26] bg-[#151412]/90 px-2 py-1 text-[9.5px] leading-snug text-[#8C877B]">
        {t('company.flowHelp')}
      </div>

      {linkFrom && (
        <div className="absolute left-1/2 top-2 z-20 flex max-w-[420px] -translate-x-1/2 items-center gap-2 rounded-md border border-[#3A3835] bg-[#1D1B18] px-2.5 py-1 text-[10px] text-[#E8E4DA] shadow-lg">
          <span className="min-w-0 truncate">
            {t('company.linkModeFrom', { name: linkSource?.name || t('company.newName') })}
          </span>
          <button
            type="button"
            onClick={() => setLinkFrom(null)}
            className="shrink-0 rounded px-1 text-[10px] text-[#8C877B] hover:bg-[#2A2825] hover:text-[#F2F0E5] cursor-pointer"
          >
            {t('company.cancel')}
          </button>
        </div>
      )}

      <div className="absolute bottom-3 left-3 z-10 flex flex-col overflow-hidden rounded-lg border border-[#2C2A26] bg-[#151412]">
        <button type="button" onClick={() => zoom(0.12)} title="Zoom in" className="grid h-7 w-7 place-items-center border-b border-[#24221F] text-[#A8A397] hover:bg-[#1D1B18] cursor-pointer">
          <Plus size={12} />
        </button>
        <button type="button" onClick={() => zoom(-0.12)} title="Zoom out" className="grid h-7 w-7 place-items-center border-b border-[#24221F] text-[#A8A397] hover:bg-[#1D1B18] cursor-pointer">
          <Minus size={12} />
        </button>
        <button type="button" onClick={fit} title="Fit" className="grid h-7 w-7 place-items-center text-[#A8A397] hover:bg-[#1D1B18] cursor-pointer">
          <Maximize2 size={11} />
        </button>
      </div>

      {props.agents.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <span className="text-[11.5px] text-[#A8A397]">{t('company.emptyPlan')}</span>
          <button
            type="button"
            onClick={props.onAdd}
            className="flex items-center gap-1 rounded-md bg-[#dcb67a] px-2.5 py-1 text-[10.5px] font-medium text-[#141210] hover:bg-[#EBCB99] cursor-pointer"
          >
            <Plus size={11} /> {t('company.firstAgent')}
          </button>
        </div>
      )}

      {props.selectedNodeId && (
        <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
          <button
            type="button"
            onClick={() => props.onAddChild(props.selectedNodeId as string)}
            className="flex items-center gap-1 rounded-md border border-[#3A3835] bg-[#1D1B18] px-2.5 py-1 text-[10.5px] text-[#E8E4DA] shadow-lg hover:bg-[#26241F] cursor-pointer"
          >
            <Plus size={10} /> {t('company.addChild')}
          </button>
        </div>
      )}
    </div>
  );
}
