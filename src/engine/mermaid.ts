import type { Dir } from "./layout";
import type { BoxType } from "./types";

/**
 * Lettura dei diagrammi di flusso Mermaid (`flowchart` / `graph`): nodi, forme, collegamenti ed
 * etichette. Il resto (stili, classi, sottografi, clic) si ignora: il diagramma arriva comunque.
 *
 *   flowchart TD
 *     A([Inizio]) --> B[/Leggi i dati/]
 *     B --> C{Valido?}
 *     C -->|Sì| D[Salva]
 *     C -- No --> B
 */

export interface MNode {
  id: string;
  label: string;
  shape: BoxType;
}

export interface MEdge {
  from: string;
  to: string;
  label?: string;
  arrow: boolean;
}

export interface MGraph {
  dir: Dir;
  nodes: MNode[];
  edges: MEdge[];
}

/** Forma Mermaid → forma della lavagna (dalla più specifica). */
const SHAPES: Array<[string, string, BoxType]> = [
  ["([", "])", "terminal"],
  ["((", "))", "ellipse"],
  ["[(", ")]", "rect"],
  ["[[", "]]", "rect"],
  ["[/", "/]", "data"],
  ["[\\", "\\]", "data"],
  ["[/", "\\]", "data"],
  ["[\\", "/]", "data"],
  ["{{", "}}", "diamond"],
  ["(", ")", "terminal"],
  ["[", "]", "rect"],
  ["{", "}", "diamond"],
  [">", "]", "rect"],
];

/** Id di un nodo: lettere, cifre, _ . e trattini (ma non quelli di un collegamento come "-->"). */
const ID = /^[A-Za-z0-9_](?:[\w.]|-(?![-.>=]))*/;
/** Collegamento: -->, ---, -.->, ==>, --x, --o, con etichetta "-- testo -->" o "-->|testo|". */
const LINK = /^\s*(?:(--|==|-\.)\s*([^-=.>|][^>]*?)\s*)?(-{2,}>|-{3,}|={2,}>|={3,}|-\.+->|-\.+-|--[xo]|<-{2,}>)\s*(?:\|([^|]*)\|)?\s*/;

function cleanLabel(s: string): string {
  let t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  return t
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/#(\w+);/g, "")
    .trim()
    .slice(0, 2000);
}

interface Parsed {
  ids: string[];
  rest: string;
}

/** Legge "A[testo]" (o "A & B") all'inizio di `src`, registrando i nodi. */
function readNodes(src: string, nodes: Map<string, MNode>): Parsed | null {
  const ids: string[] = [];
  let s = src;
  for (;;) {
    s = s.replace(/^\s+/, "");
    const m = ID.exec(s);
    if (!m) return ids.length ? { ids, rest: s } : null;
    const id = m[0];
    s = s.slice(id.length);
    let label: string | null = null;
    let shape: BoxType | null = null;
    for (const [open, close, sh] of SHAPES) {
      if (!s.startsWith(open)) continue;
      const end = s.indexOf(close, open.length);
      if (end < 0) continue;
      label = cleanLabel(s.slice(open.length, end));
      shape = sh;
      s = s.slice(end + close.length);
      break;
    }
    // classe ":::nome" dopo il nodo: si ignora
    s = s.replace(/^:::[\w-]+/, "");
    const known = nodes.get(id);
    if (!known) nodes.set(id, { id, label: label ?? id, shape: shape ?? "rect" });
    else if (label !== null) nodes.set(id, { id, label, shape: shape ?? known.shape });
    ids.push(id);
    const amp = /^\s*&\s*/.exec(s);
    if (!amp) return { ids, rest: s };
    s = s.slice(amp[0].length);
  }
}

export function parseMermaid(text: string): MGraph | null {
  const lines = text
    .replace(/%%.*$/gm, "")
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  let dir: Dir = "TB";
  const head = /^(flowchart|graph)\b\s*(TB|TD|BT|LR|RL)?/i.exec(lines[0]);
  if (head) {
    const d = (head[2] ?? "TB").toUpperCase();
    dir = d === "TD" ? "TB" : (d as Dir);
    lines.shift();
  }
  const nodes = new Map<string, MNode>();
  const edges: MEdge[] = [];
  for (const line of lines) {
    if (/^(subgraph|end|style|classDef|class|click|linkStyle|direction)\b/i.test(line)) {
      const d = /^direction\s+(TB|TD|BT|LR|RL)/i.exec(line);
      if (d) dir = d[1].toUpperCase() === "TD" ? "TB" : (d[1].toUpperCase() as Dir);
      continue;
    }
    let cur = readNodes(line, nodes);
    if (!cur) continue;
    for (;;) {
      const m = LINK.exec(cur.rest);
      if (!m) break;
      const label = cleanLabel(m[4] ?? m[2] ?? "");
      const op = m[3];
      const arrow = op.endsWith(">") || op.endsWith("x") || op.endsWith("o");
      const next = readNodes(cur.rest.slice(m[0].length), nodes);
      if (!next) break;
      for (const a of cur.ids)
        for (const b of next.ids) {
          edges.push(label ? { from: a, to: b, label, arrow } : { from: a, to: b, arrow });
          // "<-->": anche all'indietro
          if (op.startsWith("<")) edges.push({ from: b, to: a, arrow: true });
        }
      cur = next;
    }
  }
  if (!nodes.size) return null;
  return { dir, nodes: [...nodes.values()], edges };
}
