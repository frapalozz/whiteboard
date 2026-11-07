import { arrowHeadLength, boxPolygon, FONT_FAMILY, LABEL_LINE, LABEL_SIZE, labelLines, LINE_HEIGHT, lineLabelRect } from "./geometry";
import { isDark } from "./render";
import { isBox, type El, type Rect } from "./types";

/**
 * Esportazione in SVG: gli stessi elementi disegnati sul canvas, come grafica vettoriale (si ingrandisce
 * senza perdere qualità e si apre in Inkscape, Figma, Illustrator…). Le immagini sono incluse nel file.
 */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => (Math.round(v * 100) / 100).toString();

function strokePath(pts: { x: number; y: number }[]): string {
  if (pts.length === 1) return "";
  let d = `M${n(pts[0].x)} ${n(pts[0].y)}`;
  if (pts.length === 2) return `${d}L${n(pts[1].x)} ${n(pts[1].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    d += `Q${n(pts[i].x)} ${n(pts[i].y)} ${n(mx)} ${n(my)}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${n(last.x)} ${n(last.y)}`;
}

function labelSvg(lines: string[], cx: number, cy: number, color: string): string {
  const top = cy - ((lines.length - 1) * LABEL_LINE) / 2;
  return lines
    .map(
      (l, i) =>
        `<text x="${n(cx)}" y="${n(top + i * LABEL_LINE)}" fill="${color}" font-size="${LABEL_SIZE}" text-anchor="middle" dominant-baseline="central">${esc(l)}</text>`,
    )
    .join("");
}

function elementSvg(el: El, images: Map<string, string>, bg: string): string {
  const stroke = `stroke="${el.color}" stroke-width="${n(el.width)}" stroke-linecap="round" stroke-linejoin="round"`;
  const soft = (fill: boolean) => (fill ? `fill="${el.color}" fill-opacity="0.2"` : `fill="none"`);
  let out = "";
  switch (el.type) {
    case "stroke":
      if (el.points.length === 1) out = `<circle cx="${n(el.points[0].x)}" cy="${n(el.points[0].y)}" r="${n(el.width / 2)}" fill="${el.color}"/>`;
      else out = `<path d="${strokePath(el.points)}" fill="none" ${stroke}/>`;
      break;
    case "line":
    case "arrow": {
      out = `<line x1="${n(el.a.x)}" y1="${n(el.a.y)}" x2="${n(el.b.x)}" y2="${n(el.b.y)}" ${stroke}/>`;
      if (el.type === "arrow") {
        const head = arrowHeadLength(el.a, el.b, el.width);
        const ang = Math.atan2(el.b.y - el.a.y, el.b.x - el.a.x);
        const s = Math.PI / 7;
        out += `<polyline points="${n(el.b.x - head * Math.cos(ang - s))},${n(el.b.y - head * Math.sin(ang - s))} ${n(el.b.x)},${n(el.b.y)} ${n(el.b.x - head * Math.cos(ang + s))},${n(el.b.y - head * Math.sin(ang + s))}" fill="none" ${stroke}/>`;
      }
      const lr = lineLabelRect(el);
      if (lr) {
        out += `<rect x="${n(lr.x)}" y="${n(lr.y)}" width="${n(lr.w)}" height="${n(lr.h)}" rx="6" fill="${bg}"/>`;
        out += labelSvg(labelLines(el).lines, lr.x + lr.w / 2, lr.y + lr.h / 2, el.color);
      }
      break;
    }
    case "rect":
      out = `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" ${soft(el.fill)} ${stroke}/>`;
      break;
    case "ellipse":
      out = `<ellipse cx="${n(el.x + el.w / 2)}" cy="${n(el.y + el.h / 2)}" rx="${n(el.w / 2)}" ry="${n(el.h / 2)}" ${soft(el.fill)} ${stroke}/>`;
      break;
    case "terminal": {
      const r = Math.min(el.w, el.h) / 2;
      out = `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" rx="${n(r)}" ${soft(el.fill)} ${stroke}/>`;
      break;
    }
    case "diamond":
    case "data": {
      const pts = boxPolygon(el)!.map((p) => `${n(p.x)},${n(p.y)}`).join(" ");
      out = `<polygon points="${pts}" ${soft(el.fill)} ${stroke}/>`;
      break;
    }
    case "note":
      out = `<rect x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" rx="6" fill="${el.color}" filter="url(#note-shadow)"/>`;
      break;
    case "image": {
      const href = images.get(el.src);
      if (href) out = `<image x="${n(el.x)}" y="${n(el.y)}" width="${n(el.w)}" height="${n(el.h)}" preserveAspectRatio="none" href="${href}"/>`;
      break;
    }
    case "text":
      out = el.text
        .split("\n")
        .map(
          (l, i) =>
            `<text x="${n(el.x)}" y="${n(el.y + i * el.fontSize * LINE_HEIGHT)}" fill="${el.color}" font-size="${n(el.fontSize)}" dominant-baseline="text-before-edge" xml:space="preserve">${esc(l)}</text>`,
        )
        .join("");
      break;
    case "comment":
      return "";
  }
  if (isBox(el) && el.label) {
    const ink = el.type === "note" ? (isDark(el.color) ? "#f8f9fa" : "#1f2328") : el.color;
    out += labelSvg(labelLines(el).lines, el.x + el.w / 2, el.y + el.h / 2, ink);
  }
  return out;
}

/**
 * SVG dell'area `area` (coordinate mondo). `images`: data URL dei file delle immagini, per id.
 * `bg`: colore di sfondo (null = trasparente).
 */
export function buildSvg(els: El[], area: Rect, images: Map<string, string>, bg: string | null): string {
  const body = els.map((el) => elementSvg(el, images, bg ?? "#ffffff")).join("\n");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(area.x)} ${n(area.y)} ${n(area.w)} ${n(area.h)}" width="${Math.round(area.w)}" height="${Math.round(area.h)}" font-family='${FONT_FAMILY}'>`,
    `<defs><filter id="note-shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-opacity="0.18"/></filter></defs>`,
    bg ? `<rect x="${n(area.x)}" y="${n(area.y)}" width="${n(area.w)}" height="${n(area.h)}" fill="${bg}"/>` : "",
    body,
    `</svg>`,
  ].join("\n");
}
