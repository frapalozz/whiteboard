import { colorFor, parseMsg, randomId, RX_FRAME_MAX, RX_MESSAGE_MAX, RX_PARTS_MAX, toFrames } from "./protocol";
import { Relay, relaySupported, type RelayMsg, type RelayState } from "./relay";
import { buildInviteUrl, decodeAnswer, encodeAnswer, encodeInvite, type Invite } from "./signaling";
import type { Msg, PeerInfo } from "./types";

/**
 * Trasporto P2P: una mesh completa di RTCPeerConnection, un canale dati affidabile per coppia.
 *
 * Le offerte/risposte viaggiano in tre modi:
 *   - attraverso il relay (relay.ts), se attivo: chi entra nella stanza si annuncia e si collega da solo,
 *     e chi torna sulla pagina dopo una pausa (telefono in background) si ricollega senza nuovi inviti;
 *   - con un invito manuale (signaling.ts): link + codice di risposta copiati a mano, senza alcun server;
 *   - attraverso i canali già aperti: chi entra riceve l'elenco dei partecipanti e negozia le connessioni
 *     mancanti tramite chi lo ha accolto.
 * Per evitare che due peer si chiamino a vicenda, è sempre quello con l'id maggiore a fare l'offerta.
 */

export interface SessionOpts {
  room: string;
  site: string;
  name: string;
  /** Usa un server STUN pubblico per attraversare i NAT (vede l'IP, mai i contenuti). */
  stun: boolean;
  /** Segnalazione automatica attraverso broker pubblici (vedi relay.ts). */
  relay: boolean;
}

export interface SessionEvents {
  onPeerOpen(peer: PeerInfo): void;
  onPeerClose(site: string): void;
  onMessage(msg: Msg, from: string): void;
  onChange(): void;
}

interface Rx {
  parts: string[];
  n: number;
  got: number;
  size: number;
}

interface Conn {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  site: string | null;
  info: PeerInfo | null;
  ready: boolean;
  /** Istante in cui il canale è diventato operativo. */
  since: number;
  closed: boolean;
  /** Nata da un invito manuale (codici copiati a mano). */
  manual: boolean;
  queue: string[];
  rx: Map<string, Rx>;
  timers: Set<ReturnType<typeof setTimeout>>;
}

/** Canale su cui passa la segnalazione: un peer già collegato o il relay. */
type Via = Conn | "relay";

const STUN = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }];
const MAX_INVITES = 6;
const HI_TIMEOUT = 15_000;
const LINK_TIMEOUT = 25_000;
/**
 * Dopo che l'host ha incollato la risposta, l'ospite può essere ancora in un'altra app (ha appena mandato
 * il codice): su telefono il browser in background è sospeso e il collegamento parte solo al suo ritorno.
 */
const MANUAL_LINK_TIMEOUT = 5 * 60_000;
const GUEST_WAIT = 20 * 60_000;
/** Annuncio periodico sul relay: ricuce le connessioni perse senza che nessuno faccia nulla. */
const ANNOUNCE_MS = 20_000;
/** Un canale aperto da meno di così non si considera "zombie" (l'altro può non averlo ancora registrato). */
const STALE_GRACE = 15_000;
const HIGH_WATER = 1 << 20;
const LOW_WATER = 1 << 18;

export function webrtcSupported(): boolean {
  return typeof RTCPeerConnection !== "undefined";
}

/** Attende la fine della raccolta dei candidati ICE (niente trickle: serve un'unica SDP completa). */
function gathered(pc: RTCPeerConnection, ms = 6000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      pc.removeEventListener("icegatheringstatechange", on);
      resolve();
    };
    const on = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const t = setTimeout(done, ms);
    pc.addEventListener("icegatheringstatechange", on);
  });
}

export class CollabSession {
  private conns = new Set<Conn>();
  private peers = new Map<string, Conn>();
  /** Connessioni in negoziazione verso un sito noto (via mesh). */
  private linking = new Map<string, Conn>();
  private invites = new Map<string, { conn: Conn; created: number }>();
  private bc: BroadcastChannel | null = null;
  private relay: Relay | null = null;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  /** Ultima risposta mirata a un annuncio, per sito (limita il traffico). */
  private replied = new Map<string, number>();
  relayState: RelayState | "off" = "off";
  private dead = false;
  /** Impostato se un peer ha rifiutato/è stato rifiutato per stanza diversa. */
  roomMismatch = false;

