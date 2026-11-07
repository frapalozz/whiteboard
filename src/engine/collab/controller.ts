import type { El, GridMode, Point, Rect } from "../types";
import { accessOf, aclText, MAX_OVERRIDES, type Access, type Acl, type SignedAcl } from "./acl";
import { authSupported, loadIdentity, newIdentity, sign, siteFor, verify, type Identity, type IdentitySaved } from "./auth";
import { CollabDoc, MAX_POINTS, type Props } from "./doc";
import { moveKey, type MovePreview } from "../preview";
import { assetArrived, getAsset, putVerifiedAsset } from "../assets";
import { ASSET_PART } from "./protocol";
import { cleanName, colorFor, randomId } from "./protocol";
import { CollabSession, webrtcSupported } from "./session";
import { relaySupported } from "./relay";
import { buildInviteUrl, decodeInvite, encodeRoomInvite, type AnyInvite } from "./signaling";
import { OFF_UI, type Batch, type CollabSaved, type CollabUI, type Msg, type SecSaved } from "./types";

/** Ciò che il motore deve offrire al livello di collaborazione. */
export interface CollabHost {
  getElements(): El[];
  getProps(): Props;
  getBoardName(): string;
  /** `view`: area visibile in coordinate mondo (la segue chi ti segue). */
  getPresence(): { cursor: Point | null; draft: El | null; view: Rect | null; moving: MovePreview | null; laser: number[] | null };
  /** true durante un trascinamento/ridimensionamento locale: gli aggiornamenti remoti si rimandano. */
  isBusy(): boolean;
  /** Applica lo stato remoto al documento locale (senza history e senza rimandarlo in rete). */
  setRemoteState(next: { elements?: El[]; bgColor?: string; grid?: GridMode; pages?: number; first?: boolean }): void;
  /** Mostra l'area `view` (coordinate mondo) di chi si sta seguendo. */
  followView(view: Rect): void;
  /** I tuoi permessi sono cambiati (da modifica a sola lettura o viceversa). */
  accessChanged(): void;
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
  /** Elementi che sta trascinando in questo momento. */
  moving: MovePreview | null;
  /** Scia del puntatore laser (coordinate mondo, istante di arrivo). */
  laser: Array<{ x: number; y: number; t: number }>;
  /** Ultima area visibile annunciata (coordinate mondo). */
  view: Rect | null;
  /** Chiede di essere seguito. */
  leading: boolean;
}

type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };

