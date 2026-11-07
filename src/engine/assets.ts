import { idbGet, idbPut } from "./idb";

/**
 * Archivio dei file delle immagini (anche le pagine dei PDF).
 *
 * Ogni file è identificato dall'hash SHA-256 del suo contenuto: la stessa immagine inserita due volte
 * (o in due lavagne) occupa spazio una volta sola, e chi la riceve da un altro partecipante può
 * verificare che sia proprio quella. I file stanno in IndexedDB, non in localStorage (che è piccolo);
 * gli elementi della lavagna contengono solo l'id.
 */

export const MAX_ASSET_BYTES = 12 * 1024 * 1024;
export const isAssetId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

interface Stored {
  mime: string;
  data: ArrayBuffer;
}

export interface Asset {
  mime: string;
  bytes: Uint8Array;
}

const ALLOWED = /^image\/(png|jpeg|webp|gif)$/;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Salva un file e ne restituisce l'id. */
export async function putAsset(bytes: Uint8Array, mime: string): Promise<string> {
  if (!ALLOWED.test(mime)) throw new Error("formato non supportato");
  if (bytes.length > MAX_ASSET_BYTES) throw new Error("file troppo grande");
  const id = await sha256Hex(bytes);
  await idbPut("assets", id, { mime, data: bytes.slice().buffer } satisfies Stored);
  const e = cache.get(id);
  // un'immagine che mancava ora c'è: al prossimo disegno si carica
  if (e && (e.state === "missing" || e.state === "broken")) cache.delete(id);
  return id;
}

/** File ricevuto da un altro partecipante: vale solo se il contenuto corrisponde all'id. */
export async function putVerifiedAsset(id: string, bytes: Uint8Array, mime: string): Promise<boolean> {
  if (!isAssetId(id) || !ALLOWED.test(mime) || bytes.length > MAX_ASSET_BYTES) return false;
  if ((await sha256Hex(bytes)) !== id) return false;
  await putAsset(bytes, mime);
  return true;
}

export async function getAsset(id: string): Promise<Asset | null> {
  if (!isAssetId(id)) return null;
  const s = await idbGet<Stored>("assets", id).catch(() => undefined);
  if (!s || !(s.data instanceof ArrayBuffer) || typeof s.mime !== "string") return null;
  return { mime: s.mime, bytes: new Uint8Array(s.data) };
}

/* ---- immagini pronte da disegnare ---- */

type Entry =
  | { state: "loading" }
  | { state: "ready"; img: CanvasImageSource; w: number; h: number }
  | { state: "missing" }
  | { state: "broken" };

const cache = new Map<string, Entry>();
const readyListeners = new Set<(id: string) => void>();
const missingListeners = new Set<(id: string) => void>();

/** Avvisa quando un'immagine diventa disponibile (per ridisegnare). */
export function onAssetReady(fn: (id: string) => void): () => void {
  readyListeners.add(fn);
  return () => readyListeners.delete(fn);
}

/** Avvisa quando un'immagine usata nella lavagna non è in questo browser (va chiesta agli altri). */
export function onAssetMissing(fn: (id: string) => void): () => void {
  missingListeners.add(fn);
  return () => missingListeners.delete(fn);
}

async function decode(a: Asset): Promise<{ img: CanvasImageSource; w: number; h: number }> {
  const blob = new Blob([a.bytes.slice().buffer as ArrayBuffer], { type: a.mime });
  if (typeof createImageBitmap === "function") {
    const bmp = await createImageBitmap(blob);
    return { img: bmp, w: bmp.width, h: bmp.height };
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  await img.decode();
  return { img, w: img.naturalWidth, h: img.naturalHeight };
}

/** Immagine pronta, oppure null (e intanto la si carica). */
export function imageFor(id: string): CanvasImageSource | null {
  const e = cache.get(id);
  if (e) return e.state === "ready" ? e.img : null;
  cache.set(id, { state: "loading" });
  void (async () => {
    const a = await getAsset(id);
    if (!a) {
      cache.set(id, { state: "missing" });
      for (const fn of missingListeners) fn(id);
      return;
    }
    try {
      cache.set(id, { state: "ready", ...(await decode(a)) });
    } catch {
      cache.set(id, { state: "broken" });
    }
    for (const fn of readyListeners) fn(id);
  })();
  return null;
}

/** Immagine pronta da disegnare, aspettando che sia caricata (null se manca o è rovinata). */
export async function loadImage(id: string): Promise<CanvasImageSource | null> {
  const now = imageFor(id);
  if (now) return now;
  for (let i = 0; i < 200; i++) {
    const e = cache.get(id);
    if (e && e.state !== "loading") return e.state === "ready" ? e.img : null;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/** Stato di un'immagine (per il segnaposto). */
export function assetState(id: string): Entry["state"] | "unknown" {
  return cache.get(id)?.state ?? "unknown";
}

/** Un'immagine prima mancante è arrivata: si ricarica. */
export function assetArrived(id: string): void {
  const e = cache.get(id);
  if (!e || e.state === "missing") {
    cache.delete(id);
    imageFor(id);
  }
}

/** Dimensioni naturali di un'immagine già decodificata. */
export function naturalSize(id: string): { w: number; h: number } | null {
  const e = cache.get(id);
  return e && e.state === "ready" ? { w: e.w, h: e.h } : null;
}

/** Data URL di un file (per export SVG e file .json). */
export async function assetDataUrl(id: string): Promise<string | null> {
  const a = await getAsset(id);
  if (!a) return null;
  let bin = "";
  for (let i = 0; i < a.bytes.length; i += 0x8000) bin += String.fromCharCode(...a.bytes.subarray(i, i + 0x8000));
  return `data:${a.mime};base64,${btoa(bin)}`;
}

/** Contrario di assetDataUrl: salva un file arrivato da un .json (verificandone l'id se c'è). */
export async function putDataUrl(dataUrl: string, id?: string): Promise<string | null> {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2]);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    if (id) return (await putVerifiedAsset(id, bytes, m[1])) ? id : null;
    return await putAsset(bytes, m[1]);
  } catch {
    return null;
  }
}
