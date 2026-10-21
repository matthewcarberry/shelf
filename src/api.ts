import type {
  AuthStatus,
  ArtworkCandidate,
  Book,
  Bookmark,
  DictionaryResult,
  EditableBookMetadata,
  Highlight,
  KindleSendResult,
  KindleSettings,
  MediaType,
  ConnectionTicket,
  PlatformOverview,
  PlatformPreferences,
  ProfileData,
  ProfileUsage,
  ProgressState,
  ReaderInfo,
  ReaderPreferences,
  ReadingActivity,
  Review,
  ServerInvitation,
  ServerMember,
  ServerRole,
  ShelfLibrary,
  User
} from "./types";
import {
  clearOfflineLibrary,
  forgetOfflineProgress,
  getOfflineProgress,
  rememberOfflineProgress
} from "./offline";

export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "AuthRequiredError";
  }
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return request("/api/auth/status");
}

export async function login(username: string, password: string): Promise<AuthStatus> {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export async function registerAccount(input: {
  username: string;
  displayName: string;
  email?: string;
  password: string;
  passwordConfirm: string;
  website?: string;
}): Promise<AuthStatus> {
  return request("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", {
    method: "POST"
  });
  await clearOfflineLibrary().catch(() => undefined);
}

export async function listBooks(libraryId = ""): Promise<Book[]> {
  const query = libraryId ? `?libraryId=${encodeURIComponent(libraryId)}` : "";
  const data = await request<{ books: Book[] }>(`/api/books${query}`);
  return data.books;
}

export async function getPlatformOverview(): Promise<PlatformOverview> {
  return request("/api/platform");
}

export async function acceptServerInvitation(token: string): Promise<PlatformOverview> {
  return request("/api/platform/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ token })
  });
}

export async function claimServer(endpointUrl: string, claimCode: string): Promise<PlatformOverview> {
  return request("/api/platform/servers/claim", {
    method: "POST",
    body: JSON.stringify({ endpointUrl, claimCode })
  });
}

export async function createServerClaimCode(): Promise<{code: string; expiresAt: string}> {
  return request("/api/platform/claim-code");
}

export async function getConnectionTicket(serverId: string): Promise<ConnectionTicket> {
  return request(`/api/platform/servers/${serverId}/ticket`);
}

export async function getPlatformPreferences(): Promise<PlatformPreferences> {
  const data = await request<{ preferences: PlatformPreferences }>("/api/platform/preferences");
  return data.preferences;
}

export async function savePlatformPreferences(
  patch: Partial<PlatformPreferences>
): Promise<PlatformPreferences> {
  const data = await request<{ preferences: PlatformPreferences }>("/api/platform/preferences", {
    method: "PUT",
    body: JSON.stringify(patch)
  });
  return data.preferences;
}

export async function listServerMembers(): Promise<ServerMember[]> {
  const data = await request<{ members: ServerMember[] }>("/api/platform/members");
  return data.members;
}

