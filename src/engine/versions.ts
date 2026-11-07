import { idbDelete, idbGet, idbKeys, idbPut } from "./idb";
import { parseBoard } from "./storage";
import type { PersistedBoard } from "./types";

/**
 * Cronologia delle versioni: istantanee di una lavagna salvate in IndexedDB, nel browser.
 *
 * Se ne salva una in automatico ogni AUTO_MS di lavoro (solo se qualcosa è cambiato), una prima di ogni
 * ripristino e quando la si chiede ("Salva versione"). Si tengono le ultime MAX_VERSIONS per lavagna.
 */

export const AUTO_MS = 10 * 60 * 1000;
export const MAX_VERSIONS = 60;

export interface VersionMeta {
  key: string;
  time: number;
  /** Nome dato a mano, oppure il motivo ("Prima del ripristino"). */
  label?: string;
  count: number;
  thumb?: string;
}

interface Stored extends VersionMeta {
  board: string;
}

const prefix = (boardId: string) => `${boardId}|`;
const keyFor = (boardId: string, time: number) => `${prefix(boardId)}${String(time).padStart(15, "0")}`;

export async function saveVersion(boardId: string, board: PersistedBoard, opts: { label?: string; thumb?: string } = {}): Promise<VersionMeta> {
  const time = Date.now();
  const v: Stored = {
    key: keyFor(boardId, time),
    time,
    label: opts.label,
    count: board.elements.filter((e) => e.type !== "comment").length,
    thumb: opts.thumb,
    board: JSON.stringify({ ...board, collab: undefined, assets: undefined }),
  };
  await idbPut("versions", v.key, v);
  // le più vecchie oltre il limite se ne vanno
  const keys = await idbKeys("versions", prefix(boardId));
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_VERSIONS))) await idbDelete("versions", k);
  const { board: _, ...meta } = v;
  void _;
  return meta;
}

/** Versioni di una lavagna, dalla più recente. */
export async function listVersions(boardId: string): Promise<VersionMeta[]> {
  const keys = await idbKeys("versions", prefix(boardId));
  const out: VersionMeta[] = [];
  for (const k of keys.reverse()) {
    const v = await idbGet<Stored>("versions", k);
    if (v) out.push({ key: v.key, time: v.time, label: v.label, count: v.count, thumb: v.thumb });
  }
  return out;
}

export async function loadVersion(key: string): Promise<PersistedBoard | null> {
  const v = await idbGet<Stored>("versions", key);
  return v ? parseBoard(v.board) : null;
}

export async function deleteVersions(boardId: string): Promise<void> {
  for (const k of await idbKeys("versions", prefix(boardId))) await idbDelete("versions", k);
}

export async function latestVersionTime(boardId: string): Promise<number> {
  const keys = await idbKeys("versions", prefix(boardId));
  const last = keys[keys.length - 1];
  return last ? Number(last.slice(last.indexOf("|") + 1)) : 0;
}
