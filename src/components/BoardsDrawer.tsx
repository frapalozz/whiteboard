"use client";

import { useEffect, useState } from "react";
import type { BoardMeta, UIState } from "@/engine/types";
import type { Whiteboard } from "@/engine/whiteboard";
import { icons } from "./icons";
import { subtle } from "./ui";

function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "adesso";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min fa`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "1 ora fa" : `${h} ore fa`;
  const d = Math.floor(h / 24);
  if (d < 30) return d === 1 ? "ieri" : `${d} giorni fa`;
  return new Date(ts).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "numeric" });
}

const iconBtn =
  "grid h-8 w-8 place-items-center rounded-lg text-neutral-600 transition-colors hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10 [&>svg]:h-4 [&>svg]:w-4";

interface Props {
  wb: Whiteboard;
  ui: UIState;
  onClose: () => void;
  onImport: () => void;
  notify: (text: string, kind?: "ok" | "error") => void;
}

export default function BoardsDrawer({ wb, ui, onClose, onImport, notify }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /** Selezione multipla (per eliminare più lavagne insieme): null = modalità normale. */
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);

  useEffect(() => {
    wb.setPaused(true);
    wb.refreshThumb();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || renaming) return;
      if (picked) endPicking();
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      wb.setPaused(false);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming, picked]);

  const sorted = [...ui.boards].sort((a, b) => b.updatedAt - a.updatedAt);

  function open(b: BoardMeta) {
    if (picked) return toggle(b.id);
    wb.openBoard(b.id);
    onClose();
  }

  function toggle(id: string) {
    setConfirmBulk(false);
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function endPicking() {
    setPicked(null);
    setConfirmBulk(false);
  }

  function deletePicked() {
    if (!picked?.size) return;
    const n = picked.size;
    for (const id of picked) wb.deleteBoard(id);
    endPicking();
    notify(n === 1 ? "1 lavagna eliminata" : `${n} lavagne eliminate`);
  }

  function commitRename(id: string) {
    if (draft.trim()) wb.renameBoard(id, draft);
    setRenaming(null);
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onPointerDown={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Le mie lavagne"
        onPointerDown={(e) => e.stopPropagation()}
        className="animate-slide-in flex h-[100dvh] max-h-full w-full max-w-lg flex-col bg-neutral-50 text-neutral-900 shadow-2xl dark:bg-neutral-900 dark:text-neutral-100"
      >
        <header className="flex items-center justify-between gap-2 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] sm:px-5 sm:pt-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{picked ? `${picked.size} selezionate` : "Le mie lavagne"}</h2>
            <p className={`text-xs ${subtle}`}>
              {picked
                ? "Tocca le lavagne da eliminare"
                : `${sorted.length} ${sorted.length === 1 ? "lavagna salvata" : "lavagne salvate"} in questo browser`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {picked ? (
              <>
                <button
                  type="button"
                  onClick={() => setPicked(picked.size === sorted.length ? new Set() : new Set(sorted.map((b) => b.id)))}
                  className="rounded-lg px-2.5 py-1.5 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/10"
                >
                  {picked.size === sorted.length ? "Nessuna" : "Tutte"}
                </button>
                <button type="button" onClick={endPicking} className="rounded-lg px-2.5 py-1.5 text-sm font-semibold text-indigo-600 hover:bg-black/5 dark:text-indigo-400 dark:hover:bg-white/10">
                  Fine
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDelete(null);
                    setRenaming(null);
                    setPicked(new Set());
                  }}
                  className="rounded-lg px-2.5 py-1.5 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/10"
                >
                  Seleziona
                </button>
                <button type="button" aria-label="Chiudi" onClick={onClose} className={iconBtn}>
                  {icons.close}
                </button>
              </>
            )}
          </div>
        </header>

        <div className={`flex gap-2 px-4 pb-3 sm:px-5 sm:pb-4 ${picked ? "hidden" : ""}`}>
          <button
            type="button"
            onClick={() => {
              wb.newBoard();
              onClose();
            }}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/25 transition-all hover:bg-indigo-500 active:scale-[0.98]"
          >
            <span className="[&>svg]:h-4 [&>svg]:w-4">{icons.plus}</span>
            Nuova lavagna
          </button>
          <button
            type="button"
            onClick={onImport}
            className="flex items-center justify-center gap-2 rounded-xl bg-black/5 px-4 py-2.5 text-sm font-semibold transition-colors hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
          >
            <span className="[&>svg]:h-4 [&>svg]:w-4">{icons.open}</span>
            Importa
          </button>
        </div>

        {/* min-h-0: senza, la lista non scorre e su telefono le ultime lavagne restano irraggiungibili */}
        <ul className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 content-start gap-2 overflow-y-auto overscroll-contain px-4 pb-4 sm:grid-cols-2 sm:gap-3 sm:px-5">
          {sorted.map((b) => {
            const current = b.id === ui.boardId;
            const sel = picked?.has(b.id) ?? false;
            return (
              <li
                key={b.id}
                className={`flex overflow-hidden rounded-2xl bg-white shadow-sm ring-1 transition-shadow hover:shadow-md dark:bg-neutral-800 max-sm:items-center max-sm:gap-3 max-sm:p-2 sm:flex-col ${
                  sel ? "ring-2 ring-red-500" : current ? "ring-2 ring-indigo-500" : "ring-black/10 dark:ring-white/10"
                }`}
              >
                <button
                  type="button"
                  onClick={() => open(b)}
                  aria-label={picked ? `Seleziona ${b.name}` : `Apri ${b.name}`}
                  aria-pressed={picked ? sel : undefined}
                  className="relative block aspect-[16/10] w-full shrink-0 overflow-hidden bg-neutral-100 dark:bg-neutral-700 max-sm:w-24 max-sm:rounded-xl"
                >
                  {b.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={b.thumb} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className={`grid h-full place-items-center text-[10px] sm:text-xs ${subtle}`}>Lavagna vuota</span>
                  )}
                  {current && !picked && (
                    <span className="absolute left-1.5 top-1.5 rounded-full bg-indigo-600 px-2 py-0.5 text-[10px] font-semibold text-white sm:left-2 sm:top-2">
                      Aperta
                    </span>
                  )}
                  {picked && (
                    <span
                      className={`absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full ring-2 ring-white [&>svg]:h-3.5 [&>svg]:w-3.5 ${
                        sel ? "bg-red-600 text-white" : "bg-white/80 text-transparent dark:bg-neutral-900/80"
                      }`}
                    >
                      {icons.check}
                    </span>
                  )}
                </button>

                <div className="flex min-w-0 flex-1 flex-col gap-1 sm:p-3">
                  {renaming === b.id ? (
                    <input
                      autoFocus
                      value={draft}
                      maxLength={80}
                      aria-label="Nuovo nome"
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commitRename(b.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(b.id);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      className="rounded-md bg-black/5 px-1.5 py-0.5 text-sm font-semibold outline-none ring-2 ring-indigo-500 dark:bg-white/10"
                    />
                  ) : (
                    <div className="truncate text-sm font-semibold" title={b.name}>
                      {b.name}
                    </div>
                  )}
                  <div className={`text-xs ${subtle}`}>Modificata {timeAgo(b.updatedAt)}</div>

                  {picked ? null : confirmDelete === b.id ? (
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      <span className="flex-1 font-medium">
                        Eliminare<span className="max-sm:hidden"> per sempre</span>?
                      </span>
                      <button type="button" onClick={() => setConfirmDelete(null)} className="rounded-lg px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10">
                        Annulla
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          wb.deleteBoard(b.id);
                          setConfirmDelete(null);
                          notify(`«${b.name}» eliminata`);
                        }}
                        className="rounded-lg bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-500"
                      >
                        Elimina
                      </button>
                    </div>
                  ) : (
                    <div className="-mx-1 mt-1 flex items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={`Rinomina ${b.name}`}
                        title="Rinomina"
                        className={iconBtn}
                        onClick={() => {
                          setDraft(b.name);
                          setRenaming(b.id);
                        }}
                      >
                        {icons.edit}
                      </button>
                      <button
                        type="button"
                        aria-label={`Duplica ${b.name}`}
                        title="Duplica"
                        className={iconBtn}
                        onClick={() => {
                          const id = wb.duplicateBoard(b.id);
                          notify(id ? "Lavagna duplicata" : "Impossibile duplicare: spazio esaurito", id ? "ok" : "error");
                        }}
                      >
                        {icons.copy}
                      </button>
                      <button
                        type="button"
                        aria-label={`Esporta ${b.name}`}
                        title="Esporta .json"
                        className={iconBtn}
                        onClick={() => wb.exportJSON(b.id)}
                      >
                        {icons.save}
                      </button>
                      <button
                        type="button"
                        aria-label={`Elimina ${b.name}`}
                        title="Elimina"
                        className={`${iconBtn} ml-auto !text-red-600 dark:!text-red-400`}
                        onClick={() => setConfirmDelete(b.id)}
                      >
                        {icons.trash}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {picked ? (
          <footer className="flex items-center gap-2 border-t border-black/10 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 dark:border-white/10 sm:px-5">
            {confirmBulk ? (
              <>
                <span className="flex-1 text-sm font-medium">
                  Eliminare per sempre {picked.size === 1 ? "1 lavagna" : `${picked.size} lavagne`}?
                </span>
                <button type="button" onClick={() => setConfirmBulk(false)} className="rounded-xl px-3 py-2 text-sm font-semibold hover:bg-black/5 dark:hover:bg-white/10">
                  Annulla
                </button>
                <button type="button" onClick={deletePicked} className="rounded-xl bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500">
                  Elimina
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={!picked.size}
                onClick={() => setConfirmBulk(true)}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-red-500 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
              >
                <span className="[&>svg]:h-4 [&>svg]:w-4">{icons.trash}</span>
                {picked.size ? `Elimina ${picked.size === 1 ? "1 lavagna" : `${picked.size} lavagne`}` : "Seleziona le lavagne"}
              </button>
            )}
          </footer>
        ) : (
          <footer className={`border-t border-black/10 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 text-xs leading-relaxed dark:border-white/10 sm:px-5 ${subtle}`}>
            Le lavagne si salvano da sole nella memoria di questo browser. Per fare un backup o usarle su un altro
            dispositivo, esportale in .json e reimportale quando serve.
          </footer>
        )}
      </aside>
    </div>
  );
}
