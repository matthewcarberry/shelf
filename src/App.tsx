import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { Document, Page, pdfjs } from "react-pdf";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  Activity,
  Airplay,
  ArrowUpDown,
  Bookmark as BookmarkIcon,
  BookMarked,
  BookOpen,
  Cast,
  CircleUserRound,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Check,
  Columns2,
  Contrast,
  Copy,
  ExternalLink,
  FolderPlus,
  Edit3,
  Ellipsis,
  Grid2X2,
  Gauge,
  Highlighter,
  Headphones,
  House,
  ImagePlus,
  Library,
  List,
  ListMinus,
  ListPlus,
  Maximize,
  Minimize,
  LockKeyhole,
  Loader2,
  LogOut,
  Menu,
  Moon,
  MoreVertical,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rows3,
  RotateCcw,
  RotateCw,
  Search,
  Send,
  Server,
  Settings,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Sun,
  Trash2,
  Type,
  UserPlus,
  Users,
  Volume1,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import { castControls, onCastSessionStarted, useAirPlay, useCast } from "./cast";
import {
  AuthRequiredError,
  addBookmark,
  addHighlight,
  addToReadList,
  applyBookArtwork,
  acceptServerInvitation,
  claimServer,
  clearReadingActivity,
  convertBook,
  createUser,
  createLibrary,
  createServerClaimCode,
  createServerInvitation,
  deleteBook,
  deleteBookmark,
  deleteHighlight,
  deleteLibrary,
  getAuthStatus,
  getConnectionTicket,
  getPlatformOverview,
  getPreferences,
  getKindleSettings,
  getLibbyLoans,
  linkLibby,
  unlinkLibby,
  getProfile,
  getReaderInfo,
  listActivity,
  listBooks,
  listServerInvitations,
  listServerMembers,
  listUsers,
  login,
  lookupWord,
  logout,
  registerAccount,
  recordProfileUsage,
  removeUser,
  removeServerMember,
  removeFromReadList,
  revokeServerInvitation,
  saveReview,
  savePreferences,
  savePlatformPreferences,
  saveProgress,
  sendBookToKindle,
  searchBookArtwork,
  uploadBooks,
  updateBookCover,
  updateBookMetadata,
  updateLibrary,
  updateServerEndpoint,
  updateServerMember,
  updateUser,
  updateOwnPassword,
  updateReadingActivity,
  updateUserPassword
} from "./api";
import type {
  Alignment,
  ArtworkCandidate,
  AuthStatus,
  Book,
  Bookmark,
  DictionaryResult,
  EditableBookMetadata,
  Highlight,
  JumpTarget,
  KindleSettings,
  LibbyStatus,
  MediaType,
  PlatformOverview,
  ProfileData,
  ProgressState,
  ReaderInfo,
  ReaderPreferences,
  ReadingActivity,
  Review,
  ServerInvitation,
  ServerMember,
  ServerRole,
  ShelfLibrary,
  ShelfServer,
  SelectionAnchor,
  SelectionState,
  User
} from "./types";
import { BookDetailsView, bookDetailsPath, bookIdFromPath, type MarkTarget } from "./BookDetails";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const DEFAULT_PREFERENCES: ReaderPreferences = {
  fontSize: 110,
  fontFamily: "Georgia",
  alignment: "left",
  lineHeight: 1.55,
  theme: "paper",
  pageLayout: "single",
  margin: "medium",
  kindleEmail: "",
  skipForwardSeconds: 30,
  skipBackSeconds: 30,
  progressDisplay: {
    chapterTime: true,
    pageInBook: true,
    bookTime: true
  }
};

const MIN_SKIP_SECONDS = 1;
const MAX_SKIP_SECONDS = 600;

function normalizeSkipSeconds(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.round(clamp(number, MIN_SKIP_SECONDS, MAX_SKIP_SECONDS))
    : fallback;
}

function normalizePreferences(preferences?: Partial<ReaderPreferences> | null): ReaderPreferences {
  return {
    ...DEFAULT_PREFERENCES,
    ...(preferences || {}),
    skipForwardSeconds: normalizeSkipSeconds(preferences?.skipForwardSeconds, DEFAULT_PREFERENCES.skipForwardSeconds),
    skipBackSeconds: normalizeSkipSeconds(preferences?.skipBackSeconds, DEFAULT_PREFERENCES.skipBackSeconds),
    progressDisplay: {
      ...DEFAULT_PREFERENCES.progressDisplay,
      ...(preferences?.progressDisplay || {})
    }
  };
}

const COMPACT_LAYOUT_QUERY = "(max-width: 1050px)";
type LibraryLayoutMode = "grid" | "list" | "compact";
type LibraryFilterMode = "all" | "unread" | "reading" | "finished" | "needs-action";
type LibrarySortMode = "recent" | "title" | "author" | "progress";
const LIBRARY_SORT_MODES = new Set<LibrarySortMode>(["recent", "title", "author", "progress"]);
const LIBRARY_LAYOUT_MODES = new Set<LibraryLayoutMode>(["grid", "list", "compact"]);
type LibraryViewType = "ebooks" | "audiobooks";
type ListeningSession = { bookId: string; reader: ReaderInfo; progress: ProgressState | null; autoPlay: boolean };
type AudioSeekRequest = { trackIndex: number; trackTime: number; play: boolean; stamp: number };
type AudioPlayerControls = { applyReadState: (read: boolean) => void };
type AudioNote = { note: string; label: string; locator: string; percent: number };

// Audiobook positions are stored as "audio:<track index>:<seconds into the track>".
function parseAudioLocator(locator?: string | null): { trackIndex: number; trackTime: number } | null {
  const match = /^audio:(\d+):(\d+(?:\.\d+)?)$/.exec(locator || "");
  return match ? { trackIndex: Number(match[1]), trackTime: Number(match[2]) } : null;
}
type MainView = "home" | LibraryViewType | "libby" | "profile" | "marks" | "add";
type ReaderPanel = "toc" | "search" | "display" | "marks" | null;

interface ReaderTocItem {
  id: string;
  label: string;
  locator?: string | null;
  page?: number | null;
}

interface ReaderSearchResult {
  id: string;
  label: string;
  excerpt: string;
  locator?: string | null;
  page?: number | null;
}

type ReaderChromeIntent = "show" | "hide";

function getIsCompactLayout() {
  return typeof window !== "undefined" && window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
}

function getStoredLibrarySort(libraryType: LibraryViewType): LibrarySortMode {
  if (typeof window === "undefined") return "recent";

  try {
    const stored = window.localStorage.getItem(`shelfstream-${libraryType}-sort`) ||
      window.localStorage.getItem("shelfstream-library-sort");
    return stored && LIBRARY_SORT_MODES.has(stored as LibrarySortMode)
      ? (stored as LibrarySortMode)
      : "recent";
  } catch {
    return "recent";
  }
}

function getStoredLibraryLayout(libraryType: LibraryViewType): LibraryLayoutMode {
  if (typeof window === "undefined") return "grid";

  try {
    const stored = window.localStorage.getItem(`shelfstream-${libraryType}-layout`);
    return stored && LIBRARY_LAYOUT_MODES.has(stored as LibraryLayoutMode)
      ? (stored as LibraryLayoutMode)
      : "grid";
  } catch {
    return "grid";
  }
}

function viewForMediaType(mediaType: MediaType): LibraryViewType {
  return mediaType === "audiobook" ? "audiobooks" : "ebooks";
}

export function isSendableEpub(book: Book) {
  return book.mediaType === "ebook" && book.ext.toLowerCase() === ".epub";
}

