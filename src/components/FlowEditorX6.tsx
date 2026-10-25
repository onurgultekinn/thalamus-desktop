/**
 * X6 tabanlÄ± Flow editÃ¶rÃ¼ (MIT, attribution gerektirmez).
 *
 * AynÄ± veri modelini kullanÄ±r: ajanlar aÄŸaÃ§tÄ±r (parentId). X6 node'larÄ±
 * React ile Ã§izilir (`@antv/x6-react-shape`), portlar X6'nÄ±n kendi port
 * sistemiyle gelir; sÃ¼rÃ¼kleme/baÄŸlama/seÃ§me X6 olaylarÄ±yla plana yazÄ±lÄ±r.
 *
 * React Flow sÃ¼rÃ¼mÃ¼ (FlowEditor.tsx) karÅŸÄ±laÅŸtÄ±rma iÃ§in duruyor;
 * AgentCompany'de USE_X6_FLOW ile seÃ§ilir.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Graph, Shape, type Edge as X6Edge, type Node as X6Node } from '@antv/x6';
import { register } from '@antv/x6-react-shape';
import dagre from '@dagrejs/dagre';
import { Link2, Maximize2, Minus, Network, Plus } from 'lucide-react';
import { useT } from '../lib/i18n';
import { agentHeadDataUrl } from './PixelOffice';
import type { AgentLink, PlanAgent } from './AgentCompany';

const NODE_W = 216;
const NODE_H = 82;
const HIERARCHY_PORT_INSET = 14;
const GRID = 16;
/* GÃ¶z aldan "yapay zekÃ¢ gÃ¶kkuÅŸaÄŸÄ±" paleti kaldÄ±rÄ±ldÄ±: dÃ¼ÄŸÃ¼mler tek bir sÄ±cak
   kalem (altÄ±n) + nÃ¶tr taÅŸ tonlarÄ±yla Ã§izilir; ajanÄ±n yÃ¼zÃ¼ OFÄ°STEKÄ° pixel-art
   kimliÄŸidir (PixelOffice sprite'Ä±nÄ±n baÅŸ bÃ¶lÃ¼mÃ¼) â€” aynÄ± ajan = aynÄ± yÃ¼z. */
const ACCENT = '#dcb67a';
const EDGE_COLOR = '#4A4741';
const LINK_COLOR = '#5FA3AE';

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
      {/* YÃ¼z + hiyerarÅŸi sÄ±rasÄ±: numara avatarÄ±n sol Ã¼st kÃ¶ÅŸesine bitiÅŸik. */}
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
        <div className="truncate text-[12px] font-semibold leading-tight text-[#EDE9DD]">{agent.name || 'â€”'}</div>
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

const LINK_LEFT_PORTS = ['link-left-a', 'link-left-b', 'link-left-c'] as const;
const LINK_RIGHT_PORTS = ['link-right-a', 'link-right-b', 'link-right-c'] as const;
const LINK_PORT_SLOTS = [
  { x: 0, y: '35%' },
  { x: 0, y: '50%' },
  { x: 0, y: '65%' },
] as const;
const LINK_PORT_SLOTS_RIGHT = [
  { x: '100%', y: '35%' },
  { x: '100%', y: '50%' },
  { x: '100%', y: '65%' },
] as const;