export async function updateServerMember(
  accountId: string,
  patch: { role?: ServerRole; libraryIds?: string[] }
): Promise<ServerMember> {
  const data = await request<{ member: ServerMember }>(`/api/platform/members/${accountId}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
  return data.member;
}

export async function removeServerMember(accountId: string): Promise<void> {
  await request(`/api/platform/members/${accountId}`, { method: "DELETE" });
}

export async function listServerInvitations(): Promise<ServerInvitation[]> {
  const data = await request<{ invitations: ServerInvitation[] }>("/api/platform/invitations");
  return data.invitations;
}

export async function createServerInvitation(input: {
  recipient?: string;
  role: Exclude<ServerRole, "owner">;
  libraryIds: string[];
}): Promise<ServerInvitation> {
  const data = await request<{ invitation: ServerInvitation }>("/api/platform/invitations", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.invitation;
}

export async function revokeServerInvitation(invitationId: string): Promise<void> {
  await request(`/api/platform/invitations/${invitationId}`, { method: "DELETE" });
}

export async function createLibrary(input: {
  name: string;
  mediaType: ShelfLibrary["mediaType"];
  rootPath?: string;
}): Promise<ShelfLibrary> {
  const data = await request<{ library: ShelfLibrary }>("/api/libraries", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.library;
}

export async function updateLibrary(
  libraryId: string,
  patch: Partial<Pick<ShelfLibrary, "name" | "mediaType" | "rootPath">>
): Promise<ShelfLibrary> {
  const data = await request<{ library: ShelfLibrary }>(`/api/libraries/${libraryId}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
  return data.library;
}

export async function deleteLibrary(libraryId: string): Promise<void> {
  await request(`/api/libraries/${libraryId}`, { method: "DELETE" });
}

export async function updateServerEndpoint(endpointUrl: string): Promise<PlatformOverview> {
  return request("/api/platform/server", {
    method: "PATCH",
    body: JSON.stringify({ endpointUrl })
  });
}

export async function scanLibrary(): Promise<Book[]> {
  const data = await request<{ books: Book[] }>("/api/library/scan", {
    method: "POST"
  });
  return data.books;
}

export type LibraryScanSettings = {
  autoScan: boolean;
  partialScan: boolean;
  periodicScan: boolean;
  scanIntervalMinutes: number;
};

export type LibraryScanState = {
  settings: LibraryScanSettings;
  watcher: { watching: boolean; error: string | null };
};

export async function getLibraryScanSettings(): Promise<LibraryScanState> {
  return request("/api/library/scan-settings");
}

export async function updateLibraryScanSettings(patch: Partial<LibraryScanSettings>): Promise<LibraryScanState> {
  return request("/api/library/scan-settings", {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
}

export async function uploadBooks(files: File[]): Promise<{ books: Book[]; rejected: string[]; duplicates: string[] }> {
  const form = new FormData();
  for (const file of files) {
    form.append("books", file);
  }

  return request("/api/books/upload", {
    method: "POST",
    body: form
  });
}

export async function getReaderInfo(bookId: string): Promise<ReaderInfo> {
  const info = await request<ReaderInfo>(`/api/books/${bookId}/reader`);
  const offlineProgress = getOfflineProgress(bookId);
  if (!offlineProgress) {
    return info;
  }

  const serverTime = Date.parse(info.progress?.updatedAt || "") || 0;
  const offlineTime = Date.parse(offlineProgress.updatedAt || "") || 0;
  if (serverTime > offlineTime) {
    forgetOfflineProgress(bookId);
    return info;
  }

  let resolvedProgress = offlineProgress;
  try {
    const synced = await request<{ progress: ProgressState }>(`/api/books/${bookId}/progress`, {
      method: "PUT",
      body: JSON.stringify(offlineProgress)
    });
    resolvedProgress = synced.progress;
    forgetOfflineProgress(bookId);
  } catch {
    // The locally stored position remains authoritative until connectivity returns.
  }

  return {
    ...info,
    progress: resolvedProgress,
    book: { ...info.book, progress: resolvedProgress }
  };
}

export async function convertBook(bookId: string): Promise<Book> {
  const data = await request<{ book: Book }>(`/api/books/${bookId}/convert`, {
    method: "POST"
  });
  return data.book;
}

export async function updateBookMetadata(
  bookId: string,
  metadata: EditableBookMetadata
): Promise<Book> {
  const data = await request<{ book: Book }>(`/api/books/${bookId}`, {
    method: "PATCH",
    body: JSON.stringify(metadata)
  });
  return data.book;
}

export async function updateBookCover(bookId: string, cover: File): Promise<Book> {
  const form = new FormData();
  form.append("cover", cover);
  const data = await request<{ book: Book }>(`/api/books/${bookId}/cover`, {
    method: "PUT",
    body: form
  });
  return data.book;
}

export async function searchBookArtwork(
  bookId: string,
  title: string,
  author: string
): Promise<ArtworkCandidate[]> {
  const query = new URLSearchParams({ title, author });
  const data = await request<{ artwork: ArtworkCandidate[] }>(
    `/api/books/${bookId}/artwork?${query.toString()}`
  );
  return data.artwork;
}

export async function applyBookArtwork(bookId: string, coverId: number): Promise<Book> {
  const data = await request<{ book: Book }>(`/api/books/${bookId}/artwork`, {
    method: "POST",
    body: JSON.stringify({ coverId })
  });
  return data.book;
}

export async function applyBookArtworkUrl(bookId: string, imageUrl: string): Promise<Book> {
  const data = await request<{ book: Book }>(`/api/books/${bookId}/artwork`, {
    method: "POST",
    body: JSON.stringify({ imageUrl })
  });
  return data.book;
}

export async function deleteBook(bookId: string): Promise<void> {
  await request(`/api/books/${bookId}`, {
    method: "DELETE"
  });
}

export async function getKindleSettings(): Promise<KindleSettings> {
  const data = await request<{ settings: KindleSettings }>("/api/kindle/settings");
  return data.settings;
}

export async function sendBookToKindle(
  bookId: string,
  kindleEmail: string
): Promise<KindleSendResult> {
  return request(`/api/books/${bookId}/send-to-kindle`, {
    method: "POST",
    body: JSON.stringify({ kindleEmail })
  });
}

export type CastLinks = {
  expiresAt: string;
  receiverAppId: string | null;
  title: string;
  author: string | null;
  coverUrl: string | null;
  progressUrl: string;
  tracks: Array<{ index: number; title: string; durationSeconds: number | null; url: string; contentType: string }>;
};

export async function getCastConfig(): Promise<{ receiverAppId: string | null }> {
  return request("/api/cast/config");
}

// Signed 24-hour links a Chromecast can play without Shelf's sign-in cookie.
export async function createCastLinks(bookId: string): Promise<CastLinks> {
  return request(`/api/books/${bookId}/cast`, { method: "POST" });
}

export async function saveProgress(bookId: string, progress: ProgressState): Promise<ProgressState> {
  const localProgress = rememberOfflineProgress(bookId, progress);
  try {
    const data = await request<{ progress: ProgressState }>(`/api/books/${bookId}/progress`, {
      method: "PUT",
      body: JSON.stringify(progress)
    });
    forgetOfflineProgress(bookId);
    return data.progress;
  } catch (error) {
    if (!navigator.onLine || error instanceof TypeError) {
      return localProgress;
    }
    throw error;
  }
}

export async function addBookmark(
  bookId: string,
  bookmark: Partial<Bookmark>
): Promise<Bookmark> {
  const data = await request<{ bookmark: Bookmark }>(`/api/books/${bookId}/bookmarks`, {
    method: "POST",
    body: JSON.stringify(bookmark)
  });
  return data.bookmark;
}

export async function deleteBookmark(bookId: string, bookmarkId: string): Promise<void> {
  await request(`/api/books/${bookId}/bookmarks/${bookmarkId}`, {
    method: "DELETE"
  });
}

export async function addHighlight(
  bookId: string,
  highlight: Partial<Highlight>
): Promise<Highlight> {
  const data = await request<{ highlight: Highlight }>(`/api/books/${bookId}/highlights`, {
    method: "POST",
    body: JSON.stringify(highlight)
  });
  return data.highlight;
}

export async function deleteHighlight(bookId: string, highlightId: string): Promise<void> {
  await request(`/api/books/${bookId}/highlights/${highlightId}`, {
    method: "DELETE"
  });
}

export async function saveReview(
  bookId: string,
  review: Pick<Review, "rating" | "text">
): Promise<{ review: Review; reviews: Review[] }> {
  return request(`/api/books/${bookId}/review`, {
    method: "PUT",
    body: JSON.stringify(review)
  });
}

export async function deleteReview(bookId: string): Promise<void> {
  await request(`/api/books/${bookId}/review`, {
    method: "DELETE"
  });
}

export async function listUsers(): Promise<User[]> {
  const data = await request<{ users: User[] }>("/api/users");
  return data.users;
}

export async function createUser(input: {
  username: string;
  displayName: string;
  password: string;
  role: User["role"];
}): Promise<User> {
  const data = await request<{ user: User }>("/api/users", {
    method: "POST",
    body: JSON.stringify(input)
  });
  return data.user;
}

export async function updateUser(
  userId: string,
  patch: Partial<Pick<User, "displayName" | "role">>
): Promise<User> {
  const data = await request<{ user: User }>(`/api/users/${userId}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  });
  return data.user;
}

export async function updateUserPassword(userId: string, password: string): Promise<User> {
  const data = await request<{ user: User }>(`/api/users/${userId}/password`, {
    method: "PUT",
    body: JSON.stringify({ password })
  });
  return data.user;
}

export async function updateOwnPassword(
  currentPassword: string,
  newPassword: string
): Promise<User> {
  const data = await request<{ user: User }>("/api/me/password", {
    method: "PUT",
    body: JSON.stringify({ currentPassword, newPassword })
  });
  return data.user;
}

export async function removeUser(userId: string): Promise<void> {
  await request(`/api/users/${userId}`, {
    method: "DELETE"
  });
}

export async function listActivity(): Promise<ReadingActivity[]> {
  const data = await request<{ activity: ReadingActivity[] }>("/api/activity");
  return data.activity;
}

export async function getProfile(): Promise<ProfileData> {
  return request("/api/profile");
}

export async function recordProfileUsage(
  mediaType: MediaType,
  seconds: number
): Promise<ProfileUsage> {
  const data = await request<{ usage: ProfileUsage }>("/api/profile/usage", {
    method: "POST",
    body: JSON.stringify({ mediaType, seconds })
  });
  return data.usage;
}

export async function addToReadList(bookId: string): Promise<ProfileData> {
  return request(`/api/profile/read-list/${bookId}`, { method: "PUT" });
}

export async function removeFromReadList(bookId: string): Promise<ProfileData> {
  return request(`/api/profile/read-list/${bookId}`, { method: "DELETE" });
}

export async function updateReadingActivity(bookId: string, percent: number): Promise<void> {
  await request("/api/activity", {
    method: "PUT",
    body: JSON.stringify({ bookId, percent })
  });
}

export async function clearReadingActivity(keepalive = false): Promise<void> {
  await request("/api/activity", {
    method: "DELETE",
    keepalive
  });
}

export async function getPreferences(): Promise<ReaderPreferences> {
  const data = await request<{ preferences: ReaderPreferences }>("/api/preferences");
  return data.preferences;
}

export async function savePreferences(
  preferences: Partial<ReaderPreferences>
): Promise<ReaderPreferences> {
  const data = await request<{ preferences: ReaderPreferences }>("/api/preferences", {
    method: "PUT",
    body: JSON.stringify(preferences)
  });
  return data.preferences;
}

export async function lookupWord(word: string): Promise<DictionaryResult> {
  return request(`/api/dictionary?word=${encodeURIComponent(word)}`);
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (!response.ok) {
        throw new Error(httpErrorMessage(response.status));
      }
      throw new Error("Shelf returned an unreadable response");
    }
  }

  if (response.status === 401) {
    throw new AuthRequiredError();
  }

  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : httpErrorMessage(response.status));
  }

  return payload as T;
}

function httpErrorMessage(status: number): string {
  if (status === 413) return "The selected files are too large for the server upload limit";
  if (status === 502) return "Shelf could not reach the library server";
  if (status === 504) return "The audiobook upload took too long to process; the files may still have been added";
  return `Request failed with ${status}`;
}
