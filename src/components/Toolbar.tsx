"use client";

import { useRef } from "react";
import { isBoxType, type BoxType, type ToolId, type UIState } from "@/engine/types";
import type { Whiteboard } from "@/engine/whiteboard";
import { icons, type IconName } from "./icons";
import { Btn, panel } from "./ui";

type ToolDef = { id: ToolId; label: string; key: string; icon: IconName };

/** Un solo pulsante per tutte le forme: riattiva l'ultima usata, le altre si scelgono nel pannello. */
const SHAPES: ToolDef = { id: "rect", label: "Forme e diagrammi", key: "R", icon: "rect" };

const GROUPS: ToolDef[][] = [
  [
    { id: "select", label: "Seleziona", key: "V", icon: "select" },
    { id: "hand", label: "Sposta vista", key: "H", icon: "hand" },
  ],
  [
    { id: "pen", label: "Penna", key: "P", icon: "pen" },
    { id: "eraser", label: "Gomma", key: "E", icon: "eraser" },
  ],
  [
    { id: "line", label: "Linea", key: "L", icon: "line" },
    { id: "arrow", label: "Freccia (si aggancia alle forme)", key: "A", icon: "arrow" },
    SHAPES,
  ],
  [
    { id: "text", label: "Testo", key: "T", icon: "text" },
    { id: "note", label: "Nota adesiva", key: "N", icon: "note" },
  ],
  [
    { id: "laser", label: "Puntatore laser", key: "K", icon: "laser" },
    { id: "comment", label: "Commenti", key: "C", icon: "comment" },
  ],
];

const SHAPE_ICON: Record<BoxType, IconName> = {
  rect: "rect",
  ellipse: "ellipse",
  diamond: "diamond",
  terminal: "terminal",
  data: "data",
  note: "note",
};

const isShape = (t: ToolId) => isBoxType(t) && t !== "note";

export default function Toolbar({ wb, ui, notify }: { wb: Whiteboard; ui: UIState; notify: (text: string, kind?: "ok" | "error") => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div
      role="toolbar"
      aria-label="Strumenti"
      className={`${panel} flex max-w-full items-center gap-1 overflow-x-auto p-1.5 lg:overflow-visible`}
    >
      {GROUPS.map((group, gi) => (
        <div key={gi} className="flex items-center gap-0.5">
          {gi > 0 && <div className="mr-1 h-6 w-px shrink-0 bg-black/10 dark:bg-white/15" />}
          {group.map((t) =>
            t === SHAPES ? (
              <Btn
                key="shapes"
                label={t.label}
                shortcut={t.key}
                active={isShape(ui.tool)}
                onClick={() => wb.setTool(ui.lastShape)}
              >
                {icons[SHAPE_ICON[isShape(ui.tool) ? (ui.tool as BoxType) : ui.lastShape]]}
              </Btn>
            ) : (
              <Btn key={t.id} label={t.label} shortcut={t.key} active={ui.tool === t.id} onClick={() => wb.setTool(t.id)}>
                {icons[t.icon]}
              </Btn>
            ),
          )}
        </div>
      ))}
      <div className="flex items-center gap-0.5">
        <div className="mr-1 h-6 w-px shrink-0 bg-black/10 dark:bg-white/15" />
        <Btn label="Inserisci immagine o PDF" onClick={() => fileRef.current?.click()} align="end">
          {icons.upload}
        </Btn>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf,.pdf"
          multiple
          hidden
          onChange={async (e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (!files.length) return;
            const r = await wb.insertFiles(files);
            if (!r.ok) notify(r.error ?? "Impossibile inserire il file", "error");
          }}
        />
      </div>
    </div>
  );
}
