"use client";

import { useCallback, useEffect, useState } from "react";
import type { UIState } from "@/engine/types";
import type { VersionMeta } from "@/engine/versions";
import type { Whiteboard } from "@/engine/whiteboard";
import Dialog, { fieldCls, secondaryBtn } from "./Dialog";
import { subtle } from "./ui";

function when(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Oggi, ${time}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Ieri, ${time}`;
  return `${d.toLocaleDateString("it-IT", { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })}, ${time}`;
}

export default function VersionsDialog({ wb, ui, onClose, notify }: { wb: Whiteboard; ui: UIState; onClose: () => void; notify: (t: string, k?: "ok" | "error") => void }) {
  const [list, setList] = useState<VersionMeta[] | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void wb.listVersions().then(setList);
  }, [wb]);
  useEffect(reload, [reload, ui.boardId]);

  async function save() {
    setBusy(true);
    const ok = await wb.saveVersionNow(label);
    setBusy(false);
    setLabel("");
    notify(ok ? "Versione salvata" : "Impossibile salvare la versione", ok ? "ok" : "error");
    reload();
  }

  async function restore(v: VersionMeta) {
    setBusy(true);
    const ok = await wb.restoreVersion(v.key);
    setBusy(false);
    if (ok) {
      notify("Versione ripristinata (Ctrl+Z per tornare indietro)");
      onClose();
    } else notify("Impossibile ripristinare la versione", "error");
  }

  return (
    <Dialog
      title="Cronologia versioni"
      subtitle="Una versione ogni 10 minuti di lavoro, più quelle che salvi tu. Restano in questo browser."
      onClose={onClose}
      wide
    >
      <div className="flex gap-2">
        <input
          value={label}
          maxLength={80}
          placeholder="Nome della versione (facoltativo)"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") void save();
          }}
          className={fieldCls}
        />
        <button type="button" disabled={busy} onClick={() => void save()} className={`${secondaryBtn} shrink-0`}>
          Salva versione
        </button>
      </div>
      {list === null ? (
        <p className={`text-sm ${subtle}`}>Carico…</p>
      ) : list.length === 0 ? (
        <p className={`text-sm ${subtle}`}>Ancora nessuna versione: la prima si salva da sola dopo le prime modifiche.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((v) => (
            <li key={v.key} className="flex items-center gap-3 rounded-xl bg-black/[0.03] p-2 dark:bg-white/5">
              {v.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v.thumb} alt="" className="h-14 w-20 shrink-0 rounded-lg object-cover ring-1 ring-black/10" />
              ) : (
                <div className="h-14 w-20 shrink-0 rounded-lg bg-black/5 dark:bg-white/10" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{v.label ?? when(v.time)}</p>
                <p className={`text-xs ${subtle}`}>
                  {v.label ? `${when(v.time)} · ` : ""}
                  {v.count} {v.count === 1 ? "elemento" : "elementi"}
                </p>
              </div>
              <button type="button" disabled={busy || ui.readOnly} onClick={() => void restore(v)} className={`${secondaryBtn} shrink-0 text-xs`}>
                Ripristina
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
