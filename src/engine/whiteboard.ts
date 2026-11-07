import {
  DEFAULT_BG,
  DEFAULT_COLOR,
  DEFAULT_WIDTH,
  MAX_WIDTH,
  MIN_WIDTH,
  PALETTE,
} from "./constants";
import {
  ARROW_LABEL_MAX,
  boundsOf,
  centerOf,
  clamp,
  dist,
  fontSizeFor,
  geomBoundsOf,
  heightForLabel,
  hitTest,
  inflate,
  insideBox,
  LABEL_LINE,
  LABEL_SIZE,
  labelArea,
  rectContains,
  rectFromPoints,
  rectsIntersect,
  scaleEl,
  simplify,
  translateEl,
  unionRects,
  wrapText,
} from "./geometry";
import { bindTargetAt, detachFrom, isTinyLine, remapBindings, resolveConnectors, resolveLine } from "./flow";
import { Collab, type CollabHost } from "./collab/controller";
import type { Access } from "./collab/acl";
import { drawEdgeMarks, edgeMarks } from "./edges";
import { drawElement, drawElements, drawGrid, drawPages, isDark } from "./render";
import { buildShareUrl, SHARE_HARD_LIMIT } from "./share";
import {
  downloadBlob,
  LEGACY_KEY,
  parseBoard,
  readBoard,
  readIndex,
  removeBoard,
  sanitizeColor,
  slugify,
  timestamp,
  writeBoard,
  writeIndex,
} from "./storage";
import { isBox, isBoxType, isLine, MAX_PAGES, MAX_ZOOM, MIN_ZOOM, PAGE_GAP, PAGE_H, PAGE_STRIDE, PAGE_W, pageRect } from "./types";
import type {
  BoardMeta,
  BoxEl,
  BoxType,
  Camera,
  El,
  GridMode,
  LineEl,
  PersistedBoard,
  Point,
  SaveState,
  Rect,
  TextEdit,
  TextEl,
  ToolId,
  UIState,
} from "./types";

const HISTORY_LIMIT = 200;
/** Velocità massima dello scorrimento automatico (px schermo al secondo), con il puntatore sul bordo o oltre. */
const AUTOPAN_MAX = 900;
/** Raggio (px schermo) delle maniglie degli estremi e dei pulsanti "+" del collegamento rapido. */
const END_HIT = 11;
const PLUS_OFFSET = 26;
const PLUS_HIT = 10;
/** Distanza tra una forma e quella creata dal collegamento rapido (unità mondo). */
const FLOW_GAP = 90;
/** Larghezza massima a cui una forma si allarga da sola per far stare la sua etichetta. */
const FIT_MAX_W = 320;
/** Dimensioni delle forme piazzate con un clic. */
const DEFAULT_SIZE: Record<BoxType, { w: number; h: number }> = {
  rect: { w: 200, h: 100 },
  ellipse: { w: 180, h: 110 },
  diamond: { w: 200, h: 130 },
  terminal: { w: 200, h: 80 },
  data: { w: 210, h: 100 },
};
type Side = "top" | "right" | "bottom" | "left";
const SIDES: Side[] = ["top", "right", "bottom", "left"];
const SIDE_DIR: Record<Side, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };
const HANDLE_HIT = 9;
const RECENT_MAX = 5;

type Handle = "nw" | "ne" | "sw" | "se";
const HANDLES: Handle[] = ["nw", "ne", "sw", "se"];
const OPPOSITE: Record<Handle, Handle> = { nw: "se", se: "nw", ne: "sw", sw: "ne" };

type Action =
  | { kind: "pan"; pid: number; last: Point }
  | { kind: "pen"; pid: number }
  | { kind: "shape"; pid: number; start: Point; startScreen: Point; bind: string | null }
  /** Trascinamento di un estremo di un collegamento selezionato (per staccarlo o agganciarlo altrove). */
  | { kind: "endpoint"; pid: number; end: "a" | "b"; id: string; origin: El[]; moved: boolean }
  | { kind: "erase"; pid: number; last: Point }
  | { kind: "move"; pid: number; start: Point; origin: El[]; moved: boolean }
  | {
      kind: "resize";
      pid: number;
      handle: Handle;
      /** Angolo fisso (opposto all'handle) e angolo trascinato, sul bounding box geometrico. */
      anchor: Point;
      corner: Point;
      /** Scarto tra il punto di presa e l'angolo, per non far "saltare" la forma. */
      grab: Point;
      origin: El[];
      moved: boolean;
    }
  | { kind: "marquee"; pid: number; start: Point; base: Set<string> }
  | { kind: "textclick"; pid: number; start: Point };

interface Gesture {
  startDist: number;
  startZoom: number;
  startWorld: Point;
}

