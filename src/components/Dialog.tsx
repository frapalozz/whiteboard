"use client";

import { useEffect, type ReactNode } from "react";
import { icons } from "./icons";
import { subtle } from "./ui";

export const primaryBtn =
  "flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/25 transition-all hover:bg-indigo-500 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
export const secondaryBtn =
  "flex items-center justify-center gap-2 rounded-xl bg-black/5 px-3 py-2 text-sm font-semibold transition-colors hover:bg-black/10 disabled:pointer-events-none disabled:opacity-40 dark:bg-white/10 dark:hover:bg-white/15";
export const fieldCls =
  "w-full rounded-xl bg-black/5 px-3 py-2 text-sm outline-none ring-indigo-500 placeholder:text-neutral-400 focus:ring-2 dark:bg-white/10";
export const labelCls = `text-[11px] font-semibold uppercase tracking-wider ${subtle}`;

/** Finestra modale semplice: titolo, contenuto, chiusura con Esc o clic fuori. */
export default function Dialog({ title, subtitle, onClose, children, wide }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="animate-fade-in fixed inset-0 z-40 grid place-items-center bg-black/30 p-3 backdrop-blur-sm" onPointerDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        onPointerDown={(e) => e.stopPropagation()}
        className={`animate-pop-in flex max-h-[calc(100dvh-1.5rem)] w-full ${wide ? "max-w-lg" : "max-w-md"} flex-col gap-4 overflow-y-auto overscroll-contain rounded-2xl bg-neutral-50 p-5 text-neutral-900 shadow-2xl dark:bg-neutral-900 dark:text-neutral-100`}
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            {subtitle && <p className={`mt-0.5 text-xs ${subtle}`}>{subtitle}</p>}
          </div>
          <button
            type="button"
            aria-label="Chiudi"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10 [&>svg]:h-4 [&>svg]:w-4"
          >
            {icons.close}
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
