# Shelf

Shelf is a self-hosted ebook and audiobook reader for Docker and Unraid. It keeps books and audio on the server, streams them to desktop or mobile, and stores separate reading or listening progress for every user under `/data`.

Native iOS and Android clients now live in [`mobile/`](mobile/README.md). They add app-private audiobook downloads, background playback, lock-screen controls, and native CarPlay/Android Auto browsing while retaining access to every web feature.

## Current Reader Support

- EPUB: browser reader with saved progress, font size, typeface, alignment, themes, bookmarks, highlights, and contextual selected-word definitions.
- PDF: range-streamed PDF reader with page progress, bookmarks, contextual selected-text definitions, and saved highlight snippets.
- Other non-DRM ebook formats: MOBI, AZW, AZW3, FB2, DOCX, TXT, RTF, HTML, ODT, and common comic archives are prepared as EPUB with Calibre's `ebook-convert`.
- Audiobooks: range-streamed MP3, M4B, M4A, AAC, OGG, OPUS, WAV, and FLAC playback with resume position, skip controls, playback speed, volume, and multi-part navigation.
- Multi-part audiobooks: tracks with matching album metadata are grouped into one title and sorted by disc and track number. Untagged tracks in the same subfolder are grouped as a fallback.
- Offline mode: a per-audiobook toggle stores every audio part plus the app shell and required metadata on the current device. Playback position continues saving locally and syncs to the server after connectivity returns.
- Multi-user accounts: shared book files with separate progress, marks, preferences, ratings, and reviews per user.
- Multi-server accounts: one Shelf account can own or join multiple independent servers, switch among them in the web and mobile clients, and connect with short-lived server-scoped tickets.
- First-class libraries: each server can expose separate Books, Audiobooks, or mixed libraries and grant each invited member access only to selected libraries.
- Profiles: each user has reading/listening completion totals, active-time hours, history, ratings and reviews, notes and highlights, and a persistent Read List.
- Send to Kindle: every EPUB can be emailed to a user's saved `@kindle.com` address through the configured Shelf SMTP account.
- Global light, dark, and high-contrast display themes saved per user.

DRM-protected books cannot be read or converted by this app.

## Local Development

```bash
npm install
npm run dev
```

The Vite UI runs on `http://localhost:5173` and proxies API calls to the server on `http://localhost:3000`.

For local testing without Docker, copied or uploaded books go to `runtime/library`, and app state goes to `runtime/data`.

## Docker

Every push to `main` builds the image and publishes it to GitHub Container Registry as `ghcr.io/matthewcarberry/shelf:latest` (plus `sha-<commit>` tags). To release a version, bump `version` in `package.json` in a pull request. When it merges, the same build also tags the commit (for example `v0.1.2`), publishes the image as `0.1.2` and `0.1`, and creates a GitHub release. Pushes that keep an already-tagged version only update `latest`, and pushing a `v*` tag by hand still publishes that version. Compose pulls that image:

```bash
APP_PASSWORD="use-a-long-random-password" docker compose up -d
```

Set `SHELF_IMAGE_TAG` to pin a release or commit instead of `latest`. To run an image built from a local checkout instead:

```bash
docker build -t ghcr.io/matthewcarberry/shelf:local .
SHELF_IMAGE_TAG=local docker compose up -d
```

Open `http://localhost:9191`, or set `SHELFSTREAM_HOST_PORT` to a different host port before starting Compose.

The container expects:

- `/library`: your ebook and audiobook files
- `/data`: Shelf metadata, progress, profile usage, Read Lists, bookmarks, highlights, dictionary cache, and converted EPUB copies

For remote access, set a real password before starting the container. On first boot, Shelf creates the initial admin user from these values when no users exist yet:

```bash
APP_USERNAME=admin
APP_PASSWORD="use-a-long-random-password"
docker compose up -d
```

If authentication is enabled and `/data` has no existing users, the production container will refuse to start unless `APP_PASSWORD` or `APP_PASSWORD_HASH` is configured.

For a stronger setup, generate a password hash and use `APP_PASSWORD_HASH` instead of `APP_PASSWORD`:

```bash
npm run hash-password
```

After the first administrator exists, use **Server settings** to create a scoped invitation for another Shelf account. Legacy local users can still be managed during the transition, but new self-service registrations do not automatically gain access to the current server.

## Unraid

Use the compose file as a starting point or create a Docker template ([`unraid/my-shelfstream.xml`](unraid/my-shelfstream.xml)) with:

