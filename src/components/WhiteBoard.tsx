"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isDark } from "@/engine/render";
import { readCollabHash } from "@/engine/collab/signaling";
import { decodeBoard, readShareHash, SHARE_SOFT_LIMIT } from "@/engine/share";
import { useWhiteboard } from "@/hooks/useWhiteboard";
import BoardChip from "./BoardChip";
import BoardsDrawer from "./BoardsDrawer";
import Canvas from "./Canvas";
import CollabDialog from "./CollabDialog";
import CommentPopover from "./CommentPopover";
import ExportDialog from "./ExportDialog";
import MermaidDialog from "./MermaidDialog";
import VersionsDialog from "./VersionsDialog";
import FileMenu from "./FileMenu";
import LessonBar from "./LessonBar";
import PropertiesPanel from "./PropertiesPanel";
import Toast, { type ToastMsg } from "./Toast";
import Toolbar from "./Toolbar";
import ViewMenu from "./ViewMenu";
import { icons } from "./icons";
import { Btn, panel, usePopover } from "./ui";
import type { AlignKind } from "@/engine/snap";
import type { Whiteboard as Engine } from "@/engine/whiteboard";

const ALIGN: Array<{ kind: AlignKind; label: string; icon: keyof typeof icons }> = [
  { kind: "left", label: "Allinea a sinistra", icon: "alignLeft" },
  { kind: "hcenter", label: "Centra in orizzontale", icon: "alignHCenter" },
  { kind: "right", label: "Allinea a destra", icon: "alignRight" },
  { kind: "top", label: "Allinea in alto", icon: "alignTop" },
  { kind: "vcenter", label: "Centra in verticale", icon: "alignVCenter" },
  { kind: "bottom", label: "Allinea in basso", icon: "alignBottom" },
];

/** Allinea e distribuisci la selezione. */
function AlignMenu({ wb, count }: { wb: Engine; count: number }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <Btn label="Allinea e distribuisci" tip="top" active={open} onClick={() => setOpen(!open)}>
        {icons.align}
      </Btn>
      {open && (
        <div className={`${panel} animate-pop-in absolute bottom-full left-1/2 z-30 mb-2 grid -translate-x-1/2 grid-cols-4 gap-0.5 p-1.5 max-lg:bottom-auto max-lg:top-full max-lg:mb-0 max-lg:mt-2`}>
          {ALIGN.slice(0, 3).map((a) => (
            <Btn key={a.kind} label={a.label} tip="top" onClick={() => wb.align(a.kind)}>
              {icons[a.icon]}
            </Btn>
          ))}
          <Btn label="Distribuisci in orizzontale (almeno 3)" tip="top" disabled={count < 3} onClick={() => wb.distribute("x")}>
            {icons.distH}
          </Btn>
          {ALIGN.slice(3).map((a) => (
            <Btn key={a.kind} label={a.label} tip="top" onClick={() => wb.align(a.kind)}>
              {icons[a.icon]}
            </Btn>
          ))}
          <Btn label="Distribuisci in verticale (almeno 3)" tip="top" disabled={count < 3} onClick={() => wb.distribute("y")}>
            {icons.distV}
          </Btn>
        </div>
      )}
    </div>
  );
}

const TIPS_DESKTOP: Array<[string, string]> = [
  ["Disegna", "trascina con la penna"],
  ["Spostati", "Spazio + trascina, o tasto destro"],
  ["Zoom", "Ctrl + rotella"],
];
const TIPS_TOUCH: Array<[string, string]> = [
  ["Disegna", "trascina con un dito"],
  ["Spostati e zoom", "usa due dita"],
];

