"use client";

import type { UIState } from "@/engine/types";
import type { Whiteboard } from "@/engine/whiteboard";
import { icons } from "./icons";
import { Btn, panel, subtle } from "./ui";

/**
 * Barra della modalità lezione: sfoglia le pagine e mostra chi stai seguendo (o se ti stanno seguendo).
 * Compare solo quando serve: con le pagine attive o mentre si segue / ci si fa seguire.
 */
export default function LessonBar({ wb, ui }: { wb: Whiteboard; ui: UIState }) {
  const c = ui.collab;
  const followed = c.following ? c.peers.find((p) => p.site === c.following) : undefined;
  const pages = ui.pageCount;
  if (pages === 0 && !followed && !c.leading) return null;

  function removePage() {
    const n = ui.page + 1;
    if (wb.pageHasContent(ui.page) && !window.confirm(`Eliminare la pagina ${n} e quello che contiene? Puoi annullare con Ctrl+Z.`)) {
      return;
    }
    wb.deletePage(ui.page);
  }

  return (
    <div className={`${panel} flex items-center gap-0.5 p-1.5`}>
      {pages > 0 && (
        <>
          <Btn label="Pagina precedente" shortcut="Pag ↑" tip="top" align="start" disabled={ui.page === 0} onClick={wb.prevPage}>
            {icons.prev}
          </Btn>
          <span className="min-w-[3.25rem] px-1 text-center text-sm font-medium tabular-nums" aria-live="polite">
            {ui.page + 1}
            <span className={subtle}> / {pages}</span>
          </span>
          <Btn label="Pagina successiva" shortcut="Pag ↓" tip="top" disabled={ui.page >= pages - 1} onClick={wb.nextPage}>
            {icons.next}
          </Btn>
          <div className="mx-1 h-6 w-px bg-black/10 dark:bg-white/15" />
          <Btn label="Aggiungi pagina in fondo" tip="top" onClick={wb.addPage}>
            {icons.addPage}
          </Btn>
          <Btn label="Elimina questa pagina" tip="top" danger disabled={pages <= 1} onClick={removePage}>
            {icons.trash}
          </Btn>
        </>
      )}

      {(followed || c.leading) && (
        <>
          {pages > 0 && <div className="mx-1 h-6 w-px bg-black/10 dark:bg-white/15" />}
          <div className="flex items-center gap-2 pl-1.5 pr-0.5">
            <span className="text-indigo-600 dark:text-indigo-400">{followed ? icons.eye : icons.present}</span>
            <span className="max-w-[9rem] truncate text-sm">
              {followed ? (
                <>
                  Segui <b className="font-semibold">{followed.name}</b>
                </>
              ) : (
                "Gli altri seguono te"
              )}
            </span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (followed ? wb.followPeer(null) : wb.setLeading(false))}
              className="rounded-lg px-2 py-1 text-xs font-medium text-indigo-700 transition-colors hover:bg-indigo-500/10 dark:text-indigo-300"
            >
              Smetti
            </button>
          </div>
        </>
      )}
    </div>
  );
}
