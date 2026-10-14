/// <reference types="chromecast-caf-sender" />
import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { createCastLinks, getCastConfig } from "./api";

// Chromecast and AirPlay for the audiobook player.
// Chromecast: Google's Cast sender SDK, only in Chrome and Edge on HTTPS pages. The TV fetches
// audio itself through signed cast links and saves progress from Shelf's receiver page.
// AirPlay: Safari sends the <audio> element itself, so nothing changes except showing its picker.

const CAST_SDK_URL = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
const MEDIA_NAMESPACE = "urn:x-cast:com.google.cast.media";

export type CastMedia = {
  bookId: string;
  trackIndex: number;
  currentTime: number;
  duration: number;
  playing: boolean;
};

export type CastSnapshot = {
  // A Cast device is on the network (or a session is already running).
  available: boolean;
  connected: boolean;
  deviceName: string;
  // What the TV is playing, when it's a Shelf audiobook.
  media: CastMedia | null;
  volume: number;
  muted: boolean;
};

type CastItemData = { bookId?: string; trackIndex?: number; progressUrl?: string };

let snapshot: CastSnapshot = { available: false, connected: false, deviceName: "", media: null, volume: 1, muted: false };
const snapshotListeners = new Set<() => void>();
const sessionStartListeners = new Set<() => void>();
let remotePlayer: cast.framework.RemotePlayer | null = null;
let remoteController: cast.framework.RemotePlayerController | null = null;
let sdkReady: Promise<boolean> | null = null;

function publish(next: Partial<CastSnapshot>) {
  snapshot = { ...snapshot, ...next };
  snapshotListeners.forEach((listener) => listener());
}

function castSupported() {
  if (typeof window === "undefined" || !window.isSecureContext) {
    return false;
  }
  const userAgent = navigator.userAgent;
  // Chrome on iPhone and iPad can't cast from web pages.
  return /Chrome\/|Edg\//.test(userAgent) && !/CriOS|EdgiOS|iPhone|iPad/.test(userAgent);
}

function syncFromRemotePlayer() {
  const player = remotePlayer;
  if (!player) {
    return;
  }
  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  const data = (player.mediaInfo?.customData || null) as CastItemData | null;
  const media: CastMedia | null =
    player.isConnected && player.isMediaLoaded && data?.bookId && Number.isInteger(data.trackIndex)
      ? {
          bookId: data.bookId,
          trackIndex: data.trackIndex as number,
          currentTime: player.currentTime || 0,
          duration: player.duration || 0,
          playing: !player.isPaused
        }
      : null;
  publish({
    connected: player.isConnected,
    deviceName: session?.getCastDevice().friendlyName || "",
    media,
    volume: player.volumeLevel ?? 1,
    muted: Boolean(player.isMuted)
  });
}

function loadCastSdk(): Promise<boolean> {
  if (sdkReady) {
    return sdkReady;
  }
  sdkReady = new Promise<boolean>((resolve) => {
    if (!castSupported()) {
      resolve(false);
      return;
    }
    window.__onGCastApiAvailable = (available) => resolve(available);
    const script = document.createElement("script");
    script.src = CAST_SDK_URL;
    script.async = true;
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  }).then(async (available) => {
    if (!available) {
      return false;
    }
    let receiverAppId: string | null = null;
    try {
      receiverAppId = (await getCastConfig()).receiverAppId;
    } catch {
      // Fall back to Google's default receiver.
    }
    const context = cast.framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: receiverAppId || chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });
    remotePlayer = new cast.framework.RemotePlayer();
    remoteController = new cast.framework.RemotePlayerController(remotePlayer);
    remoteController.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, syncFromRemotePlayer);
    context.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, (event) => {
      publish({ available: event.castState !== cast.framework.CastState.NO_DEVICES_AVAILABLE });
    });
    context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (event) => {
      syncFromRemotePlayer();
      if (event.sessionState === cast.framework.SessionState.SESSION_STARTED) {
        sessionStartListeners.forEach((listener) => listener());
      }
    });
    publish({ available: context.getCastState() !== cast.framework.CastState.NO_DEVICES_AVAILABLE });
    syncFromRemotePlayer();
    return true;
  });
  return sdkReady;
}

