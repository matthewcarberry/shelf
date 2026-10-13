import React, {useEffect, useMemo, useState} from 'react';
import {FlatList, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Search, SlidersHorizontal} from 'lucide-react-native';
import {BookCard} from '../components/BookCard';
import {colors} from '../theme';
import type {Book, Session} from '../types';

type Props = {
  title: string;
  mediaType: 'ebook' | 'audiobook';
  session: Session;
  books: Book[];
  onOpen: (book: Book) => void;
  onRefresh: () => void;
  refreshing: boolean;
};

export function LibraryScreen(props: Props) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'title' | 'author' | 'recent'>('title');
  useEffect(() => {
    AsyncStorage.getItem(`shelfstream.mobile.sort.${props.mediaType}`).then(value => {
      if (value === 'title' || value === 'author' || value === 'recent') setSort(value);
    });
  }, [props.mediaType]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return props.books
      .filter(book => book.mediaType === props.mediaType)
      .filter(book => !needle || `${book.title} ${book.author} ${book.series || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => {
        if (sort === 'recent') return Date.parse(b.addedAt) - Date.parse(a.addedAt);
        const left = sort === 'author' ? a.author : a.title;
        const right = sort === 'author' ? b.author : b.title;
        return left.localeCompare(right, undefined, {sensitivity: 'base'});
      });
  }, [props.books, props.mediaType, query, sort]);

  function rotateSort() {
    setSort(current => {
      const next = current === 'title' ? 'author' : current === 'author' ? 'recent' : 'title';
      AsyncStorage.setItem(`shelfstream.mobile.sort.${props.mediaType}`, next).catch(() => undefined);
      return next;
    });
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>{props.title}</Text>
        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <Search size={18} color={colors.muted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search title or author"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
          </View>
          <Pressable onPress={rotateSort} accessibilityLabel={`Sort by ${sort}`} style={styles.sortButton}>
            <SlidersHorizontal size={19} color={colors.text} />
            <Text style={styles.sortText}>{sort}</Text>
          </Pressable>
        </View>
      </View>
      <FlatList
        data={filtered}
        keyExtractor={book => book.id}
        numColumns={2}
        columnWrapperStyle={styles.columns}
        contentContainerStyle={styles.list}
        refreshing={props.refreshing}
        onRefresh={props.onRefresh}
        renderItem={({item}) => <BookCard book={item} session={props.session} onPress={() => props.onOpen(item)} />}
        ListEmptyComponent={<Text style={styles.empty}>No matching titles.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.background},
  header: {paddingHorizontal: 18, paddingTop: 22, paddingBottom: 14},
  title: {color: colors.text, fontSize: 28, fontWeight: '800', marginBottom: 15},
  searchRow: {flexDirection: 'row', gap: 8},
  searchBox: {flex: 1, height: 44, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: 10, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12},
  input: {flex: 1, color: colors.text, paddingHorizontal: 8},
  sortButton: {height: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, flexDirection: 'row', alignItems: 'center', gap: 6},
  sortText: {color: colors.text, fontSize: 12, textTransform: 'capitalize'},
  list: {paddingHorizontal: 18, paddingBottom: 30},
  columns: {justifyContent: 'space-between', marginBottom: 22},
  empty: {color: colors.muted, textAlign: 'center', marginTop: 40},
});
