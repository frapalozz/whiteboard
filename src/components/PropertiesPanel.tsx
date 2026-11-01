"use client";

import { useState } from "react";
import { HexColorPicker } from "react-colorful";
import { MAX_WIDTH, MIN_WIDTH, PALETTE } from "@/engine/constants";
import { isBoxType, type BoxType, type ToolId, type UIState } from "@/engine/types";
import type { Whiteboard } from "@/engine/whiteboard";
import { icons } from "./icons";
import { panel, Section, Swatch, Switch, subtle } from "./ui";

const DRAW_TOOLS: ToolId[] = ["pen", "eraser", "line", "arrow", "rect", "ellipse", "diamond", "terminal", "data", "text"];
const TITLES: Partial<Record<ToolId, string>> = {
  pen: "Penna",
  eraser: "Gomma",
  line: "Linea",
  arrow: "Freccia",
  rect: "Forme",
  ellipse: "Forme",
  diamond: "Forme",
  terminal: "Forme",
  data: "Forme",
  text: "Testo",
};
/** Le forme, con il loro significato nei diagrammi di flusso. */
const SHAPE_INFO: Record<BoxType, { label: string; icon: keyof typeof icons }> = {
  terminal: { label: "Inizio / fine", icon: "terminal" },
  rect: { label: "Azione (processo)", icon: "rect" },
  diamond: { label: "Decisione (sì / no)", icon: "diamond" },
  data: { label: "Dati (input / output)", icon: "data" },
  ellipse: { label: "Ellisse", icon: "ellipse" },
};
const SHAPE_ORDER: BoxType[] = ["terminal", "rect", "diamond", "data", "ellipse"];

function ShapePicker({ value, onPick }: { value: BoxType | null; onPick: (t: BoxType) => void }) {
  return (
    <div role="radiogroup" aria-label="Forma" className="grid grid-cols-5 gap-1">
      {SHAPE_ORDER.map((t) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={value === t}
          aria-label={SHAPE_INFO[t].label}
          title={SHAPE_INFO[t].label}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(t)}
          className={`grid h-9 place-items-center rounded-xl transition-colors ${
            value === t ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30" : "hover:bg-black/5 dark:hover:bg-white/10"
          }`}
        >
          {icons[SHAPE_INFO[t].icon]}
        </button>
      ))}
    </div>
  );
}
const PRESETS = [2, 4, 8, 16];

/** Pannello proprietà: compare solo quando ha qualcosa da modificare. */
export default function PropertiesPanel({ wb, ui, className = "" }: { wb: Whiteboard; ui: UIState; className?: string }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expanded, setExpanded] = useState(false); // solo mobile: su schermi larghi il pannello è sempre aperto
  const hasSel = ui.selectionCount > 0;
  if (!DRAW_TOOLS.includes(ui.tool) && !hasSel) return null;

  const isEraser = ui.tool === "eraser" && !hasSel;
  const sizeLabel = isEraser ? "Dimensione gomma" : ui.tool === "text" ? "Dimensione testo" : "Spessore";
  const title = hasSel ? `Selezione · ${ui.selectionCount}` : (TITLES[ui.tool] ?? "");
  const customActive = !PALETTE.includes(ui.color) && !ui.recentColors.includes(ui.color);
  const shapeTool = !hasSel && isBoxType(ui.tool);
  const showShapes = shapeTool || (hasSel && ui.showFill);
  const shapeValue = hasSel ? ui.selShape : isBoxType(ui.tool) ? ui.tool : null;
  const hint =
    hasSel ? null
    : shapeTool ? "Clic: forma pronta per scriverci dentro. Trascina: dimensione a piacere."
    : ui.tool === "arrow" || ui.tool === "line" ? "Parti da una forma e arriva su un'altra: il collegamento resta attaccato."
    : null;

  return (
    <div className={`${panel} animate-pop-in flex w-full flex-col gap-4 p-3.5 max-md:gap-0 md:w-60 ${className}`}>
      <button
        type="button"
        aria-expanded={expanded}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-left text-sm font-semibold md:pointer-events-none"
      >
        {!isEraser && (
          <span className="h-4 w-4 rounded-full border border-black/20 md:hidden" style={{ backgroundColor: ui.color }} />
        )}
        <span className="flex-1">{title}</span>
        <span className={`transition-transform md:hidden ${expanded ? "rotate-180" : ""}`}>{icons.chevron}</span>
      </button>
      {showShapes && (
        <div className="flex flex-col gap-1.5 max-md:mt-3">
          <ShapePicker value={shapeValue} onPick={(t) => (hasSel ? wb.setShape(t) : wb.setTool(t))} />
          <p className={`text-xs ${subtle}`}>{shapeValue ? SHAPE_INFO[shapeValue].label : "Forme diverse"}</p>
        </div>
      )}
      {hint && <p className={`text-xs ${subtle} max-md:hidden`}>{hint}</p>}
      <div className={`${expanded ? "flex" : "hidden"} flex-col gap-4 max-md:mt-3 md:flex`}>

      {!isEraser && (
        <Section label="Colore">
          <div className="flex flex-wrap items-center gap-2">
            {PALETTE.map((c) => (
              <Swatch key={c} color={c} active={ui.color === c} onClick={() => wb.setColor(c)} />
            ))}
            {ui.recentColors.map((c) => (
              <Swatch key={c} color={c} active={ui.color === c} onClick={() => wb.setColor(c)} />
            ))}
            <button
              type="button"
              aria-label="Colore personalizzato"
              title="Colore personalizzato"
              aria-pressed={pickerOpen}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPickerOpen((o) => !o)}
              className={`h-6 w-6 rounded-full border border-black/15 transition-transform hover:scale-110 dark:border-white/25 ${
                pickerOpen || customActive
                  ? "ring-2 ring-indigo-500 ring-offset-2 ring-offset-white dark:ring-offset-neutral-900"
                  : ""
              }`}
              style={{
                background: customActive
                  ? ui.color
                  : "conic-gradient(#f43f5e, #f59e0b, #84cc16, #06b6d4, #6366f1, #d946ef, #f43f5e)",
              }}
            />
          </div>
          {pickerOpen && <HexColorPicker color={ui.color} onChange={wb.setColor} style={{ width: "100%", height: 130 }} />}
        </Section>
      )}

      <Section label={sizeLabel}>
        <div className="flex items-center gap-1.5">
          {PRESETS.map((w) => (
            <button
              key={w}
              type="button"
              aria-label={`${sizeLabel} ${w}`}
              aria-pressed={ui.width === w}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => wb.setWidth(w)}
              className={`grid h-9 flex-1 place-items-center rounded-xl transition-colors ${
                ui.width === w ? "bg-indigo-600/10 ring-1 ring-indigo-500" : "hover:bg-black/5 dark:hover:bg-white/10"
              }`}
            >
              <span
                className="rounded-full bg-current"
                style={{ width: Math.min(w, 18) + 2, height: Math.min(w, 18) + 2 }}
              />
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={MIN_WIDTH}
            max={MAX_WIDTH}
            value={ui.width}
            onChange={(e) => wb.setWidth(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer accent-indigo-600"
            aria-label={sizeLabel}
          />
          <span className={`w-6 text-right text-xs tabular-nums ${subtle}`}>{ui.width}</span>
        </div>
      </Section>

      {ui.showFill && <Switch label="Riempi la forma" checked={ui.fill} onChange={wb.setFill} />}
      </div>
    </div>
  );
}
