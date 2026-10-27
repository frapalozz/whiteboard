import { sanitizeElement } from "../storage";
import type { El, GridMode } from "../types";
import { MAX_ENTRIES, type Batch, type CollabSaved, type Reg, type Wire, type WireProps } from "./types";
import { isNum, isObj, isStr, MAX_CLOCK, parseBgReg, parseGridReg, parsePagesReg } from "./validate";

/**
 * Documento collaborativo.
 *
 * Ogni elemento ha una voce con (versione di Lamport, sito, chiave d'ordine, lapide). Vince la versione
 * più alta, a parità il sito con id maggiore: il merge è commutativo, associativo e idempotente, quindi
 * i peer convergono qualunque sia l'ordine (o la duplicazione) dei messaggi, e un messaggio può essere
 * inoltrato ad altri peer senza rischio di cicli (si inoltra solo ciò che ha davvero cambiato lo stato).
 *
 * Gli elementi del motore sono immutabili: "è cambiato?" si riduce a un confronto di riferimenti.
 * L'array di elementi del motore resta la fonte di verità per la UI; qui si tengono solo i metadati.
 */

interface Entry {
  v: number;
  s: string;
  o: number;
  del: boolean;
  el: El | null;
}

export const MAX_POINTS = 50_000;

const newer = (a: { v: number; s: string }, b: { v: number; s: string }): boolean =>
  a.v > b.v || (a.v === b.v && a.s > b.s);

/** Confronto totale tra chiavi d'ordine: prima la chiave, poi l'id (spareggio deterministico). */
const cmpOrder = (ao: number, aid: string, bo: number, bid: string): number =>
  ao !== bo ? (ao < bo ? -1 : 1) : aid === bid ? 0 : aid < bid ? -1 : 1;

const toWire = (id: string, e: Entry): Wire =>
  e.del ? { id, v: e.v, s: e.s, o: e.o, d: 1 } : { id, v: e.v, s: e.s, o: e.o, el: e.el ?? undefined };

export interface Props {
  bgColor: string;
  grid: GridMode;
  pages: number;
}

export interface ApplyResult {
  changed: Set<string>;
  props: boolean;
  /** Ciò che ha cambiato lo stato e va inoltrato agli altri peer (null se nulla). */
  forward: Batch | null;
}

export class CollabDoc {
  clock = 0;
  /** Numero di batch remoti che hanno modificato qualcosa (serve al rebase di undo/redo). */
  seq = 0;
  private entries = new Map<string, Entry>();
  private touched = new Map<string, number>();
  private bg: Reg<string> | null = null;
  private grid: Reg<GridMode> | null = null;
  private pages: Reg<number> | null = null;

  constructor(
    readonly room: string,
    readonly site: string,
    readonly mode: "host" | "guest",
  ) {}

  /* ---------------------------------------------------------------------
   * Modifiche locali → operazioni
   * ------------------------------------------------------------------- */

  /**
   * Confronta l'array del motore con lo stato noto e produce le operazioni da inviare.
   * `skip`: id modificati da remoto e non ancora applicati al motore (gesture in corso): non si toccano.
   * `seedProps`: l'host adotta sfondo, griglia e pagine locali come valori iniziali (un ospite no, altrimenti
   * sovrascriverebbe quelli della lavagna a cui si unisce).
   */
  local(elements: El[], props: Props, skip?: Set<string>, seedProps = false): Batch | null {
    const out: Wire[] = [];
    const orders = this.assignOrders(elements, skip);
    const seen = new Set<string>();

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      seen.add(el.id);
      if (skip?.has(el.id)) continue;
      const cur = this.entries.get(el.id);
      if (!cur || cur.del || cur.el !== el || cur.o !== orders[i]) {
        if (!cur && this.entries.size >= MAX_ENTRIES) continue;
        const e: Entry = { v: ++this.clock, s: this.site, o: orders[i], del: false, el };
        this.entries.set(el.id, e);
        out.push(toWire(el.id, e));
      }
    }
    for (const [id, e] of this.entries) {
      if (e.del || seen.has(id) || skip?.has(id)) continue;
      const t: Entry = { v: ++this.clock, s: this.site, o: e.o, del: true, el: null };
      this.entries.set(id, t);
      out.push(toWire(id, t));
    }

