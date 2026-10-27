import { GRIDS, parsePages, parseSaved } from "./collab/validate";
import { MAX_ZOOM, MIN_ZOOM } from "./types";
import type { BoardMeta, Camera, El, GridMode, PersistedBoard, Point } from "./types";

/** Chiave usata dalla versione precedente (una sola lavagna): viene migrata al primo avvio. */
export const LEGACY_KEY = "whiteboard:v1";
export const INDEX_KEY = "whiteboard:index";
export const boardKey = (id: string) => `whiteboard:board:${id}`;

const HEX = /^#[0-9a-f]{3,8}$/i;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function point(v: unknown): Point | null {
  if (!isObj(v) || !isNum(v.x) || !isNum(v.y)) return null;
  return { x: v.x, y: v.y };
}

export function sanitizeColor(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX.test(v) ? v.toLowerCase() : fallback;
}

/** Valida un elemento proveniente da localStorage o da un file importato. */
export function sanitizeElement(raw: unknown): El | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : null;
  if (!id) return null;
  const color = sanitizeColor(raw.color, "#000000");
  const width = isNum(raw.width) ? Math.min(200, Math.max(0.5, raw.width)) : 4;

  switch (raw.type) {
    case "stroke": {
      if (!Array.isArray(raw.points) || raw.points.length === 0) return null;
      const points: Point[] = [];
      for (const p of raw.points) {
        const sp = point(p);
        if (!sp) return null;
        points.push(sp);
      }
      return { id, type: "stroke", color, width, points };
    }
    case "line":
    case "arrow": {
      const a = point(raw.a);
      const b = point(raw.b);
      if (!a || !b) return null;
      return { id, type: raw.type, color, width, a, b };
    }
    case "rect":
    case "ellipse": {
      if (!isNum(raw.x) || !isNum(raw.y) || !isNum(raw.w) || !isNum(raw.h)) return null;
      return {
        id,
        type: raw.type,
        color,
        width,
        x: raw.x,
        y: raw.y,
        w: Math.abs(raw.w),
        h: Math.abs(raw.h),
        fill: raw.fill === true,
      };
    }
    case "text": {
      if (!isNum(raw.x) || !isNum(raw.y) || typeof raw.text !== "string") return null;
      const fontSize = isNum(raw.fontSize) ? Math.min(600, Math.max(6, raw.fontSize)) : 24;
      return { id, type: "text", color, width, x: raw.x, y: raw.y, text: raw.text.slice(0, 20000), fontSize };
    }
    default:
      return null;
  }
}

function sanitizeCamera(v: unknown): Camera | undefined {
  if (!isObj(v) || !isNum(v.x) || !isNum(v.y) || !isNum(v.zoom)) return undefined;
  return { x: v.x, y: v.y, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom)) };
}

/** Restituisce null se il testo non è una lavagna valida. */
export function parseBoard(text: string): PersistedBoard | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(data) || !Array.isArray(data.elements)) return null;

  const seen = new Set<string>();
  const elements: El[] = [];
  for (const raw of data.elements) {
    const el = sanitizeElement(raw);
    if (el && !seen.has(el.id)) {
      seen.add(el.id);
      elements.push(el);
    }
  }

  const grid: GridMode | undefined = GRIDS.includes(data.grid as GridMode) ? (data.grid as GridMode) : undefined;

  return {
    version: 1,
    name: typeof data.name === "string" ? data.name.slice(0, 80) : undefined,
    elements,
    camera: sanitizeCamera(data.camera),
    bgColor: typeof data.bgColor === "string" && HEX.test(data.bgColor) ? data.bgColor : undefined,
    grid,
    color: typeof data.color === "string" && HEX.test(data.color) ? data.color : undefined,
    width: isNum(data.width) ? data.width : undefined,
    fill: typeof data.fill === "boolean" ? data.fill : undefined,
    recentColors: Array.isArray(data.recentColors)
      ? data.recentColors.filter((c): c is string => typeof c === "string" && HEX.test(c)).slice(0, 8)
      : undefined,
    pages: parsePages(data.pages) ?? undefined,
    collab: parseSaved(data.collab),
  };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------------
 * Libreria di lavagne in localStorage
 *   whiteboard:index          → { currentId, boards: BoardMeta[] }
 *   whiteboard:board:<id>     → PersistedBoard
 * ---------------------------------------------------------------------- */

export interface BoardIndex {
  version: 1;
  currentId: string;
  boards: BoardMeta[];
}

function sanitizeMeta(raw: unknown): BoardMeta | null {
  if (!isObj(raw) || typeof raw.id !== "string" || !raw.id) return null;
  const now = Date.now();
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.slice(0, 80) : "Senza titolo",
    createdAt: isNum(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : now,
    thumb: typeof raw.thumb === "string" && raw.thumb.startsWith("data:image/") ? raw.thumb : undefined,
  };
}

export function readIndex(): BoardIndex | null {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return null;
    const data: unknown = JSON.parse(raw);
    if (!isObj(data) || !Array.isArray(data.boards)) return null;
    const boards = data.boards.map(sanitizeMeta).filter((b): b is BoardMeta => b !== null);
    if (boards.length === 0) return null;
    const currentId =
      typeof data.currentId === "string" && boards.some((b) => b.id === data.currentId)
        ? data.currentId
        : boards[0].id;
    return { version: 1, currentId, boards };
  } catch {
    return null;
  }
}

/** Lancia se localStorage è pieno o non disponibile. */
export function writeIndex(index: BoardIndex): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

export function readBoard(id: string): PersistedBoard | null {
  try {
    const raw = localStorage.getItem(boardKey(id));
    return raw ? parseBoard(raw) : null;
  } catch {
    return null;
  }
}

/** Lancia se localStorage è pieno o non disponibile. */
export function writeBoard(id: string, board: PersistedBoard): void {
  localStorage.setItem(boardKey(id), JSON.stringify(board));
}

export function removeBoard(id: string): void {
  try {
    localStorage.removeItem(boardKey(id));
  } catch {
    /* niente da rimuovere */
  }
}

export function slugify(name: string): string {
  const s = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "lavagna";
}