  constructor(
    readonly opts: SessionOpts,
    private ev: SessionEvents,
  ) {
    // Stesso browser (altra scheda): la risposta arriva da sola, senza copia-incolla.
    if (typeof BroadcastChannel !== "undefined") {
      this.bc = new BroadcastChannel("whiteboard-collab");
      this.bc.onmessage = (e: MessageEvent) => {
        const d: unknown = e.data;
        if (this.invites.size && typeof d === "object" && d !== null && typeof (d as { answer?: unknown }).answer === "string") {
          this.acceptAnswer((d as { answer: string }).answer).catch(() => {});
        }
      };
    }
    this.setRelay(opts.relay);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
    if (typeof window !== "undefined") window.addEventListener("online", this.onVisible);
  }

  /* ---------------------------------------------------------------------
   * Relay
   * ------------------------------------------------------------------- */

  setRelay(on: boolean): void {
    this.opts.relay = on;
    if (this.dead) return;
    if (on && !this.relay && relaySupported()) {
      this.relayState = "connecting";
      this.relay = new Relay(
        this.opts.room,
        (m) => this.onRelay(m),
        (s) => {
          const was = this.relayState;
          this.relayState = s;
          if (s === "on" && was !== "on") this.announceAll();
          if (s !== was) this.ev.onChange();
        },
      );
      this.announceTimer = setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState === "visible") this.announceAll();
      }, ANNOUNCE_MS);
    } else if (!on && this.relay) {
      this.relay.close();
      this.relay = null;
      if (this.announceTimer) clearInterval(this.announceTimer);
      this.announceTimer = null;
      this.relayState = "off";
    }
    this.ev.onChange();
  }

  /** Ritorno in primo piano (o in rete): i canali possono essere caduti nel frattempo, ci si riannuncia. */
  private onVisible = (): void => {
    if (this.dead || (typeof document !== "undefined" && document.visibilityState !== "visible")) return;
    this.relay?.wake();
    this.announceAll();
  };

  private announceAll(to?: string): void {
    if (!this.relay?.ready) return;
    void this.relay.send({ t: "here", from: this.opts.site, name: this.opts.name, peers: [...this.peers.keys()], to });
  }

  private onRelay(m: RelayMsg): void {
    if (this.dead || m.from === this.opts.site) return;
    if (m.t === "sig") {
      if (m.to === this.opts.site) this.onSignal({ t: "sig", from: m.from, to: m.to, k: m.k, sdp: m.sdp }, "relay");
      return;
    }
    if (m.to && m.to !== this.opts.site) return;
    const cur = this.peers.get(m.from);
    if (cur) {
      // l'altro non ci vede più (es. il telefono ha sospeso la pagina): il nostro canale è uno zombie
      if (m.peers.includes(this.opts.site) || Date.now() - cur.since < STALE_GRACE) return;
      this.drop(cur);
    }
    if (this.linking.has(m.from)) return;
    if (this.opts.site > m.from) {
      void this.initiate(m.from, "relay");
    } else if (!m.to) {
      // tocca all'altro fare l'offerta: gli diciamo che ci siamo
      const last = this.replied.get(m.from) ?? 0;
      if (Date.now() - last < 3000) return;
      this.replied.set(m.from, Date.now());
      this.announceAll(m.from);
    }
  }

  get peerList(): PeerInfo[] {
    return [...this.peers.values()].map((c) => c.info as PeerInfo);
  }

  get pendingInvites(): number {
    return this.invites.size;
  }

  /* ---------------------------------------------------------------------
   * Invito manuale (host) e risposta (ospite)
   * ------------------------------------------------------------------- */

  async createInvite(boardName: string): Promise<{ id: string; code: string; url: string }> {
    while (this.invites.size >= MAX_INVITES) {
      const [k, v] = this.invites.entries().next().value as [string, { conn: Conn }];
      this.invites.delete(k);
      this.drop(v.conn);
    }
    const c = this.makeConn();
    const id = randomId();
    this.invites.set(id, { conn: c, created: Date.now() });
    this.ev.onChange();
    try {
      this.attach(c, c.pc.createDataChannel("wb"));
      await c.pc.setLocalDescription(await c.pc.createOffer());
      await gathered(c.pc);
      const sdp = c.pc.localDescription?.sdp;
      if (!sdp) throw new Error("sdp");
      const code = await encodeInvite({ i: id, room: this.opts.room, s: this.opts.site, n: this.opts.name, b: boardName, sdp });
      return { id, code, url: buildInviteUrl(code) };
    } catch (e) {
      this.invites.delete(id);
      this.drop(c);
      throw e;
    }
  }

  /** L'host incolla la risposta dell'ospite: il canale si apre. */
  async acceptAnswer(text: string): Promise<void> {
    const a = await decodeAnswer(text);
    if (!a) throw new Error("Codice di risposta non valido");
    const inv = this.invites.get(a.i);
    if (!inv) throw new Error("Questo invito non è più valido: creane uno nuovo");
    const c = inv.conn;
    if (c.pc.signalingState !== "have-local-offer") throw new Error("Risposta già usata");
    await c.pc.setRemoteDescription({ type: "answer", sdp: a.sdp });
    this.invites.delete(a.i);
    c.manual = true;
    this.timeout(c, MANUAL_LINK_TIMEOUT);
    this.ev.onChange();
  }

  /** L'ospite elabora l'invito e produce il codice di risposta da mandare all'host. */
  async answerInvite(inv: Invite): Promise<string> {
    const c = this.makeConn();
    c.manual = true;
    c.pc.ondatachannel = (e) => this.attach(c, e.channel);
    try {
      await c.pc.setRemoteDescription({ type: "offer", sdp: inv.sdp });
      await c.pc.setLocalDescription(await c.pc.createAnswer());
      await gathered(c.pc);
      const sdp = c.pc.localDescription?.sdp;
      if (!sdp) throw new Error("sdp");
      const code = await encodeAnswer({ i: inv.i, s: this.opts.site, n: this.opts.name, sdp });
      this.bc?.postMessage({ answer: code });
      this.timeout(c, GUEST_WAIT);
      return code;
    } catch (e) {
      this.drop(c);
      throw e;
    }
  }

  /* ---------------------------------------------------------------------
   * Invio
   * ------------------------------------------------------------------- */

  send(msg: Msg, except?: string): void {
    for (const [site, c] of this.peers) if (site !== except) this.sendConn(c, msg);
  }

  sendTo(site: string, msg: Msg): void {
    const c = this.peers.get(site);
    if (c) this.sendConn(c, msg);
  }

  /** Chiude le connessioni. Il messaggio di congedo ha un attimo per partire. */
  leave(): void {
    if (this.dead) return;
    this.send({ t: "bye" });
    this.dead = true;
    this.bc?.close();
    this.bc = null;
    this.relay?.close();
    this.relay = null;
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
    if (typeof window !== "undefined") window.removeEventListener("online", this.onVisible);
    const all = [...this.conns];
    this.invites.clear();
    this.linking.clear();
    this.peers.clear();
    setTimeout(() => all.forEach((c) => this.closeConn(c)), 200);
  }

  private sendConn(c: Conn, msg: Msg): void {
    if (c.closed) return;
    // Presenza: se il peer è lento è meglio saltare un aggiornamento che accumulare ritardo.
    if ((msg.t === "cur" || msg.t === "dr") && c.queue.length > 40) return;
    for (const f of toFrames(msg)) c.queue.push(f);
    this.pump(c);
  }

  private pump(c: Conn): void {
    const dc = c.dc;
    if (!dc) return;
    while (c.queue.length && dc.readyState === "open" && dc.bufferedAmount < HIGH_WATER) {
      try {
        dc.send(c.queue.shift() as string);
      } catch {
        this.drop(c);
        return;
      }
    }
  }

  /* ---------------------------------------------------------------------
   * Connessioni
   * ------------------------------------------------------------------- */

  private makeConn(): Conn {
    const pc = new RTCPeerConnection({ iceServers: this.opts.stun ? STUN : [] });
    const c: Conn = { pc, dc: null, site: null, info: null, ready: false, since: 0, closed: false, manual: false, queue: [], rx: new Map(), timers: new Set() };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      // un invito manuale non ancora aperto resta in attesa: l'altro può essere momentaneamente in background
      // (il timeout dedicato lo chiuderà se non torna); per tutto il resto un errore chiude il canale
      if (s === "closed" || (s === "failed" && !(c.manual && !c.ready))) this.drop(c);
      else if (s === "disconnected") {
        const t = setTimeout(() => pc.connectionState === "disconnected" && this.drop(c), 8000);
        c.timers.add(t);
      }
    };
    this.conns.add(c);
    return c;
  }

  private timeout(c: Conn, ms: number): void {
    c.timers.add(setTimeout(() => !c.ready && this.drop(c), ms));
  }

  private attach(c: Conn, dc: RTCDataChannel): void {
    c.dc = dc;
    dc.bufferedAmountLowThreshold = LOW_WATER;
    const hello = () => {
      this.sendConn(c, { t: "hi", room: this.opts.room, site: this.opts.site, name: this.opts.name });
      this.timeout(c, HI_TIMEOUT);
    };
    dc.onopen = hello;
    dc.onmessage = (ev) => this.receive(c, ev.data);
    dc.onclose = () => this.drop(c);
    dc.onbufferedamountlow = () => this.pump(c);
    if (dc.readyState === "open") hello();
  }

  private closeConn(c: Conn): void {
    c.closed = true;
    c.timers.forEach(clearTimeout);
    c.timers.clear();
    c.pc.onconnectionstatechange = null;
    if (c.dc) {
      c.dc.onclose = null;
      c.dc.onmessage = null;
    }
    try {
      c.dc?.close();
      c.pc.close();
    } catch {
      /* già chiusa */
    }
    this.conns.delete(c);
  }

  private drop(c: Conn): void {
    if (c.closed) return;
    this.closeConn(c);
    if (this.dead) return;
    for (const [k, v] of this.linking) if (v === c) this.linking.delete(k);
    for (const [k, v] of this.invites) if (v.conn === c) this.invites.delete(k);
    if (c.site && this.peers.get(c.site) === c) {
      this.peers.delete(c.site);
      this.ev.onPeerClose(c.site);
      // magari è solo una pausa: chi è ancora qui si fa ritrovare
      setTimeout(() => this.announceAll(), 1500);
    }
    this.ev.onChange();
  }

  /* ---------------------------------------------------------------------
   * Ricezione
   * ------------------------------------------------------------------- */

  private receive(c: Conn, data: unknown): void {
    if (this.dead || c.closed) return;
    if (typeof data !== "string" || data.length > RX_FRAME_MAX) return this.drop(c);
    let obj: unknown;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof obj === "object" && obj !== null && typeof (obj as { ck?: unknown }).ck === "string") {
      const f = obj as { ck: string; i?: unknown; n?: unknown; d?: unknown };
      const { i, n, d } = f;
      if (typeof i !== "number" || typeof n !== "number" || typeof d !== "string") return;
      if (!Number.isInteger(i) || !Number.isInteger(n) || n < 2 || n > RX_PARTS_MAX || i < 0 || i >= n || f.ck.length > 40) return;
      let rx = c.rx.get(f.ck);
      if (!rx) {
        if (c.rx.size >= 4) return this.drop(c);
        rx = { parts: new Array<string>(n), n, got: 0, size: 0 };
        c.rx.set(f.ck, rx);
      }
      if (rx.n !== n || rx.parts[i] !== undefined) return;
      rx.parts[i] = d;
      rx.got++;
      rx.size += d.length;
      if (rx.size > RX_MESSAGE_MAX) return this.drop(c);
      if (rx.got === rx.n) {
        c.rx.delete(f.ck);
        try {
          this.handle(c, JSON.parse(rx.parts.join("")));
        } catch {
          /* messaggio non valido */
        }
      }
      return;
    }
    this.handle(c, obj);
  }

  private handle(c: Conn, raw: unknown): void {
    const msg = parseMsg(raw);
    if (!msg) return;
    if (!c.ready && msg.t !== "hi") return;

    switch (msg.t) {
      case "hi": {
        if (c.ready) return;
        if (msg.room !== this.opts.room) {
          this.roomMismatch = true;
          this.drop(c);
          return;
        }
        if (msg.site === this.opts.site) return this.drop(c);
        // un nuovo canale con chi risulta già collegato: quello vecchio è morto senza che ce ne accorgessimo
        const old = this.peers.get(msg.site);
        if (old) this.drop(old);
        c.site = msg.site;
        c.info = { site: msg.site, name: msg.name, color: colorFor(msg.site) };
        c.ready = true;
        c.since = Date.now();
        this.peers.set(msg.site, c);
        this.linking.delete(msg.site);
        this.ev.onPeerOpen(c.info);
        this.announce();
        this.ev.onChange();
        return;
      }
      case "peers":
        for (const p of msg.list) this.consider(p.site, c);
        return;
      case "sig":
        this.onSignal(msg, c);
        return;
      case "bye":
        this.drop(c);
        return;
      default:
        this.ev.onMessage(msg, c.site as string);
    }
  }

  /* ---------------------------------------------------------------------
   * Mesh: scoperta dei partecipanti e segnalazione attraverso i peer
   * ------------------------------------------------------------------- */

  /** Dice a ognuno chi altro è collegato a me, così che le connessioni mancanti si formino. */
  private announce(): void {
    for (const [site, c] of this.peers) {
      const list = [...this.peers.values()].filter((o) => o.site !== site).map((o) => ({ site: o.site as string, name: o.info?.name ?? "" }));
      this.sendConn(c, { t: "peers", list });
    }
  }

  private sendSig(via: Via, msg: Extract<Msg, { t: "sig" }>): void {
    if (via === "relay") void this.relay?.send(msg);
    else this.sendConn(via, msg);
  }

  private consider(site: string, via: Via): void {
    if (site === this.opts.site || this.peers.has(site) || this.linking.has(site)) return;
    if (this.opts.site > site) void this.initiate(site, via);
  }

  private async initiate(target: string, via: Via): Promise<void> {
    const c = this.makeConn();
    this.linking.set(target, c);
    try {
      this.attach(c, c.pc.createDataChannel("wb"));
      await c.pc.setLocalDescription(await c.pc.createOffer());
      await gathered(c.pc);
      const sdp = c.pc.localDescription?.sdp;
      if (!sdp || c.closed) return this.drop(c);
      this.sendSig(via, { t: "sig", from: this.opts.site, to: target, k: "offer", sdp });
      this.timeout(c, LINK_TIMEOUT);
    } catch {
      this.drop(c);
    }
  }

  private onSignal(msg: Extract<Msg, { t: "sig" }>, via: Via): void {
    if (msg.to !== this.opts.site) {
      if (via === "relay") return;
      // non è per me: lo inoltro se conosco il destinatario
      const next = this.peers.get(msg.to);
      if (next && next !== via) this.sendConn(next, msg);
      return;
    }
    if (msg.k === "offer") void this.onOffer(msg, via);
    else void this.onAnswer(msg);
  }

  private async onOffer(msg: Extract<Msg, { t: "sig" }>, via: Via): Promise<void> {
    const from = msg.from;
    if (from === this.opts.site || this.linking.has(from)) return;
    // chi offre non ci considera collegati: il canale che abbiamo con lui è uno zombie
    const old = this.peers.get(from);
    if (old) this.drop(old);
    const c = this.makeConn();
    this.linking.set(from, c);
    c.pc.ondatachannel = (e) => this.attach(c, e.channel);
    try {
      await c.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      await c.pc.setLocalDescription(await c.pc.createAnswer());
      await gathered(c.pc);
      const sdp = c.pc.localDescription?.sdp;
      if (!sdp || c.closed) return this.drop(c);
      this.sendSig(via, { t: "sig", from: this.opts.site, to: from, k: "answer", sdp });
      this.timeout(c, LINK_TIMEOUT);
    } catch {
      this.drop(c);
    }
  }

  private async onAnswer(msg: Extract<Msg, { t: "sig" }>): Promise<void> {
    const c = this.linking.get(msg.from);
    if (!c || c.pc.signalingState !== "have-local-offer") return;
    try {
      await c.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
    } catch {
      this.drop(c);
    }
  }
}
