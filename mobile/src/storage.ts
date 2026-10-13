import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import type {Session} from './types';

const SESSION_KEY = 'shelfstream.mobile.session';
const TOKEN_SERVICE = 'com.shelfstream.mobile.auth';

type StoredSessions = {
  activeKey: string;
  sessions: Array<Omit<Session, 'token'>>;
};

function sessionKey(session: Pick<Session, 'serverId' | 'serverUrl'>): string {
  return session.serverId || session.serverUrl;
}

export async function saveSession(session: Session): Promise<void> {
  const [storedRaw, credentials] = await Promise.all([
    AsyncStorage.getItem(SESSION_KEY),
    Keychain.getGenericPassword({service: TOKEN_SERVICE}),
  ]);
  let stored: StoredSessions = {activeKey: sessionKey(session), sessions: []};
  let tokens: Record<string, string> = {};
  try {
    const parsed = storedRaw ? JSON.parse(storedRaw) : null;
    if (parsed?.sessions) stored = parsed;
    if (credentials) tokens = JSON.parse(credentials.password);
  } catch {
    stored = {activeKey: sessionKey(session), sessions: []};
    tokens = {};
  }
  const key = sessionKey(session);
  const metadata = {...session, token: undefined};
  stored = {
    activeKey: key,
    sessions: [...stored.sessions.filter(item => sessionKey(item) !== key), metadata],
  };
  tokens[key] = session.token;
  await Promise.all([
    AsyncStorage.setItem(SESSION_KEY, JSON.stringify(stored)),
    Keychain.setGenericPassword(session.user.id, JSON.stringify(tokens), {
      service: TOKEN_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  ]);
}

export async function loadSession(): Promise<Session | null> {
  const sessions = await loadSessions();
  const stored = await AsyncStorage.getItem(SESSION_KEY);
  if (!stored || !sessions.length) return null;
  try {
    const parsed = JSON.parse(stored) as StoredSessions;
    return sessions.find(session => sessionKey(session) === parsed.activeKey) || sessions[0];
  } catch {
    return sessions[0] || null;
  }
}

export async function loadSessions(): Promise<Session[]> {
  const [stored, credentials] = await Promise.all([
    AsyncStorage.getItem(SESSION_KEY),
    Keychain.getGenericPassword({service: TOKEN_SERVICE}),
  ]);
  if (!stored || !credentials) {
    return [];
  }
  try {
    const parsed = JSON.parse(stored);
    if (parsed?.sessions) {
      const tokens = JSON.parse(credentials.password) as Record<string, string>;
      return (parsed.sessions as Array<Omit<Session, 'token'>>).flatMap(session => {
        const token = tokens[sessionKey(session)];
        return token ? [{...session, token}] : [];
      });
    }
    const legacy = parsed as Omit<Session, 'token'>;
    return [{...legacy, token: credentials.password}];
  } catch {
    return [];
  }
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    AsyncStorage.removeItem(SESSION_KEY),
    Keychain.resetGenericPassword({service: TOKEN_SERVICE}),
  ]);
}
