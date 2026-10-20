import { randomId } from "./protocol";
import { isObj, isStr } from "./validate";

/**
 * Segnalazione automatica attraverso broker MQTT pubblici (WebSocket).
 *
 * Il broker fa solo da bacheca: chi è nella stanza vi pubblica "ci sono" e le offerte/risposte WebRTC per
 * gli altri. Tutto viaggia cifrato (AES-GCM) con una chiave derivata dall'id della stanza, che sta solo nel
 * link d'invito: il broker vede blob opachi su un topic anch'esso derivato dall'id, mai disegni né SDP.
 * I dati della lavagna continuano a passare solo sui canali P2P.
 *
 * Rispetto allo scambio manuale di codici, qui non serve che le due persone siano presenti nello stesso
 * istante a copiare e incollare: chi torna sulla pagina (es. dopo essere passato a un'altra app sul
 * telefono) si riannuncia e la connessione si riforma da sola.
 */

const BROKERS = ["wss://broker.emqx.io:8084/mqtt", "wss://broker.hivemq.com:8884/mqtt", "wss://test.mosquitto.org:8081/mqtt"];
const KEEPALIVE = 50;
const MAX_PAYLOAD = 64_000;
const RETRY_MIN = 2_000;
const RETRY_MAX = 30_000;

export type RelayState = "connecting" | "on" | "error";

export type RelayMsg =
  /** Presenza: chi sono e a chi sono collegato (serve a scoprire connessioni rimaste "zombie"). */
  | { t: "here"; from: string; name: string; peers: string[]; to?: string }
  | { t: "sig"; from: string; to: string; k: "offer" | "answer"; sdp: string };

function parseRelayMsg(raw: unknown): RelayMsg | null {
  if (!isObj(raw) || !isStr(raw.from, 40)) return null;
  if (raw.t === "here") {
    if (!Array.isArray(raw.peers) || raw.peers.length > 64) return null;
    return {
      t: "here",
      from: raw.from,
      name: typeof raw.name === "string" ? raw.name.slice(0, 24) : "",
      peers: raw.peers.filter((p): p is string => isStr(p, 40)),
      to: isStr(raw.to, 40) ? raw.to : undefined,
    };
  }
  if (raw.t === "sig") {
    if (!isStr(raw.to, 40) || (raw.k !== "offer" && raw.k !== "answer") || !isStr(raw.sdp, 100_000)) return null;
    return { t: "sig", from: raw.from, to: raw.to, k: raw.k, sdp: raw.sdp };
  }
  return null;
}

/* ------------------------------------------------------------------------
 * Cifratura
 * ---------------------------------------------------------------------- */

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function relaySupported(): boolean {
  return typeof WebSocket !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;
}

/* ------------------------------------------------------------------------
 * Client MQTT 3.1.1 minimo (solo QoS 0): CONNECT, SUBSCRIBE, PUBLISH, PINGREQ
 * ---------------------------------------------------------------------- */

const enc = new TextEncoder();

function varLen(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 128;
    out.push(b);
  } while (n > 0);
  return out;
}

function str(s: string): number[] {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 255, ...b];
}