    let p: WireProps | undefined;
    if ((seedProps || this.bg) && this.bg?.val !== props.bgColor) {
      this.bg = { v: ++this.clock, s: this.site, val: props.bgColor };
      (p ??= {}).bg = this.bg;
    }
    if ((seedProps || this.grid) && this.grid?.val !== props.grid) {
      this.grid = { v: ++this.clock, s: this.site, val: props.grid };
      (p ??= {}).grid = this.grid;
    }
    // le pagine si propagano anche se attivate in una stanza nata prima che esistessero (nessun registro):
    // chi entra parte da 0 pagine, quindi non può sovrascrivere quelle della stanza
    if ((seedProps || this.pages || props.pages > 0) && (this.pages?.val ?? 0) !== props.pages) {
      this.pages = { v: ++this.clock, s: this.site, val: props.pages };
      (p ??= {}).pg = this.pages;
    }
    return out.length || p ? { e: out, p } : null;
  }

  /**
   * Assegna a ogni elemento una chiave d'ordine coerente con la sua posizione nell'array.
   * Si conservano le chiavi già valide (strettamente crescenti) e si riempiono i buchi
   * interpolando tra i vicini: un elemento spostato in primo piano riceve solo una chiave nuova.
   */
  private assignOrders(els: El[], skip?: Set<string>): number[] {
    const n = els.length;
    const o = new Array<number>(n).fill(0);
    const ok = new Array<boolean>(n).fill(false);
    let po = -Infinity;
    let pid = "";
    for (let i = 0; i < n; i++) {
      const id = els[i].id;
      const c = this.entries.get(id);
      if (!c) continue;
      if (skip?.has(id)) {
        o[i] = c.o;
        ok[i] = true;
        continue;
      }
      if (cmpOrder(c.o, id, po, pid) > 0) {
        o[i] = c.o;
        ok[i] = true;
        po = c.o;
        pid = id;
      }
    }
    let i = 0;
    while (i < n) {
      if (ok[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && !ok[j]) j++;
      const m = j - i;
      const lo = i > 0 ? o[i - 1] : null;
      const hi = j < n ? o[j] : null;
      for (let k = 0; k < m; k++) {
        o[i + k] =
          lo === null && hi === null
            ? k
            : hi === null
              ? (lo as number) + 1 + k
              : lo === null
                ? hi - (m - k)
                : lo + ((hi - lo) * (k + 1)) / (m + 1);
      }
      i = j;
    }
    return o;
  }

  /* ---------------------------------------------------------------------
   * Operazioni remote → stato
   * ------------------------------------------------------------------- */

  apply(b: Batch): ApplyResult {
    const changed = new Set<string>();
    const fwd: Wire[] = [];
    for (const w of b.e) {
      if (w.v > this.clock) this.clock = w.v;
      const cur = this.entries.get(w.id);
      if (cur ? !newer(w, cur) : this.entries.size >= MAX_ENTRIES) continue;
      this.entries.set(w.id, { v: w.v, s: w.s, o: w.o, del: w.d === 1, el: w.d === 1 ? null : (w.el ?? null) });
      changed.add(w.id);
      fwd.push(w);
    }

    let props = false;
    let fp: WireProps | undefined;
    if (b.p?.bg) {
      if (b.p.bg.v > this.clock) this.clock = b.p.bg.v;
      if (!this.bg || newer(b.p.bg, this.bg)) {
        this.bg = b.p.bg;
        props = true;
        (fp ??= {}).bg = b.p.bg;
      }
    }
    if (b.p?.grid) {
      if (b.p.grid.v > this.clock) this.clock = b.p.grid.v;
      if (!this.grid || newer(b.p.grid, this.grid)) {
        this.grid = b.p.grid;
        props = true;
        (fp ??= {}).grid = b.p.grid;
      }
    }
    if (b.p?.pg) {
      if (b.p.pg.v > this.clock) this.clock = b.p.pg.v;
      if (!this.pages || newer(b.p.pg, this.pages)) {
        this.pages = b.p.pg;
        props = true;
        (fp ??= {}).pg = b.p.pg;
      }
    }

    if (changed.size || props) {
      this.seq++;
      for (const id of changed) this.touched.set(id, this.seq);
    }
    return { changed, props, forward: fwd.length || fp ? { e: fwd, p: fp } : null };
  }

  /** Sfondo, griglia e pagine correnti secondo il documento (undefined se mai impostati). */
  currentProps(): Partial<Props> {
    return { bgColor: this.bg?.val, grid: this.grid?.val, pages: this.pages?.val };
  }

  /* ---------------------------------------------------------------------
   * Dal documento all'array del motore
   * ------------------------------------------------------------------- */

  /** Tutti gli elementi vivi, in ordine z. */
  materialize(): El[] {
    const live: Array<[string, Entry]> = [];
    for (const kv of this.entries) if (!kv[1].del && kv[1].el) live.push(kv);
    live.sort((a, b) => cmpOrder(a[1].o, a[0], b[1].o, b[0]));
    return live.map(([, e]) => e.el as El);
  }

  /** Aggiorna `elements` applicando solo gli id cambiati (O(n) invece di un riordino completo). */
  patch(elements: El[], changed: Set<string>): El[] {
    const out = elements.filter((e) => !changed.has(e.id));
    for (const id of changed) {
      const e = this.entries.get(id);
      if (!e || e.del || !e.el) continue;
      let lo = 0;
      let hi = out.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const m = this.entries.get(out[mid].id);
        const c = m ? cmpOrder(m.o, out[mid].id, e.o, id) : 1;
        if (c < 0) lo = mid + 1;
        else hi = mid;
      }
      out.splice(lo, 0, e.el);
    }
    return out;
  }

  /**
   * Undo/redo restituiscono uno snapshot dell'array, che altrimenti cancellerebbe il lavoro altrui
   * arrivato dopo. Per gli id modificati da remoto dopo lo snapshot si tiene la versione corrente:
   * così "annulla" annulla solo le azioni dell'utente locale.
   */
  rebase(prev: El[], snapSeq: number, current: El[]): El[] {
    if (this.seq <= snapSeq) return prev;
    const isTouched = (id: string) => (this.touched.get(id) ?? 0) > snapSeq;
    const out = prev.filter((e) => !isTouched(e.id));
    for (const el of current) {
      if (!isTouched(el.id)) continue;
      const e = this.entries.get(el.id);
      if (!e || e.del) continue;
      let idx = out.findIndex((x) => {
        const m = this.entries.get(x.id);
        return !m || cmpOrder(m.o, x.id, e.o, el.id) > 0;
      });
      if (idx < 0) idx = out.length;
      out.splice(idx, 0, el);
    }
    return out;
  }

  /* ---------------------------------------------------------------------
   * Sincronizzazione completa e persistenza
   * ------------------------------------------------------------------- */

  /** Stato completo, diviso in batch di dimensione ragionevole per il canale. */
  snapshot(chunk = 400): Batch[] {
    const all: Wire[] = [];
    for (const [id, e] of this.entries) all.push(toWire(id, e));
    const props: WireProps = {};
    if (this.bg) props.bg = this.bg;
    if (this.grid) props.grid = this.grid;
    if (this.pages) props.pg = this.pages;
    const batches: Batch[] = [];
    for (let i = 0; i < all.length; i += chunk) batches.push({ e: all.slice(i, i + chunk) });
    if (batches.length === 0) batches.push({ e: [] });
    batches[0].p = props;
    return batches;
  }

  save(): CollabSaved {
    const entries: CollabSaved["entries"] = [];
    for (const [id, e] of this.entries) entries.push([id, e.v, e.s, e.o, e.del ? 1 : 0]);
    return {
      room: this.room,
      site: this.site,
      mode: this.mode,
      clock: this.clock,
      entries,
      bg: this.bg ?? undefined,
      grid: this.grid ?? undefined,
      pages: this.pages ?? undefined,
    };
  }

  /** Ricostruisce il documento da dati salvati; `elements` fornisce i contenuti (stessi riferimenti). */
  static restore(saved: CollabSaved, elements: El[]): CollabDoc {
    const doc = new CollabDoc(saved.room, saved.site, saved.mode);
    doc.clock = saved.clock;
    const byId = new Map(elements.map((e) => [e.id, e]));
    for (const [id, v, s, o, del] of saved.entries) {
      doc.entries.set(id, { v, s, o, del: del === 1, el: del === 1 ? null : (byId.get(id) ?? null) });
    }
    doc.bg = saved.bg ?? null;
    doc.grid = saved.grid ?? null;
    doc.pages = saved.pages ?? null;
    return doc;
  }
}

