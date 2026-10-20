"use client";

import { useEffect, useState } from "react";
import { relaySupported } from "@/engine/collab/relay";
import { webrtcSupported } from "@/engine/collab/session";
import { decodeInvite, type AnyInvite } from "@/engine/collab/signaling";
import type { UIState } from "@/engine/types";
import type { Whiteboard } from "@/engine/whiteboard";
import { icons } from "./icons";
import { Switch, subtle } from "./ui";

interface Props {
  wb: Whiteboard;
  ui: UIState;
  /** Invito arrivato da un link (`#collab=…`), da proporre per l'unione. */
  invite: string | null;
  onClose: () => void;
  notify: (text: string, kind?: "ok" | "error") => void;
}

const primary =
  "flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-indigo-600/25 transition-all hover:bg-indigo-500 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
const secondary =
  "flex items-center justify-center gap-2 rounded-xl bg-black/5 px-3 py-2 text-sm font-semibold transition-colors hover:bg-black/10 disabled:pointer-events-none disabled:opacity-40 dark:bg-white/10 dark:hover:bg-white/15";
const field =
  "w-full rounded-xl bg-black/5 px-3 py-2 text-sm outline-none ring-indigo-500 placeholder:text-neutral-400 focus:ring-2 dark:bg-white/10";
const label = `text-[11px] font-semibold uppercase tracking-wider ${subtle}`;

async function copy(text: string, notify: Props["notify"], what: string) {
  try {
    await navigator.clipboard.writeText(text);
    notify(`${what} copiato negli appunti`);
  } catch {
    window.prompt(`Copia ${what.toLowerCase()}:`, text);
  }
}

const canShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

