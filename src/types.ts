export type ReadingFormat = "epub" | "pdf" | "audio";
export type MediaType = "ebook" | "audiobook";
export type BookStatus = "ready" | "needs-conversion" | "converting" | "error" | "unsupported";
export type Alignment = "left" | "center" | "justify";
export type PageLayout = "single" | "spread";
export type ReaderMargin = "narrow" | "medium" | "wide";

export interface ProgressState {
  percent: number;
  locator?: string | null;
  page?: number | null;
  totalPages?: number | null;
  currentTime?: number | null;
  duration?: number | null;
  trackIndex?: number | null;
  trackTime?: number | null;
  updatedAt?: string;
}

export interface EditableBookMetadata {
  title: string;
  subtitle?: string | null;
  series?: string | null;
  author: string;
  sortTitle?: string | null;
  publisher?: string | null;
  publicationDate?: string | null;
  language?: string | null;
  isbnAsin?: string | null;
  description?: string | null;
  pageCount?: number | null;
  categories: string[];
  contributors: string[];
  narrator?: string | null;
}

export interface Book extends EditableBookMetadata {
  id: string;
  serverId?: string;
  libraryIds?: string[];
  filename: string;
  relPath: string;
  ext: string;
  size: number;
  status: BookStatus;
  readingFormat: ReadingFormat | null;
  canConvert: boolean;
  mediaType: MediaType;
  durationSeconds?: number | null;
  trackCount?: number | null;
  coverUrl?: string | null;
  addedAt: string;
  updatedAt: string;
  error: string | null;
  progress: ProgressState | null;
}

export interface ArtworkCandidate {
  id: string;
  coverId: number;
  title: string;
  author: string;
  year: number | null;
  publisher: string;
  thumbnailUrl: string;
  imageUrl: string;
  source: "Open Library";
  sourceUrl: string;
}

export interface AudioTrack {
  index: number;
  title: string;
  filename: string;
  durationSeconds?: number | null;
  fileUrl: string;
}

export interface Bookmark {
  id: string;
  bookId: string;
  userId: string;
  label: string;
  locator?: string | null;
  page?: number | null;
  percent: number;
  createdAt: string;
}

export interface Highlight {
  id: string;
  bookId: string;
  userId: string;
  text: string;
  locator?: string | null;
  page?: number | null;
  note: string;
  color: string;
  percent: number;
  createdAt: string;
}

export interface ReaderPreferences {
  fontSize: number;
  fontFamily: string;
  alignment: Alignment;
  lineHeight: number;
  theme: "paper" | "white" | "night" | "contrast";
  pageLayout: PageLayout;
  margin: ReaderMargin;
  kindleEmail: string;
  progressDisplay: {
    chapterTime: boolean;
    pageInBook: boolean;
    bookTime: boolean;
  };
}

export interface KindleSettings {
  kindleEmail: string;
  deliveryConfigured: boolean;
  senderEmail: string | null;
  maxAttachmentBytes: number;
}

export interface KindleSendResult {
  sent: boolean;
  kindleEmail: string;
  bookId: string;
  sentAt: string;
}

export interface ReaderInfo {
  book: Book;
  fileUrl: string | null;
  format: ReadingFormat | null;
  audioTracks: AudioTrack[];
  progress: ProgressState | null;
  bookmarks: Bookmark[];
  highlights: Highlight[];
  preferences: ReaderPreferences;
  myReview: Review | null;
  reviews: Review[];
}

export interface DictionaryDefinition {
  partOfSpeech: string;
  definition: string;
  example?: string;
}

export interface DictionaryResult {
  word: string;
  source: string;
  phonetic?: string;
  definitions: DictionaryDefinition[];
  message?: string;
}

export interface SelectionAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
  containerWidth: number;
  containerHeight: number;
}

export interface SelectionState {
  text: string;
  word: string;
  locator?: string | null;
  page?: number | null;
  percent: number;
  anchor?: SelectionAnchor;
}

export interface JumpTarget {
  locator?: string | null;
  page?: number | null;
  stamp: number;
}

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
  user: User | null;
  registrationEnabled?: boolean;
  registrationDisabledReason?: string | null;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: "admin" | "reader";
  createdAt?: string;
  updatedAt?: string;
}

export type ServerRole = "owner" | "admin" | "member";
export type ShelfLibraryType = MediaType | "mixed";

export interface PlatformAccount {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShelfLibrary {
  id: string;
  serverId: string;
  name: string;
  mediaType: ShelfLibraryType;
  rootPath: string;
  enabled: boolean;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShelfServer {
  serverId: string;
  name: string;
  publicKey: string;
  ownerAccountId: string | null;
  endpointUrl: string | null;
  endpointVerifiedAt: string | null;
  status: "online" | "offline" | string;
  capabilities: string[];
  claimedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  role: ServerRole;
  libraries: ShelfLibrary[];
}

export interface ServerInvitation {
  id: string;
  serverId: string;
  serverName?: string;
  inviterAccountId: string;
  recipient: string | null;
  role: Exclude<ServerRole, "owner">;
  libraryIds: string[];
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedByAccountId: string | null;
  revokedAt: string | null;
  token?: string;
  invitePath?: string;
}

export interface ServerMember {
  serverId: string;
  accountId: string;
  localUserId: string | null;
  role: ServerRole;
  createdAt: string;
  updatedAt: string;
  account: PlatformAccount;
  libraryIds: string[];
}

export interface PlatformOverview {
  account: PlatformAccount;
  currentServerId: string;
  servers: ShelfServer[];
  pendingInvitations: ServerInvitation[];
  controlPlane: {
    mode: string;
    publicKey: string;
  };
  separation: {
    friendshipsGrantLibraryAccess: false;
    playbackStateScope: "server";
  };
}

export interface PlatformPreferences {
  selectedServerId: string;
  pinnedServerIds: string[];
  pinnedLibraryIds: string[];
  updatedAt: string | null;
}

export interface ConnectionTicket {
  serverId: string;
  endpointUrl: string;
  ticket: string;
  expiresAt: string;
}

export interface ReadingActivity {
  user: User;
  book: Pick<Book, "id" | "title" | "author" | "coverUrl" | "mediaType">;
  percent: number;
  startedAt: string;
  lastSeenAt: string;
}

export interface Review {
  id: string;
  userId: string;
  bookId: string;
  rating: number;
  text: string;
  createdAt: string;
  updatedAt: string;
  user?: User | null;
}

export interface ProfileStats {
  booksRead: number;
  audiobooksListened: number;
  readingSeconds: number;
  listeningSeconds: number;
}

export interface ProfileHistoryItem {
  book: Book;
  progress: ProgressState;
}

export interface ProfileReviewItem {
  book: Book;
  review: Review;
}

export interface ProfileMarkItem {
  book: Book;
  highlight: Highlight;
}

export interface ProfileReadListItem {
  book: Book;
  addedAt: string;
}

export interface ProfileData {
  user: User;
  stats: ProfileStats;
  history: ProfileHistoryItem[];
  reviews: ProfileReviewItem[];
  marks: ProfileMarkItem[];
  readList: ProfileReadListItem[];
}

export interface ProfileUsage {
  readingSeconds: number;
  listeningSeconds: number;
  updatedAt: string | null;
}