function useActiveUsageTimer(
  enabled: boolean,
  mediaType: MediaType,
  onUsage: (mediaType: MediaType, seconds: number) => void,
  requireVisible: boolean
) {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const timer = window.setInterval(() => {
      if (!requireVisible || (document.visibilityState === "visible" && document.hasFocus())) {
        onUsage(mediaType, 30);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [enabled, mediaType, onUsage, requireVisible]);
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [platformOverview, setPlatformOverview] = useState<PlatformOverview | null>(null);
  const [platformLoading, setPlatformLoading] = useState(false);
  const [books, setBooks] = useState<Book[]>([]);
  const [libbyBooks, setLibbyBooks] = useState<Book[]>([]);
  const [libbyStatus, setLibbyStatus] = useState<LibbyStatus | null>(null);
  const [libbyLoading, setLibbyLoading] = useState(false);
  const [activeLibraryId, setActiveLibraryId] = useState<string | null>(null);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [reader, setReader] = useState<ReaderInfo | null>(null);
  const [preferences, setPreferences] = useState<ReaderPreferences>(DEFAULT_PREFERENCES);
  const [currentProgress, setCurrentProgress] = useState<ProgressState | null>(null);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [dictionary, setDictionary] = useState<DictionaryResult | null>(null);
  const [dictionaryLoading, setDictionaryLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [isCompactLayout, setIsCompactLayout] = useState(getIsCompactLayout);
  const [sidebarOpen, setSidebarOpen] = useState(() => !getIsCompactLayout());
  const [activeView, setActiveView] = useState<MainView>("home");
  const [readerOpen, setReaderOpen] = useState(false);
  const [listening, setListening] = useState<ListeningSession | null>(null);
  const [detailsBookId, setDetailsBookId] = useState<string | null>(() => bookIdFromPath(window.location.pathname));
  const [listeningPlaying, setListeningPlaying] = useState(false);
  const [playRequest, setPlayRequest] = useState(0);
  const [seekRequest, setSeekRequest] = useState<AudioSeekRequest | null>(null);
  const [usersOpen, setUsersOpen] = useState(false);
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false);
  const [serverAccessOpen, setServerAccessOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [readingActivity, setReadingActivity] = useState<ReadingActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [metadataBook, setMetadataBook] = useState<Book | null>(null);
  const [artworkBook, setArtworkBook] = useState<Book | null>(null);
  const [kindleBook, setKindleBook] = useState<Book | null>(null);
  const [kindleSettings, setKindleSettings] = useState<KindleSettings | null>(null);
  const [kindleSettingsLoading, setKindleSettingsLoading] = useState(false);
  const [kindleSending, setKindleSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [jumpTarget, setJumpTarget] = useState<JumpTarget | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const listeningProgressTimerRef = useRef<number | null>(null);
  const listeningProgressRef = useRef<ProgressState | null>(null);
  const listeningPendingSaveRef = useRef<{ bookId: string; progress: ProgressState } | null>(null);
  const preferencesTimerRef = useRef<number | null>(null);
  const pendingPreferencesRef = useRef<Partial<ReaderPreferences>>({});
  const lookupTokenRef = useRef(0);
  const activityPercentRef = useRef(0);
  const mobileOpenBookHandledRef = useRef<string | null>(null);
  const restoredListeningRef = useRef(false);
  const listeningControlsRef = useRef<AudioPlayerControls | null>(null);
  // updatedAt of the newest server position this tab has loaded or saved for the bar's book.
  const listeningSyncedAtRef = useRef("");

  const activeBook = useMemo(
    () => books.find((book) => book.id === activeBookId) || libbyBooks.find((book) => book.id === activeBookId) || null,
    [activeBookId, books, libbyBooks]
  );

  const activeServer = useMemo(
    () => platformOverview?.servers.find((server) => server.serverId === platformOverview.currentServerId) || null,
    [platformOverview]
  );
  const availableLibraries = activeServer?.libraries || [];
  const activeLibrary = availableLibraries.find((library) => library.id === activeLibraryId) || null;
  const hasCurrentServerAccess = Boolean(activeServer);
  const canManageServer = activeServer?.role === "owner" || activeServer?.role === "admin";

  const listeningBook = useMemo(
    () => listening ? books.find((book) => book.id === listening.bookId) || listening.reader.book : null,
    [books, listening]
  );
  // The ebook reader takes priority for activity; otherwise report the audiobook that is playing.
  const activityBookId = readerOpen ? activeBookId : listening && listeningPlaying ? listening.bookId : null;

  activityPercentRef.current = activityBookId && activityBookId === listening?.bookId && !readerOpen
    ? listeningProgressRef.current?.percent || listeningBook?.progress?.percent || 0
    : currentProgress?.percent || activeBook?.progress?.percent || 0;

  const filteredBooks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const normalizedAuthor = authorFilter?.trim().toLowerCase() || "";
    return books.filter((book) => {
      const author = (book.author || "Unknown author").trim().toLowerCase();
      const matchesAuthor = !normalizedAuthor || author === normalizedAuthor;
      const matchesQuery = !normalized ||
        `${book.title} ${book.author} ${book.sortTitle || ""} ${book.filename}`.toLowerCase().includes(normalized);
      return matchesAuthor && matchesQuery;
    });
  }, [authorFilter, books, query]);

  const refreshBooks = useCallback(async () => {
    const next = await listBooks();
    setBooks(next);
    return next;
  }, []);

  const refreshPlatform = useCallback(async () => {
    setPlatformLoading(true);
    try {
      const next = await getPlatformOverview();
      setPlatformOverview(next);
      const current = next.servers.find((server) => server.serverId === next.currentServerId);
      setActiveLibraryId((selected) => {
        if (selected && current?.libraries.some((library) => library.id === selected)) return selected;
        return current?.libraries[0]?.id || null;
      });
      return next;
    } finally {
      setPlatformLoading(false);
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const next = await getProfile();
      setProfile(next);
      return next;
    } finally {
      setProfileLoading(false);
    }
  }, []);

  const refreshLibby = useCallback(async (refresh = false) => {
    setLibbyLoading(true);
    try {
      const { books: loans, ...status } = await getLibbyLoans(refresh);
      setLibbyStatus(status);
      setLibbyBooks(loans);
    } catch (error) {
      // An unlinked account isn't an error here; the Libby page offers to link it.
      setLibbyBooks([]);
      setLibbyStatus((current) => current || { linked: false, linkedAt: null, libraries: [] });
      throw error;
    } finally {
      setLibbyLoading(false);
    }
  }, []);

  const readListIds = useMemo(
    () => new Set(profile?.readList.map((item) => item.book.id) || []),
    [profile]
  );

  const handleError = useCallback((error: unknown, fallback: string) => {
    if (error instanceof AuthRequiredError) {
      setAuth((current) =>
        current ? { ...current, authenticated: false, user: null } : { enabled: true, authenticated: false, user: null }
      );
      return;
    }
    setMessage(error instanceof Error ? error.message : fallback);
  }, []);

  const openBook = useCallback(
    async (bookId: string) => {
      setActiveBookId(bookId);
      setBusy(true);
      setMessage("");
      setSelection(null);
      setDictionary(null);

      try {
        const info = await getReaderInfo(bookId);
        setReader(info);
        setPreferences(normalizePreferences(info.preferences));
        const resolvedProgress = info.progress || info.book.progress || null;
        setCurrentProgress(resolvedProgress);
        setBooks((items) => items.map((book) =>
          book.id === bookId ? { ...book, progress: resolvedProgress } : book
        ));
      } catch (error) {
        handleError(error, "Unable to open title");
      } finally {
        setBusy(false);
      }
    },
    [handleError]
  );

  const handleListen = useCallback(
    async (bookId: string, locator?: string | null) => {
      const target = parseAudioLocator(locator);
      if (listening?.bookId === bookId) {
        if (target) {
          setSeekRequest({ ...target, play: true, stamp: Date.now() });
        } else {
          setPlayRequest((value) => value + 1);
        }
        return;
      }

      setBusy(true);
      setMessage("");
      try {
        const info = await getReaderInfo(bookId);
        const resolvedProgress = info.progress || info.book.progress || null;
        setActiveBookId(bookId);
        setReader(info);
        setReaderOpen(false);
        setCurrentProgress(resolvedProgress);
        setBooks((items) => items.map((book) =>
          book.id === bookId ? { ...book, progress: resolvedProgress } : book
        ));
        listeningProgressRef.current = resolvedProgress;
        listeningSyncedAtRef.current = resolvedProgress?.updatedAt || "";
        // Jumping to a note or bookmark starts from that spot instead of the saved position,
        // and a finished book starts over.
        const startAt = target && resolvedProgress
          ? { ...resolvedProgress, ...target, currentTime: null }
          : target
            ? { percent: 0, locator: locator || null, page: null, totalPages: null, currentTime: null, duration: null, ...target }
            : (resolvedProgress?.percent || 0) >= 0.995
              ? null
              : resolvedProgress;
        setListening({ bookId, reader: info, progress: startAt, autoPlay: true });
      } catch (error) {
        handleError(error, "Unable to open title");
      } finally {
        setBusy(false);
      }
    },
    [handleError, listening?.bookId]
  );

  // Like Pocket Casts, reopen with the audiobook you listened to last, paused and ready to resume.
  useEffect(() => {
    if (restoredListeningRef.current || listening || !hasCurrentServerAccess || books.length === 0) {
      return;
    }
    restoredListeningRef.current = true;
    // A link to an audiobook (?openBook=) opens and plays that book instead.
    const linkedBookId = new URLSearchParams(window.location.search).get("openBook");
    if (linkedBookId && books.some((book) => book.id === linkedBookId && book.mediaType === "audiobook")) {
      return;
    }
    const lastListened = books
      .filter((book) => book.mediaType === "audiobook" && book.progress?.updatedAt && !isBookRead(book))
      .sort((a, b) => String(b.progress?.updatedAt).localeCompare(String(a.progress?.updatedAt)))[0];
    if (!lastListened) {
      return;
    }
    void getReaderInfo(lastListened.id)
      .then((info) => {
        if (info.format !== "audio" || info.audioTracks.length === 0) {
          return;
        }
        const resolvedProgress = info.progress || info.book.progress || null;
        setListening((current) => {
          if (current) {
            return current;
          }
          listeningProgressRef.current = resolvedProgress;
          listeningSyncedAtRef.current = resolvedProgress?.updatedAt || "";
          return { bookId: lastListened.id, reader: info, progress: resolvedProgress, autoPlay: false };
        });
      })
      .catch(() => undefined);
  }, [books, hasCurrentServerAccess, listening]);

  const handleStopListening = useCallback(() => {
    setListening(null);
    setListeningPlaying(false);
    listeningProgressRef.current = null;
  }, []);

  useEffect(() => {
    getAuthStatus()
      .then(setAuth)
      .catch((error) => handleError(error, "Unable to check authentication"));
  }, [handleError]);

  useEffect(() => {
    const media = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsCompactLayout(event.matches);
      setSidebarOpen(!event.matches);
    };

    setIsCompactLayout(media.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    if (!auth || (auth.enabled && !auth.authenticated)) {
      setPlatformOverview(null);
      return;
    }
    refreshPlatform()
      .then(async (next) => {
        const inviteToken = new URLSearchParams(window.location.search).get("invite");
        if (!inviteToken) return next;
        const accepted = await acceptServerInvitation(inviteToken);
        setPlatformOverview(accepted);
        const url = new URL(window.location.href);
        url.searchParams.delete("invite");
        window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        setMessage("Server invitation accepted.");
        return accepted;
      })
      .catch((error) => handleError(error, "Unable to load your Shelf servers"));
  }, [auth, handleError, refreshPlatform]);

  useEffect(() => {
    if (!auth || (auth.enabled && !auth.authenticated) || !platformOverview || !hasCurrentServerAccess) {
      return;
    }

    getPreferences()
      .then((loadedPreferences) => setPreferences(normalizePreferences(loadedPreferences)))
      .catch((error) => handleError(error, "Unable to load display preferences"));

    refreshBooks()
      .then((loaded) => {
        if (loaded.length > 0 && !activeBookId) {
          void openBook(loaded[0].id);
        }
      })
      .catch((error) => handleError(error, "Unable to load library"));
    refreshProfile().catch((error) => handleError(error, "Unable to load profile"));
  }, [activeBookId, auth, handleError, hasCurrentServerAccess, openBook, platformOverview, refreshBooks, refreshProfile]);

  useEffect(() => {
    if (!activeBook || activeBook.status !== "converting") {
      return;
    }

    const timer = window.setInterval(async () => {
      const next = await refreshBooks();
      const updated = next.find((book) => book.id === activeBook.id);
      if (updated?.status === "ready") {
        await openBook(updated.id);
      }
    }, 2500);

    return () => window.clearInterval(timer);
  }, [activeBook, openBook, refreshBooks]);

  useEffect(() => {
    if (!activityBookId || !auth?.user) {
      return;
    }

    const heartbeat = () => {
      if (document.visibilityState === "visible") {
        void updateReadingActivity(activityBookId, activityPercentRef.current).catch(() => undefined);
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        heartbeat();
      } else {
        void clearReadingActivity(true).catch(() => undefined);
      }
    };

    heartbeat();
    const timer = window.setInterval(heartbeat, 12_000);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
      void clearReadingActivity(true).catch(() => undefined);
    };
  }, [activityBookId, auth?.user]);

  const refreshActivity = useCallback(async () => {
    if (auth?.user?.role !== "admin") {
      return;
    }
    setActivityLoading(true);
    try {
      setReadingActivity(await listActivity());
    } catch (error) {
      if (error instanceof Error && error.message === "This item is not available offline") {
        setReadingActivity([]);
        return;
      }
      handleError(error, "Unable to load reading activity");
    } finally {
      setActivityLoading(false);
    }
  }, [auth?.user?.role, handleError]);

  useEffect(() => {
    if (auth?.user?.role !== "admin") {
      setReadingActivity([]);
      setActivityOpen(false);
      return;
    }

    void refreshActivity();
    const timer = window.setInterval(() => void refreshActivity(), 10_000);
    return () => window.clearInterval(timer);
  }, [auth?.user?.role, refreshActivity]);

  useEffect(() => {
    return () => {
      if (progressTimerRef.current) {
        window.clearTimeout(progressTimerRef.current);
      }
      if (listeningProgressTimerRef.current) {
        window.clearTimeout(listeningProgressTimerRef.current);
      }
      if (preferencesTimerRef.current) {
        window.clearTimeout(preferencesTimerRef.current);
      }
    };
  }, []);

  const handleProgress = useCallback(
    (progress: ProgressState) => {
      if (!activeBookId) {
        return;
      }

      setCurrentProgress(progress);
      setBooks((items) =>
        items.map((book) => (book.id === activeBookId ? { ...book, progress } : book))
      );
      setLibbyBooks((items) =>
        items.map((book) => (book.id === activeBookId ? { ...book, progress } : book))
      );

      if (progressTimerRef.current) {
        window.clearTimeout(progressTimerRef.current);
      }

      progressTimerRef.current = window.setTimeout(() => {
        void saveProgress(activeBookId, progress).catch((error) =>
          handleError(error, "Unable to save progress")
        );
      }, 450);
    },
    [activeBookId, handleError]
  );

  const listeningBookId = listening?.bookId || null;

  const handleListeningProgress = useCallback(
    (progress: ProgressState) => {
      if (!listeningBookId) {
        return;
      }

      listeningProgressRef.current = progress;
      setBooks((items) =>
        items.map((book) => (book.id === listeningBookId ? { ...book, progress } : book))
      );
      setLibbyBooks((items) =>
        items.map((book) => (book.id === listeningBookId ? { ...book, progress } : book))
      );

      if (listeningProgressTimerRef.current) {
        window.clearTimeout(listeningProgressTimerRef.current);
        listeningProgressTimerRef.current = null;
      }
      const pending = listeningPendingSaveRef.current;
      if (pending && pending.bookId !== listeningBookId) {
        // A different audiobook was playing a moment ago; save its last position now.
        void saveProgress(pending.bookId, pending.progress).catch(() => undefined);
      }

      listeningPendingSaveRef.current = { bookId: listeningBookId, progress };
      listeningProgressTimerRef.current = window.setTimeout(() => {
        listeningProgressTimerRef.current = null;
        listeningPendingSaveRef.current = null;
        void saveProgress(listeningBookId, progress)
          .then((saved) => {
            if (saved.updatedAt && saved.updatedAt > listeningSyncedAtRef.current) {
              listeningSyncedAtRef.current = saved.updatedAt;
            }
          })
          .catch((error) => handleError(error, "Unable to save progress"));
      }, 450);
    },
    [handleError, listeningBookId]
  );

  // While the bar is paused, pick up a newer position saved on another device (such as the
  // phone app) when you come back to this tab, so pressing play doesn't rewind it.
  useEffect(() => {
    if (!listeningBookId || listeningPlaying) {
      return;
    }
    const bookId = listeningBookId;
    let cancelled = false;
    const syncFromServer = () => {
      if (document.visibilityState !== "visible" || listeningProgressTimerRef.current) {
        return;
      }
      void getReaderInfo(bookId)
        .then((info) => {
          const latest = info.progress || info.book.progress || null;
          const target = parseAudioLocator(latest?.locator);
          if (cancelled || !latest?.updatedAt || !target || latest.updatedAt <= listeningSyncedAtRef.current) {
            return;
          }
          listeningSyncedAtRef.current = latest.updatedAt;
          listeningProgressRef.current = latest;
          setBooks((items) => items.map((book) => (book.id === bookId ? { ...book, progress: latest } : book)));
          setSeekRequest({ ...target, play: false, stamp: Date.now() });
        })
        .catch(() => undefined);
    };
    document.addEventListener("visibilitychange", syncFromServer);
    window.addEventListener("focus", syncFromServer);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", syncFromServer);
      window.removeEventListener("focus", syncFromServer);
    };
  }, [listeningBookId, listeningPlaying]);

  const applyBookProgress = useCallback(
    (bookId: string, progress: ProgressState) => {
      setBooks((items) => items.map((book) => (book.id === bookId ? { ...book, progress } : book)));

      if (bookId === activeBookId) {
        setCurrentProgress(progress);
        setReader((info) =>
          info
            ? {
                ...info,
                progress,
                book: { ...info.book, progress }
              }
            : info
        );
      }
    },
    [activeBookId]
  );

  const handleSetBookReadState = useCallback(
    async (bookId: string, read: boolean) => {
      if (bookId === activeBookId && progressTimerRef.current) {
        window.clearTimeout(progressTimerRef.current);
        progressTimerRef.current = null;
      }
      // Drop a not-yet-saved position for the playing audiobook so it can't undo this change.
      if (bookId === listeningPendingSaveRef.current?.bookId && listeningProgressTimerRef.current) {
        window.clearTimeout(listeningProgressTimerRef.current);
        listeningProgressTimerRef.current = null;
        listeningPendingSaveRef.current = null;
      }
      // If it's the book in the player bar, pause it there and stop it saving its old spot.
      if (bookId === listeningBookId) {
        listeningControlsRef.current?.applyReadState(read);
      }

      try {
        const progress = await saveProgress(bookId, {
          percent: read ? 1 : 0,
          locator: null,
          page: null,
          totalPages: null,
          currentTime: read ? books.find((book) => book.id === bookId)?.durationSeconds || null : 0,
          duration: books.find((book) => book.id === bookId)?.durationSeconds || null,
          trackIndex: read ? null : 0,
          trackTime: read ? null : 0
        });
        applyBookProgress(bookId, progress);
        if (bookId === listeningBookId && progress.updatedAt) {
          listeningSyncedAtRef.current = progress.updatedAt;
        }
        void refreshProfile().catch(() => undefined);
      } catch (error) {
        handleError(error, read ? "Unable to mark book as read" : "Unable to mark book as unread");
      }
    },
    [activeBookId, applyBookProgress, books, handleError, listeningBookId, refreshProfile]
  );

  const updatePreferences = useCallback(
    (patch: Partial<ReaderPreferences>) => {
      setPreferences((current) => normalizePreferences({ ...current, ...patch }));

      // Send only what changed, so a stale tab can't overwrite settings saved elsewhere.
      pendingPreferencesRef.current = { ...pendingPreferencesRef.current, ...patch };
      if (preferencesTimerRef.current) {
        window.clearTimeout(preferencesTimerRef.current);
      }

      preferencesTimerRef.current = window.setTimeout(() => {
        const pending = pendingPreferencesRef.current;
        pendingPreferencesRef.current = {};
        void savePreferences(pending).catch((error) =>
          handleError(error, "Unable to save preferences")
        );
      }, 350);
    },
    [handleError]
  );

  const handleConvert = async () => {
    if (!activeBook) {
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const updated = await convertBook(activeBook.id);
      setBooks((items) => items.map((book) => (book.id === updated.id ? updated : book)));
    } catch (error) {
      handleError(error, "Conversion failed");
    } finally {
      setBusy(false);
    }
  };

  const handleLookup = useCallback(async (nextSelection: SelectionState) => {
    const token = lookupTokenRef.current + 1;
    lookupTokenRef.current = token;
    setSelection(nextSelection);
    if (!nextSelection.word) {
      setDictionary(null);
      setDictionaryLoading(false);
      return;
    }

    setDictionary(null);
    setDictionaryLoading(true);
    try {
      const result = await lookupWord(nextSelection.word);
      if (lookupTokenRef.current === token) {
        setDictionary(result);
      }
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        handleError(error, "Authentication required");
        return;
      }
      if (lookupTokenRef.current === token) {
        setDictionary({
          word: nextSelection.word,
          source: "local",
          definitions: [],
          message: error instanceof Error ? error.message : "Lookup failed"
        });
      }
    } finally {
      if (lookupTokenRef.current === token) {
        setDictionaryLoading(false);
      }
    }
  }, [handleError]);

  const handleDismissSelection = useCallback(() => {
    lookupTokenRef.current += 1;
    setSelection(null);
    setDictionary(null);
    setDictionaryLoading(false);
  }, []);

  const updateBookmarksFor = useCallback((bookId: string, update: (bookmarks: Bookmark[]) => Bookmark[]) => {
    setReader((info) => (info?.book.id === bookId ? { ...info, bookmarks: update(info.bookmarks) } : info));
    setListening((session) =>
      session?.bookId === bookId
        ? { ...session, reader: { ...session.reader, bookmarks: update(session.reader.bookmarks) } }
        : session
    );
  }, []);

  const handleListeningBookmark = async () => {
    const bookId = listening?.bookId;
    const progress = listeningProgressRef.current || listening?.progress;
    if (!bookId || !progress) {
      return;
    }

    try {
      const bookmark = await addBookmark(bookId, {
        label: `${formatPercent(progress.percent)} listened`,
        locator: progress.locator,
        page: progress.page,
        percent: progress.percent
      });
      await saveProgress(bookId, progress);
      updateBookmarksFor(bookId, (bookmarks) => [bookmark, ...bookmarks]);
    } catch (error) {
      handleError(error, "Unable to save bookmark");
    }
  };

  const handleAddListeningNote = async (note: AudioNote) => {
    const bookId = listening?.bookId;
    if (!bookId) {
      return false;
    }
    try {
      const highlight = await addHighlight(bookId, {
        text: note.label,
        note: note.note,
        locator: note.locator,
        page: null,
        percent: note.percent,
        color: "gold"
      });
      setReader((info) =>
        info?.book.id === bookId ? { ...info, highlights: [highlight, ...info.highlights] } : info
      );
      void refreshProfile().catch(() => undefined);
      return true;
    } catch (error) {
      handleError(error, "Unable to save note");
      return false;
    }
  };

  const handleBookmark = async () => {
    if (!activeBookId || !currentProgress) {
      return;
    }

    const label =
      currentProgress.page && currentProgress.totalPages
        ? `Page ${currentProgress.page}`
        : `${formatPercent(currentProgress.percent)} read`;

    try {
      const bookmark = await addBookmark(activeBookId, {
        label,
        locator: currentProgress.locator,
        page: currentProgress.page,
        percent: currentProgress.percent
      });
      await saveProgress(activeBookId, currentProgress);
      updateBookmarksFor(activeBookId, (bookmarks) => [bookmark, ...bookmarks]);
    } catch (error) {
      handleError(error, "Unable to save bookmark");
    }
  };

  const handleHighlight = async () => {
    if (!activeBookId || !selection) {
      return;
    }

    try {
      const highlight = await addHighlight(activeBookId, {
        text: selection.text,
        locator: selection.locator,
        page: selection.page,
        percent: selection.percent,
        color: "gold"
      });
      setReader((info) =>
        info ? { ...info, highlights: [highlight, ...info.highlights] } : info
      );
      void refreshProfile().catch(() => undefined);
    } catch (error) {
      handleError(error, "Unable to save highlight");
    }
  };

  const handleDeleteBookmark = async (bookmark: Bookmark) => {
    if (!activeBookId) {
      return;
    }
    try {
      await deleteBookmark(activeBookId, bookmark.id);
      updateBookmarksFor(activeBookId, (bookmarks) => bookmarks.filter((item) => item.id !== bookmark.id));
      void refreshProfile().catch(() => undefined);
    } catch (error) {
      handleError(error, "Unable to delete bookmark");
    }
  };

  const handleDeleteBookBookmark = async (bookId: string, bookmark: Bookmark) => {
    try {
      await deleteBookmark(bookId, bookmark.id);
      updateBookmarksFor(bookId, (bookmarks) => bookmarks.filter((item) => item.id !== bookmark.id));
      void refreshProfile().catch(() => undefined);
    } catch (error) {
      handleError(error, "Unable to delete bookmark");
      throw error;
    }
  };

  const handleDeleteHighlight = async (highlight: Highlight) => {
    if (!activeBookId) {
      return;
    }
    try {
      await deleteHighlight(activeBookId, highlight.id);
      setReader((info) =>
        info
          ? { ...info, highlights: info.highlights.filter((item) => item.id !== highlight.id) }
          : info
      );
      void refreshProfile().catch(() => undefined);
    } catch (error) {
      handleError(error, "Unable to delete highlight");
    }
  };

  const handleJump = (target: { locator?: string | null; page?: number | null }) => {
    if (activeBook?.mediaType === "audiobook") {
      void handleListen(activeBook.id, target.locator);
      return;
    }
    setActiveView(viewForMediaType(activeBook?.mediaType || "ebook"));
    setReaderOpen(true);
    setJumpTarget({ ...target, stamp: Date.now() });
  };

  // The details page has its own address (/books/<id>) so Back, Forward and shared links work.
  useEffect(() => {
    const handlePopState = () => {
      const bookId = bookIdFromPath(window.location.pathname);
      setDetailsBookId(bookId);
      if (bookId) {
        setReaderOpen(false);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const openBookDetails = useCallback(
    (bookId: string) => {
      const path = bookDetailsPath(bookId);
      if (window.location.pathname !== path) {
        window.history.pushState({ shelfDetails: true }, "", path);
      }
      setDetailsBookId(bookId);
      setReaderOpen(false);
      setSelection(null);
      setDictionary(null);
      if (isCompactLayout) {
        setSidebarOpen(false);
      }
    },
    [isCompactLayout]
  );

  // Moving to another part of Shelf from the details page adds a history entry, so Back returns to it.
  const leaveBookDetails = useCallback(() => {
    if (bookIdFromPath(window.location.pathname)) {
      window.history.pushState(null, "", "/");
    }
    setDetailsBookId(null);
  }, []);

  const closeBookDetails = useCallback(() => {
    if ((window.history.state as { shelfDetails?: boolean } | null)?.shelfDetails) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", "/");
    setDetailsBookId(null);
  }, []);

  const handleViewSelect = useCallback(
    (view: MainView) => {
      leaveBookDetails();
      setActiveView(view);
      if (view === "ebooks" || view === "audiobooks") {
        setAuthorFilter(null);
        setQuery("");
      }
      setReaderOpen(false);
      setUserMenuOpen(false);
      setSelection(null);
      setDictionary(null);
      if (view === "profile") {
        void refreshProfile().catch((error) => handleError(error, "Unable to load profile"));
      }
      if (view === "libby") {
        void refreshLibby().catch((error) => {
          if (!(error instanceof Error) || !/Link your Libby account first/.test(error.message)) {
            handleError(error, "Unable to load Libby loans");
          }
        });
      }
      if (isCompactLayout) {
        setSidebarOpen(false);
      }
    },
    [handleError, isCompactLayout, leaveBookDetails, refreshLibby, refreshProfile]
  );

  // Audiobooks play in the bar, open EPUB/PDF loans open in shelf's reader, and the rest open in Libby.
  const handleStartLibbyLoan = useCallback(
    (book: Book) => {
      const mode = book.libby?.mode;
      if (mode === "audio") {
        void handleListen(book.id);
        return;
      }
      if (mode === "epub" || mode === "pdf") {
        if (isCompactLayout) {
          setSidebarOpen(false);
        }
        setReaderOpen(true);
        void openBook(book.id);
        return;
      }
      if (book.libby?.libbyUrl) {
        window.open(book.libby.libbyUrl, "_blank", "noopener");
      }
    },
    [handleListen, isCompactLayout, openBook]
  );

  const handleAuthorSelect = useCallback(
    (author: string, mediaType: MediaType) => {
      leaveBookDetails();
      setAuthorFilter(author.trim() || "Unknown author");
      setQuery("");
      setActiveView(viewForMediaType(mediaType));
      setReaderOpen(false);
      setSelection(null);
      setDictionary(null);
      if (isCompactLayout) {
        setSidebarOpen(false);
      }
    },
    [isCompactLayout, leaveBookDetails]
  );

  const handleReadBook = useCallback(
    (bookId: string) => {
      if (isCompactLayout) {
        setSidebarOpen(false);
      }
      const selectedBook = books.find((book) => book.id === bookId);
      if (selectedBook?.mediaType === "audiobook") {
        void handleListen(bookId);
        return;
      }
      setActiveView(viewForMediaType(selectedBook?.mediaType || "ebook"));
      setReaderOpen(true);
      void openBook(bookId);
    },
    [books, handleListen, isCompactLayout, openBook]
  );

  const handleOpenProfileMark = useCallback(
    async (book: Book, highlight: MarkTarget) => {
      if (isCompactLayout) {
        setSidebarOpen(false);
      }
      if (book.mediaType === "audiobook") {
        await handleListen(book.id, highlight.locator);
        return;
      }
      setActiveView(viewForMediaType(book.mediaType));
      setReaderOpen(true);
      await openBook(book.id);
      setJumpTarget({ locator: highlight.locator, page: highlight.page, stamp: Date.now() });
    },
    [handleListen, isCompactLayout, openBook]
  );

  const handleToggleReadList = useCallback(
    async (bookId: string) => {
      try {
        const next = readListIds.has(bookId)
          ? await removeFromReadList(bookId)
          : await addToReadList(bookId);
        setProfile(next);
      } catch (error) {
        handleError(error, "Unable to update Read List");
      }
    },
    [handleError, readListIds]
  );

  const handleProfileUsage = useCallback(async (mediaType: MediaType, seconds: number) => {
    try {
      const usage = await recordProfileUsage(mediaType, seconds);
      setProfile((current) => current ? {
        ...current,
        stats: {
          ...current.stats,
          readingSeconds: usage.readingSeconds,
          listeningSeconds: usage.listeningSeconds
        }
      } : current);
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        handleError(error, "Authentication required");
      }
    }
  }, [handleError]);

  useEffect(() => {
    const bookId = new URLSearchParams(window.location.search).get("openBook");
    if (!bookId || mobileOpenBookHandledRef.current === bookId || !books.some((book) => book.id === bookId)) {
      return;
    }
    mobileOpenBookHandledRef.current = bookId;
    handleReadBook(bookId);
    const url = new URL(window.location.href);
    url.searchParams.delete("openBook");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [books, handleReadBook]);

  const handleUploadBooks = async (files: File[]) => {
    if (files.length === 0) {
      return;
    }

    setBusy(true);
    setMessage("");
    try {
      const result = await uploadBooks(files);
      setBooks(result.books);
      const duplicates = result.duplicates || [];
      const addedCount = files.length - result.rejected.length - duplicates.length;
      if (result.rejected.length > 0 || duplicates.length > 0) {
        const details = [
          result.rejected.length > 0
            ? `${result.rejected.length} unsupported file${result.rejected.length === 1 ? " was" : "s were"} skipped.`
            : "",
          duplicates.length > 0
            ? `${duplicates.length} duplicate file${duplicates.length === 1 ? " was" : "s were"} already present.`
            : ""
        ].filter(Boolean).join(" ");
        setMessage(
          `${addedCount} file${addedCount === 1 ? "" : "s"} added. ${details}`
        );
      } else {
        setMessage(`${addedCount} file${addedCount === 1 ? "" : "s"} added. You can add more titles.`);
      }
    } catch (error) {
      handleError(error, "Unable to add title");
    } finally {
      setBusy(false);
    }
  };

  const applyUpdatedBook = useCallback((nextBook: Book) => {
    setBooks((items) => items.map((book) => (book.id === nextBook.id ? nextBook : book)));
    setReader((info) => (info?.book.id === nextBook.id ? { ...info, book: nextBook } : info));
  }, []);

  const handleUpdateBookMetadata = async (
    bookId: string,
    metadata: EditableBookMetadata,
    coverFile: File | null
  ) => {
    setBusy(true);
    setMessage("");
    try {
      let updated = await updateBookMetadata(bookId, metadata);
      applyUpdatedBook(updated);
      setMetadataBook(updated);
      if (coverFile) {
        updated = await updateBookCover(bookId, coverFile);
        applyUpdatedBook(updated);
      }
      setMetadataBook(null);
      setMessage("Metadata updated.");
    } catch (error) {
      handleError(error, "Unable to update book metadata");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteBook = async (book: Book) => {
    const confirmed = window.confirm(
      `Delete "${book.title}" from the library? This removes its files and clears saved progress, notes, ratings, and reviews for every user.`
    );
    if (!confirmed) {
      return;
    }

    if (book.id === activeBookId && progressTimerRef.current) {
      window.clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    if (book.id === listening?.bookId) {
      handleStopListening();
    }

    setBusy(true);
    setMessage("");
    try {
      await deleteBook(book.id);
      setBooks((items) => items.filter((item) => item.id !== book.id));
      if (book.id === listeningPendingSaveRef.current?.bookId) {
        if (listeningProgressTimerRef.current) {
          window.clearTimeout(listeningProgressTimerRef.current);
          listeningProgressTimerRef.current = null;
        }
        listeningPendingSaveRef.current = null;
      }
      if (book.id === activeBookId) {
        setActiveBookId(null);
        setReader(null);
        setReaderOpen(false);
        setCurrentProgress(null);
        setSelection(null);
        setDictionary(null);
      }
      setMetadataBook((current) => (current?.id === book.id ? null : current));
      setArtworkBook((current) => (current?.id === book.id ? null : current));
      if (bookIdFromPath(window.location.pathname) === book.id) {
        window.history.replaceState(null, "", "/");
        setDetailsBookId(null);
      }
      void refreshProfile().catch(() => undefined);
      setMessage("Title deleted.");
    } catch (error) {
      handleError(error, "Unable to delete title");
    } finally {
      setBusy(false);
    }
  };

  const handleOpenSendToKindle = useCallback(async (book: Book) => {
    if (book.mediaType === "audiobook" || book.ext.toLowerCase() !== ".epub") {
      setMessage("Send to Kindle is available only for EPUB files.");
      return;
    }

    setKindleBook(book);
    setKindleSettings(null);
    setKindleSettingsLoading(true);
    setMessage("");
    try {
      setKindleSettings(await getKindleSettings());
    } catch (error) {
      setKindleBook(null);
      handleError(error, "Unable to load Send to Kindle settings");
    } finally {
      setKindleSettingsLoading(false);
    }
  }, [handleError]);

  const handleConfirmSendToKindle = async (kindleEmail: string) => {
    if (!kindleBook) {
      return;
    }

    setKindleSending(true);
    try {
      const result = await sendBookToKindle(kindleBook.id, kindleEmail);
      setPreferences((current) => ({ ...current, kindleEmail: result.kindleEmail }));
      setKindleBook(null);
      setKindleSettings(null);
      setMessage(`“${kindleBook.title}” was sent to ${result.kindleEmail}.`);
    } catch (error) {
      handleError(error, "Unable to send EPUB to Kindle");
      throw error;
    } finally {
      setKindleSending(false);
    }
  };

  const handleSaveReview = async (rating: number, text: string) => {
    if (!activeBookId) {
      return;
    }

    setBusy(true);
    try {
      const result = await saveReview(activeBookId, { rating, text });
      setReader((info) =>
        info ? { ...info, myReview: result.review, reviews: result.reviews } : info
      );
      void refreshProfile().catch(() => undefined);
    } catch (error) {
      handleError(error, "Unable to save review");
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async (username: string, password: string) => {
    setBusy(true);
    setMessage("");
    try {
      const next = await login(username, password);
      setAuth(next);
    } catch (error) {
      handleError(error, "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async (input: {
    username: string;
    displayName: string;
    email?: string;
    password: string;
    passwordConfirm: string;
    website?: string;
  }) => {
    setBusy(true);
    setMessage("");
    try {
      const next = await registerAccount(input);
      setAuth(next);
    } catch (error) {
      handleError(error, "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    setBusy(true);
    try {
      await logout();
      setAuth((current) =>
        current ? { ...current, authenticated: false, user: null } : { enabled: true, authenticated: false, user: null }
      );
      setBooks([]);
      handleStopListening();
      restoredListeningRef.current = false;
      setActiveBookId(null);
      setReader(null);
      setCurrentProgress(null);
      setProfile(null);
      setPlatformOverview(null);
    } catch (error) {
      handleError(error, "Unable to sign out");
    } finally {
      setBusy(false);
    }
  };

  const handleLibrarySelect = (library: ShelfLibrary) => {
    leaveBookDetails();
    setActiveLibraryId(library.id);
    setQuery("");
    setAuthorFilter(null);
    setActiveView(library.mediaType === "audiobook" ? "audiobooks" : "ebooks");
    if (isCompactLayout) setSidebarOpen(false);
  };

  const handleServerSelect = async (server: ShelfServer) => {
    if (!platformOverview || server.serverId === platformOverview.currentServerId) return;
    setBusy(true);
    setMessage("");
    try {
      const connection = await getConnectionTicket(server.serverId);
      if (!connection.endpointUrl) {
        throw new Error("The server owner has not configured a verified remote address yet.");
      }
      await savePlatformPreferences({ selectedServerId: server.serverId }).catch(() => undefined);
      const form = document.createElement("form");
      form.method = "POST";
      form.action = `${connection.endpointUrl}/api/auth/exchange`;
      form.style.display = "none";
      const ticket = document.createElement("input");
      ticket.type = "hidden";
      ticket.name = "ticket";
      ticket.value = connection.ticket;
      const redirect = document.createElement("input");
      redirect.type = "hidden";
      redirect.name = "redirect";
      redirect.value = "true";
      form.append(ticket, redirect);
      document.body.append(form);
      form.submit();
    } catch (error) {
      handleError(error, "Unable to connect to that server");
      setBusy(false);
    }
  };

  if (!auth) {
    return (
      <div className="login-screen">
        <div className="login-panel">
          <Loader2 className="spin" size={24} />
        </div>
      </div>
    );
  }

  if (auth.enabled && !auth.authenticated) {
    return (
      <LoginScreen
        busy={busy}
        message={message}
        registrationEnabled={Boolean(auth.registrationEnabled)}
        registrationDisabledReason={auth.registrationDisabledReason}
        onLogin={(username, password) => void handleLogin(username, password)}
        onRegister={(input) => void handleRegister(input)}
      />
    );
  }

  const activeLibraryType: MediaType | null = activeView === "ebooks"
    ? "ebook"
    : activeView === "audiobooks"
      ? "audiobook"
      : null;
  const libraryScopedBooks = activeLibraryType
    ? filteredBooks.filter((book) =>
        book.mediaType === activeLibraryType &&
        (!activeLibraryId || (book.libraryIds || []).includes(activeLibraryId))
      )
    : filteredBooks;
  const activeViewCount = activeLibraryType
    ? libraryScopedBooks.length
    : activeView === "profile"
      ? (profile?.stats.booksRead || 0) + (profile?.stats.audiobooksListened || 0)
      : activeView === "libby"
        ? libbyBooks.length
        : books.length;
  const activeViewCountLabel = activeView === "profile"
    ? (activeViewCount === 1 ? "completed" : "completed")
    : activeView === "libby"
      ? (activeViewCount === 1 ? "loan" : "loans")
      : (activeViewCount === 1 ? "title" : "titles");
  const showBookDetails = hasCurrentServerAccess && detailsBookId !== null;
  const isLibbyReading = activeView === "libby" && readerOpen;
  const isReaderFocused = (activeLibraryType !== null || isLibbyReading) && readerOpen;

  return (
    <div className={`app-shell theme-${preferences.theme} ${sidebarOpen ? "sidebar-expanded" : "sidebar-collapsed"} ${isReaderFocused ? "reader-focus" : ""} ${listening ? "has-player-bar" : ""}`}>
      <aside className={`library-panel ${sidebarOpen ? "is-open" : ""}`}>
        <div className="sidebar-header">
          <button
            type="button"
            className="icon-button sidebar-toggle"
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            aria-expanded={sidebarOpen}
            onClick={() => {
              setUserMenuOpen(false);
              setSidebarOpen((value) => !value);
            }}
          >
            <Menu size={19} />
          </button>
          <div className="brand-row sidebar-brand">
            <div className="brand-mark">
              <BookOpen size={20} />
            </div>
            <div className="sidebar-copy">
              <h1 className="brand-heading">Shelf</h1>
              <span>{activeServer?.name || "Your books, anywhere"}</span>
            </div>
          </div>
        </div>

        <ServerSwitcher
          servers={platformOverview?.servers || []}
          currentServerId={platformOverview?.currentServerId || ""}
          expanded={sidebarOpen}
          loading={platformLoading || busy}
          onSelect={(server) => void handleServerSelect(server)}
        />

        <nav className="sidebar-nav" aria-label="Main navigation">
          {hasCurrentServerAccess ? (
            <>
              <SidebarNavButton
                active={activeView === "home"}
                icon={<House size={19} />}
                label="Home"
                onClick={() => handleViewSelect("home")}
              />
              <span className="sidebar-section-label">Libraries</span>
              {availableLibraries.map((library) => (
                <SidebarNavButton
                  key={library.id}
                  active={activeLibraryId === library.id && activeLibraryType !== null}
                  icon={library.mediaType === "audiobook" ? <Headphones size={19} /> : <BookOpen size={19} />}
                  label={library.name}
                  onClick={() => handleLibrarySelect(library)}
                />
              ))}
              <SidebarNavButton
                active={activeView === "libby"}
                icon={<Library size={19} />}
                label="Libby"
                onClick={() => handleViewSelect("libby")}
              />
              <span className="sidebar-section-label">You</span>
              <SidebarNavButton
                active={activeView === "profile"}
                icon={<CircleUserRound size={19} />}
                label="Profile"
                onClick={() => handleViewSelect("profile")}
              />
              <SidebarNavButton
                active={activeView === "marks"}
                icon={<Edit3 size={19} />}
                label="Notes & Highlights"
                onClick={() => handleViewSelect("marks")}
              />
              {canManageServer ? (
                <SidebarNavButton
                  active={activeView === "add"}
                  icon={<Plus size={19} />}
                  label="Add Title"
                  onClick={() => handleViewSelect("add")}
                />
              ) : null}
            </>
          ) : (
            <SidebarNavButton
              active
              icon={<Server size={19} />}
              label="Servers"
              onClick={() => setActiveView("home")}
            />
          )}
        </nav>

        <AccountMenu
          user={auth.user}
          expanded={sidebarOpen}
          open={userMenuOpen}
          canManageUsers={canManageServer}
          serverRole={activeServer?.role || null}
          onToggle={() => setUserMenuOpen((value) => !value)}
          onViewProfile={() => handleViewSelect("profile")}
          onChangePassword={() => {
            setUserMenuOpen(false);
            setAccountOpen(true);
          }}
          onOpenSettings={() => {
            setUserMenuOpen(false);
            setSettingsOpen(true);
          }}
          onManageUsers={() => {
            setUserMenuOpen(false);
            setUsersOpen(true);
          }}
          onManageServer={() => {
            setUserMenuOpen(false);
            setServerSettingsOpen(true);
          }}
          onManageAccess={() => {
            setUserMenuOpen(false);
            setServerAccessOpen(true);
          }}
          onLogout={() => void handleLogout()}
        />
      </aside>

      {isCompactLayout && sidebarOpen ? (
        <button
          type="button"
          className="library-scrim"
          aria-label="Close library"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <main className={`reader-stage ${isReaderFocused ? "is-reader-focused" : ""}`}>
        {!isReaderFocused ? (
          <div className="top-strip">
            <button
              type="button"
              className="icon-button mobile-sidebar-toggle"
              title="Toggle library"
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((value) => !value)}
            >
              <Menu size={19} />
            </button>
            <div className="active-title">
              <span>{activeLibraryType && activeLibrary ? activeLibrary.name : viewTitle(activeView)}</span>
              <small>{activeViewCount} {activeViewCountLabel}</small>
            </div>
            {hasCurrentServerAccess ? (
              <GlobalSearch books={books} onOpenBook={openBookDetails} />
            ) : null}
            <div className="top-actions">
              {canManageServer ? (
                <button
                  type="button"
                  className={`activity-trigger ${activityOpen ? "is-active" : ""}`}
                  title="Reading and listening activity"
                  aria-label={`${readingActivity.length} active ${readingActivity.length === 1 ? "reader" : "readers"}`}
                  onClick={() => {
                    setActivityOpen(true);
                    void refreshActivity();
                  }}
                >
                  <Activity size={19} />
                  <span className="activity-count">
                    <span>{readingActivity.length}</span>
                  </span>
                  <span className="activity-label">Activity</span>
                </button>
              ) : null}
              <ThemeControls preferences={preferences} onPreferencesChange={updatePreferences} compact />
              {busy ? <Loader2 className="spin" size={18} /> : null}
            </div>
          </div>
        ) : null}

        {message ? <div className="message-bar">{message}</div> : null}

        {showBookDetails && detailsBookId ? (
          <BookDetailsView
            bookId={detailsBookId}
            books={books}
            canManageBook={canManageServer}
            inReadList={readListIds.has(detailsBookId)}
            nowPlaying={listening?.bookId === detailsBookId && listeningPlaying}
            onPlayAt={(book, locator) => void handleListen(book.id, locator)}
            onBack={closeBookDetails}
            onOpenBook={openBookDetails}
            onStart={(book) => {
              if (book.mediaType === "audiobook") {
                void handleListen(book.id);
                return;
              }
              leaveBookDetails();
              handleReadBook(book.id);
            }}
            onOpenMark={(book, target) => {
              leaveBookDetails();
              void handleOpenProfileMark(book, target);
            }}
            onAuthorSelect={handleAuthorSelect}
            onSetReadState={(bookId, read) => void handleSetBookReadState(bookId, read)}
            onToggleReadList={(bookId) => void handleToggleReadList(bookId)}
            onEditBook={(book) => setMetadataBook(book)}
            onGetArtwork={(book) => setArtworkBook(book)}
            onDeleteBook={(book) => void handleDeleteBook(book)}
            onSendToKindle={(book) => void handleOpenSendToKindle(book)}
            onDeleteBookmark={handleDeleteBookBookmark}
            onReviewSaved={() => void refreshProfile().catch(() => undefined)}
            onError={handleError}
          />
        ) : null}

        {!showBookDetails ? (<>
        {!hasCurrentServerAccess && platformOverview ? (
          <ServerOnboarding
            accountName={platformOverview.account.displayName}
            pendingInvitations={platformOverview.pendingInvitations}
            loading={platformLoading || busy}
            onAccept={async (token) => {
              setBusy(true);
              try {
                const next = await acceptServerInvitation(token);
                setPlatformOverview(next);
                setMessage("Server invitation accepted.");
              } catch (error) {
                handleError(error, "Unable to accept invitation");
              } finally {
                setBusy(false);
              }
            }}
            onClaim={async (endpointUrl, claimCode) => {
              setBusy(true);
              try {
                const next = await claimServer(endpointUrl, claimCode);
                setPlatformOverview(next);
                setMessage("Server claimed and added to your account.");
              } catch (error) {
                handleError(error, "Unable to claim server");
              } finally {
                setBusy(false);
              }
            }}
          />
        ) : activeView === "home" ? (
          <HomeView
            books={books}
            canManageBooks={canManageServer}
            onReadBook={openBookDetails}
            onStartBook={handleReadBook}
            onAuthorSelect={handleAuthorSelect}
            onSetReadState={(bookId, read) => void handleSetBookReadState(bookId, read)}
            onEditBook={(book) => setMetadataBook(book)}
            onGetArtwork={(book) => setArtworkBook(book)}
            onDeleteBook={(book) => void handleDeleteBook(book)}
            readListIds={readListIds}
            onToggleReadList={(bookId) => void handleToggleReadList(bookId)}
            onViewEbooks={() => {
              const library = availableLibraries.find((item) => item.mediaType === "ebook" || item.mediaType === "mixed");
              if (library) handleLibrarySelect(library); else handleViewSelect("ebooks");
            }}
            onViewAudiobooks={() => {
              const library = availableLibraries.find((item) => item.mediaType === "audiobook" || item.mediaType === "mixed");
              if (library) handleLibrarySelect(library); else handleViewSelect("audiobooks");
            }}
            onAddBook={() => handleViewSelect("add")}
          />
        ) : null}

        {hasCurrentServerAccess && activeView === "libby" && !readerOpen ? (
          <LibbyView
            status={libbyStatus}
            books={libbyBooks}
            loading={libbyLoading}
            playingBookId={listening && listeningPlaying ? listening.bookId : null}
            onStart={handleStartLibbyLoan}
            onRefresh={() => void refreshLibby(true).catch((error) => handleError(error, "Unable to load Libby loans"))}
            onLink={async (code) => {
              await linkLibby(code);
              await refreshLibby(true);
            }}
            onUnlink={async () => {
              if (listening?.bookId.startsWith("libby-")) {
                handleStopListening();
              }
              await unlinkLibby();
              setLibbyBooks([]);
              setLibbyStatus({ linked: false, linkedAt: null, libraries: [] });
            }}
          />
        ) : null}

        {hasCurrentServerAccess && (activeLibraryType || isLibbyReading) ? (
          <LibraryView
            key={`${activeView}-${activeLibraryId || "all"}`}
            libraryType={activeLibraryType ? activeView as LibraryViewType : "ebooks"}
            books={libraryScopedBooks}
            activeBook={activeBook}
            activeBookId={activeBookId}
            readerOpen={readerOpen}
            query={query}
            authorFilter={authorFilter}
            reader={reader}
            preferences={preferences}
            progress={currentProgress}
            selection={selection}
            dictionary={dictionary}
            dictionaryLoading={dictionaryLoading}
            jumpTarget={jumpTarget}
            canManageBooks={canManageServer}
            onQueryChange={setQuery}
            onClearAuthorFilter={() => setAuthorFilter(null)}
            onReadBook={openBookDetails}
            onStartBook={handleReadBook}
            onAuthorSelect={handleAuthorSelect}
            onSetReadState={(bookId, read) => void handleSetBookReadState(bookId, read)}
            onEditBook={(book) => setMetadataBook(book)}
            onGetArtwork={(book) => setArtworkBook(book)}
            onDeleteBook={(book) => void handleDeleteBook(book)}
            onSendToKindle={(book) => void handleOpenSendToKindle(book)}
            readListIds={readListIds}
            onToggleReadList={(bookId) => void handleToggleReadList(bookId)}
            onCloseReader={() => {
              setReaderOpen(false);
              handleDismissSelection();
            }}
            onProgress={handleProgress}
            onLookup={handleLookup}
            onDismissSelection={handleDismissSelection}
            onConvert={handleConvert}
            onBookmark={() => void handleBookmark()}
            onHighlight={() => void handleHighlight()}
            onPreferencesChange={updatePreferences}
            onDeleteBookmark={(bookmark) => void handleDeleteBookmark(bookmark)}
            onDeleteHighlight={(highlight) => void handleDeleteHighlight(highlight)}
            onSaveReview={(rating, text) => void handleSaveReview(rating, text)}
            onJump={handleJump}
            onUsage={(mediaType, seconds) => void handleProfileUsage(mediaType, seconds)}
          />
        ) : null}

        {hasCurrentServerAccess && activeView === "profile" && auth.user ? (
          <ProfileView
            profile={profile}
            loading={profileLoading}
            fallbackUser={auth.user}
            onOpenBook={openBookDetails}
            onOpenMark={(book, highlight) => void handleOpenProfileMark(book, highlight)}
            onToggleReadList={(bookId) => void handleToggleReadList(bookId)}
            onEditProfile={() => setAccountOpen(true)}
          />
        ) : null}

        {hasCurrentServerAccess && activeView === "marks" ? (
          <NotesHighlightsView
            activeBook={activeBook}
            reader={reader}
            onJump={handleJump}
            onDeleteBookmark={(bookmark) => void handleDeleteBookmark(bookmark)}
            onDeleteHighlight={(highlight) => void handleDeleteHighlight(highlight)}
          />
        ) : null}

        {hasCurrentServerAccess && canManageServer && activeView === "add" ? (
          <AddBookView busy={busy} onUpload={(files) => void handleUploadBooks(files)} />
        ) : null}
        </>) : null}

        {listening && listeningBook ? (
          // Stays mounted on every page so playback continues as you browse.
          <div className="audiobook-player-dock">
            <AudiobookPlayer
              key={listening.bookId}
              book={listeningBook}
              tracks={listening.reader.audioTracks}
              progress={listening.progress}
              autoPlay={listening.autoPlay}
              playRequest={playRequest}
              seekRequest={seekRequest}
              skipBackSeconds={preferences.skipBackSeconds}
              skipForwardSeconds={preferences.skipForwardSeconds}
              inReadList={readListIds.has(listening.bookId)}
              read={isBookRead(listeningBook)}
              onProgress={handleListeningProgress}
              onPlayingChange={setListeningPlaying}
              onBookmark={() => void handleListeningBookmark()}
              onAddNote={handleAddListeningNote}
              onToggleReadList={() => void handleToggleReadList(listening.bookId)}
              onSetReadState={(read) => void handleSetBookReadState(listening.bookId, read)}
              onOpenDetails={() =>
                listening.bookId.startsWith("libby-") ? handleViewSelect("libby") : openBookDetails(listening.bookId)
              }
              onClose={handleStopListening}
              onUsage={(mediaType, seconds) => void handleProfileUsage(mediaType, seconds)}
              controlsRef={listeningControlsRef}
            />
          </div>
        ) : null}
      </main>

      {settingsOpen ? (
        <SettingsPanel
          preferences={preferences}
          onPreferencesChange={updatePreferences}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {accountOpen && auth.user ? (
        <AccountSettingsPanel
          user={auth.user}
          onClose={() => setAccountOpen(false)}
          onError={(error, fallback) => handleError(error, fallback)}
        />
      ) : null}

      {usersOpen && canManageServer && auth.user ? (
        <UserManagementPanel
          currentUser={auth.user}
          onClose={() => setUsersOpen(false)}
          onError={(error, fallback) => handleError(error, fallback)}
        />
      ) : null}

      {serverSettingsOpen && activeServer && canManageServer ? (
        <ServerSettingsPanel
          server={activeServer}
          currentAccountId={platformOverview?.account.id || ""}
          onClose={() => setServerSettingsOpen(false)}
          onPlatformChange={(next) => setPlatformOverview(next)}
          onRefreshPlatform={() => refreshPlatform()}
          onError={(error, fallback) => handleError(error, fallback)}
        />
      ) : null}

      {serverAccessOpen && platformOverview ? (
        <ServerAccessPanel
          overview={platformOverview}
          busy={busy}
          onClose={() => setServerAccessOpen(false)}
          onAccept={async (token) => {
            setBusy(true);
            try {
              const next = await acceptServerInvitation(token);
              setPlatformOverview(next);
              setMessage("Server invitation accepted.");
              setServerAccessOpen(false);
            } catch (error) { handleError(error, "Unable to accept invitation"); }
            finally { setBusy(false); }
          }}
          onClaim={async (endpointUrl, claimCode) => {
            setBusy(true);
            try {
              const next = await claimServer(endpointUrl, claimCode);
              setPlatformOverview(next);
              setMessage("Server claimed and added to your account.");
              setServerAccessOpen(false);
            } catch (error) { handleError(error, "Unable to claim server"); }
            finally { setBusy(false); }
          }}
        />
      ) : null}

      {activityOpen && canManageServer ? (
        <ActivityPanel
          activity={readingActivity}
          loading={activityLoading}
          onRefresh={() => void refreshActivity()}
          onClose={() => setActivityOpen(false)}
        />
      ) : null}

      {metadataBook && canManageServer ? (
        <BookMetadataDialog
          book={metadataBook}
          busy={busy}
          onClose={() => setMetadataBook(null)}
          onSave={(metadata, coverFile) => void handleUpdateBookMetadata(metadataBook.id, metadata, coverFile)}
        />
      ) : null}

      {artworkBook && canManageServer ? (
        <ArtworkDialog
          book={artworkBook}
          onClose={() => setArtworkBook(null)}
          onSaved={(updated) => {
            applyUpdatedBook(updated);
            setArtworkBook(null);
            setMessage("Artwork updated.");
          }}
        />
      ) : null}

      {kindleBook ? (
        <SendToKindleDialog
          book={kindleBook}
          settings={kindleSettings}
          loading={kindleSettingsLoading}
          sending={kindleSending}
          onClose={() => {
            if (!kindleSending) {
              setKindleBook(null);
              setKindleSettings(null);
            }
          }}
          onSend={(kindleEmail) => handleConfirmSendToKindle(kindleEmail)}
        />
      ) : null}
    </div>
  );
}

function LoginScreen({
  busy,
  message,
  registrationEnabled,
  registrationDisabledReason,
  onLogin,
  onRegister
}: {
  busy: boolean;
  message: string;
  registrationEnabled: boolean;
  registrationDisabledReason?: string | null;
  onLogin: (username: string, password: string) => void;
  onRegister: (input: {
    username: string;
    displayName: string;
    email?: string;
    password: string;
    passwordConfirm: string;
    website?: string;
  }) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [registerForm, setRegisterForm] = useState({
    username: "",
    displayName: "",
    email: "",
    password: "",
    passwordConfirm: "",
    website: ""
  });
  const showRegistrationSwitch = registrationEnabled || Boolean(registrationDisabledReason);

  return (
    <div className="login-screen">
      <form
        className="login-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (mode === "login") {
            onLogin(username, password);
          } else {
            onRegister(registerForm);
          }
        }}
      >
        <div className="brand-row">
          <div className="brand-mark">
            <BookOpen size={20} />
          </div>
          <div>
            <h1 className="brand-heading">Shelf</h1>
            <span>Private library access</span>
          </div>
        </div>

        <div className="login-heading">
          <LockKeyhole size={24} />
          <h2>{mode === "login" ? "Sign in" : "Create account"}</h2>
        </div>

        {message ? <div className="message-bar">{message}</div> : null}

        {showRegistrationSwitch ? (
          <div className="login-mode-switch" aria-label="Sign in or create account">
            <button
              type="button"
              className={mode === "login" ? "is-active" : ""}
              onClick={() => setMode("login")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={mode === "register" ? "is-active" : ""}
              disabled={!registrationEnabled}
              title={registrationDisabledReason || undefined}
              onClick={() => setMode("register")}
            >
              Register
            </button>
          </div>
        ) : null}
        {!registrationEnabled && registrationDisabledReason ? (
          <div className="registration-note">{registrationDisabledReason}</div>
        ) : null}

        {mode === "login" ? (
          <>
            <label className="field-stack">
              <span>Username</span>
              <input
                value={username}
                autoComplete="username"
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>

            <label className="field-stack">
              <span>Password</span>
              <input
                value={password}
                type="password"
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <label className="field-stack">
              <span>Username</span>
              <input
                value={registerForm.username}
                autoComplete="username"
                onChange={(event) =>
                  setRegisterForm((current) => ({ ...current, username: event.target.value }))
                }
              />
            </label>

            <label className="field-stack">
              <span>Display name</span>
              <input
                value={registerForm.displayName}
                autoComplete="name"
                onChange={(event) =>
                  setRegisterForm((current) => ({ ...current, displayName: event.target.value }))
                }
              />
            </label>

            <label className="field-stack">
              <span>Email</span>
              <input
                value={registerForm.email}
                type="email"
                autoComplete="email"
                placeholder="For invitations and account recovery"
                onChange={(event) =>
                  setRegisterForm((current) => ({ ...current, email: event.target.value }))
                }
              />
            </label>

            <label className="field-stack">
              <span>Password</span>
              <input
                value={registerForm.password}
                type="password"
                autoComplete="new-password"
                onChange={(event) =>
                  setRegisterForm((current) => ({ ...current, password: event.target.value }))
                }
              />
            </label>

            <label className="field-stack">
              <span>Confirm password</span>
              <input
                value={registerForm.passwordConfirm}
                type="password"
                autoComplete="new-password"
                onChange={(event) =>
                  setRegisterForm((current) => ({
                    ...current,
                    passwordConfirm: event.target.value
                  }))
                }
              />
            </label>

            <label className="visually-hidden">
              Website
              <input
                value={registerForm.website}
                tabIndex={-1}
                autoComplete="off"
                onChange={(event) =>
                  setRegisterForm((current) => ({ ...current, website: event.target.value }))
                }
              />
            </label>
          </>
        )}

        <button type="submit" className="primary-button login-button" disabled={busy}>
          {busy ? <Loader2 className="spin" size={18} /> : <LockKeyhole size={18} />}
          {mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}

function SidebarNavButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar-nav-item ${active ? "is-active" : ""}`}
      title={label}
      onClick={onClick}
    >
      <span className="sidebar-nav-icon">{icon}</span>
      <span className="sidebar-label">{label}</span>
    </button>
  );
}

function ServerSwitcher({
  servers,
  currentServerId,
  expanded,
  loading,
  onSelect
}: {
  servers: ShelfServer[];
  currentServerId: string;
  expanded: boolean;
  loading: boolean;
  onSelect: (server: ShelfServer) => void;
}) {
  const current = servers.find((server) => server.serverId === currentServerId) || null;
  if (!expanded) {
    return (
      <div className="server-switcher is-collapsed" title={current?.name || "No server selected"}>
        <Server size={18} />
        <span className={current?.status === "online" ? "is-online" : ""} />
      </div>
    );
  }
  return (
    <label className="server-switcher">
      <span className="server-switcher-label">Server</span>
      <span className="server-switcher-control">
        <Server size={16} />
        <select
          value={currentServerId}
          disabled={loading || servers.length === 0}
          onChange={(event) => {
            const selected = servers.find((server) => server.serverId === event.target.value);
            if (selected) onSelect(selected);
          }}
        >
          {servers.length ? servers.map((server) => (
            <option value={server.serverId} key={server.serverId}>
              {server.name} · {server.role}
            </option>
          )) : <option value="">No servers yet</option>}
        </select>
        <ChevronDown size={14} />
      </span>
    </label>
  );
}

function GlobalSearch({ books, onOpenBook }: { books: Book[]; onOpenBook: (bookId: string) => void }) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const matches = useMemo(() => {
    const term = value.trim().toLowerCase();
    if (!term) return [];
    return books.filter((book) =>
      `${book.title} ${book.subtitle || ""} ${book.author || ""} ${book.series || ""}`
        .toLowerCase().includes(term)
    ).slice(0, 8);
  }, [books, value]);

  return (
    <div className="global-search" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    }}>
      <label>
        <Search size={17} />
        <input
          value={value}
          placeholder="Search this server"
          aria-label="Search every library on this server"
          onFocus={() => setFocused(true)}
          onChange={(event) => {
            setValue(event.target.value);
            setFocused(true);
          }}
        />
        {value ? (
          <button type="button" aria-label="Clear search" onClick={() => setValue("")}><X size={14} /></button>
        ) : null}
      </label>
      {focused && value.trim() ? (
        <div className="global-search-results">
          {matches.length ? matches.map((book) => (
            <button type="button" key={`${book.serverId || "server"}:${book.id}`} onClick={() => {
              onOpenBook(book.id);
              setValue("");
              setFocused(false);
            }}>
              <BookCover book={book} />
              <span><strong>{book.title}</strong><small>{book.author || "Unknown author"}</small></span>
              <span className="global-search-format">{book.mediaType === "audiobook" ? "Audio" : "Book"}</span>
            </button>
          )) : <div className="global-search-empty">No titles found on this server.</div>}
        </div>
      ) : null}
    </div>
  );
}

function ServerOnboarding({
  accountName,
  pendingInvitations,
  loading,
  onAccept,
  onClaim
}: {
  accountName: string;
  pendingInvitations: ServerInvitation[];
  loading: boolean;
  onAccept: (token: string) => Promise<void>;
  onClaim: (endpointUrl: string, claimCode: string) => Promise<void>;
}) {
  const [inviteToken, setInviteToken] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [claimCode, setClaimCode] = useState("");
  return (
    <section className="server-onboarding">
      <div className="server-onboarding-hero">
        <span className="server-onboarding-icon"><Server size={30} /></span>
        <div>
          <span className="profile-eyebrow">Shelf account ready</span>
          <h2>Welcome, {accountName}</h2>
          <p>Join a server with an invitation, or claim a Shelf server you host. Your account and a server’s private library access are intentionally separate.</p>
        </div>
      </div>
      {pendingInvitations.length ? (
        <div className="server-onboarding-section">
          <h3>Invitations waiting for you</h3>
          {pendingInvitations.map((invitation) => (
            <article className="pending-invite-card" key={invitation.id}>
              <div><strong>{invitation.serverName || "Shelf Server"}</strong><span>{invitation.role} access · expires {formatShortDate(invitation.expiresAt)}</span></div>
              <span>Open the invitation link to accept securely.</span>
            </article>
          ))}
        </div>
      ) : null}
      <div className="server-onboarding-grid">
        <form onSubmit={(event) => { event.preventDefault(); void onAccept(inviteToken); }}>
          <ShieldCheck size={22} />
          <h3>Join a server</h3>
          <p>Paste the one-use invitation token sent by the server owner.</p>
          <input value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} placeholder="Invitation token" required />
          <button type="submit" className="primary-button" disabled={loading || !inviteToken.trim()}>Accept invitation</button>
        </form>
        <form onSubmit={(event) => { event.preventDefault(); void onClaim(endpointUrl, claimCode); }}>
          <Server size={22} />
          <h3>Claim your server</h3>
          <p>Enter its HTTPS address and the temporary code shown by the local setup screen.</p>
          <input value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} placeholder="https://books.example.com" type="url" required />
          <input value={claimCode} onChange={(event) => setClaimCode(event.target.value.toUpperCase())} placeholder="Claim code" required />
          <button type="submit" className="primary-button" disabled={loading || !endpointUrl || !claimCode}>Claim server</button>
        </form>
      </div>
    </section>
  );
}

function ServerAccessPanel({
  overview,
  busy,
  onClose,
  onAccept,
  onClaim
}: {
  overview: PlatformOverview;
  busy: boolean;
  onClose: () => void;
  onAccept: (token: string) => Promise<void>;
  onClaim: (endpointUrl: string, claimCode: string) => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [claimCode, setClaimCode] = useState("");
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Add or join a server">
      <section className="modal-panel server-access-panel">
        <div className="modal-heading">
          <div><span className="profile-eyebrow">My servers</span><h2>Add or join a server</h2><p>One Shelf account can connect to any server you own or have been invited to.</p></div>
          <button type="button" className="icon-button" title="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="connected-server-list">
          {overview.servers.map((server) => (
            <article key={server.serverId}>
              <Server size={18} />
              <div><strong>{server.name}</strong><span>{server.role} · {server.libraries.length} libraries</span></div>
              <span className={server.status === "online" ? "is-online" : ""}>{server.status}</span>
            </article>
          ))}
        </div>
        <div className="server-access-grid">
          <form onSubmit={(event) => { event.preventDefault(); void onAccept(token); }}>
            <ShieldCheck size={20} /><h3>Join with an invitation</h3>
            <p>Paste the token from a one-use invite link.</p>
            <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Invitation token" required />
            <button type="submit" className="primary-button" disabled={busy || !token.trim()}>Join server</button>
          </form>
          <form onSubmit={(event) => { event.preventDefault(); void onClaim(endpointUrl, claimCode); }}>
            <Server size={20} /><h3>Claim a server you host</h3>
            <p>Use the address and temporary code shown on that machine.</p>
            <input value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} placeholder="https://books.example.com" type="url" required />
            <input value={claimCode} onChange={(event) => setClaimCode(event.target.value.toUpperCase())} placeholder="Claim code" required />
            <button type="submit" className="primary-button" disabled={busy || !endpointUrl || !claimCode}>Claim server</button>
          </form>
        </div>
      </section>
    </div>
  );
}

function AccountMenu({
  user,
  expanded,
  open,
  canManageUsers,
  serverRole,
  onToggle,
  onViewProfile,
  onChangePassword,
  onOpenSettings,
  onManageUsers,
  onManageServer,
  onManageAccess,
  onLogout
}: {
  user: User | null;
  expanded: boolean;
  open: boolean;
  canManageUsers: boolean;
  serverRole: ServerRole | null;
  onToggle: () => void;
  onViewProfile: () => void;
  onChangePassword: () => void;
  onOpenSettings: () => void;
  onManageUsers: () => void;
  onManageServer: () => void;
  onManageAccess: () => void;
  onLogout: () => void;
}) {
  const displayName = user?.displayName || user?.username || "Account";
  const initial = displayName.slice(0, 1).toUpperCase() || "U";

  return (
    <div className={`account-menu ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="account-trigger"
        title={displayName}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="account-avatar">{initial}</span>
        <span className="account-copy">
          <strong>{displayName}</strong>
          <small>{serverRole || "account"}</small>
        </span>
      </button>

      {open ? (
        <div className={`account-popover ${expanded ? "is-expanded" : "is-collapsed"}`}>
          <div className="account-popover-heading">
            <strong>{displayName}</strong>
            <span>{user?.username}</span>
          </div>
          <button type="button" onClick={onViewProfile}>
            <CircleUserRound size={16} />
            <span>View profile</span>
          </button>
          <button type="button" onClick={onOpenSettings}>
            <SlidersHorizontal size={16} />
            <span>Settings</span>
          </button>
          <button type="button" onClick={onChangePassword}>
            <LockKeyhole size={16} />
            <span>Change password</span>
          </button>
          <button type="button" onClick={onManageAccess}>
            <Server size={16} />
            <span>Add or join a server</span>
          </button>
          {canManageUsers ? (
            <button type="button" onClick={onManageServer}>
              <Settings size={16} />
              <span>Server settings</span>
            </button>
          ) : null}
          <button type="button" disabled title="Libby / OverDrive sync is planned for a later version">
            <Library size={16} />
            <span>Connect Libby / OverDrive</span>
          </button>
          {canManageUsers ? (
            <button type="button" onClick={onManageUsers}>
              <Users size={16} />
              <span>Legacy local users</span>
            </button>
          ) : null}
          <button type="button" onClick={onLogout}>
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SettingsPanel({
  preferences,
  onPreferencesChange,
  onClose
}: {
  preferences: ReaderPreferences;
  onPreferencesChange: (patch: Partial<ReaderPreferences>) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal-panel settings-panel" aria-labelledby="settings-title">
        <div className="modal-heading">
          <div>
            <h2 id="settings-title">Settings</h2>
            <p>Saved to your account on this server.</p>
          </div>
          <button type="button" className="icon-button" title="Close settings" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <section className="settings-section" aria-labelledby="settings-playback-title">
          <h3 id="settings-playback-title">Playback</h3>
          <SkipSecondsField
            label="Skip forwards"
            value={preferences.skipForwardSeconds}
            onChange={(seconds) => onPreferencesChange({ skipForwardSeconds: seconds })}
          />
          <SkipSecondsField
            label="Skip backwards"
            value={preferences.skipBackSeconds}
            onChange={(seconds) => onPreferencesChange({ skipBackSeconds: seconds })}
          />
        </section>
      </section>
    </div>
  );
}

function SkipSecondsField({
  label,
  value,
  onChange
}: {
  label: string;
  value: number;
  onChange: (seconds: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (text: string) => {
    const seconds = Number(text);
    if (text.trim() === "" || !Number.isFinite(seconds)) {
      setDraft(String(value));
      return;
    }
    const next = normalizeSkipSeconds(seconds, value);
    setDraft(String(next));
    if (next !== value) {
      onChange(next);
    }
  };

  return (
    <label className="settings-row">
      <span>{label}</span>
      <span className="settings-seconds">
        <input
          type="number"
          inputMode="numeric"
          min={MIN_SKIP_SECONDS}
          max={MAX_SKIP_SECONDS}
          step="1"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit(event.currentTarget.value);
            }
          }}
        />
        <span>seconds</span>
      </span>
    </label>
  );
}

function AccountSettingsPanel({
  user,
  onClose,
  onError
}: {
  user: User;
  onClose: () => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");

    if (newPassword.length < 8) {
      setMessage("Use at least 8 characters for the new password.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setMessage("The new passwords do not match.");
      return;
    }

    setBusy(true);
    try {
      await updateOwnPassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage("Password updated.");
    } catch (error) {
      onError(error, "Unable to update password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <form className="modal-panel account-settings-panel" onSubmit={(event) => void handleSubmit(event)}>
        <div className="modal-heading">
          <div>
            <h2>Account</h2>
            <p>{user.displayName || user.username}</p>
          </div>
          <button type="button" className="icon-button" title="Close account settings" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {message ? <div className="message-bar inline-message">{message}</div> : null}

        <label className="field-stack">
          <span>Current password</span>
          <input
            value={currentPassword}
            type="password"
            autoComplete="current-password"
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>

        <label className="field-stack">
          <span>New password</span>
          <input
            value={newPassword}
            type="password"
            autoComplete="new-password"
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>

        <label className="field-stack">
          <span>Confirm new password</span>
          <input
            value={confirmPassword}
            type="password"
            autoComplete="new-password"
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </label>

        <div className="integration-placeholder">
          <Library size={18} />
          <div>
            <strong>Libby / OverDrive</strong>
            <span>Library sync will connect here in a future version.</span>
          </div>
        </div>

        <button type="submit" className="primary-button login-button" disabled={busy}>
          {busy ? <Loader2 className="spin" size={18} /> : <LockKeyhole size={18} />}
          Update password
        </button>
      </form>
    </div>
  );
}

function SendToKindleDialog({
  book,
  settings,
  loading,
  sending,
  onClose,
  onSend
}: {
  book: Book;
  settings: KindleSettings | null;
  loading: boolean;
  sending: boolean;
  onClose: () => void;
  onSend: (kindleEmail: string) => Promise<void>;
}) {
  const [kindleEmail, setKindleEmail] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (settings) {
      setKindleEmail(settings.kindleEmail || "");
      setMessage("");
    }
  }, [settings]);

  const normalizedEmail = kindleEmail.trim().toLowerCase();
  const emailValid = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@kindle\.com$/i.test(normalizedEmail);
  const tooLarge = Boolean(settings && book.size > settings.maxAttachmentBytes);
  const canSend = Boolean(settings?.deliveryConfigured && emailValid && !tooLarge && !loading && !sending);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage("");
    if (!emailValid) {
      setMessage("Enter the @kindle.com address assigned to your Kindle device or app.");
      return;
    }
    try {
      await onSend(normalizedEmail);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to send this EPUB to Kindle.");
    }
  };

  return (
    <div className="modal-backdrop">
      <form className="modal-panel send-to-kindle-panel" onSubmit={(event) => void handleSubmit(event)}>
        <div className="modal-heading">
          <div>
            <h2>Send to Kindle</h2>
            <p>{book.title} · {formatFileSize(book.size)}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Close Send to Kindle"
            disabled={sending}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="kindle-settings-loading">
            <Loader2 className="spin" size={20} />
            Loading delivery settings…
          </div>
        ) : (
          <>
            {message ? <div className="message-bar inline-message">{message}</div> : null}

            {!settings?.deliveryConfigured ? (
              <div className="kindle-warning">
                <strong>Email delivery is not configured</strong>
                <span>An administrator must configure Shelf’s SMTP settings before EPUBs can be sent.</span>
              </div>
            ) : null}

            {tooLarge && settings ? (
              <div className="kindle-warning">
                <strong>This EPUB is too large to email</strong>
                <span>The configured limit is {formatFileSize(settings.maxAttachmentBytes)}.</span>
              </div>
            ) : null}

            <label className="field-stack">
              <span>Your Send to Kindle email</span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="your-device@kindle.com"
                value={kindleEmail}
                disabled={sending}
                autoFocus
                onChange={(event) => setKindleEmail(event.target.value)}
              />
              <small>This address is saved only to your Shelf account for future sends.</small>
            </label>

            {settings?.senderEmail ? (
              <div className="kindle-approval-note">
                <Send size={19} />
                <div>
                  <strong>Approve {settings.senderEmail} with Amazon</strong>
                  <span>Amazon accepts documents only from addresses in your Approved Personal Document Email List.</span>
                  <a
                    href="https://www.amazon.com/hz/mycd/myx#/home/settings/payment"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Amazon Personal Document Settings
                  </a>
                </div>
              </div>
            ) : null}

            <div className="modal-actions">
              <button type="button" className="secondary-button" disabled={sending} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary-button" disabled={!canSend}>
                {sending ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
                {sending ? "Sending…" : "Send EPUB"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function BookMetadataDialog({
  book,
  busy,
  onClose,
  onSave
}: {
  book: Book;
  busy: boolean;
  onClose: () => void;
  onSave: (metadata: EditableBookMetadata, coverFile: File | null) => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [subtitle, setSubtitle] = useState(book.subtitle || "");
  const [series, setSeries] = useState(book.series || "");
  const [author, setAuthor] = useState(book.author || "Unknown author");
  const [sortTitle, setSortTitle] = useState(book.sortTitle || "");
  const [publisher, setPublisher] = useState(book.publisher || "");
  const [publicationDate, setPublicationDate] = useState(book.publicationDate || "");
  const [language, setLanguage] = useState(book.language || "");
  const [isbnAsin, setIsbnAsin] = useState(book.isbnAsin || "");
  const [description, setDescription] = useState(book.description || "");
  const [pageCount, setPageCount] = useState(book.pageCount ? String(book.pageCount) : "");
  const [categories, setCategories] = useState((book.categories || []).join(", "));
  const [contributors, setContributors] = useState((book.contributors || []).join("\n"));
  const [narrator, setNarrator] = useState(book.narrator || "");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [showSortTitle, setShowSortTitle] = useState(Boolean(book.sortTitle));
  const [message, setMessage] = useState("");

  useEffect(() => {
    setTitle(book.title);
    setSubtitle(book.subtitle || "");
    setSeries(book.series || "");
    setAuthor(book.author || "Unknown author");
    setSortTitle(book.sortTitle || "");
    setPublisher(book.publisher || "");
    setPublicationDate(book.publicationDate || "");
    setLanguage(book.language || "");
    setIsbnAsin(book.isbnAsin || "");
    setDescription(book.description || "");
    setPageCount(book.pageCount ? String(book.pageCount) : "");
    setCategories((book.categories || []).join(", "));
    setContributors((book.contributors || []).join("\n"));
    setNarrator(book.narrator || "");
    setCoverFile(null);
    setShowSortTitle(Boolean(book.sortTitle));
    setMessage("");
  }, [book]);

  useEffect(() => {
    if (!coverFile) {
      setCoverPreviewUrl(null);
      return;
    }
    const previewUrl = URL.createObjectURL(coverFile);
    setCoverPreviewUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [coverFile]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle) {
      setMessage("Title is required.");
      return;
    }
    const parsedPageCount = pageCount.trim() ? Number(pageCount) : null;
    if (parsedPageCount !== null && (!Number.isInteger(parsedPageCount) || parsedPageCount < 1)) {
      setMessage("Page count must be a whole number greater than zero.");
      return;
    }
    onSave({
      title: nextTitle,
      subtitle: subtitle.trim() || null,
      series: series.trim() || null,
      author: author.trim() || "Unknown author",
      sortTitle: showSortTitle ? sortTitle.trim() || null : null,
      publisher: publisher.trim() || null,
      publicationDate: publicationDate.trim() || null,
      language: language.trim() || null,
      isbnAsin: isbnAsin.trim() || null,
      description: description.trim() || null,
      pageCount: parsedPageCount,
      categories: splitMetadataValues(categories, /[\n,;]+/),
      contributors: splitMetadataValues(contributors, /\r?\n|;/),
      narrator: book.mediaType === "audiobook" ? narrator.trim() || null : null
    }, coverFile);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Edit book metadata">
      <form className="modal-panel book-metadata-panel" onSubmit={handleSubmit}>
        <div className="modal-heading">
          <div>
            <h2>Edit Metadata</h2>
            <p>{book.filename}</p>
          </div>
          <button type="button" className="icon-button" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {message ? <div className="message-bar inline-message">{message}</div> : null}

        <div className="metadata-fields-grid">
          <label className="field-stack">
            <span>Title</span>
            <input
              value={title}
              autoFocus
              maxLength={240}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label className="field-stack">
            <span>Subtitle</span>
            <input value={subtitle} maxLength={240} onChange={(event) => setSubtitle(event.target.value)} />
          </label>

          <label className="field-stack">
            <span>Series</span>
            <input value={series} maxLength={240} onChange={(event) => setSeries(event.target.value)} />
          </label>

          <label className="field-stack">
            <span>Author</span>
            <input value={author} maxLength={180} onChange={(event) => setAuthor(event.target.value)} />
          </label>

          <label className="field-stack">
            <span>Publisher</span>
            <input value={publisher} maxLength={180} onChange={(event) => setPublisher(event.target.value)} />
          </label>

          <label className="field-stack">
            <span>Publication date</span>
            <input
              value={publicationDate}
              maxLength={40}
              placeholder="YYYY-MM-DD or year"
              onChange={(event) => setPublicationDate(event.target.value)}
            />
          </label>

          <label className="field-stack">
            <span>Language</span>
            <input
              value={language}
              maxLength={80}
              placeholder="English or eng"
              onChange={(event) => setLanguage(event.target.value)}
            />
          </label>

          <label className="field-stack">
            <span>ISBN / ASIN</span>
            <input value={isbnAsin} maxLength={80} onChange={(event) => setIsbnAsin(event.target.value)} />
          </label>

          <label className="field-stack">
            <span>Page count</span>
            <input
              type="number"
              min="1"
              max="100000"
              step="1"
              value={pageCount}
              onChange={(event) => setPageCount(event.target.value)}
            />
          </label>

          {book.mediaType === "audiobook" ? (
            <label className="field-stack">
              <span>Narrator</span>
              <input value={narrator} maxLength={180} onChange={(event) => setNarrator(event.target.value)} />
            </label>
          ) : null}
        </div>

        {showSortTitle ? (
          <label className="field-stack">
            <span>Sort title</span>
            <input
              value={sortTitle}
              maxLength={240}
              placeholder="Red Rising Series Book 1"
              onChange={(event) => setSortTitle(event.target.value)}
            />
          </label>
        ) : (
          <button
            type="button"
            className="text-button metadata-sort-title-button"
            onClick={() => setShowSortTitle(true)}
          >
            Add Sort Title
          </button>
        )}

        <label className="field-stack metadata-wide-field">
          <span>Book description</span>
          <textarea
            value={description}
            maxLength={5000}
            rows={5}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>

        <label className="field-stack metadata-wide-field">
          <span>Categories / subjects</span>
          <textarea
            value={categories}
            maxLength={3000}
            rows={3}
            placeholder="Fiction, Adventure, Classics"
            onChange={(event) => setCategories(event.target.value)}
          />
          <small>Separate categories with commas, semicolons, or new lines.</small>
        </label>

        <label className="field-stack metadata-wide-field">
          <span>Contributors</span>
          <textarea
            value={contributors}
            maxLength={5000}
            rows={3}
            placeholder="One contributor per line"
            onChange={(event) => setContributors(event.target.value)}
          />
          <small>Use one contributor per line, or separate names with semicolons.</small>
        </label>

        <label className="field-stack metadata-cover-field">
          <span>Cover art</span>
          <span className="metadata-cover-picker">
            {coverPreviewUrl || book.coverUrl ? (
              <img src={coverPreviewUrl || book.coverUrl || ""} alt="Current book cover" />
            ) : (
              <span className="metadata-cover-placeholder">No cover</span>
            )}
            <span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => setCoverFile(event.target.files?.[0] || null)}
              />
              <small>JPEG, PNG, or WebP up to 10 MB.</small>
            </span>
          </span>
        </label>

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? <Loader2 className="spin" size={18} /> : <Edit3 size={18} />}
            Save metadata
          </button>
        </div>
      </form>
    </div>
  );
}

function ArtworkDialog({
  book,
  onClose,
  onSaved
}: {
  book: Book;
  onClose: () => void;
  onSaved: (book: Book) => void;
}) {
  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author || "");
  const [candidates, setCandidates] = useState<ArtworkCandidate[]>([]);
  const [selectedCoverId, setSelectedCoverId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState("");

  const runSearch = useCallback(async (nextTitle: string, nextAuthor: string) => {
    if (!nextTitle.trim()) {
      setMessage("Enter a title to search for artwork.");
      return;
    }
    setLoading(true);
    setMessage("");
    setSelectedCoverId(null);
    try {
      const next = await searchBookArtwork(book.id, nextTitle.trim(), nextAuthor.trim());
      setCandidates(next);
      if (!next.length) setMessage("No matching artwork was found. Try adjusting the title or author.");
    } catch (error) {
      setCandidates([]);
      setMessage(error instanceof Error ? error.message : "Unable to search for artwork.");
    } finally {
      setLoading(false);
    }
  }, [book.id]);

  useEffect(() => {
    void runSearch(book.title, book.author || "");
  }, [book.author, book.title, runSearch]);

  const handleApply = async () => {
    if (!selectedCoverId) return;
    setApplying(true);
    setMessage("");
    try {
      onSaved(await applyBookArtwork(book.id, selectedCoverId));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save artwork.");
      setApplying(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Get artwork for ${book.title}`}>
      <section className="modal-panel artwork-panel">
        <div className="modal-heading artwork-heading">
          <div>
            <div className="artwork-title-row">
              <ImagePlus size={23} />
              <h2>Get Artwork</h2>
            </div>
            <p>Choose a cover from Open Library. Your current artwork will remain until you save a selection.</p>
          </div>
          <button type="button" className="icon-button" title="Close" disabled={applying} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form
          className="artwork-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch(title, author);
          }}
        >
          <label className="field-stack">
            <span>Title</span>
            <input value={title} maxLength={240} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="field-stack">
            <span>Author</span>
            <input value={author} maxLength={180} onChange={(event) => setAuthor(event.target.value)} />
          </label>
          <button type="submit" className="secondary-button" disabled={loading || applying || !title.trim()}>
            {loading ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
            Search
          </button>
        </form>

        {message ? <div className="message-bar inline-message">{message}</div> : null}

        {loading ? (
          <div className="artwork-loading">
            <Loader2 className="spin" size={22} />
            Searching for covers…
          </div>
        ) : candidates.length ? (
          <div className="artwork-grid" role="list" aria-label="Artwork results">
            {candidates.map((candidate) => {
              const selected = selectedCoverId === candidate.coverId;
              return (
                <article key={candidate.id} className={`artwork-result ${selected ? "is-selected" : ""}`} role="listitem">
                  <button
                    type="button"
                    className="artwork-choice"
                    aria-pressed={selected}
                    onClick={() => setSelectedCoverId(candidate.coverId)}
                  >
                    <span className="artwork-image-wrap">
                      <img src={candidate.thumbnailUrl} alt={`Cover for ${candidate.title}`} loading="lazy" />
                      {selected ? <span className="artwork-selected-badge"><Check size={16} /></span> : null}
                    </span>
                    <span className="artwork-result-copy">
                      <strong>{candidate.title || book.title}</strong>
                      <span>{candidate.author || book.author || "Unknown author"}</span>
                      <small>{[candidate.publisher, candidate.year].filter(Boolean).join(" · ") || "Edition details unavailable"}</small>
                    </span>
                  </button>
                  <a href={candidate.sourceUrl} target="_blank" rel="noreferrer">
                    View on Open Library <ExternalLink size={12} />
                  </a>
                </article>
              );
            })}
          </div>
        ) : null}

        <div className="modal-actions artwork-actions">
          <button type="button" className="secondary-button" disabled={applying} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={!selectedCoverId || applying} onClick={() => void handleApply()}>
            {applying ? <Loader2 className="spin" size={18} /> : <ImagePlus size={18} />}
            {applying ? "Saving…" : "Use selected artwork"}
          </button>
        </div>
      </section>
    </div>
  );
}

function splitMetadataValues(value: string, separator: RegExp) {
  return [...new Set(value.split(separator).map((item) => item.trim()).filter(Boolean))];
}

function ActivityPanel({
  activity,
  loading,
  onRefresh,
  onClose
}: {
  activity: ReadingActivity[];
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Reading and listening activity">
      <section className="modal-panel activity-panel">
        <div className="modal-heading activity-heading">
          <div>
            <div className="activity-title-row">
              <Activity size={22} />
              <h2>Library activity</h2>
              <span className="live-pill">Live</span>
            </div>
            <p>Readers with a book or audiobook open right now.</p>
          </div>
          <div className="activity-heading-actions">
            <button type="button" className="icon-button" title="Refresh activity" onClick={onRefresh}>
              <RefreshCw className={loading ? "spin" : ""} size={18} />
            </button>
            <button type="button" className="icon-button" title="Close" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>

        {activity.length === 0 ? (
          <div className="activity-empty">
            <Activity size={30} />
            <strong>No one is reading or listening right now</strong>
            <span>Active sessions will appear here within a few seconds.</span>
          </div>
        ) : (
          <div className="activity-list">
            {activity.map((session) => {
              const readerName = session.user.displayName || session.user.username;
              return (
                <article className="activity-card" key={session.user.id}>
                  <div className="activity-cover" aria-hidden="true">
                    {session.book.coverUrl ? (
                      <img src={session.book.coverUrl} alt="" />
                    ) : (
                      <BookOpen size={26} />
                    )}
                  </div>
                  <div className="activity-card-copy">
                    <div className="activity-reader-row">
                      <span className="activity-avatar">{userInitials(session.user)}</span>
                      <div>
                        <strong>{readerName}</strong>
                        <span><i aria-hidden="true" /> {session.book.mediaType === "audiobook" ? "Listening now" : "Reading now"}</span>
                      </div>
                    </div>
                    <div className="activity-book-copy">
                      <strong>{session.book.title}</strong>
                      <span>{session.book.author || "Unknown author"}</span>
                    </div>
                    <div className="activity-progress-copy">
                      <span className="book-progress-bar" aria-hidden="true">
                        <span style={{ width: `${Math.round(session.percent * 100)}%` }} />
                      </span>
                      <small>{formatPercent(session.percent)} · {session.book.mediaType === "audiobook" ? "listening" : "reading"} for {formatActivityDuration(session.startedAt)}</small>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function UserManagementPanel({
  currentUser,
  onClose,
  onError
}: {
  currentUser: User;
  onClose: () => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [form, setForm] = useState({
    username: "",
    displayName: "",
    password: "",
    role: "reader" as User["role"]
  });
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await listUsers());
    } catch (error) {
      onError(error, "Unable to load users");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    setLoading(true);
    try {
      const user = await createUser(form);
      setUsers((items) => [...items, user].sort((a, b) => a.username.localeCompare(b.username)));
      setForm({ username: "", displayName: "", password: "", role: "reader" });
    } catch (error) {
      onError(error, "Unable to create user");
    } finally {
      setLoading(false);
    }
  };

  const handleRoleChange = async (user: User, role: User["role"]) => {
    try {
      const updated = await updateUser(user.id, { role });
      setUsers((items) => items.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      onError(error, "Unable to update user");
    }
  };

  const handlePasswordChange = async (user: User) => {
    const password = passwords[user.id] || "";
    if (!password) {
      return;
    }

    try {
      await updateUserPassword(user.id, password);
      setPasswords((items) => ({ ...items, [user.id]: "" }));
    } catch (error) {
      onError(error, "Unable to update password");
    }
  };

  const handleDelete = async (user: User) => {
    try {
      await removeUser(user.id);
      setUsers((items) => items.filter((item) => item.id !== user.id));
    } catch (error) {
      onError(error, "Unable to delete user");
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Manage users">
      <section className="modal-panel user-panel">
        <div className="modal-heading">
          <div>
            <h2>Users</h2>
            <p>Each account keeps its own progress, marks, preferences, ratings, and reviews.</p>
          </div>
          <button type="button" className="icon-button" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="user-create-grid">
          <input
            value={form.username}
            placeholder="username"
            onChange={(event) => setForm((value) => ({ ...value, username: event.target.value }))}
          />
          <input
            value={form.displayName}
            placeholder="display name"
            onChange={(event) => setForm((value) => ({ ...value, displayName: event.target.value }))}
          />
          <input
            value={form.password}
            type="password"
            placeholder="password"
            onChange={(event) => setForm((value) => ({ ...value, password: event.target.value }))}
          />
          <select
            value={form.role}
            onChange={(event) => setForm((value) => ({ ...value, role: event.target.value as User["role"] }))}
          >
            <option value="reader">Reader</option>
            <option value="admin">Admin</option>
          </select>
          <button type="button" className="primary-button" disabled={loading} onClick={() => void handleCreate()}>
            <UserPlus size={16} />
            Add
          </button>
        </div>

        <div className="user-list">
          {users.map((user) => (
            <article key={user.id} className="user-row">
              <div>
                <strong>{user.displayName || user.username}</strong>
                <span>{user.username}</span>
              </div>
              <select
                value={user.role}
                disabled={user.id === currentUser.id}
                onChange={(event) => void handleRoleChange(user, event.target.value as User["role"])}
              >
                <option value="reader">Reader</option>
                <option value="admin">Admin</option>
              </select>
              <input
                value={passwords[user.id] || ""}
                type="password"
                placeholder="new password"
                onChange={(event) =>
                  setPasswords((items) => ({ ...items, [user.id]: event.target.value }))
                }
              />
              <button type="button" className="secondary-button" onClick={() => void handlePasswordChange(user)}>
                Reset
              </button>
              <button
                type="button"
                className="ghost-button"
                title="Delete user"
                disabled={user.id === currentUser.id}
                onClick={() => void handleDelete(user)}
              >
                <Trash2 size={16} />
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ServerSettingsPanel({
  server,
  currentAccountId,
  onClose,
  onPlatformChange,
  onRefreshPlatform,
  onError
}: {
  server: ShelfServer;
  currentAccountId: string;
  onClose: () => void;
  onPlatformChange: (overview: PlatformOverview) => void;
  onRefreshPlatform: () => Promise<PlatformOverview>;
  onError: (error: unknown, fallback: string) => void;
}) {
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [invitations, setInvitations] = useState<ServerInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [endpointUrl, setEndpointUrl] = useState(server.endpointUrl || "");
  const [lastInvite, setLastInvite] = useState<ServerInvitation | null>(null);
  const [claimCode, setClaimCode] = useState<{code: string; expiresAt: string} | null>(null);
  const [inviteForm, setInviteForm] = useState({
    recipient: "",
    role: "member" as Exclude<ServerRole, "owner">,
    libraryIds: [] as string[]
  });
  const [libraryForm, setLibraryForm] = useState({
    name: "",
    mediaType: "ebook" as ShelfLibrary["mediaType"],
    rootPath: server.libraries[0]?.rootPath || ""
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextMembers, nextInvitations] = await Promise.all([
        listServerMembers(),
        listServerInvitations()
      ]);
      setMembers(nextMembers);
      setInvitations(nextInvitations);
    } catch (error) {
      onError(error, "Unable to load server settings");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => { void refresh(); }, [refresh]);

  const refreshOverview = async () => {
    const next = await onRefreshPlatform();
    onPlatformChange(next);
    return next.servers.find((item) => item.serverId === next.currentServerId) || server;
  };

  const copyInvite = async (invitation: ServerInvitation) => {
    if (!invitation.token && !invitation.invitePath) return;
    const value = invitation.invitePath
      ? `${window.location.origin}${invitation.invitePath}`
      : invitation.token || "";
    await navigator.clipboard.writeText(value);
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Server settings">
      <section className="modal-panel server-settings-panel">
        <div className="modal-heading">
          <div>
            <span className="profile-eyebrow">Server administration</span>
            <h2>{server.name}</h2>
            <p>Manage connections, first-class libraries, invitations, and server roles.</p>
          </div>
          <button type="button" className="icon-button" title="Close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="server-identity-card">
          <span><ShieldCheck size={20} /></span>
          <div><strong>Permanent server identity</strong><code>{server.serverId}</code></div>
          <small className={server.status === "online" ? "is-online" : ""}>{server.status}</small>
        </div>

        <section className="server-settings-section server-claim-section">
          <div className="server-settings-heading">
            <div><h3>Host setup code</h3><p>Use a temporary code to attach this machine to another Shelf account service. Generating a code does not change ownership until the claim is completed.</p></div>
          </div>
          {claimCode ? (
            <div className="server-claim-code"><code>{claimCode.code}</code><span>Expires {new Date(claimCode.expiresAt).toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})}</span><button type="button" className="secondary-button" onClick={() => void navigator.clipboard.writeText(claimCode.code)}><Copy size={16} />Copy code</button></div>
          ) : (
            <button type="button" className="secondary-button server-claim-button" disabled={loading} onClick={async () => {
              setLoading(true);
              try { setClaimCode(await createServerClaimCode()); }
              catch (error) { onError(error, "Unable to create a host setup code"); }
              finally { setLoading(false); }
            }}><ShieldCheck size={16} />Generate 15-minute code</button>
          )}
        </section>

        <section className="server-settings-section">
          <div className="server-settings-heading">
            <div><h3>Secure remote connection</h3><p>Only verified HTTPS endpoints can be used by the server switcher. Private-network HTTP addresses are allowed for local use.</p></div>
          </div>
          <form className="server-endpoint-form" onSubmit={async (event) => {
            event.preventDefault();
            setLoading(true);
            try {
              const next = await updateServerEndpoint(endpointUrl);
              onPlatformChange(next);
            } catch (error) {
              onError(error, "Unable to verify the server address");
            } finally {
              setLoading(false);
            }
          }}>
            <input value={endpointUrl} onChange={(event) => setEndpointUrl(event.target.value)} placeholder="https://books.example.com" type="url" required />
            <button className="secondary-button" type="submit" disabled={loading}><ShieldCheck size={16} />Verify address</button>
          </form>
          {server.endpointVerifiedAt ? <small>Verified {formatProfileDate(server.endpointVerifiedAt)}</small> : <small>No remote endpoint has been verified yet.</small>}
        </section>

        <section className="server-settings-section">
          <div className="server-settings-heading">
            <div><h3>Libraries</h3><p>Books and audiobooks are separate libraries with their own display and access grants.</p></div>
            <span>{server.libraries.length}</span>
          </div>
          <div className="server-library-list">
            {server.libraries.map((library) => (
              <article key={library.id}>
                <span className="server-library-icon">{library.mediaType === "audiobook" ? <Headphones size={18} /> : <BookOpen size={18} />}</span>
                <div><strong>{library.name}</strong><span>{library.itemCount} titles · {library.mediaType}</span><code>{library.rootPath}</code></div>
                <button type="button" className="ghost-button" title={`Rename ${library.name}`} onClick={async () => {
                  const name = window.prompt("Library name", library.name)?.trim();
                  if (!name || name === library.name) return;
                  try {
                    await updateLibrary(library.id, { name });
                    await refreshOverview();
                  } catch (error) { onError(error, "Unable to rename library"); }
                }}><Edit3 size={15} /></button>
                <button type="button" className="ghost-button danger" title={`Remove ${library.name}`} disabled={server.libraries.length <= 1} onClick={async () => {
                  if (!window.confirm(`Remove the “${library.name}” library? Media files will not be deleted.`)) return;
                  try {
                    await deleteLibrary(library.id);
                    await refreshOverview();
                  } catch (error) { onError(error, "Unable to remove library"); }
                }}><Trash2 size={15} /></button>
              </article>
            ))}
          </div>
          <form className="server-library-create" onSubmit={async (event) => {
            event.preventDefault();
            setLoading(true);
            try {
              await createLibrary(libraryForm);
              const refreshed = await refreshOverview();
              setLibraryForm({ name: "", mediaType: "ebook", rootPath: refreshed.libraries[0]?.rootPath || libraryForm.rootPath });
            } catch (error) {
              onError(error, "Unable to create library");
            } finally { setLoading(false); }
          }}>
            <input value={libraryForm.name} onChange={(event) => setLibraryForm((value) => ({ ...value, name: event.target.value }))} placeholder="Library name" required />
            <select value={libraryForm.mediaType} onChange={(event) => setLibraryForm((value) => ({ ...value, mediaType: event.target.value as ShelfLibrary["mediaType"] }))}>
              <option value="ebook">Books</option><option value="audiobook">Audiobooks</option><option value="mixed">Mixed</option>
            </select>
            <input value={libraryForm.rootPath} onChange={(event) => setLibraryForm((value) => ({ ...value, rootPath: event.target.value }))} placeholder="Folder inside the mounted library root" />
            <button type="submit" className="secondary-button" disabled={loading || !libraryForm.name.trim()}><FolderPlus size={16} />Add library</button>
          </form>
        </section>

        <section className="server-settings-section">
          <div className="server-settings-heading">
            <div><h3>Invite people</h3><p>Invitations grant server access. Friendship is a separate social relationship and never grants a library automatically.</p></div>
          </div>
          <form className="server-invite-form" onSubmit={async (event) => {
            event.preventDefault();
            setLoading(true);
            try {
              const created = await createServerInvitation(inviteForm);
              setLastInvite(created);
              setInvitations((items) => [created, ...items]);
              setInviteForm({ recipient: "", role: "member", libraryIds: [] });
            } catch (error) { onError(error, "Unable to create invitation"); }
            finally { setLoading(false); }
          }}>
            <input value={inviteForm.recipient} onChange={(event) => setInviteForm((value) => ({ ...value, recipient: event.target.value }))} placeholder="Username or email (optional)" />
            <select value={inviteForm.role} onChange={(event) => setInviteForm((value) => ({ ...value, role: event.target.value as Exclude<ServerRole, "owner"> }))}>
              <option value="member">Member</option>
              {server.role === "owner" ? <option value="admin">Administrator</option> : null}
            </select>
            <div className="invite-library-options">
              {server.libraries.map((library) => (
                <label key={library.id}><input type="checkbox" checked={inviteForm.libraryIds.includes(library.id)} onChange={() => setInviteForm((value) => ({
                  ...value,
                  libraryIds: value.libraryIds.includes(library.id)
                    ? value.libraryIds.filter((id) => id !== library.id)
                    : [...value.libraryIds, library.id]
                }))} />{library.name}</label>
              ))}
              <small>Leave all unchecked to share every library.</small>
            </div>
            <button type="submit" className="primary-button" disabled={loading}><UserPlus size={16} />Create invite</button>
          </form>
          {lastInvite ? (
            <div className="created-invite">
              <div><strong>Invitation ready</strong><span>It expires {formatShortDate(lastInvite.expiresAt)} and can be used once.</span></div>
              <button type="button" className="secondary-button" onClick={() => void copyInvite(lastInvite)}><Copy size={16} />Copy secure link</button>
            </div>
          ) : null}
          <div className="server-invitation-list">
            {invitations.filter((item) => !item.revokedAt).slice(0, 8).map((invitation) => (
              <article key={invitation.id}>
                <div><strong>{invitation.recipient || "Shareable one-use invite"}</strong><span>{invitation.role} · expires {formatShortDate(invitation.expiresAt)}</span></div>
                <span className={invitation.acceptedAt ? "is-accepted" : ""}>{invitation.acceptedAt ? "Accepted" : "Pending"}</span>
                {!invitation.acceptedAt ? <button type="button" className="ghost-button danger" title="Revoke invitation" onClick={async () => {
                  try { await revokeServerInvitation(invitation.id); await refresh(); }
                  catch (error) { onError(error, "Unable to revoke invitation"); }
                }}><Trash2 size={15} /></button> : null}
              </article>
            ))}
          </div>
        </section>

        <section className="server-settings-section">
          <div className="server-settings-heading"><div><h3>Members</h3><p>Owner, administrator, and member permissions are independent of account friendships.</p></div><span>{members.length}</span></div>
          <div className="server-member-list">
            {members.map((member) => (
              <article key={member.accountId}>
                <span className="account-avatar">{(member.account.displayName || member.account.username).slice(0, 1).toUpperCase()}</span>
                <div><strong>{member.account.displayName}</strong><span>@{member.account.username}</span></div>
                <select value={member.role} disabled={member.role === "owner" || (server.role !== "owner" && member.role === "admin")} onChange={async (event) => {
                  try {
                    const updated = await updateServerMember(member.accountId, { role: event.target.value as ServerRole });
                    setMembers((items) => items.map((item) => item.accountId === updated.accountId ? { ...item, ...updated } : item));
                  } catch (error) { onError(error, "Unable to update server role"); }
                }}>
                  {member.role === "owner" ? <option value="owner">Owner</option> : null}
                  <option value="admin">Administrator</option><option value="member">Member</option>
                </select>
                {member.role !== "owner" && member.accountId !== currentAccountId ? (
                  <button type="button" className="ghost-button danger" title="Remove server access" onClick={async () => {
                    if (!window.confirm(`Remove ${member.account.displayName} from this server?`)) return;
                    try { await removeServerMember(member.accountId); await refresh(); }
                    catch (error) { onError(error, "Unable to remove server member"); }
                  }}><Trash2 size={15} /></button>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}

function HomeView({
  books,
  canManageBooks,
  onReadBook,
  onStartBook,
  onAuthorSelect,
  onSetReadState,
  onEditBook,
  onGetArtwork,
  onDeleteBook,
  readListIds,
  onToggleReadList,
  onViewEbooks,
  onViewAudiobooks,
  onAddBook
}: {
  books: Book[];
  canManageBooks: boolean;
  onReadBook: (bookId: string) => void;
  onStartBook: (bookId: string) => void;
  onAuthorSelect: (author: string, mediaType: MediaType) => void;
  onSetReadState: (bookId: string, read: boolean) => void;
  onEditBook: (book: Book) => void;
  onGetArtwork: (book: Book) => void;
  onDeleteBook: (book: Book) => void;
  readListIds: Set<string>;
  onToggleReadList: (bookId: string) => void;
  onViewEbooks: () => void;
  onViewAudiobooks: () => void;
  onAddBook: () => void;
}) {
  const continueReading = useMemo(
    () =>
      [...books]
        .filter((book) => {
          const percent = book.progress?.percent || 0;
          return percent > 0 && percent < 0.995;
        })
        .sort((a, b) => latestBookTime(b) - latestBookTime(a))
        .slice(0, 12),
    [books]
  );
  const recentlyAdded = useMemo(
    () => [...books].sort((a, b) => latestBookTime(b) - latestBookTime(a)).slice(0, 18),
    [books]
  );

  if (books.length === 0) {
    return (
      <section className="home-workspace">
        <div className="home-empty">
          <Library size={34} />
          <h2>No titles yet</h2>
          {canManageBooks ? (
            <button type="button" className="primary-button" onClick={onAddBook}>
              <Plus size={18} />
              Add a title
            </button>
          ) : <p>The server owner has not added any titles to this library yet.</p>}
        </div>
      </section>
    );
  }

  return (
    <section className="home-workspace">
      <div className="home-heading">
        <h2>Home</h2>
        <div className="home-heading-actions">
          <button type="button" className="text-button" onClick={onViewEbooks}>Books</button>
          <button type="button" className="text-button" onClick={onViewAudiobooks}>Audiobooks</button>
        </div>
      </div>

      {continueReading.length > 0 ? (
        <HomeShelfRow
          title="Continue"
          books={continueReading}
          canManageBooks={canManageBooks}
          onReadBook={onReadBook}
          onStartBook={onStartBook}
          onAuthorSelect={onAuthorSelect}
          onSetReadState={onSetReadState}
          onEditBook={onEditBook}
          onGetArtwork={onGetArtwork}
          onDeleteBook={onDeleteBook}
          readListIds={readListIds}
          onToggleReadList={onToggleReadList}
        />
      ) : null}
      <HomeShelfRow
        title="Recently Added"
        books={recentlyAdded}
        canManageBooks={canManageBooks}
        onReadBook={onReadBook}
        onStartBook={onStartBook}
        onAuthorSelect={onAuthorSelect}
        onSetReadState={onSetReadState}
        onEditBook={onEditBook}
        onGetArtwork={onGetArtwork}
        onDeleteBook={onDeleteBook}
        readListIds={readListIds}
        onToggleReadList={onToggleReadList}
      />
    </section>
  );
}

function HomeShelfRow({
  title,
  books,
  canManageBooks,
  onReadBook,
  onStartBook,
  onAuthorSelect,
  onSetReadState,
  onEditBook,
  onGetArtwork,
  onDeleteBook,
  readListIds,
  onToggleReadList
}: {
  title: string;
  books: Book[];
  canManageBooks: boolean;
  onReadBook: (bookId: string) => void;
  onStartBook: (bookId: string) => void;
  onAuthorSelect: (author: string, mediaType: MediaType) => void;
  onSetReadState: (bookId: string, read: boolean) => void;
  onEditBook: (book: Book) => void;
  onGetArtwork: (book: Book) => void;
  onDeleteBook: (book: Book) => void;
  readListIds: Set<string>;
  onToggleReadList: (bookId: string) => void;
}) {
  return (
    <section className="home-shelf-row" aria-label={title}>
      <h3>{title}</h3>
      <div className="home-book-row">
        {books.map((book) => (
          <article
            key={book.id}
            className="home-book-tile"
          >
            <BookCoverFrame
              book={book}
              canManageBook={canManageBooks}
              onOpen={() => onReadBook(book.id)}
              onStart={() => onStartBook(book.id)}
              onSetReadState={(read) => onSetReadState(book.id, read)}
              onEditMetadata={() => onEditBook(book)}
              onGetArtwork={() => onGetArtwork(book)}
              onDeleteBook={() => onDeleteBook(book)}
              inReadList={readListIds.has(book.id)}
              onToggleReadList={() => onToggleReadList(book.id)}
            />
            <div className="home-book-copy">
              <button
                type="button"
                className="book-title-link"
                aria-label={`Open ${book.title}`}
                onClick={() => onReadBook(book.id)}
              >
                <strong>{book.title}</strong>
              </button>
              <button
                type="button"
                className="book-author-link"
                aria-label={`Show books by ${book.author || "Unknown author"}`}
                onClick={() => onAuthorSelect(book.author || "Unknown author", book.mediaType)}
              >
                {book.author || "Unknown author"}
              </button>
              <small>{formatPercent(book.progress?.percent || 0)}{book.mediaType === "audiobook" ? " listened" : ""}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProfileView({
  profile,
  loading,
  fallbackUser,
  onOpenBook,
  onOpenMark,
  onToggleReadList,
  onEditProfile
}: {
  profile: ProfileData | null;
  loading: boolean;
  fallbackUser: User;
  onOpenBook: (bookId: string) => void;
  onOpenMark: (book: Book, highlight: Highlight) => void;
  onToggleReadList: (bookId: string) => void;
  onEditProfile: () => void;
}) {
  const user = profile?.user || fallbackUser;
  const stats = profile?.stats || {
    booksRead: 0,
    audiobooksListened: 0,
    readingSeconds: 0,
    listeningSeconds: 0
  };
  const displayName = user.displayName || user.username;

  if (loading && !profile) {
    return (
      <section className="profile-workspace profile-loading">
        <Loader2 className="spin" size={28} />
        <span>Loading profile…</span>
      </section>
    );
  }

  return (
    <section className="profile-workspace">
      <div className="profile-hero">
        <div className="profile-identity">
          <div className="profile-avatar-large" aria-hidden="true">
            {displayName.slice(0, 1).toUpperCase() || "U"}
          </div>
          <div className="profile-identity-copy">
            <span className="profile-eyebrow">My Profile</span>
            <h2>{displayName}</h2>
            <div className="profile-meta">
              <span>@{user.username}</span>
              <span>{user.role === "admin" ? "Server admin" : "Reader"}</span>
              {user.createdAt ? <span>Joined {formatProfileDate(user.createdAt)}</span> : null}
            </div>
            <button type="button" className="profile-edit-button" onClick={onEditProfile}>
              <Edit3 size={16} />
              Account settings
            </button>
          </div>
        </div>

        <div className="profile-stats" aria-label="Reading totals">
          <ProfileStat icon={<BookOpen size={20} />} value={String(stats.booksRead)} label="Books read" />
          <ProfileStat icon={<Headphones size={20} />} value={String(stats.audiobooksListened)} label="Audiobooks listened" />
          <ProfileStat icon={<Gauge size={20} />} value={formatProfileHours(stats.readingSeconds)} label="Hours read" />
          <ProfileStat icon={<Activity size={20} />} value={formatProfileHours(stats.listeningSeconds)} label="Hours listened" />
        </div>
      </div>

      <ProfileSection
        title="Reading & Listening History"
        icon={<Activity size={19} />}
        count={profile?.history.length || 0}
      >
        {profile?.history.length ? (
          <div className="profile-cover-row">
            {profile.history.map(({ book, progress }) => (
              <article className="profile-cover-tile" key={book.id}>
                <button type="button" className="profile-cover-button" onClick={() => onOpenBook(book.id)}>
                  <BookCover book={book} fit={book.mediaType === "audiobook" ? "contain" : "cover"} />
                  <span className="profile-progress-badge">
                    {Math.round((progress.percent || 0) * 100)}%
                  </span>
                </button>
                <button type="button" className="profile-title-button" onClick={() => onOpenBook(book.id)}>
                  {book.title}
                </button>
                <span>{book.author || "Unknown author"}</span>
                <small>{formatProfileDate(progress.updatedAt)}</small>
              </article>
            ))}
          </div>
        ) : <ProfileEmpty icon={<BookOpen size={22} />} text="Finished books and in-progress titles will appear here." />}
      </ProfileSection>

      <ProfileSection
        title="Ratings & Reviews"
        icon={<Star size={19} />}
        count={profile?.reviews.length || 0}
      >
        {profile?.reviews.length ? (
          <div className="profile-review-row">
            {profile.reviews.map(({ book, review }) => (
              <button
                type="button"
                className="profile-review-card"
                key={review.id}
                onClick={() => onOpenBook(book.id)}
              >
                <BookCover book={book} fit={book.mediaType === "audiobook" ? "contain" : "cover"} />
                <span className="profile-review-copy">
                  <strong>{book.title}</strong>
                  <span className="profile-stars" aria-label={`${review.rating} out of 5 stars`}>
                    {[1, 2, 3, 4, 5].map((value) => (
                      <Star key={value} size={16} fill={value <= Math.round(review.rating) ? "currentColor" : "none"} />
                    ))}
                  </span>
                  <span>{review.text || "Rated without a written review."}</span>
                  <small>{formatProfileDate(review.updatedAt)}</small>
                </span>
              </button>
            ))}
          </div>
        ) : <ProfileEmpty icon={<Star size={22} />} text="Your ratings and reviews will collect here." />}
      </ProfileSection>

      <ProfileSection
        title="Notes & Highlights"
        icon={<Highlighter size={19} />}
        count={profile?.marks.length || 0}
      >
        {profile?.marks.length ? (
          <div className="profile-note-row">
            {profile.marks.map(({ book, highlight }) => (
              <button
                type="button"
                className="profile-note-card"
                key={highlight.id}
                onClick={() => onOpenMark(book, highlight)}
              >
                <span className="profile-note-book">
                  <BookCover book={book} fit={book.mediaType === "audiobook" ? "contain" : "cover"} />
                  <span><strong>{book.title}</strong><small>{book.author || "Unknown author"}</small></span>
                </span>
                {highlight.text ? <q>{highlight.text}</q> : null}
                {highlight.note ? <span className="profile-note-text">{highlight.note}</span> : null}
                <small>{formatProfileDate(highlight.createdAt)}</small>
              </button>
            ))}
          </div>
        ) : <ProfileEmpty icon={<Highlighter size={22} />} text="Highlights and attached notes will appear here." />}
      </ProfileSection>

      <ProfileSection
        title="Read List"
        icon={<ListPlus size={19} />}
        count={profile?.readList.length || 0}
      >
        {profile?.readList.length ? (
          <div className="profile-cover-row">
            {profile.readList.map(({ book, addedAt }) => (
              <article className="profile-cover-tile" key={book.id}>
                <button type="button" className="profile-cover-button" onClick={() => onOpenBook(book.id)}>
                  <BookCover book={book} fit={book.mediaType === "audiobook" ? "contain" : "cover"} />
                </button>
                <button type="button" className="profile-title-button" onClick={() => onOpenBook(book.id)}>
                  {book.title}
                </button>
                <span>{book.author || "Unknown author"}</span>
                <button type="button" className="profile-list-remove" onClick={() => onToggleReadList(book.id)}>
                  <X size={14} /> Remove
                </button>
                <small>Added {formatProfileDate(addedAt)}</small>
              </article>
            ))}
          </div>
        ) : <ProfileEmpty icon={<ListPlus size={22} />} text="Use a title’s three-dot menu to add it to your Read List." />}
      </ProfileSection>
    </section>
  );
}

function ProfileStat({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="profile-stat">
      <span className="profile-stat-icon">{icon}</span>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function ProfileSection({
  title,
  icon,
  count,
  children
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="profile-section">
      <div className="profile-section-heading">
        <h3>{icon}{title}</h3>
        <span>{count}</span>
      </div>
      {children}
    </section>
  );
}

function ProfileEmpty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="profile-empty">{icon}<span>{text}</span></div>;
}

function AddBookView({
  busy,
  onUpload
}: {
  busy: boolean;
  onUpload: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const handleFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) {
      return;
    }
    onUpload(Array.from(fileList));
  };

  return (
    <section className="add-book-workspace">
      <div
        className={`add-book-dropzone ${dragging ? "is-dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
      >
        <Plus size={34} />
        <h2>Add Books & Audiobooks</h2>
        <p>Upload ebooks or MP3, M4B, M4A, AAC, OGG, OPUS, WAV, and FLAC audio. Matching album tags are grouped into one audiobook.</p>
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? <Loader2 className="spin" size={18} /> : <Plus size={18} />}
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept=".epub,.pdf,.mobi,.azw3,.fb2,.docx,.txt,.cbz,.cbr,.mp3,.m4a,.m4b,.aac,.ogg,.opus,.wav,.flac,audio/*"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.currentTarget.value = "";
          }}
        />
      </div>
    </section>
  );
}

function LibbyView({
  status,
  books,
  loading,
  playingBookId,
  onStart,
  onRefresh,
  onLink,
  onUnlink
}: {
  status: LibbyStatus | null;
  books: Book[];
  loading: boolean;
  playingBookId: string | null;
  onStart: (book: Book) => void;
  onRefresh: () => void;
  onLink: (code: string) => Promise<void>;
  onUnlink: () => Promise<void>;
}) {
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  if (!status) {
    return (
      <section className="libby-view">
        <div className="library-empty"><Loader2 className="spin" size={26} /></div>
      </section>
    );
  }

  if (!status.linked) {
    return (
      <section className="libby-view">
        <form
          className="libby-link-card"
          onSubmit={async (event) => {
            event.preventDefault();
            setWorking(true);
            setError("");
            try {
              await onLink(code);
              setCode("");
            } catch (linkError) {
              setError(linkError instanceof Error ? linkError.message : "Couldn't link Libby");
            } finally {
              setWorking(false);
            }
          }}
        >
          <Library size={24} />
          <h2>Read your Libby loans in shelf</h2>
          <p>
            In Libby, open the menu, choose <strong>Copy To Another Device</strong>, then type the 8-digit code here
            before it runs out.
          </p>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/[^\d]/g, "").slice(0, 8))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Setup code"
            aria-label="Libby setup code"
            required
          />
          {error ? <span className="libby-error">{error}</span> : null}
          <button type="submit" className="primary-button" disabled={working || code.length !== 8}>
            {working ? <Loader2 className="spin" size={16} /> : null}
            Link Libby
          </button>
          <small>
            Audiobooks play in shelf and DRM-free books open in shelf's reader. Books with DRM or sent to Kindle still
            open in Libby. Libby doesn't offer this officially, so it may stop working if Libby changes.
          </small>
        </form>
      </section>
    );
  }

  return (
    <section className="libby-view">
      <div className="libby-header">
        <span>{status.libraries.length ? status.libraries.join(" · ") : "Libby"}</span>
        <div className="libby-header-actions">
          <button type="button" className="text-button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={15} className={loading ? "spin" : ""} /> Refresh
          </button>
          <button
            type="button"
            className="text-button"
            onClick={async () => {
              setWorking(true);
              try {
                await onUnlink();
              } finally {
                setWorking(false);
              }
            }}
            disabled={working}
          >
            Unlink
          </button>
        </div>
      </div>
      <div className="library-shelf library-shelf-grid libby-shelf">
        {books.map((book) => {
          const mode = book.libby?.mode || "libby";
          const percent = book.progress?.percent || 0;
          const action = mode === "audio"
            ? (playingBookId === book.id ? "Playing" : "Listen")
            : mode === "libby"
              ? "Open in Libby"
              : "Read";
          return (
            <article className="library-book-card is-grid libby-loan-card" key={book.id}>
              <button type="button" className="book-cover-button" aria-label={`${action}: ${book.title}`} onClick={() => onStart(book)}>
                <BookCover book={book} />
              </button>
              <div className="library-book-copy">
                <strong>{book.title}</strong>
                <span className="libby-loan-author">{book.author || "Unknown author"}</span>
                <span className="library-book-meta">
                  {book.libby?.dueAt ? `Due ${formatShortDate(book.libby.dueAt)}` : book.libby?.libraryName}
                </span>
                {percent > 0 ? (
                  <span className="book-progress-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round(percent * 100)}%` }} />
                  </span>
                ) : null}
              </div>
              <button type="button" className="secondary-button libby-loan-action" onClick={() => onStart(book)}>
                {mode === "audio" ? <Headphones size={15} /> : mode === "libby" ? <ExternalLink size={15} /> : <BookOpen size={15} />}
                {action}
              </button>
              {mode === "libby" ? <small className="libby-loan-note">Protected by DRM, so it opens in Libby</small> : null}
            </article>
          );
        })}
        {books.length === 0 && !loading ? (
          <div className="library-empty">
            <Library size={30} />
            <strong>No Libby loans right now</strong>
            <span>Borrow something in Libby, then refresh.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function LibraryView({
  libraryType,
  books,
  activeBook,
  activeBookId,
  readerOpen,
  query,
  authorFilter,
  reader,
  preferences,
  progress,
  selection,
  dictionary,
  dictionaryLoading,
  jumpTarget,
  canManageBooks,
  onQueryChange,
  onClearAuthorFilter,
  onReadBook,
  onStartBook,
  onAuthorSelect,
  onSetReadState,
  onEditBook,
  onGetArtwork,
  onDeleteBook,
  onSendToKindle,
  readListIds,
  onToggleReadList,
  onCloseReader,
  onProgress,
  onLookup,
  onDismissSelection,
  onConvert,
  onBookmark,
  onHighlight,
  onPreferencesChange,
  onDeleteBookmark,
  onDeleteHighlight,
  onSaveReview,
  onJump,
  onUsage
}: {
  libraryType: LibraryViewType;
  books: Book[];
  activeBook: Book | null;
  activeBookId: string | null;
  readerOpen: boolean;
  query: string;
  authorFilter: string | null;
  reader: ReaderInfo | null;
  preferences: ReaderPreferences;
  progress: ProgressState | null;
  selection: SelectionState | null;
  dictionary: DictionaryResult | null;
  dictionaryLoading: boolean;
  jumpTarget: JumpTarget | null;
  canManageBooks: boolean;
  onQueryChange: (value: string) => void;
  onClearAuthorFilter: () => void;
  onReadBook: (bookId: string) => void;
  onStartBook: (bookId: string) => void;
  onAuthorSelect: (author: string, mediaType: MediaType) => void;
  onSetReadState: (bookId: string, read: boolean) => void;
  onEditBook: (book: Book) => void;
  onGetArtwork: (book: Book) => void;
  onDeleteBook: (book: Book) => void;
  onSendToKindle: (book: Book) => void;
  readListIds: Set<string>;
  onToggleReadList: (bookId: string) => void;
  onCloseReader: () => void;
  onProgress: (progress: ProgressState) => void;
  onLookup: (selection: SelectionState) => void;
  onDismissSelection: () => void;
  onConvert: () => void;
  onBookmark: () => void;
  onHighlight: () => void;
  onPreferencesChange: (patch: Partial<ReaderPreferences>) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
  onDeleteHighlight: (highlight: Highlight) => void;
  onSaveReview: (rating: number, text: string) => void;
  onJump: (target: { locator?: string | null; page?: number | null }) => void;
  onUsage: (mediaType: MediaType, seconds: number) => void;
}) {
  const mediaType: MediaType = libraryType === "audiobooks" ? "audiobook" : "ebook";
  const libraryLabel = libraryType === "audiobooks" ? "audiobooks" : "books";
  const [layout, setLayout] = useState<LibraryLayoutMode>(() => getStoredLibraryLayout(libraryType));
  const [filter, setFilter] = useState<LibraryFilterMode>("all");
  const [sort, setSort] = useState<LibrarySortMode>(() => getStoredLibrarySort(libraryType));
  const [viewMenuOpen, setViewMenuOpen] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(`shelfstream-${libraryType}-sort`, sort);
    } catch {
      // Keep sorting available for this session if browser storage is unavailable.
    }
  }, [libraryType, sort]);

  useEffect(() => {
    try {
      window.localStorage.setItem(`shelfstream-${libraryType}-layout`, layout);
    } catch {
      // Keep the selected layout for this session if browser storage is unavailable.
    }
  }, [layout, libraryType]);

  const visibleBooks = useMemo(
    () => [...books].filter((book) => matchesLibraryFilter(book, filter)).sort((a, b) => compareLibraryBooks(a, b, sort)),
    [books, filter, sort]
  );

  if (readerOpen) {
    return (
      <section className="library-workspace is-reading">
        <ReaderWorkspace
          activeBook={activeBook}
          reader={reader}
            preferences={preferences}
            progress={progress}
          selection={selection}
          dictionary={dictionary}
          dictionaryLoading={dictionaryLoading}
          jumpTarget={jumpTarget}
          onProgress={onProgress}
          onLookup={onLookup}
          onDismissSelection={onDismissSelection}
          onConvert={onConvert}
          onBookmark={onBookmark}
          onHighlight={onHighlight}
          onPreferencesChange={onPreferencesChange}
            onDeleteBookmark={onDeleteBookmark}
            onDeleteHighlight={onDeleteHighlight}
            onSaveReview={onSaveReview}
            onJump={onJump}
            onCloseReader={onCloseReader}
            onUsage={onUsage}
          />
      </section>
    );
  }

  return (
    <section className={`library-workspace is-browsing library-layout-${layout} library-media-${mediaType}`}>
      <div className="books-library-header">
        <label className="search-box library-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={`Search ${libraryLabel}`}
          />
        </label>

        <div className="library-header-controls">
          <label className="library-select-control">
            <SlidersHorizontal size={16} />
            <span>Filter</span>
            <select
              value={filter}
              aria-label={`Filter ${libraryLabel}`}
              onChange={(event) => setFilter(event.target.value as LibraryFilterMode)}
            >
              <option value="all">All {libraryLabel}</option>
              <option value="unread">Unread</option>
              <option value="reading">{mediaType === "audiobook" ? "Listening" : "Reading"} now</option>
              <option value="finished">Finished</option>
              {mediaType === "ebook" ? <option value="needs-action">Needs prep</option> : null}
            </select>
          </label>

          <label className="library-select-control">
            <ArrowUpDown size={16} />
            <span>Sort</span>
            <select
              value={sort}
              aria-label={`Sort ${libraryLabel}`}
              onChange={(event) => setSort(event.target.value as LibrarySortMode)}
            >
              <option value="recent">Recent</option>
              <option value="title">Title</option>
              <option value="author">Author</option>
              <option value="progress">Progress</option>
            </select>
          </label>

          <div className="library-view-menu">
            <button
              type="button"
              className={`library-view-trigger ${viewMenuOpen ? "is-open" : ""}`}
              aria-expanded={viewMenuOpen}
              onClick={() => setViewMenuOpen((value) => !value)}
            >
              <Grid2X2 size={16} />
              <span>View</span>
              <ChevronRight size={14} />
            </button>
            {viewMenuOpen ? (
              <div className="library-view-popover" role="menu">
                <button
                  type="button"
                  className={layout === "grid" ? "is-active" : ""}
                  role="menuitemradio"
                  aria-checked={layout === "grid"}
                  onClick={() => {
                    setLayout("grid");
                    setViewMenuOpen(false);
                  }}
                >
                  <Grid2X2 size={17} />
                  <span>Grid</span>
                </button>
                <button
                  type="button"
                  className={layout === "list" ? "is-active" : ""}
                  role="menuitemradio"
                  aria-checked={layout === "list"}
                  onClick={() => {
                    setLayout("list");
                    setViewMenuOpen(false);
                  }}
                >
                  <List size={17} />
                  <span>List</span>
                </button>
                <button
                  type="button"
                  className={layout === "compact" ? "is-active" : ""}
                  role="menuitemradio"
                  aria-checked={layout === "compact"}
                  onClick={() => {
                    setLayout("compact");
                    setViewMenuOpen(false);
                  }}
                >
                  <Rows3 size={17} />
                  <span>Compact list</span>
                  <strong>NEW</strong>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="library-results-bar">
        <span>
          {visibleBooks.length} {visibleBooks.length === 1 ? libraryLabel.slice(0, -1) : libraryLabel}
          {authorFilter ? <> by <strong>{authorFilter}</strong></> : null}
        </span>
        {authorFilter ? (
          <button type="button" className="author-filter-clear" onClick={onClearAuthorFilter}>
            <X size={14} />
            Show all authors
          </button>
        ) : null}
      </div>

      <div className={`library-shelf library-shelf-${layout}`}>
        {visibleBooks.map((book) => (
          <LibraryBookCard
            key={book.id}
            book={book}
            active={book.id === activeBookId}
            layout={layout}
            canManageBook={canManageBooks}
            onRead={onReadBook}
            onStart={onStartBook}
            onAuthorSelect={(author) => onAuthorSelect(author, mediaType)}
            onSetReadState={onSetReadState}
            onEditBook={onEditBook}
            onGetArtwork={onGetArtwork}
            onDeleteBook={onDeleteBook}
            onSendToKindle={onSendToKindle}
            inReadList={readListIds.has(book.id)}
            onToggleReadList={onToggleReadList}
          />
        ))}
        {visibleBooks.length === 0 ? (
          <div className="library-empty">
            <Library size={30} />
            <strong>No matching {libraryLabel}</strong>
            <span>Adjust search, filter, or sort—or add a new title.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function LibraryBookCard({
  book,
  active,
  layout,
  canManageBook,
  onRead,
  onStart,
  onAuthorSelect,
  onSetReadState,
  onEditBook,
  onGetArtwork,
  onDeleteBook,
  onSendToKindle,
  inReadList,
  onToggleReadList
}: {
  book: Book;
  active: boolean;
  layout: LibraryLayoutMode;
  canManageBook: boolean;
  onRead: (bookId: string) => void;
  onStart: (bookId: string) => void;
  onAuthorSelect: (author: string) => void;
  onSetReadState: (bookId: string, read: boolean) => void;
  onEditBook: (book: Book) => void;
  onGetArtwork: (book: Book) => void;
  onDeleteBook: (book: Book) => void;
  onSendToKindle: (book: Book) => void;
  inReadList: boolean;
  onToggleReadList: (bookId: string) => void;
}) {
  const percent = book.progress?.percent || 0;

  return (
    <article className={`library-book-card is-${layout} ${active ? "is-active" : ""}`}>
      <div className="library-book-main">
        <BookCoverFrame
          book={book}
          canManageBook={canManageBook}
          onOpen={() => onRead(book.id)}
          onStart={() => onStart(book.id)}
          onSetReadState={(read) => onSetReadState(book.id, read)}
          onEditMetadata={() => onEditBook(book)}
          onGetArtwork={() => onGetArtwork(book)}
          onDeleteBook={() => onDeleteBook(book)}
          inReadList={inReadList}
          onToggleReadList={() => onToggleReadList(book.id)}
        />

        <div className="library-book-copy">
          <button
            type="button"
            className="book-title-link"
            aria-label={`Open ${book.title}`}
            onClick={() => onRead(book.id)}
          >
            <strong>{book.title}</strong>
          </button>
          <button
            type="button"
            className="book-author-link"
            aria-label={`Show books by ${book.author || "Unknown author"}`}
            onClick={() => onAuthorSelect(book.author || "Unknown author")}
          >
            {book.author || "Unknown author"}
          </button>
          <span className="library-book-meta">
            {book.ext.replace(".", "").toUpperCase()} - {formatFileSize(book.size)}
          </span>
          <span className="book-progress-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(percent * 100)}%` }} />
          </span>
        </div>
      </div>

      <div className="library-card-footer">
        <span>{formatPercent(percent)}{book.mediaType === "audiobook" ? " listened" : ""}</span>
        <StatusPill book={book} />
        {isSendableEpub(book) ? (
          <button
            type="button"
            className="library-kindle-button"
            aria-label={`Send ${book.title} to Kindle`}
            onClick={() => onSendToKindle(book)}
          >
            <Send size={14} />
            Send to Kindle
          </button>
        ) : null}
      </div>
    </article>
  );
}

function BookCoverFrame({
  book,
  canManageBook,
  onOpen,
  onStart,
  onSetReadState,
  onEditMetadata,
  onGetArtwork,
  onDeleteBook,
  inReadList,
  onToggleReadList
}: {
  book: Book;
  canManageBook: boolean;
  onOpen: () => void;
  onStart: () => void;
  onSetReadState: (read: boolean) => void;
  onEditMetadata: () => void;
  onGetArtwork: () => void;
  onDeleteBook: () => void;
  inReadList: boolean;
  onToggleReadList: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const read = isBookRead(book);

  return (
    <div
      className={`book-cover-frame ${read ? "is-read" : ""}`}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setMenuOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setMenuOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="book-cover-button"
        aria-label={`Open ${book.title}`}
        onClick={onOpen}
      >
        <BookCover book={book} />
      </button>

      {read ? (
        <span className="book-read-badge" title="Read" aria-label="Read">
          <Check size={17} strokeWidth={3} />
        </span>
      ) : null}

      <button
        type="button"
        className={`book-cover-menu-button ${menuOpen ? "is-open" : ""}`}
        aria-label={`More actions for ${book.title}`}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((value) => !value)}
      >
        <MoreVertical size={18} />
      </button>

      {menuOpen ? (
        <div className="book-cover-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onStart();
            }}
          >
            {book.mediaType === "audiobook" ? "Play now" : "Read now"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={read}
            onClick={() => {
              setMenuOpen(false);
              onSetReadState(true);
            }}
          >
            Mark as read
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!read}
            onClick={() => {
              setMenuOpen(false);
              onSetReadState(false);
            }}
          >
            Mark as unread
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onToggleReadList();
            }}
          >
            {inReadList ? "Remove from Read List" : "Add to Read List"}
          </button>
          {canManageBook ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onEditMetadata();
                }}
              >
                Edit metadata
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onGetArtwork();
                }}
              >
                Get artwork
              </button>
              <button
                type="button"
                className="is-danger"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onDeleteBook();
                }}
              >
                Delete title
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function BookCover({ book, fit = "cover" }: { book: Book; fit?: "cover" | "contain" }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(book.coverUrl) && !failed;

  useEffect(() => {
    setFailed(false);
  }, [book.coverUrl]);

  return (
    <span className={`book-cover media-${book.mediaType} cover-fit-${fit} ${showImage ? "has-image" : ""}`}>
      {showImage ? (
        <img src={book.coverUrl || ""} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className={`generated-cover cover-v${coverVariant(book)}`}>
          <span className="generated-cover-kicker">
            {book.mediaType === "audiobook" ? <><Headphones size={15} /> AUDIOBOOK</> : book.ext.replace(".", "").toUpperCase() || "EBOOK"}
          </span>
          <span className="generated-cover-title">{book.title}</span>
          <span className="generated-cover-author">{book.author || "Unknown author"}</span>
        </span>
      )}
    </span>
  );
}

function NotesHighlightsView({
  activeBook,
  reader,
  onJump,
  onDeleteBookmark,
  onDeleteHighlight
}: {
  activeBook: Book | null;
  reader: ReaderInfo | null;
  onJump: (target: { locator?: string | null; page?: number | null }) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
  onDeleteHighlight: (highlight: Highlight) => void;
}) {
  const bookmarks = reader?.bookmarks || [];
  const highlights = reader?.highlights || [];

  return (
    <section className="marks-workspace">
      <div className="marks-heading">
        <div>
          <h2>Notes & Highlights</h2>
          <p>{activeBook ? activeBook.title : "Open a book to review saved marks."}</p>
        </div>
        <span>{bookmarks.length + highlights.length}</span>
      </div>

      <AnnotationPanel
        bookmarks={bookmarks}
        highlights={highlights}
        onJump={onJump}
        onDeleteBookmark={onDeleteBookmark}
        onDeleteHighlight={onDeleteHighlight}
      />
    </section>
  );
}

interface ReaderWorkspaceProps {
  activeBook: Book | null;
  reader: ReaderInfo | null;
  preferences: ReaderPreferences;
  progress: ProgressState | null;
  selection: SelectionState | null;
  dictionary: DictionaryResult | null;
  dictionaryLoading: boolean;
  jumpTarget: JumpTarget | null;
  onProgress: (progress: ProgressState) => void;
  onLookup: (selection: SelectionState) => void;
  onDismissSelection: () => void;
  onConvert: () => void;
  onBookmark: () => void;
  onHighlight: () => void;
  onPreferencesChange: (patch: Partial<ReaderPreferences>) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
  onDeleteHighlight: (highlight: Highlight) => void;
  onSaveReview: (rating: number, text: string) => void;
  onJump: (target: { locator?: string | null; page?: number | null }) => void;
  onCloseReader: () => void;
  onUsage: (mediaType: MediaType, seconds: number) => void;
}

function ReaderWorkspace({
  activeBook,
  reader,
  preferences,
  progress,
  selection,
  dictionary,
  dictionaryLoading,
  jumpTarget,
  onProgress,
  onLookup,
  onDismissSelection,
  onConvert,
  onBookmark,
  onHighlight,
  onPreferencesChange,
  onDeleteBookmark,
  onDeleteHighlight,
  onSaveReview,
  onJump,
  onCloseReader,
  onUsage
}: ReaderWorkspaceProps) {
  const shellRef = useRef<HTMLElement | null>(null);
  const [activePanel, setActivePanel] = useState<ReaderPanel>(null);
  const [tocItems, setTocItems] = useState<ReaderTocItem[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<ReaderSearchResult[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [readerChromeVisible, setReaderChromeVisible] = useState(true);
  const chromeHideTimerRef = useRef<number | null>(null);
  const shouldAutoHideChrome = !activePanel;
  useActiveUsageTimer(
    Boolean(activeBook && reader?.fileUrl && reader.format !== "audio"),
    "ebook",
    onUsage,
    true
  );

  useEffect(() => {
    setActivePanel(null);
    setSearchTerm("");
    setSearchResults([]);
  }, [activeBook?.id]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const clearChromeHideTimer = useCallback(() => {
    if (chromeHideTimerRef.current) {
      window.clearTimeout(chromeHideTimerRef.current);
      chromeHideTimerRef.current = null;
    }
  }, []);

  const scheduleChromeHide = useCallback(() => {
    clearChromeHideTimer();
    if (!shouldAutoHideChrome) {
      return;
    }
    chromeHideTimerRef.current = window.setTimeout(() => {
      setReaderChromeVisible(false);
    }, 2600);
  }, [clearChromeHideTimer, shouldAutoHideChrome]);

  const showReaderChrome = useCallback(() => {
    setReaderChromeVisible(true);
    scheduleChromeHide();
  }, [scheduleChromeHide]);

  const hideReaderChrome = useCallback(() => {
    clearChromeHideTimer();
    if (!activePanel) {
      setReaderChromeVisible(false);
    }
  }, [activePanel, clearChromeHideTimer]);

  const handleReaderChromeIntent = useCallback(
    (intent: ReaderChromeIntent) => {
      if (intent === "show") {
        showReaderChrome();
      } else {
        hideReaderChrome();
      }
    },
    [hideReaderChrome, showReaderChrome]
  );

  useEffect(() => {
    clearChromeHideTimer();
    setReaderChromeVisible(true);
    if (shouldAutoHideChrome) {
      chromeHideTimerRef.current = window.setTimeout(() => {
        setReaderChromeVisible(false);
      }, 1800);
    }

    return clearChromeHideTimer;
  }, [activeBook?.id, clearChromeHideTimer, shouldAutoHideChrome]);

  if (!activeBook) {
    return (
      <section className="empty-state">
        <Library size={32} />
        <h2>Your library is empty</h2>
        <p>Add ebooks or MP3, M4B, M4A, AAC, OGG, OPUS, WAV, or FLAC audiobooks from the library panel.</p>
      </section>
    );
  }

  if (activeBook.status === "needs-conversion" || activeBook.status === "error") {
    return (
      <section className="prepare-state">
        <div>
          <h2>{activeBook.title}</h2>
          <p>{activeBook.error || "This format needs to be prepared as EPUB before browser reading."}</p>
        </div>
        <button type="button" className="primary-button" onClick={onConvert}>
          <RefreshCw size={18} />
          Prepare
        </button>
      </section>
    );
  }

  if (activeBook.status === "converting") {
    return (
      <section className="prepare-state">
        <div>
          <h2>{activeBook.title}</h2>
          <p>Preparing EPUB reading copy.</p>
        </div>
        <Loader2 className="spin" size={22} />
      </section>
    );
  }

  if (!reader?.fileUrl || !reader.format) {
    return (
      <section className="prepare-state">
        <div>
          <h2>{activeBook.title}</h2>
          <p>This file is not ready for browser reading.</p>
        </div>
      </section>
    );
  }

  if (reader.format === "audio") {
    // Audiobooks play in the app-level player so they keep going while you browse.
    return (
      <section className="prepare-state">
        <div>
          <h2>{activeBook.title}</h2>
          <p>This audiobook plays in the Shelf player.</p>
        </div>
        <button type="button" className="secondary-button" onClick={onCloseReader}>Back to library</button>
      </section>
    );
  }

  return (
    <section
      ref={shellRef}
      className={`reader-layout kindle-reader-shell ${preferences.pageLayout === "spread" ? "is-spread-layout" : ""} ${readerChromeVisible ? "is-chrome-visible" : "is-chrome-hidden"}`}
    >
      <div
        className="reader-toolbar-hotspot"
        aria-hidden="true"
        onMouseEnter={showReaderChrome}
        onMouseMove={showReaderChrome}
      />
      <div
        className="kindle-reader-topbar"
        onMouseEnter={showReaderChrome}
        onMouseMove={showReaderChrome}
      >
        <button type="button" className="kindle-library-button" onClick={onCloseReader}>
          <BookOpen size={16} />
          Library
        </button>
        <div className="kindle-reader-title">{activeBook.title}</div>
        <ReaderTopToolbar
          activePanel={activePanel}
          fullscreen={fullscreen}
          onTogglePanel={(panel) => setActivePanel((current) => (current === panel ? null : panel))}
          onToggleFullscreen={() => void toggleReaderFullscreen(shellRef.current)}
          onBookmark={onBookmark}
        />
      </div>

      {activePanel ? (
        <ReaderPanelPopover
          panel={activePanel}
          preferences={preferences}
          tocItems={tocItems}
          searchTerm={searchTerm}
          searchResults={searchResults}
          bookmarks={reader.bookmarks}
          highlights={reader.highlights}
          onPreferencesChange={onPreferencesChange}
          onSearchTermChange={setSearchTerm}
          onJump={(target) => {
            setActivePanel(null);
            onJump(target);
          }}
          onDeleteBookmark={onDeleteBookmark}
          onDeleteHighlight={onDeleteHighlight}
        />
      ) : null}

      <div className="kindle-reader-main">
        <div className="viewer-frame reader-content-frame">
          {reader.format === "epub" ? (
            <EpubReader
              fileUrl={reader.fileUrl}
              preferences={preferences}
              progress={progress}
              highlights={reader.highlights}
              jumpTarget={jumpTarget}
              onProgress={onProgress}
              onLookup={onLookup}
              onReaderInteraction={handleReaderChromeIntent}
              searchTerm={searchTerm}
              onTocChange={setTocItems}
              onSearchResults={setSearchResults}
            />
          ) : (
            <PdfReader
              fileUrl={reader.fileUrl}
              preferences={preferences}
              progress={progress}
              jumpTarget={jumpTarget}
              onProgress={onProgress}
              onLookup={onLookup}
              onReaderInteraction={handleReaderChromeIntent}
              searchTerm={searchTerm}
              onTocChange={setTocItems}
              onSearchResults={setSearchResults}
            />
          )}
          <SelectionLookupPopover
            selection={selection}
            dictionary={dictionary}
            loading={dictionaryLoading}
            onHighlight={onHighlight}
            onDismiss={onDismissSelection}
          />
        </div>
      </div>

      <ReaderProgressStrip
        book={activeBook}
        preferences={preferences}
        progress={progress}
      />
    </section>
  );
}

function AudiobookPlayer({
  book,
  tracks,
  progress,
  autoPlay,
  playRequest,
  seekRequest,
  skipBackSeconds,
  skipForwardSeconds,
  inReadList,
  read,
  onProgress,
  onPlayingChange,
  onBookmark,
  onAddNote,
  onToggleReadList,
  onSetReadState,
  onOpenDetails,
  onClose,
  onUsage,
  controlsRef
}: {
  book: Book;
  tracks: ReaderInfo["audioTracks"];
  progress: ProgressState | null;
  autoPlay: boolean;
  playRequest: number;
  seekRequest: AudioSeekRequest | null;
  skipBackSeconds: number;
  skipForwardSeconds: number;
  inReadList: boolean;
  read: boolean;
  onProgress: (progress: ProgressState) => void;
  onPlayingChange: (playing: boolean) => void;
  onBookmark: () => void;
  onAddNote: (note: AudioNote) => Promise<boolean>;
  onToggleReadList: () => void;
  onSetReadState: (read: boolean) => void;
  // Set once the book details page exists; until then the cover and title aren't clickable.
  onOpenDetails?: () => void;
  onClose: () => void;
  onUsage: (mediaType: MediaType, seconds: number) => void;
  // Lets Shelf pause and reposition the player when the book is marked read or unread elsewhere.
  controlsRef?: React.MutableRefObject<AudioPlayerControls | null>;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const pendingPlayRef = useRef(autoPlay);
  const lastPlayRequestRef = useRef(playRequest);
  const lastSeekStampRef = useRef(seekRequest?.stamp ?? 0);
  const selectTrackRef = useRef<((index: number, time: number, autoPlay: boolean) => void) | null>(null);
  // After "Mark as read/unread", stop saving the old position until playback resumes.
  const suppressProgressRef = useRef(false);
  const lastVolumeRef = useRef(1);
  const barToolsRef = useRef<HTMLDivElement | null>(null);
  const restoredRef = useRef(false);
  const lastEmitRef = useRef(0);
  // The newest position heard while playing; saved on unmount only if it hasn't been saved yet.
  const latestProgressRef = useRef<ProgressState | null>(null);
  const unsavedProgressRef = useRef(false);
  const applyReadStateRef = useRef<(read: boolean) => void>(() => undefined);
  const [trackIndex, setTrackIndex] = useState(() => initialAudioTrack(progress, tracks));
  const [trackTime, setTrackTime] = useState(progress?.trackTime || 0);
  const [playing, setPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(() => {
    const stored = Number(window.localStorage.getItem("shelfstream-audio-rate"));
    const isValidStep = Math.abs(stored * 20 - Math.round(stored * 20)) < 0.000001;
    return stored >= 0.5 && stored <= 3 && isValidStep ? stored : 1;
  });
  const [volume, setVolume] = useState(() => {
    const saved = window.localStorage.getItem("shelfstream-audio-volume");
    if (saved === null) {
      return 1;
    }
    const stored = Number(saved);
    return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 1;
  });
  const [muted, setMuted] = useState(false);
  const [volumeAdjustable] = useState(canAdjustVolume);
  const [durations, setDurations] = useState(() =>
    tracks.map((track) => track.durationSeconds || 0)
  );
  const [notice, setNotice] = useState("");
  const [barMenu, setBarMenu] = useState<"speed" | "chapters" | "more" | "note" | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [notePosition, setNotePosition] = useState<{ label: string; locator: string; percent: number } | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);

  const castState = useCast();
  const casting = castState.connected;
  // Read inside audio event handlers, which can fire after casting starts but before a re-render.
  const castingRef = useRef(casting);
  castingRef.current = casting;
  const wasCastingRef = useRef(false);
  const castPlayRef = useRef<() => void>(() => undefined);
  const startCastingRef = useRef<() => void>(() => undefined);
  // What the TV is playing, only when it's this book.
  const remote = casting && castState.media?.bookId === book.id ? castState.media : null;
  const airPlay = useAirPlay(audioRef);

  // Browsers can refuse playback that doesn't follow a click; stay paused instead of erroring.
  const playAudio = useCallback(() => {
    if (castingRef.current) {
      castPlayRef.current();
      return;
    }
    void audioRef.current?.play().catch(() => setPlaying(false));
  }, []);

  const pauseAudio = useCallback(() => {
    if (castingRef.current) {
      castControls.pause();
      return;
    }
    audioRef.current?.pause();
  }, []);

  useEffect(() => onCastSessionStarted(() => startCastingRef.current()), []);

  useEffect(() => {
    if (playRequest === lastPlayRequestRef.current) {
      return;
    }
    lastPlayRequestRef.current = playRequest;
    playAudio();
  }, [playAudio, playRequest]);

  useEffect(() => {
    if (!seekRequest || seekRequest.stamp === lastSeekStampRef.current) {
      return;
    }
    lastSeekStampRef.current = seekRequest.stamp;
    selectTrackRef.current?.(seekRequest.trackIndex, seekRequest.trackTime, seekRequest.play);
  }, [seekRequest]);

  useEffect(() => {
    onPlayingChange(playing);
  }, [onPlayingChange, playing]);

  useEffect(() => () => onPlayingChange(false), [onPlayingChange]);

  useEffect(() => {
    if (!controlsRef) {
      return;
    }
    const controls: AudioPlayerControls = { applyReadState: (read) => applyReadStateRef.current(read) };
    controlsRef.current = controls;
    return () => {
      if (controlsRef.current === controls) {
        controlsRef.current = null;
      }
    };
  }, [controlsRef]);

  useEffect(() => {
    if (!barMenu) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!barToolsRef.current?.contains(event.target as Node)) {
        setBarMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBarMenu(null);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [barMenu]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useActiveUsageTimer(playing, "audiobook", onUsage, false);

  useEffect(() => {
    if (castingRef.current) {
      castControls.setPlaybackRate(playbackRate);
    }
  }, [playbackRate]);

  const track = tracks[trackIndex] || tracks[0];
  const allDurationsKnown = durations.length > 0 && durations.every((duration) => duration > 0);
  const totalDuration = allDurationsKnown
    ? durations.reduce((total, duration) => total + duration, 0)
    : book.durationSeconds || 0;
  const elapsedBeforeTrack = durations.slice(0, trackIndex).reduce((total, duration) => total + duration, 0);
  const elapsed = elapsedBeforeTrack + trackTime;
  const percent = totalDuration > 0
    ? clamp(elapsed / totalDuration, 0, 1)
    : clamp((trackIndex + (durations[trackIndex] ? trackTime / durations[trackIndex] : 0)) / Math.max(1, tracks.length), 0, 1);

  const emitProgress = useCallback((overrideTime?: number, finished = false) => {
    if (suppressProgressRef.current) {
      return;
    }
    const audio = audioRef.current;
    const localTime = overrideTime ?? audio?.currentTime ?? trackTime;
    const localDuration = audio?.duration && Number.isFinite(audio.duration)
      ? audio.duration
      : durations[trackIndex] || 0;
    const knownDurations = durations.map((duration, index) =>
      index === trackIndex && localDuration > 0 ? localDuration : duration
    );
    const knownTotal = knownDurations.every((duration) => duration > 0)
      ? knownDurations.reduce((total, duration) => total + duration, 0)
      : totalDuration;
    const globalTime = knownDurations.slice(0, trackIndex).reduce((total, duration) => total + duration, 0) + localTime;
    const nextPercent = finished
      ? 1
      : knownTotal > 0
        ? clamp(globalTime / knownTotal, 0, 1)
        : clamp((trackIndex + (localDuration > 0 ? localTime / localDuration : 0)) / Math.max(1, tracks.length), 0, 1);
    const next: ProgressState = {
      percent: nextPercent,
      locator: `audio:${trackIndex}:${Math.round(localTime)}`,
      currentTime: knownTotal > 0 ? globalTime : null,
      duration: knownTotal || null,
      trackIndex,
      trackTime: localTime,
      page: null,
      totalPages: null
    };
    latestProgressRef.current = next;
    unsavedProgressRef.current = false;
    lastEmitRef.current = Date.now();
    onProgress(next);
  }, [durations, onProgress, totalDuration, trackIndex, trackTime, tracks.length]);

  // While casting, the bar follows the TV. The receiver saves progress itself; saving here too
  // keeps Shelf's own progress display current while this tab is open.
  useEffect(() => {
    if (!remote) {
      return;
    }
    if (remote.trackIndex !== trackIndex) {
      pendingSeekRef.current = null;
      pendingPlayRef.current = false;
      restoredRef.current = true;
      setTrackIndex(remote.trackIndex);
    } else if (remote.playing && Date.now() - lastEmitRef.current >= 10000) {
      emitProgress(remote.currentTime);
    }
    setTrackTime(remote.currentTime);
    setPlaying(remote.playing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote?.trackIndex, remote?.currentTime, remote?.playing]);

  // When casting stops, pick up here, paused, from where the TV was.
  useEffect(() => {
    if (casting) {
      wasCastingRef.current = true;
      return;
    }
    if (!wasCastingRef.current) {
      return;
    }
    wasCastingRef.current = false;
    setPlaying(false);
    const audio = audioRef.current;
    if (audio && audio.readyState >= 1) {
      audio.currentTime = trackTime;
    } else {
      pendingSeekRef.current = trackTime;
    }
    emitProgress(trackTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [casting]);

  useEffect(() => {
    return () => {
      if (latestProgressRef.current && unsavedProgressRef.current && !suppressProgressRef.current) {
        onProgress(latestProgressRef.current);
      }
    };
  }, [onProgress]);

  useEffect(() => {
    window.localStorage.setItem("shelfstream-audio-rate", String(playbackRate));
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  useEffect(() => {
    window.localStorage.setItem("shelfstream-audio-volume", String(volume));
    if (audioRef.current) {
      audioRef.current.volume = volume;
    }
  }, [volume]);

  // Mute with `muted` rather than volume 0: iPhone and iPad Safari ignore volume changes.
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.muted = muted;
    }
  }, [muted]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !track) {
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || book.title,
      artist: book.author,
      album: book.title,
      artwork: book.coverUrl ? [{ src: book.coverUrl }] : []
    });
    navigator.mediaSession.setActionHandler("play", playAudio);
    navigator.mediaSession.setActionHandler("pause", pauseAudio);
    navigator.mediaSession.setActionHandler("seekbackward", (details) => seekRelative(-(details.seekOffset || skipBackSeconds)));
    navigator.mediaSession.setActionHandler("seekforward", (details) => seekRelative(details.seekOffset || skipForwardSeconds));
    return () => {
      for (const action of ["play", "pause", "seekbackward", "seekforward"] as MediaSessionAction[]) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
  });

  if (!track) {
    return (
      <section className="player-bar player-bar-empty" aria-label="Audiobook player">
        <p><strong>{book.title}</strong> has no playable audio tracks.</p>
        <button type="button" className="player-bar-tool" title="Close player" aria-label="Close player" onClick={onClose}>
          <X size={22} />
        </button>
      </section>
    );
  }

  const selectTrack = (nextIndex: number, nextTime = 0, autoPlay = playing) => {
    // Any explicit move (chapter, seek, note or bookmark jump) counts as listening again.
    suppressProgressRef.current = false;
    const boundedIndex = clamp(Math.round(nextIndex), 0, tracks.length - 1);
    if (castingRef.current) {
      castMoveTo(boundedIndex, Math.max(0, nextTime), autoPlay);
      return;
    }
    if (boundedIndex === trackIndex) {
      if (audioRef.current) {
        audioRef.current.currentTime = clamp(nextTime, 0, audioRef.current.duration || Number.MAX_SAFE_INTEGER);
        setTrackTime(audioRef.current.currentTime);
        emitProgress(audioRef.current.currentTime);
        if (autoPlay) {
          playAudio();
        }
      }
      return;
    }
    emitProgress();
    pendingSeekRef.current = Math.max(0, nextTime);
    pendingPlayRef.current = autoPlay;
    restoredRef.current = true;
    setTrackIndex(boundedIndex);
    setTrackTime(Math.max(0, nextTime));
  };

  // Sends a move to the TV: a seek within the chapter it's playing, otherwise a reload at the new spot.
  function castMoveTo(index: number, time: number, autoPlay: boolean) {
    setTrackTime(time);
    if (remote && remote.trackIndex === index) {
      castControls.seek(time);
      if (autoPlay && !remote.playing) {
        castControls.playOrPause();
      }
      return;
    }
    void castControls
      .load({ bookId: book.id, trackIndex: index, time, play: autoPlay, playbackRate })
      .catch(() => setNotice("Couldn't send this book to the TV."));
  }

  // The current chapter's position and length, from the TV while casting.
  function mediaPosition() {
    const audio = audioRef.current;
    if (castingRef.current) {
      return { time: trackTime, duration: remote?.duration || durations[trackIndex] || NaN };
    }
    return audio ? { time: audio.currentTime, duration: audio.duration } : null;
  }

  function seekWithinTrack(time: number) {
    if (castingRef.current) {
      castMoveTo(trackIndex, time, playing);
    } else if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
    setTrackTime(time);
    emitProgress(time);
  }

  function seekRelative(seconds: number) {
    const position = mediaPosition();
    if (!position) {
      return;
    }
    const localDuration = Number.isFinite(position.duration) && position.duration > 0 ? position.duration : durations[trackIndex] || 0;
    const knownDurations = durations.map((duration, index) => (index === trackIndex && localDuration > 0 ? localDuration : duration));
    if (knownDurations.every((duration) => duration > 0)) {
      // Skip by the full amount even when it crosses more than one chapter.
      const bookDuration = knownDurations.reduce((total, duration) => total + duration, 0);
      const before = knownDurations.slice(0, trackIndex).reduce((total, duration) => total + duration, 0);
      const bookTarget = clamp(before + position.time + seconds, 0, bookDuration);
      let offset = 0;
      for (let index = 0; index < knownDurations.length; index += 1) {
        if (bookTarget < offset + knownDurations[index] || index === knownDurations.length - 1) {
          const local = bookTarget - offset;
          if (index === trackIndex) {
            seekWithinTrack(local);
          } else {
            // Stay just inside the chapter so it doesn't load and end straight away.
            selectTrack(index, Math.min(local, Math.max(0, knownDurations[index] - 1)), playing);
          }
          return;
        }
        offset += knownDurations[index];
      }
    }
    let target = position.time + seconds;
    if (target < 0 && trackIndex > 0) {
      const previousDuration = durations[trackIndex - 1] || 0;
      selectTrack(trackIndex - 1, Math.max(0, previousDuration + target), playing);
      return;
    }
    if (Number.isFinite(position.duration) && target >= position.duration && trackIndex < tracks.length - 1) {
      selectTrack(trackIndex + 1, target - position.duration, playing);
      return;
    }
    target = clamp(target, 0, Number.isFinite(position.duration) ? position.duration : Number.MAX_SAFE_INTEGER);
    seekWithinTrack(target);
  }

  const seekToPercent = (nextPercent: number) => {
    if (totalDuration <= 0 || !allDurationsKnown) {
      const position = mediaPosition();
      if (position && Number.isFinite(position.duration)) {
        seekWithinTrack(position.duration * nextPercent);
      }
      return;
    }

    const target = clamp(nextPercent, 0, 1) * totalDuration;
    let offset = 0;
    for (let index = 0; index < durations.length; index += 1) {
      if (target <= offset + durations[index] || index === durations.length - 1) {
        selectTrack(index, target - offset, playing);
        return;
      }
      offset += durations[index];
    }
  };

  selectTrackRef.current = selectTrack;

  castPlayRef.current = () => {
    if (remote) {
      if (!remote.playing) {
        castControls.playOrPause();
      }
      return;
    }
    // The TV is idle or playing something else: send this book from the current spot.
    castMoveTo(trackIndex, trackTime, true);
  };

  // The person just picked a device: move what's in the bar to the TV.
  startCastingRef.current = () => {
    const audio = audioRef.current;
    const time = audio?.currentTime ?? trackTime;
    const wasPlaying = playing;
    audio?.pause();
    emitProgress(time);
    void castControls
      .load({ bookId: book.id, trackIndex, time, play: wasPlaying, playbackRate })
      .catch(() => setNotice("Couldn't send this book to the TV."));
  };

  const shareAudiobook = async () => {
    // Links straight to this book; anyone with an account on this server can open it.
    const shareUrl = new URL(window.location.pathname, window.location.origin);
    shareUrl.searchParams.set("openBook", book.id);
    try {
      if (navigator.share) {
        await navigator.share({
          title: book.title,
          text: `${book.title} by ${book.author || "Unknown author"}`,
          url: shareUrl.href
        });
      } else {
        await navigator.clipboard.writeText(shareUrl.href);
        setNotice("Link copied.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setNotice("Unable to share this book.");
    }
  };

  const audioElement = (
      <audio
        ref={audioRef}
        src={track.fileUrl}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          audio.playbackRate = playbackRate;
          audio.volume = volume;
          audio.muted = muted;
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            setDurations((items) => items.map((duration, index) => index === trackIndex ? audio.duration : duration));
          }
          let resumeAt = pendingSeekRef.current;
          if (resumeAt === null && !restoredRef.current && progress?.trackIndex === trackIndex) {
            resumeAt = progress.trackTime || 0;
          }
          pendingSeekRef.current = null;
          restoredRef.current = true;
          if (resumeAt && resumeAt < audio.duration) {
            audio.currentTime = resumeAt;
            setTrackTime(resumeAt);
          }
          if (pendingPlayRef.current) {
            pendingPlayRef.current = false;
            playAudio();
          }
        }}
        onPlay={(event) => {
          if (castingRef.current) {
            event.currentTarget.pause();
            return;
          }
          suppressProgressRef.current = false;
          setPlaying(true);
        }}
        onPause={() => {
          if (castingRef.current) {
            return;
          }
          setPlaying(false);
          emitProgress();
        }}
        onTimeUpdate={(event) => {
          if (castingRef.current) {
            return;
          }
          const nextTime = event.currentTarget.currentTime;
          setTrackTime(nextTime);
          // Seeks while paused (like resuming the saved spot on startup) aren't listening, so
          // don't save them; that would overwrite a newer position from another device.
          if (event.currentTarget.paused || suppressProgressRef.current) {
            return;
          }
          const nextDuration = event.currentTarget.duration;
          const knownTotal = durations.every((duration, index) => index === trackIndex ? nextDuration > 0 : duration > 0)
            ? durations.reduce((total, duration, index) => total + (index === trackIndex ? nextDuration : duration), 0)
            : totalDuration;
          const nextGlobal = durations.slice(0, trackIndex).reduce((total, duration) => total + duration, 0) + nextTime;
          latestProgressRef.current = {
            percent: knownTotal > 0 ? clamp(nextGlobal / knownTotal, 0, 1) : percent,
            locator: `audio:${trackIndex}:${Math.round(nextTime)}`,
            currentTime: knownTotal > 0 ? nextGlobal : null,
            duration: knownTotal || null,
            trackIndex,
            trackTime: nextTime,
            page: null,
            totalPages: null
          };
          unsavedProgressRef.current = true;
          if (Date.now() - lastEmitRef.current >= 5000) {
            emitProgress(nextTime);
          }
        }}
        onEnded={() => {
          if (castingRef.current) {
            return;
          }
          if (trackIndex < tracks.length - 1) {
            selectTrack(trackIndex + 1, 0, true);
          } else {
            setPlaying(false);
            emitProgress(audioRef.current?.duration || trackTime, true);
          }
        }}
      />
  );

  const remaining = Math.max(0, totalDuration - elapsed);
  const chapterLabel = tracks.length > 1 ? track.title || `Chapter ${trackIndex + 1}` : "";
  const togglePlayback = () => {
    if (playing) {
      pauseAudio();
    } else {
      playAudio();
    }
  };
  // While casting, volume and mute control the TV.
  const shownVolume = casting ? castState.volume : volume;
  const silent = casting ? castState.muted || castState.volume === 0 : muted || volume === 0;
  const toggleMute = () => {
    if (casting) {
      castControls.toggleMute();
      return;
    }
    if (!silent) {
      setMuted(true);
      return;
    }
    setMuted(false);
    if (volume === 0) {
      setVolume(lastVolumeRef.current || 1);
    }
  };
  const toggleMenu = (menu: "speed" | "chapters" | "more") => {
    setBarMenu((current) => (current === menu ? null : menu));
  };
  // Called by Shelf (through controlsRef) whenever this book is marked read or unread,
  // whether from this menu or from a book card elsewhere.
  applyReadStateRef.current = (nextRead: boolean) => {
    // Stop saving the current spot (including the save the pause triggers) so it can't
    // overwrite the new read state. Saving resumes when playback does.
    suppressProgressRef.current = true;
    latestProgressRef.current = null;
    pauseAudio();
    if (!nextRead) {
      // Unread starts the book over.
      if (castingRef.current) {
        castMoveTo(0, 0, false);
      } else if (trackIndex === 0) {
        if (audioRef.current) {
          audioRef.current.currentTime = 0;
        }
      } else {
        pendingSeekRef.current = 0;
        pendingPlayRef.current = false;
        restoredRef.current = true;
        setTrackIndex(0);
      }
      setTrackTime(0);
    }
  };
  const setReadState = (nextRead: boolean) => {
    setBarMenu(null);
    onSetReadState(nextRead);
    setNotice(nextRead ? "Marked as read." : "Marked as unread.");
  };
  const openNote = () => {
    const time = casting ? trackTime : audioRef.current?.currentTime ?? trackTime;
    const position = tracks.length > 1
      ? `${track.title || `Chapter ${trackIndex + 1}`} · ${formatAudioTime(time)}`
      : formatAudioTime(elapsedBeforeTrack + time);
    setNotePosition({ label: position, locator: `audio:${trackIndex}:${Math.round(time)}`, percent });
    setNoteDraft("");
    setBarMenu("note");
  };
  const saveNote = async () => {
    if (!notePosition || !noteDraft.trim() || noteSaving) {
      return;
    }
    setNoteSaving(true);
    const saved = await onAddNote({ note: noteDraft.trim(), ...notePosition });
    setNoteSaving(false);
    if (saved) {
      setBarMenu(null);
      setNoteDraft("");
      setNotice("Note saved to Notes & Highlights.");
    }
  };
  const showCastButton = castState.supported && (castState.available || casting);
  const coverArt = <BookCover book={book} fit="contain" />;
  const titleText = (
    <>
      <strong>{book.title}</strong>
      <span>
        {casting
          ? [castState.deviceName ? `Casting to ${castState.deviceName}` : "Casting", chapterLabel].filter(Boolean).join(" · ")
          : [book.author || "Unknown author", chapterLabel].filter(Boolean).join(" · ")}
      </span>
    </>
  );

  // Pocket Casts-style bar along the bottom of every page.
  return (
    <>
      <section className="player-bar" aria-label="Audiobook player">
        <div className="player-bar-transport">
          {onOpenDetails ? (
            <button type="button" className="player-bar-art" title="Book details" aria-label={`Details for ${book.title}`} onClick={onOpenDetails}>
              {coverArt}
            </button>
          ) : (
            <span className="player-bar-art">{coverArt}</span>
          )}
          <button type="button" className="player-bar-skip player-bar-back" title={`Back ${skipBackSeconds} seconds`} aria-label={`Back ${skipBackSeconds} seconds`} onClick={() => seekRelative(-skipBackSeconds)}>
            <RotateCcw size={34} strokeWidth={1.7} />
            <span aria-hidden="true" className={skipBackSeconds >= 100 ? "is-long" : ""}>{skipBackSeconds}</span>
          </button>
          <button type="button" className="player-bar-play" title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : "Play"} onClick={togglePlayback}>
            {playing ? <Pause size={34} fill="currentColor" strokeWidth={0} /> : <Play size={36} fill="currentColor" strokeWidth={0} />}
          </button>
          <button type="button" className="player-bar-skip player-bar-forward" title={`Forward ${skipForwardSeconds} seconds`} aria-label={`Forward ${skipForwardSeconds} seconds`} onClick={() => seekRelative(skipForwardSeconds)}>
            <RotateCw size={34} strokeWidth={1.7} />
            <span aria-hidden="true" className={skipForwardSeconds >= 100 ? "is-long" : ""}>{skipForwardSeconds}</span>
          </button>
        </div>

        <div className="player-bar-now">
          {onOpenDetails ? (
            <button type="button" className="player-bar-title" title="Book details" onClick={onOpenDetails}>
              {titleText}
            </button>
          ) : (
            <div className="player-bar-title">{titleText}</div>
          )}
          <div className="player-bar-seek">
            <input
              type="range"
              min="0"
              max="1000"
              value={Math.round(percent * 1000)}
              aria-label="Audiobook position"
              aria-valuetext={`${formatAudioTime(elapsed)} of ${formatAudioTime(totalDuration)}`}
              style={{ "--player-bar-progress": `${percent * 100}%` } as React.CSSProperties}
              onChange={(event) => seekToPercent(Number(event.target.value) / 1000)}
            />
            <div className="player-bar-times">
              <span>{formatAudioTime(elapsed)}</span>
              <span>{totalDuration > 0 ? `-${formatAudioTime(remaining)}` : formatPercent(percent)}</span>
            </div>
          </div>
        </div>

        <div className="player-bar-tools" ref={barToolsRef}>
          <button type="button" className="player-bar-tool player-bar-bookmark" title="Add bookmark" aria-label="Add bookmark" onClick={onBookmark}>
            <BookmarkIcon size={24} />
          </button>
          {showCastButton ? (
            <button
              type="button"
              className={`player-bar-tool player-bar-cast ${casting ? "is-active" : ""}`}
              title={casting ? `Casting to ${castState.deviceName || "TV"}` : "Cast"}
              aria-label={casting ? `Casting to ${castState.deviceName || "TV"}. Choose device or stop casting` : "Cast to a device"}
              onClick={castControls.requestSession}
            >
              <Cast size={24} />
            </button>
          ) : null}
          {airPlay.available ? (
            <button
              type="button"
              className={`player-bar-tool player-bar-airplay ${airPlay.active ? "is-active" : ""}`}
              title="AirPlay"
              aria-label="AirPlay"
              onClick={airPlay.showPicker}
            >
              <Airplay size={24} />
            </button>
          ) : null}
          <div className="player-bar-menu player-bar-speed">
            <button
              type="button"
              className={`player-bar-tool player-bar-speed-button ${barMenu === "speed" ? "is-active" : ""}`}
              title="Playback speed"
              aria-label={`Playback speed ${formatPlaybackRate(playbackRate)}×`}
              aria-expanded={barMenu === "speed"}
              onClick={() => toggleMenu("speed")}
            >
              <span>{formatPlaybackRate(playbackRate)}×</span>
            </button>
          </div>
          <div className="player-bar-volume">
            <button type="button" className="player-bar-tool" title={silent ? "Unmute" : "Mute"} aria-label={silent ? "Unmute" : "Mute"} onClick={toggleMute}>
              {silent ? <VolumeX size={24} /> : shownVolume < 0.5 ? <Volume1 size={24} /> : <Volume2 size={24} />}
            </button>
            {/* iPhone and iPad only allow the hardware buttons to change volume. */}
            {volumeAdjustable ? (
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={silent ? 0 : shownVolume}
                aria-label="Volume"
                style={{ "--player-bar-progress": `${(silent ? 0 : shownVolume) * 100}%` } as React.CSSProperties}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (casting) {
                    castControls.setVolume(next);
                    return;
                  }
                  setVolume(next);
                  if (next > 0) {
                    lastVolumeRef.current = next;
                    setMuted(false);
                  }
                }}
              />
            ) : null}
          </div>
          <button
            type="button"
            className={`player-bar-tool player-bar-chapters-button ${barMenu === "chapters" ? "is-active" : ""}`}
            title="Chapters"
            aria-label="Chapters"
            aria-expanded={barMenu === "chapters"}
            onClick={() => toggleMenu("chapters")}
          >
            <ChapterListIcon size={24} />
          </button>
          <button
            type="button"
            className={`player-bar-tool player-bar-more-button ${barMenu === "more" || barMenu === "note" ? "is-active" : ""}`}
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={barMenu === "more"}
            onClick={() => toggleMenu("more")}
          >
            <Ellipsis size={24} />
          </button>

          {barMenu === "speed" ? (
            <div className="player-bar-popover player-bar-speed-popover" role="group" aria-label="Playback speed">
              <div className="player-bar-popover-heading">
                <span>Playback speed</span>
                <strong>{formatPlaybackRate(playbackRate)}×</strong>
              </div>
              <input
                type="range"
                min="0.5"
                max="3"
                step="0.05"
                value={playbackRate}
                aria-label="Playback speed"
                style={{ "--player-bar-progress": `${((playbackRate - 0.5) / 2.5) * 100}%` } as React.CSSProperties}
                onChange={(event) => setPlaybackRate(Number(event.target.value))}
              />
              <div className="player-bar-speed-presets">
                {[0.8, 1, 1.25, 1.5, 2].map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    className={Math.abs(playbackRate - rate) < 0.001 ? "is-active" : ""}
                    onClick={() => setPlaybackRate(rate)}
                  >
                    {formatPlaybackRate(rate)}×
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {barMenu === "chapters" ? (
            <div className="player-bar-popover player-bar-chapters" role="group" aria-label="Chapters">
              <div className="player-bar-popover-heading">
                <span>Chapters</span>
                <strong>{trackIndex + 1} of {tracks.length}</strong>
              </div>
              <ol>
                {tracks.map((item, index) => (
                  <li key={`${item.index}-${item.filename}`}>
                    <button
                      type="button"
                      className={index === trackIndex ? "is-active" : ""}
                      aria-current={index === trackIndex ? "true" : undefined}
                      onClick={() => {
                        selectTrack(index, 0, playing);
                        setBarMenu(null);
                      }}
                    >
                      <span>{index + 1}</span>
                      <strong>{item.title || `Chapter ${index + 1}`}</strong>
                      <small>{durations[index] ? formatAudioTime(durations[index]) : ""}</small>
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          {barMenu === "more" ? (
            <div className="player-bar-popover player-bar-more" role="menu" aria-label="More actions">
              <div className="player-bar-popover-label">More actions</div>
              <button type="button" role="menuitem" onClick={() => { setBarMenu(null); void shareAudiobook(); }}>
                <Share2 size={18} /><span>Share book</span>
              </button>
              <button type="button" role="menuitem" onClick={() => { setBarMenu(null); onToggleReadList(); }}>
                {inReadList ? <ListMinus size={18} /> : <ListPlus size={18} />}
                <span>{inReadList ? "Remove from Read List" : "Add to Read List"}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => setReadState(!read)}>
                <CircleCheck size={18} /><span>{read ? "Mark as unread" : "Mark as read"}</span>
              </button>
              <button type="button" role="menuitem" onClick={openNote}>
                <Highlighter size={18} /><span>Add note/highlight</span>
              </button>
              {/* On phones the bar has no room for these, so they live in this menu. */}
              <div className="player-bar-more-phone">
                <button type="button" role="menuitem" onClick={() => { setBarMenu(null); onBookmark(); }}>
                  <BookmarkIcon size={18} /><span>Add bookmark</span>
                </button>
                <button type="button" role="menuitem" onClick={() => setBarMenu("speed")}>
                  <Gauge size={18} /><span>Playback speed ({formatPlaybackRate(playbackRate)}×)</span>
                </button>
                <button type="button" role="menuitem" onClick={() => setBarMenu("chapters")}>
                  <ChapterListIcon size={18} /><span>Chapters</span>
                </button>
                {showCastButton ? (
                  <button type="button" role="menuitem" onClick={() => { setBarMenu(null); castControls.requestSession(); }}>
                    <Cast size={18} /><span>{casting ? `Casting to ${castState.deviceName || "TV"}` : "Cast"}</span>
                  </button>
                ) : null}
                {airPlay.available ? (
                  <button type="button" role="menuitem" onClick={() => { setBarMenu(null); airPlay.showPicker(); }}>
                    <Airplay size={18} /><span>AirPlay</span>
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {barMenu === "note" && notePosition ? (
            <form
              className="player-bar-popover player-bar-note"
              aria-label="Add note"
              onSubmit={(event) => {
                event.preventDefault();
                void saveNote();
              }}
            >
              <div className="player-bar-popover-heading">
                <span>Add note</span>
                <strong>{notePosition.label}</strong>
              </div>
              <textarea
                value={noteDraft}
                rows={3}
                maxLength={2000}
                placeholder="What do you want to remember here?"
                aria-label="Note"
                autoFocus
                onChange={(event) => setNoteDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    void saveNote();
                  }
                }}
              />
              <div className="player-bar-note-actions">
                <button type="button" className="secondary-button" onClick={() => setBarMenu(null)}>Cancel</button>
                <button type="submit" className="primary-button" disabled={!noteDraft.trim() || noteSaving}>
                  {noteSaving ? <Loader2 className="spin" size={16} /> : null}
                  Save note
                </button>
              </div>
            </form>
          ) : null}
        </div>

        {notice ? <div className="player-bar-notice" role="status">{notice}</div> : null}
      </section>
      {audioElement}
    </>
  );
}

// Chapter list icon: three long lines with three short dashes beside them.
function ChapterListIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
      <path d="M2 6h13M2 12h13M2 18h13M18 6h4M18 12h4M18 18h4" />
    </svg>
  );
}

let volumeAdjustable: boolean | null = null;

function canAdjustVolume() {
  if (volumeAdjustable === null) {
    try {
      const probe = document.createElement("audio");
      probe.volume = 0.5;
      volumeAdjustable = Math.abs(probe.volume - 0.5) < 0.01;
    } catch {
      volumeAdjustable = false;
    }
  }
  return volumeAdjustable;
}

function initialAudioTrack(progress: ProgressState | null, tracks: ReaderInfo["audioTracks"]) {
  if (Number.isInteger(progress?.trackIndex)) {
    return clamp(progress?.trackIndex || 0, 0, Math.max(0, tracks.length - 1));
  }
  if (progress?.currentTime && tracks.every((track) => (track.durationSeconds || 0) > 0)) {
    let remaining = progress.currentTime;
    for (let index = 0; index < tracks.length; index += 1) {
      const duration = tracks[index].durationSeconds || 0;
      if (remaining < duration) {
        return index;
      }
      remaining -= duration;
    }
  }
  return 0;
}

export function formatAudioTime(value: number) {
  const total = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatPlaybackRate(value: number) {
  return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function ReaderTopToolbar({
  activePanel,
  fullscreen,
  onTogglePanel,
  onToggleFullscreen,
  onBookmark
}: {
  activePanel: ReaderPanel;
  fullscreen: boolean;
  onTogglePanel: (panel: Exclude<ReaderPanel, null>) => void;
  onToggleFullscreen: () => void;
  onBookmark: () => void;
}) {
  return (
    <div className="kindle-reader-actions" aria-label="Reader tools">
      <button
        type="button"
        className={activePanel === "toc" ? "is-active" : ""}
        title="Table of contents"
        onClick={() => onTogglePanel("toc")}
      >
        <List size={19} />
      </button>
      <button
        type="button"
        className={activePanel === "search" ? "is-active" : ""}
        title="Search"
        onClick={() => onTogglePanel("search")}
      >
        <Search size={19} />
      </button>
      <button
        type="button"
        className={activePanel === "display" ? "is-active" : ""}
        title="Text and spacing"
        onClick={() => onTogglePanel("display")}
      >
        <Type size={19} />
      </button>
      <button
        type="button"
        className={activePanel === "marks" ? "is-active" : ""}
        title="Notes & Highlights"
        onClick={() => onTogglePanel("marks")}
      >
        <Edit3 size={19} />
      </button>
      <button type="button" title={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={onToggleFullscreen}>
        {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
      </button>
      <button type="button" title="Bookmark this location" onClick={onBookmark}>
        <BookMarked size={19} />
      </button>
    </div>
  );
}

function ReaderPanelPopover({
  panel,
  preferences,
  tocItems,
  searchTerm,
  searchResults,
  bookmarks,
  highlights,
  onPreferencesChange,
  onSearchTermChange,
  onJump,
  onDeleteBookmark,
  onDeleteHighlight
}: {
  panel: Exclude<ReaderPanel, null>;
  preferences: ReaderPreferences;
  tocItems: ReaderTocItem[];
  searchTerm: string;
  searchResults: ReaderSearchResult[];
  bookmarks: Bookmark[];
  highlights: Highlight[];
  onPreferencesChange: (patch: Partial<ReaderPreferences>) => void;
  onSearchTermChange: (value: string) => void;
  onJump: (target: { locator?: string | null; page?: number | null }) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
  onDeleteHighlight: (highlight: Highlight) => void;
}) {
  return (
    <section className="reader-tool-popover">
      {panel === "toc" ? (
        <div className="reader-tool-panel">
          <h3>Table of contents</h3>
          <div className="reader-tool-list">
            {tocItems.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => onJump({ locator: item.locator, page: item.page })}
              >
                {item.label}
              </button>
            ))}
            {tocItems.length === 0 ? <p className="muted">Loading table of contents...</p> : null}
          </div>
        </div>
      ) : null}

      {panel === "search" ? (
        <div className="reader-tool-panel">
          <h3>Search</h3>
          <label className="search-box reader-search-box">
            <Search size={16} />
            <input
              value={searchTerm}
              autoFocus
              placeholder="Search this book"
              onChange={(event) => onSearchTermChange(event.target.value)}
            />
          </label>
          <div className="reader-tool-list search-results-list">
            {searchResults.map((result) => (
              <button
                type="button"
                key={result.id}
                onClick={() => onJump({ locator: result.locator, page: result.page })}
              >
                <strong>{result.label}</strong>
                <span>{result.excerpt}</span>
              </button>
            ))}
            {searchTerm.trim() && searchResults.length === 0 ? (
              <p className="muted">No matches yet.</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {panel === "display" ? (
        <DisplaySettingsPanel preferences={preferences} onPreferencesChange={onPreferencesChange} />
      ) : null}

      {panel === "marks" ? (
        <div className="reader-tool-panel reader-marks-panel">
          <h3>Notes & Highlights</h3>
          <AnnotationPanel
            bookmarks={bookmarks}
            highlights={highlights}
            onJump={onJump}
            onDeleteBookmark={onDeleteBookmark}
            onDeleteHighlight={onDeleteHighlight}
          />
        </div>
      ) : null}
    </section>
  );
}

function DisplaySettingsPanel({
  preferences,
  onPreferencesChange
}: {
  preferences: ReaderPreferences;
  onPreferencesChange: (patch: Partial<ReaderPreferences>) => void;
}) {
  const progressDisplay = preferences.progressDisplay || DEFAULT_PREFERENCES.progressDisplay;

  const updateProgressDisplay = (key: keyof ReaderPreferences["progressDisplay"]) => {
    onPreferencesChange({
      progressDisplay: {
        ...progressDisplay,
        [key]: !progressDisplay[key]
      }
    });
  };

  return (
    <div className="reader-tool-panel display-settings-panel">
      <section className="display-settings-section">
        <h3>Font</h3>
        <div className="font-choice-row" aria-label="Font">
          <button
            type="button"
            className={preferences.fontFamily === "Georgia" ? "is-active" : ""}
            onClick={() => onPreferencesChange({ fontFamily: "Georgia" })}
          >
            <strong>Aa</strong>
            <span>Bookery</span>
          </button>
          <button
            type="button"
            className={preferences.fontFamily === "Inter, Arial, sans-serif" ? "is-active" : ""}
            onClick={() => onPreferencesChange({ fontFamily: "Inter, Arial, sans-serif" })}
          >
            <strong>Aa</strong>
            <span>Amazon Ember</span>
          </button>
          <button
            type="button"
            className={
              preferences.fontFamily.includes("OpenDyslexic") ||
              preferences.fontFamily === "Atkinson Hyperlegible, Arial, sans-serif"
                ? "is-active"
                : ""
            }
            onClick={() =>
              onPreferencesChange({
                fontFamily: "OpenDyslexic, Atkinson Hyperlegible, Arial, sans-serif"
              })
            }
          >
            <strong>Aa</strong>
            <span>OpenDyslexic</span>
          </button>
        </div>
        <label className="font-size-slider">
          <span>A</span>
          <input
            type="range"
            min="80"
            max="180"
            step="5"
            value={preferences.fontSize}
            onChange={(event) => onPreferencesChange({ fontSize: Number(event.target.value) })}
          />
          <strong>A</strong>
        </label>
      </section>

      <section className="display-settings-section">
        <h3>Page Color</h3>
        <div className="page-color-row" aria-label="Page color">
          <button
            type="button"
            className={`page-swatch is-light ${preferences.theme === "paper" || preferences.theme === "white" ? "is-active" : ""}`}
            title="Light mode"
            onClick={() => onPreferencesChange({ theme: "paper" })}
          />
          <button
            type="button"
            className={`page-swatch is-dark ${preferences.theme === "night" ? "is-active" : ""}`}
            title="Dark mode"
            onClick={() => onPreferencesChange({ theme: "night" })}
          />
          <button
            type="button"
            className={`page-swatch is-contrast ${preferences.theme === "contrast" ? "is-active" : ""}`}
            title="High contrast mode"
            onClick={() => onPreferencesChange({ theme: "contrast" })}
          />
        </div>
        <label className="system-theme-option">
          <input type="checkbox" disabled />
          <span>Update page using system theme</span>
        </label>
      </section>

      <section className="display-settings-section">
        <h3>Layout</h3>
        <div className="display-button-row is-tiles" aria-label="Page layout">
          <button type="button" className={preferences.pageLayout === "spread" ? "is-active" : ""} onClick={() => onPreferencesChange({ pageLayout: "spread" })}>
            <Columns2 size={25} />
            <span>Two Columns</span>
          </button>
          <button type="button" className={preferences.pageLayout === "single" ? "is-active" : ""} onClick={() => onPreferencesChange({ pageLayout: "single" })}>
            <BookOpen size={25} />
            <span>Single Column</span>
          </button>
        </div>
      </section>

      <section className="display-settings-section">
        <h3>Margin</h3>
        <div className="display-button-row is-tiles" aria-label="Margin">
          {(["narrow", "medium", "wide"] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={preferences.margin === value ? "is-active" : ""}
              onClick={() => onPreferencesChange({ margin: value })}
            >
              <Rows3 size={25} />
              <span>{capitalize(value)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="display-settings-section">
        <h3>Reading Progress</h3>
        <p>Choose how to display your progress while reading</p>
        <button type="button" className="progress-toggle-row" onClick={() => updateProgressDisplay("chapterTime")}>
          <span>Time left in chapter</span>
          {progressDisplay.chapterTime ? <CheckMark /> : null}
        </button>
        <button type="button" className="progress-toggle-row" onClick={() => updateProgressDisplay("pageInBook")}>
          <span>Page in book</span>
          {progressDisplay.pageInBook ? <CheckMark /> : null}
        </button>
        <button type="button" className="progress-toggle-row" onClick={() => updateProgressDisplay("bookTime")}>
          <span>Time left in book</span>
          {progressDisplay.bookTime ? <CheckMark /> : null}
        </button>
      </section>
    </div>
  );
}

function CheckMark() {
  return (
    <span className="settings-check" aria-hidden="true">
      <Check size={17} strokeWidth={2.4} />
    </span>
  );
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

async function toggleReaderFullscreen(node: HTMLElement | null) {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await (node || document.documentElement).requestFullscreen();
}

function ReaderProgressStrip({
  book,
  preferences,
  progress
}: {
  book: Book;
  preferences: ReaderPreferences;
  progress: ProgressState | null;
}) {
  const percent = progress?.percent || book.progress?.percent || 0;
  const progressDisplay = preferences.progressDisplay || DEFAULT_PREFERENCES.progressDisplay;
  const locationText = `${formatReadingLocation(book, progress, percent)} - ${formatPercent(percent)}`;
  const timeLeftText = formatReadingTimeLeft(book, progress, percent);

  return (
    <div className="kindle-progress-strip">
      <div className="kindle-progress-track" aria-hidden="true">
        <span style={{ width: `${Math.round(clamp(percent, 0, 1) * 100)}%` }} />
      </div>
      <div className="kindle-progress-meta">
        <span>{progressDisplay.chapterTime ? "Learning chapter timing..." : ""}</span>
        <span>{progressDisplay.pageInBook ? locationText : formatPercent(percent)}</span>
        <span>{progressDisplay.bookTime ? timeLeftText : `${formatPercent(percent)} read`}</span>
      </div>
    </div>
  );
}

function ThemeControls({
  preferences,
  compact = false,
  onPreferencesChange
}: {
  preferences: ReaderPreferences;
  compact?: boolean;
  onPreferencesChange: (patch: Partial<ReaderPreferences>) => void;
}) {
  return (
    <div className={`tool-group compact theme-toggle-group ${compact ? "is-header" : ""}`} aria-label="Display theme">
      <button
        type="button"
        className={`icon-button ${preferences.theme === "paper" || preferences.theme === "white" ? "is-active" : ""}`}
        title="Light mode"
        onClick={() => onPreferencesChange({ theme: "paper" })}
      >
        <Sun size={17} />
      </button>
      <button
        type="button"
        className={`icon-button ${preferences.theme === "night" ? "is-active" : ""}`}
        title="Dark mode"
        onClick={() => onPreferencesChange({ theme: "night" })}
      >
        <Moon size={17} />
      </button>
      <button
        type="button"
        className={`icon-button ${preferences.theme === "contrast" ? "is-active" : ""}`}
        title="High contrast mode"
        onClick={() => onPreferencesChange({ theme: "contrast" })}
      >
        <Contrast size={17} />
      </button>
    </div>
  );
}

interface EpubReaderProps {
  fileUrl: string;
  preferences: ReaderPreferences;
  progress: ProgressState | null;
  highlights: Highlight[];
  jumpTarget: JumpTarget | null;
  searchTerm: string;
  onProgress: (progress: ProgressState) => void;
  onLookup: (selection: SelectionState) => void;
  onReaderInteraction: (intent: ReaderChromeIntent) => void;
  onTocChange: (items: ReaderTocItem[]) => void;
  onSearchResults: (items: ReaderSearchResult[]) => void;
}

function EpubReader({
  fileUrl,
  preferences,
  progress,
  highlights: _highlights,
  jumpTarget,
  searchTerm,
  onProgress,
  onLookup,
  onReaderInteraction,
  onTocChange,
  onSearchResults
}: EpubReaderProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const [sections, setSections] = useState<EpubSection[]>([]);
  const [zip, setZip] = useState<JSZip | null>(null);
  const [sectionIndex, setSectionIndex] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [sectionPageCount, setSectionPageCount] = useState(1);
  const [visiblePageCount, setVisiblePageCount] = useState(1);
  const [srcDoc, setSrcDoc] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pendingPageIndexRef = useRef<number | "last" | null>(null);
  const pageIndexRef = useRef(0);
  const sectionPageCountRef = useRef(1);
  const visiblePageCountRef = useRef(1);

  useEffect(() => {
    pageIndexRef.current = pageIndex;
    sectionPageCountRef.current = sectionPageCount;
    visiblePageCountRef.current = visiblePageCount;
  }, [pageIndex, sectionPageCount, visiblePageCount]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setSrcDoc("");
    revokeObjectUrls(objectUrlsRef);

    void loadEpub(fileUrl)
      .then((loaded) => {
        if (cancelled) {
          return;
        }
        const initialLocation = epubLocationFromLocator(progress?.locator, loaded.sections.length);
        setZip(loaded.zip);
        setSections(loaded.sections);
        onTocChange(
          loaded.sections.map((section, index) => ({
            id: `epub-toc-${index}`,
            label: section.title || `Section ${index + 1}`,
            locator: epubLocator(index, 0)
          }))
        );
        setSectionIndex(initialLocation.sectionIndex);
        setPageIndex(initialLocation.pageIndex);
        setSectionPageCount(1);
        setVisiblePageCount(1);
        pendingPageIndexRef.current = initialLocation.pageIndex;
        return renderEpubSection(loaded.zip, loaded.sections[initialLocation.sectionIndex], preferences, objectUrlsRef);
      })
      .then((html) => {
        if (!cancelled && html) {
          setSrcDoc(html);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Unable to render EPUB");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      revokeObjectUrls(objectUrlsRef);
    };
  }, [fileUrl]);

  useEffect(() => {
    if (!zip || sections.length === 0) {
      onSearchResults([]);
      return;
    }

    const term = searchTerm.trim().toLowerCase();
    if (term.length < 2) {
      onSearchResults([]);
      return;
    }

    let cancelled = false;
    void searchEpubSections(zip, sections, term).then((results) => {
      if (!cancelled) {
        onSearchResults(results);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [zip, sections, searchTerm, onSearchResults]);

  useEffect(() => {
    if (!zip || sections.length === 0) {
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSectionPageCount(1);
    setVisiblePageCount(1);
    revokeObjectUrls(objectUrlsRef);

    void renderEpubSection(zip, sections[sectionIndex], preferences, objectUrlsRef)
      .then((html) => {
        if (!cancelled) {
          setSrcDoc(html);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Unable to render EPUB section");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [zip, sections, sectionIndex, preferences]);

  useEffect(() => {
    if (sections.length === 0) {
      return;
    }

    onProgress({
      locator: epubLocator(sectionIndex, pageIndex),
      percent: epubPercent(sectionIndex, pageIndex, sectionPageCount, sections.length)
    });
  }, [sections.length, sectionIndex, pageIndex, sectionPageCount, onProgress]);

  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) {
      return;
    }
    applyEpubPage(doc, pageIndex);
  }, [pageIndex, srcDoc]);

  useEffect(() => {
    const target = epubLocationFromLocator(jumpTarget?.locator, sections.length);
    if (!jumpTarget?.locator) {
      return;
    }
    pendingPageIndexRef.current = target.pageIndex;
    if (target.sectionIndex !== sectionIndex) {
      setSectionIndex(target.sectionIndex);
      setPageIndex(target.pageIndex);
      return;
    }
    if (target.pageIndex !== pageIndex) {
      setPageIndex(target.pageIndex);
    }
  }, [jumpTarget, pageIndex, sectionIndex, sections.length]);

  const goToPreviousPage = useCallback(() => {
    setPageIndex((current) => {
      if (current > 0) {
        return Math.max(0, current - visiblePageCountRef.current);
      }

      if (sectionIndex > 0) {
        pendingPageIndexRef.current = "last";
        setSectionIndex((value) => Math.max(0, value - 1));
      }

      return current;
    });
  }, [sectionIndex]);

  const goToNextPage = useCallback(() => {
    setPageIndex((current) => {
      const nextPage = current + visiblePageCountRef.current;
      if (nextPage < sectionPageCountRef.current) {
        return nextPage;
      }

      if (sectionIndex < sections.length - 1) {
        pendingPageIndexRef.current = 0;
        setSectionIndex((value) => Math.min(sections.length - 1, value + 1));
        return 0;
      }

      return current;
    });
  }, [sectionIndex, sections.length]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      handleReaderNavigationKey(event, goToPreviousPage, goToNextPage, () => onReaderInteraction("hide"));
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goToNextPage, goToPreviousPage, onReaderInteraction]);

  const handleFrameLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    const iframe = iframeRef.current;
    const viewer = iframe?.parentElement;
    if (!doc || !iframe || !viewer) {
      return;
    }

    let selectionTimer: number | null = null;
    let longPressTimer: number | null = null;
    let pointerStart: { x: number; y: number; pointerType: string } | null = null;
    let touchStart: { x: number; y: number } | null = null;
    let lastSwipeAt = 0;

    const updatePagination = () => {
      const frameDoc = iframeRef.current?.contentDocument;
      if (!frameDoc) {
        return;
      }

      const metrics = getEpubPageMetrics(frameDoc);
      if (!metrics) {
        return;
      }

      const pendingPage = pendingPageIndexRef.current;
      pendingPageIndexRef.current = null;
      const desiredPage =
        pendingPage === "last"
          ? metrics.pageCount - 1
          : typeof pendingPage === "number"
            ? pendingPage
            : pageIndexRef.current;
      const nextPage = Math.floor(clamp(desiredPage, 0, metrics.pageCount - 1));

      setSectionPageCount(metrics.pageCount);
      setVisiblePageCount(metrics.visiblePageCount);
      setPageIndex(nextPage);
      applyEpubPage(frameDoc, nextPage);
    };

    window.requestAnimationFrame(updatePagination);
    window.setTimeout(updatePagination, 140);

    const emitLookup = (text: string, rect: DOMRect | undefined) => {
      const trimmed = text.trim();
      const word = firstWord(trimmed);
      if (!word) {
        return;
      }
      const anchor = rect
        ? buildSelectionAnchorFromFrame(
            rect,
            iframe.getBoundingClientRect(),
            viewer.getBoundingClientRect()
          )
        : undefined;
      onLookup({
        text: trimmed,
        word,
        locator: epubLocator(sectionIndex, pageIndexRef.current),
        percent: epubPercent(sectionIndex, pageIndexRef.current, sectionPageCountRef.current, sections.length),
        anchor
      });
    };

    const handleSelection = () => {
      const activeSelection = doc.getSelection?.() || null;
      const text = String(activeSelection?.toString() || "").trim();
      if (!text || !activeSelection || activeSelection.rangeCount === 0) {
        return;
      }
      emitLookup(text, activeSelection.getRangeAt(0).getBoundingClientRect());
    };

    const lookupWordAtPoint = (x: number, y: number) => {
      const picked = selectWordAtPoint(doc, x, y);
      if (!picked) {
        return;
      }
      emitLookup(picked.text, picked.rect);
    };

    const queueSelection = () => {
      if (selectionTimer) {
        window.clearTimeout(selectionTimer);
      }
      selectionTimer = window.setTimeout(handleSelection, 120);
    };

    const clearLongPress = () => {
      if (longPressTimer) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      doc.getSelection?.()?.removeAllRanges();
      pointerStart = { x: event.clientX, y: event.clientY, pointerType: event.pointerType };
      clearLongPress();
      onReaderInteraction("hide");

      if (event.pointerType === "touch" || event.pointerType === "pen") {
        longPressTimer = window.setTimeout(() => {
          lookupWordAtPoint(event.clientX, event.clientY);
        }, 520);
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!pointerStart) {
        return;
      }
      const distance = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
      if (distance > 10) {
        clearLongPress();
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      clearLongPress();
      if (!pointerStart) {
        return;
      }

      const start = pointerStart;
      pointerStart = null;
      const frameRect = {
        top: 0,
        left: 0,
        width: doc.documentElement.clientWidth || iframe.clientWidth,
        height: doc.documentElement.clientHeight || iframe.clientHeight
      };

      if (start.pointerType === "touch" || start.pointerType === "pen") {
        if (handleDownwardRevealSwipe(start, event)) {
          lastSwipeAt = Date.now();
          doc.getSelection?.()?.removeAllRanges();
          onReaderInteraction("show");
          event.preventDefault();
          return;
        }

        if (handleSwipe(start, event, goToPreviousPage, goToNextPage)) {
          lastSwipeAt = Date.now();
          doc.getSelection?.()?.removeAllRanges();
          onReaderInteraction("hide");
          return;
        }
      }

      const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (distance < 10) {
        if (isReaderTopRevealTap(event, frameRect)) {
          lastSwipeAt = Date.now();
          onReaderInteraction("show");
          event.preventDefault();
          return;
        }

        if (!String(doc.getSelection?.()?.toString() || "").trim()) {
          const navigated = handleReaderNavigationClick(
            event,
            frameRect,
            goToPreviousPage,
            goToNextPage
          );
          if (navigated) {
            lastSwipeAt = Date.now();
            doc.getSelection?.()?.removeAllRanges();
            onReaderInteraction("hide");
          } else {
            onReaderInteraction("hide");
          }
        }
        return;
      }

      if (start.pointerType !== "mouse") {
        return;
      }

      window.setTimeout(() => {
        if (!String(doc.getSelection?.()?.toString() || "").trim()) {
          lookupWordAtPoint(start.x, start.y);
        }
      }, 80);
    };

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) {
        return;
      }
      touchStart = { x: touch.clientX, y: touch.clientY };
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      const start = touchStart;
      touchStart = null;
      if (Date.now() - lastSwipeAt <= 160) {
        event.preventDefault();
        return;
      }
      if (touch && start && Date.now() - lastSwipeAt > 350) {
        if (handleDownwardRevealSwipe(start, touch)) {
          lastSwipeAt = Date.now();
          doc.getSelection?.()?.removeAllRanges();
          onReaderInteraction("show");
          event.preventDefault();
          return;
        }

        if (handleSwipe(start, touch, goToPreviousPage, goToNextPage)) {
          lastSwipeAt = Date.now();
          doc.getSelection?.()?.removeAllRanges();
          onReaderInteraction("hide");
          event.preventDefault();
          return;
        }
      }
      handleSelection();
      onReaderInteraction("hide");
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      handleReaderNavigationKey(event, goToPreviousPage, goToNextPage, () => onReaderInteraction("hide"));
    };

    const handleReaderClick = (event: MouseEvent) => {
      const frameRect = {
        top: 0,
        height: doc.documentElement.clientHeight || iframe.clientHeight
      };
      onReaderInteraction(isReaderTopRevealTap(event, frameRect) ? "show" : "hide");
    };

    doc.addEventListener("mouseup", handleSelection);
    doc.addEventListener("click", handleReaderClick);
    doc.addEventListener("touchstart", handleTouchStart, { passive: true });
    doc.addEventListener("touchend", handleTouchEnd, { passive: false });
    doc.addEventListener("selectionchange", queueSelection);
    doc.addEventListener("pointerdown", handlePointerDown);
    doc.addEventListener("pointermove", handlePointerMove);
    doc.addEventListener("pointerup", handlePointerUp);
    doc.addEventListener("pointercancel", clearLongPress);
    doc.addEventListener("keydown", handleKeyDown);
  };

  return (
    <div className="epub-reader">
      {loading ? (
        <div className="epub-loading">
          <Loader2 className="spin" size={24} />
        </div>
      ) : null}
      {error ? <div className="epub-error">{error}</div> : null}
      <iframe
        ref={iframeRef}
        className="epub-section-frame"
        title="EPUB reader"
        srcDoc={srcDoc}
        onLoad={handleFrameLoad}
      />
    </div>
  );
}

interface EpubSection {
  href: string;
  mediaType: string;
  title: string;
}

async function loadEpub(fileUrl: string): Promise<{ zip: JSZip; sections: EpubSection[] }> {
  const response = await fetch(fileUrl, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`Unable to load EPUB (${response.status})`);
  }

  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const containerXml = await zipFileText(zip, "META-INF/container.xml");
  const containerDoc = parseXml(containerXml);
  const opfPath = containerDoc.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) {
    throw new Error("EPUB container does not declare a package file");
  }

  const opfXml = await zipFileText(zip, opfPath);
  const opfDoc = parseXml(opfXml);
  const basePath = directoryName(opfPath);
  const manifest = new Map<string, EpubSection>();

  for (const item of Array.from(opfDoc.querySelectorAll("manifest item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) {
      continue;
    }
    manifest.set(id, {
      href: resolveZipPath(basePath, href),
      mediaType: item.getAttribute("media-type") || "",
      title: item.getAttribute("id") || ""
    });
  }

  const sections = Array.from(opfDoc.querySelectorAll("spine itemref"))
    .map((itemref) => manifest.get(itemref.getAttribute("idref") || ""))
    .filter((section): section is EpubSection =>
      Boolean(section && /xhtml|html/i.test(section.mediaType || section.href))
    );

  if (sections.length === 0) {
    throw new Error("EPUB spine has no readable XHTML sections");
  }

  const titledSections = await Promise.all(
    sections.map(async (section, index) => ({
      ...section,
      title: await getEpubSectionTitle(zip, section, index)
    }))
  );

  return { zip, sections: titledSections };
}

async function renderEpubSection(
  zip: JSZip,
  section: EpubSection,
  preferences: ReaderPreferences,
  objectUrlsRef: React.MutableRefObject<string[]>
) {
  const raw = await zipFileText(zip, section.href);
  const doc = parseXml(raw);
  const sectionBase = directoryName(section.href);

  for (const image of Array.from(doc.querySelectorAll("img[src], image[href], image[*|href]"))) {
    const attr = image.getAttribute("src") ? "src" : image.getAttribute("href") ? "href" : "xlink:href";
    const value = image.getAttribute(attr);
    if (!value || value.startsWith("data:") || value.startsWith("http")) {
      continue;
    }
    const file = zip.file(resolveZipPath(sectionBase, value.split("#")[0]));
    if (!file) {
      continue;
    }
    const blob = await file.async("blob");
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.push(url);
    image.setAttribute(attr, url);
  }

  const title = doc.querySelector("title")?.textContent || "";
  const body = doc.querySelector("body");
  const colors = themeColors(preferences.theme);
  const scheme = preferences.theme === "paper" || preferences.theme === "white" ? "light" : "dark";
  const linkColor =
    preferences.theme === "contrast" ? "#00ffff" : preferences.theme === "night" ? "#f48fb1" : "#c2185b";
  const margins = readerMarginValues(preferences.margin);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: ${scheme}; }
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: ${colors.surface};
      }
      body {
        box-sizing: border-box;
        color: ${colors.text};
        font-family: ${preferences.fontFamily};
        font-size: ${preferences.fontSize}%;
        line-height: ${preferences.lineHeight};
        text-align: ${preferences.alignment};
      }
      * { box-sizing: border-box; }
      #epub-flow {
        --page-gap: 76px;
        --page-width: calc(100vw - ${margins.horizontal * 2}px);
        width: var(--page-width);
        height: calc(100vh - 114px);
        margin: 42px ${margins.horizontal}px 72px;
        overflow: visible;
        column-width: var(--page-width);
        column-gap: var(--page-gap);
        transform: translateX(calc(var(--epub-page-offset, 0px) * -1));
        transition: transform 120ms ease-out;
      }
      #epub-flow[data-layout="spread"] {
        --page-gap: 42px;
        --page-width: calc((100vw - ${margins.spreadHorizontal * 2}px - var(--page-gap)) / 2);
        width: calc(var(--page-width) + var(--page-width) + var(--page-gap));
        margin: 42px ${margins.spreadHorizontal}px 72px;
      }
      #epub-flow > * {
        max-width: 72ch;
        margin-left: auto;
        margin-right: auto;
      }
      p { line-height: ${preferences.lineHeight}; text-align: ${preferences.alignment}; }
      img, svg { max-width: 100%; max-height: 100%; height: auto; }
      a { color: ${linkColor}; }
      ::selection { background: #f2b84b; color: #000000; }
      @media (max-width: 720px) {
        #epub-flow {
          --page-gap: 36px;
          --page-width: calc(100vw - ${margins.mobile * 2}px);
          width: calc(100vw - ${margins.mobile * 2}px);
          height: calc(100vh - 64px);
          margin: 24px ${margins.mobile}px 40px;
          column-width: var(--page-width);
          column-gap: var(--page-gap);
        }
        #epub-flow[data-layout="spread"] {
          --page-gap: 36px;
          --page-width: calc(100vw - ${margins.mobile * 2}px);
          width: var(--page-width);
          margin: 24px ${margins.mobile}px 40px;
          column-width: var(--page-width);
          column-gap: var(--page-gap);
        }
      }
    </style>
  </head>
  <body><main id="epub-flow" data-layout="${preferences.pageLayout}">${body?.innerHTML || ""}</main></body>
</html>`;
}

async function getEpubSectionTitle(zip: JSZip, section: EpubSection, index: number) {
  try {
    const raw = await zipFileText(zip, section.href);
    const doc = parseXml(raw);
    return (
      cleanText(
        doc.querySelector("h1, h2, h3, title")?.textContent ||
          section.href.split("/").pop()?.replace(/\.[^.]+$/, "") ||
          ""
      ) || `Section ${index + 1}`
    );
  } catch {
    return `Section ${index + 1}`;
  }
}

async function searchEpubSections(zip: JSZip, sections: EpubSection[], term: string) {
  const results: ReaderSearchResult[] = [];
  for (let index = 0; index < sections.length && results.length < 30; index += 1) {
    const section = sections[index];
    try {
      const raw = await zipFileText(zip, section.href);
      const text = cleanText(parseXml(raw).body?.textContent || "");
      const matchIndex = text.toLowerCase().indexOf(term);
      if (matchIndex < 0) {
        continue;
      }
      results.push({
        id: `epub-search-${index}-${matchIndex}`,
        label: section.title || `Section ${index + 1}`,
        excerpt: excerptAround(text, matchIndex, term.length),
        locator: epubLocator(index, 0)
      });
    } catch {
      // Skip unreadable sections but keep searching the rest of the book.
    }
  }
  return results;
}

async function zipFileText(zip: JSZip, path: string) {
  const file = zip.file(path);
  if (!file) {
    throw new Error(`EPUB file not found: ${path}`);
  }
  return file.async("text");
}

function parseXml(value: string) {
  const xmlDoc = new DOMParser().parseFromString(value, "application/xhtml+xml");
  if (!xmlDoc.querySelector("parsererror")) {
    return xmlDoc;
  }
  return new DOMParser().parseFromString(value, "text/html");
}

function directoryName(value: string) {
  const parts = value.split("/");
  parts.pop();
  return parts.join("/");
}

function resolveZipPath(base: string, href: string) {
  const stack = base ? base.split("/") : [];
  for (const part of href.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join("/");
}

function epubLocationFromLocator(locator: string | null | undefined, sectionCount: number) {
  const match = /^section:(\d+)(?::page:(\d+))?$/.exec(locator || "");
  if (!match || sectionCount <= 0) {
    return { sectionIndex: 0, pageIndex: 0 };
  }
  return {
    sectionIndex: Math.min(sectionCount - 1, Math.max(0, Number(match[1]))),
    pageIndex: Math.max(0, Number(match[2] || 0))
  };
}

function epubLocator(sectionIndex: number, pageIndex: number) {
  return `section:${sectionIndex}:page:${pageIndex}`;
}

function epubPercent(
  sectionIndex: number,
  pageIndex: number,
  sectionPageCount: number,
  sectionCount: number
) {
  if (sectionCount <= 0) {
    return 0;
  }

  const pagePortion = sectionPageCount > 0 ? pageIndex / sectionPageCount : 0;
  return clamp((sectionIndex + pagePortion) / sectionCount, 0, 1);
}

function getEpubPageMetrics(doc: Document) {
  const flow = doc.getElementById("epub-flow") as HTMLElement | null;
  if (!flow) {
    return null;
  }

  const styles = doc.defaultView?.getComputedStyle(flow);
  const columnGap = Number.parseFloat(styles?.columnGap || "0") || 0;
  const flowWidth = flow.getBoundingClientRect().width;
  const computedColumnWidth = Number.parseFloat(styles?.columnWidth || "");
  const pageWidth = Number.isFinite(computedColumnWidth) && computedColumnWidth > 0
    ? computedColumnWidth
    : flowWidth;
  const pageStep = Math.max(1, pageWidth + columnGap);
  const visiblePageCount = Math.max(1, Math.round((flowWidth + columnGap) / pageStep));
  const pageCount = Math.max(1, Math.ceil((flow.scrollWidth + columnGap) / pageStep));

  return { flow, pageCount, pageStep, visiblePageCount };
}

function applyEpubPage(doc: Document, pageIndex: number) {
  const metrics = getEpubPageMetrics(doc);
  if (!metrics) {
    return;
  }

  metrics.flow.style.setProperty("--epub-page-offset", `${pageIndex * metrics.pageStep}px`);
}

function revokeObjectUrls(objectUrlsRef: React.MutableRefObject<string[]>) {
  for (const url of objectUrlsRef.current) {
    URL.revokeObjectURL(url);
  }
  objectUrlsRef.current = [];
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface PdfReaderProps {
  fileUrl: string;
  preferences: ReaderPreferences;
  progress: ProgressState | null;
  jumpTarget: JumpTarget | null;
  searchTerm: string;
  onProgress: (progress: ProgressState) => void;
  onLookup: (selection: SelectionState) => void;
  onReaderInteraction: (intent: ReaderChromeIntent) => void;
  onTocChange: (items: ReaderTocItem[]) => void;
  onSearchResults: (items: ReaderSearchResult[]) => void;
}

function PdfReader({
  fileUrl,
  preferences,
  progress,
  jumpTarget,
  searchTerm,
  onProgress,
  onLookup,
  onReaderInteraction,
  onTocChange,
  onSearchResults
}: PdfReaderProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pointerStartRef = useRef<{ x: number; y: number; pointerType: string } | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastSwipeAtRef = useRef(0);
  const longPressTimerRef = useRef<number | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(progress?.page || 1);
  const [readerSize, setReaderSize] = useState({ width: 720, height: 900 });

  const pagesPerView =
    preferences.pageLayout === "spread" && readerSize.width > readerSize.height && readerSize.width >= 760
      ? 2
      : 1;
  const pdfMarginOffset = readerMarginValues(preferences.margin).pdfOffset;
  const pdfPageWidth =
    pagesPerView === 2
      ? Math.max(260, Math.min(620, (readerSize.width - pdfMarginOffset - 40) / 2))
      : Math.max(280, Math.min(900, readerSize.width - pdfMarginOffset));

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      setReaderSize({
        width: Math.max(320, entry.contentRect.width),
        height: Math.max(320, entry.contentRect.height)
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (jumpTarget?.page) {
      setPage(jumpTarget.page);
    }
  }, [jumpTarget]);

  useEffect(() => {
    if (!numPages) {
      onTocChange([]);
      return;
    }
    onTocChange(
      Array.from({ length: numPages }, (_, index) => ({
        id: `pdf-page-${index + 1}`,
        label: `Page ${index + 1}`,
        page: index + 1
      }))
    );
  }, [numPages, onTocChange]);

  useEffect(() => {
    const term = searchTerm.trim().toLowerCase();
    if (term.length < 2) {
      onSearchResults([]);
      return;
    }

    let cancelled = false;
    void searchPdfDocument(fileUrl, term).then((results) => {
      if (!cancelled) {
        onSearchResults(results);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fileUrl, searchTerm, onSearchResults]);

  useEffect(() => {
    if (!numPages) {
      return;
    }
    const safePage = Math.min(numPages, Math.max(1, page));
    if (safePage !== page) {
      setPage(safePage);
      return;
    }
    onProgress({
      page,
      totalPages: numPages,
      percent: page / numPages
    });
  }, [numPages, page]);

  const goToPreviousPdfPage = useCallback(() => {
    setPage((value) => Math.max(1, value - pagesPerView));
  }, [pagesPerView]);

  const goToNextPdfPage = useCallback(() => {
    setPage((value) => Math.min(numPages || value + pagesPerView, value + pagesPerView));
  }, [numPages, pagesPerView]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      handleReaderNavigationKey(event, goToPreviousPdfPage, goToNextPdfPage, () => onReaderInteraction("hide"));
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goToNextPdfPage, goToPreviousPdfPage, onReaderInteraction]);

  const emitLookup = useCallback((text: string, rect: DOMRect | undefined) => {
    const trimmed = text.trim();
    const word = firstWord(trimmed);
    if (!word) {
      return;
    }
    const anchor =
      containerRef.current && rect
        ? buildSelectionAnchorFromViewport(rect, containerRef.current.getBoundingClientRect())
        : undefined;
    onLookup({
      text: trimmed,
      word,
      page,
      percent: numPages ? page / numPages : 0,
      anchor
    });
  }, [numPages, onLookup, page]);

  const handleSelection = useCallback(() => {
    const activeSelection = window.getSelection();
    const text = String(activeSelection?.toString() || "").trim();
    if (!text || !activeSelection || activeSelection.rangeCount === 0) {
      return;
    }
    emitLookup(text, activeSelection.getRangeAt(0).getBoundingClientRect());
  }, [emitLookup]);

  const lookupWordAtPoint = useCallback((x: number, y: number) => {
    const picked = selectWordAtPoint(document, x, y);
    if (!picked) {
      return;
    }
    emitLookup(picked.text, picked.rect);
  }, [emitLookup]);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    window.getSelection()?.removeAllRanges();
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType
    };
    clearLongPress();
    onReaderInteraction("hide");

    if (event.pointerType === "touch" || event.pointerType === "pen") {
      const x = event.clientX;
      const y = event.clientY;
      longPressTimerRef.current = window.setTimeout(() => lookupWordAtPoint(x, y), 520);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = pointerStartRef.current;
    if (!start) {
      return;
    }
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance > 10) {
      clearLongPress();
    }
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    clearLongPress();
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start) {
      return;
    }

    const readerRect = containerRef.current?.getBoundingClientRect();

    if (start.pointerType === "touch" || start.pointerType === "pen") {
      if (handleDownwardRevealSwipe(start, event.nativeEvent)) {
        lastSwipeAtRef.current = Date.now();
        window.getSelection()?.removeAllRanges();
        onReaderInteraction("show");
        event.preventDefault();
        return;
      }

      if (handleSwipe(start, event.nativeEvent, goToPreviousPdfPage, goToNextPdfPage)) {
        lastSwipeAtRef.current = Date.now();
        window.getSelection()?.removeAllRanges();
        onReaderInteraction("hide");
        return;
      }
    }

    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance < 10) {
      if (readerRect && isReaderTopRevealTap(event.nativeEvent, readerRect)) {
        lastSwipeAtRef.current = Date.now();
        onReaderInteraction("show");
        event.preventDefault();
        return;
      }

      if (!String(window.getSelection()?.toString() || "").trim() && readerRect) {
        const navigated = handleReaderNavigationClick(
          event.nativeEvent,
          readerRect,
          goToPreviousPdfPage,
          goToNextPdfPage
        );
        if (navigated) {
          lastSwipeAtRef.current = Date.now();
          window.getSelection()?.removeAllRanges();
          onReaderInteraction("hide");
        } else {
          onReaderInteraction("hide");
        }
      }
      return;
    }

    if (start.pointerType !== "mouse") {
      return;
    }

    window.setTimeout(() => {
      if (!String(window.getSelection()?.toString() || "").trim()) {
        lookupWordAtPoint(start.x, start.y);
      }
    }, 80);
  };

  const handlePointerCancel = () => {
    clearLongPress();
    pointerStartRef.current = null;
  };

  const handleMouseUp = () => {
    const activeSelection = window.getSelection();
    const text = String(activeSelection?.toString() || "").trim();
    const word = firstWord(text);
    if (!word) {
      return;
    }
    const anchor =
      containerRef.current && activeSelection && activeSelection.rangeCount > 0
        ? buildSelectionAnchorFromViewport(
            activeSelection.getRangeAt(0).getBoundingClientRect(),
            containerRef.current.getBoundingClientRect()
          )
        : undefined;
    onLookup({
      text,
      word,
      page,
      percent: numPages ? page / numPages : 0,
      anchor
    });
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    if (!touch) {
      return;
    }
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.changedTouches[0];
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (Date.now() - lastSwipeAtRef.current <= 160) {
      event.preventDefault();
      return;
    }
    if (touch && start && Date.now() - lastSwipeAtRef.current > 350) {
      if (handleDownwardRevealSwipe(start, touch)) {
        lastSwipeAtRef.current = Date.now();
        window.getSelection()?.removeAllRanges();
        onReaderInteraction("show");
        event.preventDefault();
        return;
      }

      if (handleSwipe(start, touch, goToPreviousPdfPage, goToNextPdfPage)) {
        lastSwipeAtRef.current = Date.now();
        window.getSelection()?.removeAllRanges();
        onReaderInteraction("hide");
        event.preventDefault();
        return;
      }
    }
    handleSelection();
    onReaderInteraction("hide");
  };

  useEffect(() => {
    let selectionTimer: number | null = null;

    const queueSelection = () => {
      const activeSelection = window.getSelection();
      const node = activeSelection?.anchorNode;
      const element = node instanceof Element ? node : node?.parentElement;
      if (!element || !containerRef.current?.contains(element)) {
        return;
      }
      if (selectionTimer) {
        window.clearTimeout(selectionTimer);
      }
      selectionTimer = window.setTimeout(handleSelection, 120);
    };

    document.addEventListener("selectionchange", queueSelection);
    return () => {
      if (selectionTimer) {
        window.clearTimeout(selectionTimer);
      }
      document.removeEventListener("selectionchange", queueSelection);
    };
  }, [handleSelection]);

  return (
    <div
      className="pdf-reader"
      ref={containerRef}
      onMouseUp={handleMouseUp}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <Document
        file={fileUrl}
        loading={<Loader2 className="spin" size={24} />}
        onLoadSuccess={({ numPages: loadedPages }) => {
          setNumPages(loadedPages);
          if (progress?.page) {
            setPage(Math.min(loadedPages, Math.max(1, progress.page)));
          } else if (progress?.percent) {
            setPage(Math.min(loadedPages, Math.max(1, Math.ceil(progress.percent * loadedPages))));
          }
        }}
      >
        <div className={`pdf-page-spread ${pagesPerView === 2 ? "is-spread" : ""}`}>
          <Page pageNumber={page} width={pdfPageWidth} renderTextLayer renderAnnotationLayer />
          {pagesPerView === 2 && page + 1 <= numPages ? (
            <Page pageNumber={page + 1} width={pdfPageWidth} renderTextLayer renderAnnotationLayer />
          ) : null}
        </div>
      </Document>
    </div>
  );
}

async function searchPdfDocument(fileUrl: string, term: string) {
  const results: ReaderSearchResult[] = [];
  const task = pdfjs.getDocument({ url: fileUrl, withCredentials: true });
  const document = await task.promise;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages && results.length < 30; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = cleanText(
        textContent.items
          .map((item) => ("str" in item ? String(item.str) : ""))
          .join(" ")
      );
      const matchIndex = text.toLowerCase().indexOf(term);
      if (matchIndex < 0) {
        continue;
      }
      results.push({
        id: `pdf-search-${pageNumber}-${matchIndex}`,
        label: `Page ${pageNumber}`,
        excerpt: excerptAround(text, matchIndex, term.length),
        page: pageNumber
      });
    }
  } finally {
    await document.destroy();
  }
  return results;
}

export function ReviewPanel({
  myReview,
  reviews,
  onSave
}: {
  myReview: Review | null;
  reviews: Review[];
  onSave: (rating: number, text: string) => void;
}) {
  const [rating, setRating] = useState(myReview?.rating || 0);
  const [text, setText] = useState(myReview?.text || "");
  const average =
    reviews.length > 0
      ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length
      : 0;

  useEffect(() => {
    setRating(myReview?.rating || 0);
    setText(myReview?.text || "");
  }, [myReview]);

  return (
    <section className="rail-section review-panel">
      <div className="rail-heading">
        <span>Review</span>
        <span>{reviews.length ? `${average.toFixed(1)} avg` : "No ratings"}</span>
      </div>

      <div className="rating-row" aria-label="Rating">
        <button
          type="button"
          className={`zero-rating ${rating === 0 ? "is-active" : ""}`}
          onClick={() => setRating(0)}
        >
          0
        </button>
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            className={`star-button ${rating >= value ? "is-active" : ""}`}
            title={`${value} star${value === 1 ? "" : "s"}`}
            onClick={() => setRating(value)}
          >
            <Star size={18} />
          </button>
        ))}
      </div>

      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Write a review"
        rows={4}
      />

      <button type="button" className="secondary-button" onClick={() => onSave(rating, text)}>
        <Star size={16} />
        Save review
      </button>

      <div className="review-list">
        {reviews.map((review) => (
          <article key={review.id} className="review-item">
            <div>
              <strong>{review.user?.displayName || review.user?.username || "Reader"}</strong>
              <span>{review.rating}/5</span>
            </div>
            {review.text ? <p>{review.text}</p> : <p className="muted">No written review.</p>}
          </article>
        ))}
      </div>
    </section>
  );
}

function SelectionLookupPopover({
  selection,
  dictionary,
  loading,
  onHighlight,
  onDismiss
}: {
  selection: SelectionState | null;
  dictionary: DictionaryResult | null;
  loading: boolean;
  onHighlight: () => void;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [selection?.text]);

  if (!selection) {
    return null;
  }

  const anchor = selection.anchor;
  const popoverStyle = anchor
    ? getSelectionPopoverStyle(anchor)
    : undefined;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(selection.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section
      className="selection-popover"
      style={popoverStyle}
      role="dialog"
      aria-label={`Definition for ${selection.word}`}
    >
      <div className="selection-action-bar">
        <button type="button" className="selection-action" onClick={onHighlight}>
          <span className="selection-color-dot" />
          <span>Highlight</span>
        </button>
        <button type="button" className="selection-action" onClick={() => void handleCopy()}>
          <Copy size={19} />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
        <button type="button" className="selection-close" title="Close definition" onClick={onDismiss}>
          <X size={20} />
        </button>
      </div>

      <div className="definition-card">
        <div className="definition-card-heading">
          <div className="selected-word">
            <strong>{selection.word}</strong>
            {dictionary?.phonetic ? <span>{dictionary.phonetic}</span> : null}
          </div>
          <span>Definition</span>
        </div>

        {loading ? <Loader2 className="spin" size={16} /> : null}

        <div className="definition-list">
          {loading ? <p className="muted">Looking up definition...</p> : null}
          {!loading && dictionary?.definitions.length ? (
            dictionary.definitions.slice(0, 3).map((item, index) => (
              <article key={`${item.partOfSpeech}-${index}`} className="definition-item">
                <span>{item.partOfSpeech}</span>
                <p>{item.definition}</p>
                {item.example ? <em>{item.example}</em> : null}
              </article>
            ))
          ) : null}
          {!loading && !dictionary?.definitions.length ? (
            <p className="muted">{dictionary?.message || "No definition found."}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AnnotationPanel({
  bookmarks,
  highlights,
  onJump,
  onDeleteBookmark,
  onDeleteHighlight
}: {
  bookmarks: Bookmark[];
  highlights: Highlight[];
  onJump: (target: { locator?: string | null; page?: number | null }) => void;
  onDeleteBookmark: (bookmark: Bookmark) => void;
  onDeleteHighlight: (highlight: Highlight) => void;
}) {
  return (
    <section className="rail-section annotations-panel">
      <div className="rail-heading">
        <span>Marks</span>
        <span>{bookmarks.length + highlights.length}</span>
      </div>

      <div className="annotation-list">
        {bookmarks.map((bookmark) => (
          <article key={bookmark.id} className="annotation-item">
            <button type="button" onClick={() => onJump(bookmark)}>
              <BookMarked size={15} />
              <span>{bookmark.label}</span>
            </button>
            <button type="button" className="ghost-button" title="Delete bookmark" onClick={() => onDeleteBookmark(bookmark)}>
              <Trash2 size={15} />
            </button>
          </article>
        ))}

        {highlights.map((highlight) => (
          <article key={highlight.id} className="annotation-item highlight-item">
            <button type="button" onClick={() => onJump(highlight)}>
              <Highlighter size={15} />
              <span>{highlight.text}</span>
              {highlight.note ? <small className="annotation-note">{highlight.note}</small> : null}
            </button>
            <button type="button" className="ghost-button" title="Delete highlight" onClick={() => onDeleteHighlight(highlight)}>
              <Trash2 size={15} />
            </button>
          </article>
        ))}

        {bookmarks.length + highlights.length === 0 ? <p className="muted">No marks yet.</p> : null}
      </div>
    </section>
  );
}

function selectWordAtPoint(doc: Document, x: number, y: number): { text: string; rect: DOMRect } | null {
  const caret = getCaretAtPoint(doc, x, y);
  if (!caret) {
    return null;
  }

  const resolved = resolveTextNodeAtOffset(caret.node, caret.offset);
  if (!resolved) {
    return null;
  }

  const { textNode } = resolved;
  const value = textNode.data || "";
  let offset = clamp(resolved.offset, 0, value.length);
  if (offset >= value.length && value.length > 0) {
    offset = value.length - 1;
  }
  if (!isWordCharacter(value[offset] || "") && offset > 0 && isWordCharacter(value[offset - 1])) {
    offset -= 1;
  }
  if (!isWordCharacter(value[offset] || "")) {
    return null;
  }

  let start = offset;
  let end = offset + 1;
  while (start > 0 && isWordCharacter(value[start - 1])) {
    start -= 1;
  }
  while (end < value.length && isWordCharacter(value[end])) {
    end += 1;
  }

  let startNode = textNode;
  let startOffset = start;
  while (startOffset === 0) {
    const previous = previousTextNodeInSameBlock(startNode);
    if (!previous || !isWordCharacter(previous.data[previous.data.length - 1] || "")) {
      break;
    }
    startNode = previous;
    startOffset = previous.data.length;
    while (startOffset > 0 && isWordCharacter(startNode.data[startOffset - 1])) {
      startOffset -= 1;
    }
  }

  let endNode = textNode;
  let endOffset = end;
  while (endOffset === endNode.data.length) {
    const next = nextTextNodeInSameBlock(endNode);
    if (!next || !isWordCharacter(next.data[0] || "")) {
      break;
    }
    endNode = next;
    endOffset = 0;
    while (endOffset < endNode.data.length && isWordCharacter(endNode.data[endOffset])) {
      endOffset += 1;
    }
  }

  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = doc.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);

  return {
    text: range.toString(),
    rect: range.getBoundingClientRect()
  };
}

function getCaretAtPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const caretDoc = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = caretDoc.caretPositionFromPoint?.(x, y);
  if (position) {
    return { node: position.offsetNode, offset: position.offset };
  }

  const range = caretDoc.caretRangeFromPoint?.(x, y);
  if (range) {
    return { node: range.startContainer, offset: range.startOffset };
  }

  return null;
}

function resolveTextNodeAtOffset(node: Node, offset: number): { textNode: Text; offset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return { textNode: node as Text, offset };
  }

  const children = Array.from(node.childNodes);
  const next = children[Math.min(offset, children.length - 1)];
  const nextText = next ? firstTextNode(next) : null;
  if (nextText) {
    return { textNode: nextText, offset: 0 };
  }

  const previous = children[Math.max(0, offset - 1)];
  const previousText = previous ? lastTextNode(previous) : null;
  if (previousText) {
    return { textNode: previousText, offset: previousText.data.length };
  }

  return null;
}

function firstTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim()) {
    return node as Text;
  }
  for (const child of Array.from(node.childNodes)) {
    const found = firstTextNode(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function lastTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE && (node.textContent || "").trim()) {
    return node as Text;
  }
  const children = Array.from(node.childNodes);
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const found = lastTextNode(children[index]);
    if (found) {
      return found;
    }
  }
  return null;
}

function previousTextNodeInSameBlock(node: Node): Text | null {
  const block = closestTextBlock(node);
  let current: Node | null = node;
  while (current && current !== block) {
    let sibling = current.previousSibling;
    while (sibling) {
      const found = lastTextNode(sibling);
      if (found && closestTextBlock(found) === block) {
        return found;
      }
      sibling = sibling.previousSibling;
    }
    current = current.parentNode;
  }
  return null;
}

function nextTextNodeInSameBlock(node: Node): Text | null {
  const block = closestTextBlock(node);
  let current: Node | null = node;
  while (current && current !== block) {
    let sibling = current.nextSibling;
    while (sibling) {
      const found = firstTextNode(sibling);
      if (found && closestTextBlock(found) === block) {
        return found;
      }
      sibling = sibling.nextSibling;
    }
    current = current.parentNode;
  }
  return null;
}

function closestTextBlock(node: Node): Element | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest("p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption") || element || null;
}

function isWordCharacter(value: string) {
  return /[A-Za-z'\u2019-]/.test(value);
}

function buildSelectionAnchorFromFrame(
  selectionRect: DOMRect,
  frameRect: DOMRect,
  containerRect: DOMRect
): SelectionAnchor | undefined {
  if (selectionRect.width <= 0 && selectionRect.height <= 0) {
    return undefined;
  }

  return {
    left: frameRect.left - containerRect.left + selectionRect.left,
    top: frameRect.top - containerRect.top + selectionRect.top,
    width: selectionRect.width,
    height: selectionRect.height,
    containerWidth: containerRect.width,
    containerHeight: containerRect.height
  };
}

function buildSelectionAnchorFromViewport(
  selectionRect: DOMRect,
  containerRect: DOMRect
): SelectionAnchor | undefined {
  if (selectionRect.width <= 0 && selectionRect.height <= 0) {
    return undefined;
  }

  return {
    left: selectionRect.left - containerRect.left,
    top: selectionRect.top - containerRect.top,
    width: selectionRect.width,
    height: selectionRect.height,
    containerWidth: containerRect.width,
    containerHeight: containerRect.height
  };
}

function getSelectionPopoverStyle(anchor: SelectionAnchor): React.CSSProperties {
  const width = Math.max(180, Math.min(360, anchor.containerWidth - 24));
  const left = clamp(
    anchor.left + anchor.width / 2 - width / 2,
    12,
    Math.max(12, anchor.containerWidth - width - 12)
  );
  const below = anchor.top + anchor.height + 12;
  const estimatedHeight = 300;
  const top =
    below + estimatedHeight > anchor.containerHeight - 12
      ? Math.max(12, anchor.top - estimatedHeight - 12)
      : below;

  return { left, top, width };
}

function handleSwipe(
  start: { x: number; y: number },
  end: { clientX: number; clientY: number },
  onSwipeRight: () => void,
  onSwipeLeft: () => void
) {
  const deltaX = end.clientX - start.x;
  const deltaY = end.clientY - start.y;
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  if (absX < 48 || absX < absY * 1.35) {
    return false;
  }

  if (deltaX < 0) {
    onSwipeLeft();
  } else {
    onSwipeRight();
  }
  return true;
}

function handleDownwardRevealSwipe(
  start: { x: number; y: number },
  end: { clientX: number; clientY: number }
) {
  const deltaX = end.clientX - start.x;
  const deltaY = end.clientY - start.y;
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  return deltaY > 56 && absY > absX * 1.35;
}

function handleReaderNavigationClick(
  event: MouseEvent | PointerEvent,
  rect: Pick<DOMRect, "left" | "width">,
  onPrevious: () => void,
  onNext: () => void
) {
  const pointerType = "pointerType" in event ? event.pointerType : "mouse";
  const isTouchLikePointer = pointerType === "touch" || pointerType === "pen";
  if (
    event.defaultPrevented ||
    (event.button !== 0 && !isTouchLikePointer) ||
    rect.width <= 0 ||
    isInteractiveReaderTarget(event.target)
  ) {
    return false;
  }

  const x = event.clientX - rect.left;
  if (x < 0 || x > rect.width) {
    return false;
  }

  if (x <= rect.width * 0.25) {
    event.preventDefault();
    onPrevious();
    return true;
  }

  if (x >= rect.width * 0.75) {
    event.preventDefault();
    onNext();
    return true;
  }

  return false;
}

function isReaderTopRevealTap(
  event: MouseEvent | PointerEvent,
  rect: Pick<DOMRect, "top" | "height">
) {
  return (
    !event.defaultPrevented &&
    !isInteractiveReaderTarget(event.target) &&
    isPointInReaderTopRevealZone(event.clientY, rect)
  );
}

function isPointInReaderTopRevealZone(
  clientY: number,
  rect: Pick<DOMRect, "top" | "height">
) {
  if (rect.height <= 0) {
    return false;
  }
  const y = clientY - rect.top;
  const threshold = Math.min(112, Math.max(56, rect.height * 0.12));
  return y >= 0 && y <= threshold;
}

function handleReaderNavigationKey(
  event: KeyboardEvent,
  onPrevious: () => void,
  onNext: () => void,
  onNavigate?: () => void
) {
  if (
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    isEditableKeyboardTarget(event.target)
  ) {
    return;
  }

  if (event.key === "ArrowLeft") {
    event.preventDefault();
    onPrevious();
    onNavigate?.();
    return;
  }

  if (event.key === "ArrowRight") {
    event.preventDefault();
    onNext();
    onNavigate?.();
  }
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  const element = target instanceof Element ? target : null;
  if (!element) {
    return false;
  }

  return Boolean(
    element.closest(
      "input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']"
    )
  );
}

function isInteractiveReaderTarget(target: EventTarget | null) {
  const element = target instanceof Element ? target : null;
  if (!element) {
    return false;
  }

  return Boolean(
    element.closest(
      "a, button, input, textarea, select, summary, [role='button'], [contenteditable='true'], [contenteditable='plaintext-only']"
    )
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function viewTitle(view: MainView) {
  if (view === "ebooks") {
    return "Books";
  }
  if (view === "audiobooks") {
    return "Audiobooks";
  }
  if (view === "profile") {
    return "Profile";
  }
  if (view === "marks") {
    return "Notes & Highlights";
  }
  if (view === "add") {
    return "Add Title";
  }
  if (view === "libby") {
    return "Libby";
  }
  return "Home";
}

function formatProfileHours(seconds: number) {
  const hours = Math.max(0, Number(seconds) || 0) / 3600;
  if (hours === 0) {
    return "0";
  }
  if (hours < 0.1) {
    return "<0.1";
  }
  if (hours >= 100) {
    return Math.round(hours).toLocaleString();
  }
  return hours.toFixed(hours >= 10 ? 1 : 2).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
}

function formatProfileDate(value?: string | null) {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed)) {
    return "Recently";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(parsed).getFullYear() === new Date().getFullYear() ? undefined : "numeric"
  }).format(parsed);
}

export function formatShortDate(value?: string | null) {
  if (!value) return "soon";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "soon";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatReadingLocation(
  book: Book,
  progress: ProgressState | null,
  percent: number
) {
  if (progress?.page && progress.totalPages) {
    return `Page ${progress.page} of ${progress.totalPages}`;
  }

  const totalLocations = estimateTotalLocations(book);
  const location = Math.max(1, Math.round(clamp(percent, 0, 1) * totalLocations));
  return `Location ${location} of ${totalLocations}`;
}

function formatReadingTimeLeft(
  book: Book,
  progress: ProgressState | null,
  percent: number
) {
  if (percent <= 0.003) {
    return "Learning reading speed...";
  }

  const remainingMinutes = estimateRemainingMinutes(book, progress, percent);
  if (remainingMinutes < 60) {
    return `About ${Math.max(1, remainingMinutes)} min left in book`;
  }

  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return minutes > 0
    ? `About ${hours} hr ${minutes} min left in book`
    : `About ${hours} hr left in book`;
}

function estimateRemainingMinutes(book: Book, progress: ProgressState | null, percent: number) {
  if (progress?.page && progress.totalPages) {
    const remainingPages = Math.max(0, progress.totalPages - progress.page);
    return Math.max(1, Math.round(remainingPages * 1.8));
  }

  const totalMinutes = clamp(Math.round(book.size / 3400), 45, 900);
  return Math.max(1, Math.round(totalMinutes * (1 - clamp(percent, 0, 1))));
}

function estimateTotalLocations(book: Book) {
  return Math.max(100, Math.round(book.size / 320));
}

function cleanText(value: string) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function excerptAround(text: string, index: number, matchLength: number) {
  const start = Math.max(0, index - 72);
  const end = Math.min(text.length, index + matchLength + 92);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function matchesLibraryFilter(book: Book, filter: LibraryFilterMode) {
  const percent = book.progress?.percent || 0;
  if (filter === "unread") {
    return percent <= 0;
  }
  if (filter === "reading") {
    return percent > 0 && percent < 0.995;
  }
  if (filter === "finished") {
    return percent >= 0.995;
  }
  if (filter === "needs-action") {
    return ["needs-conversion", "error", "unsupported"].includes(book.status);
  }
  return true;
}

export function isBookRead(book: Book) {
  return (book.progress?.percent || 0) >= 0.995;
}

function compareLibraryBooks(a: Book, b: Book, sort: LibrarySortMode) {
  if (sort === "title") {
    return bookSortTitle(a).localeCompare(bookSortTitle(b), undefined, { sensitivity: "base" });
  }
  if (sort === "author") {
    const byAuthor = (a.author || "").localeCompare(b.author || "", undefined, { sensitivity: "base" });
    return byAuthor || bookSortTitle(a).localeCompare(bookSortTitle(b), undefined, { sensitivity: "base" });
  }
  if (sort === "progress") {
    return (b.progress?.percent || 0) - (a.progress?.percent || 0);
  }
  return latestBookTime(b) - latestBookTime(a);
}

function bookSortTitle(book: Book) {
  return book.sortTitle || book.title;
}

function latestBookTime(book: Book) {
  return Date.parse(book.progress?.updatedAt || book.updatedAt || book.addedAt || "") || 0;
}

function coverVariant(book: Book) {
  const seed = `${book.title}${book.author}${book.id}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 9973;
  }
  return hash % 6;
}

function StatusPill({ book }: { book: Book }) {
  const label = {
    ready: "Ready",
    "needs-conversion": "Prepare",
    converting: "Preparing",
    error: "Error",
    unsupported: "Unsupported"
  }[book.status];

  return <span className={`status-pill status-${book.status}`}>{label}</span>;
}

function firstWord(value: string) {
  const match = String(value || "").match(/[A-Za-z]+(?:['\u2019-][A-Za-z]+)?/);
  return match
    ? match[0]
        .replace(/\u2019/g, "'")
        .replace(/'s$/i, "")
        .toLowerCase()
    : "";
}

export function formatPercent(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function userInitials(user: User) {
  const source = String(user.displayName || user.username || "U").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : source.slice(0, 2)).toUpperCase();
}

function formatActivityDuration(startedAt: string) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 60_000));
  if (elapsedMinutes < 1) {
    return "less than a minute";
  }
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} min`;
  }
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function formatFileSize(size: number) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function themeColors(theme: ReaderPreferences["theme"]) {
  if (theme === "contrast") {
    return { surface: "#000000", text: "#ffffff" };
  }
  if (theme === "night") {
    return { surface: "#151718", text: "#e9ece8" };
  }
  if (theme === "white") {
    return { surface: "#ffffff", text: "#1e2528" };
  }
  return { surface: "#fbf8f0", text: "#1f2728" };
}

function readerMarginValues(margin: ReaderPreferences["margin"]) {
  if (margin === "narrow") {
    return { horizontal: 24, spreadHorizontal: 36, mobile: 14, pdfOffset: 28 };
  }
  if (margin === "wide") {
    return { horizontal: 72, spreadHorizontal: 88, mobile: 24, pdfOffset: 104 };
  }
  return { horizontal: 38, spreadHorizontal: 56, mobile: 18, pdfOffset: 56 };
}
