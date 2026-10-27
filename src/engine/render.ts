import {
  arrowHeadLength,
  boundsOf,
  fontOf,
  LINE_HEIGHT,
  rectsIntersect,
} from "./geometry";
import { PAGE_GAP, PAGE_STRIDE, pageRect, type Camera, type El, type GridMode, type Point, type Rect } from "./types";

const lodCache = new WeakMap<El, { level: number; pts: Point[] }>();

/**
 * Quando si è zoomati fuori, i punti più vicini di ~1px schermo non cambiano
 * l'aspetto del tratto: li saltiamo. Il risultato è in cache per (elemento, livello).
 */
function lodPoints(el: El, pts: Point[], zoom: number): Point[] {
  if (zoom >= 0.7 || pts.length < 12) return pts;
  const level = Math.round(Math.log2(zoom) * 2);
  const hit = lodCache.get(el);
  if (hit && hit.level === level) return hit.pts;
  const minStep = 1.2 / Math.pow(2, level / 2);
  const min2 = minStep * minStep;
  const out: Point[] = [pts[0]];
  let last = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    if (dx * dx + dy * dy >= min2) {
      out.push(p);
      last = p;
    }
  }
  out.push(pts[pts.length - 1]);
  lodCache.set(el, { level, pts: out });
  return out;
}

/**
 * Disegna un elemento. Il contesto deve già avere la trasformazione mondo→schermo.
 * `zoom` abilita il livello di dettaglio per gli elementi già confermati
 * (non va passato per le bozze, i cui punti cambiano mentre si disegna).
 */
export function drawElement(ctx: CanvasRenderingContext2D, el: El, zoom = 1): void {
  ctx.strokeStyle = el.color;
  ctx.fillStyle = el.color;
  ctx.lineWidth = el.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (el.type) {
    case "stroke": {
      const pts = lodPoints(el, el.points, zoom);
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, el.width / 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 2) {
        ctx.lineTo(pts[1].x, pts[1].y);
      } else {
        // curve quadratiche passanti per i punti medi: tratto liscio senza "spigoli"
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x, last.y);
      }
      ctx.stroke();
      break;
    }
    case "line":
    case "arrow": {
      ctx.beginPath();
      ctx.moveTo(el.a.x, el.a.y);
      ctx.lineTo(el.b.x, el.b.y);
      ctx.stroke();
      if (el.type === "arrow") {
        const head = arrowHeadLength(el.a, el.b, el.width);
        const ang = Math.atan2(el.b.y - el.a.y, el.b.x - el.a.x);
        const spread = Math.PI / 7;
        ctx.beginPath();
        ctx.moveTo(el.b.x - head * Math.cos(ang - spread), el.b.y - head * Math.sin(ang - spread));
        ctx.lineTo(el.b.x, el.b.y);
        ctx.lineTo(el.b.x - head * Math.cos(ang + spread), el.b.y - head * Math.sin(ang + spread));
        ctx.stroke();
      }
      break;
    }
    case "rect": {
      if (el.fill) {
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * 0.2;
        ctx.fillRect(el.x, el.y, el.w, el.h);
        ctx.globalAlpha = a;
      }
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      break;
    }
    case "ellipse": {
      ctx.beginPath();
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2);
      if (el.fill) {
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * 0.2;
        ctx.fill();
        ctx.globalAlpha = a;
      }
      ctx.stroke();
      break;
    }
    case "text": {
      ctx.font = fontOf(el.fontSize);
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      const lines = el.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], el.x, el.y + i * el.fontSize * LINE_HEIGHT);
      }
      break;
    }
  }
}

/**
 * Disegna tutti gli elementi visibili in `view` (coordinate mondo).
 * `fade`: id da disegnare semitrasparenti (gomma). `hideId`: id da non disegnare
 * (testo in modifica).
 */
export function drawElements(
  ctx: CanvasRenderingContext2D,
  elements: El[],
  view: Rect | null,
  fade?: Set<string>,
  hideId?: string | null,
  zoom = 1,
): void {
  for (const el of elements) {
    if (hideId && el.id === hideId) continue;
    if (view && !rectsIntersect(boundsOf(el), view)) continue;
    ctx.globalAlpha = fade && fade.has(el.id) ? 0.25 : 1;
    drawElement(ctx, el, zoom);
  }
  ctx.globalAlpha = 1;
}

export function isDark(hex: string): boolean {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length < 6) return false;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/** Mescola un colore esadecimale con il bianco (amount > 0) o il nero (amount < 0). */
function shade(hex: string, amount: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  const t = amount > 0 ? 255 : 0;
  const a = Math.abs(amount);
  return `rgb(${n.map((v) => Math.round(v + (t - v) * a)).join(",")})`;
}

/** Passo dei quadretti e delle righe in unità mondo (le pagine iniziano a multipli di entrambi). */
export const SQUARE = 20;
export const RULE = 40;
/** Distanza del margine rosso dal bordo sinistro della pagina (solo foglio a righe). */
export const MARGIN = 120;

