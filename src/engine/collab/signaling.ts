import { deflate, fromBase64Url, hasStreams, inflate, toBase64Url } from "../share";

/**
 * Segnalazione WebRTC senza server.
 *
 * Per aprire un canale P2P due browser devono scambiarsi una "offerta" e una "risposta" (SDP con i candidati
 * ICE). Qui lo scambio avviene fuori banda, ed è l'utente a trasportare i due messaggi:
 *   1. l'host genera un link d'invito (contiene l'offerta, nel fragment: mai inviato a nessun server);
 *   2. l'ospite lo apre e ottiene un codice di risposta;
 *   3. l'ospite lo manda all'host, che lo incolla. Il canale si apre.
 * Dopo il primo collegamento, gli altri partecipanti si scambiano offerte e risposte attraverso i canali
 * già aperti (vedi session.ts), quindi l'invito manuale serve una sola volta per persona.
 *
 * Con il relay attivo (relay.ts) basta invece un "link della stanza": contiene solo l'id della stanza (che
 * fa anche da chiave di cifratura per il relay), vale per quante persone si vuole e non scade.
 */

export const COLLAB_PARAM = "collab";
const MAX_CODE = 40_000;
const MAX_JSON = 200_000;

export interface Invite {
  /** id dell'invito: la risposta lo cita per essere abbinata alla giusta connessione in sospeso. */
  i: string;
  room: string;
  /** sito dell'host */
  s: string;
  /** nome dell'host */
  n: string;
  /** nome della lavagna */
  b: string;
  sdp: string;
}

/** Link della stanza: per entrare con il relay, senza codici da rimandare indietro. */
export interface RoomInvite {
  room: string;
  /** nome dell'host */
  n: string;
  /** nome della lavagna */
  b: string;
}

export type AnyInvite = ({ kind: "offer" } & Invite) | ({ kind: "room" } & RoomInvite);

export interface Answer {
  i: string;
  /** sito dell'ospite */
  s: string;
  n: string;
  sdp: string;
}

async function pack(obj: unknown): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (hasStreams()) {
    try {
      return "z" + toBase64Url(await deflate(raw));
    } catch {
      /* ripiega sul formato non compresso */
    }
  }
  return "p" + toBase64Url(raw);
}

async function unpack(code: string): Promise<unknown> {
  if (code.length < 2 || code.length > MAX_CODE) throw new Error("size");
  let bytes = fromBase64Url(code.slice(1));
  if (code[0] === "z") bytes = await inflate(bytes);
  else if (code[0] !== "p") throw new Error("format");
  if (bytes.length > MAX_JSON) throw new Error("size");
  return JSON.parse(new TextDecoder().decode(bytes));
}

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isSdp = (v: unknown): v is string => isStr(v, 100_000) && v.startsWith("v=0");

/** Accetta sia il link completo sia il solo codice (anche con spazi o a capo incollati). */
export function extractCode(text: string): string {
  const m = new RegExp(`${COLLAB_PARAM}=([A-Za-z0-9_-]+)`).exec(text);
  return (m ? m[1] : text).replace(/\s+/g, "");
}

export async function encodeInvite(inv: Invite): Promise<string> {
  return pack({ v: 1, k: "o", ...inv });
}

export async function encodeRoomInvite(inv: RoomInvite): Promise<string> {
  return pack({ v: 2, k: "r", ...inv });
}

export async function encodeAnswer(a: Answer): Promise<string> {
  return pack({ v: 1, k: "a", ...a });
}

export async function decodeInvite(text: string): Promise<AnyInvite | null> {
  try {
    const d = (await unpack(extractCode(text))) as Record<string, unknown>;
    const n = typeof d.n === "string" ? d.n.slice(0, 24) : "";
    const b = typeof d.b === "string" ? d.b.slice(0, 80) : "";
    if (d.v === 2 && d.k === "r") return isStr(d.room, 100) ? { kind: "room", room: d.room, n, b } : null;
    if (d.v !== 1 || d.k !== "o") return null;
    if (!isStr(d.i, 40) || !isStr(d.room, 100) || !isStr(d.s, 40) || !isSdp(d.sdp)) return null;
    return {
      kind: "offer",
      i: d.i,
      room: d.room,
      s: d.s,
      n,
      b,
      sdp: d.sdp,
    };
  } catch {
    return null;
  }
}

export async function decodeAnswer(text: string): Promise<Answer | null> {
  try {
    const d = (await unpack(extractCode(text))) as Record<string, unknown>;
    if (d.v !== 1 || d.k !== "a") return null;
    if (!isStr(d.i, 40) || !isStr(d.s, 40) || !isSdp(d.sdp)) return null;
    return { i: d.i, s: d.s, n: typeof d.n === "string" ? d.n.slice(0, 24) : "", sdp: d.sdp };
  } catch {
    return null;
  }
}

export function buildInviteUrl(code: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `${COLLAB_PARAM}=${code}`;
  return url.toString();
}

/** Estrae il codice d'invito dal fragment corrente (null se assente). */
export function readCollabHash(hash: string = window.location.hash): string | null {
  const m = new RegExp(`^#${COLLAB_PARAM}=([A-Za-z0-9_-]+)$`).exec(hash);
  return m ? m[1] : null;
}
