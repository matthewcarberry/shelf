import AsyncStorage from '@react-native-async-storage/async-storage';
import RNFS from 'react-native-fs';
import {absoluteUrl} from './api';
import type {ReaderInfo, Session} from './types';

const MANIFEST_KEY = 'shelfstream.mobile.offline';
type OfflineManifest = Record<string, {trackPaths: string[]; savedAt: string}>;

async function manifest(): Promise<OfflineManifest> {
  const raw = await AsyncStorage.getItem(MANIFEST_KEY);
  return raw ? (JSON.parse(raw) as OfflineManifest) : {};
}

export async function getOfflineTracks(bookId: string): Promise<string[] | null> {
  const entry = (await manifest())[bookId];
  if (!entry || !entry.trackPaths.length) {
    return null;
  }
  const checks = await Promise.all(entry.trackPaths.map(track => RNFS.exists(track)));
  return checks.every(Boolean) ? entry.trackPaths : null;
}

export async function downloadAudiobook(
  session: Session,
  reader: ReaderInfo,
  onProgress: (value: number) => void,
): Promise<string[]> {
  const directory = `${RNFS.DocumentDirectoryPath}/shelfstream/${reader.book.id}`;
  await RNFS.mkdir(directory);
  const paths: string[] = [];
  for (let index = 0; index < reader.audioTracks.length; index += 1) {
    const track = reader.audioTracks[index];
    const destination = `${directory}/track-${String(index).padStart(4, '0')}.audio`;
    const url = absoluteUrl(session.serverUrl, track.fileUrl);
    if (!url) {
      throw new Error(`Track ${index + 1} has no audio URL`);
    }
    const result = await RNFS.downloadFile({
      fromUrl: url,
      toFile: destination,
      headers: {Authorization: `Bearer ${session.token}`},
      progressDivider: 4,
      progress: event => {
        const trackProgress = event.contentLength
          ? event.bytesWritten / event.contentLength
          : 0;
        onProgress((index + trackProgress) / reader.audioTracks.length);
      },
    }).promise;
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`Unable to save track ${index + 1}`);
    }
    paths.push(destination);
    onProgress((index + 1) / reader.audioTracks.length);
  }

  const data = await manifest();
  data[reader.book.id] = {trackPaths: paths, savedAt: new Date().toISOString()};
  await AsyncStorage.setItem(MANIFEST_KEY, JSON.stringify(data));
  return paths;
}

export async function removeOfflineAudiobook(bookId: string): Promise<void> {
  const data = await manifest();
  const entry = data[bookId];
  if (entry) {
    const directory = entry.trackPaths[0]?.replace(/[\\/]track-[^\\/]+$/, '');
    if (directory && (await RNFS.exists(directory))) {
      await RNFS.unlink(directory);
    }
    delete data[bookId];
    await AsyncStorage.setItem(MANIFEST_KEY, JSON.stringify(data));
  }
}
