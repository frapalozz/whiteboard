"use client";

import { useState } from "react";
import type { Whiteboard } from "@/engine/whiteboard";
import Dialog, { fieldCls, primaryBtn } from "./Dialog";
import { subtle } from "./ui";

const EXAMPLE = `flowchart TD
  A([Inizio]) --> B[/Arriva una richiesta/]
  B --> C{È urgente?}
  C -->|Sì| D[Rispondi subito]
  C -->|No| E[Metti in coda]
  D --> F([Fine])
  E --> F`;

export default function MermaidDialog({ wb, onClose, notify }: { wb: Whiteboard; onClose: () => void; notify: (t: string, k?: "ok" | "error") => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  function create() {
    const r = wb.importMermaid(text || EXAMPLE);
    if (!r.ok) {
      setError(r.error ?? "Diagramma non valido");
      return;
    }
    notify(`Diagramma creato: ${r.count} ${r.count === 1 ? "forma" : "forme"}`);
    onClose();
  }

  return (
    <Dialog title="Diagramma da testo" subtitle="Incolla un flowchart Mermaid (anche scritto da un'AI): diventa forme e frecce modificabili, già in ordine." onClose={onClose} wide>
      <textarea
        value={text}
        autoFocus
        rows={10}
        spellCheck={false}
        placeholder={EXAMPLE}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) create();
        }}
        className={`${fieldCls} resize-y font-mono text-xs leading-relaxed`}
      />
      {error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
      <details className={`text-xs ${subtle}`}>
        <summary className="cursor-pointer font-medium">Cosa si può scrivere</summary>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-4">
          <li>
            Direzione: <code>flowchart TD</code> (dall&apos;alto) o <code>LR</code> (da sinistra).
          </li>
          <li>
            Forme: <code>A[azione]</code>, <code>B{"{"}decisione{"}"}</code>, <code>C([inizio/fine])</code>, <code>D[/dati/]</code>,{" "}
            <code>E((cerchio))</code>.
          </li>
          <li>
            Frecce: <code>A --&gt; B</code>, con etichetta <code>A --&gt;|Sì| B</code> o <code>A -- No --&gt; B</code>; linea senza punta{" "}
            <code>A --- B</code>.
          </li>
          <li>Stili, classi e sottogruppi si ignorano.</li>
        </ul>
      </details>
      <button type="button" onClick={create} className={primaryBtn}>
        {text.trim() ? "Crea il diagramma" : "Prova con l'esempio"}
      </button>
    </Dialog>
  );
}