/* ------------------------------------------------------------------------
 * Validazione di ciò che arriva dalla rete (mai fidarsi dei peer)
 * ---------------------------------------------------------------------- */

export function parseBatch(raw: unknown): Batch | null {
  if (!isObj(raw) || !Array.isArray(raw.e) || raw.e.length > 5000) return null;
  const e: Wire[] = [];
  for (const w of raw.e) {
    if (!isObj(w) || !isStr(w.id, 100) || !isNum(w.v) || w.v < 0 || w.v > MAX_CLOCK || !isStr(w.s, 40) || !isNum(w.o)) {
      return null;
    }
    if (Math.abs(w.o) > 1e12) return null;
    const base = { id: w.id, v: Math.floor(w.v), s: w.s, o: w.o };
    if (w.d === 1) {
      e.push({ ...base, d: 1 });
      continue;
    }
    const el = sanitizeElement(w.el);
    if (!el || el.id !== w.id || (el.type === "stroke" && el.points.length > MAX_POINTS)) return null;
    e.push({ ...base, el });
  }
  let p: WireProps | undefined;
  if (raw.p !== undefined) {
    if (!isObj(raw.p)) return null;
    const bg = raw.p.bg === undefined ? null : parseBgReg(raw.p.bg);
    const grid = raw.p.grid === undefined ? null : parseGridReg(raw.p.grid);
    const pg = raw.p.pg === undefined ? null : parsePagesReg(raw.p.pg);
    if (bg || grid || pg) {
      p = {};
      if (bg) p.bg = bg;
      if (grid) p.grid = grid;
      if (pg) p.pg = pg;
    }
  }
  return { e, p };
}
