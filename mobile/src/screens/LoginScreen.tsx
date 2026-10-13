import React, {useState} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {BookOpen, LockKeyhole} from 'lucide-react-native';
import {mobileLogin} from '../api';
import {colors} from '../theme';
import type {Session} from '../types';

export function LoginScreen({onLogin}: {onLogin: (session: Session) => Promise<void>}) {
  const [server, setServer] = useState('https://shelf-stream.com');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const session = await mobileLogin(server, username, password);
      await onLogin(session);
    } catch (value) {
      setError(value instanceof Error ? value.message : 'Unable to sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.container}>
        <View style={styles.logo}><BookOpen color="#fff" size={34} /></View>
        <Text style={styles.title}>ShelfStream</Text>
        <Text style={styles.subtitle}>Your books and audiobooks, everywhere.</Text>
        <View style={styles.form}>
          <Text style={styles.label}>Server</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={setServer}
            value={server}
            style={styles.input}
          />
          <Text style={styles.label}>Username</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setUsername}
            value={username}
            style={styles.input}
          />
          <Text style={styles.label}>Password</Text>
          <TextInput
            onChangeText={setPassword}
            onSubmitEditing={submit}
            secureTextEntry
            value={password}
            style={styles.input}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            disabled={busy || !username || !password}
            onPress={submit}
            style={({pressed}) => [styles.button, pressed && styles.pressed, busy && styles.disabled]}>
            {busy ? <ActivityIndicator color="#20151a" /> : <LockKeyhole color="#20151a" size={20} />}
            <Text style={styles.buttonText}>{busy ? 'Signing in…' : 'Sign in'}</Text>
          </Pressable>
        </View>
        <Text style={styles.privacy}>Your password is sent only to your ShelfStream server. The mobile token is stored in the device keychain.</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {flex: 1, backgroundColor: colors.background},
  container: {flex: 1, justifyContent: 'center', padding: 28},
  logo: {width: 66, height: 66, borderRadius: 16, backgroundColor: colors.pinkStrong, alignItems: 'center', justifyContent: 'center', marginBottom: 20},
  title: {color: colors.text, fontSize: 34, fontWeight: '800'},
  subtitle: {color: colors.muted, fontSize: 16, marginTop: 5, marginBottom: 28},
  form: {gap: 8},
  label: {color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 7},
  input: {height: 50, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, paddingHorizontal: 14, fontSize: 16},
  error: {color: colors.danger, marginTop: 4},
  button: {height: 52, borderRadius: 26, backgroundColor: colors.pink, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 14},
  pressed: {opacity: 0.8},
  disabled: {opacity: 0.55},
  buttonText: {color: '#20151a', fontSize: 16, fontWeight: '800'},
  privacy: {color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 22},
});
