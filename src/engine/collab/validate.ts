import { MAX_PAGES, type GridMode } from "../types";
import { MAX_ENTRIES, type CollabSaved, type Reg } from "./types";

/**
 * Validatori senza dipendenze dal resto del motore (così `storage.ts` può usarli senza cicli di import).
 */

export const MAX_CLOCK = 2 ** 40;
/** L'ordine conta: il link di condivisione salva l'indice. Aggiungere solo in fondo. */
export const GRIDS: GridMode[] = ["none", "dots", "lines", "squares", "ruled"];

const HEX = /^#[0-9a-f]{3,8}$/i;

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
export const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

const parseColor = (v: unknown): string | null => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : null);
const parseGrid = (v: unknown): GridMode | null => (GRIDS.includes(v as GridMode) ? (v as GridMode) : null);

export function parseReg<T>(raw: unknown, val: (v: unknown) => T | null): Reg<T> | null {
  if (!isObj(raw) || !isNum(raw.v) || raw.v < 0 || raw.v > MAX_CLOCK || !isStr(raw.s, 40)) return null;
  const x = val(raw.val);
  return x === null ? null : { v: Math.floor(raw.v), s: raw.s, val: x };
}

export const parseBgReg = (raw: unknown): Reg<string> | null => parseReg(raw, parseColor);
export const parseGridReg = (raw: unknown): Reg<GridMode> | null => parseReg(raw, parseGrid);

/** Numero di pagine (0 = lavagna infinita), intero tra 0 e MAX_PAGES. */
export const parsePages = (v: unknown): number | null =>
  isNum(v) && v >= 0 && v <= MAX_PAGES && Math.floor(v) === v ? v : null;
export const parsePagesReg = (raw: unknown): Reg<number> | null => parseReg(raw, parsePages);

/** Valida i dati di collaborazione letti da localStorage. */
export function parseSaved(raw: unknown): CollabSaved | undefined {
  if (!isObj(raw) || !isStr(raw.room, 100) || !isStr(raw.site, 40) || !isNum(raw.clock) || !Array.isArray(raw.entries)) {
    return undefined;
  }
  if (raw.mode !== "host" && raw.mode !== "guest") return undefined;
  const entries: CollabSaved["entries"] = [];
  for (const r of raw.entries) {
    if (!Array.isArray(r) || r.length !== 5) continue;
    const [id, v, s, o, d] = r as unknown[];
    if (isStr(id, 100) && isNum(v) && isStr(s, 40) && isNum(o)) entries.push([id, v, s, o, d === 1 ? 1 : 0]);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return {
    room: raw.room,
    site: raw.site,
    mode: raw.mode,
    clock: Math.max(0, Math.floor(raw.clock)),
    entries,
    bg: (raw.bg === undefined ? null : parseBgReg(raw.bg)) ?? undefined,
    grid: (raw.grid === undefined ? null : parseGridReg(raw.grid)) ?? undefined,
    pages: (raw.pages === undefined ? null : parsePagesReg(raw.pages)) ?? undefined,
  };
}
