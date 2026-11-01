"use client";

import { useEffect, useRef } from "react";
import { FONT_FAMILY, LINE_HEIGHT, measureText, wrapText } from "@/engine/geometry";
import type { Camera, TextEdit } from "@/engine/types";
import type { Whiteboard } from "@/engine/whiteboard";

/**
 * Textarea posizionata sopra il canvas per scrivere/modificare un testo.
 * Per l'etichetta di una forma o di una freccia il testo è centrato e va a capo dentro l'area della
 * forma; Invio conferma (Maiusc+Invio per andare a capo).
 */
export default function TextEditor({ wb, edit, camera }: { wb: Whiteboard; edit: TextEdit; camera: Camera }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [edit.session]);

  const z = camera.zoom;
  const label = edit.label;
  let box: { left: number; top: number; width: number; height: number };
  if (label) {
    const area = label.box;
    const { lines, w } = wrapText(edit.text || " ", area.w, edit.fontSize);
    const h = lines.length * edit.fontSize * LINE_HEIGHT;
    const width = Math.min(area.w, Math.max(w + edit.fontSize * 1.2, edit.fontSize * 4));
    box = {
      left: (area.x + (area.w - width) / 2 - camera.x) * z,
      top: (area.y + area.h / 2 - h / 2 - camera.y) * z,
      width: Math.ceil(width * z),
      height: Math.ceil(h * z) + 2,
    };
  } else {
    const m = measureText(edit.text || " ", edit.fontSize);
    box = {
      left: (edit.x - camera.x) * z,
      top: (edit.y - camera.y) * z,
      width: Math.ceil((m.w + edit.fontSize * 0.8) * z),
      height: Math.ceil(m.h * z) + 2,
    };
  }

  return (
    <textarea
      ref={ref}
      value={edit.text}
      spellCheck={false}
      placeholder="Scrivi…"
      aria-label={label ? "Testo della forma" : "Testo"}
      onChange={(e) => wb.updateEditText(edit.session, e.target.value)}
      onBlur={() => wb.commitText(edit.session)}
      onKeyDown={(e) => {
        e.stopPropagation();
        const confirm = e.key === "Enter" && (e.ctrlKey || e.metaKey || (label && !e.shiftKey));
        if (e.key === "Escape" || confirm) {
          e.preventDefault();
          wb.commitText(edit.session);
        }
      }}
      className={`absolute z-20 resize-none overflow-hidden border-0 bg-transparent p-0 outline-dashed outline-1 outline-offset-4 outline-blue-400/80 ${
        label ? "whitespace-pre-wrap break-words text-center" : "whitespace-pre"
      }`}
      style={{
        ...box,
        fontSize: edit.fontSize * z,
        lineHeight: LINE_HEIGHT,
        fontFamily: FONT_FAMILY,
        color: edit.color,
        caretColor: edit.color,
      }}
    />
  );
}
