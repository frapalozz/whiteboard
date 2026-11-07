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
  | "diamond"
  | "terminal"
  | "data"
  | "note"
  | "text"
  | "laser"
  | "comment";

/**
 * Forme "scatola": rettangolo (processo), ellisse, rombo (decisione), inizio/fine (rettangolo con
 * i lati arrotondati), dati (parallelogramma, input/output), nota adesiva. Possono contenere
 * un'etichetta e le frecce vi si agganciano.
 */
export const BOX_TYPES = ["rect", "ellipse", "diamond", "terminal", "data", "note"] as const;
/** Forme del menu "Forme" (la nota adesiva ha il suo strumento). */
export const SHAPE_TYPES = ["rect", "ellipse", "diamond", "terminal", "data"] as const;
export type BoxType = (typeof BOX_TYPES)[number];
const BOX_SET = new Set<string>(BOX_TYPES);
export const isBoxType = (t: string): t is BoxType => BOX_SET.has(t);

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
  /** Bloccato: non si sposta, non si ridimensiona, non si cancella (finché non lo si sblocca). */
  locked?: true;
}

export interface StrokeEl extends BaseEl {
  type: "stroke";
  points: Point[];
}

export interface LineEl extends BaseEl {
  type: "line" | "arrow";
  a: Point;
  b: Point;
  /** Id della forma a cui è agganciato l'estremo `a` / `b` (diagrammi di flusso). */
  from?: string;
  to?: string;
  /** Etichetta scritta a metà del collegamento (es. "Sì" / "No"). */
  label?: string;
}

export interface BoxEl extends BaseEl {
  type: BoxType;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: boolean;
  /** Testo centrato dentro la forma. */
  label?: string;
}

/** Immagine (anche una pagina di un PDF). `src`: id del file nell'archivio locale (hash SHA-256). */
export interface ImageEl extends BaseEl {
  type: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
}

/**
 * Commento. Il primo messaggio di una discussione ha la posizione (`x`, `y`) e lo stato `done`
 * (risolta); se è attaccato a un elemento (`target`) segue quell'elemento, a distanza `ox`, `oy` dal suo
 * angolo. Le risposte puntano al primo messaggio con `re`. Ogni messaggio è un elemento a sé: due risposte scritte
 * insieme non si sovrascrivono.
 */
export interface CommentEl extends BaseEl {
  type: "comment";
  x: number;
  y: number;
  text: string;
  author: string;
  /** Data di creazione (ms). */
  t: number;
  re?: string;
  target?: string;
  ox?: number;
  oy?: number;
  done?: true;
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
export type El = StrokeEl | LineEl | BoxEl | TextEl | ImageEl | CommentEl;

export const isBox = (el: El): el is BoxEl => isBoxType(el.type);
export const isLine = (el: El): el is LineEl => el.type === "line" || el.type === "arrow";
export const isComment = (el: El): el is CommentEl => el.type === "comment";

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
  /**
   * Presente quando si scrive l'etichetta di una forma o di una freccia (`id`): il testo va a capo e
   * resta centrato nell'area `box` (coordinate mondo).
   */
  label?: { box: Rect };
}

/** Stato osservabile dalla UI React (immutabile, sostituito a ogni cambiamento). */
export interface UIState {
  tool: ToolId;
  /** Lavagna condivisa in sola lettura: solo la mano, nessuna modifica. */
  readOnly: boolean;
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
  /** Ultima forma usata: è quella che attiva il pulsante "Forme". */
  lastShape: BoxType;
  /** Tipo di forma comune alla selezione (null se non è fatta solo di forme dello stesso tipo). */
  selShape: BoxType | null;
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
  /* note adesive e blocco */
  noteColor: string;
  showNoteColors: boolean;
  /** Si stanno impostando solo note (strumento nota, o selezione di sole note). */
  onlyNotes: boolean;
  lockState: "none" | "some" | "all";
  /** Nella lavagna c'è almeno un elemento bloccato. */
  hasLocked: boolean;
  /** La selezione contiene almeno due forme: si può disporre in automatico. */
  canArrange: boolean;
  /* commenti: discussione aperta (o nuova, `draft`) e dove mostrarla (px schermo) */
  comment: {
    open: string | null;
    draft: boolean;
    thread: CommentEl[];
    anchor: Point | null;
    /** Discussioni non risolte nella lavagna. */
    count: number;
  };
  /** Lavoro lungo in corso (import di un PDF…), null se nessuno. */
  task: string | null;
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
  /** File delle immagini (data URL per id), solo nei file .json esportati. */
  assets?: Record<string, string>;
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
