import type { El, GridMode, Point } from "../types";
import { CollabDoc, MAX_POINTS, type Props } from "./doc";
import { cleanName, colorFor, randomId } from "./protocol";
import { CollabSession, webrtcSupported } from "./session";
import { relaySupported } from "./relay";
import { buildInviteUrl, decodeInvite, encodeRoomInvite, type AnyInvite } from "./signaling";
import { OFF_UI, type Batch, type CollabSaved, type CollabUI, type Msg } from "./types";

/** Ciò che il motore deve offrire al livello di collaborazione. */
export interface CollabHost {
  getElements(): El[];
  getProps(): Props;
  getBoardName(): string;
  getPresence(): { cursor: Point | null; draft: El | null };
  /** true durante un trascinamento/ridimensionamento locale: gli aggiornamenti remoti si rimandano. */
  isBusy(): boolean;
  /** Applica lo stato remoto al documento locale (senza history e senza rimandarlo in rete). */
  setRemoteState(next: { elements?: El[]; bgColor?: string; grid?: GridMode; first?: boolean }): void;
  invalidate(): void;
  emit(): void;
  persist(): void;
}

export interface RemoteView {
  site: string;
  name: string;
  color: string;
  cursor: { x: number; y: number; t: number } | null;
  draft: El | null;
}

type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

const PREFS_KEY = "whiteboard:collab";
const PRESENCE_MS = 40;
const BATCH_MAX = 400;
const r2 = (v: number) => Math.round(v * 100) / 100;

function chunkBatch(b: Batch): Batch[] {
  if (b.e.length <= BATCH_MAX) return [b];
  const out: Batch[] = [];
  for (let i = 0; i < b.e.length; i += BATCH_MAX) out.push({ e: b.e.slice(i, i + BATCH_MAX), p: i === 0 ? b.p : undefined });
  return out;
}

export class Collab {
  doc: CollabDoc | null = null;
  ui: CollabUI = OFF_UI;

  private session: CollabSession | null = null;
  private name = "";
  private stun = true;
  private relay = true;
  private pending = new Set<string>();
  private pendingProps = false;
  private synced = false;
  private remotes = new Map<string, RemoteView>();
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCursor = "";
  private draftSent: { id: string; n: number } | null = null;
  private draftKey = "";

  constructor(private host: CollabHost) {}

  /** Numero di batch remoti applicati finora (usato per marcare gli snapshot di undo/redo). */
  get seq(): number {
    return this.doc?.seq ?? 0;
  }

  get active(): boolean {
    return this.doc !== null;
  }

