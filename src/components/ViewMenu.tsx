"use client";

import { BG_PRESETS } from "@/engine/constants";
import type { GridMode, UIState } from "@/engine/types";
import type { Whiteboard } from "@/engine/whiteboard";
import { icons } from "./icons";
import { Btn, panel, Section, subtle, Swatch, Switch, usePopover } from "./ui";

const GRIDS: Array<{ id: GridMode; label: string }> = [
  { id: "none", label: "Nessuna" },
  { id: "dots", label: "Punti" },
  { id: "lines", label: "Griglia" },
  { id: "squares", label: "Quadretti" },
  { id: "ruled", label: "Righe" },
];

/** Anteprima in miniatura del motivo, per riconoscerlo senza leggere. */
function GridPreview({ mode }: { mode: GridMode }) {
  const blue = "rgba(70,120,200,0.55)";
  const grey = "currentColor";
  return (
    <svg viewBox="0 0 28 20" className="h-5 w-7" aria-hidden="true">
      {mode === "dots" &&
        [5, 12, 19].flatMap((y) => [6, 14, 22].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" fill={grey} opacity="0.5" />))}
      {mode === "lines" && (
        <path d="M7 0v20M14 0v20M21 0v20M0 6h28M0 13h28" stroke={grey} strokeWidth="0.8" opacity="0.4" />
      )}
      {mode === "squares" && (
        <path
          d="M4 0v20M8 0v20M12 0v20M16 0v20M20 0v20M24 0v20M0 4h28M0 8h28M0 12h28M0 16h28"
          stroke={blue}
          strokeWidth="0.6"
        />
      )}
      {mode === "ruled" && (
        <>
          <path d="M0 5h28M0 10h28M0 15h28" stroke={blue} strokeWidth="0.7" />
          <path d="M6 0v20" stroke="rgba(220,60,60,0.7)" strokeWidth="0.7" />
        </>
      )}
    </svg>
  );
}

export default function ViewMenu({ wb, ui }: { wb: Whiteboard; ui: UIState }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div ref={ref} className="relative">
      <Btn label="Sfondo, griglia e pagine" align="end" active={open} onClick={() => setOpen(!open)}>
        {icons.palette}
      </Btn>
      {open && (
        <div className={`${panel} animate-pop-in absolute right-0 top-full z-30 mt-2 flex w-72 flex-col gap-4 p-3.5`}>
          <Section label="Sfondo">
            <div className="flex flex-wrap gap-2">
              {BG_PRESETS.map((c) => (
                <Swatch key={c} color={c} label={`Sfondo ${c}`} size="h-7 w-7" active={ui.bgColor === c} onClick={() => wb.setBgColor(c)} />
              ))}
            </div>
          </Section>
          <Section label="Motivo">
            <div className="grid grid-cols-3 gap-1.5">
              {GRIDS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  aria-pressed={ui.grid === g.id}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => wb.setGrid(g.id)}
                  className={`flex flex-col items-center gap-1 rounded-xl px-1 py-1.5 text-[11px] font-medium transition-colors ${
                    ui.grid === g.id
                      ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                      : "bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15"
                  }`}
                >
                  <span className={`rounded-md ${ui.grid === g.id ? "bg-white/90 text-neutral-700" : "bg-white text-neutral-700 dark:bg-neutral-200"}`}>
                    <GridPreview mode={g.id} />
                  </span>
                  {g.label}
                </button>
              ))}
            </div>
          </Section>
          <Section label="Lezione">
            <Switch checked={ui.pageCount > 0} onChange={wb.setPagesMode} label="Pagine in sequenza" />
            <p className={`text-xs ${subtle}`}>
              Fogli uno sotto l&apos;altro, da sfogliare con ‹ › o con i tasti Pagina su/giù. Con la collaborazione attiva, chi
              partecipa può seguire la tua vista.
            </p>
          </Section>
        </div>
      )}
    </div>
  );
}
