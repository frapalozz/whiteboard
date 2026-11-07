import { boundsOf } from "./geometry";
import type { El, Rect } from "./types";

/**
 * Segni ai bordi della lavagna: per ogni elemento fuori dalla vista, una sottile striscia del suo colore
 * sul bordo verso cui si trova, nella posizione che corrisponde all'elemento. Dove due elementi cadono
 * sullo stesso tratto di bordo vince il più vicino (viene disegnato per ultimo).
 */

export type Side = "left" | "right" | "top" | "bottom";

export interface EdgeMark {
  side: Side;
  /** Tratto del bordo occupato, in pixel schermo (y per left/right, x per top/bottom). */
  from: number;
  to: number;
  color: string;
  /** Distanza dalla vista (unità mondo): i segni sono ordinati dal più lontano al più vicino. */
  dist: number;
}

/** Lunghezza minima di un segno (px schermo), perché anche un elemento piccolo e lontano si veda. */
export const MARK_MIN = 14;
/** Spessore del segno (px schermo). */
export const MARK_SIZE = 4;

export function edgeMarks(els: readonly El[], view: Rect, zoom: number, viewW: number, viewH: number): EdgeMark[] {
  const out: EdgeMark[] = [];
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  const right = view.x + view.w;
  const bottom = view.y + view.h;
  for (const el of els) {
    const b = boundsOf(el);
    const gapX = b.x + b.w < view.x ? view.x - (b.x + b.w) : b.x > right ? b.x - right : 0;
    const gapY = b.y + b.h < view.y ? view.y - (b.y + b.h) : b.y > bottom ? b.y - bottom : 0;
    if (gapX === 0 && gapY === 0) continue; // visibile (anche solo in parte)

    // il bordo è quello che incontra la retta dal centro della vista al centro dell'elemento
    const dx = b.x + b.w / 2 - cx;
    const dy = b.y + b.h / 2 - cy;
    const horizontal = Math.abs(dx) * view.h >= Math.abs(dy) * view.w;
    let side: Side;
    let lo: number;
    let hi: number;
    let len: number;
    if (horizontal) {
      side = dx < 0 ? "left" : "right";
      lo = (b.y - view.y) * zoom;
      hi = (b.y + b.h - view.y) * zoom;
      len = viewH;
    } else {
      side = dy < 0 ? "top" : "bottom";
      lo = (b.x - view.x) * zoom;
      hi = (b.x + b.w - view.x) * zoom;
      len = viewW;
    }
    // si porta il tratto sul bordo (per gli elementi in diagonale finisce nell'angolo)
    let from = Math.max(0, Math.min(len, lo));
    let to = Math.max(0, Math.min(len, hi));
    if (to - from < MARK_MIN) {
      const mid = Math.max(MARK_MIN / 2, Math.min(len - MARK_MIN / 2, (from + to) / 2));
      from = mid - MARK_MIN / 2;
      to = mid + MARK_MIN / 2;
    }
    out.push({ side, from, to, color: el.color, dist: Math.hypot(gapX, gapY) });
  }
  return out.sort((a, b) => b.dist - a.dist);
}

export function drawEdgeMarks(ctx: CanvasRenderingContext2D, marks: readonly EdgeMark[], viewW: number, viewH: number): void {
  if (!marks.length) return;
  ctx.save();
  ctx.globalAlpha = 0.9;
  for (const m of marks) {
    ctx.fillStyle = m.color;
    const l = m.to - m.from;
    if (m.side === "left") ctx.fillRect(0, m.from, MARK_SIZE, l);
    else if (m.side === "right") ctx.fillRect(viewW - MARK_SIZE, m.from, MARK_SIZE, l);
    else if (m.side === "top") ctx.fillRect(m.from, 0, l, MARK_SIZE);
    else ctx.fillRect(m.from, viewH - MARK_SIZE, l, MARK_SIZE);
  }
  ctx.restore();
}
