# ShelfStream Multi-Server Platform

Status: P0 platform foundation deployed and verified on the primary Unraid server (2026-08-27)

ShelfStream now implements the complete self-hosted P0 path in one binary: SQLite schema 4, permanent server and control-plane identities, platform accounts, server claiming, memberships and invitations, first-class libraries and library grants, endpoint verification, one-use connection tickets, and web/mobile server switching. The current primary deployment runs in combined control-plane/node mode. A separately operated PostgreSQL control plane, relay service, mDNS discovery, and Windows installer remain later phases.

## Product goal

ShelfStream should use one global account for every client while allowing that account to:

- create and own one or more ShelfStream servers;
- accept invitations to servers owned by other people;
- switch between joined servers without signing in again;
- keep each server's media files and reading/listening state on that server;
- install a ShelfStream server on an ordinary Windows machine through a guided setup flow.

This is a control-plane/node architecture. The ShelfStream service coordinates identity and discovery, but it does not become the storage location for privately hosted books or audiobooks.

## Implemented architecture

The same Express application currently supplies two roles so the architecture can be deployed without a new cloud dependency:

- The node owns its media paths, metadata, playback state, reading state, server keypair, library configuration, and local authorization.
- The embedded coordination layer owns platform accounts, the server directory, membership and invitation records, platform preferences, and the control-plane signing key.
- Browser sessions and mobile bearer tokens carry both the account identity and the selected server context.
- Web and mobile clients retrieve the account's server directory, request a short-lived ticket, exchange it at the selected node, and then use that node's existing media APIs.
- Existing installations migrate their first local administrator to owner, other administrators to admin, and readers to member while retaining their local IDs and all personal state.
- Existing Books and Audiobooks views are seeded as separate first-class libraries and every catalog item is associated with its matching library.

This combined mode establishes the client/node boundary and is suitable for the current self-hosted P0 deployment. Splitting the coordination tables into a separately hosted service does not require moving private library or playback data.

## Implemented P0 API

Platform and account endpoints:

- `GET /api/platform`
- `GET|PUT /api/platform/preferences`
- `GET|POST|DELETE /api/platform/invitations`
- `POST /api/platform/invitations/accept`
- `POST /api/platform/servers/claim`
- `GET /api/platform/servers/:serverId/ticket`
- `POST /api/platform/delegated/ticket`
- `GET|PATCH|DELETE /api/platform/members`

Node and library endpoints:

- `GET /.well-known/shelfstream-server`
- `POST /api/server/claim`
- `GET /api/platform/claim-code`
- `PATCH /api/platform/server`
- `GET|POST /api/libraries`
- `PATCH|DELETE /api/libraries/:libraryId`
- `POST /api/auth/exchange`
- `POST /api/auth/mobile/exchange`

Invitation secrets and connection-ticket nonces are stored only as hashes. Tickets are Ed25519-signed, audience-scoped, expire after 60 seconds, and cannot be replayed. Invitations are one-use, expire after seven days, and carry explicit server-role and library grants.

## Target architecture

### 1. Future standalone ShelfStream control plane

The control plane runs at ShelfStream-operated endpoints such as `api.shelf-stream.com` and owns only platform coordination data:

- global accounts and credential recovery;
- registered server identities and ownership;
- memberships and roles;
- invitation lifecycle;
- server endpoint discovery and connection status;
- short-lived, server-scoped connection tickets;
- device sessions and security audit events.

The control plane must not store library files, audiobook streams, book metadata, highlights, or reading/listening progress.

Recommended production storage is PostgreSQL. Account passwords should use Argon2id, with passkeys and MFA added after the first release.

### 2. ShelfStream server node

The existing Express application becomes a server node. A node owns:

- configured library folders and original media files;
- scanned book and audiobook metadata;
- per-member progress, bookmarks, highlights, ratings, and preferences;
- streaming, conversion, offline-download, and Send to Kindle endpoints;
- its server keypair and control-plane registration;
- cached membership authorization for limited offline operation.

The node database is SQLite with versioned migrations and automatic legacy import backups. PostgreSQL is unnecessary for a normal personal server.

### 3. Web and mobile clients

Clients authenticate once with the control plane. After login they receive a list of servers they own or have joined. Selecting a server follows this flow:

1. Client requests a short-lived connection ticket for a specific server.
2. Client chooses the best advertised endpoint for that server.
3. Server validates the ticket's signature, audience, account, membership, role, expiry, and nonce.
4. Server exchanges it for a local HTTP-only session or device token.
5. Existing library and playback APIs continue to operate against the selected server.

The client must treat `(serverId, bookId)` as the identity of a title. A bare `bookId` is not globally unique.

## Identity and authorization model

### Global roles

- Account user: can own and join servers.
- Platform operator: limited ShelfStream service administration; never implies access to a private server library.

### Server roles

- Owner: claims the server, manages deletion/transfer, connectivity, administrators, and invitations.
- Administrator: manages the library, metadata, users, and server settings.
- Member: reads, listens, reviews, and manages personal state.

The existing `admin` and `reader` roles map to server administrator and member. Ownership is a separate membership property and must not be inferred from `admin`.

### Invitations

An invitation record contains:

- server ID and inviter account ID;
- intended email address or a shareable one-use token;
- requested server role;
- expiry, acceptance time, and revocation time;
- a hash of the invitation secret, never the raw secret.

Accepting an invitation creates a membership. It never creates a second local password on the host server.

### Server identity

Each node generates an Ed25519 keypair on first setup. The private key remains in the server data directory. Claiming a server requires both an authenticated owner account and a one-time local setup code, preventing someone on the internet from claiming an unconfigured node.

## Connectivity model

Connection order should be:

