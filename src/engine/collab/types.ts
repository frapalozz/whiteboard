import type { El, GridMode } from "../types";

/** Registro "ultima scrittura vince" (Lamport + id del sito come spareggio). */
export interface Reg<T> {
  v: number;
  s: string;
  val: T;
}

/** Un elemento (o la sua lapide) così come viaggia sul canale. */
export interface Wire {
  id: string;
  /** Versione (orologio di Lamport). */
  v: number;
  /** Sito che ha prodotto la versione. */
  s: string;
  /** Chiave d'ordine z (frazionaria). */
  o: number;
  /** 1 = cancellato (lapide). */
  d?: 1;
  el?: El;
}

export interface WireProps {
  bg?: Reg<string>;
  grid?: Reg<GridMode>;
}

export interface Batch {
  e: Wire[];
  p?: WireProps;
}

export type Msg =
  | { t: "hi"; room: string; site: string; name: string }
  | { t: "ops"; b: Batch }
  | { t: "peers"; list: Array<{ site: string; name: string }> }
  | { t: "sig"; from: string; to: string; k: "offer" | "answer"; sdp: string }
  /** Cursore in coordinate mondo (x = null: fuori dalla lavagna). */
  | { t: "cur"; x: number | null; y: number }
  /** Tratto in corso: punti nuovi a partire dall'indice `f`, come coppie piatte [x0,y0,x1,y1,…]. */
  | { t: "dp"; id: string; c: string; w: number; f: number; p: number[] }
  /** Forma in corso (linea, freccia, rettangolo, ellisse). */
  | { t: "dr"; el: El }
  | { t: "dend"; id: string }
  | { t: "bye" };

export interface PeerInfo {
  site: string;
  name: string;
  color: string;
}

/** Stato persistito con la lavagna, per riprendere la collaborazione dopo un ricaricamento. */
export interface CollabSaved {
  room: string;
  site: string;
  mode: "host" | "guest";
  clock: number;
  /** [id, versione, sito, ordine, cancellato] */
  entries: Array<[string, number, string, number, 0 | 1]>;
  bg?: Reg<string>;
  grid?: Reg<GridMode>;
}

/** Parte dello stato osservabile dalla UI. */
export interface CollabUI {
  mode: "off" | "host" | "guest";
  room: string;
  /** Persone collegate direttamente (tu escluso). */
  peers: PeerInfo[];
  name: string;
  stun: boolean;
  /** Preferenza: collegamento automatico attraverso il relay. */
  relay: boolean;
  /** Stato del relay per la sessione corrente. */
  relayState: "off" | "connecting" | "on" | "error";
  /** Sito locale (serve a mostrare il tuo colore). */
  site: string;
  color: string;
}

export const MAX_ENTRIES = 200_000;

export const OFF_UI: CollabUI = { mode: "off", room: "", peers: [], name: "", stun: true, relay: true, relayState: "off", site: "", color: "#4c8dff" };
