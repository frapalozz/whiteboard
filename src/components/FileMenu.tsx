"use client";

import type { UIState } from "@/engine/types";
import type { Whiteboard } from "@/engine/whiteboard";
import { icons } from "./icons";
import { Btn, MenuItem, panel, usePopover } from "./ui";

export default function FileMenu({ wb, ui, onImport, onShare }: { wb: Whiteboard; ui: UIState; onImport: () => void; onShare: () => void }) {
  const { open, setOpen, ref } = usePopover();
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div ref={ref} className="relative">
      <Btn label="Esporta e importa" align="end" active={open} onClick={() => setOpen(!open)}>
        {icons.save}
      </Btn>
      {open && (
        <div className={`${panel} animate-pop-in absolute right-0 top-full z-30 mt-2 w-72 p-1.5`}>
          <MenuItem icon={icons.link} label="Copia link di condivisione" hint="Il link contiene tutta la lavagna" onClick={run(onShare)} />
          <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
          <MenuItem icon={icons.image} label="Esporta come immagine" hint="PNG di tutto il contenuto" onClick={run(() => void wb.exportPNG())} />
          <MenuItem icon={icons.save} label="Esporta lavagna" hint="File .json, per backup o altri dispositivi" onClick={run(() => wb.exportJSON())} />
          <MenuItem icon={icons.open} label="Importa lavagna…" hint="Apre un file .json come nuova lavagna" onClick={run(onImport)} />
          <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
          <MenuItem icon={icons.trash} label="Svuota questa lavagna" danger disabled={!ui.hasContent || ui.readOnly} onClick={run(wb.clear)} />
        </div>
      )}
    </div>
  );
}
