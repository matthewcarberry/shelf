import type {Book, Bookmark, PlatformOverview, ReaderInfo, Session, User} from './types';

export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return 'https://shelf-stream.com';
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function absoluteUrl(serverUrl: string, value?: string | null): string | null {
  if (!value) {
    return null;
  }
  return /^https?:\/\//i.test(value) ? value : `${serverUrl}${value}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    return (await response.json()) as T;
  }
  const body = await response.json().catch(() => ({}));
  throw new Error(body.error || `Shelf returned ${response.status}`);
}

export async function mobileLogin(
  serverValue: string,
  username: string,
  password: string,
): Promise<Session> {
  const serverUrl = normalizeServerUrl(serverValue);
  const response = await fetch(`${serverUrl}/api/auth/mobile/login`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({username, password, deviceName: 'Shelf mobile app'}),
  });
  const result = await parseResponse<{
    token: string;
    expiresAt?: string;
    user: User;
  }>(response);
  const session: Session = {serverUrl, token: result.token, expiresAt: result.expiresAt, user: result.user};
  const server = await authorizedRequest<{serverId: string; name: string}>(session, '/api/server');
  return {...session, serverId: server.serverId, serverName: server.name};
}

export async function authorizedRequest<T>(
  session: Session,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${session.serverUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${session.token}`,
      ...(options.body ? {'Content-Type': 'application/json'} : {}),
      ...options.headers,
    },
  });
  return parseResponse<T>(response);
}

export async function listBooks(session: Session): Promise<Book[]> {
  const result = await authorizedRequest<{books: Book[]}>(session, '/api/books');
  return result.books;
}

export function getPlatformOverview(session: Session): Promise<PlatformOverview> {
  return authorizedRequest<PlatformOverview>(session, '/api/platform');
}

export async function connectToServer(session: Session, serverId: string): Promise<Session> {
  const connection = await authorizedRequest<{
    endpointUrl: string;
    ticket: string;
  }>(session, `/api/platform/servers/${serverId}/ticket`);
  if (!connection.endpointUrl) {
    throw new Error('The server owner has not configured a verified remote address.');
  }
  const response = await fetch(`${connection.endpointUrl}/api/auth/mobile/exchange`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ticket: connection.ticket, deviceName: 'Shelf mobile app'}),
  });
  const result = await parseResponse<{
    token: string;
    expiresAt?: string;
    user: User;
    serverId: string;
    serverName: string;
  }>(response);
  return {
    serverUrl: connection.endpointUrl,
    serverId: result.serverId,
    serverName: result.serverName,
    token: result.token,
    expiresAt: result.expiresAt,
    user: result.user,
  };
}

export function getReaderInfo(session: Session, bookId: string): Promise<ReaderInfo> {
  return authorizedRequest<ReaderInfo>(session, `/api/books/${bookId}/reader`);
}

export async function addBookmark(
  session: Session,
  bookId: string,
  bookmark: Pick<Bookmark, 'label' | 'locator' | 'percent'>,
): Promise<Bookmark> {
  const result = await authorizedRequest<{bookmark: Bookmark}>(session, `/api/books/${bookId}/bookmarks`, {
    method: 'POST',
    body: JSON.stringify(bookmark),
  });
  return result.bookmark;
}

export async function logout(session: Session): Promise<void> {
  await fetch(`${session.serverUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${session.token}`},
  });
}
