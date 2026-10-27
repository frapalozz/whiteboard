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
  /** Numero di pagine della modalità lezione (0 = lavagna infinita). */
  pg?: Reg<number>;
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
  /** Area visibile in coordinate mondo: serve a chi segue questo partecipante. */
  | { t: "vw"; x: number; y: number; w: number; h: number }
  /** "Fatti seguire": chi lo riceve inizia (o smette) di seguire chi lo manda. */
  | { t: "lead"; on: boolean }
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
  pages?: Reg<number>;
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
  /** true se stai chiedendo a tutti di seguire la tua vista. */
  leading: boolean;
  /** Sito del partecipante di cui segui la vista (null: nessuno). */
  following: string | null;
  /** Siti dei partecipanti che chiedono di essere seguiti. */
  leaders: string[];
}

export const MAX_ENTRIES = 200_000;

export const OFF_UI: CollabUI = { mode: "off", room: "", peers: [], name: "", stun: true, relay: true, relayState: "off", site: "", color: "#4c8dff", leading: false, following: null, leaders: [] };