/**
 * Disegna il motivo di sfondo in coordinate schermo (CSS px), dentro `area` (di default tutta la vista).
 * Punti e griglia si adattano allo zoom; quadretti e righe sono ancorati al foglio come in un quaderno.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  width: number,
  height: number,
  mode: GridMode,
  dark: boolean,
  area: Rect = { x: 0, y: 0, w: width, h: height },
): void {
  if (mode === "none") return;
  const x0 = area.x;
  const y0 = area.y;
  const x1 = area.x + area.w;
  const y1 = area.y + area.h;
  /** Prima linea della griglia di passo `spacing` (mondo) visibile da `from` (schermo). */
  const first = (spacing: number, camPos: number, from: number) => {
    const world = camPos + from / cam.zoom;
    return (Math.ceil(world / spacing) * spacing - camPos) * cam.zoom;
  };

  if (mode === "squares" || mode === "ruled") {
    const spacing = mode === "squares" ? SQUARE : RULE;
    let step = spacing * cam.zoom;
    // zoomati molto fuori le linee sparirebbero in un grigio uniforme: si diradano
    let k = 1;
    while (step * k < 6) k *= 5;
    step *= k;
    const alpha = Math.min(1, (step - 4) / 10);
    if (alpha <= 0) return;
    ctx.strokeStyle = dark ? `rgba(150,185,255,${0.22 * alpha})` : `rgba(70,120,200,${0.32 * alpha})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (mode === "squares") {
      for (let x = first(spacing * k, cam.x, x0); x < x1; x += step) {
        ctx.moveTo(Math.round(x) + 0.5, y0);
        ctx.lineTo(Math.round(x) + 0.5, y1);
      }
    }
    for (let y = first(spacing * k, cam.y, y0); y < y1; y += step) {
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x1, Math.round(y) + 0.5);
    }
    ctx.stroke();
    return;
  }

  let spacing = 24;
  while (spacing * cam.zoom < 12) spacing *= 2;
  const step = spacing * cam.zoom;
  const startX = first(spacing, cam.x, x0);
  const startY = first(spacing, cam.y, y0);
  const color = dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.15)";

  if (mode === "dots") {
    ctx.fillStyle = color;
    const s = Math.max(1.4, Math.min(2.4, cam.zoom * 1.6));
    for (let x = startX; x < x1; x += step) {
      for (let y = startY; y < y1; y += step) {
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startX; x < x1; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, y0);
      ctx.lineTo(Math.round(x) + 0.5, y1);
    }
    for (let y = startY; y < y1; y += step) {
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x1, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }
}

/**
 * Modalità lezione: il "tavolo" e i fogli, in coordinate schermo. Fuori dalle pagine lo sfondo è un
 * po' più scuro (o più chiaro su sfondi scuri); ogni pagina ha il colore di sfondo, il motivo scelto e il
 * suo numero.
 */
export function drawPages(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  width: number,
  height: number,
  count: number,
  bgColor: string,
  mode: GridMode,
  current: number,
): void {
  const dark = isDark(bgColor);
  ctx.fillStyle = shade(bgColor, dark ? 0.1 : -0.09);
  ctx.fillRect(0, 0, width, height);

  const z = cam.zoom;
  const first = Math.max(0, Math.floor(cam.y / PAGE_STRIDE));
  const last = Math.min(count - 1, Math.floor((cam.y + height / z) / PAGE_STRIDE));
  for (let i = first; i <= last; i++) {
    const r = pageRect(i);
    const s: Rect = { x: (r.x - cam.x) * z, y: (r.y - cam.y) * z, w: r.w * z, h: r.h * z };
    if (s.x > width || s.x + s.w < 0) continue;

    ctx.save();
    ctx.shadowColor = dark ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.16)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = bgColor;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(s.x, s.y, s.w, s.h);
    ctx.clip();
    drawGrid(ctx, cam, width, height, mode, dark, {
      x: Math.max(0, s.x),
      y: Math.max(0, s.y),
      w: Math.min(width, s.x + s.w) - Math.max(0, s.x),
      h: Math.min(height, s.y + s.h) - Math.max(0, s.y),
    });
    if (mode === "ruled" && MARGIN * z > 8) {
      const mx = Math.round(s.x + MARGIN * z) + 0.5;
      ctx.strokeStyle = dark ? "rgba(255,120,120,0.45)" : "rgba(220,60,60,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mx, s.y);
      ctx.lineTo(mx, s.y + s.h);
      ctx.stroke();
    }
    ctx.restore();

    // numero della pagina, nello spazio tra un foglio e l'altro
    if (PAGE_GAP * z >= 22) {
      const fs = Math.min(15, Math.max(11, 13 * z));
      ctx.font = `${i === current ? 700 : 500} ${fs}px system-ui, -apple-system, sans-serif`;
      ctx.textBaseline = "bottom";
      ctx.textAlign = "left";
      ctx.fillStyle = dark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.5)";
      ctx.fillText(`Pagina ${i + 1}`, s.x + 2, s.y - 6);
    }
  }
}
