/**
 * PDF minimo: una pagina per immagine JPEG, a tutta pagina. Basta per mandare gli appunti di una lezione
 * (e non serve nessuna libreria).
 */

export interface PdfImagePage {
  jpeg: Uint8Array;
  /** Pixel dell'immagine. */
  px: number;
  py: number;
  /** Dimensioni della pagina in punti (1/72 di pollice). */
  w: number;
  h: number;
}

export function buildPdf(pages: PdfImagePage[], title = "Lavagna"): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (b: Uint8Array | string) => {
    const u = typeof b === "string" ? enc.encode(b) : b;
    parts.push(u);
    size += u.length;
  };
  const obj = (n: number, body: () => void) => {
    offsets[n] = size;
    push(`${n} 0 obj\n`);
    body();
    push("\nendobj\n");
  };
  const n = pages.length;
  // 1 catalogo, 2 albero delle pagine, 3 info; per ogni pagina: pagina, contenuto, immagine
  const pageObj = (i: number) => 4 + i * 3;
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>`));
  const safe = title.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?");
  obj(3, () => push(`<< /Title (${safe}) /Producer (Lavagna) >>`));
  pages.forEach((p, i) => {
    const po = pageObj(i);
    const w = p.w.toFixed(2);
    const h = p.h.toFixed(2);
    obj(po, () =>
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${po + 2} 0 R >> >> /Contents ${po + 1} 0 R >>`,
      ),
    );
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(po + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(po + 2, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${p.px} /Height ${p.py} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`,
      );
      push(p.jpeg);
      push("\nendstream");
    });
  });
  const total = 3 + n * 3;
  const xref = size;
  let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) table += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}
