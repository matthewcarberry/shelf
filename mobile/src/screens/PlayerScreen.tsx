import React, {useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageBackground,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import Slider from '@react-native-community/slider';
import TrackPlayer, {useActiveMediaItem, useIsPlaying, useProgress} from '@rntp/player';
import {
  Bookmark,
  CarFront,
  ChevronDown,
  Download,
  Gauge,
  ListMusic,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
  SkipForward,
  Share2,
  Trash2,
} from 'lucide-react-native';
import {absoluteUrl, addBookmark, getReaderInfo} from '../api';
import {downloadAudiobook, getOfflineTracks, removeOfflineAudiobook} from '../offline';
import {loadAudiobook} from '../player';
import {colors} from '../theme';
import type {Book, ReaderInfo, Session} from '../types';

type Props = {session: Session; book: Book; onBack: () => void};

export function PlayerScreen({session, book, onBack}: Props) {
  const [reader, setReader] = useState<ReaderInfo | null>(null);
  const [error, setError] = useState('');
  const [speed, setSpeed] = useState(1);
  const [offline, setOffline] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [speedOpen, setSpeedOpen] = useState(false);
  const playing = useIsPlaying();
  const progress = useProgress(0.5);
  const activeItem = useActiveMediaItem();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const info = await getReaderInfo(session, book.id);
        const localTracks = await getOfflineTracks(book.id);
        if (!alive) return;
        setReader(info);
        setOffline(Boolean(localTracks));
        loadAudiobook(session, info, localTracks);
        setSpeed(TrackPlayer.getPlaybackSpeed());
      } catch (value) {
        if (alive) setError(value instanceof Error ? value.message : 'Unable to load audiobook');
      }
    })();
    return () => { alive = false; };
  }, [book.id, session]);

  const trackIndex = Number(activeItem?.extras?.trackIndex || 0);
  const cover = absoluteUrl(session.serverUrl, book.coverUrl);
  const trackTitle = activeItem?.title || reader?.audioTracks[trackIndex]?.title || book.title;
  const elapsedBeforeTrack = (reader?.audioTracks || [])
    .slice(0, trackIndex)
    .reduce((total, item) => total + (item.durationSeconds || 0), 0);
  const elapsed = elapsedBeforeTrack + progress.position;
  const totalDuration = book.durationSeconds
    || (reader?.audioTracks || []).reduce((total, item) => total + (item.durationSeconds || 0), 0);
  const overallPercent = totalDuration > 0 ? Math.min(1, elapsed / totalDuration) : 0;
  const downloadText = useMemo(() => {
    if (downloadProgress !== null) return `Saving ${Math.round(downloadProgress * 100)}%`;
    return offline ? 'Available offline' : 'Keep on this device';
  }, [downloadProgress, offline]);

  async function toggleOffline(value: boolean) {
    if (!reader || downloadProgress !== null) return;
    try {
      if (value) {
        setDownloadProgress(0);
        const paths = await downloadAudiobook(session, reader, setDownloadProgress);
        setOffline(true);
        loadAudiobook(session, reader, paths);
      } else {
        await removeOfflineAudiobook(book.id);
        setOffline(false);
        loadAudiobook(session, reader, null);
      }
    } catch (valueError) {
      Alert.alert('Offline download failed', valueError instanceof Error ? valueError.message : 'Please try again.');
    } finally {
      setDownloadProgress(null);
    }
  }

  function changeSpeed(value: number) {
    const rounded = Math.round(value * 20) / 20;
    setSpeed(rounded);
    TrackPlayer.setPlaybackSpeed(rounded);
  }

  async function saveCurrentBookmark() {
    if (!reader) return;
    try {
      const bookmark = await addBookmark(session, book.id, {
        label: `${trackTitle} at ${formatTime(progress.position)}`,
        locator: `audio:${trackIndex}:${Math.round(progress.position)}`,
        percent: overallPercent,
      });
      setReader(current => current ? {...current, bookmarks: [bookmark, ...(current.bookmarks || [])]} : current);
      Alert.alert('Bookmark added', bookmark.label);
    } catch (bookmarkError) {
      Alert.alert('Unable to add bookmark', bookmarkError instanceof Error ? bookmarkError.message : 'Please try again.');
    }
  }

  if (!reader && !error) {
    return <View style={styles.loading}><ActivityIndicator color={colors.pink} size="large" /></View>;
  }

  return (
    <View style={styles.root}>
      {cover ? <ImageBackground source={{uri: cover, headers: {Authorization: `Bearer ${session.token}`}}} blurRadius={34} style={styles.backdrop}><View style={styles.backdropShade} /></ImageBackground> : null}
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <View style={styles.topBar}>
        <Pressable onPress={onBack} style={styles.iconButton}><ChevronDown color="#ffffff" size={31} /></Pressable>
        <View style={styles.topActions}>
          <Pressable accessibilityLabel="Car playback" onPress={() => Alert.alert('Car playback', 'Connect to CarPlay or Android Auto and open Shelf from your car display.')} style={styles.iconButton}><CarFront color="#ffffff" size={25} /></Pressable>
          <Pressable accessibilityLabel="Share audiobook" onPress={() => Share.share({title: book.title, message: `${book.title} by ${book.author}`})} style={styles.iconButton}><Share2 color="#ffffff" size={25} /></Pressable>
        </View>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {cover ? (
        <Image source={{uri: cover, headers: {Authorization: `Bearer ${session.token}`}}} resizeMode="contain" style={styles.cover} />
      ) : <View style={[styles.cover, styles.coverPlaceholder]} />}
      <Text style={styles.chapter} numberOfLines={2}>{trackTitle}</Text>
      <Text style={styles.trackCount}>Track {trackIndex + 1} of {reader?.audioTracks.length || 1}</Text>
      <Text style={styles.remaining}>
        {totalDuration > 0 ? `${formatRemaining(Math.max(0, totalDuration - elapsed) / speed)} left at ${formatRate(speed)}× · ${Math.round(overallPercent * 100)}%` : book.author}
      </Text>
      <Slider
        minimumValue={0}
        maximumValue={Math.max(progress.duration, 1)}
        value={Math.min(progress.position, Math.max(progress.duration, 1))}
        onSlidingComplete={value => TrackPlayer.seekTo(value)}
        minimumTrackTintColor="#ffffff"
        maximumTrackTintColor="rgba(255,255,255,0.38)"
        thumbTintColor="#ffffff"
      />
      <View style={styles.timeRow}>
        <Text style={styles.time}>{formatTime(progress.position)}</Text>
        <Text style={styles.time}>-{formatTime(Math.max(0, progress.duration - progress.position))}</Text>
      </View>
      <View style={styles.controls}>
        <Pressable onPress={() => TrackPlayer.skipToPrevious()} style={styles.controlButton}><SkipBack color={colors.text} size={25} /></Pressable>
        <Pressable onPress={() => TrackPlayer.seekBy(-15)} style={styles.controlButton}>
          <RotateCcw color={colors.text} size={31} /><Text style={styles.skipNumber}>15</Text>
        </Pressable>
        <Pressable onPress={() => playing ? TrackPlayer.pause() : TrackPlayer.play()} style={styles.playButton}>
          {playing ? <Pause fill="#25151b" color="#25151b" size={34} /> : <Play fill="#25151b" color="#25151b" size={35} />}
        </Pressable>
        <Pressable onPress={() => TrackPlayer.seekBy(15)} style={styles.controlButton}>
          <RotateCw color={colors.text} size={31} /><Text style={styles.skipNumber}>15</Text>
        </Pressable>
        <Pressable onPress={() => TrackPlayer.skipToNext()} style={styles.controlButton}><SkipForward color={colors.text} size={25} /></Pressable>
      </View>
      <View style={styles.toolBar}>
        <Pressable onPress={() => setSpeedOpen(value => !value)} style={styles.toolButton}><Text style={styles.toolValue}>{formatRate(speed)}</Text><Gauge color="#ffffff" size={22} /></Pressable>
        <Pressable onPress={() => toggleOffline(!offline)} style={styles.toolButton}><Download color={offline ? colors.pink : '#ffffff'} size={24} /></Pressable>
        <Pressable onPress={saveCurrentBookmark} style={styles.toolButton}><Bookmark color="#ffffff" size={24} /></Pressable>
        <Pressable onPress={() => Share.share({title: book.title, message: `${book.title} by ${book.author}`})} style={styles.toolButton}><Share2 color="#ffffff" size={24} /></Pressable>
        <Pressable onPress={() => Alert.alert(`${reader?.audioTracks.length || 1} tracks`, `Currently playing track ${trackIndex + 1}: ${trackTitle}`)} style={styles.toolButton}><ListMusic color="#ffffff" size={26} /></Pressable>
      </View>
      {speedOpen ? <View style={styles.panel}>
        <View style={styles.panelTitleRow}><Gauge color={colors.pink} size={19} /><Text style={styles.panelTitle}>Playback speed</Text><Text style={styles.speed}>{speed.toFixed(2)}×</Text></View>
        <Slider
          minimumValue={0.5}
          maximumValue={3}
          step={0.05}
          value={speed}
          onValueChange={changeSpeed}
          minimumTrackTintColor={colors.pink}
          maximumTrackTintColor={colors.border}
          thumbTintColor={colors.pink}
        />
        <View style={styles.speedLabels}><Text style={styles.time}>0.5×</Text><Text style={styles.time}>3×</Text></View>
      </View> : null}
      <View style={styles.offlineRow}>
        <View style={styles.offlineIcon}>{offline ? <Trash2 color={colors.pink} size={20} /> : <Download color={colors.pink} size={20} />}</View>
        <View style={styles.offlineText}><Text style={styles.panelTitle}>Offline mode</Text><Text style={styles.time}>{downloadText}</Text></View>
        {downloadProgress !== null ? <ActivityIndicator color={colors.pink} /> : <Switch value={offline} onValueChange={toggleOffline} trackColor={{true: colors.pinkStrong}} />}
      </View>
      <Text style={styles.carNote}>CarPlay and Android Auto use the same chapter queue, cover art, progress, and 15-second controls.</Text>
    </ScrollView>
    </View>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00';
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatRate(value: number): string {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function formatRemaining(seconds: number): string {
  const minutes = Math.max(0, Math.ceil(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours} hr${hours === 1 ? '' : 's'}${remainder ? ` ${remainder} min` : ''}` : `${remainder} min`;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#050505'},
  scroll: {flex: 1, backgroundColor: 'transparent'},
  backdrop: {position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: 0.58},
  backdropShade: {flex: 1, backgroundColor: 'rgba(3,3,3,0.58)'},
  loading: {flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center'},
  content: {padding: 20, paddingBottom: 44},
  topBar: {height: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  topActions: {flexDirection: 'row', alignItems: 'center', gap: 8},
  iconButton: {width: 42, height: 42, alignItems: 'center', justifyContent: 'center'},
  iconSpacer: {width: 42},
  nowPlaying: {color: colors.muted, letterSpacing: 1.7, fontSize: 11, fontWeight: '800'},
  error: {color: colors.danger, textAlign: 'center'},
  cover: {width: '100%', aspectRatio: 1, maxHeight: 490, borderRadius: 13, backgroundColor: '#070808', marginTop: 22},
  coverPlaceholder: {backgroundColor: colors.surface},
  title: {color: colors.text, fontSize: 25, fontWeight: '800', textAlign: 'center', marginTop: 24},
  author: {color: colors.muted, fontSize: 15, textAlign: 'center', marginTop: 5},
  chapter: {color: '#ffffff', fontSize: 19, lineHeight: 25, fontWeight: '800', textAlign: 'center', marginTop: 38},
  trackCount: {color: 'rgba(255,255,255,0.92)', fontSize: 16, textAlign: 'center', marginTop: 6},
  remaining: {color: 'rgba(255,255,255,0.72)', fontSize: 14, textAlign: 'center', marginTop: 18, marginBottom: 36},
  timeRow: {flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: 4},
  time: {color: 'rgba(255,255,255,0.72)', fontSize: 12},
  controls: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: 34},
  controlButton: {width: 46, height: 50, alignItems: 'center', justifyContent: 'center'},
  skipNumber: {color: colors.text, position: 'absolute', fontSize: 9, fontWeight: '800'},
  playButton: {width: 86, height: 86, borderRadius: 43, backgroundColor: '#ffffff', alignItems: 'center', justifyContent: 'center'},
  toolBar: {minHeight: 70, borderRadius: 18, backgroundColor: 'rgba(16,16,16,0.58)', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 4, marginTop: 12},
  toolButton: {position: 'relative', width: 52, height: 58, alignItems: 'center', justifyContent: 'center'},
  toolValue: {position: 'absolute', top: 1, color: '#ffffff', fontSize: 11, fontWeight: '800'},
  panel: {backgroundColor: 'rgba(18,18,18,0.82)', borderRadius: 14, padding: 14, marginTop: 12},
  panelTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  panelTitle: {color: colors.text, fontSize: 15, fontWeight: '700'},
  speed: {color: colors.pink, marginLeft: 'auto', fontSize: 16, fontWeight: '800'},
  speedLabels: {flexDirection: 'row', justifyContent: 'space-between'},
  offlineRow: {backgroundColor: 'rgba(18,18,18,0.82)', borderRadius: 14, padding: 14, marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 12},
  offlineIcon: {width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center'},
  offlineText: {flex: 1, gap: 3},
  carNote: {color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginHorizontal: 20, marginTop: 18},
});
