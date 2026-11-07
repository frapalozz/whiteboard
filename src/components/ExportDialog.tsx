"use client";

import { useState } from "react";
import type { UIState } from "@/engine/types";
import type { ExportScope, Whiteboard } from "@/engine/whiteboard";
import Dialog, { labelCls, primaryBtn } from "./Dialog";
import { icons } from "./icons";
import { Segmented, Switch, subtle } from "./ui";

type Format = "png" | "svg" | "pdf";

const FORMAT_HINT: Record<Format, string> = {
  png: "Immagine, va bene ovunque (chat, documenti, slide).",
  svg: "Grafica vettoriale: si ingrandisce senza sgranare; si apre in Figma, Inkscape, Illustrator.",
  pdf: "Da stampare o mandare: con le pagine della lezione, un foglio per pagina.",
};

export default function ExportDialog({ wb, ui, onClose, notify }: { wb: Whiteboard; ui: UIState; onClose: () => void; notify: (t: string, k?: "ok" | "error") => void }) {
  const hasPages = ui.pageCount > 0;
  const [format, setFormat] = useState<Format>(hasPages ? "pdf" : "png");
  const [scope, setScope] = useState<ExportScope>(ui.selectionCount > 0 ? "selection" : hasPages ? "pages" : "all");
  const [background, setBackground] = useState(true);
  const [busy, setBusy] = useState(false);

  const scopes: Array<{ id: ExportScope; label: string }> = [
    { id: "all", label: "Tutto" },
    ...(ui.selectionCount > 0 ? [{ id: "selection" as const, label: "Selezione" }] : []),
    ...(hasPages ? [{ id: "page" as const, label: `Pagina ${ui.page + 1}` }] : []),
    ...(hasPages && format === "pdf" ? [{ id: "pages" as const, label: `Tutte (${ui.pageCount})` }] : []),
  ];
  const current = scopes.some((s) => s.id === scope) ? scope : scopes[0].id;

  async function go() {
    setBusy(true);
    const r = await wb.exportImage({ format, scope: current, background: format === "pdf" ? true : background });
    setBusy(false);
    if (!r.ok) notify(r.error ?? "Esportazione non riuscita", "error");
    else onClose();
  }

  return (
    <Dialog title="Esporta" subtitle="Il file si crea qui, nel browser." onClose={onClose}>
      <section className="flex flex-col gap-2">
        <span className={labelCls}>Formato</span>
        <Segmented<Format>
          value={format}
          onChange={setFormat}
          options={[
            { id: "png", label: "PNG" },
            { id: "svg", label: "SVG" },
            { id: "pdf", label: "PDF" },
          ]}
        />
        <p className={`text-xs ${subtle}`}>{FORMAT_HINT[format]}</p>
      </section>
      <section className="flex flex-col gap-2">
        <span className={labelCls}>Cosa</span>
        <Segmented<ExportScope> value={current} onChange={setScope} options={scopes} />
      </section>
      {format !== "pdf" && <Switch checked={background} onChange={setBackground} label="Con lo sfondo (senza: trasparente)" />}
      <button type="button" disabled={busy} onClick={() => void go()} className={primaryBtn}>
        <span className="[&>svg]:h-4 [&>svg]:w-4">{icons.download}</span>
        {busy ? "Preparo il file…" : `Scarica ${format.toUpperCase()}`}
      </button>
    </Dialog>
  );
}
