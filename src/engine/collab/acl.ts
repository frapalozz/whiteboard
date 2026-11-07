/**
 * Permessi di una stanza: chi può modificare e chi può solo guardare.
 *
 * Li decide il proprietario della stanza (chi ha avviato la collaborazione) e li firma con la sua chiave:
 * la chiave pubblica viaggia nel link d'invito, quindi ogni partecipante verifica da solo che i permessi
 * vengano davvero da lui. Vale la versione più alta; i permessi si inoltrano come le modifiche, così
 * arrivano anche a chi non è collegato direttamente al proprietario.
 */

export type Access = "edit" | "view";

export interface Acl {
  /** Versione: cresce a ogni cambio. */
  v: number;
  /** Chi entra senza un permesso personale. */
  def: Access;
  /** Permessi personali, per sito. */
  ov: Record<string, Access>;
}

export interface SignedAcl {
  acl: Acl;
  sig: string;
}

export const MAX_OVERRIDES = 500;
const MAX_VERSION = 2 ** 40;

const isAccess = (v: unknown): v is Access => v === "edit" || v === "view";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Testo canonico firmato dal proprietario: la stanza è inclusa, così una firma non vale altrove. */
export function aclText(room: string, a: Acl): string {
  const ov = Object.keys(a.ov)
    .sort()
    .map((k) => `${k}=${a.ov[k]}`)
    .join(",");
  return `wb-acl|${room}|${a.v}|${a.def}|${ov}`;
}

export function parseSignedAcl(raw: unknown): SignedAcl | null {
  if (!isObj(raw) || !isObj(raw.acl) || typeof raw.sig !== "string" || raw.sig.length === 0 || raw.sig.length > 200) return null;
  const a = raw.acl;
  if (typeof a.v !== "number" || !Number.isInteger(a.v) || a.v < 1 || a.v > MAX_VERSION || !isAccess(a.def) || !isObj(a.ov)) return null;
  const keys = Object.keys(a.ov);
  if (keys.length > MAX_OVERRIDES) return null;
  const ov: Record<string, Access> = {};
  for (const k of keys) {
    const v = a.ov[k];
    if (!/^[0-9a-f]{1,40}$/.test(k) || !isAccess(v)) return null;
    ov[k] = v;
  }
  return { acl: { v: a.v, def: a.def, ov }, sig: raw.sig };
}

/** Accesso di `site` secondo i permessi (il proprietario può sempre modificare). */
export function accessOf(acl: Acl, owner: string, site: string): Access {
  if (site === owner) return "edit";
  return acl.ov[site] ?? acl.def;
}
