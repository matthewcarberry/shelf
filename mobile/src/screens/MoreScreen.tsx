import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {BookOpen, LogOut, Server, ShieldCheck} from 'lucide-react-native';
import {colors} from '../theme';
import type {PlatformOverview, Session} from '../types';

export function MoreScreen({session, sessions, platform, onServerSwitch, onFullApp, onLogout}: {
  session: Session;
  sessions: Session[];
  platform: PlatformOverview | null;
  onServerSwitch: (serverId: string) => void;
  onFullApp: () => void;
  onLogout: () => void;
}) {
  const servers = platform?.servers || sessions.map(saved => ({
    serverId: saved.serverId || saved.serverUrl,
    name: saved.serverName || saved.serverUrl,
    endpointUrl: saved.serverUrl,
    status: 'saved',
    role: saved.user.role === 'admin' ? 'admin' as const : 'member' as const,
    libraries: [],
  }));
  return (
    <View style={styles.root}>
      <Text style={styles.heading}>More</Text>
      <View style={styles.profile}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{session.user.displayName.slice(0, 1).toUpperCase()}</Text></View>
        <View><Text style={styles.name}>{session.user.displayName}</Text><Text style={styles.muted}>{session.user.role}</Text></View>
      </View>
      <Pressable style={styles.row} onPress={onFullApp}><BookOpen color={colors.pink} /><View style={styles.rowText}><Text style={styles.label}>Full ShelfStream</Text><Text style={styles.muted}>Add titles, edit metadata, read ebooks, send to Kindle, and manage users</Text></View></Pressable>
      <Text style={styles.sectionLabel}>SERVERS</Text>
      {servers.map(server => (
        <Pressable
          key={server.serverId}
          disabled={server.serverId === session.serverId}
          style={[styles.row, server.serverId === session.serverId && styles.activeServer]}
          onPress={() => onServerSwitch(server.serverId)}>
          <Server color={server.serverId === session.serverId ? colors.pink : colors.muted} />
          <View style={styles.rowText}><Text style={styles.label}>{server.name}</Text><Text style={styles.muted}>{server.role} · {server.serverId === session.serverId ? 'connected' : server.status}</Text></View>
        </Pressable>
      ))}
      <View style={styles.row}><ShieldCheck color={colors.green} /><View style={styles.rowText}><Text style={styles.label}>Secure mobile session</Text><Text style={styles.muted}>Token stored in the device keychain</Text></View></View>
      <Pressable style={[styles.row, styles.logout]} onPress={onLogout}><LogOut color={colors.danger} /><Text style={[styles.label, {color: colors.danger}]}>Sign out</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background, padding: 20},
  heading: {color: colors.text, fontSize: 28, fontWeight: '800', marginTop: 8, marginBottom: 22},
  profile: {flexDirection: 'row', alignItems: 'center', gap: 13, marginBottom: 24},
  avatar: {width: 50, height: 50, borderRadius: 15, backgroundColor: colors.pinkStrong, alignItems: 'center', justifyContent: 'center'},
  avatarText: {color: '#fff', fontSize: 21, fontWeight: '800'},
  name: {color: colors.text, fontSize: 18, fontWeight: '800'},
  row: {minHeight: 72, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 13},
  rowText: {flex: 1, gap: 4},
  sectionLabel: {color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 1.1, marginTop: 8},
  activeServer: {backgroundColor: colors.surface},
  label: {color: colors.text, fontSize: 15, fontWeight: '700'},
  muted: {color: colors.muted, fontSize: 12, lineHeight: 17},
  logout: {marginTop: 12, borderBottomWidth: 0},
});