/** Foglio di condivisione del sistema (telefono), altrimenti appunti. */
async function share(data: { url?: string; text?: string }, notify: Props["notify"], what: string) {
  if (canShare()) {
    try {
      await navigator.share(data);
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }
  await copy(data.url ?? data.text ?? "", notify, what);
}

function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

function Icon({ children }: { children: React.ReactNode }) {
  return <span className="[&>svg]:h-4 [&>svg]:w-4">{children}</span>;
}

export default function CollabDialog({ wb, ui, invite, onClose, notify }: Props) {
  const c = ui.collab;
  const [name, setName] = useState(c.name);
  const [joinText, setJoinText] = useState(invite ?? "");
  /** Esito della decodifica di `joinText` (l'invito, o null se non valido). */
  const [decoded, setDecoded] = useState<{ text: string; inv: AnyInvite | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Link della stanza (riutilizzabile, con il relay). */
  const [roomUrl, setRoomUrl] = useState<string | null>(null);
  /** Invito manuale per una persona. */
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [answerIn, setAnswerIn] = useState("");
  /** Il codice di risposta da mandare a chi ci ha invitato (ospite, invito manuale). */
  const [answerOut, setAnswerOut] = useState<string | null>(null);
  const supported = webrtcSupported();
  const relayOk = c.relay && relaySupported();
  const relayDown = c.relayState === "error";
  const preview = joinText.trim() && decoded?.text === joinText ? decoded.inv : null;
  const invalid = !!joinText.trim() && decoded?.text === joinText && !decoded.inv;

  useEffect(() => {
    wb.setPaused(true);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      wb.setPaused(false);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // anteprima dell'invito incollato/aperto: chi invita e su quale lavagna
  useEffect(() => {
    let alive = true;
    if (!joinText.trim()) return;
    void decodeInvite(joinText).then((inv) => alive && setDecoded({ text: joinText, inv }));
    return () => {
      alive = false;
    };
  }, [joinText]);

  // il link della stanza si ricava dalla stanza: pronto appena la collaborazione è attiva
  const active = c.mode !== "off";
  useEffect(() => {
    if (!active || !relayOk) return setRoomUrl(null);
    let alive = true;
    void wb.getRoomLink().then((r) => alive && r.ok && setRoomUrl(r.url));
    return () => {
      alive = false;
    };
  }, [wb, active, relayOk, c.room, c.name]);

  // quando qualcuno si collega, l'invito manuale e la risposta pendenti hanno fatto il loro lavoro
  const peerCount = c.peers.length;
  useEffect(() => {
    if (peerCount > 0) {
      setInviteUrl(null);
      setAnswerIn("");
      setAnswerOut(null);
    }
  }, [peerCount]);

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  }

  function start() {
    const r = wb.startCollab(name);
    if (!r.ok) setError(r.error);
    else if (!relayOk) void makeInvite();
  }

  async function makeInvite() {
    const r = await run(() => wb.createInvite());
    if (!r) return;
    if (r.ok) setInviteUrl(r.url);
    else setError(r.error);
  }

  async function connect() {
    const r = await run(() => wb.acceptAnswer(answerIn));
    if (!r) return;
    if (r.ok) {
      setAnswerIn("");
      notify("Risposta accettata: collegamento in corso…");
    } else setError(r.error);
  }

  async function join() {
    wb.setCollabName(name);
    const r = await run(() => wb.joinCollab(joinText, name));
    if (!r) return;
    if (r.ok) {
      setAnswerOut(r.answer);
      setJoinText("");
      if (!r.answer) notify(r.resumed ? "Rientro nella stanza…" : "Collegamento in corso…");
    } else setError(r.error);
  }

  const you = (
    <li className="flex items-center gap-2 text-sm">
      <Dot color={c.color} />
      <span className="truncate font-medium">{c.name || "Ospite"}</span>
      <span className={`text-xs ${subtle}`}>(tu)</span>
    </li>
  );

  const relayStatus =
    c.relayState === "on"
      ? { color: "bg-emerald-500", text: "Collegamento automatico attivo" }
      : c.relayState === "connecting"
        ? { color: "bg-amber-400 animate-pulse", text: "Connessione al relay…" }
        : c.relayState === "error"
          ? { color: "bg-red-500", text: "Relay non raggiungibile: usa l'invito manuale qui sotto" }
          : null;

  const manualInvite = (
    <div className="flex flex-col gap-2">
      {!inviteUrl ? (
        <button type="button" disabled={busy} onClick={() => void makeInvite()} className={secondary}>
          <Icon>{icons.link}</Icon>
          {busy ? "Preparo l'invito…" : "Crea invito per una persona"}
        </button>
      ) : (
        <>
          <ol className={`list-decimal pl-4 text-xs ${subtle}`}>
            <li>Manda il link alla persona.</li>
            <li>Lei lo apre e ti rimanda un codice di risposta.</li>
            <li>Incollalo qui sotto.</li>
          </ol>
          <div className="flex gap-2">
            {canShare() && (
              <button type="button" className={`${secondary} flex-1`} onClick={() => void share({ url: inviteUrl }, notify, "Link")}>
                <Icon>{icons.share}</Icon>
                Condividi
              </button>
            )}
            <button type="button" className={`${secondary} flex-1`} onClick={() => void copy(inviteUrl, notify, "Link")}>
              <Icon>{icons.copy}</Icon>
              Copia link
            </button>
          </div>
          <textarea
            value={answerIn}
            rows={3}
            placeholder="Incolla qui il codice di risposta"
            onChange={(e) => setAnswerIn(e.target.value)}
            className={`${field} resize-none font-mono text-xs`}
          />
          <button type="button" disabled={busy || !answerIn.trim()} onClick={() => void connect()} className={primary}>
            Collega
          </button>
          <p className={`text-xs ${subtle}`}>
            Il link vale per una sola persona. Per un&apos;altra, creane uno nuovo. Il collegamento parte quando entrambi avete la
            pagina aperta: se l&apos;altra persona è al telefono, chiedile di tornare sul browser.
          </p>
        </>
      )}
    </div>
  );

  return (
    <div className="animate-fade-in fixed inset-0 z-40 grid place-items-center bg-black/30 p-3 backdrop-blur-sm" onPointerDown={onClose}>
      <div
        role="dialog"
        aria-label="Collaborazione in tempo reale"
        onPointerDown={(e) => e.stopPropagation()}
        className="animate-pop-in flex max-h-[calc(100dvh-1.5rem)] w-full max-w-md flex-col gap-4 overflow-y-auto overscroll-contain rounded-2xl bg-neutral-50 p-5 text-neutral-900 shadow-2xl dark:bg-neutral-900 dark:text-neutral-100"
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Collabora in tempo reale</h2>
            <p className={`mt-0.5 text-xs ${subtle}`}>Peer-to-peer: i disegni passano direttamente tra i dispositivi, senza server.</p>
          </div>
          <button type="button" aria-label="Chiudi" onClick={onClose} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg hover:bg-black/5 dark:hover:bg-white/10 [&>svg]:h-4 [&>svg]:w-4">
            {icons.close}
          </button>
        </header>

        {!supported && <p className="rounded-xl bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">Questo browser non supporta WebRTC.</p>}

        <label className="flex flex-col gap-1.5">
          <span className={label}>Il tuo nome</span>
          <input
            value={name}
            maxLength={24}
            placeholder="Ospite"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => wb.setCollabName(name)}
            className={field}
          />
        </label>

        {c.mode === "off" ? (
          <>
            {preview && (
              <section className="flex flex-col gap-2 rounded-xl bg-indigo-500/10 p-3">
                <p className="text-sm">
                  <b>{preview.n || "Qualcuno"}</b> ti invita a collaborare su <b>«{preview.b || "Lavagna condivisa"}»</b>.
                </p>
                <button type="button" disabled={!supported || busy || !!answerOut} onClick={() => void join()} className={primary}>
                  <Icon>{icons.users}</Icon>
                  {busy ? "Preparo il collegamento…" : "Unisciti"}
                </button>
                <p className={`text-xs ${subtle}`}>Si apre come nuova lavagna nella tua libreria; quella aperta ora non viene toccata.</p>
              </section>
            )}

            {!preview && (
              <div className="flex flex-col gap-2">
                <button type="button" disabled={!supported || busy} onClick={start} className={primary}>
                  <Icon>{icons.users}</Icon>
                  Collabora su questa lavagna
                </button>
                <p className={`text-xs ${subtle}`}>Ottieni un link da mandare a chi vuoi. La lavagna resta anche nel tuo browser e funziona offline.</p>
              </div>
            )}

            <div className="flex items-center gap-3 text-xs text-neutral-400">
              <span className="h-px flex-1 bg-current opacity-30" />
              {preview ? "oppure incolla un altro invito" : "oppure"}
              <span className="h-px flex-1 bg-current opacity-30" />
            </div>

            <div className="flex flex-col gap-2">
              {!preview && <span className={label}>Unisciti a una lavagna</span>}
              <textarea
                value={joinText}
                rows={2}
                placeholder="Incolla qui il link o il codice d'invito"
                onChange={(e) => setJoinText(e.target.value)}
                className={`${field} resize-none font-mono text-xs`}
              />
              {invalid && <p className="text-xs text-red-600 dark:text-red-400">Invito non valido o incompleto.</p>}
            </div>
          </>
        ) : (
          <>
            {relayStatus && (
              <p className="flex items-center gap-2 text-xs">
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${relayStatus.color}`} />
                {relayStatus.text}
              </p>
            )}

            <section className="flex flex-col gap-2">
              <span className={label}>Partecipanti</span>
              <ul className="flex flex-col gap-1.5">
                {you}
                {c.peers.map((p) => (
                  <li key={p.site} className="flex items-center gap-2 text-sm">
                    <Dot color={p.color} />
                    <span className="truncate">{p.name}</span>
                  </li>
                ))}
              </ul>
              {c.peers.length === 0 && !answerOut && (
                <p className={`text-xs ${subtle}`}>
                  {c.relayState === "on" || c.relayState === "connecting"
                    ? c.mode === "guest"
                      ? "In attesa degli altri partecipanti: il collegamento parte da solo appena qualcuno della stanza ha la lavagna aperta."
                      : "Nessuno collegato. Manda il link qui sotto: chi lo apre entra da solo."
                    : "Nessuno collegato. Invita qualcuno qui sotto."}
                </p>
              )}
            </section>

            {answerOut && (
              <section className="flex flex-col gap-2 rounded-xl bg-indigo-500/10 p-3">
                <p className="text-sm font-medium">Ultimo passo: manda questo codice a chi ti ha invitato</p>
                <p className={`text-xs ${subtle}`}>
                  Quando lo incolla nella sua finestra, il collegamento parte da solo. Dal telefono: dopo averlo inviato torna subito su
                  questa pagina e tienila aperta finché non risulti collegato.
                </p>
                <textarea readOnly rows={3} value={answerOut} onFocus={(e) => e.currentTarget.select()} className={`${field} resize-none font-mono text-xs`} />
                <div className="flex gap-2">
                  {canShare() && (
                    <button type="button" className={`${secondary} flex-1`} onClick={() => void share({ text: answerOut }, notify, "Codice")}>
                      <Icon>{icons.share}</Icon>
                      Condividi
                    </button>
                  )}
                  <button type="button" className={`${secondary} flex-1`} onClick={() => void copy(answerOut, notify, "Codice")}>
                    <Icon>{icons.copy}</Icon>
                    Copia codice
                  </button>
                </div>
              </section>
            )}

            {relayOk ? (
              <section className="flex flex-col gap-2">
                <span className={label}>Invita</span>
                <div className="flex gap-2">
                  {canShare() && (
                    <button type="button" disabled={!roomUrl} className={`${relayDown ? secondary : primary} flex-1`} onClick={() => roomUrl && void share({ url: roomUrl }, notify, "Link")}>
                      <Icon>{icons.share}</Icon>
                      Condividi link
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!roomUrl}
                    className={canShare() || relayDown ? `${secondary} flex-1` : primary}
                    onClick={() => roomUrl && void copy(roomUrl, notify, "Link")}
                  >
                    <Icon>{icons.copy}</Icon>
                    Copia link
                  </button>
                </div>
                <p className={`text-xs ${subtle}`}>
                  Un solo link per tutti: chi lo apre entra da solo, senza codici da rimandarti. Puoi uscire dal browser per inviarlo; se
                  la connessione cade (telefono in background, ricaricamento) si riforma da sola al ritorno.
                </p>
                <details className="rounded-xl bg-black/5 p-3 dark:bg-white/10" open={c.relayState === "error"}>
                  <summary className="cursor-pointer text-sm font-medium">Invito manuale (senza relay)</summary>
                  <div className="mt-2">{manualInvite}</div>
                </details>
              </section>
            ) : (
              <section className="flex flex-col gap-2">
                <span className={label}>Invita una persona</span>
                {manualInvite}
              </section>
            )}

            {c.peers.length === 0 && !answerOut && (
              <details className="rounded-xl bg-black/5 p-3 dark:bg-white/10" open={c.mode === "guest" && !relayOk}>
                <summary className="cursor-pointer text-sm font-medium">Riconnettiti con un invito</summary>
                <div className="mt-2 flex flex-col gap-2">
                  <p className={`text-xs ${subtle}`}>Incolla un link o un invito di qualcuno che è ancora nella stanza.</p>
                  <textarea value={joinText} rows={2} placeholder="Link o codice d'invito" onChange={(e) => setJoinText(e.target.value)} className={`${field} resize-none font-mono text-xs`} />
                  <button type="button" disabled={busy || !joinText.trim()} onClick={() => void join()} className={secondary}>
                    Riconnetti
                  </button>
                </div>
              </details>
            )}

            <button
              type="button"
              onClick={() => {
                wb.stopCollab();
                setInviteUrl(null);
                setAnswerOut(null);
                notify("Collaborazione terminata: la lavagna resta in questo browser");
              }}
              className="rounded-xl px-3 py-2 text-sm font-semibold text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
            >
              Esci dalla collaborazione
            </button>
          </>
        )}

        {error && <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">{error}</p>}

        <details className={`text-xs ${subtle}`}>
          <summary className="cursor-pointer font-medium">Privacy e impostazioni</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p>
              I disegni passano solo da dispositivo a dispositivo. Chi ha il link diventa un partecipante a tutti gli effetti, e può
              modificare e cancellare: condividilo solo con chi vuoi. Il lavoro è salvato in ogni browser e si riunisce alla riconnessione.
            </p>
            <div className="rounded-xl bg-black/5 p-3 dark:bg-white/10">
              <Switch checked={c.relay} onChange={(v) => wb.setCollabRelay(v)} label="Collegamento automatico (relay)" />
              <p className="mt-1.5">
                Per trovarsi, i dispositivi si scambiano i dati di connessione attraverso broker MQTT pubblici, cifrati con una chiave che
                sta solo nel link: il broker non può leggerli e non vede mai i disegni. Disattivalo per usare solo inviti manuali (link +
                codice di risposta), senza alcun server.
              </p>
            </div>
            <div className="rounded-xl bg-black/5 p-3 dark:bg-white/10">
              <Switch checked={c.stun} onChange={(v) => wb.setCollabStun(v)} label="Usa un server STUN pubblico" />
              <p className="mt-1.5">
                Serve per collegarsi attraverso reti diverse (casa, ufficio, rete mobile). Il server STUN vede il tuo indirizzo IP, mai i
                disegni. Disattivalo per collaborare solo nella stessa rete locale.
              </p>
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
