import { detachFrom, resolveConnectors } from "./flow";
import { scaleEl, translateEl } from "./geometry";
import { isLine, type El } from "./types";

/**
 * Anteprima di un trascinamento in corso, condivisa in tempo reale con gli altri partecipanti.
 *
 * Non manda gli elementi ma solo la trasformazione: chi la riceve la applica alla propria copia
 * (spostamento `m = [dx, dy]`, ridimensionamento `m = [ax, ay, sx, sy]`), quindi il messaggio resta
 * piccolo anche con tratti da migliaia di punti. Per l'estremo di una freccia si manda la freccia (`el`).
 * È effimera come i cursori: non entra nel documento; al rilascio arrivano le modifiche vere.
 */
export type MovePreview = { ids: string[]; m: number[] } | { ids: string[]; el: El };

export const MAX_MOVE_IDS = 2000;

/** Elementi con l'anteprima applicata (stesso array se non tocca nulla). */
export function applyMove(els: El[], pv: MovePreview): El[] {
  if (!pv.ids.length) return els;
  const ids = new Set(pv.ids);
  let hit = false;
  const out = els.map((el) => {
    if (!ids.has(el.id)) return el;
    hit = true;
    let next: El;
    if ("el" in pv) next = pv.el.id === el.id ? pv.el : el;
    else if (pv.m.length === 2) next = translateEl(el, pv.m[0], pv.m[1]);
    else next = scaleEl(el, pv.m[0], pv.m[1], pv.m[2], pv.m[3]);
    // come per chi trascina: una freccia spostata senza le sue forme si stacca
    return "el" in pv || !isLine(next) ? next : detachFrom(next, ids);
  });
  return hit ? resolveConnectors(out) : els;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Chiave per non rimandare la stessa anteprima. */
export function moveKey(pv: MovePreview | null): string {
  if (!pv) return "";
  const head = `${pv.ids.length}:${pv.ids[0]}:${pv.ids[pv.ids.length - 1]}`;
  return "el" in pv ? `${head}|${JSON.stringify(pv.el)}` : `${head}|${pv.m.map(r3).join(",")}`;
}