- Repository: `ghcr.io/matthewcarberry/shelf:latest`
- Container port: `3000`
- Host port: any available port; this deployment uses `9191`
- `/library` mapped to your books and audiobooks share, for example `/mnt/user/media/books`
- `/data` mapped to appdata, for example `/mnt/user/appdata/shelfstream`
- `ONLINE_DICTIONARY=true` to allow dictionaryapi.dev lookup and caching
- `ONLINE_DICTIONARY=false` to use only cached dictionary entries
- `AUTH_ENABLED=true`
- `APP_USERNAME=admin`
- `APP_PASSWORD` or `APP_PASSWORD_HASH`
- `TRUST_PROXY=true` when running behind a reverse proxy or tunnel
- `COOKIE_SECURE=true` when the public URL uses HTTPS
- `PUBLIC_URL=https://books.example.com` so clients and invitations advertise the externally reachable server endpoint
- `REGISTRATION_ENABLED=true` to allow self-service reader signup from the login page
- `REGISTRATION_REQUIRE_EMAIL_NOTIFY=true` to block production self-signup unless SMTP is configured
- `REGISTRATION_NOTIFY_EMAIL=you@example.com` for registration attempt notifications (defaults to the `EMAIL_FROM` sender address when unset)
- SMTP settings when email notifications should be delivered:
  - `SMTP_HOST`
  - `SMTP_PORT`
  - `SMTP_SECURE`
  - `SMTP_USER`
  - `SMTP_PASS`
  - `EMAIL_FROM`
  - `KINDLE_MAX_ATTACHMENT_MB` (optional, defaults to `25`)

## Access From Any Network

Do not expose Shelf directly to the internet without authentication and HTTPS. The app now includes built-in session-cookie authentication, but the safest network design is still to avoid a raw public port whenever possible.

Recommended options:

1. Tailscale or WireGuard VPN into your home network, then open `http://unraid-ip:3000`.
2. Cloudflare Tunnel, Nginx Proxy Manager, SWAG, Caddy, or Traefik in front of Shelf with HTTPS enabled.
3. Router port forwarding only if you also use HTTPS, a strong app password, and keep the container updated.

Typical reverse proxy target:

```text
http://shelfstream:3000
```

For a public HTTPS URL such as `https://books.example.com`, use:

```env
AUTH_ENABLED=true
APP_USERNAME=admin
APP_PASSWORD_HASH=scrypt:...
TRUST_PROXY=true
COOKIE_SECURE=true
```

Requests that reach the container directly over plain HTTP (for example `http://unraid-ip:9191` on your LAN) always get a non-Secure cookie, so signing in on the LAN keeps working with `COOKIE_SECURE=true`. Requests through your HTTPS proxy still get a Secure cookie.

## Registration And Notifications

When `REGISTRATION_ENABLED=true`, the login page shows a registration form. Registration creates a Shelf platform account but does not grant access to any server. The account can accept a one-use invitation or claim an unowned server with its short-lived setup code. In production, `REGISTRATION_REQUIRE_EMAIL_NOTIFY=true` blocks self-registration unless SMTP notification settings are configured.

Registration security notes:

- Shelf uses SQLite through fixed, parameterized application queries; users cannot submit SQL.
- Usernames are normalized to lowercase letters, numbers, dots, underscores, and hyphens.
- Passwords are hashed with `scrypt`; raw passwords are not stored.
- Registration attempts are IP rate-limited in memory with `REGISTRATION_MAX_ATTEMPTS`, default `5`, per `REGISTRATION_WINDOW_MS`, default `900000`.
- The form includes a hidden honeypot field for basic bot resistance.
- Processed registration attempts send an email notification when SMTP is configured. Rate-limited attempts are rejected before email to avoid turning the notification system into an email-spam tool.

Example Gmail SMTP settings require a Gmail app password, not your normal Gmail password:

```env
REGISTRATION_ENABLED=true
REGISTRATION_REQUIRE_EMAIL_NOTIFY=true
REGISTRATION_NOTIFY_EMAIL=you@example.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-sending-account@gmail.com
SMTP_PASS=your-gmail-app-password
EMAIL_FROM="Shelf <your-sending-account@gmail.com>"
KINDLE_MAX_ATTACHMENT_MB=25
```

## Send To Kindle

Every EPUB title has a prominent **Send to Kindle** action on its library card and detail view. On first use, enter the `@kindle.com` address assigned to your Kindle device or app. Shelf saves that address per user; later sends require only opening the action and confirming delivery.