const PREFS_KEY = "whiteboard:collab";
const PRESENCE_MS = 40;
const BATCH_MAX = 400;
const r2 = (v: number) => Math.round(v * 100) / 100;
const roundRect = (r: Rect): Rect => ({ x: r2(r.x), y: r2(r.y), w: r2(r.w), h: r2(r.h) });

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
  private lastMove = "";
  private lastView = "";
  /** Stai chiedendo a tutti di seguirti. */
  private leading = false;
  /** Sito del partecipante che stai seguendo. */
  private following: string | null = null;
  /** Permessi della stanza (null: stanza creata prima dei permessi, tutti modificano). */
  private sec: SecSaved | null = null;
  /** La tua identità nella stanza: la forma salvata e la chiave pronta per firmare. */
  private idSaved: IdentitySaved | null = null;
  private idP: Promise<Identity | null> = Promise.resolve(null);
  /** Solo il proprietario: chi ha chiesto di poter modificare. */
  private requests = new Set<string>();
  /** Hai chiesto di poter modificare. */
  private asked = false;
  /** I cambi di permessi si firmano uno alla volta (ognuno con la versione successiva). */
  private aclQueue: Promise<void> = Promise.resolve();

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
    if (saved) {
      this.doc = CollabDoc.restore(saved, elements);
      this.sec = saved.sec ?? null;
      this.setIdentity(saved.id ?? null);
    }
    // con il relay si rientra nella stanza da soli (ricaricamento, pagina sospesa e riaperta dal telefono…)
    if (this.doc && this.relay && webrtcSupported() && relaySupported()) this.ensureSession();
    this.refreshUI();
  }

  save(): CollabSaved | undefined {
    const d = this.doc?.save();
    return d && { ...d, sec: this.sec ?? undefined, id: this.idSaved ?? undefined };
  }

  private setIdentity(s: IdentitySaved | null, ready?: Identity): void {
    this.idSaved = s;
    this.idP = ready ? Promise.resolve(ready) : s && authSupported() ? loadIdentity(s).catch(() => null) : Promise.resolve(null);
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
    this.lastMove = "";
    this.lastView = "";
    this.leading = false;
    this.following = null;
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.presenceTimer = null;
    this.sec = null;
    this.setIdentity(null);
    this.requests.clear();
    this.asked = false;
  }

  /**
   * La lavagna corrente diventa collaborativa: chi la avvia ne è il proprietario e decide se chi entra
   * può modificare (`def`). I permessi si possono cambiare in qualsiasi momento, anche per singola persona.
   */
  async startHost(name: string, def: Access = "edit"): Promise<Result> {
    if (!webrtcSupported()) return { ok: false, error: "Questo browser non supporta WebRTC" };
    if (!authSupported()) return { ok: false, error: "Questo browser non supporta la crittografia necessaria (serve HTTPS)" };
    if (this.doc) return { ok: true };
    this.setName(name);
    const { id, saved } = await newIdentity();
    const room = randomId(16);
    const acl: Acl = { v: 1, def, ov: {} };
    const sig = await sign(id, aclText(room, acl));
    if (this.doc) return { ok: true };
    const doc = new CollabDoc(room, id.site, "host");
    this.doc = doc;
    this.sec = { hk: id.pk, hs: id.site, acl: { acl, sig } };
    this.setIdentity(saved, id);
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
    const sec = await this.secFromInvite(inv);
    if (sec === false) return { ok: false, error: "Invito non valido: i permessi non sono firmati dal proprietario" };
    let site = randomId();
    if (authSupported()) {
      const { id, saved } = await newIdentity();
      this.setIdentity(saved, id);
      site = id.site;
    }
    this.doc = new CollabDoc(inv.room, site, "guest");
    this.sec = sec;
    return this.answer(inv, true);
  }

  /** Permessi contenuti nell'invito: null se la stanza non li ha, false se la firma non torna. */
  private async secFromInvite(inv: AnyInvite): Promise<SecSaved | null | false> {
    if (!inv.k || !inv.a) return null;
    if (!authSupported() || !(await verify(inv.k, aclText(inv.room, inv.a.acl), inv.a.sig))) return false;
    return { hk: inv.k, hs: await siteFor(inv.k), acl: inv.a };
  }

  /** Riconnessione a una stanza di cui questa lavagna fa già parte (stessa identità, stesso storico). */
  async resume(inv: AnyInvite, name: string): Promise<Result<{ answer: string | null }>> {
    this.setName(name);
    // un invito più recente può portare permessi più nuovi di quelli salvati
    const sec = await this.secFromInvite(inv);
    const cur = this.sec;
    if (sec && cur && sec.hk === cur.hk && sec.acl.acl.v > cur.acl.acl.v) {
      this.sec = { ...cur, acl: sec.acl };
      this.accessChanged();
    }
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
      const sec = this.sec ? { k: this.sec.hk, a: this.sec.acl } : undefined;
      return { ok: true, ...(await (this.session as CollabSession).createInvite(this.host.getBoardName(), sec)) };
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
      const sec = this.sec ? { k: this.sec.hk, a: this.sec.acl } : {};
      const code = await encodeRoomInvite({ room: doc.room, n: this.effectiveName(), b: this.host.getBoardName(), ...sec });
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
      {
        room: doc.room,
        site: doc.site,
        name: this.effectiveName(),
        stun: this.stun,
        relay: this.relay && relaySupported(),
        auth: this.idSaved
          ? {
              pk: this.idSaved.pk,
              sign: async (text) => {
                const id = await this.idP;
                if (!id) throw new Error("identità non disponibile");
                return sign(id, text);
              },
            }
          : null,
      },
      {
        onPeerOpen: (peer) => {
          this.remotes.set(peer.site, { site: peer.site, name: peer.name, color: peer.color, cursor: null, draft: null, moving: null, laser: [], view: null, leading: false });
          // ognuno manda il proprio stato completo: il merge è idempotente
          for (const b of doc.snapshot()) this.session?.sendTo(peer.site, { t: "ops", b });
          // chi arriva a lezione iniziata sa subito chi seguire e cosa sta guardando
          const view = this.host.getPresence().view;
          if (view) this.session?.sendTo(peer.site, { t: "vw", ...roundRect(view) });
          if (this.leading) this.session?.sendTo(peer.site, { t: "lead", on: true });
          // i permessi più recenti che conosciamo, e la nostra richiesta se arriva il proprietario
          if (this.sec) this.session?.sendTo(peer.site, { t: "acl", a: this.sec.acl });
          if (this.asked && peer.site === this.sec?.hs) this.session?.sendTo(peer.site, { t: "ask", on: true });
          // immagini che ci mancano: magari le ha chi è appena arrivato
          for (const id of this.wanted) this.session?.sendTo(peer.site, { t: "ag", id });
          this.refreshUI();
        },
        onPeerClose: (site) => {
          this.remotes.delete(site);
          this.requests.delete(site);
          if (this.following === site) this.following = null;
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
    // in sola lettura non si manda nulla, e ciò che è cambiato in locale torna com'era
    if (!this.canEditSelf) return this.revert();
    let props = this.host.getProps();
    // proprietà remote non ancora applicate al motore (gesture in corso): valgono quelle del documento,
    // altrimenti i valori vecchi del motore sovrascriverebbero quelli appena arrivati
    if (this.pendingProps) {
      const cur = doc.currentProps();
      props = {
        bgColor: cur.bgColor ?? props.bgColor,
        grid: cur.grid ?? props.grid,
        pages: cur.pages ?? props.pages,
      };
    }
    const b = doc.local(this.host.getElements(), props, this.pending.size ? this.pending : undefined);
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
    let pages: number | undefined;
    if (this.pendingProps) {
      const p = doc.currentProps();
      bgColor = p.bgColor;
      grid = p.grid;
      pages = p.pages;
    }
    this.pending = new Set();
    this.pendingProps = false;
    const first = !this.synced && doc.mode === "guest" && !!elements?.length;
    if (elements?.length || this.synced === false) this.synced = true;
    this.host.setRemoteState({ elements, bgColor, grid, pages, first });
  }

  private onMessage(msg: Msg, from: string): void {
    const doc = this.doc;
    if (!doc) return;
    const rv = this.remotes.get(from);
    switch (msg.t) {
      case "ops": {
        // modifiche (anche inoltrate) solo da chi può modificare e ha dimostrato chi è
        if (!this.trusted(from)) return;
        const r = doc.apply(msg.b);
        // le modifiche finali di un trascinamento sostituiscono la sua anteprima (non va applicata due volte)
        for (const v of this.remotes.values()) {
          const mv = v.moving;
          if (!mv) continue;
          const ids = new Set(mv.ids);
          if (msg.b.e.some((w) => w.s === v.site && ids.has(w.id))) v.moving = null;
        }
        // chi è in sola lettura non inoltra: gli altri non accetterebbero comunque le sue modifiche
        if (r.forward && this.canEditSelf) for (const part of chunkBatch(r.forward)) this.session?.send({ t: "ops", b: part }, from);
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
        if (!rv || !this.trusted(from)) return;
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
        if (!rv || !this.trusted(from)) return;
        rv.draft = msg.el;
        this.host.invalidate();
        return;
      case "ag":
        void this.serveAsset(msg.id, from);
        return;
      case "ad":
        void this.receiveAsset(msg, from);
        return;
      case "lz": {
        if (!rv) return;
        const now = performance.now();
        for (let i = 0; i + 1 < msg.p.length; i += 2) rv.laser.push({ x: msg.p[i], y: msg.p[i + 1], t: now });
        if (rv.laser.length > 600) rv.laser.splice(0, rv.laser.length - 600);
        this.host.invalidate();
        return;
      }
      case "mv":
        if (!rv) return;
        if (msg.ids.length === 0) rv.moving = null;
        else if (!this.trusted(from)) return;
        else rv.moving = msg.el ? { ids: msg.ids, el: msg.el } : { ids: msg.ids, m: msg.m ?? [0, 0] };
        this.host.invalidate();
        return;
      case "dend":
        if (rv?.draft?.id === msg.id) {
          rv.draft = null;
          this.host.invalidate();
        }
        return;
      case "vw":
        if (!rv) return;
        rv.view = { x: msg.x, y: msg.y, w: msg.w, h: msg.h };
        if (this.following === from) this.host.followView(rv.view);
        return;
      case "acl":
        void this.onAcl(msg.a, from);
        return;
      case "ask":
        if (!this.isOwner || this.canEdit(from)) return;
        if (msg.on) this.requests.add(from);
        else this.requests.delete(from);
        this.refreshUI();
        return;
      case "lead":
        // farsi seguire da tutti è di chi conduce: non di chi può solo guardare
        if (!rv || rv.leading === msg.on || (msg.on && !this.trusted(from))) return;
        rv.leading = msg.on;
        if (msg.on && !this.leading) this.follow(from);
        else if (!msg.on && this.following === from) this.following = null;
        this.refreshUI();
        return;
    }
  }

  /* ---------------------------------------------------------------------
   * File delle immagini: si chiedono a chi li ha e arrivano a pezzi, una volta sola
   * ------------------------------------------------------------------- */

  /** Immagini usate nella lavagna ma non presenti in questo browser. */
  private wanted = new Set<string>();
  private incoming = new Map<string, { from: string; m: string; n: number; parts: Array<string | undefined>; got: number; t: number }>();
  private serving = new Set<string>();

  wantAsset(id: string): void {
    if (this.wanted.has(id)) return;
    this.wanted.add(id);
    this.session?.send({ t: "ag", id });
  }

  private async serveAsset(id: string, to: string): Promise<void> {
    const key = `${to}|${id}`;
    if (this.serving.has(key)) return;
    const a = await getAsset(id);
    if (!a || !this.session) return;
    this.serving.add(key);
    try {
      const n = Math.max(1, Math.ceil(a.bytes.length / ASSET_PART));
      for (let i = 0; i < n; i++) {
        // un pezzo alla volta: modifiche e cursori continuano a passare
        while (this.session && this.session.queued(to) > 30) await new Promise((r) => setTimeout(r, 40));
        const s = this.session;
        if (!s || !s.peerList.some((p) => p.site === to)) return;
        const part = a.bytes.subarray(i * ASSET_PART, (i + 1) * ASSET_PART);
        let bin = "";
        for (let k = 0; k < part.length; k += 0x8000) bin += String.fromCharCode(...part.subarray(k, k + 0x8000));
        s.sendTo(to, { t: "ad", id, m: a.mime, i, n, d: btoa(bin) });
      }
    } finally {
      this.serving.delete(key);
    }
  }

  private async receiveAsset(msg: Extract<Msg, { t: "ad" }>, from: string): Promise<void> {
    if (!this.wanted.has(msg.id)) return;
    let inc = this.incoming.get(msg.id);
    // si accetta un file da un solo mittente alla volta (gli altri doppioni si ignorano)
    if (inc && inc.from !== from && Date.now() - inc.t < 20_000) return;
    if (!inc || inc.from !== from || inc.n !== msg.n) {
      inc = { from, m: msg.m, n: msg.n, parts: new Array(msg.n), got: 0, t: Date.now() };
      this.incoming.set(msg.id, inc);
    }
    if (inc.parts[msg.i] === undefined) {
      inc.parts[msg.i] = msg.d;
      inc.got++;
    }
    inc.t = Date.now();
    if (inc.got < inc.n) return;
    this.incoming.delete(msg.id);
    let bin = "";
    try {
      for (const p of inc.parts) bin += atob(p ?? "");
    } catch {
      return;
    }
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    // vale solo se il contenuto corrisponde all'id (hash): nessuno può spacciare un'immagine per un'altra
    if (!(await putVerifiedAsset(msg.id, bytes, inc.m))) return;
    this.wanted.delete(msg.id);
    assetArrived(msg.id);
    this.host.invalidate();
  }

  /* ---------------------------------------------------------------------
   * Permessi: chi può modificare e chi può solo guardare
   * ------------------------------------------------------------------- */

  /** `site` può modificare? (Stanza senza permessi: tutti.) */
  canEdit(site: string): boolean {
    return !this.sec || accessOf(this.sec.acl.acl, this.sec.hs, site) === "edit";
  }

  /** Puoi modificare la lavagna (fuori dalla collaborazione: sempre). */
  get canEditSelf(): boolean {
    return !this.doc || this.canEdit(this.doc.site);
  }

  /** Sei il proprietario della stanza: solo tu firmi i permessi. */
  private get isOwner(): boolean {
    return !!this.sec && !!this.doc && !!this.idSaved && this.doc.site === this.sec.hs;
  }

  /** Da `from` si accettano modifiche (sue o inoltrate): può modificare e ha dimostrato la sua identità. */
  private trusted(from: string): boolean {
    if (!this.sec) return true;
    return this.canEdit(from) && !!this.session?.isAuthed(from);
  }

  /** Permessi arrivati da un partecipante: valgono se firmati dal proprietario e più recenti dei nostri. */
  private async onAcl(a: SignedAcl, from: string): Promise<void> {
    const sec = this.sec;
    const doc = this.doc;
    if (!sec || !doc || a.acl.v <= sec.acl.acl.v) return;
    if (!(await verify(sec.hk, aclText(doc.room, a.acl), a.sig))) return;
    const cur = this.sec;
    if (!cur || cur.hk !== sec.hk || this.doc !== doc || a.acl.v <= cur.acl.acl.v) return;
    this.sec = { ...cur, acl: a };
    this.session?.send({ t: "acl", a }, from);
    this.accessChanged();
  }

  private accessChanged(): void {
    for (const s of [...this.requests]) if (this.canEdit(s)) this.requests.delete(s);
    if (this.canEditSelf) this.asked = false;
    this.host.accessChanged();
    if (!this.canEditSelf) this.revert();
    this.host.persist();
    this.refreshUI();
  }

  /** Riporta la lavagna allo stato condiviso (in sola lettura nessuna modifica locale resta). */
  private revert(): void {
    const doc = this.doc;
    if (!doc) return;
    const p = doc.currentProps();
    this.pending.clear();
    this.pendingProps = false;
    this.host.setRemoteState({ elements: doc.materialize(), bgColor: p.bgColor, grid: p.grid, pages: p.pages });
  }

  /** Proprietario: chi entra senza un permesso personale può modificare o solo guardare. */
  setDefaultAccess(def: Access): Promise<void> {
    return this.updateAcl((a) => ({ ...a, def }));
  }

  /** Proprietario: dà o toglie a una persona la possibilità di modificare. */
  setAccess(site: string, access: Access): Promise<void> {
    if (this.sec && site === this.sec.hs) return Promise.resolve();
    return this.updateAcl((a) => ({ ...a, ov: { ...a.ov, [site]: access } }));
  }

  private updateAcl(change: (a: Acl) => Acl): Promise<void> {
    this.aclQueue = this.aclQueue
      .then(async () => {
        const sec = this.sec;
        const doc = this.doc;
        if (!sec || !doc || !this.isOwner) return;
        const id = await this.idP;
        if (!id) return;
        const cur = sec.acl.acl;
        const want = change(cur);
        let ov = want.ov;
        if (Object.keys(ov).length > MAX_OVERRIDES) {
          // si tolgono prima i permessi personali uguali a quello di tutti (non cambiano nulla)
          ov = Object.fromEntries(Object.entries(ov).filter(([, v]) => v !== want.def));
          if (Object.keys(ov).length > MAX_OVERRIDES) return;
        }
        const next: Acl = { v: cur.v + 1, def: want.def, ov };
        const sig = await sign(id, aclText(doc.room, next));
        if (this.sec !== sec) return;
        this.sec = { ...sec, acl: { acl: next, sig } };
        this.session?.send({ t: "acl", a: this.sec.acl });
        this.accessChanged();
      })
      .catch(() => {});
    return this.aclQueue;
  }

  /** In sola lettura: chiedi al proprietario di poter modificare. */
  askAccess(): void {
    if (!this.doc || !this.sec || this.canEditSelf || this.asked) return;
    this.asked = true;
    this.session?.send({ t: "ask", on: true });
    this.refreshUI();
  }

  /** Proprietario: ignora una richiesta (la persona resta in sola lettura). */
  dismissRequest(site: string): void {
    if (this.requests.delete(site)) this.refreshUI();
  }

  /* ---------------------------------------------------------------------
   * Segui la vista di un altro partecipante (modalità lezione)
   * ------------------------------------------------------------------- */

  /** Inizia a seguire la vista di `site` (null: smetti). */
  follow(site: string | null): void {
    const rv = site ? this.remotes.get(site) : undefined;
    this.following = rv ? rv.site : null;
    if (rv?.view) this.host.followView(rv.view);
    this.refreshUI();
  }

  /** L'utente ha mosso la vista da solo: smette di seguire. */
  unfollow(): void {
    if (!this.following) return;
    this.following = null;
    this.refreshUI();
  }

  get isFollowing(): boolean {
    return this.following !== null;
  }

  /** Chiede a tutti i partecipanti di seguire la tua vista (o smette di chiederlo). */
  setLeading(on: boolean): void {
    if (!this.doc || this.leading === on) return;
    this.leading = on;
    if (on) {
      this.following = null;
      // la vista va mandata subito, non al prossimo movimento
      this.lastView = "";
      this.ping();
    }
    this.session?.send({ t: "lead", on });
    this.refreshUI();
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
    const { cursor, draft, view, moving, laser } = this.host.getPresence();
    if (laser) s.send({ t: "lz", p: laser });

    // trascinamento: la fine parte dopo le modifiche vere (mandate subito al rilascio), così chi guarda non
    // vede l'elemento tornare indietro per un attimo
    const mk = moveKey(moving);
    if (mk !== this.lastMove) {
      this.lastMove = mk;
      s.send(moving ? { t: "mv", ...moving } : { t: "mv", ids: [] });
    }

    if (view) {
      const r = roundRect(view);
      const vk = `${r.x},${r.y},${r.w},${r.h}`;
      if (vk !== this.lastView) {
        this.lastView = vk;
        s.send({ t: "vw", ...r });
      }
    }

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
    const peers = this.session?.peerList ?? [];
    const next: CollabUI = {
      mode: d ? d.mode : "off",
      room: d?.room ?? "",
      peers,
      name: this.name,
      stun: this.stun,
      relay: this.relay,
      relayState: this.session?.relayState ?? "off",
      site: d?.site ?? "",
      color: d ? colorFor(d.site) : OFF_UI.color,
      leading: this.leading,
      following: this.following,
      leaders: [...this.remotes.values()].filter((r) => r.leading).map((r) => r.site),
      secured: !!this.sec,
      owner: this.isOwner,
      ownerSite: this.sec?.hs ?? "",
      canEdit: this.canEditSelf,
      defaultAccess: this.sec?.acl.acl.def ?? null,
      editors: peers.filter((p) => this.canEdit(p.site) && (!this.sec || p.authed)).map((p) => p.site),
      requests: [...this.requests].filter((r) => peers.some((p) => p.site === r)),
      asked: this.asked,
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
      p.leading === next.leading &&
      p.following === next.following &&
      p.leaders.join() === next.leaders.join() &&
      p.secured === next.secured &&
      p.owner === next.owner &&
      p.ownerSite === next.ownerSite &&
      p.canEdit === next.canEdit &&
      p.defaultAccess === next.defaultAccess &&
      p.editors.join() === next.editors.join() &&
      p.requests.join() === next.requests.join() &&
      p.asked === next.asked &&
      p.peers.length === next.peers.length &&
      p.peers.every((x, i) => x.site === next.peers[i].site && x.name === next.peers[i].name && x.authed === next.peers[i].authed);
    if (same) return;
    this.ui = next;
    this.host.emit();
  }
}
