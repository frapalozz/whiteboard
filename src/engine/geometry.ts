import type { BoxEl, El, LineEl, Point, Rect } from "./types";

export const FONT_FAMILY =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const LINE_HEIGHT = 1.25;

export const fontOf = (size: number) => `${size}px ${FONT_FAMILY}`;

/** Dimensione del testo a partire dallo spessore scelto nello slider. */
export const fontSizeFor = (width: number) => Math.max(16, Math.round(width * 6));

export const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* ------------------------------------------------------------------ rect */

export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

export const inflate = (r: Rect, n: number): Rect => ({
  x: r.x - n,
  y: r.y - n,
  w: r.w + n * 2,
  h: r.h + n * 2,
});

export const rectContains = (r: Rect, p: Point) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

export const rectsIntersect = (a: Rect, b: Rect) =>
  a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Distanza di un punto dal contorno di un rettangolo (positiva sia dentro che fuori). */
function distToRectOutline(p: Point, r: Rect): number {
  const inside = rectContains(r, p);
  if (inside) {
    return Math.min(p.x - r.x, r.x + r.w - p.x, p.y - r.y, r.y + r.h - p.y);
  }
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/* ------------------------------------------------------------------ text */

let measureCtx: CanvasRenderingContext2D | null = null;

export function measureText(text: string, fontSize: number): { w: number; h: number } {
  const lines = text.split("\n");
  if (!measureCtx && typeof document !== "undefined") {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  let w = 0;
  if (measureCtx) {
    measureCtx.font = fontOf(fontSize);
    for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width);
  } else {
    for (const l of lines) w = Math.max(w, l.length * fontSize * 0.6);
  }
  return { w: Math.max(w, fontSize * 0.5), h: lines.length * fontSize * LINE_HEIGHT };
}

/* ------------------------------------------------------- forme da diagramma */

/** Dimensione dell'etichetta dentro forme e frecce (unità mondo). */
export const LABEL_SIZE = 20;
export const LABEL_LINE = LABEL_SIZE * LINE_HEIGHT;
/** Larghezza massima dell'etichetta di una freccia prima di andare a capo. */
export const ARROW_LABEL_MAX = 240;

export const centerOf = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Inclinazione dei lati del parallelogramma (forma "dati"). */
export const dataSkew = (b: { w: number; h: number }) => Math.min(b.h * 0.3, b.w * 0.2, 36);

/** Vertici di rombo e parallelogramma (null per le altre forme). */
export function boxPolygon(el: BoxEl): Point[] | null {
  const { x, y, w, h } = el;
  if (el.type === "diamond") {
    return [
      { x: x + w / 2, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w / 2, y: y + h },
      { x, y: y + h / 2 },
    ];
  }
  if (el.type === "data") {
    const s = dataSkew(el);
    return [
      { x: x + s, y },
      { x: x + w, y },
      { x: x + w - s, y: y + h },
      { x, y: y + h },
    ];
  }
  return null;
}

function inPolygon(p: Point, pts: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToPolygon(p: Point, pts: Point[]): number {
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) d = Math.min(d, distToSegment(p, pts[i], pts[(i + 1) % pts.length]));
  return d;
}

/** Distanza con segno dal contorno di "inizio/fine" (rettangolo con lati semicircolari): < 0 dentro. */
function sdTerminal(el: BoxEl, p: Point): number {
  const hw = Math.abs(el.w) / 2;
  const hh = Math.abs(el.h) / 2;
  const r = Math.min(hw, hh);
  const qx = Math.abs(p.x - (el.x + hw)) - (hw - r);
  const qy = Math.abs(p.y - (el.y + hh)) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** true se `p` è dentro la forma (bordo compreso), allargata di `pad`. */
export function insideBox(el: BoxEl, p: Point, pad = 0): boolean {
  switch (el.type) {
    case "rect":
    case "note":
      return rectContains(inflate(el, pad), p);
    case "ellipse": {
      const rx = el.w / 2 + pad;
      const ry = el.h / 2 + pad;
      if (rx <= 0 || ry <= 0) return false;
      const dx = (p.x - (el.x + el.w / 2)) / rx;
      const dy = (p.y - (el.y + el.h / 2)) / ry;
      return dx * dx + dy * dy <= 1;
    }
    case "terminal":
      return sdTerminal(el, p) <= pad;
    case "diamond":
    case "data": {
      const pts = boxPolygon(el)!;
      return inPolygon(p, pts) || (pad > 0 && distToPolygon(p, pts) <= pad);
    }
  }
}

/** Area in cui sta l'etichetta di una forma: dove il testo non tocca il contorno. */
export function labelArea(el: BoxEl): Rect {
  let w: number;
  let h: number;
  switch (el.type) {
    case "rect":
      w = el.w - 20;
      h = el.h - 12;
      break;
    case "note":
      w = el.w - 28;
      h = el.h - 24;
      break;
    case "terminal":
      w = el.w - Math.min(el.w, el.h) * 0.6 - 8;
      h = el.h - 12;
      break;
    case "ellipse":
      w = el.w * 0.72;
      h = el.h * 0.72;
      break;
    case "diamond":
      w = el.w * 0.52;
      h = el.h * 0.52;
      break;
    case "data":
      w = el.w - dataSkew(el) * 2 - 16;
      h = el.h - 12;
      break;
  }
  w = Math.max(24, w);
  h = Math.max(LABEL_LINE, h);
  return { x: el.x + (el.w - w) / 2, y: el.y + (el.h - h) / 2, w, h };
}

/** Altezza che deve avere la forma perché un'etichetta alta `textH` ci stia dentro. */
export function heightForLabel(el: BoxEl, textH: number): number {
  switch (el.type) {
    case "ellipse":
      return textH / 0.72 + 8;
    case "diamond":
      return textH / 0.52 + 8;
    default:
      return textH + 20;
  }
}

/** Spezza il testo in righe larghe al massimo `maxW` (a capo sulle parole; parole troppo lunghe spezzate). */
export function wrapText(text: string, maxW: number, fontSize: number): { lines: string[]; w: number } {
  if (!measureCtx && typeof document !== "undefined") measureCtx = document.createElement("canvas").getContext("2d");
  const ctx = measureCtx;
  if (ctx) ctx.font = fontOf(fontSize);
  const width = (t: string) => (ctx ? ctx.measureText(t).width : t.length * fontSize * 0.6);
  const lines: string[] = [];
  let maxLine = 0;
  const push = (l: string) => {
    lines.push(l);
    maxLine = Math.max(maxLine, width(l));
  };
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const cand = line ? `${line} ${word}` : word;
      if (width(cand) <= maxW) {
        line = cand;
        continue;
      }
      if (line) push(line);
      line = word;
      // parola più larga della riga: si spezza a caratteri
      while (width(line) > maxW && line.length > 1) {
        let n = line.length - 1;
        while (n > 1 && width(line.slice(0, n)) > maxW) n--;
        push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    push(line);
  }
  return { lines, w: maxLine };
}

const labelCache = new WeakMap<El, { lines: string[]; w: number }>();

/** Righe dell'etichetta di una forma o di una freccia (in cache: gli elementi sono immutabili). */
export function labelLines(el: BoxEl | LineEl): { lines: string[]; w: number } {
  const hit = labelCache.get(el);
  if (hit) return hit;
  const maxW = el.type === "line" || el.type === "arrow" ? ARROW_LABEL_MAX : labelArea(el as BoxEl).w;
  const r = el.label ? wrapText(el.label, maxW, LABEL_SIZE) : { lines: [], w: 0 };
  labelCache.set(el, r);
  return r;
}

/** Riquadro dell'etichetta di una freccia, centrato a metà del collegamento (null senza etichetta). */
export function lineLabelRect(el: LineEl): Rect | null {
  if (!el.label) return null;
  const { lines, w } = labelLines(el);
  const bw = w + 12;
  const bh = lines.length * LABEL_LINE + 6;
  return { x: (el.a.x + el.b.x) / 2 - bw / 2, y: (el.a.y + el.b.y) / 2 - bh / 2, w: bw, h: bh };
}

/* ---------------------------------------------------------------- bounds */

export function arrowHeadLength(a: Point, b: Point, width: number): number {
  return Math.min(Math.max(14, width * 4.5), dist(a, b) * 0.6);
}

const boundsCache = new WeakMap<El, Rect>();

/** Bounding box in coordinate mondo, comprensivo dello spessore del tratto. */
export function boundsOf(el: El): Rect {
  const cached = boundsCache.get(el);
  if (cached) return cached;
  const hw = el.width / 2;
  let r: Rect;
  switch (el.type) {
    case "stroke": {
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      for (const p of el.points) {
        if (p.x < x1) x1 = p.x;
        if (p.y < y1) y1 = p.y;
        if (p.x > x2) x2 = p.x;
        if (p.y > y2) y2 = p.y;
      }
      r = { x: x1 - hw, y: y1 - hw, w: x2 - x1 + el.width, h: y2 - y1 + el.width };
      break;
    }
    case "line":
    case "arrow": {
      const pad = hw + (el.type === "arrow" ? arrowHeadLength(el.a, el.b, el.width) : 0);
      r = inflate(rectFromPoints(el.a, el.b), pad);
      const lr = lineLabelRect(el);
      if (lr) r = unionRects([r, lr])!;
      break;
    }
    case "rect":
    case "ellipse":
    case "diamond":
    case "terminal":
    case "data":
      r = inflate({ x: el.x, y: el.y, w: el.w, h: el.h }, hw);
      break;
    case "note":
    case "image":
      r = { x: el.x, y: el.y, w: el.w, h: el.h };
      break;
    case "text": {
      const m = measureText(el.text, el.fontSize);
      r = { x: el.x, y: el.y, w: m.w, h: m.h };
      break;
    }
    case "comment":
      // la posizione vera dipende dall'elemento a cui è attaccato: i commenti si disegnano a parte
      r = { x: el.x, y: el.y, w: 0, h: 0 };
      break;
  }
  boundsCache.set(el, r);
  return r;
}

/** Bounding box geometrico (senza lo spessore del tratto): base per il ridimensionamento. */
export function geomBoundsOf(el: El): Rect {
  switch (el.type) {
    case "stroke": {
      let x1 = Infinity;
      let y1 = Infinity;
      let x2 = -Infinity;
      let y2 = -Infinity;
      for (const p of el.points) {
        if (p.x < x1) x1 = p.x;
        if (p.y < y1) y1 = p.y;
        if (p.x > x2) x2 = p.x;
        if (p.y > y2) y2 = p.y;
      }
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    case "line":
    case "arrow":
      return rectFromPoints(el.a, el.b);
    case "rect":
    case "ellipse":
    case "diamond":
    case "terminal":
    case "data":
    case "note":
    case "image":
      return { x: el.x, y: el.y, w: el.w, h: el.h };
    case "text":
    case "comment":
      return boundsOf(el);
  }
}

/* ------------------------------------------------------------- hit-test */

/** `tol` è la tolleranza in unità mondo (es. 6px / zoom). */
export function hitTest(el: El, p: Point, tol: number): boolean {
  const hw = el.width / 2 + tol;
  switch (el.type) {
    case "stroke": {
      const pts = el.points;
      if (pts.length === 1) return dist(p, pts[0]) <= hw;
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSegment(p, pts[i], pts[i + 1]) <= hw) return true;
      }
      return false;
    }
    case "line":
    case "arrow": {
      const lr = lineLabelRect(el);
      return distToSegment(p, el.a, el.b) <= hw || (!!lr && rectContains(inflate(lr, tol), p));
    }
    case "rect": {
      if (el.fill && rectContains(el, p)) return true;
      if (el.label && rectContains(labelArea(el), p)) return true;
      return distToRectOutline(p, el) <= hw;
    }
    case "diamond":
    case "data": {
      const pts = boxPolygon(el)!;
      if ((el.fill || el.label) && inPolygon(p, pts)) return true;
      return distToPolygon(p, pts) <= hw;
    }
    case "terminal": {
      const d = sdTerminal(el, p);
      if ((el.fill || el.label) && d <= 0) return true;
      return Math.abs(d) <= hw;
    }
    case "ellipse": {
      const rx = el.w / 2;
      const ry = el.h / 2;
      if (rx < 0.5 || ry < 0.5) {
        return distToSegment(p, { x: el.x, y: el.y }, { x: el.x + el.w, y: el.y + el.h }) <= hw;
      }
      const dx = p.x - (el.x + rx);
      const dy = p.y - (el.y + ry);
      const dc = Math.hypot(dx, dy);
      const q = Math.hypot(dx / rx, dy / ry);
      if ((el.fill || el.label) && q <= 1) return true;
      // distanza radiale dal contorno (approssimazione ottima per hit-test)
      const d = dc === 0 ? Math.min(rx, ry) : Math.abs(dc - dc / q);
      return d <= hw;
    }
    case "note":
    case "image":
    case "text":
      return rectContains(inflate(boundsOf(el), tol), p);
    case "comment":
      return false;
  }
}

/* ----------------------------------------------------------- transforms */

export function translateEl(el: El, dx: number, dy: number): El {
  switch (el.type) {
    case "stroke":
      return { ...el, points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case "line":
    case "arrow":
      return {
        ...el,
        a: { x: el.a.x + dx, y: el.a.y + dy },
        b: { x: el.b.x + dx, y: el.b.y + dy },
      };
    case "rect":
    case "ellipse":
    case "diamond":
    case "terminal":
    case "data":
    case "note":
    case "image":
    case "text":
      return { ...el, x: el.x + dx, y: el.y + dy };
    case "comment":
      // un commento attaccato a un elemento lo segue da solo
      return el.target ? el : { ...el, x: el.x + dx, y: el.y + dy };
  }
}

/** Scala un elemento rispetto al punto (ox, oy). sx, sy devono essere > 0. */
export function scaleEl(el: El, ox: number, oy: number, sx: number, sy: number): El {
  const mx = (x: number) => ox + (x - ox) * sx;
  const my = (y: number) => oy + (y - oy) * sy;
  switch (el.type) {
    case "stroke":
      return { ...el, points: el.points.map((p) => ({ x: mx(p.x), y: my(p.y) })) };
    case "line":
    case "arrow":
      return {
        ...el,
        a: { x: mx(el.a.x), y: my(el.a.y) },
        b: { x: mx(el.b.x), y: my(el.b.y) },
      };
    case "rect":
    case "ellipse":
    case "diamond":
    case "terminal":
    case "data":
    case "note":
    case "image":
      return { ...el, x: mx(el.x), y: my(el.y), w: el.w * sx, h: el.h * sy };
    case "comment":
      return el;
    case "text":
      return {
        ...el,
        x: mx(el.x),
        y: my(el.y),
        fontSize: Math.max(6, el.fontSize * ((sx + sy) / 2)),
      };
  }
}

/* --------------------------------------------------------- simplification */

/** Ramer–Douglas–Peucker iterativo (nessun rischio di stack overflow). */
export function simplify(points: Point[], eps: number): Point[] {
  const n = points.length;
  if (n < 3) return points;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(points[i], points[s], points[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx > 0 && maxD > eps) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}
