import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Plus, Tablet, Trash2, X } from "lucide-react";
import { createKoboLink, deleteKoboLink, getKoboOverview, setBookOnKobo } from "./api";
import { formatShortDate } from "./App";
import type { Book, KoboOverview } from "./types";

// Kobo sync covers EPUBs, including books shelf has converted to EPUB.
export function isKoboCompatible(book: Book) {
  return book.mediaType === "ebook" && (book.ext.toLowerCase() === ".epub" || book.readingFormat === "epub");
}

export function KoboPanel({
  books,
  onBooksChange,
  onClose,
  onError
}: {
  books: Book[];
  onBooksChange: (bookId: string, onKobo: boolean) => void;
  onClose: () => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const [overview, setOverview] = useState<KoboOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncUrl, setSyncUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getKoboOverview()
      .then(setOverview)
      .catch((error) => onError(error, "Unable to load Kobo settings"));
    // Load once when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const makeLink = async () => {
    setBusy(true);
    try {
      const next = await createKoboLink();
      setOverview(next);
      setSyncUrl(next.created?.syncUrl || "");
      setCopied(false);
    } catch (error) {
      onError(error, "Unable to make a Kobo sync link");
    } finally {
      setBusy(false);
    }
  };

  const removeLink = async (linkId: string) => {
    if (!window.confirm("Stop this Kobo syncing with shelf? Its books stay on the device until you remove them there.")) {
      return;
    }
    setBusy(true);
    try {
      setOverview(await deleteKoboLink(linkId));
    } catch (error) {
      onError(error, "Unable to remove the Kobo link");
    } finally {
      setBusy(false);
    }
  };

  const removeBook = async (bookId: string) => {
    try {
      await setBookOnKobo(bookId, false);
      onBooksChange(bookId, false);
      setOverview((current) => current ? { ...current, bookIds: current.bookIds.filter((id) => id !== bookId) } : current);
    } catch (error) {
      onError(error, "Unable to take the book off your Kobo");
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(syncUrl);
      setCopied(true);
    } catch {
      // Clipboard access needs https; the link stays selectable in the field.
      document.querySelector<HTMLInputElement>(".kobo-sync-url input")?.select();
    }
  };

  const koboBooks = (overview?.bookIds || [])
    .map((id) => books.find((book) => book.id === id))
    .filter((book): book is Book => Boolean(book));
  const tokenPath = syncUrl ? new URL(syncUrl).pathname : "";

  return (
    <div className="modal-backdrop">
      <section className="modal-panel kobo-panel" aria-labelledby="kobo-title">
        <div className="modal-heading">
          <div>
            <h2 id="kobo-title">Kobo e-reader</h2>
            <p>Books you send to Kobo arrive on your Kobo when it syncs. Reading progress syncs both ways.</p>
          </div>
          <button type="button" className="icon-button" title="Close Kobo settings" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {!overview ? (
          <div className="kindle-settings-loading">
            <Loader2 className="spin" size={20} />
            Loading…
          </div>
        ) : (
          <>
            {syncUrl ? (
              <section className="settings-section kobo-setup">
                <h3>Point your Kobo at shelf</h3>
                <div className="kobo-sync-url">
                  <input readOnly value={syncUrl} onFocus={(event) => event.currentTarget.select()} aria-label="Kobo sync link" />
                  <button type="button" className="secondary-button" onClick={() => void copy()}>
                    {copied ? <Check size={16} /> : <Copy size={16} />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <p className="kobo-note">This link is shown only now. Anyone with it can sync your Kobo books, so keep it private.</p>
                <ol className="kobo-steps">
                  <li>Connect the Kobo to your computer with a USB cable and open its drive.</li>
                  <li>Open <code>.kobo/Kobo/Kobo eReader.conf</code> in a text editor. The <code>.kobo</code> folder may be hidden.</li>
                  <li>
                    Under <code>[OneStoreServices]</code>, change the <code>api_endpoint=</code> line to:
                    <code className="kobo-conf-line">api_endpoint={syncUrl}</code>
                  </li>
                  <li>Save the file, eject the Kobo, then tap Sync on the Kobo.</li>
                </ol>
                <p className="kobo-note">
                  The Kobo has to reach this address. If it only syncs on your home Wi-Fi, you can use shelf's local
                  address instead, keeping the <code>{tokenPath}</code> part. Your Kobo store, account and purchases keep
                  working: shelf passes everything else on to Kobo.
                </p>
              </section>
            ) : null}

            <section className="settings-section">
              <h3>Linked Kobos</h3>
              {overview.links.length === 0 ? (
                <p className="kobo-note">No Kobo is linked yet. Make a sync link, then put it on your Kobo.</p>
              ) : (
                overview.links.map((link) => (
                  <div className="settings-row kobo-row" key={link.id}>
                    <span className="kobo-row-copy">
                      <Tablet size={18} />
                      <span>
                        <strong>Kobo link</strong>
                        <small>
                          Made {formatShortDate(link.createdAt)} ·{" "}
                          {link.lastUsedAt ? `last synced ${formatShortDate(link.lastUsedAt)}` : "not used yet"}
                        </small>
                      </span>
                    </span>
                    <button type="button" className="icon-button" title="Remove this Kobo link" disabled={busy} onClick={() => void removeLink(link.id)}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))
              )}
              <button type="button" className="secondary-button kobo-new-link" disabled={busy} onClick={() => void makeLink()}>
                {busy ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
                {overview.links.length === 0 ? "Make a sync link" : "Make another link"}
              </button>
            </section>

            <section className="settings-section">
              <h3>On your Kobo</h3>
              {koboBooks.length === 0 ? (
                <p className="kobo-note">No books yet. Open an EPUB in shelf and choose Send to Kobo.</p>
              ) : (
                koboBooks.map((book) => (
                  <div className="settings-row kobo-row" key={book.id}>
                    <span className="kobo-row-copy">
                      <span>
                        <strong>{book.title}</strong>
                        <small>{book.author || "Unknown author"}</small>
                      </span>
                    </span>
                    <button type="button" className="icon-button" title={`Take ${book.title} off your Kobo`} onClick={() => void removeBook(book.id)}>
                      <X size={16} />
                    </button>
                  </div>
                ))
              )}
              {!overview.kepub ? (
                <p className="kobo-note">This server doesn't have kepubify, so books go to the Kobo as standard EPUBs.</p>
              ) : null}
            </section>
          </>
        )}
      </section>
    </div>
  );
}
