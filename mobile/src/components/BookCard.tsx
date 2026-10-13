import React from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {Headphones, BookOpen} from 'lucide-react-native';
import {absoluteUrl} from '../api';
import {colors} from '../theme';
import type {Book, Session} from '../types';

type Props = {
  book: Book;
  session: Session;
  onPress: () => void;
  compact?: boolean;
};

export function BookCard({book, session, onPress, compact = false}: Props) {
  const cover = absoluteUrl(session.serverUrl, book.coverUrl);
  const isAudio = book.mediaType === 'audiobook';
  const percent = Math.round((book.progress?.percent || 0) * 100);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${book.title} by ${book.author}`}
      onPress={onPress}
      style={({pressed}) => [styles.card, compact && styles.compact, pressed && styles.pressed]}>
      <View style={[styles.coverFrame, isAudio ? styles.audioCover : styles.ebookCover]}>
        {cover ? (
          <Image
            source={{uri: cover, headers: {Authorization: `Bearer ${session.token}`}}}
            style={styles.cover}
            resizeMode={isAudio ? 'contain' : 'cover'}
          />
        ) : (
          <View style={styles.placeholder}>
            {isAudio ? (
              <Headphones color={colors.pink} size={28} />
            ) : (
              <BookOpen color={colors.pink} size={28} />
            )}
          </View>
        )}
      </View>
      <View style={styles.details}>
        <Text style={styles.title} numberOfLines={2}>{book.title}</Text>
        <Text style={styles.author} numberOfLines={1}>{book.author}</Text>
        <View style={styles.kindRow}>
          {isAudio ? <Headphones size={13} color={colors.pink} /> : <BookOpen size={13} color={colors.muted} />}
          <Text style={styles.progress}>
            {percent > 0 ? `${percent}%` : isAudio ? 'Audiobook' : 'Ebook'}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {width: 152, gap: 9},
  compact: {width: 132},
  pressed: {opacity: 0.72},
  coverFrame: {width: '100%', height: 190, borderRadius: 10, overflow: 'hidden', backgroundColor: '#080909'},
  audioCover: {justifyContent: 'center'},
  ebookCover: {},
  cover: {width: '100%', height: '100%'},
  placeholder: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceRaised},
  details: {gap: 2},
  title: {color: colors.text, fontSize: 15, lineHeight: 19, fontWeight: '700'},
  author: {color: colors.muted, fontSize: 13},
  kindRow: {flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3},
  progress: {color: colors.muted, fontSize: 12},
});