export function useCast(): CastSnapshot & { supported: boolean } {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    void loadCastSdk().then((ready) => {
      if (live) {
        setSupported(ready);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  const state = useSyncExternalStore(
    (listener) => {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    () => snapshot
  );
  return { ...state, supported };
}

// Fires when the person picks a device, not when a page reload rejoins a running session.
export function onCastSessionStarted(listener: () => void) {
  sessionStartListeners.add(listener);
  return () => {
    sessionStartListeners.delete(listener);
  };
}

function currentSession() {
  return remotePlayer ? cast.framework.CastContext.getInstance().getCurrentSession() : null;
}

export const castControls = {
  // Opens Chrome's device picker; while casting it offers "Stop casting".
  requestSession() {
    if (remotePlayer) {
      cast.framework.CastContext.getInstance().requestSession().catch(() => undefined);
    }
  },

  // Sends the whole book to the TV as a queue, one item per track.
  async load(options: { bookId: string; trackIndex: number; time: number; play: boolean; playbackRate: number }) {
    const session = currentSession();
    if (!session) {
      return;
    }
    const links = await createCastLinks(options.bookId);
    if (!links.tracks.length) {
      return;
    }
    const items = links.tracks.map((track) => {
      const info = new chrome.cast.media.MediaInfo(track.url, track.contentType);
      const metadata = new chrome.cast.media.MusicTrackMediaMetadata();
      metadata.title = links.tracks.length > 1 ? track.title : links.title;
      metadata.albumName = links.title;
      metadata.artist = links.author || "";
      if (links.coverUrl) {
        metadata.images = [new chrome.cast.Image(links.coverUrl)];
      }
      info.metadata = metadata;
      info.streamType = chrome.cast.media.StreamType.BUFFERED;
      if (track.durationSeconds) {
        info.duration = track.durationSeconds;
      }
      const data: CastItemData = { bookId: options.bookId, trackIndex: track.index, progressUrl: links.progressUrl };
      info.customData = data;
      const item = new chrome.cast.media.QueueItem(info);
      item.autoplay = true;
      item.preloadTime = 20;
      return item;
    });
    const startIndex = Math.min(Math.max(0, options.trackIndex), items.length - 1);
    items[startIndex].startTime = Math.max(0, options.time);
    items[startIndex].autoplay = options.play;
    const request = new chrome.cast.media.QueueLoadRequest(items);
    request.startIndex = startIndex;
    await new Promise<void>((resolve, reject) => {
      session.getSessionObj().queueLoad(request, () => resolve(), reject);
    });
    if (options.playbackRate !== 1) {
      castControls.setPlaybackRate(options.playbackRate);
    }
  },

  playOrPause() {
    remoteController?.playOrPause();
  },

  pause() {
    if (remotePlayer && !remotePlayer.isPaused) {
      remoteController?.playOrPause();
    }
  },

  seek(time: number) {
    if (!remotePlayer || !remoteController) {
      return;
    }
    remotePlayer.currentTime = Math.max(0, time);
    remoteController.seek();
  },

  // The Cast sender SDK has no speed control, so this sends the media message directly.
  setPlaybackRate(playbackRate: number) {
    const session = currentSession();
    const mediaSessionId = session?.getMediaSession()?.mediaSessionId;
    if (!session || mediaSessionId === undefined) {
      return;
    }
    void session
      .sendMessage(MEDIA_NAMESPACE, {
        type: "SET_PLAYBACK_RATE",
        requestId: Math.floor(Math.random() * 1_000_000_000),
        mediaSessionId,
        playbackRate
      })
      .catch(() => undefined);
  },

  setVolume(volume: number) {
    if (!remotePlayer || !remoteController) {
      return;
    }
    remotePlayer.volumeLevel = Math.min(1, Math.max(0, volume));
    remoteController.setVolumeLevel();
    if (remotePlayer.isMuted && volume > 0) {
      remoteController.muteOrUnmute();
    }
  },

  toggleMute() {
    remoteController?.muteOrUnmute();
  }
};

type AirPlayAudio = HTMLAudioElement & {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

// Safari only: shows the AirPlay button when an AirPlay device is nearby.
export function useAirPlay(audioRef: RefObject<HTMLAudioElement | null>) {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const audio = audioRef.current as AirPlayAudio | null;
    if (!audio || !("WebKitPlaybackTargetAvailabilityEvent" in window)) {
      return;
    }
    const handleAvailability = (event: Event) => {
      setAvailable((event as Event & { availability?: string }).availability === "available");
    };
    const handleTargetChange = () => setActive(Boolean(audio.webkitCurrentPlaybackTargetIsWireless));
    audio.addEventListener("webkitplaybacktargetavailabilitychanged", handleAvailability);
    audio.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", handleTargetChange);
    handleTargetChange();
    return () => {
      audio.removeEventListener("webkitplaybacktargetavailabilitychanged", handleAvailability);
      audio.removeEventListener("webkitcurrentplaybacktargetiswirelesschanged", handleTargetChange);
    };
  }, [audioRef]);
  return {
    available,
    active,
    showPicker: () => (audioRef.current as AirPlayAudio | null)?.webkitShowPlaybackTargetPicker?.()
  };
}
