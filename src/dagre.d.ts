/**
 * @dagrejs/dagre v3 tip tanımı yayınlamıyor; yalnız kullandığımız yüzeyi
 * tanımlıyoruz (graphlib.Graph + layout).
 */
declare module '@dagrejs/dagre' {
  interface GraphNode {
    x: number;
    y: number;
  }
  interface Graph {
    setDefaultEdgeLabel(fn: () => unknown): void;
    setGraph(opts: Record<string, unknown>): void;
    setNode(id: string, dims: { width: number; height: number }): void;
    setEdge(from: string, to: string): void;
    node(id: string): GraphNode;
  }
  const dagre: {
    graphlib: { Graph: new () => Graph };
    layout(graph: Graph): void;
  };
  export default dagre;
}
