import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Bookmark as BookmarkIcon,
  Check,
  Download,
  Headphones,
  ListPlus,
  Loader2,
  MoreVertical,
  Play,
  Send,
  Share2,
  Trash2,
  WifiOff
} from "lucide-react";
import { getReaderInfo, saveReview } from "./api";
import {
  BookCover,
  ReviewPanel,
  formatAudioTime,
  formatFileSize,
  formatPercent,
  formatShortDate,
  isBookRead,
  isSendableEpub
} from "./App";
import {
  isAudiobookStoredOffline,
  offlineStorageSupported,
  removeOfflineAudiobook,
  storeAudiobookOffline
} from "./offline";
import type { Book, Bookmark, Highlight, MediaType, ReaderInfo } from "./types";

const BOOK_PATH = /^\/books\/([^/]+)\/?$/;

/** The book id in a /books/<id> address, or null for any other page. */
export function bookIdFromPath(pathname: string) {
  const match = BOOK_PATH.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export function bookDetailsPath(bookId: string) {
  return `/books/${encodeURIComponent(bookId)}`;
}

export interface MarkTarget {
  locator?: string | null;
  page?: number | null;
}

export function BookDetailsView({
  bookId,
  books,
  canManageBook,
  inReadList,
  nowPlaying,
  onBack,
  onOpenBook,
  onStart,
  onOpenMark,
  onAuthorSelect,
  onSetReadState,
  onToggleReadList,
  onEditBook,
  onGetArtwork,
  onDeleteBook,
  onSendToKindle,
  onDeleteBookmark,
  onReviewSaved,
  onError
}: {
  bookId: string;
  books: Book[];
  canManageBook: boolean;
  inReadList: boolean;
  nowPlaying: boolean;
  onBack: () => void;
  onOpenBook: (bookId: string) => void;
  onStart: (book: Book) => void;
  onOpenMark: (book: Book, target: MarkTarget) => void;
  onAuthorSelect: (author: string, mediaType: MediaType) => void;
  onSetReadState: (bookId: string, read: boolean) => void;
  onToggleReadList: (bookId: string) => void;
  onEditBook: (book: Book) => void;
  onGetArtwork: (book: Book) => void;
  onDeleteBook: (book: Book) => void;
  onSendToKindle: (book: Book) => void;
  onDeleteBookmark: (bookId: string, bookmark: Bookmark) => Promise<void>;
  onReviewSaved: () => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const [info, setInfo] = useState<ReaderInfo | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "missing">("loading");
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let current = true;
    setInfo(null);
    setLoadState("loading");
    setDescriptionOpen(false);
    setMenuOpen(false);
    getReaderInfo(bookId)
      .then((next) => {
        if (!current) return;
        setInfo(next);
        setLoadState("ready");
      })
      .catch((error) => {
        if (!current) return;
        setLoadState("missing");
        onError(error, "Unable to load this title");
      });
    return () => {
      current = false;
    };
    // Reload only when a different book is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // The library list is the freshest copy: it reflects edits, new artwork and read state.
  const book = books.find((item) => item.id === bookId) || info?.book || null;
  const tracks = info?.audioTracks || [];
  const offline = useOfflineAudiobook(book, tracks, setNotice);

  const sameAuthor = useMemo(() => {
    const author = book?.author?.trim().toLowerCase();
    if (!book || !author) return [];
    return books
      .filter((item) => item.id !== book.id && item.author?.trim().toLowerCase() === author)
      .slice(0, 18);
  }, [book, books]);

  const sameSeries = useMemo(() => {
    const series = book?.series?.trim().toLowerCase();
    if (!book || !series) return [];
    return books
      .filter((item) => item.id !== book.id && item.series?.trim().toLowerCase() === series)
      .sort((a, b) => (a.sortTitle || a.title).localeCompare(b.sortTitle || b.title, undefined, { numeric: true }));
  }, [book, books]);

  if (!book) {
    return (
      <section className="book-details-workspace book-details-empty">
        {loadState === "loading" ? (
          <Loader2 className="spin" size={28} />
        ) : (
          <>
            <h2>Title not found</h2>
            <p>It may have been removed, or you may not have access to it.</p>
            <button type="button" className="primary-button" onClick={onBack}>
              <ArrowLeft size={18} />
              Back
            </button>
          </>
        )}
      </section>
    );
  }

  const isAudiobook = book.mediaType === "audiobook";
  const percent = book.progress?.percent || 0;
  const read = isBookRead(book);
  const started = percent > 0 && !read;
  const author = book.author || "Unknown author";
  const totalSeconds = tracks.length > 0 && tracks.every((track) => (track.durationSeconds || 0) > 0)
    ? tracks.reduce((total, track) => total + (track.durationSeconds || 0), 0)
    : book.durationSeconds || 0;
  const currentTrack = Number.isInteger(book.progress?.trackIndex) ? book.progress?.trackIndex : null;
  const description = book.description?.trim() || "";
  const longDescription = description.length > 420;
  const bookmarks = info?.bookmarks || [];
  const highlights = info?.highlights || [];

  const facts = [
    isAudiobook ? "Audiobook" : book.ext.replace(".", "").toUpperCase(),
    isAudiobook && totalSeconds ? formatLength(totalSeconds) : null,
    isAudiobook && (tracks.length || book.trackCount)
      ? `${tracks.length || book.trackCount} chapter${(tracks.length || book.trackCount) === 1 ? "" : "s"}`
      : null,
    !isAudiobook && book.pageCount ? `${book.pageCount} pages` : null,
    read ? "Finished" : started ? `${formatPercent(percent)} ${isAudiobook ? "listened" : "read"}` : null
  ].filter(Boolean);

  const detailRows: Array<[string, string]> = [
    ["Narrator", book.narrator || ""],
    ["Series", book.series || ""],
    ["Publisher", book.publisher || ""],
    ["Published", book.publicationDate || ""],
    ["Language", book.language || ""],
    ["ISBN / ASIN", book.isbnAsin || ""],
    ["Categories", book.categories.join(", ")],
    ["Contributors", book.contributors.join(", ")],
    ["File", `${book.ext.replace(".", "").toUpperCase()} · ${formatFileSize(book.size)}`],
    ["Added", formatShortDate(book.addedAt)]
  ];

  const startLabel = isAudiobook
    ? nowPlaying ? "Now playing" : started ? "Resume" : "Play"
    : started ? "Continue reading" : "Read";

  const shareBook = async () => {
    const url = `${window.location.origin}${bookDetailsPath(book.id)}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: book.title, text: `${book.title} by ${author}`, url });
      } else {
        await navigator.clipboard.writeText(url);
        setNotice("Link copied.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setNotice("Unable to share this title.");
    }
  };

  const deleteBookmark = async (bookmark: Bookmark) => {
    try {
      await onDeleteBookmark(book.id, bookmark);
      setInfo((current) => current ? { ...current, bookmarks: current.bookmarks.filter((item) => item.id !== bookmark.id) } : current);
    } catch {
      // The app shows the error.
    }
  };

  const handleSaveReview = async (rating: number, text: string) => {
    try {
      const result = await saveReview(book.id, { rating, text });
      setInfo((current) => current ? { ...current, myReview: result.review, reviews: result.reviews } : current);
      setNotice("Review saved.");
      onReviewSaved();
    } catch (error) {
      onError(error, "Unable to save review");
    }
  };

  return (
    <section className="book-details-workspace" aria-label={`${book.title} details`}>
      <button type="button" className="book-details-back" onClick={onBack}>
        <ArrowLeft size={18} />
        Back
      </button>

      <header className="book-details-hero">
        <div className="book-details-cover">
          <BookCover book={book} fit={isAudiobook ? "contain" : "cover"} />
          {read ? (
            <span className="book-read-badge" title="Read" aria-label="Read">
              <Check size={17} strokeWidth={3} />
            </span>
          ) : null}
        </div>

        <div className="book-details-copy">
          <span className="book-details-kicker">
            {isAudiobook ? <Headphones size={15} /> : <BookOpen size={15} />}
            {isAudiobook ? "Audiobook" : "Book"}
          </span>
          <h2>{book.title}</h2>
          {book.subtitle ? <p className="book-details-subtitle">{book.subtitle}</p> : null}
          <p className="book-details-byline">
            <button
              type="button"
              className="book-author-link"
              aria-label={`Show books by ${author}`}
              onClick={() => onAuthorSelect(author, book.mediaType)}
            >
              {author}
            </button>
            {isAudiobook && book.narrator ? <span> · Narrated by {book.narrator}</span> : null}
          </p>
          {book.series ? <p className="book-details-series">{book.series}</p> : null}
          <p className="book-details-facts">{facts.join(" · ")}</p>
          {percent > 0 && !read ? (
            <span className="book-progress-bar book-details-progress" aria-hidden="true">
              <span style={{ width: `${Math.round(percent * 100)}%` }} />
            </span>
          ) : null}

          <div className="book-details-actions">
            <button
              type="button"
              className="primary-button book-details-start"
              onClick={() => onStart(book)}
            >
              {isAudiobook ? <Play size={18} fill="currentColor" /> : <BookOpen size={18} />}
              {startLabel}
            </button>
            <button
              type="button"
              className={`book-details-action ${inReadList ? "is-active" : ""}`}
              aria-pressed={inReadList}
              onClick={() => onToggleReadList(book.id)}
            >
              {inReadList ? <Check size={17} /> : <ListPlus size={17} />}
              {inReadList ? "On Read List" : "Add to Read List"}
            </button>
            <button
              type="button"
              className={`book-details-action ${read ? "is-active" : ""}`}
              aria-pressed={read}
              onClick={() => onSetReadState(book.id, !read)}
            >
              <Check size={17} />
              {read ? "Mark as unread" : "Mark as read"}
            </button>
            <button type="button" className="book-details-action" onClick={() => void shareBook()}>
              <Share2 size={17} />
              Share
            </button>
            {isAudiobook && offline.supported ? (
              <button
                type="button"
                className={`book-details-action ${offline.stored ? "is-active" : ""}`}
                aria-pressed={offline.stored}
                disabled={offline.busy || tracks.length === 0}
                onClick={() => void offline.toggle()}
              >
                {offline.busy ? <Loader2 className="spin" size={17} /> : offline.stored ? <WifiOff size={17} /> : <Download size={17} />}
                {offline.busy
                  ? `Saving ${offline.progress.completed}/${offline.progress.total}`
                  : offline.stored ? "Available offline" : "Make available offline"}
              </button>
            ) : null}
            {isSendableEpub(book) ? (
              <button type="button" className="book-details-action" onClick={() => onSendToKindle(book)}>
                <Send size={17} />
                Send to Kindle
              </button>
            ) : null}
            {canManageBook ? (
              <div
                className="book-details-more"
                onBlur={(event) => {
                  const next = event.relatedTarget;
                  if (!(next instanceof Node) || !event.currentTarget.contains(next)) setMenuOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setMenuOpen(false);
                }}
              >
                <button
                  type="button"
                  className="book-details-action is-icon"
                  aria-label={`More actions for ${book.title}`}
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((value) => !value)}
                >
                  <MoreVertical size={18} />
                </button>
                {menuOpen ? (
                  <div className="book-cover-menu book-details-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onEditBook(book); }}>
                      Edit metadata
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onGetArtwork(book); }}>
                      Get artwork
                    </button>
                    <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenuOpen(false); onDeleteBook(book); }}>
                      Delete title
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          {notice || offline.message ? <p className="book-details-notice" role="status">{notice || offline.message}</p> : null}
        </div>
      </header>

      <div className="book-details-body">
        <div className="book-details-main">
          <DetailsSection title="About">
            {description ? (
              <>
                <p className={`book-details-description ${longDescription && !descriptionOpen ? "is-clamped" : ""}`}>
                  {description}
                </p>
                {longDescription ? (
                  <button type="button" className="text-button" onClick={() => setDescriptionOpen((value) => !value)}>
                    {descriptionOpen ? "Less" : "More"}
                  </button>
                ) : null}
              </>
            ) : (
              <p className="book-details-muted">No description yet.</p>
            )}
          </DetailsSection>

          {isAudiobook && tracks.length > 0 ? (
            <DetailsSection title="Chapters" count={tracks.length}>
              <ol className="book-details-chapters">
                {tracks.map((track) => (
                  <li key={track.index} className={track.index === currentTrack && !read ? "is-current" : ""}>
                    <span className="book-details-chapter-index">{track.index + 1}</span>
                    <span className="book-details-chapter-title">{track.title || `Part ${track.index + 1}`}</span>
                    <span className="book-details-chapter-time">
                      {track.index === currentTrack && !read ? "Up to here · " : ""}
                      {track.durationSeconds ? formatAudioTime(track.durationSeconds) : ""}
                    </span>
                  </li>
                ))}
              </ol>
            </DetailsSection>
          ) : null}

          {loadState === "ready" ? (
            <DetailsSection title={isAudiobook ? "Your bookmarks" : "Your bookmarks and notes"} count={bookmarks.length + highlights.length}>
              {bookmarks.length + highlights.length === 0 ? (
                <p className="book-details-muted">
                  {isAudiobook ? "Bookmarks you add while listening show up here." : "Bookmarks and highlights you add while reading show up here."}
                </p>
              ) : (
                <ul className="book-details-marks">
                  {bookmarks.map((bookmark) => (
                    <MarkRow
                      key={bookmark.id}
                      icon={<BookmarkIcon size={16} />}
                      title={bookmark.label || `Bookmark at ${formatPercent(bookmark.percent)}`}
                      detail={`${formatPercent(bookmark.percent)} · ${formatShortDate(bookmark.createdAt)}`}
                      onOpen={isAudiobook ? undefined : () => onOpenMark(book, bookmark)}
                      onDelete={() => void deleteBookmark(bookmark)}
                    />
                  ))}
                  {highlights.map((highlight: Highlight) => (
                    <MarkRow
                      key={highlight.id}
                      icon={<span className="book-details-highlight-swatch" />}
                      title={`“${highlight.text}”`}
                      detail={[highlight.note, formatShortDate(highlight.createdAt)].filter(Boolean).join(" · ")}
                      onOpen={isAudiobook ? undefined : () => onOpenMark(book, highlight)}
                    />
                  ))}
                </ul>
              )}
            </DetailsSection>
          ) : null}

          {info ? (
            <div className="book-details-reviews">
              <ReviewPanel myReview={info.myReview} reviews={info.reviews} onSave={(rating, text) => void handleSaveReview(rating, text)} />
            </div>
          ) : null}
        </div>

        <aside className="book-details-side">
          <DetailsSection title="Details">
            <dl className="book-details-list">
              {detailRows.filter(([, value]) => value).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </DetailsSection>
        </aside>
      </div>

      {sameSeries.length > 0 ? (
        <RelatedRow title={`More in ${book.series}`} books={sameSeries} onOpenBook={onOpenBook} />
      ) : null}
      {sameAuthor.length > 0 ? (
        <RelatedRow title={`More by ${author}`} books={sameAuthor} onOpenBook={onOpenBook} />
      ) : null}
    </section>
  );
}

function DetailsSection({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="book-details-section">
      <div className="profile-section-heading">
        <h3>{title}</h3>
        {count ? <span>{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

function MarkRow({
  icon,
  title,
  detail,
  onOpen,
  onDelete
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  onOpen?: () => void;
  onDelete?: () => void;
}) {
  const body = (
    <>
      <span className="book-details-mark-icon">{icon}</span>
      <span className="book-details-mark-copy">
        <strong>{title}</strong>
        {detail ? <small>{detail}</small> : null}
      </span>
    </>
  );
  return (
    <li>
      {onOpen ? (
        <button type="button" className="book-details-mark" onClick={onOpen}>{body}</button>
      ) : (
        <div className="book-details-mark">{body}</div>
      )}
      {onDelete ? (
        <button type="button" className="icon-button" title="Delete bookmark" aria-label="Delete bookmark" onClick={onDelete}>
          <Trash2 size={16} />
        </button>
      ) : null}
    </li>
  );
}

function RelatedRow({ title, books, onOpenBook }: { title: string; books: Book[]; onOpenBook: (bookId: string) => void }) {
  return (
    <section className="home-shelf-row book-details-related" aria-label={title}>
      <h3>{title}</h3>
      <div className="home-book-row">
        {books.map((item) => (
          <article key={item.id} className="home-book-tile">
            <button type="button" className="book-cover-button" aria-label={`Open ${item.title}`} onClick={() => onOpenBook(item.id)}>
              <BookCover book={item} />
            </button>
            <div className="home-book-copy">
              <button type="button" className="book-title-link" onClick={() => onOpenBook(item.id)}>
                <strong>{item.title}</strong>
              </button>
              <small>{formatPercent(item.progress?.percent || 0)}{item.mediaType === "audiobook" ? " listened" : ""}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function useOfflineAudiobook(book: Book | null, tracks: ReaderInfo["audioTracks"], setNotice: (message: string) => void) {
  const supported = offlineStorageSupported();
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const bookId = book?.mediaType === "audiobook" ? book.id : null;

  useEffect(() => {
    setStored(false);
    if (!bookId) return;
    let current = true;
    void isAudiobookStoredOffline(bookId).then((value) => {
      if (current) setStored(value);
    });
    return () => {
      current = false;
    };
  }, [bookId]);

  const toggle = async () => {
    if (!book || !supported || busy) return;
    setBusy(true);
    setProgress({ completed: 0, total: tracks.length });
    setMessage(stored ? "Removing local copy..." : "Preparing offline copy...");
    try {
      if (stored) {
        await removeOfflineAudiobook(book.id);
        setStored(false);
        setNotice("Local copy removed.");
      } else {
        await storeAudiobookOffline({
          book,
          tracks,
          onProgress: (completed, total, label) => {
            setProgress({ completed, total });
            setMessage(completed >= total ? "Finishing offline copy..." : `Downloading ${label}`);
          }
        });
        setStored(true);
        setNotice("Available offline on this device.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to change offline mode");
    } finally {
      setMessage("");
      setBusy(false);
    }
  };

  return { supported, stored, busy, message: busy ? message : "", progress, toggle };
}

function formatLength(seconds: number) {
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes} min`;
  return `${hours} hr${minutes ? ` ${minutes} min` : ""}`;
}
