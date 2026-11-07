"use client";

import { useEffect, useRef, useState } from "react";
import type { UIState } from "@/engine/types";
import type { Whiteboard } from "@/engine/whiteboard";
import { icons } from "./icons";
import { panel, subtle } from "./ui";

const W = 300;

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "ora";
  if (s < 3600) return `${Math.floor(s / 60)} min fa`;
  if (s < 86400) return `${Math.floor(s / 3600)} h fa`;
  return new Date(t).toLocaleDateString("it-IT", { day: "numeric", month: "short" });
}

/** Discussione aperta (o nuovo commento) accanto al suo segnaposto sulla lavagna. */
export default function CommentPopover({ wb, ui }: { wb: Whiteboard; ui: UIState }) {
  const c = ui.comment;
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const key = c.open ?? (c.draft ? "draft" : "");
  useEffect(() => {
    setText("");
    if (key) setTimeout(() => ref.current?.focus(), 0);
  }, [key]);
  if (!c.anchor || (!c.open && !c.draft)) return null;

  const root = c.thread.find((m) => !m.re);
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(vw - W - 8, c.anchor.x + 34));
  const top = Math.max(64, Math.min(vh - 280, c.anchor.y - 28));

  const send = () => {
    if (!text.trim()) return;
    wb.addComment(text);
    setText("");
  };

  return (
    <div
      className={`${panel} animate-pop-in absolute z-20 flex max-h-[min(420px,calc(100dvh-8rem))] flex-col gap-2 !bg-white p-3 dark:!bg-neutral-900`}
      style={{ left, top, width: W }}
      onPointerDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={c.draft ? "Nuovo commento" : "Commenti"}
    >
      <div className="flex items-center gap-1">
        <span className="flex-1 text-sm font-semibold">{c.draft ? "Nuovo commento" : root?.done ? "Discussione risolta" : "Commenti"}</span>
        {!c.draft && c.count > 1 && (
          <>
            <button type="button" aria-label="Commento precedente" title="Precedente" onClick={() => wb.nextComment(-1)} className="grid h-7 w-7 place-items-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10 [&>svg]:h-4 [&>svg]:w-4">
              {icons.prev}
            </button>
            <button type="button" aria-label="Commento successivo" title="Successivo" onClick={() => wb.nextComment(1)} className="grid h-7 w-7 place-items-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10 [&>svg]:h-4 [&>svg]:w-4">
              {icons.next}
            </button>
          </>
        )}
        {root && !ui.readOnly && (
          <button
            type="button"
            onClick={() => wb.setCommentDone(root.id, !root.done)}
            title={root.done ? "Riapri la discussione" : "Segna come risolta (si nasconde)"}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
          >
            {root.done ? "Riapri" : "✓ Risolvi"}
          </button>
        )}
        <button type="button" aria-label="Chiudi" onClick={() => wb.openComment(null)} className="grid h-7 w-7 place-items-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10 [&>svg]:h-4 [&>svg]:w-4">
          {icons.close}
        </button>
      </div>

      {c.thread.length > 0 && (
        <ul className="-mx-1 flex min-h-0 flex-col gap-2 overflow-y-auto px-1">
          {c.thread.map((m) => (
            <li key={m.id} className="group flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: m.color }} />
                <b className="truncate font-semibold">{m.author}</b>
                <span className={subtle}>{ago(m.t)}</span>
                {!ui.readOnly && (
                  <button
                    type="button"
                    onClick={() => wb.deleteComment(m.id)}
                    title={m.re ? "Elimina il messaggio" : "Elimina la discussione"}
                    aria-label="Elimina"
                    className={`ml-auto rounded px-1 opacity-0 transition-opacity hover:text-red-600 focus:opacity-100 group-hover:opacity-100 ${subtle}`}
                  >
                    ×
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words pl-4 text-sm">{m.text}</p>
            </li>
          ))}
        </ul>
      )}

      {ui.readOnly ? (
        <p className={`text-xs ${subtle}`}>In sola lettura puoi leggere i commenti, non scriverne.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <textarea
            ref={ref}
            value={text}
            rows={2}
            maxLength={5000}
            placeholder={c.draft ? "Scrivi un commento…" : "Rispondi…"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape") wb.openComment(null);
            }}
            className="w-full resize-none rounded-xl bg-black/5 px-3 py-2 text-sm outline-none ring-indigo-500 placeholder:text-neutral-400 focus:ring-2 dark:bg-white/10"
          />
          <div className="flex items-center justify-between">
            <span className={`text-[11px] ${subtle}`}>Invio per mandare · Maiusc+Invio a capo</span>
            <button
              type="button"
              disabled={!text.trim()}
              onClick={send}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              {c.draft ? "Commenta" : "Rispondi"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
