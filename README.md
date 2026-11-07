# Whiteboard infinita

Lavagna infinita in Next.js + canvas 2D. Tutta la logica sta in `src/engine` (TypeScript puro, senza React);
la UI in `src/components` è un guscio sottile che legge lo stato tramite `useSyncExternalStore`.

```bash
npm install
npm run dev        # http://localhost:3000
npm run lint
npm run typecheck
```

## Funzioni

- **Strumenti**: selezione, mano, penna (tratti lisci), gomma a oggetti, linea, freccia, forme, testo multilinea.
- **Diagrammi di flusso**: il pulsante "Forme" offre inizio/fine, azione (rettangolo), decisione (rombo), dati
  (input/output, parallelogramma) ed ellisse. Un clic piazza una forma già pronta per scriverci dentro; trascinando la si
  disegna della misura voluta. Il testo nelle forme è centrato e va a capo, e la forma si allarga se non ci sta
  (doppio clic, Invio sulla forma selezionata o lo strumento Testo per scriverci). Le frecce (e le linee) che partono o
  arrivano dentro una forma vi restano agganciate: spostando o ridimensionando le forme, le frecce le seguono. Selezionando
  una freccia, i pallini agli estremi si trascinano per staccarla o agganciarla a un'altra forma (pieno = agganciato), e un
  doppio clic ci scrive sopra un'etichetta ("Sì", "No"). Con una forma selezionata, i "+" sui lati liberi creano la forma
  successiva già collegata. Il pannello cambia il tipo delle forme selezionate senza perdere testo e frecce. Duplicando o
  copiando forme e frecce insieme, le copie restano collegate tra loro.
- **Selezione**: click, Shift+click, rettangolo di selezione, spostamento, ridimensionamento dagli angoli (Shift = proporzioni),
  frecce per spostare (Shift = ×10), duplica, copia/taglia/incolla, primo piano / sullo sfondo, elimina.
- **Stile**: colore (palette, recenti, selettore libero), spessore, riempimento forme, sfondo e motivo (punti, griglia, quadretti, righe con margine). Con una selezione attiva le modifiche si applicano agli elementi selezionati.
- **Camera**: pan con rotella/trackpad, Spazio+trascina, tasto destro o centrale; zoom con Ctrl+rotella/pinch ancorato al cursore; pinch e pan a due dita su touch; "adatta al contenuto".
- **Undo/redo** illimitati nella pratica (200 passi), anche per gomma, import e svuota.
- **Libreria di lavagne** salvata nel browser (localStorage): crea, apri, rinomina, duplica ed elimina lavagne dal
  pannello "Le mie lavagne", con anteprima (su telefono come elenco compatto). "Seleziona" permette di eliminarne più insieme. Ogni lavagna si salva da sola (contenuto, vista, sfondo) e si riapre
  com'era. Chi arriva dalla versione a lavagna singola trova il suo lavoro migrato in "Lavagna 1".
- **Export / import**: PNG di tutto il contenuto, JSON di una lavagna (dal menu File o dalla card in libreria).
  Importare un `.json` crea sempre una *nuova* lavagna, senza toccare quella aperta.
