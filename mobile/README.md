# ShelfStream Mobile

ShelfStream Mobile is the shared React Native client for iOS and Android. It connects to the existing self-hosted ShelfStream server and provides:

- separate native Books and Audiobooks libraries
- native background audiobook playback with lock-screen controls
- CarPlay and Android Auto audiobook browsing by title and chapter
- server-synced playback position, including progress posted by the native player while the UI is not running
- 15-second rewind, 30-second forward, chapter controls, and 0.5x-3x speed in 0.05 increments
- complete-audiobook downloads into app-private device storage for offline playback
- the full authenticated ShelfStream web interface for adding titles, EPUB/PDF reading, metadata, covers, ratings, users, and Send to Kindle
- credentials in the iOS Keychain or Android Keystore-backed credential storage; media URLs use expiring bearer authorization headers
- one account with a server directory, encrypted per-server sessions, and signed-ticket switching among every server the account owns or has joined

## Server requirement

The mobile app requires the mobile authentication and progress endpoints in the adjacent ShelfStream server source. Deploy the root application before testing the client.

The default coordination endpoint is `https://shelf-stream.com`. A different HTTPS ShelfStream endpoint can be entered on the login screen. After login, the More screen lists every available server and switches by exchanging a short-lived, server-scoped ticket at the destination node; successful per-server sessions are retained in encrypted device storage. iOS permits local network discovery but intentionally does not allow arbitrary insecure HTTP traffic. Android debug builds can use HTTP; production should use HTTPS.

## Development

Requirements:

- Node.js 22.11 or newer
- Android Studio, Android SDK, and JDK 17 for Android
- macOS with current Xcode and CocoaPods for iOS
- iOS 16 or later for the native audio/CarPlay library

```bash
npm install
npm run typecheck
npm run icons
```

Android:

```bash
npm run android
```

iOS (on macOS):

```bash
cd ios
pod install
cd ..
npm run ios
```

## CarPlay

The app already contains the CarPlay scene configuration, audio background mode, native browse tree, Now Playing metadata, and native transport commands. Apple must approve the Audio CarPlay entitlement for the app's bundle ID before the CarPlay app can be signed and appear on a vehicle screen.

After approval:

1. Add the CarPlay Audio capability to the Xcode target and provisioning profile.
2. Copy `ios/ShelfStreamMobile/ShelfStreamMobile.CarPlay.entitlements.example` to `ShelfStreamMobile.entitlements`.
3. Set the target's Code Signing Entitlements build setting to that file.
4. Sign with the approved profile and test with the CarPlay simulator or a vehicle.

The entitlement is intentionally not enabled in the checked-in development signing settings because Xcode cannot sign it until Apple grants that capability.

## Android Auto

The Android manifest declares a media app and the native player supplies an exported Media3 `MediaLibraryService`. ShelfStream publishes an Audiobooks browse category containing every title and its chapters. The car host renders the driver-safe UI and invokes native play, pause, seek, previous/next chapter, and skip controls without relying on the React Native runtime.

Test using the Android Auto Desktop Head Unit after installing a debug build on an Android phone. A release build must use a private release keystore; the generated template's debug key must not be used for store submission.

## Offline storage

The Offline mode switch downloads every chapter into the app's private documents directory and changes the queue to those local files. Removing the toggle deletes that title's local directory. Offline files are not exposed to other apps. A server connection is still required for initial login and download; previously downloaded audio can then play without network access.

## Audio library license

`@rntp/player` v5 is free for non-commercial use. Commercial distribution of ShelfStream Mobile requires a paid React Native Track Player license. Review `node_modules/@rntp/player/license.txt` before publishing to either app store.
