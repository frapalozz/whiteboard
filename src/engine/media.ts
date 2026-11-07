import { MAX_ASSET_BYTES, putAsset } from "./assets";

/**
 * Immagini e PDF da inserire nella lavagna.
 *
 * Le immagini grandi vengono ridotte (lato lungo ≤ 2400 px) e ricompresse: una foto del telefono da
 * 8 MB diventa qualche centinaio di KB, che conta sia nello spazio del browser sia nella
 * collaborazione. I PDF diventano un'immagine per pagina, disegnata con pdf.js.
 */

export interface Prepared {
  id: string;
  /** Dimensioni in pixel dell'immagine salvata. */
  w: number;
  h: number;
}

const MAX_SIDE = 2400;
/** Sotto questa dimensione (e con il lato lungo entro MAX_SIDE) il file resta com'è. */
const KEEP_BYTES = 1_500_000;
const KEEP_TYPES = /^image\/(png|jpeg|webp|gif)$/;

export const isPdf = (f: Blob & { name?: string }) => f.type === "application/pdf" || /\.pdf$/i.test(f.name ?? "");
export const isImage = (f: Blob) => /^image\//.test(f.type);

async function toBlob(canvas: HTMLCanvasElement, type: string, q: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, q));
}

async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  // WebP mantiene la trasparenza ed è piccolo; dove non c'è si ripiega su JPEG
  const webp = await toBlob(canvas, "image/webp", 0.85);
  if (webp && webp.type === "image/webp") return webp;
  const jpeg = await toBlob(canvas, "image/jpeg", 0.86);
  if (!jpeg) throw new Error("impossibile comprimere l'immagine");
  return jpeg;
}

/** Salva un'immagine nell'archivio (ridotta se serve). */
export async function prepareImage(file: Blob): Promise<Prepared> {
  if (!isImage(file)) throw new Error("Non è un'immagine");
  if (file.size > 60 * 1024 * 1024) throw new Error("Immagine troppo grande");
  const bmp = await createImageBitmap(file).catch(() => {
    throw new Error("Immagine non leggibile");
  });
  try {
    const { width: w, height: h } = bmp;
    if (KEEP_TYPES.test(file.type) && file.size <= KEEP_BYTES && Math.max(w, h) <= MAX_SIDE) {
      const id = await putAsset(new Uint8Array(await file.arrayBuffer()), file.type);
      return { id, w, h };
    }
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas non disponibile");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await encode(canvas);
    if (blob.size > MAX_ASSET_BYTES) throw new Error("Immagine troppo grande");
    const id = await putAsset(new Uint8Array(await blob.arrayBuffer()), blob.type);
    return { id, w: canvas.width, h: canvas.height };
  } finally {
    bmp.close();
  }
}

/* ---- PDF ---- */

/**
 * pdf.js si scarica solo quando serve (la prima volta che si apre un PDF), dalla CDN jsDelivr: il PDF
 * resta nel browser, viaggia solo il codice della libreria. Chi ospita l'app può puntare a una copia
 * propria impostando `window.__PDFJS_URL` prima di caricare la pagina.
 */
const PDFJS_VERSION = "4.10.38";
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
export const MAX_PDF_PAGES = 200;

interface PdfPage {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
  cleanup?(): void;
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(o: { data: Uint8Array }): { promise: Promise<PdfDoc>; destroy?(): Promise<void> };
}

let pdfjsP: Promise<PdfJs> | null = null;

function loadPdfjs(): Promise<PdfJs> {
  if (!pdfjsP) {
    const url = ((globalThis as { __PDFJS_URL?: string }).__PDFJS_URL ?? PDFJS_CDN).toString();
    pdfjsP = import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)
      .then((m: PdfJs) => {
        m.GlobalWorkerOptions.workerSrc = url.replace(/pdf(\.min)?\.mjs$/, "pdf.worker$1.mjs");
        return m;
      })
      .catch((e) => {
        pdfjsP = null;
        throw e;
      });
  }
  return pdfjsP;
}

/**
 * Trasforma ogni pagina di un PDF in un'immagine salvata nell'archivio. `width`: larghezza in pixel
 * delle immagini (le pagine della modalità lezione sono larghe 1600 unità).
 */
export async function preparePdf(
  file: Blob,
  onProgress?: (done: number, total: number) => void,
  width = 2000,
): Promise<Prepared[]> {
  let pdfjs: PdfJs;
  try {
    pdfjs = await loadPdfjs();
  } catch {
    throw new Error("Non riesco a caricare il lettore di PDF (serve la connessione la prima volta)");
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise.catch(() => {
    throw new Error("PDF non leggibile o protetto da password");
  });
  try {
    const total = Math.min(doc.numPages, MAX_PDF_PAGES);
    const out: Prepared[] = [];
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas non disponibile");
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(4, width / base.width) });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup?.();
      const blob = await toBlob(canvas, "image/jpeg", 0.85);
      if (!blob) throw new Error("impossibile salvare la pagina");
      const id = await putAsset(new Uint8Array(await blob.arrayBuffer()), "image/jpeg");
      out.push({ id, w: canvas.width, h: canvas.height });
      onProgress?.(n, total);
    }
    return out;
  } finally {
    void task.destroy?.().catch(() => {});
  }
}
