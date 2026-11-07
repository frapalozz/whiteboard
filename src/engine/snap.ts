import type { Rect } from "./types";

/**
 * Guide magnetiche: mentre si sposta (o si ridimensiona) qualcosa, i suoi bordi e il suo centro si
 * agganciano a quelli degli altri elementi vicini, e una linea mostra l'allineamento.
 */

export interface Guide {
  /** "x": linea verticale alla coordinata `at`; "y": linea orizzontale. */
  axis: "x" | "y";
  at: number;
  /** Estensione della linea sull'altro asse (coordinate mondo). */
  from: number;
  to: number;
}

const xs = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w];
const ys = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h];

/** Miglior aggancio su un asse: scarto da applicare e coordinate allineate (null se nessuno entro `tol`). */
function best(mine: number[], theirs: number[][], tol: number): { d: number; at: number[] } | null {
  let d = Infinity;
  for (const t of theirs) for (const v of t) for (const m of mine) if (Math.abs(v - m) < Math.abs(d)) d = v - m;
  if (!(Math.abs(d) <= tol)) return null;
  // tutte le coordinate che coincidono dopo l'aggancio (più linee se più bordi si allineano)
  const at = new Set<number>();
  for (const t of theirs) for (const v of t) for (const m of mine) if (Math.abs(v - (m + d)) < 1e-6) at.add(v);
  return { d, at: [...at] };
}

function guidesFor(axis: "x" | "y", at: number[], moved: Rect, others: Rect[]): Guide[] {
  const out: Guide[] = [];
  for (const a of at) {
    let from = axis === "x" ? moved.y : moved.x;
    let to = axis === "x" ? moved.y + moved.h : moved.x + moved.w;
    for (const o of others) {
      const c = axis === "x" ? xs(o) : ys(o);
      if (!c.some((v) => Math.abs(v - a) < 1e-6)) continue;
      from = Math.min(from, axis === "x" ? o.y : o.x);
      to = Math.max(to, axis === "x" ? o.y + o.h : o.x + o.w);
    }
    out.push({ axis, at: a, from, to });
  }
  return out;
}

/** Aggancia un rettangolo in movimento: scarto (dx, dy) da aggiungere e linee guida. */
export function snapRect(moving: Rect, others: Rect[], tol: number): { dx: number; dy: number; guides: Guide[] } {
  if (!others.length) return { dx: 0, dy: 0, guides: [] };
  const bx = best(xs(moving), others.map(xs), tol);
  const by = best(ys(moving), others.map(ys), tol);
  const dx = bx?.d ?? 0;
  const dy = by?.d ?? 0;
  const moved = { ...moving, x: moving.x + dx, y: moving.y + dy };
  return {
    dx,
    dy,
    guides: [...(bx ? guidesFor("x", bx.at, moved, others) : []), ...(by ? guidesFor("y", by.at, moved, others) : [])],
  };
}

/** Aggancia un punto (l'angolo trascinato di un ridimensionamento). `fixed`: l'angolo opposto, per le guide. */
export function snapPoint(
  x: number,
  y: number,
  others: Rect[],
  tol: number,
  fixed: { x: number; y: number },
): { x: number; y: number; guides: Guide[] } {
  if (!others.length) return { x, y, guides: [] };
  const bx = best([x], others.map(xs), tol);
  const by = best([y], others.map(ys), tol);
  const nx = x + (bx?.d ?? 0);
  const ny = y + (by?.d ?? 0);
  const r: Rect = { x: Math.min(nx, fixed.x), y: Math.min(ny, fixed.y), w: Math.abs(nx - fixed.x), h: Math.abs(ny - fixed.y) };
  return {
    x: nx,
    y: ny,
    guides: [...(bx ? guidesFor("x", bx.at, r, others) : []), ...(by ? guidesFor("y", by.at, r, others) : [])],
  };
}

/* ---- allinea e distribuisci ---- */

export type AlignKind = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";

/** Spostamento (dx, dy) di ogni rettangolo per allinearlo agli altri. */
export function alignOffsets(rects: Rect[], kind: AlignKind): Array<{ dx: number; dy: number }> {
  if (rects.length < 2) return rects.map(() => ({ dx: 0, dy: 0 }));
  const x1 = Math.min(...rects.map((r) => r.x));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.min(...rects.map((r) => r.y));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return rects.map((r) => {
    switch (kind) {
      case "left":
        return { dx: x1 - r.x, dy: 0 };
      case "right":
        return { dx: x2 - (r.x + r.w), dy: 0 };
      case "hcenter":
        return { dx: (x1 + x2) / 2 - (r.x + r.w / 2), dy: 0 };
      case "top":
        return { dx: 0, dy: y1 - r.y };
      case "bottom":
        return { dx: 0, dy: y2 - (r.y + r.h) };
      case "vcenter":
        return { dx: 0, dy: (y1 + y2) / 2 - (r.y + r.h / 2) };
    }
  });
}

/**
 * Distribuisce i rettangoli con spazi uguali tra uno e l'altro lungo un asse; il primo e l'ultimo
 * restano fermi. Servono almeno 3 elementi.
 */
export function distributeOffsets(rects: Rect[], axis: "x" | "y"): Array<{ dx: number; dy: number }> {
  const out = rects.map(() => ({ dx: 0, dy: 0 }));
  if (rects.length < 3) return out;
  const pos = (r: Rect) => (axis === "x" ? r.x : r.y);
  const size = (r: Rect) => (axis === "x" ? r.w : r.h);
  const order = rects.map((r, i) => i).sort((a, b) => pos(rects[a]) + size(rects[a]) / 2 - (pos(rects[b]) + size(rects[b]) / 2));
  const first = rects[order[0]];
  const last = rects[order[order.length - 1]];
  const span = pos(last) + size(last) - pos(first);
  const total = order.reduce((s, i) => s + size(rects[i]), 0);
  const gap = (span - total) / (order.length - 1);
  let cur = pos(first);
  for (const i of order) {
    const d = cur - pos(rects[i]);
    out[i] = axis === "x" ? { dx: d, dy: 0 } : { dx: 0, dy: d };
    cur += size(rects[i]) + gap;
  }
  return out;
}