export default function WhiteBoard() {
  const { wb, ui } = useWhiteboard();
  const [library, setLibrary] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "export" | "mermaid" | "versions">(null);
  // con una finestra aperta le scorciatoie della lavagna tacciono
  useEffect(() => {
    if (!dialog) return;
    wb.setPaused(true);
    return () => wb.setPaused(false);
  }, [dialog, wb]);
  /** Codice d'invito arrivato da un link `#collab=…`. */
  const [invite, setInvite] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toastId = useRef(0);

  const notify = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    setToast({ id: ++toastId.current, text, kind });
  }, []);
  const clearToast = useCallback(() => setToast(null), []);

  /** Copia negli appunti il link che contiene l'intera lavagna. */
  async function onShare() {
    try {
      const res = await wb.getShareUrl();
      if (!res.ok) return notify(res.error, "error");
      try {
        await navigator.clipboard.writeText(res.url);
      } catch {
        // appunti non disponibili (http, permessi): ultima risorsa, il link da copiare a mano
        window.prompt("Copia il link di condivisione:", res.url);
      }
      const kb = Math.max(1, Math.round(res.url.length / 1024));
      notify(
        res.url.length > SHARE_SOFT_LIMIT
          ? `Link copiato (${kb} KB): alcune app potrebbero troncarlo`
          : "Link copiato negli appunti",
      );
    } catch {
      notify("Impossibile creare il link", "error");
    }
  }

  // Apertura di un link condiviso: la lavagna diventa una NUOVA lavagna della libreria.
  // Il fragment viene tolto subito, così un ricaricamento non la importa una seconda volta.
  useEffect(() => {
    async function openShared() {
      const value = readShareHash();
      if (!value) return;
      history.replaceState(null, "", window.location.pathname + window.location.search);
      const board = await decodeBoard(value);
      if (!board) return notify("Link non valido o danneggiato", "error");
      const res = wb.importBoard(board);
      if (res.ok) {
        setLibrary(false);
        notify("Lavagna condivisa aperta come nuova lavagna");
      } else {
        notify(res.error ?? "Importazione non riuscita", "error");
      }
    }
    void openShared();
    const onHash = () => void openShared();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [wb, notify]);

  // Apertura di un link d'invito alla collaborazione: si propone l'unione, senza fare nulla da soli.
  // Il fragment viene tolto subito, così un ricaricamento non lo ripropone.
  useEffect(() => {
    function openInvite() {
      const code = readCollabHash();
      if (!code) return;
      history.replaceState(null, "", window.location.pathname + window.location.search);
      setInvite(code);
      setCollabOpen(true);
    }
    openInvite();
    window.addEventListener("hashchange", openInvite);
    return () => window.removeEventListener("hashchange", openInvite);
  }, []);

  async function onFile(file: File | undefined) {
    if (!file) return;
    const res = wb.importJSON(await file.text(), file.name);
    if (res.ok) {
      setLibrary(false);
      notify("Importata come nuova lavagna");
    } else {
      notify(res.error ?? "Importazione non riuscita", "error");
    }
  }

  const readOnly = ui.readOnly;
  const hasSelection = ui.selectionCount > 0 && !readOnly;
  const dark = isDark(ui.bgColor);

  return (
    <div className="fixed inset-0 overflow-clip">
      <Canvas wb={wb} ui={ui} />

      {/* UI sopra il canvas: il contenitore lascia passare i click, i pannelli no */}
      <div className="pointer-events-none absolute inset-0 z-10 select-none overflow-clip">
        {/* In alto a sinistra: lavagna */}
        <div className="absolute left-2 top-2">
          <BoardChip wb={wb} ui={ui} onOpenLibrary={() => setLibrary(true)} />
        </div>

        {/* In alto a destra: annulla/ripeti, sfondo, file */}
        <div className={`${panel} absolute right-2 top-2 flex items-center gap-0.5 p-1.5`}>
          {!readOnly && (
            <>
              <Btn label="Annulla" shortcut="Ctrl+Z" disabled={!ui.canUndo} onClick={wb.undo}>
                {icons.undo}
              </Btn>
              <Btn label="Ripeti" shortcut="Ctrl+Shift+Z" disabled={!ui.canRedo} onClick={wb.redo}>
                {icons.redo}
              </Btn>
              <div className="mx-1 h-6 w-px bg-black/10 dark:bg-white/15" />
            </>
          )}
          <Btn
            label={ui.collab.mode === "off" ? "Collabora" : `Collaborazione: ${ui.collab.peers.length + 1} ${ui.collab.peers.length ? "persone" : "persona"}`}
            active={ui.collab.mode !== "off"}
            onClick={() => setCollabOpen(true)}
          >
            <span className="relative">
              {icons.users}
              {ui.collab.mode !== "off" && (
                <span className="absolute -right-2 -top-2 grid h-4 min-w-4 place-items-center rounded-full bg-white px-1 text-[10px] font-bold leading-none text-indigo-700">
                  {ui.collab.peers.length + 1}
                </span>
              )}
            </span>
          </Btn>
          {!readOnly && <ViewMenu wb={wb} ui={ui} />}
          <FileMenu wb={wb} ui={ui} onImport={() => fileRef.current?.click()} onShare={() => void onShare()} onOpen={setDialog} />
        </div>

        {/* Strumenti: in alto al centro su schermi larghi, in basso altrove */}
        <div className="absolute inset-x-0 bottom-2 flex justify-center px-2 lg:bottom-auto lg:top-2">
          {readOnly ? (
            <div className={`${panel} pointer-events-auto flex items-center gap-2 py-1.5 pl-3.5 pr-1.5 text-sm`} role="status">
              <Btn label="Puntatore laser" shortcut="K" active={ui.tool === "laser"} onClick={() => wb.setTool(ui.tool === "laser" ? "hand" : "laser")}>
                {icons.laser}
              </Btn>
              <span className="text-amber-600 dark:text-amber-400">{icons.eye}</span>
              <span>
                <b className="font-semibold">Sola lettura</b>
                <span className="hidden sm:inline"> · puoi guardare e muoverti</span>
              </span>
              <button
                type="button"
                disabled={ui.collab.asked}
                onClick={() => {
                  wb.askEditAccess();
                  notify("Richiesta inviata al proprietario della lavagna");
                }}
                className="rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-500 disabled:bg-black/10 disabled:text-current disabled:opacity-60 dark:disabled:bg-white/10"
              >
                {ui.collab.asked ? "Richiesta inviata" : "Chiedi di modificare"}
              </button>
            </div>
          ) : (
            <Toolbar wb={wb} ui={ui} notify={notify} />
          )}
        </div>

        {/* Proprietà dello strumento / della selezione */}
        {!readOnly && (
          <div className="absolute inset-x-2 bottom-[4.5rem] max-h-[45vh] overflow-y-auto md:inset-x-auto md:bottom-auto md:left-2 md:top-[4.5rem] md:max-h-[calc(100%-9rem)]">
            <PropertiesPanel wb={wb} ui={ui} />
          </div>
        )}

        {/* Azioni sulla selezione */}
        {hasSelection && (
          <div
            className={`${panel} animate-pop-in absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-0.5 p-1.5 lg:bottom-3 lg:top-auto`}
          >
            {ui.selectionCount > 1 && <AlignMenu wb={wb} count={ui.selectionCount} />}
            {ui.canArrange && (
              <Btn label="Disponi il diagramma in automatico" tip="top" onClick={() => wb.autoArrange()}>
                {icons.arrange}
              </Btn>
            )}
            <Btn
              label={ui.lockState === "all" ? "Sblocca" : "Blocca (non si sposta né si cancella)"}
              tip="top"
              active={ui.lockState === "all"}
              onClick={wb.toggleLock}
            >
              {ui.lockState === "all" ? icons.lock : icons.unlock}
            </Btn>
            <div className="mx-0.5 h-6 w-px bg-black/10 dark:bg-white/15" />
            <Btn label="Duplica" shortcut="Ctrl+D" tip="top" onClick={wb.duplicateSelection}>
              {icons.copy}
            </Btn>
            <Btn label="Porta in primo piano" shortcut="]" tip="top" onClick={wb.bringToFront}>
              {icons.front}
            </Btn>
            <Btn label="Manda sullo sfondo" shortcut="[" tip="top" onClick={wb.sendToBack}>
              {icons.back}
            </Btn>
            <Btn label="Elimina" shortcut="Canc" tip="top" danger onClick={wb.deleteSelection}>
              {icons.trash}
            </Btn>
          </div>
        )}

        {/* Modalità lezione: pagine e "segui" (sotto la lavagna su schermi larghi, in alto a sinistra sul telefono) */}
        <div className="absolute left-2 top-[3.75rem] md:bottom-[4.5rem] md:top-auto lg:bottom-3">
          <LessonBar wb={wb} ui={ui} />
        </div>

        {/* Zoom */}
        <div className={`${panel} absolute bottom-[4.5rem] right-2 flex items-center gap-0.5 p-1.5 max-md:hidden lg:bottom-3`}>
          <Btn label="Riduci" shortcut="Ctrl+−" tip="top" onClick={wb.zoomOut}>
            {icons.minus}
          </Btn>
          <button
            type="button"
            aria-label="Zoom 100%"
            title="Torna al 100%"
            onMouseDown={(e) => e.preventDefault()}
            onClick={wb.resetZoom}
            className="h-10 w-14 rounded-xl text-center text-xs font-medium tabular-nums transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          >
            {Math.round(ui.zoom * 100)}%
          </button>
          <Btn label="Ingrandisci" shortcut="Ctrl++" tip="top" onClick={wb.zoomIn}>
            {icons.plus}
          </Btn>
          <Btn label="Adatta al contenuto" shortcut="1" tip="top" align="end" onClick={wb.zoomToFit}>
            {icons.fit}
          </Btn>
        </div>

        {/* Messaggio di benvenuto a lavagna vuota */}
        {!ui.hasContent && !ui.editing && (
          <div
            className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-center gap-4 px-6 text-center"
            style={{ color: dark ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.5)" }}
          >
            <div>
              <p className="text-2xl font-semibold tracking-tight">
                {ui.pageCount > 0 ? "La prima pagina è pronta" : "Una lavagna senza confini"}
              </p>
              <p className="mt-1 text-sm">
                {ui.pageCount > 0 ? "Scrivi sul foglio. Cambi pagina con ‹ › o aggiungine una nuova." : "Inizia a disegnare: viene salvata da sola."}
              </p>
            </div>
            {([["hidden [@media(hover:hover)]:flex", TIPS_DESKTOP], ["hidden [@media(hover:none)]:flex", TIPS_TOUCH]] as const).map(([cls, tips]) => (
              <ul key={cls} className={`${cls} flex-wrap justify-center gap-2 text-xs`}>
                {tips.map(([t, d]) => (
                  <li
                    key={t}
                    className="rounded-full px-3 py-1.5"
                    style={{ background: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)" }}
                  >
                    <b className="font-semibold">{t}</b> · {d}
                  </li>
                ))}
              </ul>
            ))}
          </div>
        )}

        <CommentPopover wb={wb} ui={ui} />

        {/* Lavoro in corso (es. import di un PDF) */}
        {ui.task && (
          <div className="absolute inset-x-0 bottom-20 flex justify-center px-2 lg:bottom-6">
            <div className={`${panel} flex items-center gap-2 px-4 py-2 text-sm`} role="status">
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
              {ui.task}
            </div>
          </div>
        )}

        {/* Notifiche */}
        <div className="absolute inset-x-0 top-16 flex justify-center px-2 lg:top-[4.5rem]">
          <Toast toast={toast} onDone={clearToast} />
        </div>
      </div>

      {collabOpen && (
        <CollabDialog
          key={invite ?? "dialog"}
          wb={wb}
          ui={ui}
          invite={invite}
          onClose={() => {
            setCollabOpen(false);
            setInvite(null);
          }}
          notify={notify}
        />
      )}

      {dialog === "export" && <ExportDialog wb={wb} ui={ui} onClose={() => setDialog(null)} notify={notify} />}
      {dialog === "mermaid" && <MermaidDialog wb={wb} onClose={() => setDialog(null)} notify={notify} />}
      {dialog === "versions" && <VersionsDialog wb={wb} ui={ui} onClose={() => setDialog(null)} notify={notify} />}

      {library && <BoardsDrawer wb={wb} ui={ui} onClose={() => setLibrary(false)} onImport={() => fileRef.current?.click()} notify={notify} />}

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