const PORT_CONFIG = {
  groups: {
    in: {
      position: { name: 'absolute' as const, args: { x: '50%', y: HIERARCHY_PORT_INSET } },
      attrs: {
        /* Portlar görünmez; uçlar kartın 14px içine girer, çizgi ucu
           kartın arkasında kalır. Sürükleyerek bağlama kapalıdır. */
        circle: { r: 6, magnet: false, stroke: 'transparent', strokeWidth: 0, fill: 'transparent', cursor: 'default' },
      },
    },
    out: {
      position: { name: 'absolute' as const, args: { x: '50%', y: NODE_H - HIERARCHY_PORT_INSET } },
      attrs: {
        circle: { r: 6, magnet: false, stroke: 'transparent', strokeWidth: 0, fill: 'transparent', cursor: 'default' },
      },
    },
    /* Serbest ilişkiler hiyerarşi portlarını kullanmaz: kartın yanından çıkıp
       hedefin yanına girer. Her yanda üç görünmez yuva, aynı karta gelen
       okların tek noktada üst üste binmesini engeller. */
    linkLeft: {
      position: 'absolute',
      attrs: {
        circle: { r: 3, magnet: false, stroke: 'none', fill: 'transparent' },
      },
    },
    linkRight: {
      position: 'absolute',
      attrs: {
        circle: { r: 3, magnet: false, stroke: 'none', fill: 'transparent' },
      },
    },
  },
  items: [
    { id: 'in', group: 'in' },
    { id: 'out', group: 'out' },
    ...LINK_LEFT_PORTS.map((id, i) => ({ id, group: 'linkLeft', args: LINK_PORT_SLOTS[i] })),
    ...LINK_RIGHT_PORTS.map((id, i) => ({ id, group: 'linkRight', args: LINK_PORT_SLOTS_RIGHT[i] })),
  ],
};

function edgePort(edge: X6Edge, end: 'source' | 'target') {
  const terminal = end === 'source' ? edge.getSource() : edge.getTarget();
  return 'port' in terminal ? terminal.port : null;
}

function applyEdgeLook(edge: X6Edge, direction: 'H' | 'V') {
  const connector = edge.getConnector() as {
    name?: string;
    args?: { direction?: string };
  } | undefined;
  if (connector?.name !== 'smooth' || connector.args?.direction !== direction) {
    edge.setConnector('smooth', { direction });
  }
}

type FlowPoint = { x: number; y: number };
type FlowBox = { x: number; y: number; width: number; height: number };

function pointInBox(p: FlowPoint, b: FlowBox) {
  return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
}

function segmentHitsBox(a: FlowPoint, b: FlowPoint, box: FlowBox) {
  if (pointInBox(a, box) || pointInBox(b, box)) return true;
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
  const cross = (p: FlowPoint, q: FlowPoint, r: FlowPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  for (let i = 0; i < 4; i++) {
    const c = corners[i];
    const d = corners[(i + 1) % 4];
    const d1 = cross(a, b, c);
    const d2 = cross(a, b, d);
    const d3 = cross(c, d, a);
    const d4 = cross(c, d, b);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      return true;
    }
  }
  return false;
}

function pathHitsBoxes(points: FlowPoint[], boxes: FlowBox[]) {
  for (let i = 0; i < points.length - 1; i++) {
    for (const box of boxes) if (segmentHitsBox(points[i], points[i + 1], box)) return true;
  }
  return false;
}

function portPoint(node: X6Node, portId: string): FlowPoint {
  const bbox = node.getBBox();
  const port = node.getPort(portId);
  const group = port?.group;
  if (!group) return { x: bbox.getCenter().x, y: bbox.getCenter().y };
  const layout = node.getPortsPosition(group)[portId];
  if (!layout) return { x: bbox.getCenter().x, y: bbox.getCenter().y };
  return { x: bbox.x + layout.position.x, y: bbox.y + layout.position.y };
}

type LinkSide = 'left' | 'right';
type LinkKind = 'hierarchy' | 'work';
type LinkMenuState = { from: string; x: number; y: number };

function linkSides(graph: Graph, from: string, to: string) {
  const a = graph.getCellById(from);
  const b = graph.getCellById(to);
  if (!a?.isNode() || !b?.isNode()) return null;
  const ax = a.getBBox().getCenter().x;
  const bx = b.getBBox().getCenter().x;
  return bx >= ax
    ? { source: 'right' as LinkSide, target: 'left' as LinkSide }
    : { source: 'left' as LinkSide, target: 'right' as LinkSide };
}

function pickLinkPort(side: LinkSide, count: number, index: number) {
  const ports = side === 'left' ? LINK_LEFT_PORTS : LINK_RIGHT_PORTS;
  if (count <= 1) return ports[1];
  if (count === 2) return ports[index === 0 ? 0 : 2];
  return ports[index % ports.length];
}

