
/**
 * Identità dei partecipanti (ECDSA P-256 con WebCrypto, nessun server).
 *
 * Ogni lavagna collaborativa ha la sua coppia di chiavi; l'id del sito è ricavato dalla chiave pubblica,
 * quindi nessuno può presentarsi con l'id di un altro senza averne la chiave privata. Nel saluto di ogni
 * canale WebRTC il partecipante firma l'impronta DTLS del proprio lato del collegamento: chi riceve la
 * confronta con quella che vede dall'altra parte. Una firma copiata da un altro canale non vale, perché
 * ogni collegamento ha il suo certificato.
 */

// base64url locale: importarla da share.ts creerebbe un ciclo di import (share → validate → auth)
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const enc = new TextEncoder();

/** Copia in un ArrayBuffer proprio: WebCrypto non accetta viste su buffer condivisi. */
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export interface Identity {
  site: string;
  /** Chiave pubblica (SPKI, base64url). */
  pk: string;
  key: CryptoKey;
}

/** Forma salvata nel browser insieme alla lavagna. */
export interface IdentitySaved {
  pk: string;
  jwk: JsonWebKey;
}

export function authSupported(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle;
}

/** Id del sito ricavato dalla chiave pubblica: 16 cifre esadecimali dell'hash SHA-256. */
export async function siteFor(pk: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", buf(fromBase64Url(pk))));
  return Array.from(h.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function newIdentity(): Promise<{ id: Identity; saved: IdentitySaved }> {
  const kp = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const pk = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey)));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { id: { site: await siteFor(pk), pk, key: kp.privateKey }, saved: { pk, jwk } };
}

export async function loadIdentity(s: IdentitySaved): Promise<Identity> {
  const key = await crypto.subtle.importKey("jwk", s.jwk, ALG, false, ["sign"]);
  return { site: await siteFor(s.pk), pk: s.pk, key };
}

export async function sign(id: Identity, text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.sign(SIGN, id.key, enc.encode(text))));
}

const pubKeys = new Map<string, Promise<CryptoKey | null>>();

function publicKey(pk: string): Promise<CryptoKey | null> {
  let p = pubKeys.get(pk);
  if (!p) {
    p = crypto.subtle.importKey("spki", buf(fromBase64Url(pk)), ALG, false, ["verify"]).catch(() => null);
    if (pubKeys.size > 500) pubKeys.clear();
    pubKeys.set(pk, p);
  }
  return p;
}

export async function verify(pk: string, text: string, sig: string): Promise<boolean> {
  try {
    const key = await publicKey(pk);
    if (!key) return false;
    return await crypto.subtle.verify(SIGN, key, buf(fromBase64Url(sig)), enc.encode(text));
  } catch {
    return false;
  }
}

/** Impronte DTLS contenute in una SDP, in forma canonica (legano la firma a un collegamento preciso). */
export function fingerprints(sdp: string | undefined | null): string {
  if (!sdp) return "";
  const out = new Set<string>();
  for (const m of sdp.matchAll(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/gm)) out.add(`${m[1].toLowerCase()} ${m[2].toUpperCase()}`);
  return [...out].sort().join(",");
}

/** Testo firmato nel saluto di un canale. */
export const helloText = (room: string, site: string, fp: string): string => `wb-hi|${room}|${site}|${fp}`;

const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export function parseIdentitySaved(raw: unknown): IdentitySaved | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { pk?: unknown; jwk?: unknown };
  if (!isStr(r.pk, 300) || typeof r.jwk !== "object" || r.jwk === null) return undefined;
  const j = r.jwk as Record<string, unknown>;
  if (j.kty !== "EC" || j.crv !== "P-256" || !isStr(j.d, 100) || !isStr(j.x, 100) || !isStr(j.y, 100)) return undefined;
  return { pk: r.pk, jwk: { kty: "EC", crv: "P-256", d: j.d, x: j.x, y: j.y, ext: true } };
}
