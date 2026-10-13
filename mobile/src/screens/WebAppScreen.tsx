import React from 'react';
import {StyleSheet, View} from 'react-native';
import {WebView} from 'react-native-webview';
import {colors} from '../theme';
import type {Session} from '../types';

export function WebAppScreen({session, bookId}: {session: Session; bookId?: string | null}) {
  const target = `${session.serverUrl}/?mobile=1${bookId ? `&openBook=${encodeURIComponent(bookId)}` : ''}`;
  const script = `
    (function () {
      if (window.location.pathname !== '/api/health') return true;
      fetch('/api/mobile/web-session', {
        method: 'POST',
        credentials: 'include',
        headers: { Authorization: ${JSON.stringify(`Bearer ${session.token}`)} }
      }).then(function (response) {
        if (!response.ok) throw new Error('Unable to open ShelfStream');
        window.location.replace(${JSON.stringify(target)});
      }).catch(function (error) { document.body.innerText = error.message; });
      return true;
    })();
  `;
  return (
    <View style={styles.root}>
      <WebView
        source={{uri: `${session.serverUrl}/api/health`}}
        injectedJavaScript={script}
        sharedCookiesEnabled
        thirdPartyCookiesEnabled={false}
        allowsBackForwardNavigationGestures
        setSupportMultipleWindows={false}
        style={styles.web}
      />
    </View>
  );
}

const styles = StyleSheet.create({root: {flex: 1, backgroundColor: colors.background}, web: {flex: 1, backgroundColor: colors.background}});