/** Serbest iliÅŸkileri kartlarÄ±n dÄ±ÅŸÄ±ndan dolaÅŸtÄ±r: yan porttan Ã§Ä±k, satÄ±r
 *  aralarÄ±ndaki boÅŸ ÅŸeritten geÃ§, hedefin yan portuna gir. DoÄŸrudan hat
 *  temizse gereksiz kÄ±vrÄ±m Ã¼retme. */
function freeLinkRoute(graph: Graph, from: string, to: string, sourcePort: string, targetPort: string) {
  const sourceCell = graph.getCellById(from);
  const targetCell = graph.getCellById(to);
  if (!sourceCell?.isNode() || !targetCell?.isNode()) return null;
  const source = portPoint(sourceCell as X6Node, sourcePort);
  const target = portPoint(targetCell as X6Node, targetPort);
  const nodes = graph.getNodes();
  const boxes: FlowBox[] = [];
  const bands: { top: number; bottom: number }[] = [];
  for (const node of nodes) {
    if (node.id === from || node.id === to) continue;
    const bb = node.getBBox();
    boxes.push({ x: bb.x - 8, y: bb.y - 8, width: bb.width + 16, height: bb.height + 16 });
    bands.push({ top: bb.y, bottom: bb.y + bb.height });
  }
  if (!pathHitsBoxes([source, target], boxes)) return [];
  const merged: { top: number; bottom: number }[] = [];
  for (const band of bands.sort((a, b) => a.top - b.top)) {
    const last = merged[merged.length - 1];
    if (last && band.top <= last.bottom + 2) last.bottom = Math.max(last.bottom, band.bottom);
    else merged.push({ ...band });
  }
  const first = merged[0];
  const last = merged[merged.length - 1];
  const lanes: number[] = [];
  if (first) lanes.push(first.top - 18);
  for (let i = 0; i < merged.length - 1; i++) {
    if (merged[i + 1].top - merged[i].bottom >= 28) {
      lanes.push((merged[i].bottom + merged[i + 1].top) / 2);
    }
  }
  if (last) lanes.push(last.bottom + 18);
  const sourceDir = sourcePort.startsWith('link-right') ? 1 : -1;
  const targetDir = targetPort.startsWith('link-left') ? -1 : 1;
  const sourceExit = { x: source.x + sourceDir * 16, y: source.y };
  const targetExit = { x: target.x + targetDir * 16, y: target.y };
  let best: FlowPoint[] | null = null;
  let bestLength = Infinity;
  for (const lane of lanes) {
    const points = [
      source,
      sourceExit,
      { x: sourceExit.x, y: lane },
      { x: targetExit.x, y: lane },
      targetExit,
      target,
    ];
    if (pathHitsBoxes(points, boxes)) continue;
    let length = 0;
    for (let i = 0; i < points.length - 1; i++) {
      length += Math.abs(points[i].x - points[i + 1].x) + Math.abs(points[i].y - points[i + 1].y);
    }
    if (length < bestLength) {
      bestLength = length;
      best = [sourceExit, { x: sourceExit.x, y: lane }, { x: targetExit.x, y: lane }, targetExit];
    }
  }
  return best ?? [];
}

function applyFreeLook(edge: X6Edge, vertices: FlowPoint[]) {
  const connector = edge.getConnector() as { name?: string } | undefined;
  if (vertices.length === 0) {
    if (connector?.name !== 'smooth') edge.setConnector('smooth', { direction: 'H' });
  } else if (connector?.name !== 'rounded') {
    edge.setConnector('rounded', { radius: 14 });
  }
  const current = edge.getVertices();
  if (JSON.stringify(current) !== JSON.stringify(vertices)) edge.setVertices(vertices);
}

function syncFreeRoutes(graph: Graph) {
  for (const edge of graph.getEdges()) {
    const data = (edge.getData() || {}) as { linkId?: string };
    if (!data.linkId) continue;
    const from = edge.getSourceCellId();
    const to = edge.getTargetCellId();
    const sourcePort = edgePort(edge, 'source');
    const targetPort = edgePort(edge, 'target');
    if (!from || !to || !sourcePort || !targetPort) continue;
    const route = freeLinkRoute(graph, from, to, sourcePort, targetPort);
    if (route) applyFreeLook(edge, route);
  }
}

