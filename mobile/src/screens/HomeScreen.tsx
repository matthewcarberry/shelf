import React from 'react';
import {RefreshControl, ScrollView, StyleSheet, Text, View} from 'react-native';
import {BookCard} from '../components/BookCard';
import {colors} from '../theme';
import type {Book, Session} from '../types';

type Props = {
  session: Session;
  books: Book[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (book: Book) => void;
};

export function HomeScreen({session, books, refreshing, onRefresh, onOpen}: Props) {
  const continueBooks = books
    .filter(book => (book.progress?.percent || 0) > 0 && (book.progress?.percent || 0) < 0.995)
    .sort((a, b) => Date.parse(b.progress?.updatedAt || '') - Date.parse(a.progress?.updatedAt || ''));
  const recent = [...books].sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.pink} />}>
      <Text style={styles.eyebrow}>SHELFSTREAM</Text>
      <Text style={styles.heading}>Good reading.</Text>
      {continueBooks.length ? (
        <Section title="Continue">
          {continueBooks.slice(0, 10).map(book => (
            <BookCard key={book.id} compact book={book} session={session} onPress={() => onOpen(book)} />
          ))}
        </Section>
      ) : null}
      <Section title="Recently added">
        {recent.slice(0, 14).map(book => (
          <BookCard key={book.id} compact book={book} session={session} onPress={() => onOpen(book)} />
        ))}
      </Section>
    </ScrollView>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  content: {paddingTop: 24, paddingBottom: 28},
  eyebrow: {color: colors.pink, fontSize: 12, letterSpacing: 2.2, fontWeight: '800', paddingHorizontal: 18},
  heading: {color: colors.text, fontSize: 30, fontWeight: '800', paddingHorizontal: 18, marginTop: 4},
  section: {marginTop: 30},
  sectionTitle: {color: colors.text, fontSize: 20, fontWeight: '800', paddingHorizontal: 18, marginBottom: 13},
  row: {paddingHorizontal: 18, gap: 15},
});