function packet(type: number, body: ArrayLike<number>): Uint8Array {
  const head = [type, ...varLen(body.length)];
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

class Broker {
  private ws: WebSocket | null = null;
  private buf = new Uint8Array(0);
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private delay = RETRY_MIN;
  private closed = false;
  ready = false;

  constructor(
    private url: string,
    private topic: string,
    private onPayload: (p: Uint8Array) => void,
    private onState: () => void,
  ) {
    this.open();
  }

  /** Riapre subito se la connessione è caduta (es. al ritorno in primo piano sul telefono). */
  wake(): void {
    if (this.closed || this.ws) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.delay = RETRY_MIN;
    this.open();
  }

  publish(payload: Uint8Array): void {
    if (!this.ready || !this.ws) return;
    const body = [...str(this.topic), ...payload];
    try {
      this.ws.send(packet(0x30, body));
    } catch {
      this.fail();
    }
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.reset();
  }

  private open(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, "mqtt");
    } catch {
      return this.fail();
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      const id = "wb" + randomId(8);
      ws.send(packet(0x10, [...str("MQTT"), 4, 0x02, KEEPALIVE >> 8, KEEPALIVE & 255, ...str(id)]));
    };
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      const add = new Uint8Array(e.data);
      const next = new Uint8Array(this.buf.length + add.length);
      next.set(this.buf);
      next.set(add, this.buf.length);
      this.buf = next;
      this.parse();
    };
    ws.onclose = () => this.fail();
    ws.onerror = () => this.fail();
  }

  private parse(): void {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = 0;
      let mul = 1;
      let i = 1;
      for (;;) {
        if (i >= b.length) return;
        const d = b[i++];
        len += (d & 127) * mul;
        mul *= 128;
        if (!(d & 128)) break;
        if (i > 4) return this.fail();
      }
      if (len > MAX_PAYLOAD * 2) return this.fail();
      if (b.length < i + len) return;
      const type = b[0] >> 4;
      const body = b.subarray(i, i + len);
      this.buf = b.slice(i + len);
      this.handle(type, b[0], body);
      if (!this.ws) return;
    }
  }

  private handle(type: number, flags: number, body: Uint8Array): void {
    switch (type) {
      case 2: // CONNACK
        if (body[1] !== 0) return this.fail();
        this.ws?.send(packet(0x82, [0, 1, ...str(this.topic), 0]));
        return;
      case 9: // SUBACK
        if (body[2] === 0x80) return this.fail();
        this.ready = true;
        this.delay = RETRY_MIN;
        this.ping = setInterval(() => {
          try {
            this.ws?.send(new Uint8Array([0xc0, 0]));
          } catch {
            this.fail();
          }
        }, (KEEPALIVE * 1000) / 2);
        this.onState();
        return;
      case 3: {
        // PUBLISH
        const tl = (body[0] << 8) | body[1];
        const qos = (flags >> 1) & 3;
        const start = 2 + tl + (qos ? 2 : 0);
        if (start <= body.length) this.onPayload(body.slice(start));
        return;
      }
    }
  }

  private reset(): void {
    const ws = this.ws;
    this.ws = null;
    this.buf = new Uint8Array(0);
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    const was = this.ready;
    this.ready = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* già chiusa */
      }
    }
    if (was) this.onState();
  }

  private fail(): void {
    this.reset();
    if (this.closed || this.retry) return;
    this.onState();
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, this.delay);
    this.delay = Math.min(RETRY_MAX, this.delay * 2);
  }
}

/* ------------------------------------------------------------------------
 * Relay della stanza: più broker in parallelo, messaggi cifrati e deduplicati
 * ---------------------------------------------------------------------- */

export class Relay {
  private brokers: Broker[] = [];
  private key: CryptoKey | null = null;
  private seen = new Set<string>();
  private dead = false;
  private started = Date.now();

  constructor(
    private room: string,
    private onMsg: (m: RelayMsg) => void,
    private onState: (s: RelayState) => void,
  ) {
    void this.init();
  }

  get state(): RelayState {
    if (this.brokers.some((b) => b.ready)) return "on";
    return Date.now() - this.started < 15_000 ? "connecting" : "error";
  }

  get ready(): boolean {
    return this.brokers.some((b) => b.ready);
  }

  private async init(): Promise<void> {
    try {
      const [k, t] = await Promise.all([sha256("whiteboard-relay-key:" + this.room), sha256("whiteboard-relay-topic:" + this.room)]);
      if (this.dead) return;
      this.key = await crypto.subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]);
      const topic = "wbcollab/" + hex(t).slice(0, 40);
      const changed = () => !this.dead && this.onState(this.state);
      this.brokers = BROKERS.map((u) => new Broker(u, topic, (p) => void this.receive(p), changed));
      // se nessun broker risponde in tempo, la UI deve poterlo dire
      setTimeout(changed, 15_500);
    } catch {
      this.onState("error");
    }
  }

  wake(): void {
    this.started = Date.now();
    for (const b of this.brokers) b.wake();
  }

  async send(msg: RelayMsg): Promise<void> {
    const key = this.key;
    if (!key || this.dead) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = enc.encode(JSON.stringify({ ...msg, n: randomId(6) }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    if (out.length > MAX_PAYLOAD) return;
    for (const b of this.brokers) b.publish(out);
  }

  close(): void {
    this.dead = true;
    for (const b of this.brokers) b.close();
    this.brokers = [];
  }

  private async receive(payload: Uint8Array): Promise<void> {
    const key = this.key;
    if (!key || this.dead || payload.length < 29 || payload.length > MAX_PAYLOAD) return;
    let raw: unknown;
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payload.slice(0, 12) }, key, payload.slice(12));
      raw = JSON.parse(new TextDecoder().decode(plain));
    } catch {
      return; // non è per noi, o è stato manomesso
    }
    // lo stesso messaggio arriva da ogni broker
    const n = isObj(raw) && isStr(raw.n, 20) ? raw.n : null;
    if (!n || this.seen.has(n)) return;
    this.seen.add(n);
    if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-250));
    const msg = parseRelayMsg(raw);
    if (msg && !this.dead) this.onMsg(msg);
  }
}