/** X6 3.x bazÄ± remove/add dÃ¶ngÃ¼lerinde edge view'Ä±nÄ± DOM'da bÄ±rakÄ±yor.
 *  Model doÄŸru olduÄŸu iÃ§in view'Ä± modele senkronluyoruz. Kopyalardan
 *  X6'nÄ±n sahibi olduÄŸu CANLI view (findViewByCell) tutulur; bayat olan
 *  silinir. Ä°lkini tutarsak canlÄ± view'Ä±n DOM'u gidiyor ve X6 artÄ±k
 *  gÃ¶rÃ¼nmeyen elemanÄ± gÃ¼ncellediÄŸi iÃ§in Ã§izgi eski yerinde donuk kalÄ±yor. */
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
        fill: '#CFC9BC',
        fontSize: 9,
        letterSpacing: 0.2,
        textAnchor: 'middle',
        textVerticalAnchor: 'middle',
        pointerEvents: 'none',
      },
      body: { fill: '#141312', stroke: '#33312C', rx: 3, ry: 3 },
    },
    position: 0.5,
  };
}

/** Kart verisini yalnÄ±z gerÃ§ekten deÄŸiÅŸen dÃ¼ÄŸÃ¼mlere yaz (seÃ§im/link modu
 *  deÄŸiÅŸiminde tÃ¼m kartlarÄ±n yeniden render edilmesini Ã¶nler). */
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
  selectedLinkId: string | null,
  focusNodeId: string | null,
  showAllLinks: boolean
) {
  const ids = new Set(agents.map((a) => a.id));
  const desired = new Map<string, PlanAgent>();
  for (const a of agents) {
    if (a.parentId && ids.has(a.parentId)) desired.set(a.id, a);
  }
  const desiredLinks = new Map<string, AgentLink>();
  for (const l of links) {
    if (ids.has(l.from) && ids.has(l.to) && l.from !== l.to) {
      const visible = showAllLinks
        || selectedLinkId === l.id
        || focusNodeId === l.from
        || focusNodeId === l.to;
      if (visible) desiredLinks.set(l.id, l);
    }
  }
  /* Serbest iliÅŸkiler kartÄ±n yan portlarÄ±ndan Ã§Ä±kar; hiyerarÅŸinin alt/Ã¼st
     portlarÄ±na karÄ±ÅŸmaz. Kaynak hedefe bakan yandan Ã§Ä±kar, hedef Ã¶bÃ¼r
     yandan girer; hat gerekiyorsa kartlarÄ±n arasÄ±ndaki boÅŸluktan dolaÅŸÄ±r. */
  const linkEnds = new Map<string, {
    from: string;
    to: string;
    source: LinkSide;
    target: LinkSide;
  }>();
  const sideCounts = new Map<string, number>();
  for (const [id, l] of desiredLinks) {
    const sides = linkSides(graph, l.from, l.to);
    if (!sides) continue;
    linkEnds.set(id, { from: l.from, to: l.to, ...sides });
    for (const [nodeId, side] of [[l.from, sides.source], [l.to, sides.target]] as const) {
      const key = `${nodeId}:${side}`;
      sideCounts.set(key, (sideCounts.get(key) ?? 0) + 1);
    }
  }
  const sideCursor = new Map<string, number>();
  const portFor = (nodeId: string, side: LinkSide) => {
    const key = `${nodeId}:${side}`;
    const index = sideCursor.get(key) ?? 0;
    sideCursor.set(key, index + 1);
    return pickLinkPort(side, sideCounts.get(key) ?? 1, index);
  };
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
      // Hiyerarşi çizgileri kartların arkasında kalmalı; port uçları kartın
      // içine girse bile çizgi kartın önüne taşmasın.
      if (existingEdge.getZIndex() !== -1) existingEdge.setZIndex(-1);
      // Silip yeniden eklemek X6 view'Ä±nda kopya bÄ±rakÄ±yor; yerinde gÃ¼ncelle.
      if (existingEdge.getSourceCellId() !== a.parentId || edgePort(existingEdge, 'source') !== 'out') {
        existingEdge.setSource({ cell: a.parentId as string, port: 'out' });
      }
      if (existingEdge.getTargetCellId() !== childId || edgePort(existingEdge, 'target') !== 'in') {
        existingEdge.setTarget({ cell: childId, port: 'in' });
      }
      applyEdgeLook(existingEdge, 'V');
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
      connector: { name: 'smooth', args: { direction: 'V' } },
      zIndex: -1,
      attrs: {
        line: {
          stroke,
          strokeWidth: selected ? 2 : 1.4,
          /* X6 varsayÄ±lan klasik ok baÅŸÄ±nÄ± kapat. */
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
    const ends = linkEnds.get(id);
    if (!ends) continue;
    const sourcePort = portFor(l.from, ends.source);
    const targetPort = portFor(l.to, ends.target);
    const route = freeLinkRoute(graph, l.from, l.to, sourcePort, targetPort);
    const ex = existingLinks.get(id);
    if (ex) {
      if (ex.getSourceCellId() !== l.from || edgePort(ex, 'source') !== sourcePort) {
        ex.setSource({ cell: l.from, port: sourcePort });
      }
      if (ex.getTargetCellId() !== l.to || edgePort(ex, 'target') !== targetPort) {
        ex.setTarget({ cell: l.to, port: targetPort });
      }
      if (route) applyFreeLook(ex, route);
      if (ex.attr('line/strokeDasharray') !== '4 4') {
        ex.attr('line/strokeDasharray', '4 4');
        ex.attr('line/targetMarker/size', 7);
        ex.attr('line/targetMarker/strokeWidth', 0);
      }
      if (ex.attr('line/stroke') !== stroke || ex.attr('line/strokeWidth') !== (selected ? 2 : 1.25)) {
        ex.attr('line/stroke', stroke);
        ex.attr('line/strokeWidth', selected ? 2 : 1.25);
        ex.attr('line/targetMarker/fill', stroke);
      }
      const nextLabels = labelText ? [labelItem(labelText)] : [];
      const first = ex.getLabels()[0] as
        | { attrs?: { label?: { text?: string } }; position?: unknown }
        | undefined;
      const sameText = (first?.attrs?.label?.text ?? '') === labelText;
      const samePosition =
        JSON.stringify(first?.position) === JSON.stringify(nextLabels[0]?.position);
      if (!sameText || !samePosition) ex.setLabels(nextLabels);
      continue;
    }
    graph.addEdge({
      id: `link:${id}`,
      source: { cell: l.from, port: sourcePort },
      target: { cell: l.to, port: targetPort },
      data: { linkId: id },
      vertices: route ?? [],
      connector: route && route.length > 0
        ? { name: 'rounded', args: { radius: 14 } }
        : { name: 'smooth', args: { direction: 'H' } },
      attrs: {
        line: {
          stroke,
          strokeWidth: selected ? 2 : 1.25,
          strokeDasharray: '4 4',
          sourceMarker: null,
          targetMarker: { name: 'classic', size: 7, fill: stroke, strokeWidth: 0 },
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
  /** SaÄŸ tÄ±kla baÅŸlatÄ±lan baÄŸlantÄ±nÄ±n kaynaÄŸÄ±. */
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const linkFromRef = useRef<string | null>(null);
  linkFromRef.current = linkFrom;
  const [linkKind, setLinkKind] = useState<LinkKind>('work');
  const linkKindRef = useRef<LinkKind>('work');
  linkKindRef.current = linkKind;
  const [linkMenu, setLinkMenu] = useState<LinkMenuState | null>(null);
  /* Serbest iliÅŸkiler varsayÄ±lan olarak yalnÄ±z seÃ§ili kart iÃ§in gÃ¶rÃ¼nÃ¼r;
     "BaÄŸlantÄ±lar" dÃ¼ÄŸmesi hepsini aÃ§ar. */
  const [showAllLinks, setShowAllLinks] = useState(false);
  const applyingRef = useRef(false);
  const dragTimerRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  /** En son uygulanan hiyerarÅŸi/konum anahtarÄ± (link deÄŸiÅŸiminde dagre'yi atla). */
  const appliedLayoutKeyRef = useRef<string | null>(null);

  /* NumaralandÄ±rma: seviye sÄ±rasÄ±na gÃ¶re tekil sÄ±ra. En Ã¼st hiyerarÅŸi 1,
     alt seviyelere indikÃ§e sayÄ± artar. AynÄ± seviyede soldan saÄŸa ilerler. */
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

  // Graph bir kez kurulur; olaylar propsRef Ã¼zerinden gÃ¼ncel callbacks'e gider.
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
        validateMagnet: () => false,
        /* Port Ã§apÄ±na yakÄ±nÄ±nca hat port ortasÄ±na kilitlenir. */
        snap: { radius: 44 },
        allowBlank: false,
        allowLoop: false,
        allowNode: false,
        allowMulti: false,
        highlight: false,
        connector: { name: 'smooth' },
        anchor: 'center',
        connectionPoint: 'anchor',
        /* SÃ¼rÃ¼kleme Ã¶nizlemesinde de ok baÅŸÄ± olmasÄ±n. */
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
        /* SaÄŸ tÄ±kla baÅŸlatÄ±lan baÄŸlantÄ± hedefe tÄ±klayÄ±nca kurulur. */
        const kind = linkKindRef.current;
        setLinkFrom(null);
        setLinkMenu(null);
        if (kind === 'hierarchy') propsRef.current.onLink(from, node.id);
        else propsRef.current.onRequestLink(from, node.id);
        return;
      }
      if (from === node.id) {
        setLinkFrom(null);
        return;
      }
      setLinkMenu(null);
      propsRef.current.onSelectNode(node.id);
    });
    graph.on('node:contextmenu', ({ e, node }) => {
      e.preventDefault();
      /* AynÄ± karta saÄŸ tÄ±k: baÄŸlantÄ± modunu kapat. */
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        setLinkMenu({
          from: node.id,
          x: Math.max(8, Math.min(e.clientX - rect.left, rect.width - 228)),
          y: Math.max(8, Math.min(e.clientY - rect.top, rect.height - 142)),
        });
      }
      setLinkFrom(null);
      setLinkKind('work');
      propsRef.current.onSelectNode(null);
      propsRef.current.onSelectEdge(null);
      propsRef.current.onSelectLink(null);
    });
    graph.on('blank:contextmenu', ({ e }) => {
      e.preventDefault();
      if (linkFromRef.current) setLinkFrom(null);
      setLinkMenu(null);
    });
    graph.on('edge:click', ({ edge }) => {
      setLinkMenu(null);
      if (linkFromRef.current) {
        setLinkFrom(null);
        return;
      }
      const d = (edge.getData() || {}) as { childId?: string; linkId?: string };
      if (d.linkId) propsRef.current.onSelectLink(d.linkId);
      else if (d.childId) propsRef.current.onSelectEdge(d.childId);
    });
    graph.on('blank:click', () => {
      setLinkMenu(null);
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
      syncFreeRoutes(graph);
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
      // X6'Ä±n geÃ§ici kenarÄ±nÄ± SENKRON kaldÄ±r; aksi halde view'da kopya kalÄ±yor.
      try { edge.remove(); } catch { /* already gone */ }
      window.setTimeout(() => syncEdgeViews(graph), 220);
      if (source && target) propsRef.current.onLink(source, target);
    });

    const timer = window.setTimeout(() => {
      graph.zoomToFit({ padding: 32, maxScale: 1 });
    }, 120);

    /* KapsayÄ±cÄ± yeniden boyutlandÄ±ÄŸÄ±nda (Ã¶r. saÄŸ panel katlanÄ±nca flow
       bÃ¼yÃ¼r) X6 canvas'Ä± YENÄ°DEN BOYUTLANDIR ve iÃ§eriÄŸi gÃ¶rÃ¼nÃ¼me sÄ±ÄŸdÄ±r.
       X6'nÄ±n autoResize'i yalnÄ±z pencere resize'Ä±nÄ± dinler; panel katlanmasÄ±
       pencere resize'Ä± olmadÄ±ÄŸÄ± iÃ§in canvas eski boyutta kalÄ±yordu ve
       geniÅŸleyen alan boÅŸ gÃ¶rÃ¼nÃ¼yordu. */
    let refitTimer: number | undefined;
    let lastW = 0;
    let lastH = 0;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      /* Gizliyken (0Ã—0) boyut deÄŸiÅŸimi sayÄ±lmaz; gÃ¶rÃ¼nÃ¼r olunca sÄ±ÄŸdÄ±r. */
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      graph.resize(rect.width, rect.height);
      const firstReveal = lastW === 0;
      const sizeChanged = firstReveal
        || Math.abs(rect.width - lastW) > 1
        || Math.abs(rect.height - lastH) > 1;
      lastW = rect.width;
      lastH = rect.height;
      /* YalnÄ±z gÃ¶rÃ¼nÃ¼rlÃ¼k deÄŸiÅŸtiyse kullanÄ±cÄ±nÄ±n pan/zoom'u korunur. */
      if (!sizeChanged) return;
      if (propsRef.current.agents.length === 0) return;
      /* Ä°lk gÃ¶rÃ¼nÃ¼rlÃ¼kte beklemeden sÄ±ÄŸdÄ±r (flash olmasÄ±n). */
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

  // Node/edge iskeleti: yalnÄ±z yapÄ±/konum deÄŸiÅŸince.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    applyingRef.current = true;
    try {
      /* YalnÄ±z hiyerarÅŸi/konum deÄŸiÅŸtiyse dagre + dÃ¼ÄŸÃ¼m iÅŸlemleri.
         Link etiketi/durumu deÄŸiÅŸimi yalnÄ±z kenarlarÄ± gÃ¼nceller. */
      if (appliedLayoutKeyRef.current !== agentsKey) {
        appliedLayoutKeyRef.current = agentsKey;
        const ids = new Set(props.agents.map((a) => a.id));
        for (const n of graph.getNodes()) if (!ids.has(n.id)) graph.removeNode(n);
        /* KenarlarÄ± burada toplu silip yeniden eklemiyoruz: her sÃ¼rÃ¼kleme
           bÄ±rakÄ±ÅŸÄ±nda remove/add dÃ¶ngÃ¼sÃ¼ X6 3.x'te bayat view bÄ±rakÄ±p Ã§izgileri
           eski konumda donduruyor. replaceEdges farkÄ± yerinde gÃ¼nceller. */
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
      replaceEdges(
        graph,
        props.agents,
        props.links,
        selectedEdgeRef.current,
        propsRef.current.selectedLinkId,
        propsRef.current.selectedNodeId,
        showAllLinks
      );
    } finally {
      applyingRef.current = false;
    }
  }, [structuralKey, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Metin/rol/model deÄŸiÅŸimi: node'larÄ± yeniden kurmadan data gÃ¼ncelle.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    syncNodeData(graph, props.agents, nodeData);
  }, [dataKey, nodeData, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // BaÄŸlantÄ± modu: kaynak kartÄ±n vurgusu ve imleÃ§.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    syncNodeData(graph, props.agents, nodeData);
  }, [linkFrom, props.agents, nodeData, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // SeÃ§im: yalnÄ±z seÃ§ili kartÄ±n serbest iliÅŸkilerini gÃ¶ster; vurgularÄ± gÃ¼ncelle.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready) return;
    syncNodeData(graph, props.agents, nodeData);
    replaceEdges(
      graph,
      props.agents,
      props.links,
      props.selectedEdgeId,
      props.selectedLinkId,
      props.selectedNodeId,
      showAllLinks
    );
  }, [props.selectedNodeId, props.selectedEdgeId, props.selectedLinkId, showAllLinks, nodeData, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || !ready || !props.fitNonce) return;
    const id = window.setTimeout(() => graph.zoomToFit({ padding: 32, maxScale: 1 }), 80);
    return () => window.clearTimeout(id);
  }, [props.fitNonce, ready]);

  useEffect(() => {
    if (!linkFrom && !linkMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLinkFrom(null);
        setLinkMenu(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [linkFrom, linkMenu]);

  const fit = useCallback(() => graphRef.current?.zoomToFit({ padding: 32, maxScale: 1 }), []);
  const zoom = useCallback((delta: number) => graphRef.current?.zoom(delta), []);
  const linkSource = linkFrom ? props.agents.find((a) => a.id === linkFrom) : null;
  const linkKindLabel = t(linkKind === 'hierarchy' ? 'company.linkHierarchy' : 'company.linkWork');
  const beginLink = (kind: LinkKind) => {
    if (!linkMenu) return;
    setLinkFrom(linkMenu.from);
    setLinkKind(kind);
    setLinkMenu(null);
  };

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className={`x6-thalamus h-full w-full ${linkFrom ? 'cursor-crosshair' : ''}`} />

      <div className="pointer-events-none absolute left-2 top-2 z-10 max-w-[250px] rounded-md border border-[#2C2A26] bg-[#151412]/90 px-2 py-1 text-[9.5px] leading-snug text-[#8C877B]">
        {t('company.flowHelp')}
      </div>

      {props.links.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAllLinks((v) => !v)}
          aria-pressed={showAllLinks}
          title={t('company.allConnections')}
          className={`absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] shadow-lg cursor-pointer ${
            showAllLinks
              ? 'border-[#3AA99F]/50 bg-[#3AA99F]/10 text-[#D8D2C4]'
              : 'border-[#2C2A26] bg-[#151412]/90 text-[#A8A397] hover:border-[#3A3835] hover:text-[#E8E4DA]'
          }`}
        >
          <Link2 size={10} />
          <span>{t('company.allConnections')}</span>
          <span className="rounded bg-[#2A2825] px-1 text-[9px] text-[#A8A397]">{props.links.length}</span>
        </button>
      )}

      {linkMenu && (
        <div
          className="absolute z-30 w-[220px] overflow-hidden rounded-lg border border-[#3A3835] bg-[#151412] shadow-2xl"
          style={{ left: linkMenu.x, top: linkMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="border-b border-[#24221F] px-2.5 py-1.5 text-[9px] font-medium uppercase tracking-[0.1em] text-[#7C776B]">
            {t('company.linkMenuTitle')}
          </div>
          <button
            type="button"
            onClick={() => beginLink('hierarchy')}
            className="flex w-full items-center gap-2.5 px-2.5 py-2.5 text-left hover:bg-[#1D1B18] cursor-pointer"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[5px] border border-[#3A3835] bg-[#211F1B] text-[#dcb67a]">
              <Network size={12} />
            </span>
            <span className="min-w-0">
              <span className="block text-[11px] font-medium text-[#E8E4DA]">{t('company.linkHierarchy')}</span>
              <span className="mt-0.5 block text-[9.5px] leading-snug text-[#8C877B]">{t('company.linkHierarchyDesc')}</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => beginLink('work')}
            className="flex w-full items-center gap-2.5 border-t border-[#24221F] px-2.5 py-2.5 text-left hover:bg-[#1D1B18] cursor-pointer"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[5px] border border-[#3A3835] bg-[#211F1B] text-[#5FA3AE]">
              <Link2 size={12} />
            </span>
            <span className="min-w-0">
              <span className="block text-[11px] font-medium text-[#E8E4DA]">{t('company.linkWork')}</span>
              <span className="mt-0.5 block text-[9.5px] leading-snug text-[#8C877B]">{t('company.linkWorkDesc')}</span>
            </span>
          </button>
        </div>
      )}

      {linkFrom && (
        <div className="absolute left-1/2 top-2 z-20 flex max-w-[420px] -translate-x-1/2 items-center gap-2 rounded-md border border-[#3A3835] bg-[#1D1B18] px-2.5 py-1 text-[10px] text-[#E8E4DA] shadow-lg">
          <span className="min-w-0 truncate">
            {t('company.linkModeFrom', { name: linkSource?.name || t('company.newName') })}
          </span>
          <span className="shrink-0 rounded border border-[#3A3835] bg-[#26241F] px-1 py-0.5 text-[9px] text-[#CFC9BC]">
            {linkKindLabel}
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

      {props.selectedNodeId && !linkFrom && (
        <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5">
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