  /** Da chiamare solo nel browser. */
  init(): void {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (raw) {
        const d: unknown = JSON.parse(raw);
        if (typeof d === "object" && d !== null) {
          const o = d as { name?: unknown; stun?: unknown; relay?: unknown };
          if (typeof o.name === "string") this.name = cleanName(o.name, "");
          if (typeof o.stun === "boolean") this.stun = o.stun;
          if (typeof o.relay === "boolean") this.relay = o.relay;
        }
      }
    } catch {
      /* preferenze non disponibili */
    }
    this.refreshUI();
  }

  /* ---------------------------------------------------------------------
   * Ciclo di vita
   * ------------------------------------------------------------------- */

  /** La lavagna corrente è cambiata: chiude la sessione precedente e (se c'è) riprende lo stato salvato. */
  load(saved: CollabSaved | undefined, elements: El[]): void {
    this.teardown();
    if (saved) this.doc = CollabDoc.restore(saved, elements);
    // con il relay si rientra nella stanza da soli (ricaricamento, pagina sospesa e riaperta dal telefono…)
    if (this.doc && this.relay && webrtcSupported() && relaySupported()) this.ensureSession();
    this.refreshUI();
  }

  save(): CollabSaved | undefined {
    return this.doc?.save();
  }

  private teardown(): void {
    this.session?.leave();
    this.session = null;
    this.doc = null;
    this.pending.clear();
    this.pendingProps = false;
    this.synced = false;
    this.remotes.clear();
    this.lastCursor = "";
    this.draftSent = null;
    this.draftKey = "";
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
  }

  /** La lavagna corrente diventa collaborativa: chi la avvia ne è l'host. */
  startHost(name: string): Result {
    if (!webrtcSupported()) return { ok: false, error: "Questo browser non supporta WebRTC" };
    if (this.doc) return { ok: true };
    this.setName(name);
    const doc = new CollabDoc(randomId(16), randomId(), "host");
    this.doc = doc;
    doc.local(this.host.getElements(), this.host.getProps(), undefined, true);
    this.synced = true;
    this.ensureSession();
    this.host.persist();
    this.refreshUI();
    return { ok: true };
  }

  /**
   * Lavagna nuova e vuota che si unirà a una stanza: l'ospite parte senza contenuto né metadati.
   * Con un invito manuale ritorna il codice di risposta da mandare all'host; con il link della stanza
   * (`answer: null`) il collegamento passa dal relay e parte da solo.
   */
  async beginGuest(inv: AnyInvite, name: string): Promise<Result<{ answer: string | null }>> {
    if (!webrtcSupported()) return { ok: false, error: "Questo browser non supporta WebRTC" };
    if (inv.kind === "room" && !relaySupported()) return { ok: false, error: "Questo browser non supporta il collegamento automatico" };
    this.setName(name);
    this.doc = new CollabDoc(inv.room, randomId(), "guest");
    return this.answer(inv, true);
  }

  /** Riconnessione a una stanza di cui questa lavagna fa già parte (stessa identità, stesso storico). */
  async resume(inv: AnyInvite, name: string): Promise<Result<{ answer: string | null }>> {
    this.setName(name);
    return this.answer(inv, false);
  }

  private async answer(inv: AnyInvite, fresh: boolean): Promise<Result<{ answer: string | null }>> {
    if (inv.kind === "room") {
      // il link della stanza funziona solo attraverso il relay: chi lo apre lo vuole usare
      if (!this.relay) this.setRelay(true);
      this.ensureSession();
      this.session?.setRelay(true);
      this.host.persist();
      this.refreshUI();
      return { ok: true, answer: null };
    }
    this.ensureSession();
    try {
      const answer = await (this.session as CollabSession).answerInvite(inv);
      this.host.persist();
      this.refreshUI();
      return { ok: true, answer };
    } catch {
      if (fresh) this.teardown();
      this.refreshUI();
      return { ok: false, error: "Impossibile elaborare l'invito" };
    }
  }

  /** Chiusura della pagina: avvisa i peer subito, senza aspettare che se ne accorgano. */
  farewell(): void {
    this.session?.send({ t: "bye" });
  }

  /** Esce dalla collaborazione: la lavagna resta, normale, nel browser. */
  stop(): void {
    this.teardown();
    this.host.invalidate();
    this.host.persist();
    this.refreshUI();
  }

  async createInvite(): Promise<Result<{ id: string; code: string; url: string }>> {
    if (!this.doc) return { ok: false, error: "La collaborazione non è attiva" };
    this.ensureSession();
    try {
      return { ok: true, ...(await (this.session as CollabSession).createInvite(this.host.getBoardName())) };
    } catch {
      return { ok: false, error: "Impossibile creare l'invito" };
    }
  }

  async acceptAnswer(text: string): Promise<Result> {
    if (!this.session) return { ok: false, error: "La collaborazione non è attiva" };
    try {
      await this.session.acceptAnswer(text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error && e.name === "Error" ? e.message : "Risposta non valida o scaduta" };
    }
  }

  /** Link della stanza (riutilizzabile, per il collegamento automatico via relay). */
  async roomLink(): Promise<Result<{ url: string }>> {
    const doc = this.doc;
    if (!doc) return { ok: false, error: "La collaborazione non è attiva" };
    try {
      const code = await encodeRoomInvite({ room: doc.room, n: this.effectiveName(), b: this.host.getBoardName() });
      return { ok: true, url: buildInviteUrl(code) };
    } catch {
      return { ok: false, error: "Impossibile creare il link" };
    }
  }

  static async parseInvite(text: string): Promise<AnyInvite | null> {
    return decodeInvite(text);
  }

  setName(name: string): void {
    this.name = cleanName(name, "");
    if (this.session) this.session.opts.name = this.effectiveName();
    this.savePrefs();
    this.refreshUI();
  }

  setStun(stun: boolean): void {
    this.stun = stun;
    if (this.session) this.session.opts.stun = stun;
    this.savePrefs();
    this.refreshUI();
  }

  setRelay(relay: boolean): void {
    this.relay = relay;
    if (relay && this.doc) this.ensureSession();
    this.session?.setRelay(relay);
    this.savePrefs();
    this.refreshUI();
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ name: this.name, stun: this.stun, relay: this.relay }));
    } catch {
      /* non critico */
    }
  }

  private effectiveName(): string {
    return cleanName(this.name, "Ospite");
  }

  private ensureSession(): void {
    const doc = this.doc;
    if (!doc || this.session) return;
    this.session = new CollabSession(
      { room: doc.room, site: doc.site, name: this.effectiveName(), stun: this.stun, relay: this.relay && relaySupported() },
      {
        onPeerOpen: (peer) => {
          this.remotes.set(peer.site, { site: peer.site, name: peer.name, color: peer.color, cursor: null, draft: null });
          // ognuno manda il proprio stato completo: il merge è idempotente
          for (const b of doc.snapshot()) this.session?.sendTo(peer.site, { t: "ops", b });
          this.refreshUI();
        },
        onPeerClose: (site) => {
          this.remotes.delete(site);
          this.host.invalidate();
          this.refreshUI();
        },
        onMessage: (msg, from) => this.onMessage(msg, from),
        onChange: () => this.refreshUI(),
      },
    );
  }

  /* ---------------------------------------------------------------------
   * Modifiche
   * ------------------------------------------------------------------- */

  /** Il documento locale è cambiato: confronta con lo stato noto e invia le differenze. */
  localChanged(): void {
    const doc = this.doc;
    if (!doc) return;
    const b = doc.local(this.host.getElements(), this.host.getProps(), this.pending.size ? this.pending : undefined);
    if (b && this.session) for (const part of chunkBatch(b)) this.session.send({ t: "ops", b: part });
  }

  /** Per undo/redo: ripristina lo snapshot senza cancellare il lavoro altrui. */
  rebase(prev: El[], snapSeq: number, current: El[]): El[] {
    return this.doc ? this.doc.rebase(prev, snapSeq, current) : prev;
  }

  /** Applica al motore gli aggiornamenti remoti accumulati, se non c'è una gesture in corso. */
  flush(): void {
    if (this.host.isBusy()) return;
    const doc = this.doc;
    if (!doc || (this.pending.size === 0 && !this.pendingProps)) return;
    let elements: El[] | undefined;
    if (this.pending.size) {
      elements = this.pending.size > 64 ? doc.materialize() : doc.patch(this.host.getElements(), this.pending);
    }
    let bgColor: string | undefined;
    let grid: GridMode | undefined;
    if (this.pendingProps) {
      const p = doc.currentProps();
      bgColor = p.bgColor;
      grid = p.grid;
    }
    this.pending = new Set();
    this.pendingProps = false;
    const first = !this.synced && doc.mode === "guest" && !!elements?.length;
    if (elements?.length || this.synced === false) this.synced = true;
    this.host.setRemoteState({ elements, bgColor, grid, first });
  }

  private onMessage(msg: Msg, from: string): void {
    const doc = this.doc;
    if (!doc) return;
    const rv = this.remotes.get(from);
    switch (msg.t) {
      case "ops": {
        const r = doc.apply(msg.b);
        if (r.forward) for (const part of chunkBatch(r.forward)) this.session?.send({ t: "ops", b: part }, from);
        if (r.changed.size || r.props) {
          for (const id of r.changed) {
            this.pending.add(id);
            for (const v of this.remotes.values()) if (v.draft?.id === id) v.draft = null;
          }
          if (r.props) this.pendingProps = true;
          this.flush();
        }
        return;
      }
      case "cur":
        if (!rv) return;
        rv.cursor = msg.x === null ? null : { x: msg.x, y: msg.y, t: Date.now() };
        this.host.invalidate();
        return;
      case "dp": {
        if (!rv) return;
        let d = rv.draft;
        if (!d || d.id !== msg.id || d.type !== "stroke") {
          if (msg.f !== 0) return;
          d = { id: msg.id, type: "stroke", color: msg.c, width: msg.w, points: [] };
          rv.draft = d;
        }
        if (d.type !== "stroke" || msg.f !== d.points.length || d.points.length + msg.p.length / 2 > MAX_POINTS) return;
        for (let i = 0; i < msg.p.length; i += 2) d.points.push({ x: msg.p[i], y: msg.p[i + 1] });
        this.host.invalidate();
        return;
      }
      case "dr":
        if (!rv) return;
        rv.draft = msg.el;
        this.host.invalidate();
        return;
      case "dend":
        if (rv?.draft?.id === msg.id) {
          rv.draft = null;
          this.host.invalidate();
        }
        return;
    }
  }

  /* ---------------------------------------------------------------------
   * Presenza: cursori e bozze in corso (effimeri, non entrano nel documento)
   * ------------------------------------------------------------------- */

  remote(): RemoteView[] {
    return [...this.remotes.values()];
  }

  /** Il motore segnala che cursore o bozza possono essere cambiati. */
  ping(): void {
    if (!this.session || this.presenceTimer || this.session.peerList.length === 0) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.flushPresence();
    }, PRESENCE_MS);
  }

  private flushPresence(): void {
    const s = this.session;
    if (!s) return;
    const { cursor, draft } = this.host.getPresence();

    const key = cursor ? `${cursor.x.toFixed(1)},${cursor.y.toFixed(1)}` : "";
    if (key !== this.lastCursor) {
      this.lastCursor = key;
      s.send(cursor ? { t: "cur", x: r2(cursor.x), y: r2(cursor.y) } : { t: "cur", x: null, y: 0 });
    }

    const sent = this.draftSent;
    if (!draft || draft.type === "text") {
      if (sent) s.send({ t: "dend", id: sent.id });
      this.draftSent = null;
      this.draftKey = "";
      return;
    }
    if (sent && sent.id !== draft.id) s.send({ t: "dend", id: sent.id });
    if (draft.type === "stroke") {
      const from = sent && sent.id === draft.id ? sent.n : 0;
      if (draft.points.length > from) {
        const part = draft.points.slice(from, from + 1000);
        s.send({ t: "dp", id: draft.id, c: draft.color, w: draft.width, f: from, p: part.flatMap((p) => [r2(p.x), r2(p.y)]) });
        this.draftSent = { id: draft.id, n: from + part.length };
        if (this.draftSent.n < draft.points.length) this.ping();
      }
    } else {
      const k = JSON.stringify(draft);
      if (k !== this.draftKey) {
        this.draftKey = k;
        s.send({ t: "dr", el: draft });
      }
      this.draftSent = { id: draft.id, n: 0 };
    }
  }

  /* ---------------------------------------------------------------------
   * Stato per la UI
   * ------------------------------------------------------------------- */

  private refreshUI(): void {
    const d = this.doc;
    const next: CollabUI = {
      mode: d ? d.mode : "off",
      room: d?.room ?? "",
      peers: this.session?.peerList ?? [],
      name: this.name,
      stun: this.stun,
      relay: this.relay,
      relayState: this.session?.relayState ?? "off",
      site: d?.site ?? "",
      color: d ? colorFor(d.site) : OFF_UI.color,
    };
    const p = this.ui;
    const same =
      p.mode === next.mode &&
      p.room === next.room &&
      p.name === next.name &&
      p.stun === next.stun &&
      p.relay === next.relay &&
      p.relayState === next.relayState &&
      p.site === next.site &&
      p.peers.length === next.peers.length &&
      p.peers.every((x, i) => x.site === next.peers[i].site && x.name === next.peers[i].name);
    if (same) return;
    this.ui = next;
    this.host.emit();
  }
}
