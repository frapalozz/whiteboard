/**
 * Disposizione automatica di un diagramma di flusso (a livelli, come fanno Mermaid e Graphviz):
 *  1. i cicli si spezzano (un ritorno all'indietro non decide i livelli);
 *  2. ogni nodo va al livello più lontano raggiungibile dall'inizio (cammino più lungo);
 *  3. dentro ogni livello i nodi si ordinano vicino ai loro collegati (baricentro, qualche passata);
 *  4. si calcolano le posizioni: livelli dall'alto in basso (o da sinistra a destra), centrati.
 */

export type Dir = "TB" | "LR" | "BT" | "RL";

export interface LNode {
  id: string;
  w: number;
  h: number;
}

export interface LEdge {
  from: string;
  to: string;
}

export interface Placed {
  x: number;
  y: number;
}

export const GAP_RANK = 90;
export const GAP_NODE = 50;

export function layeredLayout(nodes: LNode[], edges: LEdge[], dir: Dir = "TB"): Map<string, Placed> {
  const ids = nodes.map((n) => n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const valid = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);

  // 1. archi all'indietro (DFS): si ignorano per i livelli
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of valid) out.get(e.from)!.push(e.to);
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  const visit = (start: string) => {
    const stack: Array<[string, number]> = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, i] = top;
      const next = out.get(v)![i];
      if (next === undefined) {
        state.set(v, 2);
        stack.pop();
        continue;
      }
      top[1]++;
      const st = state.get(next) ?? 0;
      if (st === 1) back.add(`${v}>${next}`);
      else if (st === 0) {
        state.set(next, 1);
        stack.push([next, 0]);
      }
    }
  };
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of valid) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  for (const id of ids) if (!indeg.get(id) && !state.get(id)) visit(id);
  for (const id of ids) if (!state.get(id)) visit(id);
  const dag = valid.filter((e) => !back.has(`${e.from}>${e.to}`));

  // 2. livelli: cammino più lungo (ordine topologico)
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const din = new Map<string, number>(ids.map((id) => [id, 0]));
  const dout = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of dag) {
    din.set(e.to, din.get(e.to)! + 1);
    dout.get(e.from)!.push(e.to);
  }
  const queue = ids.filter((id) => din.get(id) === 0);
  while (queue.length) {
    const v = queue.shift()!;
    for (const w of dout.get(v)!) {
      rank.set(w, Math.max(rank.get(w)!, rank.get(v)! + 1));
      din.set(w, din.get(w)! - 1);
      if (din.get(w) === 0) queue.push(w);
    }
  }
  const nRanks = Math.max(0, ...rank.values()) + 1;
  const layers: string[][] = Array.from({ length: nRanks }, () => []);
  for (const id of ids) layers[rank.get(id)!].push(id);

  // 3. ordine dentro i livelli: baricentro dei vicini, alternando discesa e risalita
  const nb = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of dag) {
    nb.get(e.from)!.push(e.to);
    nb.get(e.to)!.push(e.from);
  }
  const pos = new Map<string, number>();
  const index = () => layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)));
  index();
  for (let it = 0; it < 8; it++) {
    const down = it % 2 === 0;
    const order = down ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
    for (const li of order) {
      const ref = down ? li - 1 : li + 1;
      if (ref < 0 || ref >= layers.length) continue;
      const refSet = new Set(layers[ref]);
      const bary = (id: string) => {
        const ns = nb.get(id)!.filter((x) => refSet.has(x));
        return ns.length ? ns.reduce((s, x) => s + pos.get(x)!, 0) / ns.length : pos.get(id)!;
      };
      layers[li].sort((a, b) => bary(a) - bary(b) || pos.get(a)! - pos.get(b)!);
      layers[li].forEach((id, i) => pos.set(id, i));
    }
  }

  // 4. coordinate: lungo il livello si affiancano i nodi; i livelli si impilano
  const horizontal = dir === "LR" || dir === "RL";
  const along = (n: LNode) => (horizontal ? n.h : n.w);
  const across = (n: LNode) => (horizontal ? n.w : n.h);
  const result = new Map<string, Placed>();
  const widths = layers.map((l) => l.reduce((s, id) => s + along(byId.get(id)!), 0) + GAP_NODE * Math.max(0, l.length - 1));
  const maxW = Math.max(0, ...widths);
  let depth = 0;
  layers.forEach((l, li) => {
    const thick = Math.max(0, ...l.map((id) => across(byId.get(id)!)));
    let cur = (maxW - widths[li]) / 2;
    for (const id of l) {
      const n = byId.get(id)!;
      const a = cur;
      const b = depth + (thick - across(n)) / 2;
      result.set(id, horizontal ? { x: b, y: a } : { x: a, y: b });
      cur += along(n) + GAP_NODE;
    }
    depth += thick + GAP_RANK;
  });
  if (dir === "BT" || dir === "RL") {
    const total = depth - GAP_RANK;
    for (const [id, p] of result) {
      const n = byId.get(id)!;
      if (dir === "BT") p.y = total - p.y - n.h;
      else p.x = total - p.x - n.w;
    }
  }
  return result;
}
