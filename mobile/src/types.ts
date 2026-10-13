export type User = {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'reader';
};

export type Progress = {
  percent: number;
  currentTime?: number | null;
  duration?: number | null;
  trackIndex?: number | null;
  trackTime?: number | null;
  updatedAt?: string;
};

export type Book = {
  id: string;
  serverId?: string;
  libraryIds?: string[];
  title: string;
  subtitle?: string | null;
  author: string;
  narrator?: string | null;
  series?: string | null;
  description?: string | null;
  mediaType: 'ebook' | 'audiobook';
  readingFormat: 'epub' | 'pdf' | 'audio' | null;
  coverUrl?: string | null;
  durationSeconds?: number | null;
  trackCount?: number | null;
  addedAt: string;
  updatedAt: string;
  progress: Progress | null;
};

export type AudioTrack = {
  index: number;
  title: string;
  filename: string;
  durationSeconds?: number | null;
  fileUrl: string;
};

export type Bookmark = {
  id: string;
  bookId: string;
  userId: string;
  label: string;
  locator?: string | null;
  page?: number | null;
  percent: number;
  createdAt: string;
};

export type ReaderInfo = {
  book: Book;
  format: 'epub' | 'pdf' | 'audio' | null;
  fileUrl: string | null;
  audioTracks: AudioTrack[];
  progress: Progress | null;
  bookmarks: Bookmark[];
};

export type Session = {
  serverUrl: string;
  serverId?: string;
  serverName?: string;
  token: string;
  expiresAt?: string;
  user: User;
};

export type ShelfLibrary = {
  id: string;
  name: string;
  mediaType: 'ebook' | 'audiobook' | 'mixed';
  itemCount: number;
};

export type ShelfServer = {
  serverId: string;
  name: string;
  endpointUrl: string | null;
  status: string;
  role: 'owner' | 'admin' | 'member';
  libraries: ShelfLibrary[];
};

export type PlatformOverview = {
  currentServerId: string;
  servers: ShelfServer[];
};
