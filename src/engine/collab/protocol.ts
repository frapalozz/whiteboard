import { sanitizeColor, sanitizeElement } from "../storage";
import { MAX_POINTS, parseBatch } from "./doc";
import type { Msg } from "./types";
import { isNum, isObj, isStr } from "./validate";

/**
 * Validazione dei messaggi ricevuti dal canale dati. Ogni peer è non fidato: forma, tipi e dimensioni
 * vengono controllati prima che qualsiasi cosa tocchi il documento.
 */


/** Nome visualizzabile: niente caratteri di controllo, lunghezza limitata. */
export function cleanName(v: unknown, fallback = "Ospite"): string {
  if (typeof v !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
  return s || fallback;
}

export function parseMsg(raw: unknown): Msg | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  switch (raw.t) {
    case "hi":
      if (!isStr(raw.room, 100) || !isStr(raw.site, 40)) return null;
      return { t: "hi", room: raw.room, site: raw.site, name: cleanName(raw.name) };
    case "ops": {
      const b = parseBatch(raw.b);
      return b ? { t: "ops", b } : null;
    }
    case "peers": {
      if (!Array.isArray(raw.list) || raw.list.length > 64) return null;
      const list: Array<{ site: string; name: string }> = [];
      for (const p of raw.list) {
        if (isObj(p) && isStr(p.site, 40)) list.push({ site: p.site, name: cleanName(p.name) });
      }
      return { t: "peers", list };
    }
    case "sig":
      if (!isStr(raw.from, 40) || !isStr(raw.to, 40) || (raw.k !== "offer" && raw.k !== "answer")) return null;
      if (!isStr(raw.sdp, 100_000)) return null;
      return { t: "sig", from: raw.from, to: raw.to, k: raw.k, sdp: raw.sdp };
    case "cur":
      if (raw.x === null) return { t: "cur", x: null, y: 0 };
      return isNum(raw.x) && isNum(raw.y) ? { t: "cur", x: raw.x, y: raw.y } : null;
    case "dp": {
      if (!isStr(raw.id, 100) || !isNum(raw.w) || !isNum(raw.f) || !Array.isArray(raw.p)) return null;
      if (raw.p.length > 4000 || raw.p.length % 2 !== 0 || raw.f < 0 || raw.f > MAX_POINTS) return null;
      for (const n of raw.p) if (!isNum(n)) return null;
      return {
        t: "dp",
        id: raw.id,
        c: sanitizeColor(raw.c, "#000000"),
        w: Math.min(200, Math.max(0.5, raw.w)),
        f: Math.floor(raw.f),
        p: raw.p as number[],
      };
    }
    case "dr": {
      const el = sanitizeElement(raw.el);
      return el && el.type !== "stroke" && el.type !== "text" ? { t: "dr", el } : null;
    }
    case "dend":
      return isStr(raw.id, 100) ? { t: "dend", id: raw.id } : null;
    case "vw":
      if (!isNum(raw.x) || !isNum(raw.y) || !isNum(raw.w) || !isNum(raw.h)) return null;
      if (raw.w <= 0 || raw.h <= 0 || raw.w > 1e7 || raw.h > 1e7) return null;
      return { t: "vw", x: raw.x, y: raw.y, w: raw.w, h: raw.h };
    case "lead":
      return typeof raw.on === "boolean" ? { t: "lead", on: raw.on } : null;
    case "bye":
      return { t: "bye" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------
 * Frammentazione: i canali dati hanno un limite pratico sulla dimensione del messaggio
 * (~16 KB è sicuro ovunque). I messaggi più grandi sono spezzati e ricomposti.
 * ---------------------------------------------------------------------- */

export const FRAME_MAX = 14_000;
/** Dimensione massima accettata per un frame singolo e per un messaggio ricomposto. */
export const RX_FRAME_MAX = 64_000;
export const RX_MESSAGE_MAX = 32 * 1024 * 1024;
export const RX_PARTS_MAX = 2_400;

let frameId = 0;

export function toFrames(msg: Msg): string[] {
  const text = JSON.stringify(msg);
  if (text.length <= FRAME_MAX) return [text];
  const id = `${Date.now().toString(36)}${(frameId++).toString(36)}`;
  const n = Math.ceil(text.length / FRAME_MAX);
  const frames: string[] = [];
  for (let i = 0; i < n; i++) frames.push(JSON.stringify({ ck: id, i, n, d: text.slice(i * FRAME_MAX, (i + 1) * FRAME_MAX) }));
  return frames;
}

/** Colore stabile per sito, calcolato in locale (non ci si fida di quello dichiarato dagli altri). */
export function colorFor(site: string): string {
  let h = 0;
  for (let i = 0; i < site.length; i++) h = (h * 31 + site.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 45%)`;
}

export function randomId(bytes = 6): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
