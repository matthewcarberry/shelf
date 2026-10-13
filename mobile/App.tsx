import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {BookOpen, Headphones, Home, MoreHorizontal} from 'lucide-react-native';
import {connectToServer, getPlatformOverview, listBooks, logout as logoutRequest} from './src/api';
import {clearPlayer, initializePlayer, updateAutomotiveLibrary} from './src/player';
import {clearSession, loadSession, loadSessions, saveSession} from './src/storage';
import {colors} from './src/theme';
import type {Book, PlatformOverview, Session} from './src/types';
import {HomeScreen} from './src/screens/HomeScreen';
import {LibraryScreen} from './src/screens/LibraryScreen';
import {LoginScreen} from './src/screens/LoginScreen';
import {MoreScreen} from './src/screens/MoreScreen';
import {PlayerScreen} from './src/screens/PlayerScreen';
import {WebAppScreen} from './src/screens/WebAppScreen';

type Tab = 'home' | 'books' | 'audio' | 'more';

export default function App() {
  return <SafeAreaProvider><ShelfStreamMobile /></SafeAreaProvider>;
}

function ShelfStreamMobile() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [platform, setPlatform] = useState<PlatformOverview | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('home');
  const [activeAudiobook, setActiveAudiobook] = useState<Book | null>(null);
  const [fullApp, setFullApp] = useState(false);
  const [fullAppBookId, setFullAppBookId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([loadSession(), loadSessions()]).then(([active, saved]) => {
      setSession(active);
      setSessions(saved);
    }).catch(() => setSession(null));
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      const [next, nextPlatform] = await Promise.all([
        listBooks(session),
        getPlatformOverview(session).catch(() => null),
      ]);
      setBooks(next);
      setPlatform(nextPlatform);
      updateAutomotiveLibrary(session, next).catch(() => undefined);
    } catch (error) {
      Alert.alert('Unable to refresh ShelfStream', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setRefreshing(false);
    }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    try {
      initializePlayer(session);
      refresh();
    } catch (error) {
      Alert.alert('Audio player unavailable', error instanceof Error ? error.message : 'Unable to start audio playback.');
    }
  }, [refresh, session]);

  async function handleLogin(next: Session) {
    await saveSession(next);
    setSessions(await loadSessions());
    setSession(next);
  }

  async function handleServerSwitch(serverId: string) {
    if (!session || serverId === session.serverId) return;
    setRefreshing(true);
    try {
      const cached = sessions.find(item => item.serverId === serverId);
      const next = cached || await connectToServer(session, serverId);
      await saveSession(next);
      setSessions(await loadSessions());
      setBooks([]);
      setPlatform(null);
      setSession(next);
      setTab('home');
    } catch (error) {
      Alert.alert('Unable to connect to server', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleLogout() {
    if (!session) return;
    await logoutRequest(session).catch(() => undefined);
    clearPlayer();
    await clearSession();
    setBooks([]);
    setSessions([]);
    setPlatform(null);
    setSession(null);
  }

  function openBook(book: Book) {
    if (book.mediaType === 'audiobook') {
      setActiveAudiobook(book);
    } else {
      setFullAppBookId(book.id);
      setFullApp(true);
    }
  }

  if (session === undefined) {
    return <View style={styles.loading}><ActivityIndicator color={colors.pink} size="large" /></View>;
  }
  if (!session) {
    return <LoginScreen onLogin={handleLogin} />;
  }
  if (activeAudiobook) {
    return <SafeAreaView style={styles.safe}><StatusBar barStyle="light-content" /><PlayerScreen session={session} book={activeAudiobook} onBack={() => { setActiveAudiobook(null); refresh(); }} /></SafeAreaView>;
  }
  if (fullApp) {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <StatusBar barStyle="light-content" />
        <View style={styles.webHeader}><Pressable onPress={() => { setFullApp(false); setFullAppBookId(null); }} style={styles.done}><Text style={styles.doneText}>Done</Text></Pressable><Text style={styles.webTitle}>ShelfStream</Text><View style={styles.done} /></View>
        <WebAppScreen session={session} bookId={fullAppBookId} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" />
      <View style={styles.body}>
        {tab === 'home' && <HomeScreen session={session} books={books} refreshing={refreshing} onRefresh={refresh} onOpen={openBook} />}
        {tab === 'books' && <LibraryScreen title="Books" mediaType="ebook" session={session} books={books} refreshing={refreshing} onRefresh={refresh} onOpen={openBook} />}
        {tab === 'audio' && <LibraryScreen title="Audiobooks" mediaType="audiobook" session={session} books={books} refreshing={refreshing} onRefresh={refresh} onOpen={openBook} />}
        {tab === 'more' && <MoreScreen session={session} sessions={sessions} platform={platform} onServerSwitch={handleServerSwitch} onFullApp={() => { setFullAppBookId(null); setFullApp(true); }} onLogout={handleLogout} />}
      </View>
      <View style={styles.tabs}>
        <TabButton label="Home" active={tab === 'home'} onPress={() => setTab('home')} icon={Home} />
        <TabButton label="Books" active={tab === 'books'} onPress={() => setTab('books')} icon={BookOpen} />
        <TabButton label="Audio" active={tab === 'audio'} onPress={() => setTab('audio')} icon={Headphones} />
        <TabButton label="More" active={tab === 'more'} onPress={() => setTab('more')} icon={MoreHorizontal} />
      </View>
    </SafeAreaView>
  );
}

function TabButton({label, active, onPress, icon: Icon}: {label: string; active: boolean; onPress: () => void; icon: typeof Home}) {
  return <Pressable accessibilityRole="tab" accessibilityState={{selected: active}} onPress={onPress} style={styles.tab}><Icon size={22} color={active ? colors.pink : colors.muted} /><Text style={[styles.tabText, active && styles.tabActive]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: colors.background},
  loading: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background},
  body: {flex: 1},
  tabs: {height: 64, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface, flexDirection: 'row'},
  tab: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3},
  tabText: {color: colors.muted, fontSize: 10, fontWeight: '700'},
  tabActive: {color: colors.pink},
  webHeader: {height: 48, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  webTitle: {color: colors.text, fontWeight: '800'},
  done: {width: 70, paddingHorizontal: 14},
  doneText: {color: colors.pink, fontWeight: '700'},
});
