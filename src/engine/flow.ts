import { centerOf, dist, insideBox } from "./geometry";
import { isBox, isLine, type BoxEl, type El, type LineEl, type Point } from "./types";

/**
 * Diagrammi di flusso: frecce (e linee) agganciate alle forme.
 *
 * Un collegamento ricorda l'id della forma di partenza (`from`) e di arrivo (`to`). I suoi estremi
 * `a`/`b` restano salvati come punti normali (così export, link e versioni vecchie dell'app li
 * disegnano comunque), ma vengono ricalcolati da `resolveConnectors` ogni volta che il documento
 * cambia: ogni estremo agganciato sta sul contorno della sua forma, sulla retta verso l'altro capo.
 *
 * Il calcolo è deterministico e restituisce gli stessi oggetti quando nulla si muove: in
 * collaborazione due partecipanti che ricalcolano la stessa freccia scrivono lo stesso valore e il
 * merge si ferma subito.
 */

const EPS = 0.01;

/** Punto del contorno di `box` sulla semiretta dal centro verso `toward`, spostato in fuori di `gap`. */
export function boxAnchor(box: BoxEl, toward: Point, gap: number): Point {
  const c = centerOf(box);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: c.x, y: box.y - gap };
  const ux = dx / len;
  const uy = dy / len;
  // ricerca binaria del bordo: vale per tutte le forme (anche quelle senza formula semplice)
  let lo = 0;
  let hi = Math.hypot(box.w, box.h) / 2 + 1;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (insideBox(box, { x: c.x + ux * mid, y: c.y + uy * mid })) lo = mid;
    else hi = mid;
  }
  return { x: c.x + ux * (hi + gap), y: c.y + uy * (hi + gap) };
}

/** Spazio tra il contorno della forma e la punta: la freccia tocca il bordo senza coprirlo. */
const gapFor = (box: BoxEl, line: LineEl) => box.width / 2 + line.width / 2 + 2;

const close = (p: Point, q: Point) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;

/** Ricalcola gli estremi agganciati di un collegamento (stesso oggetto se non cambia nulla). */
export function resolveLine(line: LineEl, get: (id: string) => El | undefined): LineEl {
  const fa = line.from ? get(line.from) : undefined;
  const fb = line.to && line.to !== line.from ? get(line.to) : undefined;
  const A = fa && isBox(fa) ? fa : null;
  const B = fb && isBox(fb) ? fb : null;
  if (!A && !B) return line;
  const ca = A ? centerOf(A) : line.a;
  const cb = B ? centerOf(B) : line.b;
  const a = A ? boxAnchor(A, cb, gapFor(A, line)) : line.a;
  const b = B ? boxAnchor(B, ca, gapFor(B, line)) : line.b;
  if (close(a, line.a) && close(b, line.b)) return line;
  return { ...line, a, b };
}

const resolved = new WeakMap<El[], El[]>();

/**
 * Aggiorna tutti i collegamenti agganciati. Restituisce lo stesso array se nulla cambia.
 * Un collegamento la cui forma non esiste più (cancellata) resta dov'è e mantiene l'aggancio:
 * se la forma torna (annulla), torna attaccato.
 */
export function resolveConnectors(els: El[]): El[] {
  const hit = resolved.get(els);
  if (hit) return hit;
  let any = false;
  for (const el of els) {
    if (isLine(el) && (el.from || el.to)) {
      any = true;
      break;
    }
  }
  if (!any) {
    resolved.set(els, els);
    return els;
  }
  const byId = new Map<string, El>();
  for (const el of els) byId.set(el.id, el);
  let changed = false;
  const out = els.map((el) => {
    if (!isLine(el) || (!el.from && !el.to)) return el;
    const r = resolveLine(el, (id) => byId.get(id));
    if (r !== el) changed = true;
    return r;
  });
  const res = changed ? out : els;
  resolved.set(els, res);
  resolved.set(res, res);
  return res;
}

/** Forma più in alto che contiene `p` (allargata di `tol`): è quella a cui si aggancia un estremo. */
export function bindTargetAt(els: El[], p: Point, tol: number, exclude?: string): BoxEl | null {
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (el.id !== exclude && isBox(el) && insideBox(el, p, tol)) return el;
  }
  return null;
}

/**
 * Spostando un collegamento senza la sua forma, l'aggancio si stacca (altrimenti tornerebbe subito
 * attaccato alla forma). `moving`: id degli elementi spostati insieme.
 */
export function detachFrom(line: LineEl, moving: Set<string>): LineEl {
  const keepFrom = !!line.from && moving.has(line.from);
  const keepTo = !!line.to && moving.has(line.to);
  if ((!line.from || keepFrom) && (!line.to || keepTo)) return line;
  const next: LineEl = { ...line };
  if (!keepFrom) delete next.from;
  if (!keepTo) delete next.to;
  return next;
}

/** Copie di elementi: gli agganci puntano alle copie delle forme, o si staccano se la forma non è copiata. */
export function remapBindings(copies: El[], idMap: Map<string, string>): El[] {
  return copies.map((el) => {
    if (!isLine(el) || (!el.from && !el.to)) return el;
    const next: LineEl = { ...el };
    const f = el.from ? idMap.get(el.from) : undefined;
    const t = el.to ? idMap.get(el.to) : undefined;
    if (f) next.from = f;
    else delete next.from;
    if (t) next.to = t;
    else delete next.to;
    return next;
  });
}

/** Distanza minima dello schermo per considerare un collegamento disegnato (non un clic). */
export const isTinyLine = (l: LineEl, zoom: number) => !l.from && !l.to && dist(l.a, l.b) * zoom < 3;
