import type { CollabSaved, CollabUI } from "./collab/types";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** x/y = coordinata mondo dell'angolo in alto a sinistra del viewport. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type ToolId =
  | "select"
  | "hand"
  | "pen"
  | "eraser"
  | "line"
  | "arrow"
  | "rect"
  | "ellipse"
  | "text";

/**
 * Motivo dello sfondo. "lines" è la griglia; "squares" (quadretti) e "ruled" (righe) imitano i
 * quaderni di scuola e sono ancorati al foglio, non allo zoom.
 */
export type GridMode = "none" | "dots" | "lines" | "squares" | "ruled";

interface BaseEl {
  id: string;
  color: string;
  /** Spessore del tratto in unità mondo. */
  width: number;
}

export interface StrokeEl extends BaseEl {
  type: "stroke";
  points: Point[];
}

export interface LineEl extends BaseEl {
  type: "line" | "arrow";
  a: Point;
  b: Point;
}

export interface BoxEl extends BaseEl {
  type: "rect" | "ellipse";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: boolean;
}

export interface TextEl extends BaseEl {
  type: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
}

/**
 * Gli elementi sono trattati come immutabili: ogni modifica produce un nuovo
 * oggetto. Questo rende undo/redo (snapshot dell'array) e le cache (WeakMap)
 * corrette e a costo quasi nullo.
 */
export type El = StrokeEl | LineEl | BoxEl | TextEl;

export interface TextEdit {
  /** Identifica la sessione di editing: i commit di sessioni vecchie vengono ignorati. */
  session: number;
  /** id dell'elemento esistente in modifica, null se è un testo nuovo. */
  id: string | null;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  color: string;
}

/** Stato osservabile dalla UI React (immutabile, sostituito a ogni cambiamento). */
export interface UIState {
  tool: ToolId;
  color: string;
  width: number;
  fill: boolean;
  bgColor: string;
  grid: GridMode;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  selectionCount: number;
  /** true se lo strumento corrente o la selezione contengono forme riempibili. */
  showFill: boolean;
  hasContent: boolean;
  recentColors: string[];
  editing: TextEdit | null;
  /** Presente solo durante l'editing di un testo (serve a posizionare la textarea). */
  camera: Camera | null;
  /* libreria lavagne */
  boardId: string;
  boardName: string;
  boards: BoardMeta[];
  saveState: SaveState;
  lastSaved: number;
  /* modalità lezione: pagine in sequenza (pageCount 0 = lavagna infinita) */
  pageCount: number;
  /** Pagina mostrata (indice da 0), calcolata dal centro della vista. */
  page: number;
  /* collaborazione P2P */
  collab: CollabUI;
}

export interface BoardMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Anteprima JPEG (data URL) mostrata nella libreria. */
  thumb?: string;
}

export type SaveState = "saved" | "saving" | "error";

export interface PersistedBoard {
  version: 1;
  name?: string;
  elements: El[];
  camera?: Camera;
  bgColor?: string;
  grid?: GridMode;
  color?: string;
  width?: number;
  fill?: boolean;
  recentColors?: string[];
  /** Numero di pagine in modalità lezione (assente o 0 = lavagna infinita). */
  pages?: number;
  /** Metadati di sincronizzazione, presenti solo se la lavagna è (o era) collaborativa. */
  collab?: CollabSaved;
}

/* ---- pagine (modalità lezione) ---- */

/** Pagina 16:10, come uno schermo o una LIM. Le pagine sono impilate in verticale a partire da (0, 0). */
export const PAGE_W = 1600;
export const PAGE_H = 1000;
export const PAGE_GAP = 120;
export const PAGE_STRIDE = PAGE_H + PAGE_GAP;
export const MAX_PAGES = 500;

export function pageRect(i: number): Rect {
  return { x: 0, y: i * PAGE_STRIDE, w: PAGE_W, h: PAGE_H };
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