- **Condivisione via link**: dal menu File, "Copia link di condivisione" crea un URL che contiene l'intera lavagna
  (elementi, sfondo, griglia, nome), compressa nel fragment `#lavagna=…` — nessun server né database. Chi apre il link
  ottiene una *nuova* lavagna nella propria libreria (quella aperta non viene toccata) e il fragment viene rimosso
  dall'indirizzo, così un ricaricamento non la importa due volte. Le coordinate sono arrotondate al centesimo.
  Lavagne molto ricche generano link lunghi: oltre ~8 KB alcune app di messaggistica possono troncarli (l'app avvisa);
  oltre ~1,5 MB il link viene rifiutato e conviene l'export `.json`.
- **Collaborazione in tempo reale (P2P)**: più persone disegnano sulla stessa lavagna via WebRTC, i disegni passano solo da
  dispositivo a dispositivo. Pulsante "Collabora" in alto a destra: si manda un link e chi lo apre entra da solo (collegamento
  automatico); se il telefono mette il browser in background o la pagina si ricarica, la connessione si riforma da sola.
  Resta disponibile l'invito manuale (link + codice di risposta) senza alcun server.
  Cursori con nome, tratti visibili mentre vengono disegnati, spostamenti e ridimensionamenti visibili mentre avvengono, undo/redo che annulla solo le *tue* azioni. Vedi sotto.
- **Permessi**: avviando la collaborazione scegli se chi entra con il link può *modificare* o *solo guardare*. Dopo puoi
  cambiare idea per tutti (interruttore "Chi entra può modificare") o per una singola persona (pulsante accanto al suo nome).
  Chi è in sola lettura vede tutto in tempo reale, si muove, segue la lezione, e può premere "Chiedi di modificare": la
  richiesta compare a chi ha avviato la collaborazione con "Consenti" / "Ignora".
- **Modalità lezione**: dal menu "Sfondo, griglia e pagine" si attivano le *pagine in sequenza*: fogli 16:10 uno sotto
  l'altro, con lo sfondo a quadretti o a righe come un quaderno. Una barra in basso (in alto sul telefono) sfoglia le pagine
  (‹ ›, Pagina su/giù, o le frecce quando non c'è niente di selezionato), ne aggiunge una in fondo o elimina quella corrente
  con il suo contenuto (le successive salgono; Ctrl+Z la ripristina). Il numero di pagine viaggia nel file `.json`, nel link
  di condivisione e nella collaborazione.
- **Segui l'insegnante**: in collaborazione, "Fatti seguire da tutti" fa vedere a ogni partecipante quello che vedi tu
  (pagina, zoom, spostamenti); chi entra a lezione iniziata ti segue subito. Si può anche seguire una persona sola dal
  pulsante "Segui" accanto al suo nome. Chi segue può scrivere sulla pagina; appena sposta la vista da solo smette di
  seguire, e la barra della lezione mostra chi stai seguendo con un pulsante per smettere.
- **Bordi che guidano**: trascinando un elemento (o una forma, una freccia, un ridimensionamento, una selezione) vicino al
  bordo dello schermo la lavagna scorre da sola in quella direzione, più veloce quanto più ti avvicini. Ai bordi una striscia
  di pochi pixel, del colore dell'elemento e alla sua altezza (o larghezza), segnala ciò che è fuori dalla vista; se due
  elementi stanno nella stessa direzione si vede il più vicino.
- **Interfaccia**: pannelli "vetro" chiari o scuri secondo il tema del sistema, strumenti raggruppati con tooltip e
  scorciatoie, pannello proprietà contestuale, notifiche, layout adattato a mobile e touch.
- Supporto mouse, touch e penna (Pointer Events), schermi HiDPI, ridimensionamento finestra.

## Scorciatoie

| Tasto | Azione | Tasto | Azione |
|---|---|---|---|
| V | Seleziona | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y | Annulla / Ripeti |
| H | Mano | Ctrl+A | Seleziona tutto |
| P o B | Penna | Ctrl+C / X / V / D | Copia / Taglia / Incolla / Duplica |
| E | Gomma | Canc | Elimina selezione |
| L / A | Linea / Freccia | ] / [ | Primo piano / Sfondo |
| R / O / D | Forme: rettangolo / ellisse / decisione | 1 | Adatta al contenuto |
| T | Testo (doppio click per modificare) | Ctrl+0 / Ctrl+± | Zoom 100% / Zoom |
| Invio | Scrivi nella forma, freccia o testo selezionato | Maiusc+Invio (scrivendo in una forma) | A capo |
| Shift (mentre disegni) | Angoli a 15° / quadrato | Esc | Deseleziona / chiudi testo |
| Pag ↓ / Pag ↑ | Pagina successiva / precedente | ← → ↑ ↓ (senza selezione) | Cambia pagina (con le pagine attive) |

## Architettura

```
src/engine/
  types.ts       tipi (Camera, elementi, stato UI)
  geometry.ts    bounds, hit-test, trasformazioni, semplificazione tratti (RDP), forme ed etichette
  flow.ts        frecce agganciate alle forme (ancoraggio sul contorno, ricalcolo, copia)
  render.ts      disegno di elementi e griglia (usato anche dall'export), LOD per lo zoom-out
  storage.ts     validazione/parsing JSON, download
  share.ts       codifica/decodifica della lavagna nell'URL (formato compatto + deflate + base64url)
  whiteboard.ts  classe Whiteboard: stato, input, strumenti, history, persistenza, export
src/hooks/useWhiteboard.ts
src/components/  WhiteBoard (composizione), Canvas, TextEditor, Toolbar, PropertiesPanel, ViewMenu, FileMenu,
                 LessonBar (pagine e "segui"), BoardChip, BoardsDrawer, Toast, ui (design system)
```

### Collaborazione P2P

```
src/engine/collab/
  doc.ts          CRDT: una voce per elemento (versione di Lamport, sito, chiave d'ordine z, lapide); merge "ultima scrittura vince"
  protocol.ts     validazione dei messaggi di rete (i peer non sono fidati), frammentazione, colori/nomi
  signaling.ts    link della stanza e inviti manuali (SDP compressa) nel fragment dell'URL (#collab=…)
  relay.ts        segnalazione automatica: client MQTT minimo su WebSocket verso broker pubblici, messaggi cifrati AES-GCM
  session.ts      mesh WebRTC: un canale dati per coppia, segnalazione assistita dai peer già collegati, backpressure
  auth.ts         identità dei partecipanti (ECDSA P-256, WebCrypto): id del sito ricavato dalla chiave, saluto firmato
  acl.ts          permessi della stanza firmati dal proprietario (chi può modificare, chi solo guardare)
  controller.ts   unisce documento, trasporto e presenza; si aggancia al motore tramite l'interfaccia CollabHost
  validate.ts     validatori puri (usati anche da storage.ts)
src/components/CollabDialog.tsx   interfaccia (avvio, inviti, partecipanti, privacy)
```

**Come si collega.** WebRTC ha bisogno che due browser si scambino un'offerta e una risposta.

*Collegamento automatico (predefinito).* Il link della stanza contiene solo l'id della stanza (128 bit casuali). Da quello ogni
partecipante ricava un topic e una chiave AES-GCM, e usa alcuni broker MQTT pubblici (emqx, hivemq, mosquitto, in parallelo) come
bacheca: si annuncia ("ci sono, e sono collegato a…") e scambia offerte/risposte cifrate. Il broker vede solo blob opachi; i disegni
non ci passano mai. L'annuncio si ripete ogni 20 s, al ritorno in primo piano e al ritorno in rete: per questo un telefono che
sospende il browser mentre si manda il link, o una scheda scartata e ricaricata, si ricollega da solo. Un annuncio che non ci
elenca rivela anche le connessioni "zombie" (canale che sembra aperto ma che l'altro ha perso), che vengono sostituite.
Lo si disattiva da "Privacy e impostazioni".

*Invito manuale (senza alcun server).* L'host crea un link d'invito, l'ospite lo apre e ottiene un codice di risposta, l'host lo
incolla. Il collegamento parte solo quando entrambi hanno la pagina aperta: l'host aspetta fino a 5 minuti che l'ospite torni sul
browser dopo aver mandato il codice. È un passaggio per persona: dopo il
primo collegamento, chi entra riceve l'elenco dei partecipanti e negozia le connessioni mancanti *attraverso* i canali già aperti
(mesh completa). Tra schede dello stesso browser la risposta arriva da sola (BroadcastChannel).

**Come converge.** Ogni modifica locale è confrontata con lo stato noto (gli elementi sono immutabili: basta confrontare i riferimenti)
e diventa un'operazione. Il merge è commutativo e idempotente, quindi i peer convergono con messaggi in ritardo, duplicati o in disordine,
e ogni peer inoltra agli altri solo ciò che ha cambiato il proprio stato (gossip senza cicli). Le cancellazioni sono lapidi, l'ordine z è
una chiave frazionaria per elemento. Lo storico di undo/redo è ri-agganciato (`rebase`) al lavoro altrui: annulli le tue azioni, non quelle degli altri.
Durante un trascinamento locale gli aggiornamenti remoti aspettano la fine del gesto.

**Trascinamenti in tempo reale.** Mentre sposti o ridimensioni qualcosa, gli altri lo vedono muoversi: come per cursori e
tratti in corso, viaggia un messaggio di presenza effimero (`mv`, preview.ts) che non tocca il documento. Contiene solo gli id
e la trasformazione (`[dx, dy]` o `[ax, ay, sx, sy]`; per l'estremo di una freccia, la freccia), quindi resta piccolo anche con
tratti lunghi; chi lo riceve la applica alla propria copia e ricalcola le frecce agganciate. Al rilascio partono le modifiche
vere, che sostituiscono l'anteprima.

**Frecce agganciate.** Una freccia ricorda l'id delle forme ai suoi capi (`from`/`to`); i suoi punti restano salvati come
normali coordinate (export, link e versioni precedenti la disegnano comunque) ma vengono ricalcolati dopo ogni modifica,
locale o remota: ogni capo agganciato sta sul contorno della sua forma, sulla retta verso l'altro capo. Il calcolo è
deterministico e non tocca gli oggetti che non cambiano, quindi se due persone spostano i due capi della stessa freccia
entrambe ricalcolano lo stesso risultato e la sincronizzazione si ferma al primo scambio. Nel link condiviso gli agganci
viaggiano come posizioni nell'elenco degli elementi (gli id non ci sono).

**Pagine e "segui".** Le pagine non sono elementi: sono un layout fisso (fogli di 1600×1000 unità impilati da (0, 0)) più un
numero, sincronizzato come sfondo e griglia (registro "ultima scrittura vince"). Le pagine mostrate sono il massimo tra quel numero
e quelle occupate dal contenuto, così il lavoro di un altro partecipante (o un annulla) non finisce mai fuori dai fogli. "Segui"
usa due messaggi di presenza, effimeri come i cursori: `vw` (l'area visibile in coordinate mondo, a ogni spostamento) e `lead`
("fatti seguire"). Chi segue adatta quell'area al proprio schermo; a metà di un tratto la vista aspetta la fine del gesto. Le versioni
precedenti dell'app ignorano questi messaggi e il numero di pagine, quindi una stanza mista continua a funzionare.

**Permessi senza server.** Non c'è un server che possa dire chi è chi, quindi i permessi si reggono sulla crittografia:
- Chi avvia la collaborazione genera una coppia di chiavi (ECDSA P-256) che resta nel suo browser con la lavagna. Firma i
  permessi `{v, def, ov}` (versione, accesso predefinito, eccezioni per persona) legandoli all'id della stanza; la chiave pubblica
  e l'ultima versione firmata viaggiano nel link. Ogni partecipante verifica da solo la firma: nessuno può darsi il permesso.
- Ogni partecipante ha la sua chiave; il suo id è l'hash della chiave pubblica. Nel saluto di ogni canale WebRTC firma l'impronta
  DTLS del proprio lato, che l'altro confronta con quella che vede: non si può usare l'id di un altro, né riusare una firma copiata.
  I messaggi arrivati prima della verifica aspettano in coda.
- Un peer accetta modifiche (anche inoltrate) solo da chi ha dimostrato la sua identità e può modificare; chi è in sola lettura non
  inoltra nulla. I permessi si propagano come le modifiche (vale la versione firmata più alta), quindi arrivano anche a chi non è
  collegato direttamente al proprietario. In sola lettura l'interfaccia mostra solo la mano e ogni modifica locale viene scartata.
- Le stanze create prima dei permessi continuano a funzionare come prima (tutti modificano). Le versioni precedenti dell'app non
  sanno firmare il saluto: in una stanza con permessi possono solo guardare.

**Local-first.** Ogni partecipante tiene la propria copia in localStorage (con i metadati di sincronizzazione), anche offline. Se ricarichi
la pagina la lavagna resta e, con il collegamento automatico, rientra nella stanza da sola (con l'invito manuale serve un nuovo
invito di chi è ancora nella stanza). Chi apre un invito ottiene una *nuova* lavagna nella libreria, a meno che ne abbia già una
di quella stanza: in quel caso viene riaperta quella, senza doppioni. "Esci dalla collaborazione" la rende di nuovo una lavagna normale.

**Limiti e fiducia.**
- Chi ha il link vede la lavagna: i permessi decidono chi modifica, non chi guarda. Condividilo solo con chi vuoi.
- Solo chi ha avviato la collaborazione può cambiare i permessi, e solo dal browser in cui l'ha avviata: se ne cancella i dati, i
  permessi restano quelli dell'ultima versione.
- Chi è in sola lettura riceve il contenuto da chi può modificare: se è online solo lui, aspetta che entri qualcun altro.
- Una modifica partita un attimo prima di una revoca può ancora arrivare a chi non ha ricevuto i nuovi permessi.
- Il collegamento automatico dipende da broker MQTT pubblici gratuiti: se nessuno è raggiungibile l'app lo dice e propone l'invito manuale.
- Con una rete molto restrittiva (NAT simmetrico, firewall aziendali, alcune reti mobili 4G/5G) il collegamento diretto può fallire senza un relay TURN, che qui non c'è: in quel caso conviene il Wi-Fi.
- Il server STUN pubblico (opzionale, attivo di default) vede l'IP, mai i contenuti. Disattivato, funziona solo nella stessa rete locale.
- Una collaborazione è legata alla lavagna aperta: cambiando lavagna la sessione si chiude (si riprende riaprendola, o con un nuovo invito senza relay).
- Le lapidi non vengono ripulite: lavagne molto vecchie e molto editate crescono un po' nel tempo.
- La chiave d'ordine z è un numero in virgola mobile: moltissimi inserimenti nello stesso punto esatto ne esauriscono la precisione.

### Dove finiscono i dati

| Chiave localStorage | Contenuto |
|---|---|
| `whiteboard:index` | elenco lavagne (id, nome, date, anteprima) e lavagna corrente |
| `whiteboard:board:<id>` | una lavagna: elementi, camera, sfondo, griglia, numero di pagine (e metadati di sincronizzazione se collaborativa) |
| `whiteboard:collab` | nome visualizzato e preferenze STUN e collegamento automatico |

localStorage ha un limite di pochi MB per sito: se si esaurisce, l'app continua a funzionare in memoria e lo segnala
sotto il nome della lavagna. In quel caso esporta in `.json` ed elimina le lavagne che non servono.

Il documento è un array di elementi **immutabili** in coordinate mondo: l'undo è uno snapshot dell'array
(condivide gli oggetti, costo trascurabile) e le cache per elemento (bounds, LOD) restano valide.
Il rendering avviene solo quando serve (`requestAnimationFrame` su richiesta), con culling sul viewport.

`@use-gesture/react` e `react-color` non sono più usati: puoi toglierli con `npm uninstall @use-gesture/react react-color`.

## Favicon e condivisione

Icone e anteprime usano le convenzioni file di Next in `src/app`: `favicon.ico`, `icon.svg`, `apple-icon.png`,
`opengraph-image.png`, `twitter-image.png`, `manifest.ts`. I meta tag (Open Graph, Twitter, theme-color) sono in `layout.tsx`.
In produzione imposta `NEXT_PUBLIC_SITE_URL` (es. `https://tuodominio.it`) per avere URL assoluti nelle anteprime.