Before sending, add the address configured in `EMAIL_FROM` to Amazon's **Approved Personal Document Email List** under Manage Your Content and Devices. Amazon rejects documents from unapproved senders. Shelf reports when the SMTP server accepts a message, but final conversion and device delivery are handled by Amazon and can take additional time.

Send to Kindle uses the same `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `EMAIL_FROM` settings as registration notifications. `KINDLE_MAX_ATTACHMENT_MB` prevents oversized EPUBs from being submitted to the SMTP provider; adjust it only when the provider supports a larger message size. This action is intentionally limited to original EPUB files and is not shown for PDFs, converted reading copies, or audiobooks.

## Users, Progress, Ratings, And Reviews

The library is shared, but reading state is not. Two users can open the same book and each will keep separate:

- current reading location and read percentage
- bookmarks
- highlights
- typography/theme preferences
- global display theme, including high-contrast mode
- 0-5 star rating
- written review
- profile reading/listening hours
- Read List entries

Mobile apps authenticate with revocable 90-day bearer tokens stored as SHA-256 hashes in Shelf data. The raw token remains in the phone's protected credential store and is sent as an authorization header for API, cover, and audio range requests. Signing out revokes the current device token.

Each server membership has an independent `owner`, `admin`, or `member` role. Owners and administrators manage invitations, members, libraries, and metadata from **Server settings**; invitation grants can be restricted to selected libraries. Friendship is intentionally separate from server membership and never grants library access. Signed-in users can change their own password from the account menu.

## Servers, Invitations, And Libraries

The current Shelf binary can operate as both a server node and the coordination service for a small self-hosted deployment. A permanent Ed25519 node identity and a separate control-plane signing identity live in the persistent SQLite database. Rebuilding the container does not change either identity.

- Owners generate a 15-minute local claim code before attaching a server to their account.
- Owners and administrators issue one-use invitations that expire after seven days and specify a server role plus explicit library grants.
- Invite secrets are stored only as hashes and are shown to the inviter once.
- Server switching uses a signed, one-use connection ticket scoped to the destination server and valid for 60 seconds.
- Remote endpoints must use HTTPS, except for loopback and private-LAN addresses, and their public server identity must match the directory record.
- Media, metadata, progress, highlights, ratings, and reviews stay on the server that owns the library; the coordination layer carries identity, membership, endpoint, and ticket data only.

This combined mode supplies the complete P0 multi-server foundation without moving private media off the host. A separately operated PostgreSQL control plane, relay connectivity, mDNS discovery, and the guided Windows server installer remain later infrastructure work.

## Storage Model

Shelf stores application state in `/data/shelfstream.sqlite` using SQLite with versioned schema migrations. Schema 4 adds global accounts, registered servers, memberships, invitations, first-class libraries and access grants, claim codes, connection-ticket replay protection, platform preferences, friendships, and the coordination-service signing identity. Every server also has a permanent Ed25519 identity in that database. Rebuilding or upgrading the container does not change the server ID as long as `/data` remains mapped to persistent storage.

When an existing installation starts with `/data/shelfstream.json` but no initialized SQLite database, Shelf:

1. validates the legacy JSON;
2. creates `/data/shelfstream.json.pre-sqlite-backup` without overwriting an existing backup;
3. imports users, books, progress, bookmarks, highlights, preferences, reviews, dictionary entries, and mobile tokens in one SQLite transaction;
4. verifies imported record counts before startup continues;
5. leaves the original JSON file untouched for rollback.

The public `/.well-known/shelfstream-server` endpoint exposes the stable server ID, public key, display name, and capabilities. The private key never leaves the SQLite database.

Shelf does not move or rewrite original files in `/library`. When an ebook cannot be rendered directly in the browser, the server creates an EPUB reading copy in `/data/converted` and keeps the original untouched.

PDFs and audio are served with HTTP range requests. EPUBs are opened through the browser reader from the server URL; the app does not trigger a file download, though the browser still fetches the content needed to render the title.

For the cleanest multi-part audiobook grouping, put one audiobook per folder or tag every track with the same album and album artist. Embedded artwork is used automatically; `cover.jpg`, `folder.jpg`, `front.jpg`, or an image matching the audio filename is also recognized.

## Audiobook Offline Mode

Open an audiobook and enable **Offline mode** to download the complete title to that browser. The toggle reports per-part progress and changes to **Offline ready** only after every track and the required app data have been stored. Disable it to remove that local copy.

Offline copies are device- and browser-specific, consume browser storage, and may be evicted by the operating system under storage pressure. Signing out removes all offline Shelf data from that browser for account security. The first download requires connectivity; afterward the app can be reloaded, played, and seeked without reaching the Shelf server.
