import TrackPlayer, {
  PlayerCommand,
  type BrowseCategory,
  type MediaItem,
} from '@rntp/player';
import {absoluteUrl, getReaderInfo} from './api';
import type {Book, ReaderInfo, Session} from './types';

let activeConfiguration = '';

export function mediaItems(
  session: Session,
  reader: ReaderInfo,
  localPaths?: string[] | null,
): MediaItem[] {
  const artworkUrl = absoluteUrl(session.serverUrl, reader.book.coverUrl);
  return reader.audioTracks.map((track, index) => ({
    mediaId: `${reader.book.id}:${track.index}`,
    url: localPaths?.[index]
      ? `file://${localPaths[index]}`
      : {
          uri: absoluteUrl(session.serverUrl, track.fileUrl)!,
          headers: {Authorization: `Bearer ${session.token}`},
        },
    title: track.title || `Chapter ${index + 1}`,
    artist: reader.book.narrator || reader.book.author,
    albumTitle: reader.book.title,
    artworkUrl: artworkUrl
      ? {uri: artworkUrl, headers: {Authorization: `Bearer ${session.token}`}}
      : undefined,
    duration: track.durationSeconds || undefined,
    mimeType: 'audio/mpeg',
    extras: {bookId: reader.book.id, trackIndex: track.index},
  }));
}

export function initializePlayer(session: Session): void {
  const configuration = `${session.serverUrl}:${session.user.id}`;
  if (activeConfiguration === configuration) {
    TrackPlayer.updateProgressSyncHeaders({Authorization: `Bearer ${session.token}`});
    return;
  }
  if (activeConfiguration) {
    TrackPlayer.destroy();
  }
  TrackPlayer.setupPlayer({
    contentType: 'speech',
    handleAudioBecomingNoisy: true,
    cache: {maxSizeBytes: 2 * 1024 * 1024 * 1024, preloading: {window: 2}},
    progressSync: {
      intervalSeconds: 10,
      http: {
        url: `${session.serverUrl}/api/mobile/playback-progress`,
        headers: {Authorization: `Bearer ${session.token}`},
      },
    },
    android: {
      wakeMode: 'network',
      taskRemovedBehavior: 'continue',
      notification: {
        channelId: 'shelfstream_playback',
        channelName: 'Audiobook playback',
        smallIcon: 'ic_notification',
      },
    },
  });
  TrackPlayer.setCommands({
    capabilities: [
      PlayerCommand.PlayPause,
      PlayerCommand.Seek,
      PlayerCommand.Previous,
      PlayerCommand.Next,
      PlayerCommand.SkipBackward,
      PlayerCommand.SkipForward,
    ],
    handling: 'native',
    backwardInterval: 15,
    forwardInterval: 15,
  });
  activeConfiguration = configuration;
}

export function clearPlayer(): void {
  if (activeConfiguration) {
    TrackPlayer.destroy();
    activeConfiguration = '';
  }
}

export function loadAudiobook(
  session: Session,
  reader: ReaderInfo,
  localPaths?: string[] | null,
): void {
  initializePlayer(session);
  const startIndex = Math.min(
    Math.max(0, reader.progress?.trackIndex || 0),
    Math.max(0, reader.audioTracks.length - 1),
  );
  TrackPlayer.setMediaItems(mediaItems(session, reader, localPaths), startIndex);
  const trackTime = Number(reader.progress?.trackTime) || 0;
  if (trackTime > 0) {
    TrackPlayer.seekTo(trackTime);
  }
}

export async function updateAutomotiveLibrary(
  session: Session,
  books: Book[],
): Promise<void> {
  initializePlayer(session);
  const audiobooks = books.filter(book => book.mediaType === 'audiobook');
  const readers = await Promise.all(
    audiobooks.map(book => getReaderInfo(session, book.id).catch(() => null)),
  );
  const items = readers.flatMap(reader => {
    if (!reader) {
      return [];
    }
    return [
      {
        mediaId: `book:${reader.book.id}`,
        title: reader.book.title,
        artist: reader.book.author,
        artworkUrl: reader.book.coverUrl
          ? {
              uri: absoluteUrl(session.serverUrl, reader.book.coverUrl)!,
              headers: {Authorization: `Bearer ${session.token}`},
            }
          : undefined,
        children: mediaItems(session, reader).map(item => ({
          mediaId: item.mediaId!,
          title: item.title || reader.book.title,
          artist: item.artist,
          artworkUrl: item.artworkUrl,
          url: item.url,
          duration: item.duration,
          mimeType: item.mimeType,
          extras: item.extras,
        })),
      },
    ];
  });
  const categories: BrowseCategory[] = [
    {mediaId: 'audiobooks', title: 'Audiobooks', items},
  ];
  TrackPlayer.setBrowseTree(categories);
}