1. Verified local-network endpoint discovered through mDNS.
2. Host-configured direct HTTPS endpoint.
3. ShelfStream relay tunnel when direct connectivity is unavailable.

The first release should support host-configured HTTPS endpoints. That preserves the current Nginx Proxy Manager deployment and avoids making the control plane a media bandwidth bottleneck.

The Windows-friendly release should add an outbound node connection to a ShelfStream relay. Because the connection originates from the host, users do not need port forwarding, a static public IP, or their own reverse proxy. Relay bandwidth and abuse controls make this a later infrastructure phase, not part of the initial identity migration.

The control plane should advertise endpoints, but the client must verify that every endpoint presents the expected server identity.

## Proposed service boundaries

### Future versioned control-plane API

- `POST /v1/accounts/register`
- `POST /v1/accounts/login`
- `POST /v1/accounts/logout`
- `GET /v1/me/servers`
- `POST /v1/servers/claim/start`
- `POST /v1/servers/claim/complete`
- `PATCH /v1/servers/:serverId`
- `POST /v1/servers/:serverId/invitations`
- `DELETE /v1/servers/:serverId/invitations/:invitationId`
- `POST /v1/invitations/:token/accept`
- `DELETE /v1/servers/:serverId/members/:accountId`
- `POST /v1/servers/:serverId/connection-tickets`
- `POST /v1/nodes/heartbeat`

### Node API additions

- `GET /.well-known/shelfstream-server`
- `GET /api/server`
- `POST /api/server/claim`
- `POST /api/auth/exchange`
- `GET /api/members`
- `PATCH /api/members/:accountId`
- `DELETE /api/members/:accountId`

Existing media APIs remain on the node. Node authorization resolves a global account ID to a local membership before calling existing handlers.

## Data ownership

| Data | Control plane | Server node | Client device |
| --- | --- | --- | --- |
| Global account and recovery | Authoritative | Account ID cache only | Active account session |
| Server ownership and membership | Authoritative | Signed/cacheable copy | Selected server list |
| Server endpoint directory | Authoritative | Publishes endpoints | Cached endpoints |
| Books, metadata, and media | Never | Authoritative | Offline copies only |
| Progress, bookmarks, and highlights | Never | Authoritative | Pending/offline changes |
| Server private key | Never | Authoritative | Never |

## Windows server application

The Windows host experience should include:

- a signed installer;
- an embedded Node runtime and ShelfStream server build;
- a Windows service wrapper so the server runs without a logged-in desktop user;
- a localhost setup wizard for account sign-in, server claiming, library-folder selection, and invite creation;
- Windows Firewall configuration;
- automatic, signed application updates with rollback;
- a tray utility for opening the dashboard, viewing status, restarting the service, and changing library folders;
- optional Calibre discovery or installation for conversion features.

An MSI built with WiX and a service wrapper such as WinSW is a lower-risk path than rewriting the server in a desktop framework. The existing Node application remains the server implementation.

## Migration of the current Unraid server

1. Completed: migrate state into versioned SQLite and preserve the legacy JSON backup.
2. Completed: persist stable server and coordination signing identities.
3. Completed: convert legacy users into platform accounts and server memberships without changing IDs or personal state.
4. Completed: seed Books and Audiobooks as first-class libraries and preserve every catalog association.
5. Completed: support both local login and global ticket exchange during the transition.
6. Completed: deploy schema 4 to the primary Unraid node and verify identity, row counts, LAN/public health, Docker Manager integration, and orphan-free image replacement.
7. Later: move coordination data to the hosted control plane and retire local-password login only after account recovery and linking flows are production-ready.

No media files need to move during this migration.

## Delivery phases

### Phase 0: Stabilize the node data layer — complete

- Introduce SQLite repositories and versioned migrations.
- Import the existing JSON database on first launch.
- Add automatic pre-migration backups and rollback tests.
- Add stable `serverId` and server keypair generation.

### Phase 1: Accounts and server claiming — complete in combined mode

- Create platform-account and server-directory repositories in the combined service.
- Add global account registration/login and device sessions.
- Claim the current Unraid server through a one-time setup code.
- Add the server switcher to web and mobile clients.

### Phase 2: Invitations and memberships — complete in combined mode

- Add invite creation, acceptance, revocation, and expiration.
- Add owner/admin/member authorization.
- Link existing users without losing progress.

### Phase 3: Direct remote connectivity — P0 complete

- Register host-provided HTTPS endpoints.
- Add health, version, capability, and cryptographic endpoint identity reporting.
- Remaining: heartbeat and mDNS local discovery/endpoint preference.

### Phase 4: Windows host release

- Build the installer, service wrapper, setup wizard, firewall rules, and updater.
- Test library paths on local disks, removable disks, and UNC shares.
- Publish signed release artifacts and an uninstall flow that preserves library files.

### Phase 5: Relay connectivity

- Add outbound persistent node tunnels and relay routing.
- Enforce quotas, rate limits, abuse controls, and end-to-end server identity verification.
- Prefer direct connections and use relay only as fallback.

## P0 acceptance criteria

- Existing users and all reading/listening state migrate exactly once.
- Existing API and UI tests pass without client changes.
- Failed migrations restore the prior JSON-backed state.
- A server ID and Ed25519 keypair persist under `/data`.
- Rebuilding or upgrading the container does not change server identity.
- Accounts without membership see onboarding instead of private libraries.
- Invitations grant only their named server role and libraries.
- Friendship records remain separate and never authorize library access.
- Web and mobile clients can switch servers through signed one-use tickets.
- The current Unraid deployment remains usable throughout the transition.

## Non-goals for the first release

- Central storage of books or audiobooks.
- Cross-server merging of duplicate titles.
- Sharing one progress record across different hosts' copies of a title.
- Mandatory relay usage.
- Requiring current Unraid users to abandon local login before account linking is complete.