let idCounter = 0;
const newId = () => `${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** true se il focus è su un campo in cui l'utente sta scrivendo (non su slider/checkbox/bottoni). */
function isTypingTarget(t: HTMLElement | null): boolean {
  if (!t) return false;
  if (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  if (t instanceof HTMLInputElement) {
    return !["range", "checkbox", "radio", "button", "color", "file", "submit"].includes(t.type);
  }
  return false;
}

function shallowEqual(a: object, b: object): boolean {
  const ka = Object.keys(a) as Array<keyof typeof a>;
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is(a[k], (b as typeof a)[k])) return false;
  }
  return true;
}

export class Whiteboard {
  /* ---- documento ---- */
  private elements: El[] = [];
  private past: El[][] = [];
  private future: El[][] = [];
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private bgColor = DEFAULT_BG;
  private grid: GridMode = "dots";
  /** Pagine della modalità lezione (0 = lavagna infinita). Vedi `pageCount()`. */
  private pages = 0;

  /* ---- strumento / stile ---- */
  private tool: ToolId = "pen";
  private style = { color: DEFAULT_COLOR, width: DEFAULT_WIDTH, fill: false };
  private recentColors: string[] = [];
  /** Ultima forma scelta (il pulsante "Forme" della barra riattiva questa). */
  private lastShape: BoxType = "rect";

  /* ---- stato transitorio ---- */
  /** Forma evidenziata a cui si aggancerà l'estremo che si sta disegnando o trascinando. */
  private snapTarget: string | null = null;
  private selection = new Set<string>();
  private draft: El | null = null;
  private erasing = new Set<string>();
  private marquee: Rect | null = null;
  private hover: Point | null = null;
  private editing: TextEdit | null = null;
  private editSession = 0;
  private clipboard: El[] = [];
  private pasteCount = 0;
  private spaceDown = false;
  private action: Action | null = null;
  private pointers = new Map<number, Point>();
  private gesture: Gesture | null = null;
  private coalesceKey: string | null = null;
  private coalesceAt = 0;

  /* ---- canvas ---- */
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private viewW = 0;
  private viewH = 0;
  private dpr = 1;
  private raf = 0;
  private cursor = "";
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  /* ---- libreria lavagne ---- */
  private boardId = "";
  private boardName = "Lavagna 1";
  private boards: BoardMeta[] = [];
  private saveState: SaveState = "saved";
  private lastSaved = 0;
  /** Se true le scorciatoie da tastiera sono sospese (dialog aperti). */
  private paused = false;

  /* ---- collaborazione P2P ---- */
  private collab: Collab;
  /** Valore di `collab.seq` quando uno snapshot di undo/redo è stato preso (vedi `Collab.rebase`). */
  private snapSeq = new WeakMap<El[], number>();
  /** Ultima posizione del puntatore in coordinate mondo (null: fuori dalla lavagna). */
  private presenceCursor: Point | null = null;
  /** Vista di chi si segue arrivata durante un gesto: si applica alla fine (non si sposta il foglio sotto la penna). */
  private pendingFollow: Rect | null = null;
  /** Pagine occupate dal contenuto, in cache per array di elementi (immutabile). */
  private usedPages = new WeakMap<El[], number>();

  /* ---- store osservabile ---- */
  private listeners = new Set<() => void>();
  private snapshot: UIState;

  constructor() {
    this.collab = new Collab(this.makeCollabHost());
    this.snapshot = this.buildSnapshot();
  }

  /* ======================================================================
   * Store (useSyncExternalStore)
   * ==================================================================== */

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = (): UIState => this.snapshot;
  getServerSnapshot = (): UIState => this.snapshot;

  /** In una lavagna condivisa in sola lettura: si guarda e ci si muove, ma non si modifica nulla. */
  get readOnly(): boolean {
    return !this.collab.canEditSelf;
  }

  private buildSnapshot(): UIState {
    // Con una selezione, il pannello mostra lo stile degli elementi selezionati
    // (se è uniforme), altrimenti quello dello strumento.
    let { color, width, fill } = this.style;
    let hasBox = false;
    if (this.selection.size) {
      const sel = this.selectedElements();
      if (sel.length) {
        if (sel.every((e) => e.color === sel[0].color)) color = sel[0].color;
        if (sel.every((e) => e.width === sel[0].width)) width = sel[0].width;
        const boxes = sel.filter(isBox);
        if (boxes.length) {
          hasBox = true;
          if (boxes.every((b) => b.fill === boxes[0].fill)) fill = boxes[0].fill;
        }
      }
    }
    const prev = this.snapshot as UIState | undefined;
    const editing = this.editing;
    let selShape: BoxType | null = null;
    if (this.selection.size) {
      const sel = this.selectedElements();
      if (sel.length && sel.every((e) => e.type === sel[0].type) && isBox(sel[0])) selShape = sel[0].type;
    }
    return {
      tool: this.tool,
      readOnly: this.readOnly,
      color,
      width,
      fill,
      bgColor: this.bgColor,
      grid: this.grid,
      zoom: this.camera.zoom,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
      selectionCount: this.selection.size,
      showFill: isBoxType(this.tool) || hasBox,
      lastShape: this.lastShape,
      selShape,
      hasContent: this.elements.length > 0,
      // riusa lo stesso riferimento se i colori recenti non cambiano
      recentColors:
        prev && prev.recentColors.join() === this.recentColors.join()
          ? prev.recentColors
          : [...this.recentColors],
      editing,
      camera: editing ? { ...this.camera } : null,
      boardId: this.boardId,
      boardName: this.boardName,
      boards: this.boards,
      saveState: this.saveState,
      lastSaved: this.lastSaved,
      pageCount: this.pageCount(),
      page: this.currentPage(),
      collab: this.collab.ui,
    };
  }

  private emit(): void {
    // i permessi cambiano anche entrando in una stanza o aprendo una lavagna condivisa
    if (this.readOnly !== this.wasReadOnly) return this.onAccessChanged();
    const next = this.buildSnapshot();
    if (shallowEqual(this.snapshot, next)) return;
    this.snapshot = next;
    this.listeners.forEach((l) => l());
  }

  /* ======================================================================
   * Ciclo di vita
   * ==================================================================== */

  attach(canvas: HTMLCanvasElement): () => void {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    if (!this.loaded) {
      this.loaded = true;
      this.load();
    }

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();

    const opts = { passive: false } as const;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, opts);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onWindowBlur);
    window.addEventListener("pagehide", this.flushSave);
    window.addEventListener("pagehide", this.onPageHide);
    document.addEventListener("visibilitychange", this.onVisibility);

    this.updateCursor();
    this.emit();
    this.requestRender();

    return () => {
      this.flushSave();
      ro.disconnect();
      canvas.removeEventListener("pointerdown", this.onPointerDown);
      canvas.removeEventListener("pointermove", this.onPointerMove);
      canvas.removeEventListener("pointerup", this.onPointerUp);
      canvas.removeEventListener("pointercancel", this.onPointerCancel);
      canvas.removeEventListener("pointerleave", this.onPointerLeave);
      canvas.removeEventListener("wheel", this.onWheel);
      canvas.removeEventListener("dblclick", this.onDoubleClick);
      canvas.removeEventListener("contextmenu", this.onContextMenu);
      canvas.removeEventListener("mousedown", this.onMouseDown);
      window.removeEventListener("keydown", this.onKeyDown);
      window.removeEventListener("keyup", this.onKeyUp);
      window.removeEventListener("blur", this.onWindowBlur);
      window.removeEventListener("pagehide", this.flushSave);
      window.removeEventListener("pagehide", this.onPageHide);
      document.removeEventListener("visibilitychange", this.onVisibility);
      if (this.raf) cancelAnimationFrame(this.raf);
      this.stopAutoPan();
      this.raf = 0;
      this.canvas = null;
      this.ctx = null;
    };
  }

  private resize(): void {
    const c = this.canvas;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.viewW = Math.max(1, Math.round(rect.width));
    this.viewH = Math.max(1, Math.round(rect.height));
    c.width = Math.round(this.viewW * this.dpr);
    c.height = Math.round(this.viewH * this.dpr);
    this.requestRender();
    // chi segue riceve l'area visibile, che cambia con la finestra
    this.collab.ping();
  }

  /* ======================================================================
   * Coordinate
   * ==================================================================== */

  private toWorld(p: Point): Point {
    return { x: p.x / this.camera.zoom + this.camera.x, y: p.y / this.camera.zoom + this.camera.y };
  }

  private toScreen(p: Point): Point {
    return { x: (p.x - this.camera.x) * this.camera.zoom, y: (p.y - this.camera.y) * this.camera.zoom };
  }

  private screenPoint(e: { clientX: number; clientY: number }): Point {
    const r = this.canvas!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /* ======================================================================
   * Rendering
   * ==================================================================== */

  private requestRender(): void {
    if (this.raf || !this.canvas) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render(): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    const { x, y, zoom } = this.camera;
    const dpr = this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // sfondo + griglia (spazio schermo); in modalità lezione i fogli
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pages = this.pageCount();
    if (pages > 0) {
      drawPages(ctx, this.camera, this.viewW, this.viewH, pages, this.bgColor, this.grid, this.currentPage());
    } else {
      ctx.fillStyle = this.bgColor;
      ctx.fillRect(0, 0, this.viewW, this.viewH);
      drawGrid(ctx, this.camera, this.viewW, this.viewH, this.grid, isDark(this.bgColor));
    }

    // contenuto (spazio mondo)
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, -x * zoom * dpr, -y * zoom * dpr);
    const view: Rect = { x, y, w: this.viewW / zoom, h: this.viewH / zoom };
    const ed = this.editing;
    const extra = { bg: this.bgColor, hideLabelId: ed?.label ? ed.id : null };
    drawElements(ctx, this.elements, view, this.erasing, ed && !ed.label ? ed.id : null, zoom, extra);
    if (this.draft) drawElement(ctx, this.draft, 1, { bg: this.bgColor });
    for (const r of this.collab.remote()) if (r.draft) drawElement(ctx, r.draft, 1, { bg: this.bgColor });

    // overlay (spazio schermo): prima i segni di ciò che è fuori dalla vista
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawEdgeMarks(ctx, edgeMarks(this.elements, view, zoom, this.viewW, this.viewH), this.viewW, this.viewH);
    this.drawOverlay(ctx);
  }

  private drawOverlay(ctx: CanvasRenderingContext2D): void {
    const accent = "#4c8dff";
    const showSel = this.selection.size > 0 && !this.editing && this.draft === null;

    if (showSel) {
      const sel = this.selectedElements();
      if (sel.length > 1) {
        ctx.strokeStyle = "rgba(76,141,255,0.55)";
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        for (const el of sel) {
          const b = boundsOf(el);
          const s = this.toScreen(b);
          ctx.strokeRect(s.x, s.y, b.w * this.camera.zoom, b.h * this.camera.zoom);
        }
      }
      const sb = this.singleLine() ? null : this.selectionBounds();
      this.drawFlowHandles(ctx);
      if (sb) {
        const s = this.toScreen(sb);
        const w = sb.w * this.camera.zoom;
        const h = sb.h * this.camera.zoom;
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(s.x - 3, s.y - 3, w + 6, h + 6);
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        for (const hd of HANDLES) {
          const hp = this.handleScreenPos(sb, hd);
          ctx.beginPath();
          ctx.rect(hp.x - 4.5, hp.y - 4.5, 9, 9);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    if (this.snapTarget) {
      const t = this.elements.find((e) => e.id === this.snapTarget);
      if (t) {
        const b = inflate(geomBoundsOf(t), 6 / this.camera.zoom + t.width / 2);
        const s = this.toScreen(b);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.roundRect(s.x, s.y, b.w * this.camera.zoom, b.h * this.camera.zoom, 8);
        ctx.stroke();
      }
    }

    if (this.marquee) {
      const s = this.toScreen(this.marquee);
      ctx.fillStyle = "rgba(76,141,255,0.12)";
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      const w = this.marquee.w * this.camera.zoom;
      const h = this.marquee.h * this.camera.zoom;
      ctx.fillRect(s.x, s.y, w, h);
      ctx.strokeRect(s.x + 0.5, s.y + 0.5, w, h);
    }

    // cursore personalizzato per penna e gomma
    if (this.hover && !this.editing && !this.spaceDown && (!this.action || this.action.kind === "pen" || this.action.kind === "erase")) {
      const dark = isDark(this.bgColor);
      if (this.tool === "pen") {
        const r = Math.max(1.5, (this.style.width / 2) * this.camera.zoom);
        ctx.beginPath();
        ctx.arc(this.hover.x, this.hover.y, r, 0, Math.PI * 2);
        ctx.fillStyle = this.style.color;
        ctx.globalAlpha = 0.9;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = dark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.45)";
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (this.tool === "eraser") {
        ctx.beginPath();
        ctx.arc(this.hover.x, this.hover.y, this.eraserRadiusPx(), 0, Math.PI * 2);
        ctx.fillStyle = dark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)";
        ctx.fill();
        ctx.strokeStyle = dark ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
    }

    this.drawRemoteCursors(ctx);
  }

  /** Cursori degli altri partecipanti, con il loro nome. */
  private drawRemoteCursors(ctx: CanvasRenderingContext2D): void {
    const now = Date.now();
    for (const r of this.collab.remote()) {
      const c = r.cursor;
      if (!c || now - c.t > 10_000) continue;
      const s = this.toScreen(c);
      if (s.x < -40 || s.y < -40 || s.x > this.viewW + 40 || s.y > this.viewH + 40) continue;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.fillStyle = r.color;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 15);
      ctx.lineTo(4, 11.5);
      ctx.lineTo(7.5, 18);
      ctx.lineTo(10.5, 16.5);
      ctx.lineTo(7, 10.5);
      ctx.lineTo(12, 10.5);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.font = "600 11px system-ui, -apple-system, sans-serif";
      const w = ctx.measureText(r.name).width + 12;
      ctx.fillRect(12, 17, w, 18);
      ctx.fillStyle = "#ffffff";
      ctx.textBaseline = "middle";
      ctx.fillText(r.name, 18, 26.5);
      ctx.restore();
    }
  }

  /* ---- diagrammi di flusso: maniglie ---- */

  /** L'unico elemento selezionato, se è un collegamento (linea o freccia). */
  private singleLine(): LineEl | null {
    if (this.selection.size !== 1) return null;
    const el = this.selectedElements()[0];
    return el && isLine(el) ? el : null;
  }

  /** L'unica forma selezionata (per i pulsanti "+" del collegamento rapido). */
  private singleBox(): BoxEl | null {
    if (this.selection.size !== 1 || this.tool !== "select") return null;
    const el = this.selectedElements()[0];
    return el && isBox(el) ? el : null;
  }

  /** Posizioni (schermo) dei pulsanti "+" ai lati della forma selezionata. */
  private plusPositions(box: BoxEl): Record<Side, Point> {
    const s = this.toScreen(box);
    const w = box.w * this.camera.zoom;
    const h = box.h * this.camera.zoom;
    const o = PLUS_OFFSET + (box.width * this.camera.zoom) / 2;
    return {
      top: { x: s.x + w / 2, y: s.y - o },
      right: { x: s.x + w + o, y: s.y + h / 2 },
      bottom: { x: s.x + w / 2, y: s.y + h + o },
      left: { x: s.x - o, y: s.y + h / 2 },
    };
  }

  /**
   * Lati della forma senza collegamenti: solo lì compare il "+" (su un lato già collegato coprirebbe
   * la freccia, e un clic sulla freccia creerebbe una forma nuova).
   */
  private freeSides(box: BoxEl): Side[] {
    const used = new Set<Side>();
    const c = centerOf(box);
    for (const el of this.elements) {
      if (!isLine(el)) continue;
      for (const [p, id] of [[el.a, el.from], [el.b, el.to]] as const) {
        if (id !== box.id) continue;
        const dx = (p.x - c.x) / Math.max(box.w, 1);
        const dy = (p.y - c.y) / Math.max(box.h, 1);
        used.add(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top");
      }
    }
    return SIDES.filter((s) => !used.has(s));
  }

  private plusAt(sp: Point): Side | null {
    const box = this.singleBox();
    if (!box || box.w * this.camera.zoom < 24 || box.h * this.camera.zoom < 16) return null;
    const pos = this.plusPositions(box);
    for (const side of this.freeSides(box)) if (dist(sp, pos[side]) <= PLUS_HIT) return side;
    return null;
  }

  private endpointAt(sp: Point): "a" | "b" | null {
    const l = this.singleLine();
    if (!l) return null;
    if (dist(sp, this.toScreen(l.b)) <= END_HIT) return "b";
    if (dist(sp, this.toScreen(l.a)) <= END_HIT) return "a";
    return null;
  }

  private drawFlowHandles(ctx: CanvasRenderingContext2D): void {
    const accent = "#4c8dff";
    const line = this.singleLine();
    if (line) {
      for (const end of ["a", "b"] as const) {
        const p = this.toScreen(line[end]);
        const bound = end === "a" ? line.from : line.to;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = bound ? accent : "#ffffff";
        ctx.strokeStyle = bound ? "#ffffff" : accent;
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      }
    }
    const box = this.action ? null : this.singleBox();
    if (box && box.w * this.camera.zoom >= 24 && box.h * this.camera.zoom >= 16) {
      const pos = this.plusPositions(box);
      for (const side of this.freeSides(box)) {
        const p = pos[side];
        const hot = this.hover && dist(this.hover, p) <= PLUS_HIT;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
        ctx.fillStyle = hot ? accent : "#ffffff";
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x - 4, p.y);
        ctx.lineTo(p.x + 4, p.y);
        ctx.moveTo(p.x, p.y - 4);
        ctx.lineTo(p.x, p.y + 4);
        ctx.strokeStyle = hot ? "#ffffff" : accent;
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
    }
  }

  private eraserRadiusPx(): number {
    return 8 + this.style.width;
  }

  /* ======================================================================
   * History
   * ==================================================================== */

  /**
   * Salva `before` come stato annullabile. Con `key`, chiamate ravvicinate con la
   * stessa chiave (slider, color picker, frecce) vengono fuse in un'unica voce.
   */
  private record(before: El[] = this.elements, key?: string): void {
    const now = performance.now();
    if (key && key === this.coalesceKey && now - this.coalesceAt < 800) {
      this.coalesceAt = now;
      return;
    }
    this.coalesceKey = key ?? null;
    this.coalesceAt = now;
    this.snapSeq.set(before, this.collab.seq);
    this.past.push(before);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  undo = (): void => {
    if (this.readOnly) return;
    if (this.editing) this.finishEdit();
    const prev = this.past.pop();
    if (!prev) return;
    this.snapSeq.set(this.elements, this.collab.seq);
    this.future.push(this.elements);
    this.elements = this.collab.rebase(prev, this.snapSeq.get(prev) ?? 0, this.elements);
    this.coalesceKey = null;
    this.afterRestore();
  };

  redo = (): void => {
    if (this.readOnly) return;
    if (this.editing) this.finishEdit();
    const next = this.future.pop();
    if (!next) return;
    this.snapSeq.set(this.elements, this.collab.seq);
    this.past.push(this.elements);
    this.elements = this.collab.rebase(next, this.snapSeq.get(next) ?? 0, this.elements);
    this.coalesceKey = null;
    this.afterRestore();
  };

  private afterRestore(): void {
    this.pruneSelection();
    this.changed();
  }

  private pruneSelection(): void {
    if (this.selection.size === 0) return;
    const ids = new Set(this.elements.map((e) => e.id));
    for (const id of this.selection) if (!ids.has(id)) this.selection.delete(id);
  }

  /** Da chiamare dopo ogni modifica del documento. */
  private changed(): void {
    this.elements = resolveConnectors(this.elements);
    this.collab.localChanged();
    this.requestRender();
    this.scheduleSave();
    this.emit();
  }

  private addElement(el: El): void {
    this.record();
    this.elements = [...this.elements, el];
    this.rememberColor(el.color);
    this.changed();
  }

  private selectedElements(): El[] {
    return this.elements.filter((e) => this.selection.has(e.id));
  }

  private selectionBounds(): Rect | null {
    return unionRects(this.selectedElements().map(boundsOf));
  }

  private mutateSelection(fn: (el: El) => El, key?: string): void {
    if (this.selection.size === 0 || this.readOnly) return;
    this.record(this.elements, key);
    this.elements = this.elements.map((el) => (this.selection.has(el.id) ? fn(el) : el));
    this.changed();
  }

  /* ======================================================================
   * API pubblica: strumenti e stile
   * ==================================================================== */

  setTool = (tool: ToolId): void => {
    // in sola lettura c'è solo la mano
    if (this.readOnly && tool !== "hand") {
      this.emit();
      return;
    }
    if (this.editing) this.finishEdit();
    if (isBoxType(tool)) this.lastShape = tool;
    if (this.tool === tool) {
      this.emit();
      return;
    }
    this.tool = tool;
    if (tool !== "select") this.selection.clear();
    this.updateCursor();
    this.requestRender();
    this.emit();
  };

  setColor = (color: string): void => {
    this.style.color = color;
    this.mutateSelection((el) => ({ ...el, color }), "color");
    if (!this.selection.size) this.requestRender();
    this.scheduleSave();
    this.emit();
  };

  setWidth = (width: number): void => {
    const w = Math.round(clamp(width, MIN_WIDTH, MAX_WIDTH));
    this.style.width = w;
    this.mutateSelection(
      (el) => (el.type === "text" ? { ...el, width: w, fontSize: fontSizeFor(w) } : { ...el, width: w }),
      "width",
    );
    this.requestRender();
    this.scheduleSave();
    this.emit();
  };

  setFill = (fill: boolean): void => {
    this.style.fill = fill;
    this.mutateSelection((el) => (isBox(el) ? { ...el, fill } : el));
    this.scheduleSave();
    this.emit();
  };

  /** Cambia il tipo delle forme selezionate (es. da processo a decisione): etichette e frecce restano. */
  setShape = (type: BoxType): void => {
    if (this.readOnly) return;
    this.lastShape = type;
    if (!this.selectedElements().some(isBox)) {
      this.emit();
      return;
    }
    this.mutateSelection((el) => (isBox(el) ? { ...el, type } : el));
  };

  setBgColor = (color: string): void => {
    if (this.readOnly) return;
    const wasDark = isDark(this.bgColor);
    this.bgColor = color;
    // la penna nera su sfondo scuro (o bianca su chiaro) sarebbe invisibile
    const nowDark = isDark(color);
    if (wasDark !== nowDark) {
      if (nowDark && this.style.color === "#000000") this.style.color = "#ffffff";
      else if (!nowDark && this.style.color === "#ffffff") this.style.color = "#000000";
    }
    this.changed();
  };

  setGrid = (grid: GridMode): void => {
    if (this.readOnly) return;
    this.grid = grid;
    this.changed();
  };

  private rememberColor(color: string): void {
    if (PALETTE.includes(color)) return;
    this.recentColors = [color, ...this.recentColors.filter((c) => c !== color)].slice(0, RECENT_MAX);
  }

  /* ======================================================================
   * API pubblica: selezione e modifica
   * ==================================================================== */

  selectAll = (): void => {
    if (this.editing) this.finishEdit();
    this.tool = "select";
    this.selection = new Set(this.elements.map((e) => e.id));
    this.updateCursor();
    this.requestRender();
    this.emit();
  };

  clearSelection = (): void => {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.requestRender();
    this.emit();
  };

  deleteSelection = (): void => {
    if (this.selection.size === 0 || this.readOnly) return;
    this.record();
    this.elements = this.elements.filter((e) => !this.selection.has(e.id));
    this.selection.clear();
    this.changed();
  };

  duplicateSelection = (): void => {
    const sel = this.selectedElements();
    if (sel.length === 0) return;
    this.insertCopies(sel, 24, 24);
  };

  copySelection = (): void => {
    const sel = this.selectedElements();
    if (sel.length === 0) return;
    this.clipboard = sel;
    this.pasteCount = 0;
  };

  cutSelection = (): void => {
    if (this.readOnly) return;
    this.copySelection();
    this.deleteSelection();
  };

  paste = (): void => {
    if (this.clipboard.length === 0) return;
    this.pasteCount++;
    const o = 24 * this.pasteCount;
    this.insertCopies(this.clipboard, o, o);
  };

  private insertCopies(src: El[], dx: number, dy: number): void {
    if (this.readOnly) return;
    const idMap = new Map<string, string>();
    for (const el of src) idMap.set(el.id, newId());
    const copies = remapBindings(
      src.map((el) => ({ ...translateEl(el, dx, dy), id: idMap.get(el.id)! }) as El),
      idMap,
    );
    this.record();
    this.elements = [...this.elements, ...copies];
    this.tool = "select";
    this.selection = new Set(copies.map((c) => c.id));
    this.updateCursor();
    this.changed();
  }

  bringToFront = (): void => {
    if (this.selection.size === 0 || this.readOnly) return;
    this.record();
    const rest = this.elements.filter((e) => !this.selection.has(e.id));
    this.elements = [...rest, ...this.selectedElements()];
    this.changed();
  };

  sendToBack = (): void => {
    if (this.selection.size === 0 || this.readOnly) return;
    this.record();
    const rest = this.elements.filter((e) => !this.selection.has(e.id));
    this.elements = [...this.selectedElements(), ...rest];
    this.changed();
  };

  private nudge(dx: number, dy: number): void {
    this.mutateSelection((el) => translateEl(el, dx, dy), "nudge");
  }

  clear = (): void => {
    if (this.editing) this.finishEdit();
    if (this.elements.length === 0 || this.readOnly) return;
    this.record();
    this.elements = [];
    this.selection.clear();
    this.changed();
  };

  /* ======================================================================
   * API pubblica: camera
   * ==================================================================== */

  private zoomAt(screen: Point, zoom: number): void {
    const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    const w = this.toWorld(screen);
    this.camera.zoom = z;
    this.camera.x = w.x - screen.x / z;
    this.camera.y = w.y - screen.y / z;
    this.cameraChanged();
  }

  private cameraChanged(): void {
    this.requestRender();
    this.scheduleSave();
    this.emit();
    this.collab.ping();
  }

  /** L'utente sposta la vista da solo: se stava seguendo qualcuno, smette. */
  private userCamera(): void {
    this.collab.unfollow();
    this.pendingFollow = null;
  }

  zoomIn = (): void => {
    this.userCamera();
    this.zoomAt({ x: this.viewW / 2, y: this.viewH / 2 }, this.camera.zoom * 1.25);
  };
  zoomOut = (): void => {
    this.userCamera();
    this.zoomAt({ x: this.viewW / 2, y: this.viewH / 2 }, this.camera.zoom * 0.8);
  };
  resetZoom = (): void => {
    this.userCamera();
    this.zoomAt({ x: this.viewW / 2, y: this.viewH / 2 }, 1);
  };

  zoomToFit = (): void => {
    this.userCamera();
    this.fitContent();
  };

  /** Mostra un'area del mondo il più grande possibile, lasciando i margini indicati (px schermo). */
  private showRect(r: Rect, pad: { top: number; right: number; bottom: number; left: number }, maxZoom = MAX_ZOOM): void {
    // su schermi piccoli i margini non possono mangiarsi tutta la vista
    const k = Math.min(1, (this.viewW * 0.3) / (pad.left + pad.right), (this.viewH * 0.3) / (pad.top + pad.bottom));
    const p = { top: pad.top * k, right: pad.right * k, bottom: pad.bottom * k, left: pad.left * k };
    const availW = Math.max(1, this.viewW - p.left - p.right);
    const availH = Math.max(1, this.viewH - p.top - p.bottom);
    const z = clamp(Math.min(availW / Math.max(r.w, 1), availH / Math.max(r.h, 1)), MIN_ZOOM, maxZoom);
    this.camera = {
      zoom: z,
      x: r.x + r.w / 2 - (p.left + availW / 2) / z,
      y: r.y + r.h / 2 - (p.top + availH / 2) / z,
    };
    this.cameraChanged();
  }

  private fitContent(): void {
    const b = unionRects(this.elements.map(boundsOf));
    if (!b && this.pageCount() > 0) {
      this.showRect(pageRect(0), this.pagePadding());
      return;
    }
    if (!b) {
      this.camera = { x: 0, y: 0, zoom: 1 };
      this.cameraChanged();
      return;
    }
    const pad = 64;
    const z = clamp(
      Math.min((this.viewW - pad * 2) / Math.max(b.w, 1), (this.viewH - pad * 2) / Math.max(b.h, 1)),
      MIN_ZOOM,
      2,
    );
    this.camera = {
      zoom: z,
      x: b.x + b.w / 2 - this.viewW / z / 2,
      y: b.y + b.h / 2 - this.viewH / z / 2,
    };
    this.cameraChanged();
  }

  /* ======================================================================
   * Modalità lezione: pagine in sequenza
   * ==================================================================== */

  /** Pagina a cui appartiene un elemento (dal centro del suo riquadro), -1 se è fuori dalla colonna dei fogli. */
  private pageOf(el: El): number {
    const b = boundsOf(el);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    if (cx < -PAGE_GAP || cx > PAGE_W + PAGE_GAP || cy < -PAGE_GAP / 2) return -1;
    return Math.floor((cy + PAGE_GAP / 2) / PAGE_STRIDE);
  }

  /**
   * Numero di pagine mostrate: quelle impostate, o di più se c'è contenuto più in basso (per esempio dopo
   * aver annullato l'eliminazione di una pagina, o con il disegno di un altro partecipante).
   */
  private pageCount(): number {
    if (this.pages <= 0) return 0;
    let used = this.usedPages.get(this.elements);
    if (used === undefined) {
      used = 0;
      for (const el of this.elements) used = Math.max(used, this.pageOf(el) + 1);
      this.usedPages.set(this.elements, used);
    }
    return Math.min(MAX_PAGES, Math.max(this.pages, used));
  }

  /** Pagina più vicina al centro della vista. */
  private currentPage(): number {
    const n = this.pageCount();
    if (n === 0 || this.viewH === 0) return 0;
    const cy = this.camera.y + this.viewH / this.camera.zoom / 2;
    return clamp(Math.round((cy - PAGE_H / 2) / PAGE_STRIDE), 0, n - 1);
  }

  /** Attiva o disattiva le pagine. Il contenuto non si sposta: i fogli partono da (0, 0). */
  setPagesMode = (on: boolean): void => {
    if (on === this.pages > 0 || this.readOnly) return;
    if (this.editing) this.finishEdit();
    this.pages = on ? 1 : 0;
    if (on) {
      this.pages = Math.max(1, this.pageCount());
      this.goToPage(0);
    }
    this.changed();
  };

  /** Mostra la pagina `i` intera, lasciando spazio alle barre degli strumenti. */
  goToPage = (i: number): void => {
    const n = this.pageCount();
    if (n === 0) return;
    if (this.editing) this.finishEdit();
    this.userCamera();
    this.showRect(pageRect(clamp(Math.round(i), 0, n - 1)), this.pagePadding());
  };

  /**
   * Margini (px schermo) per inquadrare una pagina senza che le barre la coprano: sul telefono le barre
   * stanno in alto e in basso, su schermi larghi il pannello dello stile occupa la sinistra.
   */
  private pagePadding(): { top: number; right: number; bottom: number; left: number } {
    if (this.viewW < 768) return { top: 120, right: 12, bottom: 150, left: 12 };
    if (this.viewW < 1024) return { top: 72, right: 24, bottom: 132, left: 264 };
    return { top: 72, right: 24, bottom: 84, left: 264 };
  }

  nextPage = (): void => this.goToPage(this.currentPage() + 1);
  prevPage = (): void => this.goToPage(this.currentPage() - 1);

  /** Aggiunge una pagina in fondo e la mostra. */
  addPage = (): void => {
    const n = this.pageCount();
    if (n === 0 || n >= MAX_PAGES || this.readOnly) return;
    this.pages = n + 1;
    this.changed();
    this.goToPage(n);
  };

  /** Contenuto della pagina `i` (serve alla UI per chiedere conferma prima di eliminarla). */
  pageHasContent = (i: number): boolean => this.elements.some((el) => this.pageOf(el) === i);

  /**
   * Elimina la pagina `i` con il suo contenuto; le pagine successive salgono di un posto.
   * Si annulla con Ctrl+Z (il contenuto torna al suo posto e il numero di pagine si ricalcola).
   */
  deletePage = (i: number): void => {
    const n = this.pageCount();
    if (n <= 1 || i < 0 || i >= n || this.readOnly) return;
    if (this.editing) this.finishEdit();
    const next: El[] = [];
    let touched = false;
    for (const el of this.elements) {
      const p = this.pageOf(el);
      if (p === i) {
        touched = true;
        continue;
      }
      if (p > i) {
        touched = true;
        next.push(translateEl(el, 0, -PAGE_STRIDE));
      } else {
        next.push(el);
      }
    }
    if (touched) {
      this.record();
      this.elements = next;
      this.pruneSelection();
    }
    this.pages = n - 1;
    this.changed();
    this.goToPage(Math.min(i, n - 2));
  };

  /* ---- segui l'insegnante ---- */

  /** Chiede a tutti i partecipanti di seguire la tua vista. */
  setLeading = (on: boolean): void => this.collab.setLeading(on);

  /** Segue la vista di un partecipante (null: smette di seguire). */
  followPeer = (site: string | null): void => {
    this.pendingFollow = null;
    this.collab.follow(site);
  };

  /** Area del mondo visibile in questo momento. */
  private visibleRect(): Rect {
    return { x: this.camera.x, y: this.camera.y, w: this.viewW / this.camera.zoom, h: this.viewH / this.camera.zoom };
  }

  private followView(view: Rect): void {
    // a metà di un tratto o di un trascinamento la vista non si muove: si aspetta la fine del gesto
    if (this.action || this.gesture) {
      this.pendingFollow = view;
      return;
    }
    this.pendingFollow = null;
    this.showRect(view, { top: 0, right: 0, bottom: 0, left: 0 });
  }

  private applyPendingFollow(): void {
    const v = this.pendingFollow;
    if (v && !this.action && !this.gesture && this.collab.isFollowing) this.followView(v);
  }

  /* ======================================================================
   * Testo
   * ==================================================================== */

  private startTextEdit(world: Point, existing?: TextEl): void {
    if (this.readOnly) return;
    this.editSession++;
    if (existing) {
      this.editing = {
        session: this.editSession,
        id: existing.id,
        x: existing.x,
        y: existing.y,
        text: existing.text,
        fontSize: existing.fontSize,
        color: existing.color,
      };
    } else {
      const fontSize = fontSizeFor(this.style.width);
      this.editing = {
        session: this.editSession,
        id: null,
        x: world.x,
        y: world.y - fontSize / 2,
        text: "",
        fontSize,
        color: this.style.color,
      };
    }
    this.selection.clear();
    this.requestRender();
    this.emit();
  }

  updateEditText = (session: number, text: string): void => {
    if (!this.editing || this.editing.session !== session) return;
    this.editing = { ...this.editing, text };
    this.emit();
  };

  commitText = (session: number): void => {
    if (!this.editing || this.editing.session !== session) return;
    this.finishEdit();
  };

  private finishEdit(): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    if (ed.label) {
      this.finishLabel(ed);
      return;
    }
    const text = ed.text.replace(/\s+$/, "");

    if (ed.id) {
      const orig = this.elements.find((e) => e.id === ed.id);
      if (orig && orig.type === "text") {
        if (text === "") {
          this.record();
          this.elements = this.elements.filter((e) => e.id !== ed.id);
        } else if (text !== orig.text) {
          this.record();
          this.elements = this.elements.map((e) => (e.id === ed.id ? { ...orig, text } : e));
        }
      }
    } else if (text !== "") {
      const el: TextEl = {
        id: newId(),
        type: "text",
        color: ed.color,
        width: this.style.width,
        x: ed.x,
        y: ed.y,
        text,
        fontSize: ed.fontSize,
      };
      this.record();
      this.elements = [...this.elements, el];
      this.rememberColor(el.color);
      this.tool = "select";
      this.selection = new Set([el.id]);
      this.updateCursor();
    }
    this.changed();
  }

  /* ======================================================================
   * Diagrammi di flusso: etichette, forme piazzate con un clic, collegamento rapido
   * ==================================================================== */

  /** Forma più in alto che contiene il punto (anche se vuota e non riempita). */
  private boxAt(wp: Point): BoxEl | null {
    return bindTargetAt(this.elements, wp, 0);
  }

  /** Un collegamento spostato senza la sua forma si stacca da lei. */
  private detach(el: El): El {
    return isLine(el) ? detachFrom(el, this.selection) : el;
  }

  /** Apre la textarea per scrivere l'etichetta di una forma o di una freccia. */
  private startLabelEdit(el: BoxEl | LineEl): void {
    if (this.readOnly) return;
    this.editSession++;
    let box: Rect;
    if (isLine(el)) {
      const mx = (el.a.x + el.b.x) / 2;
      const my = (el.a.y + el.b.y) / 2;
      box = { x: mx - ARROW_LABEL_MAX / 2, y: my - LABEL_LINE / 2, w: ARROW_LABEL_MAX, h: LABEL_LINE };
    } else {
      box = labelArea(el);
    }
    this.editing = {
      session: this.editSession,
      id: el.id,
      x: box.x,
      y: box.y,
      text: el.label ?? "",
      fontSize: LABEL_SIZE,
      color: el.color,
      label: { box },
    };
    this.selection.clear();
    this.requestRender();
    this.emit();
  }

  /**
   * Fa stare l'etichetta nella forma, ingrandendola attorno al centro: prima in larghezza (fino a
   * FIT_MAX_W, perché un testo lungo in una colonna stretta si legge male), poi in altezza. Si ripete
   * perché l'area del testo dipende dalle dimensioni (rombo, parallelogramma).
   */
  private fitLabel(el: BoxEl): BoxEl {
    if (!el.label) return el;
    let cur = el;
    for (let i = 0; i < 12; i++) {
      const n = wrapText(cur.label!, labelArea(cur).w, LABEL_SIZE).lines.length;
      const need = heightForLabel(cur, n * LABEL_LINE);
      if (n > 3 && cur.w < FIT_MAX_W) {
        const w = Math.min(FIT_MAX_W, cur.w + 40);
        cur = { ...cur, x: cur.x - (w - cur.w) / 2, w };
      } else if (need > cur.h + 0.5) {
        cur = { ...cur, y: cur.y - (need - cur.h) / 2, h: need };
      } else {
        break;
      }
    }
    return cur;
  }

  /** Conclude la scrittura di un'etichetta: la salva (annullabile) e seleziona l'elemento. */
  private finishLabel(ed: TextEdit): void {
    const orig = ed.id ? this.elements.find((e) => e.id === ed.id) : undefined;
    if (orig && (isBox(orig) || isLine(orig))) {
      const text = ed.text.trim();
      if (text !== (orig.label ?? "")) {
        let next: El;
        if (text) {
          next = { ...orig, label: text };
          if (isBox(next)) next = this.fitLabel(next);
        } else {
          const copy = { ...orig };
          delete copy.label;
          next = copy;
        }
        this.record();
        this.elements = this.elements.map((e) => (e.id === orig.id ? next : e));
      }
      this.tool = "select";
      this.selection = new Set([orig.id]);
      this.updateCursor();
    }
    this.changed();
  }

  /** Piazza una forma di dimensioni standard centrata in `c` e apre la scrittura dell'etichetta. */
  private placeBox(type: BoxType, c: Point): void {
    const { w, h } = DEFAULT_SIZE[type];
    const box: BoxEl = {
      id: newId(),
      type,
      color: this.style.color,
      width: this.style.width,
      x: c.x - w / 2,
      y: c.y - h / 2,
      w,
      h,
      fill: this.style.fill,
    };
    this.addElement(box);
    this.startLabelEdit(box);
  }

  /**
   * Collegamento rapido: crea accanto alla forma selezionata (dal lato scelto) una forma uguale e
   * vuota, collegata con una freccia, e apre subito la scrittura della sua etichetta.
   */
  private quickConnect(side: Side): void {
    const src = this.singleBox();
    if (!src) return;
    const d = SIDE_DIR[side];
    const step = { x: d.x * (src.w + FLOW_GAP), y: d.y * (src.h + FLOW_GAP) };
    const base = { ...src };
    delete base.label;
    let cand: BoxEl = { ...base, id: newId(), x: src.x + step.x, y: src.y + step.y };
    // se il posto è occupato da un'altra forma si va oltre, nella stessa direzione
    const taken = (r: Rect) => this.elements.some((e) => isBox(e) && rectsIntersect(inflate(geomBoundsOf(e), 12), r));
    for (let i = 0; i < 8 && taken(cand); i++) cand = { ...cand, x: cand.x + step.x, y: cand.y + step.y };
    const arrow: LineEl = {
      id: newId(),
      type: "arrow",
      color: src.color,
      width: src.width,
      a: centerOf(src),
      b: centerOf(cand),
      from: src.id,
      to: cand.id,
    };
    this.record();
    this.elements = [...this.elements, cand, arrow];
    this.changed();
    // la nuova forma deve restare visibile mentre ci si scrive
    const view = this.visibleRect();
    if (!rectContains(view, { x: cand.x, y: cand.y }) || !rectContains(view, { x: cand.x + cand.w, y: cand.y + cand.h })) {
      this.camera.x += centerOf(cand).x - (view.x + view.w / 2);
      this.camera.y += centerOf(cand).y - (view.y + view.h / 2);
      this.cameraChanged();
    }
    this.startLabelEdit(cand);
  }

  /* ======================================================================
   * Gesture a due dita (pan + pinch zoom)
   * ==================================================================== */

  private beginGesture(): void {
    this.cancelAction();
    this.userCamera();
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.gesture = {
      startDist: Math.max(1, dist(a, b)),
      startZoom: this.camera.zoom,
      startWorld: this.toWorld(center),
    };
  }

  private updateGesture(): void {
    const g = this.gesture;
    const pts = [...this.pointers.values()];
    if (!g || pts.length < 2) return;
    const [a, b] = pts;
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = clamp((g.startZoom * dist(a, b)) / g.startDist, MIN_ZOOM, MAX_ZOOM);
    this.camera.zoom = z;
    this.camera.x = g.startWorld.x - center.x / z;
    this.camera.y = g.startWorld.y - center.y / z;
    this.cameraChanged();
  }

  /** Annulla l'azione in corso ripristinando lo stato precedente. */
  private cancelAction(): void {
    this.stopAutoPan();
    const a = this.action;
    if (!a) return;
    this.action = null;
    this.snapTarget = null;
    switch (a.kind) {
      case "pen":
      case "shape":
        this.draft = null;
        break;
      case "erase":
        this.erasing.clear();
        break;
      case "move":
      case "resize":
      case "endpoint":
        this.elements = a.origin;
        break;
      case "marquee":
        this.marquee = null;
        break;
    }
    this.updateCursor();
    this.requestRender();
    this.emit();
    this.collab.flush();
    this.collab.ping();
    this.applyPendingFollow();
  }

  /* ======================================================================
   * Eventi pointer
   * ==================================================================== */

  private onContextMenu = (e: Event): void => e.preventDefault();

  private onMouseDown = (e: MouseEvent): void => {
    // evita l'autoscroll del tasto centrale
    if (e.button === 1) e.preventDefault();
  };

  private onPointerLeave = (e: PointerEvent): void => {
    if (this.action) return;
    this.presenceCursor = null;
    this.collab.ping();
    if (e.pointerType !== "touch") {
      this.hover = null;
      this.requestRender();
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.canvas) return;
    const p = this.screenPoint(e);
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* pointer già rilasciato */
    }
    this.pointers.set(e.pointerId, p);
    this.hover = e.pointerType === "touch" ? null : p;
    e.preventDefault();

    if (this.pointers.size >= 2) {
      this.beginGesture();
      return;
    }
    if (this.pointers.size > 2) return;

    if (this.editing) this.finishEdit();
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active !== this.canvas) active.blur?.();

    const wantsPan = e.button === 1 || e.button === 2 || this.spaceDown || this.tool === "hand" || this.readOnly;
    if (wantsPan) {
      this.action = { kind: "pan", pid: e.pointerId, last: p };
      this.updateCursor(p);
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const wp = this.toWorld(p);
    switch (this.tool) {
      case "pen": {
        this.draft = {
          id: newId(),
          type: "stroke",
          color: this.style.color,
          width: this.style.width,
          points: [wp],
        };
        this.action = { kind: "pen", pid: e.pointerId };
        break;
      }
      case "line":
      case "arrow":
      case "rect":
      case "ellipse":
      case "diamond":
      case "terminal":
      case "data": {
        const isLink = this.tool === "line" || this.tool === "arrow";
        // un collegamento che parte da dentro una forma vi resta agganciato
        const bind = isLink ? (bindTargetAt(this.elements, wp, 4 / this.camera.zoom)?.id ?? null) : null;
        this.action = { kind: "shape", pid: e.pointerId, start: wp, startScreen: p, bind };
        this.draft = this.shapeDraft(this.tool, wp, wp, false, bind);
        break;
      }
      case "eraser": {
        this.action = { kind: "erase", pid: e.pointerId, last: wp };
        this.eraseAt(wp, wp);
        break;
      }
      case "text": {
        this.action = { kind: "textclick", pid: e.pointerId, start: p };
        break;
      }
      case "select":
        this.beginSelect(e, p, wp);
        break;
    }
    this.updateCursor(p);
    this.requestRender();
    this.emit();
  };

  private beginSelect(e: PointerEvent, p: Point, wp: Point): void {
    const side = this.plusAt(p);
    if (side) {
      this.quickConnect(side);
      return;
    }
    const end = this.endpointAt(p);
    const line = this.singleLine();
    if (end && line) {
      this.action = { kind: "endpoint", pid: e.pointerId, end, id: line.id, origin: this.elements, moved: false };
      return;
    }
    const handle = this.handleAt(p);
    if (handle) {
      const g = this.selectionGeomBounds()!;
      const corners = this.cornersOf(g);
      const corner = corners[handle];
      this.action = {
        kind: "resize",
        pid: e.pointerId,
        handle,
        anchor: corners[OPPOSITE[handle]],
        corner,
        grab: { x: wp.x - corner.x, y: wp.y - corner.y },
        origin: this.elements,
        moved: false,
      };
      return;
    }

    const hit = this.pick(wp, 6 / this.camera.zoom);
    if (hit) {
      if (e.shiftKey) {
        if (this.selection.has(hit.id)) {
          this.selection.delete(hit.id);
          return;
        }
        this.selection.add(hit.id);
      } else if (!this.selection.has(hit.id)) {
        this.selection = new Set([hit.id]);
      }
      this.action = { kind: "move", pid: e.pointerId, start: wp, origin: this.elements, moved: false };
      return;
    }

    const base = e.shiftKey ? new Set(this.selection) : new Set<string>();
    if (!e.shiftKey) this.selection.clear();
    this.marquee = { x: wp.x, y: wp.y, w: 0, h: 0 };
    this.action = { kind: "marquee", pid: e.pointerId, start: wp, base };
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.canvas) return;
    const p = this.screenPoint(e);
    if (e.pointerType !== "touch") this.hover = p;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    this.presenceCursor = this.toWorld(p);
    this.collab.ping();

    if (this.gesture && this.pointers.size >= 2) {
      this.updateGesture();
      return;
    }

    const a = this.action;
    if (!a || a.pid !== e.pointerId) {
      this.updateCursor(p);
      this.requestRender();
      return;
    }
    this.dragTo(a, p, e.shiftKey, e);
    this.autoPanCheck(p, e.shiftKey);
  };

  /**
   * Aggiorna l'azione in corso con il puntatore in `p` (schermo). La chiama anche lo scorrimento automatico,
   * che sposta la vista tenendo fermo il puntatore: senza evento (`e`), la penna non aggiunge punti.
   */
  private dragTo(a: Action, p: Point, shiftKey: boolean, e?: PointerEvent): void {
    switch (a.kind) {
      case "pan": {
        this.userCamera();
        this.camera.x -= (p.x - a.last.x) / this.camera.zoom;
        this.camera.y -= (p.y - a.last.y) / this.camera.zoom;
        a.last = p;
        this.cameraChanged();
        return;
      }
      case "pen": {
        const d = this.draft;
        if (d && d.type === "stroke" && e) {
          const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
          const list = events.length ? events : [e];
          const minDist = 1 / this.camera.zoom;
          for (const ce of list) {
            const wp = this.toWorld(this.screenPoint(ce));
            const last = d.points[d.points.length - 1];
            if (dist(wp, last) >= minDist) d.points.push(wp);
          }
        }
        break;
      }
      case "shape": {
        const t = this.tool;
        if (t === "line" || t === "arrow" || isBoxType(t)) {
          const wp = this.toWorld(p);
          let to: string | null = null;
          if (t === "line" || t === "arrow") {
            to = bindTargetAt(this.elements, wp, 4 / this.camera.zoom, a.bind ?? undefined)?.id ?? null;
            this.snapTarget = to;
          }
          this.draft = this.shapeDraft(t, a.start, wp, shiftKey && !a.bind && !to, a.bind, to);
        }
        break;
      }
      case "endpoint": {
        const line = a.origin.find((x) => x.id === a.id);
        if (!line || !isLine(line)) break;
        const wp = this.toWorld(p);
        // i due estremi non si agganciano alla stessa forma
        const other = a.end === "a" ? line.to : line.from;
        const tgt = bindTargetAt(a.origin, wp, 4 / this.camera.zoom, other);
        this.snapTarget = tgt?.id ?? null;
        const next: LineEl = { ...line, [a.end]: wp };
        const key = a.end === "a" ? "from" : "to";
        if (tgt) next[key] = tgt.id;
        else delete next[key];
        a.moved = true;
        this.elements = resolveConnectors(a.origin.map((x) => (x.id === a.id ? next : x)));
        break;
      }
      case "erase": {
        const wp = this.toWorld(p);
        this.eraseAt(a.last, wp);
        a.last = wp;
        break;
      }
      case "move": {
        const wp = this.toWorld(p);
        const dx = wp.x - a.start.x;
        const dy = wp.y - a.start.y;
        if (!a.moved && Math.hypot(dx, dy) * this.camera.zoom < 3) break;
        a.moved = true;
        this.elements = resolveConnectors(
          a.origin.map((el) => (this.selection.has(el.id) ? this.detach(translateEl(el, dx, dy)) : el)),
        );
        break;
      }
      case "resize": {
        const wp = this.toWorld(p);
        const tx = wp.x - a.grab.x;
        const ty = wp.y - a.grab.y;
        const ratio = (target: number, anchor: number, corner: number) => {
          const span = corner - anchor;
          // asse senza estensione (linea orizzontale/verticale, punto): nessuna scala
          if (Math.abs(span) < 1e-6) return 1;
          return Math.max(0.05, (target - anchor) / span);
        };
        let sx = ratio(tx, a.anchor.x, a.corner.x);
        let sy = ratio(ty, a.anchor.y, a.corner.y);
        if (shiftKey) sx = sy = Math.max(sx, sy);
        a.moved = true;
        this.elements = resolveConnectors(
          a.origin.map((el) => (this.selection.has(el.id) ? this.detach(scaleEl(el, a.anchor.x, a.anchor.y, sx, sy)) : el)),
        );
        break;
      }
      case "marquee": {
        const wp = this.toWorld(p);
        const r = rectFromPoints(a.start, wp);
        this.marquee = r;
        const next = new Set(a.base);
        for (const el of this.elements) if (rectsIntersect(boundsOf(el), r)) next.add(el.id);
        this.selection = next;
        this.emit();
        break;
      }
      case "textclick":
        break;
    }
    this.requestRender();
  }

  /* ---- scorrimento automatico vicino ai bordi ---- */

  private autoPan: { p: Point; shift: boolean; last: number; raf: number } | null = null;

  /** Velocità (px schermo al secondo) con il puntatore in `p`: zero lontano dai bordi o se il trascinamento non è iniziato. */
  private autoPanVelocity(p: Point): Point {
    const a = this.action;
    if (!a || this.gesture) return { x: 0, y: 0 };
    const active =
      a.kind === "marquee" ||
      a.kind === "resize" ||
      ((a.kind === "move" || a.kind === "endpoint") && a.moved) ||
      (a.kind === "shape" && dist(p, a.startScreen) >= 4);
    if (!active) return { x: 0, y: 0 };
    const margin = Math.min(48, Math.max(24, Math.min(this.viewW, this.viewH) * 0.06));
    const speed = (d: number) => {
      const t = clamp((margin - d) / margin, 0, 1);
      return t * t * AUTOPAN_MAX;
    };
    return { x: speed(this.viewW - p.x) - speed(p.x), y: speed(this.viewH - p.y) - speed(p.y) };
  }

  private autoPanCheck(p: Point, shift: boolean): void {
    const v = this.autoPanVelocity(p);
    if (v.x === 0 && v.y === 0) {
      this.stopAutoPan();
      return;
    }
    if (this.autoPan) {
      this.autoPan.p = p;
      this.autoPan.shift = shift;
      return;
    }
    this.autoPan = { p, shift, last: performance.now(), raf: requestAnimationFrame(this.autoPanTick) };
  }

  private autoPanTick = (now: number): void => {
    const ap = this.autoPan;
    const a = this.action;
    if (!ap || !a) return this.stopAutoPan();
    const v = this.autoPanVelocity(ap.p);
    if (v.x === 0 && v.y === 0) return this.stopAutoPan();
    const dt = Math.min(0.05, Math.max(0, (now - ap.last) / 1000));
    ap.last = now;
    this.userCamera();
    this.camera.x += (v.x * dt) / this.camera.zoom;
    this.camera.y += (v.y * dt) / this.camera.zoom;
    // il puntatore resta fermo sullo schermo ma ora indica un altro punto del mondo
    this.presenceCursor = this.toWorld(ap.p);
    this.dragTo(a, ap.p, ap.shift);
    this.cameraChanged();
    ap.raf = requestAnimationFrame(this.autoPanTick);
  };

  private stopAutoPan(): void {
    if (this.autoPan) cancelAnimationFrame(this.autoPan.raf);
    this.autoPan = null;
  }

  private onPointerUp = (e: PointerEvent): void => {
    this.endPointer(e, false);
  };

  private onPointerCancel = (e: PointerEvent): void => {
    this.endPointer(e, true);
  };

  private endPointer(e: PointerEvent, cancelled: boolean): void {
    this.stopAutoPan();
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2 && this.gesture) {
      this.gesture = null;
      this.applyPendingFollow();
    }
    try {
      this.canvas?.releasePointerCapture(e.pointerId);
    } catch {
      /* già rilasciato */
    }
    if (e.pointerType === "touch") {
      this.hover = null;
      this.presenceCursor = null;
    }

    const a = this.action;
    if (!a || a.pid !== e.pointerId) {
      this.requestRender();
      return;
    }
    if (cancelled) {
      this.cancelAction();
      return;
    }
    this.action = null;
    this.finishAction(a, e);
    this.updateCursor(this.hover ?? undefined);
    this.requestRender();
    this.emit();
    this.collab.flush();
    this.collab.ping();
    this.applyPendingFollow();
  }

  private finishAction(a: Action, e: PointerEvent): void {
    switch (a.kind) {
      case "pan":
        this.scheduleSave();
        break;
      case "pen": {
        const d = this.draft;
        this.draft = null;
        if (d && d.type === "stroke") {
          const points = d.points.length > 2 ? simplify(d.points, 0.35 / this.camera.zoom) : d.points;
          this.addElement({ ...d, points });
        }
        break;
      }
      case "shape": {
        const d = this.draft;
        this.draft = null;
        this.snapTarget = null;
        if (!d) break;
        const moved = dist(this.screenPoint(e), a.startScreen) >= 4;
        // un clic con una forma ne piazza una di dimensioni standard, pronta per scriverci dentro
        if (!moved && isBox(d)) this.placeBox(d.type, a.start);
        else if (moved && this.isMeaningful(d)) this.addElement(d);
        break;
      }
      case "endpoint":
        this.snapTarget = null;
        if (a.moved) {
          this.record(a.origin);
          this.changed();
        }
        break;
      case "erase": {
        if (this.erasing.size > 0) {
          const gone = this.erasing;
          this.erasing = new Set();
          this.record();
          this.elements = this.elements.filter((el) => !gone.has(el.id));
          this.pruneSelection();
          this.changed();
        }
        break;
      }
      case "move":
      case "resize":
        if (a.moved) {
          this.record(a.origin);
          this.changed();
        }
        break;
      case "marquee":
        this.marquee = null;
        break;
      case "textclick": {
        const p = this.screenPoint(e);
        if (dist(p, a.start) < 6) {
          const wp = this.toWorld(p);
          const hit = this.pick(wp, 4 / this.camera.zoom);
          if (hit && hit.type === "text") this.startTextEdit(wp, hit);
          else {
            // con lo strumento testo, un clic su una forma o una freccia ne scrive l'etichetta
            const target = hit && (isBox(hit) || isLine(hit)) ? hit : this.boxAt(wp);
            if (target) this.startLabelEdit(target);
            else this.startTextEdit(wp);
          }
        }
        break;
      }
    }
  }

  private isMeaningful(el: El): boolean {
    const z = this.camera.zoom;
    switch (el.type) {
      case "line":
      case "arrow":
        return !isTinyLine(el, z) && (el.from !== el.to || !el.from);
      case "rect":
      case "ellipse":
      case "diamond":
      case "terminal":
      case "data":
        return Math.max(el.w, el.h) * z >= 3;
      default:
        return true;
    }
  }

  private shapeDraft(
    tool: "line" | "arrow" | BoxType,
    a: Point,
    b: Point,
    shift: boolean,
    from: string | null = null,
    to: string | null = null,
  ): El {
    const base = { id: newId(), color: this.style.color, width: this.style.width };
    if (tool === "line" || tool === "arrow") {
      let end = b;
      if (shift) {
        const step = Math.PI / 12;
        const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / step) * step;
        const len = dist(a, b);
        end = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
      }
      const line: LineEl = { ...base, type: tool, a, b: end };
      if (from) line.from = from;
      if (to) line.to = to;
      return from || to ? resolveLine(line, (id) => this.elements.find((x) => x.id === id)) : line;
    }
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    if (shift) {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * s;
      dy = Math.sign(dy || 1) * s;
    }
    const box: BoxEl = {
      ...base,
      type: tool,
      x: Math.min(a.x, a.x + dx),
      y: Math.min(a.y, a.y + dy),
      w: Math.abs(dx),
      h: Math.abs(dy),
      fill: this.style.fill,
    };
    return box;
  }

  /* ---- selezione / gomma ---- */

  private pick(wp: Point, tol: number): El | null {
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const el = this.elements[i];
      if (rectContains(inflate(boundsOf(el), tol), wp) && hitTest(el, wp, tol)) return el;
    }
    return null;
  }

  /** Segna per la cancellazione gli elementi toccati dal segmento from→to. */
  private eraseAt(from: Point, to: Point): void {
    const r = this.eraserRadiusPx() / this.camera.zoom;
    const steps = Math.max(1, Math.ceil(dist(from, to) / (r * 0.5)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      for (const el of this.elements) {
        if (this.erasing.has(el.id)) continue;
        if (rectContains(inflate(boundsOf(el), r), p) && hitTest(el, p, r)) this.erasing.add(el.id);
      }
    }
  }

  private selectionGeomBounds(): Rect | null {
    return unionRects(this.selectedElements().map(geomBoundsOf));
  }

  private cornersOf(b: Rect): Record<Handle, Point> {
    return {
      nw: { x: b.x, y: b.y },
      ne: { x: b.x + b.w, y: b.y },
      sw: { x: b.x, y: b.y + b.h },
      se: { x: b.x + b.w, y: b.y + b.h },
    };
  }

  /** Posizione schermo degli handle: agli angoli del riquadro di selezione, 3px all'esterno. */
  private handleScreenPos(sb: Rect, h: Handle): Point {
    const s = this.toScreen(sb);
    const w = sb.w * this.camera.zoom;
    const hh = sb.h * this.camera.zoom;
    return {
      x: h === "ne" || h === "se" ? s.x + w + 3 : s.x - 3,
      y: h === "sw" || h === "se" ? s.y + hh + 3 : s.y - 3,
    };
  }

  private handleAt(sp: Point): Handle | null {
    if (this.selection.size === 0 || this.singleLine()) return null;
    const sb = this.selectionBounds();
    if (!sb) return null;
    for (const h of HANDLES) {
      const hp = this.handleScreenPos(sb, h);
      if (Math.abs(sp.x - hp.x) <= HANDLE_HIT && Math.abs(sp.y - hp.y) <= HANDLE_HIT) return h;
    }
    return null;
  }

  private updateCursor(p?: Point): void {
    if (!this.canvas) return;
    let c = "default";
    const a = this.action;
    if (a?.kind === "pan") c = "grabbing";
    else if (this.spaceDown || this.tool === "hand") c = "grab";
    else if (a?.kind === "move") c = "move";
    else if (a?.kind === "endpoint") c = "grabbing";
    else if (a?.kind === "resize") c = a.handle === "nw" || a.handle === "se" ? "nwse-resize" : "nesw-resize";
    else {
      switch (this.tool) {
        case "pen":
        case "eraser":
          c = "none";
          break;
        case "line":
        case "arrow":
        case "rect":
        case "ellipse":
          c = "crosshair";
          break;
        case "text":
          c = "text";
          break;
        case "select": {
          if (p && !a && this.plusAt(p)) c = "pointer";
          else if (p && !a && this.endpointAt(p)) c = "grab";
          else if (p && !a) {
            const h = this.handleAt(p);
            if (h) c = h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize";
            else if (this.pick(this.toWorld(p), 6 / this.camera.zoom)) c = "move";
          }
          break;
        }
      }
    }
    if (c !== this.cursor) {
      this.cursor = c;
      this.canvas.style.cursor = c;
    }
  }

  private onDoubleClick = (e: MouseEvent): void => {
    if ((this.tool !== "select" && this.tool !== "text") || this.readOnly) return;
    const wp = this.toWorld(this.screenPoint(e));
    const hit = this.pick(wp, 4 / this.camera.zoom);
    if (hit && hit.type === "text") {
      this.startTextEdit(wp, hit);
    } else if (hit && (isBox(hit) || isLine(hit))) {
      this.startLabelEdit(hit);
    } else {
      // dentro una forma vuota: si scrive la sua etichetta, non un testo libero
      const box = this.boxAt(wp);
      if (box) this.startLabelEdit(box);
      else if (!hit && this.tool === "select") this.startTextEdit(wp);
    }
  };

  /* ======================================================================
   * Rotella / trackpad
   * ==================================================================== */

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.userCamera();
    const p = this.screenPoint(e);
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    } else if (e.deltaMode === 2) {
      dx *= this.viewW;
      dy *= this.viewH;
    }
    if (e.ctrlKey || e.metaKey) {
      // pinch su trackpad (ctrlKey sintetico) o Ctrl + rotella
      const d = clamp(dy, -30, 30);
      this.zoomAt(p, this.camera.zoom * Math.exp(-d * 0.01));
    } else {
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      this.camera.x += dx / this.camera.zoom;
      this.camera.y += dy / this.camera.zoom;
      this.cameraChanged();
    }
    if (this.hover) this.hover = p;
  };

  /* ======================================================================
   * Tastiera
   * ==================================================================== */

  private onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (this.paused || isTypingTarget(t)) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    // sullo slider le frecce servono allo slider stesso
    if (k.startsWith("arrow") && t instanceof HTMLInputElement && t.type === "range") return;

    if (k === " ") {
      e.preventDefault();
      if (!this.spaceDown) {
        this.spaceDown = true;
        this.updateCursor();
        this.requestRender();
      }
      return;
    }

    if (mod) {
      switch (k) {
        case "z":
          if (e.shiftKey) this.redo();
          else this.undo();
          break;
        case "y":
          this.redo();
          break;
        case "a":
          this.selectAll();
          break;
        case "d":
          this.duplicateSelection();
          break;
        case "c":
          this.copySelection();
          break;
        case "x":
          this.cutSelection();
          break;
        case "v":
          this.paste();
          break;
        case "0":
          this.resetZoom();
          break;
        case "+":
        case "=":
          this.zoomIn();
          break;
        case "-":
          this.zoomOut();
          break;
        default:
          return;
      }
      e.preventDefault();
      return;
    }
    if (e.altKey) return;
    // in sola lettura restano solo la navigazione tra le pagine e la vista
    const viewOnly = this.readOnly;

    // modalità lezione: Pagina giù/su, e le frecce quando non c'è niente di selezionato
    if (this.pageCount() > 0 && !e.shiftKey) {
      const noSel = this.selection.size === 0;
      if (k === "pagedown" || (noSel && (k === "arrowright" || k === "arrowdown"))) {
        e.preventDefault();
        this.nextPage();
        return;
      }
      if (k === "pageup" || (noSel && (k === "arrowleft" || k === "arrowup"))) {
        e.preventDefault();
        this.prevPage();
        return;
      }
    }

    if (viewOnly && k !== "1" && k !== "escape") return;
    const step = (e.shiftKey ? 10 : 1) / this.camera.zoom;
    switch (k) {
      case "v":
        this.setTool("select");
        break;
      case "h":
        this.setTool("hand");
        break;
      case "p":
      case "b":
        this.setTool("pen");
        break;
      case "e":
        this.setTool("eraser");
        break;
      case "l":
        this.setTool("line");
        break;
      case "a":
        this.setTool("arrow");
        break;
      case "r":
        this.setTool("rect");
        break;
      case "o":
        this.setTool("ellipse");
        break;
      case "d":
        this.setTool("diamond");
        break;
      case "enter": {
        // Invio sulla forma (o freccia, o testo) selezionata: si scrive dentro
        if (this.selection.size !== 1) break;
        const el = this.selectedElements()[0];
        if (!el) break;
        e.preventDefault();
        if (el.type === "text") this.startTextEdit({ x: el.x, y: el.y }, el);
        else if (isBox(el) || isLine(el)) this.startLabelEdit(el);
        break;
      }
      case "t":
        e.preventDefault(); // evita che la "t" finisca nella textarea appena aperta
        this.setTool("text");
        break;
      case "delete":
      case "backspace":
        e.preventDefault();
        this.deleteSelection();
        break;
      case "escape":
        this.clearSelection();
        break;
      case "arrowleft":
        e.preventDefault();
        this.nudge(-step, 0);
        break;
      case "arrowright":
        e.preventDefault();
        this.nudge(step, 0);
        break;
      case "arrowup":
        e.preventDefault();
        this.nudge(0, -step);
        break;
      case "arrowdown":
        e.preventDefault();
        this.nudge(0, step);
        break;
      case "]":
        this.bringToFront();
        break;
      case "[":
        this.sendToBack();
        break;
      case "1":
        this.zoomToFit();
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === " ") {
      if (!isTypingTarget(e.target as HTMLElement | null)) e.preventDefault();
      this.spaceDown = false;
      this.updateCursor();
      this.requestRender();
    }
  };

  private onWindowBlur = (): void => {
    this.spaceDown = false;
    this.updateCursor();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === "hidden") this.flushSave();
  };

  /* ======================================================================
   * Persistenza e libreria di lavagne
   * ==================================================================== */

  setPaused = (paused: boolean): void => {
    this.paused = paused;
  };

  private serialize(forStorage = false): PersistedBoard {
    return {
      version: 1,
      name: this.boardName,
      elements: this.elements,
      camera: { ...this.camera },
      bgColor: this.bgColor,
      grid: this.grid,
      color: this.style.color,
      width: this.style.width,
      fill: this.style.fill,
      recentColors: this.recentColors,
      pages: this.pages || undefined,
      // i metadati di sincronizzazione restano nel browser: mai in export, link o duplicati
      collab: forStorage ? this.collab.save() : undefined,
    };
  }

  private applyBoard(b: PersistedBoard, withCamera: boolean): void {
    this.elements = b.elements;
    if (withCamera && b.camera) this.camera = { ...b.camera };
    if (b.bgColor) this.bgColor = sanitizeColor(b.bgColor, DEFAULT_BG);
    if (b.grid) this.grid = b.grid;
    if (b.color) this.style.color = sanitizeColor(b.color, DEFAULT_COLOR);
    if (b.width) this.style.width = Math.round(clamp(b.width, MIN_WIDTH, MAX_WIDTH));
    if (typeof b.fill === "boolean") this.style.fill = b.fill;
    if (b.recentColors) this.recentColors = b.recentColors.slice(0, RECENT_MAX);
    this.pages = b.pages ?? 0;
  }

  /** Riporta il documento a una lavagna vuota (stile dello strumento invariato). */
  private resetDocument(): void {
    this.elements = [];
    this.past = [];
    this.future = [];
    this.coalesceKey = null;
    this.selection = new Set();
    this.draft = null;
    this.erasing = new Set();
    this.marquee = null;
    this.editing = null;
    this.action = null;
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.bgColor = DEFAULT_BG;
    this.grid = "dots";
    this.pages = 0;
    this.pendingFollow = null;
  }

  private nextName(): string {
    const names = new Set(this.boards.map((b) => b.name));
    let n = this.boards.length + 1;
    while (names.has(`Lavagna ${n}`)) n++;
    return `Lavagna ${n}`;
  }

  private makeMeta(name: string): BoardMeta {
    const now = Date.now();
    return { id: newId(), name, createdAt: now, updatedAt: now };
  }

  /** Scrive l'indice. Ritorna false se localStorage non è utilizzabile. */
  private persistIndex(): boolean {
    try {
      writeIndex({ version: 1, currentId: this.boardId, boards: this.boards });
      return true;
    } catch {
      return false;
    }
  }

  private patchMeta(id: string, patch: Partial<BoardMeta>): void {
    this.boards = this.boards.map((b) => (b.id === id ? { ...b, ...patch } : b));
  }

  private load(): void {
    this.collab.init();
    let index = readIndex();
    if (!index) {
      // primo avvio, oppure migrazione dalla versione a lavagna singola
      const meta = this.makeMeta("Lavagna 1");
      try {
        const raw = localStorage.getItem(LEGACY_KEY);
        const legacy = raw ? parseBoard(raw) : null;
        if (legacy) {
          writeBoard(meta.id, legacy);
          localStorage.removeItem(LEGACY_KEY);
        }
      } catch {
        /* storage non disponibile: si lavora in memoria */
      }
      index = { version: 1, currentId: meta.id, boards: [meta] };
    }
    this.boards = index.boards;
    this.enterBoard(index.currentId);
    this.persistIndex();
    this.ensureStored();
  }

  /** Garantisce che la lavagna corrente abbia la sua voce dati (indice e dati restano coerenti). */
  private ensureStored(): void {
    if (readBoard(this.boardId)) return;
    this.dirty = true;
    this.flushSave();
  }

  /** Carica la lavagna `id` come documento corrente (senza salvare quella precedente). */
  private enterBoard(id: string): void {
    const meta = this.boards.find((b) => b.id === id) ?? this.boards[0];
    this.resetDocument();
    this.boardId = meta.id;
    this.boardName = meta.name;
    const data = readBoard(meta.id);
    if (data) this.applyBoard(data, true);
    this.collab.load(data?.collab, this.elements);
    this.dirty = false;
    this.saveState = "saved";
    this.updateCursor();
    this.requestRender();
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveState !== "saving") {
      this.saveState = "saving";
      this.emit();
    }
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(this.flushSave, 500);
  }

  private flushSave = (): void => {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.loaded || !this.boardId || !this.dirty) return;
    this.dirty = false;
    try {
      writeBoard(this.boardId, this.serialize(true));
      this.patchMeta(this.boardId, { updatedAt: Date.now(), name: this.boardName });
      if (!this.persistIndex()) throw new Error("index");
      this.saveState = "saved";
      this.lastSaved = Date.now();
    } catch {
      // quota superata o storage bloccato: i dati restano in memoria, la UI avvisa
      this.saveState = "error";
      this.dirty = true;
    }
    this.emit();
  };

  /** Anteprima JPEG della lavagna corrente (undefined se vuota). */
  private makeThumb(): string | undefined {
    const content = unionRects(this.elements.map(boundsOf));
    if (!content) return undefined;
    try {
      const W = 320;
      const H = 200;
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d");
      if (!ctx) return undefined;
      ctx.fillStyle = this.bgColor;
      ctx.fillRect(0, 0, W, H);
      const area = inflate(content, 40);
      const scale = Math.min(W / area.w, H / area.h, 1.5);
      const ox = (W - area.w * scale) / 2 - area.x * scale;
      const oy = (H - area.h * scale) / 2 - area.y * scale;
      ctx.setTransform(scale, 0, 0, scale, ox, oy);
      drawElements(ctx, this.elements, null, undefined, null, scale, { bg: this.bgColor });
      return canvas.toDataURL("image/jpeg", 0.72);
    } catch {
      return undefined;
    }
  }

  /** Aggiorna l'anteprima della lavagna corrente (chiamata aprendo la libreria). */
  refreshThumb = (): void => {
    if (!this.boardId) return;
    this.flushSave();
    this.patchMeta(this.boardId, { thumb: this.makeThumb() });
    this.persistIndex();
    this.emit();
  };

  newBoard = (name?: string): string => {
    if (this.editing) this.finishEdit();
    this.flushSave();
    this.patchMeta(this.boardId, { thumb: this.makeThumb() });
    const meta = this.makeMeta(name?.trim() || this.nextName());
    this.boards = [...this.boards, meta];
    this.enterBoard(meta.id);
    this.dirty = true;
    this.flushSave();
    this.requestRender();
    this.emit();
    return meta.id;
  };

  openBoard = (id: string): void => {
    if (id === this.boardId || !this.boards.some((b) => b.id === id)) return;
    if (this.editing) this.finishEdit();
    this.flushSave();
    this.patchMeta(this.boardId, { thumb: this.makeThumb() });
    this.enterBoard(id);
    this.persistIndex();
    this.requestRender();
    this.emit();
  };

  renameBoard = (id: string, name: string): void => {
    const n = name.trim().slice(0, 80);
    if (!n) return;
    this.patchMeta(id, { name: n });
    if (id === this.boardId) {
      this.boardName = n;
      this.dirty = true;
    }
    this.flushSave();
    this.persistIndex();
    this.emit();
  };

  duplicateBoard = (id: string): string | null => {
    const src = this.boards.find((b) => b.id === id);
    if (!src) return null;
    this.flushSave();
    const data = id === this.boardId ? this.serialize() : readBoard(id);
    if (!data) return null;
    const meta: BoardMeta = {
      ...this.makeMeta(`${src.name} (copia)`.slice(0, 80)),
      thumb: id === this.boardId ? this.makeThumb() : src.thumb,
    };
    try {
      writeBoard(meta.id, { ...data, name: meta.name, collab: undefined });
    } catch {
      this.saveState = "error";
      this.emit();
      return null;
    }
    this.boards = [...this.boards, meta];
    this.persistIndex();
    this.emit();
    return meta.id;
  };

  deleteBoard = (id: string): void => {
    if (!this.boards.some((b) => b.id === id)) return;
    removeBoard(id);
    const rest = this.boards.filter((b) => b.id !== id);
    if (id !== this.boardId) {
      this.boards = rest;
      this.persistIndex();
      this.emit();
      return;
    }
    this.dirty = false;
    if (rest.length === 0) {
      const meta = this.makeMeta("Lavagna 1");
      this.boards = [meta];
    } else {
      this.boards = rest;
    }
    const next = [...this.boards].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    this.enterBoard(next.id);
    this.persistIndex();
    this.ensureStored();
    this.requestRender();
    this.emit();
  };

  /* ======================================================================
   * Collaborazione in tempo reale (P2P, WebRTC)
   * ==================================================================== */

  private makeCollabHost(): CollabHost {
    return {
      getElements: () => this.elements,
      getProps: () => ({ bgColor: this.bgColor, grid: this.grid, pages: this.pages }),
      getBoardName: () => this.boardName,
      getPresence: () => ({ cursor: this.presenceCursor, draft: this.draft, view: this.canvas ? this.visibleRect() : null }),
      followView: (v) => this.followView(v),
      accessChanged: () => this.onAccessChanged(),
      // durante un trascinamento locale `elements` viene ricalcolato da uno snapshot: gli aggiornamenti
      // remoti aspettano la fine del gesto (vedi Collab.flush)
      isBusy: () => this.action?.kind === "move" || this.action?.kind === "resize" || this.action?.kind === "endpoint",
      setRemoteState: (n) => this.setRemoteState(n),
      invalidate: () => this.requestRender(),
      emit: () => this.emit(),
      persist: () => this.scheduleSave(),
    };
  }

  /** Applica lo stato arrivato dagli altri partecipanti. Non entra nella history né viene rispedito. */
  private setRemoteState(n: { elements?: El[]; bgColor?: string; grid?: GridMode; pages?: number; first?: boolean }): void {
    if (n.elements) {
      // le forme spostate da altri trascinano le frecce agganciate; se il ricalcolo cambia qualcosa
      // (es. due persone hanno spostato i due capi della stessa freccia) lo si condivide: tutti
      // calcolano lo stesso risultato, quindi converge subito
      this.elements = resolveConnectors(n.elements);
      this.pruneSelection();
      if (this.elements !== n.elements && !this.readOnly) this.collab.localChanged();
    }
    if (n.bgColor) this.bgColor = n.bgColor;
    if (n.grid) this.grid = n.grid;
    if (n.pages !== undefined) this.pages = n.pages;
    if (n.first && !this.collab.isFollowing) this.fitContent();
    this.requestRender();
    this.scheduleSave();
    this.emit();
  }

  /** I tuoi permessi sono cambiati: in sola lettura si chiude ciò che stavi facendo e resta la mano. */
  private wasReadOnly = false;

  private onAccessChanged(): void {
    this.wasReadOnly = this.readOnly;
    if (this.readOnly) {
      this.editing = null;
      this.action = null;
      this.draft = null;
      this.selection.clear();
      this.past = [];
      this.future = [];
      this.tool = "hand";
    } else if (this.tool === "hand") {
      this.tool = "select";
    }
    this.updateCursor();
    this.requestRender();
    this.emit();
  }

  private onPageHide = (e: PageTransitionEvent): void => {
    if (!e.persisted) this.collab.farewell();
  };

  /** Rende collaborativa la lavagna corrente: da qui si possono creare inviti. */
  startCollab = (name: string, access: Access = "edit"): ReturnType<Collab["startHost"]> => {
    if (this.editing) this.finishEdit();
    return this.collab.startHost(name, access);
  };

  /** Proprietario: chi entra può modificare ("edit") o solo guardare ("view"). */
  setDefaultAccess = (access: Access): Promise<void> => this.collab.setDefaultAccess(access);

  /** Proprietario: dà o toglie a un partecipante la possibilità di modificare. */
  setPeerAccess = (site: string, access: Access): Promise<void> => this.collab.setAccess(site, access);

  /** In sola lettura: chiedi al proprietario di poter modificare. */
  askEditAccess = (): void => this.collab.askAccess();

  /** Proprietario: ignora una richiesta di modifica. */
  dismissAccessRequest = (site: string): void => this.collab.dismissRequest(site);

  /** Crea un invito (link + codice) per una persona. */
  createInvite = (): ReturnType<Collab["createInvite"]> => this.collab.createInvite();

  /** L'host incolla il codice di risposta dell'ospite. */
  acceptAnswer = (text: string): ReturnType<Collab["acceptAnswer"]> => this.collab.acceptAnswer(text);

  /** Link della stanza, riutilizzabile, per entrare con il collegamento automatico. */
  getRoomLink = (): ReturnType<Collab["roomLink"]> => this.collab.roomLink();

  /** Id di una lavagna della libreria che fa già parte della stanza `room` (null se nessuna). */
  private boardInRoom(room: string): string | null {
    for (const b of this.boards) {
      if (b.id === this.boardId) continue;
      if (readBoard(b.id)?.collab?.room === room) return b.id;
    }
    return null;
  }

  /**
   * L'ospite apre un invito. Se una lavagna della libreria fa già parte di quella stanza la riapre e si
   * riconnette (stessa identità, niente doppioni), altrimenti l'invito crea una NUOVA lavagna nella
   * libreria (quella aperta non viene toccata né sincronizzata).
   * `answer` è il codice da rimandare all'host per un invito manuale, null con il link della stanza.
   */
  joinCollab = async (
    text: string,
    name: string,
  ): Promise<{ ok: true; answer: string | null; resumed: boolean } | { ok: false; error: string }> => {
    const inv = await Collab.parseInvite(text);
    if (!inv) return { ok: false, error: "Invito non valido o danneggiato" };
    if (this.editing) this.finishEdit();

    const existing = this.collab.doc?.room === inv.room ? this.boardId : this.boardInRoom(inv.room);
    if (existing) {
      this.openBoard(existing);
      const r = await this.collab.resume(inv, name);
      return r.ok ? { ...r, resumed: true } : r;
    }

    this.flushSave();
    this.patchMeta(this.boardId, { thumb: this.makeThumb() });
    const meta = this.makeMeta((inv.b || "Lavagna condivisa").slice(0, 80));
    this.boards = [...this.boards, meta];
    this.enterBoard(meta.id);
    const r = await this.collab.beginGuest(inv, name);
    if (!r.ok) {
      this.deleteBoard(meta.id);
      return r;
    }
    this.dirty = true;
    this.flushSave();
    this.requestRender();
    this.emit();
    return { ...r, resumed: false };
  };

  /** Esce dalla collaborazione: la lavagna resta, normale, in questo browser. */
  stopCollab = (): void => this.collab.stop();
  setCollabName = (name: string): void => this.collab.setName(name);
  setCollabStun = (stun: boolean): void => this.collab.setStun(stun);
  setCollabRelay = (relay: boolean): void => this.collab.setRelay(relay);

  /* ======================================================================
   * Import / export
   * ==================================================================== */

  private saveJSONFile(data: PersistedBoard, name: string): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${slugify(name)}-${timestamp()}.json`);
  }

  /** Esporta la lavagna corrente (o quella indicata) come file .json. */
  exportJSON = (id?: string): void => {
    if (!id || id === this.boardId) {
      this.saveJSONFile(this.serialize(), this.boardName);
      return;
    }
    const meta = this.boards.find((b) => b.id === id);
    const data = readBoard(id);
    if (meta && data) this.saveJSONFile({ ...data, name: meta.name, collab: undefined }, meta.name);
  };

  /** Link che contiene l'intera lavagna corrente (nel fragment dell'URL, mai inviato al server). */
  getShareUrl = async (): Promise<{ ok: true; url: string } | { ok: false; error: string }> => {
    if (this.editing) this.finishEdit();
    const url = await buildShareUrl(this.serialize());
    if (url.length > SHARE_HARD_LIMIT) {
      return { ok: false, error: "La lavagna è troppo grande per essere condivisa con un link: esportala in .json." };
    }
    return { ok: true, url };
  };

  /** Importa un file .json come NUOVA lavagna (la lavagna corrente non viene toccata). */
  importJSON = (text: string, fileName?: string): { ok: boolean; id?: string; error?: string } => {
    const board = parseBoard(text);
    if (!board) return { ok: false, error: "File non valido: non è una lavagna esportata da questa app." };
    return this.importBoard(board, fileName);
  };

  /** Importa una lavagna già validata come NUOVA lavagna (usata da file .json e link condivisi). */
  importBoard = (board: PersistedBoard, fileName?: string): { ok: boolean; id?: string; error?: string } => {
    if (this.editing) this.finishEdit();
    this.flushSave();
    this.patchMeta(this.boardId, { thumb: this.makeThumb() });
    const fromFile = fileName?.replace(/\.json$/i, "").replace(/[-_]\d{8}-\d{4}$/, "").trim();
    const meta = this.makeMeta((board.name || fromFile || this.nextName()).slice(0, 80));
    this.boards = [...this.boards, meta];
    this.enterBoard(meta.id);
    this.applyBoard(board, false);
    if (this.pages > 0) this.goToPage(0);
    else this.fitContent();
    this.dirty = true;
    this.flushSave();
    this.requestRender();
    this.emit();
    return { ok: true, id: meta.id };
  };

  /** Esporta tutto il contenuto (o la vista corrente se la lavagna è vuota) in PNG. */
  exportPNG = async (): Promise<void> => {
    const content = unionRects(this.elements.map(boundsOf));
    const pad = 48;
    const area: Rect = content
      ? inflate(content, pad)
      : { x: this.camera.x, y: this.camera.y, w: this.viewW / this.camera.zoom, h: this.viewH / this.camera.zoom };

    const maxSide = 8192;
    const maxPixels = 16_000_000;
    const scale = Math.min(2, maxSide / Math.max(area.w, area.h), Math.sqrt(maxPixels / (area.w * area.h)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(area.w * scale));
    canvas.height = Math.max(1, Math.round(area.h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = this.bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, -area.x * scale, -area.y * scale);
    drawElements(ctx, this.elements, null, undefined, null, 1, { bg: this.bgColor });

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob) downloadBlob(blob, `${slugify(this.boardName)}-${timestamp()}.png`);
  };
}
