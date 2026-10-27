import { GRIDS } from "./collab/validate";
import { parseBoard } from "./storage";
import type { El, PersistedBoard } from "./types";

/**
 * Condivisione tramite URL.
 *
 * L'intera lavagna (elementi, vista, sfondo, griglia, nome) viene serializzata in un formato compatto,
 * compressa con deflate e messa nel *fragment* dell'URL (`#lavagna=...`). Il fragment non viene mai
 * inviato al server: il link funziona anche su un hosting statico e senza backend.
 *
 * Formato (v1): JSON compatto → deflate-raw → base64url, preceduto da un carattere di formato:
 *   "z" = compresso, "p" = non compresso (browser senza CompressionStream).
 * Le coordinate sono arrotondate al centesimo di unità mondo; i tratti sono codificati a delta.
 */

export const SHARE_PARAM = "lavagna";

/** Oltre questa lunghezza alcune app (chat, social) possono troncare il link. */
export const SHARE_SOFT_LIMIT = 8_000;
/** Oltre questa lunghezza il link rischia di non aprirsi nei browser: si rifiuta. */
export const SHARE_HARD_LIMIT = 1_500_000;
/** Protezione da "zip bomb": dimensione massima del JSON decompresso. */
const MAX_INFLATED = 40 * 1024 * 1024;

const TYPES = ["stroke", "line", "arrow", "rect", "ellipse", "text"] as const;

const q = (v: number) => Math.round(v * 100);
const uq = (v: number) => v / 100;
const hex = (c: string) => c.replace(/^#/, "");

/* ---------- elementi ⇄ forma compatta ---------- */

type Packed = Array<number | string>;

function packElement(el: El): Packed {
  const head: Packed = [TYPES.indexOf(el.type), hex(el.color), Math.round(el.width * 100) / 100];
  switch (el.type) {
    case "stroke": {
      const out = head;
      let px = 0;
      let py = 0;
      for (const p of el.points) {
        const x = q(p.x);
        const y = q(p.y);
        out.push(x - px, y - py);
        px = x;
        py = y;
      }
      return out;
    }
    case "line":
    case "arrow":
      return [...head, q(el.a.x), q(el.a.y), q(el.b.x), q(el.b.y)];
    case "rect":
    case "ellipse":
      return [...head, q(el.x), q(el.y), q(el.w), q(el.h), el.fill ? 1 : 0];
    case "text":
      return [...head, q(el.x), q(el.y), Math.round(el.fontSize * 100) / 100, el.text];
  }
}

/** Ricostruisce un elemento "grezzo" (verrà validato da parseBoard). */
function unpackElement(p: unknown, index: number): unknown {
  if (!Array.isArray(p) || p.length < 3) return null;
  const type = TYPES[p[0] as number];
  if (!type) return null;
  const base = { id: `sh${index.toString(36)}`, type, color: `#${String(p[1])}`, width: p[2] };
  const n = (i: number) => uq(Number(p[i]));
  switch (type) {
    case "stroke": {
      const points = [];
      let x = 0;
      let y = 0;
      for (let i = 3; i + 1 < p.length; i += 2) {
        x += Number(p[i]);
        y += Number(p[i + 1]);
        points.push({ x: uq(x), y: uq(y) });
      }
      return { ...base, points };
    }
    case "line":
    case "arrow":
      return { ...base, a: { x: n(3), y: n(4) }, b: { x: n(5), y: n(6) } };
    case "rect":
    case "ellipse":
      return { ...base, x: n(3), y: n(4), w: n(5), h: n(6), fill: p[7] === 1 };
    case "text":
      return { ...base, x: n(3), y: n(4), fontSize: Number(p[5]), text: String(p[6] ?? "") };
  }
}

/* ---------- base64url ---------- */

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- compressione ---------- */

export const hasStreams = () => typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INFLATED) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/* ---------- API pubblica ---------- */

/** Codifica una lavagna nel valore del fragment (senza il prefisso `lavagna=`). */
export async function encodeBoard(board: PersistedBoard): Promise<string> {
  const doc = {
    v: 1,
    n: board.name ?? "",
    b: board.bgColor ? hex(board.bgColor) : undefined,
    g: board.grid ? GRIDS.indexOf(board.grid) : undefined,
    p: board.pages || undefined,
    c: board.camera ? [q(board.camera.x), q(board.camera.y), Math.round(board.camera.zoom * 1000) / 1000] : undefined,
    e: board.elements.map(packElement),
  };
  const raw = new TextEncoder().encode(JSON.stringify(doc));
  if (hasStreams()) {
    try {
      return "z" + toBase64Url(await deflate(raw));
    } catch {
      /* ripiega sul formato non compresso */
    }
  }
  return "p" + toBase64Url(raw);
}

/** Decodifica il valore del fragment. Restituisce null se non è una lavagna valida. */
export async function decodeBoard(value: string): Promise<PersistedBoard | null> {
  try {
    if (value.length < 2 || value.length > SHARE_HARD_LIMIT * 2) return null;
    const mode = value[0];
    let bytes = fromBase64Url(value.slice(1));
    if (mode === "z") {
      if (!hasStreams()) return null;
      bytes = await inflate(bytes);
    } else if (mode !== "p") {
      return null;
    }
    const doc: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof doc !== "object" || doc === null) return null;
    const d = doc as Record<string, unknown>;
    if (d.v !== 1 || !Array.isArray(d.e)) return null;

    const cam = Array.isArray(d.c) && d.c.length === 3 ? d.c.map(Number) : null;
    // La validazione vera (colori, limiti, tipi) è quella già usata per l'import dei file .json.
    return parseBoard(
      JSON.stringify({
        version: 1,
        name: typeof d.n === "string" ? d.n : undefined,
        bgColor: typeof d.b === "string" ? `#${d.b}` : undefined,
        grid: typeof d.g === "number" ? GRIDS[d.g] : undefined,
        pages: d.p,
        camera: cam ? { x: uq(cam[0]), y: uq(cam[1]), zoom: cam[2] } : undefined,
        elements: d.e.map(unpackElement).filter((e) => e !== null),
      }),
    );
  } catch {
    return null;
  }
}

/** URL completo per condividere la lavagna, costruito sulla pagina corrente. */
export async function buildShareUrl(board: PersistedBoard): Promise<string> {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `${SHARE_PARAM}=${await encodeBoard(board)}`;
  return url.toString();
}

/** Estrae il valore condiviso dal fragment corrente (null se assente). */
export function readShareHash(hash: string = window.location.hash): string | null {
  const m = new RegExp(`^#${SHARE_PARAM}=([A-Za-z0-9_-]+)$`).exec(hash);
  return m ? m[1] : null;
}
