import crypto from "node:crypto";
import path from "node:path";
import { nanoid } from "nanoid";

const TICKET_TTL_MS = 60_000;
const DELEGATION_TTL_MS = 8 * 60 * 60 * 1000;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLAIM_TTL_MS = 15 * 60 * 1000;
const SERVER_ROLES = new Set(["owner", "admin", "member"]);
const INVITABLE_ROLES = new Set(["admin", "member"]);
const LIBRARY_TYPES = new Set(["ebook", "audiobook", "mixed"]);

export class PlatformService {
  constructor(store, { serverIdentity, serverName, libraryRoot, publicUrl = "" }) {
    this.store = store;
    this.serverIdentity = serverIdentity;
    this.serverName = serverName;
    this.libraryRoot = path.resolve(libraryRoot);
    this.publicUrl = normalizeEndpoint(publicUrl, { allowEmpty: true });
    this.controlPlaneIdentity = null;
  }

  async init() {
    this.controlPlaneIdentity = ensureControlPlaneIdentity(this.store.sqlite);
    const storedUsers = this.store.listUsers();
    const users = storedUsers.length ? storedUsers : [{
      id: "anonymous",
      username: "local",
      displayName: "Local reader",
      role: "admin",
      createdAt: new Date().toISOString()
    }];
    for (const user of users) {
      this.ensureAccount(user);
    }

    const firstAdmin = users.find((user) => user.role === "admin") || users[0] || null;
    const now = new Date().toISOString();
    await this.store.queueSqliteWrite((sqlite) => {
      const existing = sqlite.prepare("SELECT server_id FROM registered_servers WHERE server_id = ?")
        .get(this.serverIdentity.serverId);
      if (!existing) {
        sqlite.prepare(`
          INSERT INTO registered_servers (
            server_id, name, public_key, owner_account_id, endpoint_url,
            endpoint_verified_at, status, capabilities_json, claimed_at,
            last_seen_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?)
        `).run(
          this.serverIdentity.serverId,
          this.serverName,
          this.serverIdentity.publicKey,
          firstAdmin?.id || null,
          this.publicUrl || null,
          this.publicUrl ? now : null,
          JSON.stringify(defaultCapabilities()),
          firstAdmin ? now : null,
          now,
          now,
          now
        );
      } else {
        sqlite.prepare(`
          UPDATE registered_servers
          SET name = ?, public_key = ?, status = 'online', last_seen_at = ?, updated_at = ?,
              endpoint_url = COALESCE(NULLIF(?, ''), endpoint_url)
          WHERE server_id = ?
        `).run(this.serverName, this.serverIdentity.publicKey, now, now, this.publicUrl, this.serverIdentity.serverId);
      }
    });

    if (firstAdmin) {
      await this.upsertMembership({
        serverId: this.serverIdentity.serverId,
        accountId: firstAdmin.id,
        localUserId: firstAdmin.id,
        role: "owner"
      });
    }
    for (const user of users) {
      if (firstAdmin && user.id === firstAdmin.id) continue;
      await this.upsertMembership({
        serverId: this.serverIdentity.serverId,
        accountId: user.id,
        localUserId: user.id,
        role: user.role === "admin" ? "admin" : "member"
      });
    }

    await this.ensureDefaultLibraries(firstAdmin?.id || null);
    await this.reconcileBooks(this.store.listBooks());
  }

  getControlPlanePublicIdentity() {
    return {
      publicKey: this.controlPlaneIdentity.publicKey,
      createdAt: this.controlPlaneIdentity.createdAt
    };
  }

  ensureAccount(user, email = "") {
    const now = new Date().toISOString();
    this.store.sqlite.prepare(`
      INSERT INTO platform_accounts (
        id, username, display_name, email, local_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        username = excluded.username,
        display_name = excluded.display_name,
        email = COALESCE(NULLIF(excluded.email, ''), platform_accounts.email),
        local_user_id = COALESCE(excluded.local_user_id, platform_accounts.local_user_id),
        updated_at = excluded.updated_at
    `).run(
      user.id,
      user.username,
      user.displayName || user.username,
      normalizeEmail(email) || null,
      user.id,
      user.createdAt || now,
      now
    );
    return this.getAccount(user.id);
  }

  getAccount(accountId) {
    const row = this.store.sqlite.prepare(`
      SELECT id, username, display_name, email, created_at, updated_at
      FROM platform_accounts WHERE id = ?
    `).get(accountId);
    return row ? accountRow(row) : null;
  }

  getMembership(serverId, accountId) {
    const row = this.store.sqlite.prepare(`
      SELECT server_id, account_id, local_user_id, role, created_at, updated_at
      FROM server_memberships WHERE server_id = ? AND account_id = ?
    `).get(serverId, accountId);
    return row ? membershipRow(row) : null;
  }

  async upsertMembership({ serverId, accountId, localUserId = null, role = "member" }) {
    const safeRole = SERVER_ROLES.has(role) ? role : "member";
    const now = new Date().toISOString();
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        INSERT INTO server_memberships (
          server_id, account_id, local_user_id, role, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id, account_id) DO UPDATE SET
          local_user_id = COALESCE(excluded.local_user_id, server_memberships.local_user_id),
          role = excluded.role,
          updated_at = excluded.updated_at
      `).run(serverId, accountId, localUserId, safeRole, now, now);
    });
    return this.getMembership(serverId, accountId);
  }

  requireRole(accountId, allowedRoles, serverId = this.serverIdentity.serverId) {
    const membership = this.getMembership(serverId, accountId);
    if (!membership || !allowedRoles.includes(membership.role)) {
      const error = new Error("You do not have permission to manage this server");
      error.status = 403;
      throw error;
    }
    return membership;
  }

  overview(userId) {
    const localUser = this.store.getPublicUser(userId);
    const account = localUser ? this.ensureAccount(localUser) : this.getAccount(userId);
    if (!account) {
      const error = new Error("Shelf account not found");
      error.status = 404;
      throw error;
    }

    const servers = this.store.sqlite.prepare(`
      SELECT s.*, m.role
      FROM registered_servers s
      JOIN server_memberships m ON m.server_id = s.server_id
      WHERE m.account_id = ?
      ORDER BY CASE WHEN s.server_id = ? THEN 0 ELSE 1 END, s.name COLLATE NOCASE
    `).all(account.id, this.serverIdentity.serverId).map((row) => ({
      ...serverRow(row),
      role: row.role,
      libraries: this.listLibraries(account.id, row.server_id)
    }));

    return {
      account,
      currentServerId: this.serverIdentity.serverId,
      servers,
      pendingInvitations: this.listPendingInvitations(account),
      controlPlane: {
        mode: "combined",
        publicKey: this.controlPlaneIdentity.publicKey
      },
      separation: {
        friendshipsGrantLibraryAccess: false,
        playbackStateScope: "server"
      }
    };
  }

  overviewFromContext(userId, context) {
    const local = this.overview(userId);
    if (!Array.isArray(context?.servers) || !context.servers.length) return local;
    const byId = new Map(context.servers.map((server) => [server.serverId, server]));
    const localCurrent = local.servers.find((server) => server.serverId === local.currentServerId);
    if (localCurrent) byId.set(local.currentServerId, localCurrent);
    return {
      ...local,
      servers: [...byId.values()].sort((left, right) =>
        left.serverId === local.currentServerId ? -1 : right.serverId === local.currentServerId ? 1 :
          left.name.localeCompare(right.name)
      )
    };
  }

  getAccountPreferences(accountId) {
    const row = this.store.sqlite.prepare(`
      SELECT data_json, updated_at FROM account_platform_preferences WHERE account_id = ?
    `).get(accountId);
    return {
      selectedServerId: this.serverIdentity.serverId,
      pinnedServerIds: [],
      pinnedLibraryIds: [],
      ...(row ? safeJson(row.data_json, {}) : {}),
      updatedAt: row?.updated_at || null
    };
  }

  async setAccountPreferences(accountId, patch) {
    if (!this.getAccount(accountId)) {
      const error = new Error("Shelf account not found");
      error.status = 404;
      throw error;
    }
    const current = this.getAccountPreferences(accountId);
    const next = {
      selectedServerId: String(patch.selectedServerId || current.selectedServerId),
      pinnedServerIds: Array.isArray(patch.pinnedServerIds)
        ? [...new Set(patch.pinnedServerIds.map(String))].slice(0, 100)
        : current.pinnedServerIds,
      pinnedLibraryIds: Array.isArray(patch.pinnedLibraryIds)
        ? [...new Set(patch.pinnedLibraryIds.map(String))].slice(0, 200)
        : current.pinnedLibraryIds
    };
    const updatedAt = new Date().toISOString();
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        INSERT INTO account_platform_preferences (account_id, data_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET data_json = excluded.data_json,
          updated_at = excluded.updated_at
      `).run(accountId, JSON.stringify(next), updatedAt);
    });
    return { ...next, updatedAt };
  }

  listMembers(requesterId, serverId = this.serverIdentity.serverId) {
    this.requireRole(requesterId, ["owner", "admin"], serverId);
    return this.store.sqlite.prepare(`
      SELECT m.server_id, m.account_id, m.local_user_id, m.role,
             m.created_at, m.updated_at, a.username, a.display_name, a.email
      FROM server_memberships m
      JOIN platform_accounts a ON a.id = m.account_id
      WHERE m.server_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               a.display_name COLLATE NOCASE
    `).all(serverId).map((row) => ({
      ...membershipRow(row),
      account: accountRow({
        id: row.account_id,
        username: row.username,
        display_name: row.display_name,
        email: row.email,
        created_at: row.created_at,
        updated_at: row.updated_at
      }),
      libraryIds: this.store.sqlite.prepare(
        "SELECT library_id FROM library_access WHERE account_id = ? ORDER BY library_id"
      ).all(row.account_id).map((grant) => grant.library_id)
    }));
  }

  async updateMember(requesterId, accountId, patch, serverId = this.serverIdentity.serverId) {
    const requester = this.requireRole(requesterId, ["owner", "admin"], serverId);
    const target = this.getMembership(serverId, accountId);
    if (!target) {
      const error = new Error("Server member not found");
      error.status = 404;
      throw error;
    }
    if (target.role === "owner" || (requester.role === "admin" && patch.role === "owner")) {
      const error = new Error("Only ownership transfer can change the server owner");
      error.status = 400;
      throw error;
    }
    const role = INVITABLE_ROLES.has(patch.role) ? patch.role : target.role;
    await this.upsertMembership({ ...target, role });
    const localUser = target.localUserId ? this.store.getUser(target.localUserId) : null;
    if (localUser) {
      await this.store.updateUser(localUser.id, { role: role === "admin" ? "admin" : "reader" });
    }
    if (Array.isArray(patch.libraryIds)) {
      await this.replaceLibraryAccess(accountId, patch.libraryIds, serverId);
    }
    return this.getMembership(serverId, accountId);
  }

  async removeMember(requesterId, accountId, serverId = this.serverIdentity.serverId) {
    const requester = this.requireRole(requesterId, ["owner", "admin"], serverId);
    const target = this.getMembership(serverId, accountId);
    if (!target) return false;
    if (target.role === "owner" || requester.accountId === accountId) {
      const error = new Error("The server owner cannot be removed");
      error.status = 400;
      throw error;
    }
    if (requester.role === "admin" && target.role === "admin") {
      const error = new Error("Only the owner can remove another administrator");
      error.status = 403;
      throw error;
    }
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare("DELETE FROM library_access WHERE account_id = ?").run(accountId);
      sqlite.prepare("DELETE FROM server_memberships WHERE server_id = ? AND account_id = ?")
        .run(serverId, accountId);
    });
    return true;
  }

  listInvitations(requesterId, serverId = this.serverIdentity.serverId) {
    this.requireRole(requesterId, ["owner", "admin"], serverId);
    return this.store.sqlite.prepare(`
      SELECT id, server_id, inviter_account_id, recipient, role, library_ids_json,
             created_at, expires_at, accepted_at, accepted_by_account_id, revoked_at
      FROM server_invitations WHERE server_id = ? ORDER BY created_at DESC
    `).all(serverId).map(invitationRow);
  }

  async createInvitation(requesterId, input, serverId = this.serverIdentity.serverId) {
    const requester = this.requireRole(requesterId, ["owner", "admin"], serverId);
    const role = INVITABLE_ROLES.has(input.role) ? input.role : "member";
    if (requester.role === "admin" && role === "admin") {
      const error = new Error("Only the server owner can invite another administrator");
      error.status = 403;
      throw error;
    }
    const libraryIds = this.validateLibraryIds(input.libraryIds, serverId);
    const secret = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const invitation = {
      id: `inv_${nanoid(18)}`,
      serverId,
      inviterAccountId: requesterId,
      recipient: String(input.recipient || "").trim().toLowerCase().slice(0, 254) || null,
      role,
      libraryIds,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITATION_TTL_MS).toISOString()
    };
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        INSERT INTO server_invitations (
          id, server_id, inviter_account_id, recipient, role, library_ids_json,
          secret_hash, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        invitation.id,
        invitation.serverId,
        invitation.inviterAccountId,
        invitation.recipient,
        invitation.role,
        JSON.stringify(invitation.libraryIds),
        hashSecret(secret),
        invitation.createdAt,
        invitation.expiresAt
      );
    });
    return {
      ...invitation,
      token: secret,
      invitePath: `/?invite=${encodeURIComponent(secret)}`
    };
  }

  async revokeInvitation(requesterId, invitationId) {
    const row = this.store.sqlite.prepare(
      "SELECT server_id FROM server_invitations WHERE id = ?"
    ).get(invitationId);
    if (!row) return false;
    this.requireRole(requesterId, ["owner", "admin"], row.server_id);
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        UPDATE server_invitations SET revoked_at = ?
        WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL
      `).run(new Date().toISOString(), invitationId);
    });
    return true;
  }

  async acceptInvitation(accountId, token) {
    const account = this.getAccount(accountId);
    if (!account) {
      const error = new Error("Shelf account not found");
      error.status = 404;
      throw error;
    }
    const row = this.store.sqlite.prepare(`
      SELECT * FROM server_invitations WHERE secret_hash = ?
    `).get(hashSecret(String(token || "")));
    if (!row || row.revoked_at || row.accepted_at || Date.parse(row.expires_at) <= Date.now()) {
      const error = new Error("This server invitation is invalid or has expired");
      error.status = 400;
      throw error;
    }
    if (row.recipient && ![account.username, account.email].filter(Boolean).includes(row.recipient)) {
      const error = new Error("This invitation was issued to a different Shelf account");
      error.status = 403;
      throw error;
    }
    await this.upsertMembership({
      serverId: row.server_id,
      accountId,
      localUserId: row.server_id === this.serverIdentity.serverId ? accountId : null,
      role: row.role
    });
    const libraryIds = safeJson(row.library_ids_json, []);
    await this.replaceLibraryAccess(accountId, libraryIds, row.server_id);
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        UPDATE server_invitations SET accepted_at = ?, accepted_by_account_id = ? WHERE id = ?
      `).run(new Date().toISOString(), accountId, row.id);
    });
    return this.overview(accountId);
  }

  listPendingInvitations(account) {
    const identities = [account.username, account.email].filter(Boolean);
    if (!identities.length) return [];
    const placeholders = identities.map(() => "?").join(", ");
    return this.store.sqlite.prepare(`
      SELECT i.id, i.server_id, i.inviter_account_id, i.recipient, i.role,
             i.library_ids_json, i.created_at, i.expires_at, i.accepted_at,
             i.accepted_by_account_id, i.revoked_at, s.name AS server_name
      FROM server_invitations i
      JOIN registered_servers s ON s.server_id = i.server_id
      WHERE i.recipient IN (${placeholders}) AND i.accepted_at IS NULL
        AND i.revoked_at IS NULL AND i.expires_at > ?
      ORDER BY i.created_at DESC
    `).all(...identities, new Date().toISOString()).map((row) => ({
      ...invitationRow(row),
      serverName: row.server_name
    }));
  }

  listLibraries(accountId, serverId = this.serverIdentity.serverId) {
    const membership = this.getMembership(serverId, accountId);
    if (!membership) return [];
    const ownerOrAdmin = membership.role === "owner" || membership.role === "admin";
    const rows = this.store.sqlite.prepare(`
      SELECT l.*,
             (SELECT COUNT(*) FROM library_items li WHERE li.library_id = l.id) AS item_count,
             EXISTS(
               SELECT 1 FROM library_access la
               WHERE la.library_id = l.id AND la.account_id = ?
             ) AS explicitly_granted
      FROM libraries l WHERE l.server_id = ? AND l.enabled = 1
      ORDER BY l.sort_order, l.name COLLATE NOCASE
    `).all(accountId, serverId);
    const hasExplicitGrants = rows.some((row) => Boolean(row.explicitly_granted));
    return rows
      .filter((row) => ownerOrAdmin || !hasExplicitGrants || Boolean(row.explicitly_granted))
      .map(libraryRow);
  }

  async createLibrary(accountId, input) {
    this.requireRole(accountId, ["owner", "admin"]);
    const name = String(input.name || "").trim().slice(0, 80);
    const mediaType = LIBRARY_TYPES.has(input.mediaType) ? input.mediaType : "mixed";
    if (!name) {
      const error = new Error("Library name is required");
      error.status = 400;
      throw error;
    }
    const rootPath = normalizeLibraryPath(input.rootPath || this.libraryRoot, this.libraryRoot);
    const now = new Date().toISOString();
    const library = {
      id: `lib_${nanoid(18)}`,
      serverId: this.serverIdentity.serverId,
      name,
      mediaType,
      rootPath,
      createdByAccountId: accountId,
      createdAt: now,
      updatedAt: now
    };
    await this.store.queueSqliteWrite((sqlite) => {
      const order = Number(sqlite.prepare(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM libraries WHERE server_id = ?"
      ).get(this.serverIdentity.serverId).value);
      sqlite.prepare(`
        INSERT INTO libraries (
          id, server_id, name, media_type, root_path, enabled, sort_order,
          created_by_account_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        library.id,
        library.serverId,
        library.name,
        library.mediaType,
        library.rootPath,
        order,
        accountId,
        now,
        now
      );
    });
    await this.reconcileBooks(this.store.listBooks());
    return this.listLibraries(accountId).find((item) => item.id === library.id);
  }

  async updateLibrary(accountId, libraryId, patch) {
    this.requireRole(accountId, ["owner", "admin"]);
    const current = this.store.sqlite.prepare("SELECT * FROM libraries WHERE id = ? AND server_id = ?")
      .get(libraryId, this.serverIdentity.serverId);
    if (!current) {
      const error = new Error("Library not found");
      error.status = 404;
      throw error;
    }
    const name = patch.name === undefined ? current.name : String(patch.name).trim().slice(0, 80);
    const mediaType = LIBRARY_TYPES.has(patch.mediaType) ? patch.mediaType : current.media_type;
    const rootPath = patch.rootPath === undefined
      ? current.root_path
      : normalizeLibraryPath(patch.rootPath, this.libraryRoot);
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        UPDATE libraries SET name = ?, media_type = ?, root_path = ?, updated_at = ?
        WHERE id = ? AND server_id = ?
      `).run(name, mediaType, rootPath, new Date().toISOString(), libraryId, this.serverIdentity.serverId);
    });
    await this.reconcileBooks(this.store.listBooks());
    return this.listLibraries(accountId).find((item) => item.id === libraryId);
  }

  async deleteLibrary(accountId, libraryId) {
    this.requireRole(accountId, ["owner", "admin"]);
    const count = Number(this.store.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM libraries WHERE server_id = ? AND enabled = 1"
    ).get(this.serverIdentity.serverId).count);
    if (count <= 1) {
      const error = new Error("A server must keep at least one library");
      error.status = 400;
      throw error;
    }
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare("UPDATE libraries SET enabled = 0, updated_at = ? WHERE id = ? AND server_id = ?")
        .run(new Date().toISOString(), libraryId, this.serverIdentity.serverId);
    });
  }

  getBookLibraryIds(bookId) {
    return this.store.sqlite.prepare(`
      SELECT library_id FROM library_items WHERE book_id = ? ORDER BY library_id
    `).all(bookId).map((row) => row.library_id);
  }

  canAccessBook(accountId, bookId, serverId = this.serverIdentity.serverId) {
    const allowed = new Set(this.listLibraries(accountId, serverId).map((library) => library.id));
    return this.getBookLibraryIds(bookId).some((libraryId) => allowed.has(libraryId));
  }

  async reconcileBooks(books) {
    const libraries = this.store.sqlite.prepare(`
      SELECT id, media_type, root_path FROM libraries
      WHERE server_id = ? AND enabled = 1 ORDER BY sort_order
    `).all(this.serverIdentity.serverId);
    const now = new Date().toISOString();
    await this.store.queueSqliteWrite((sqlite) => {
      const insert = sqlite.prepare(`
        INSERT INTO library_items (library_id, book_id, added_at)
        VALUES (?, ?, ?) ON CONFLICT(library_id, book_id) DO NOTHING
      `);
      const remove = sqlite.prepare("DELETE FROM library_items WHERE book_id = ?");
      for (const book of books) {
        remove.run(book.id);
        const mediaType = book.mediaType === "audiobook" ? "audiobook" : "ebook";
        const bookPath = path.resolve(this.libraryRoot, book.relPath || book.filename || "");
        let matches = libraries.filter((library) => {
          const typeMatches = library.media_type === "mixed" || library.media_type === mediaType;
          const rootMatches = isPathWithin(bookPath, path.resolve(library.root_path));
          return typeMatches && rootMatches;
        });
        if (!matches.length) {
          matches = libraries.filter((library) => library.media_type === "mixed" || library.media_type === mediaType).slice(0, 1);
        }
        for (const library of matches) insert.run(library.id, book.id, now);
      }
    });
  }

  async ensureDefaultLibraries(createdByAccountId) {
    const current = this.store.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM libraries WHERE server_id = ?"
    ).get(this.serverIdentity.serverId);
    if (Number(current.count) > 0) return;
    const now = new Date().toISOString();
    await this.store.queueSqliteWrite((sqlite) => {
      const insert = sqlite.prepare(`
        INSERT INTO libraries (
          id, server_id, name, media_type, root_path, enabled, sort_order,
          created_by_account_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `);
      insert.run(`lib_${nanoid(18)}`, this.serverIdentity.serverId, "Books", "ebook", this.libraryRoot, 0, createdByAccountId, now, now);
      insert.run(`lib_${nanoid(18)}`, this.serverIdentity.serverId, "Audiobooks", "audiobook", this.libraryRoot, 1, createdByAccountId, now, now);
    });
  }

  validateLibraryIds(libraryIds, serverId) {
    if (!Array.isArray(libraryIds) || !libraryIds.length) return [];
    const valid = new Set(this.store.sqlite.prepare(
      "SELECT id FROM libraries WHERE server_id = ? AND enabled = 1"
    ).all(serverId).map((row) => row.id));
    return [...new Set(libraryIds.map(String).filter((id) => valid.has(id)))];
  }

  async replaceLibraryAccess(accountId, libraryIds, serverId) {
    const selected = this.validateLibraryIds(libraryIds, serverId);
    const now = new Date().toISOString();
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        DELETE FROM library_access
        WHERE account_id = ? AND library_id IN (SELECT id FROM libraries WHERE server_id = ?)
      `).run(accountId, serverId);
      const insert = sqlite.prepare(`
        INSERT INTO library_access (library_id, account_id, can_download, created_at)
        VALUES (?, ?, 1, ?)
      `);
      for (const libraryId of selected) insert.run(libraryId, accountId, now);
    });
  }

  async setEndpoint(accountId, endpointUrl) {
    this.requireRole(accountId, ["owner"]);
    const endpoint = normalizeEndpoint(endpointUrl);
    const identity = await fetchServerIdentity(endpoint);
    if (identity.serverId !== this.serverIdentity.serverId || identity.publicKey !== this.serverIdentity.publicKey) {
      const error = new Error("That URL does not identify this Shelf server");
      error.status = 400;
      throw error;
    }
    const now = new Date().toISOString();
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        UPDATE registered_servers
        SET endpoint_url = ?, endpoint_verified_at = ?, status = 'online', updated_at = ?
        WHERE server_id = ?
      `).run(endpoint, now, now, this.serverIdentity.serverId);
    });
    return this.overview(accountId);
  }

  async claimRemoteServer(accountId, { endpointUrl, claimCode }) {
    const account = this.getAccount(accountId);
    if (!account) {
      const error = new Error("Shelf account not found");
      error.status = 404;
      throw error;
    }
    const endpoint = normalizeEndpoint(endpointUrl);
    const identity = await fetchServerIdentity(endpoint);
    if (!identity.serverId || !identity.publicKey) {
      const error = new Error("The remote server did not publish a valid Shelf identity");
      error.status = 400;
      throw error;
    }

    const response = await fetch(`${endpoint}/api/server/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        claimCode,
        endpointUrl: endpoint,
        account,
        controlPlanePublicKey: this.controlPlaneIdentity.publicKey,
        controlPlaneUrl: this.publicUrl
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.serverId !== identity.serverId) {
      const error = new Error(body.error || `The remote server rejected the claim (${response.status})`);
      error.status = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw error;
    }

    const now = new Date().toISOString();
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        INSERT INTO registered_servers (
          server_id, name, public_key, owner_account_id, endpoint_url,
          endpoint_verified_at, status, capabilities_json, claimed_at,
          last_seen_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          name = excluded.name,
          public_key = excluded.public_key,
          owner_account_id = excluded.owner_account_id,
          endpoint_url = excluded.endpoint_url,
          endpoint_verified_at = excluded.endpoint_verified_at,
          status = 'online',
          capabilities_json = excluded.capabilities_json,
          claimed_at = COALESCE(registered_servers.claimed_at, excluded.claimed_at),
          last_seen_at = excluded.last_seen_at,
          updated_at = excluded.updated_at
      `).run(
        identity.serverId,
        String(identity.name || "Shelf Server").trim().slice(0, 100),
        identity.publicKey,
        accountId,
        endpoint,
        now,
        JSON.stringify(Array.isArray(identity.capabilities) ? identity.capabilities : []),
        now,
        now,
        now,
        now
      );
    });
    await this.upsertMembership({ serverId: identity.serverId, accountId, role: "owner" });
    return this.overview(accountId);
  }

  async createClaimCode(requesterId = null) {
    const registration = this.getServerRegistration(this.serverIdentity.serverId);
    if (registration?.ownerAccountId && requesterId) {
      this.requireRole(requesterId, ["owner"]);
    } else if (registration?.ownerAccountId && !requesterId) {
      const error = new Error("This server is already claimed");
      error.status = 409;
      throw error;
    }
    const code = crypto.randomBytes(6).toString("hex").toUpperCase();
    const now = new Date();
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        INSERT INTO server_claim_codes (server_id, secret_hash, created_at, expires_at, used_at)
        VALUES (?, ?, ?, ?, NULL)
        ON CONFLICT(server_id) DO UPDATE SET secret_hash = excluded.secret_hash,
          created_at = excluded.created_at, expires_at = excluded.expires_at, used_at = NULL
      `).run(
        this.serverIdentity.serverId,
        hashSecret(code),
        now.toISOString(),
        new Date(now.getTime() + CLAIM_TTL_MS).toISOString()
      );
    });
    return { code, expiresAt: new Date(now.getTime() + CLAIM_TTL_MS).toISOString() };
  }

  async claimLocalServer({
    claimCode,
    account,
    endpointUrl = "",
    controlPlanePublicKey = "",
    controlPlaneUrl = ""
  }) {
    const row = this.store.sqlite.prepare(
      "SELECT * FROM server_claim_codes WHERE server_id = ?"
    ).get(this.serverIdentity.serverId);
    if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now() ||
        !timingSafeStringEqual(row.secret_hash, hashSecret(String(claimCode || "").toUpperCase()))) {
      const error = new Error("The server claim code is invalid or has expired");
      error.status = 400;
      throw error;
    }
    const localUser = await this.store.ensurePlatformUser({
      accountId: account.id,
      username: account.username,
      displayName: account.displayName,
      role: "owner"
    });
    this.ensureAccount(localUser, account.email || "");
    const now = new Date().toISOString();
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare("UPDATE server_claim_codes SET used_at = ? WHERE server_id = ?")
        .run(now, this.serverIdentity.serverId);
      sqlite.prepare(`
        UPDATE server_memberships SET role = 'admin', updated_at = ?
        WHERE server_id = ? AND role = 'owner' AND account_id <> ?
      `).run(now, this.serverIdentity.serverId, account.id);
      sqlite.prepare(`
        UPDATE registered_servers SET owner_account_id = ?, claimed_at = ?,
          endpoint_url = COALESCE(NULLIF(?, ''), endpoint_url), updated_at = ?
        WHERE server_id = ?
      `).run(account.id, now, normalizeEndpoint(endpointUrl, { allowEmpty: true }), now, this.serverIdentity.serverId);
      if (controlPlanePublicKey) {
        sqlite.prepare(`
          INSERT INTO metadata (key, value) VALUES ('trusted_control_plane_public_key', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(controlPlanePublicKey);
      }
      if (controlPlaneUrl) {
        sqlite.prepare(`
          INSERT INTO metadata (key, value) VALUES ('control_plane_url', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(normalizeEndpoint(controlPlaneUrl));
      }
    });
    await this.upsertMembership({
      serverId: this.serverIdentity.serverId,
      accountId: account.id,
      localUserId: localUser.id,
      role: "owner"
    });
    return this.getServerRegistration(this.serverIdentity.serverId);
  }

  getServerRegistration(serverId) {
    const row = this.store.sqlite.prepare("SELECT * FROM registered_servers WHERE server_id = ?").get(serverId);
    return row ? serverRow(row) : null;
  }

  async createConnectionTicket(accountId, serverId) {
    const membership = this.getMembership(serverId, accountId);
    const server = this.getServerRegistration(serverId);
    const account = this.getAccount(accountId);
    if (!membership || !server || !account) {
      const error = new Error("Server access is not available for this account");
      error.status = 404;
      throw error;
    }
    if (!server.endpointUrl && serverId !== this.serverIdentity.serverId) {
      const error = new Error("This server does not have a verified remote address");
      error.status = 409;
      throw error;
    }
    const nonce = crypto.randomBytes(18).toString("base64url");
    const now = Date.now();
    const directory = this.overview(accountId).servers.map((item) => ({
      ...item,
      publicKey: undefined
    }));
    const delegation = signEnvelope({
      iss: "shelfstream-control-plane",
      aud: "shelfstream-control-plane",
      sub: accountId,
      scope: "connection-ticket",
      iat: Math.floor(now / 1000),
      exp: Math.floor((now + DELEGATION_TTL_MS) / 1000),
      nonce: crypto.randomBytes(18).toString("base64url")
    }, this.controlPlaneIdentity.privateKey);
    const payload = {
      iss: "shelfstream-control-plane",
      aud: serverId,
      sub: accountId,
      username: account.username,
      displayName: account.displayName,
      role: membership.role,
      iat: Math.floor(now / 1000),
      exp: Math.floor((now + TICKET_TTL_MS) / 1000),
      nonce,
      context: {
        servers: directory,
        controlPlaneUrl: this.publicUrl,
        delegation
      }
    };
    const ticket = signEnvelope(payload, this.controlPlaneIdentity.privateKey);
    await this.store.queueSqliteWrite((sqlite) => {
      sqlite.prepare(`
        INSERT INTO connection_ticket_nonces (nonce, server_id, account_id, expires_at, used_at)
        VALUES (?, ?, ?, ?, NULL)
      `).run(nonce, serverId, accountId, new Date(now + TICKET_TTL_MS).toISOString());
      sqlite.prepare("DELETE FROM connection_ticket_nonces WHERE expires_at < ?")
        .run(new Date(now - 60_000).toISOString());
    });
    return {
      serverId,
      endpointUrl: server.endpointUrl || this.publicUrl || "",
      ticket,
      expiresAt: new Date(now + TICKET_TTL_MS).toISOString()
    };
  }

  async exchangeConnectionTicket(ticket) {
    const trustedKey = this.trustedControlPlanePublicKey();
    const payload = verifyEnvelope(ticket, trustedKey);
    if (payload.aud !== this.serverIdentity.serverId || payload.iss !== "shelfstream-control-plane") {
      const error = new Error("Connection ticket was issued for a different server");
      error.status = 403;
      throw error;
    }
    if (!payload.exp || payload.exp * 1000 <= Date.now()) {
      const error = new Error("Connection ticket has expired");
      error.status = 401;
      throw error;
    }
    await this.consumeTicketNonce(payload);
    const user = await this.store.ensurePlatformUser({
      accountId: payload.sub,
      username: payload.username,
      displayName: payload.displayName,
      role: payload.role
    });
    this.ensureAccount(user);
    await this.upsertMembership({
      serverId: this.serverIdentity.serverId,
      accountId: payload.sub,
      localUserId: user.id,
      role: payload.role
    });
    return { user, accountId: payload.sub, serverRole: payload.role, context: payload.context || null };
  }

  verifyDelegation(delegation) {
    const payload = verifyEnvelope(delegation, this.controlPlaneIdentity.publicKey);
    if (payload.iss !== "shelfstream-control-plane" || payload.aud !== "shelfstream-control-plane" ||
        payload.scope !== "connection-ticket" || !payload.exp || payload.exp * 1000 <= Date.now()) {
      const error = new Error("Account delegation is invalid or has expired");
      error.status = 401;
      throw error;
    }
    return payload;
  }

  async requestDelegatedConnectionTicket(context, serverId) {
    const controlPlaneUrl = normalizeEndpoint(context?.controlPlaneUrl || this.controlPlaneUrl());
    const response = await fetch(`${controlPlaneUrl}/api/platform/delegated/ticket`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ delegation: context?.delegation, serverId })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `The Shelf account service returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  controlPlaneUrl() {
    return this.store.sqlite.prepare("SELECT value FROM metadata WHERE key = 'control_plane_url'").get()?.value || "";
  }

  trustedControlPlanePublicKey() {
    const configured = this.store.sqlite.prepare(
      "SELECT value FROM metadata WHERE key = 'trusted_control_plane_public_key'"
    ).get()?.value;
    return configured || this.controlPlaneIdentity.publicKey;
  }

  async consumeTicketNonce(payload) {
    const now = new Date().toISOString();
    let accepted = false;
    await this.store.queueSqliteWrite((sqlite) => {
      const existing = sqlite.prepare("SELECT used_at, expires_at FROM connection_ticket_nonces WHERE nonce = ?")
        .get(payload.nonce);
      if (existing?.used_at || (existing && Date.parse(existing.expires_at) <= Date.now())) return;
      if (existing) {
        sqlite.prepare("UPDATE connection_ticket_nonces SET used_at = ? WHERE nonce = ?")
          .run(now, payload.nonce);
      } else {
        sqlite.prepare(`
          INSERT INTO connection_ticket_nonces (nonce, server_id, account_id, expires_at, used_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(payload.nonce, payload.aud, payload.sub, new Date(payload.exp * 1000).toISOString(), now);
      }
      accepted = true;
    });
    if (!accepted) {
      const error = new Error("Connection ticket has already been used");
      error.status = 409;
      throw error;
    }
  }
}

function ensureControlPlaneIdentity(sqlite) {
  const existing = sqlite.prepare(`
    SELECT public_key, private_key, created_at FROM control_plane_identity WHERE singleton = 1
  `).get();
  if (existing) {
    return { publicKey: existing.public_key, privateKey: existing.private_key, createdAt: existing.created_at };
  }
  const keys = crypto.generateKeyPairSync("ed25519");
  const identity = {
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    createdAt: new Date().toISOString()
  };
  sqlite.prepare(`
    INSERT INTO control_plane_identity (singleton, public_key, private_key, created_at)
    VALUES (1, ?, ?, ?)
  `).run(identity.publicKey, identity.privateKey, identity.createdAt);
  return identity;
}

function accountRow(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function membershipRow(row) {
  return {
    serverId: row.server_id,
    accountId: row.account_id,
    localUserId: row.local_user_id || null,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serverRow(row) {
  return {
    serverId: row.server_id,
    name: row.name,
    publicKey: row.public_key,
    ownerAccountId: row.owner_account_id || null,
    endpointUrl: row.endpoint_url || null,
    endpointVerifiedAt: row.endpoint_verified_at || null,
    status: row.status,
    capabilities: safeJson(row.capabilities_json, []),
    claimedAt: row.claimed_at || null,
    lastSeenAt: row.last_seen_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function libraryRow(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    mediaType: row.media_type,
    rootPath: row.root_path,
    enabled: Boolean(row.enabled),
    sortOrder: Number(row.sort_order),
    itemCount: Number(row.item_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function invitationRow(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    inviterAccountId: row.inviter_account_id,
    recipient: row.recipient || null,
    role: row.role,
    libraryIds: safeJson(row.library_ids_json, []),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at || null,
    acceptedByAccountId: row.accepted_by_account_id || null,
    revokedAt: row.revoked_at || null
  };
}

function defaultCapabilities() {
  return [
    "ebooks",
    "audiobooks",
    "offline",
    "progress",
    "multi-user",
    "libraries",
    "invitations",
    "connection-tickets",
    "server-scoped-sync"
  ];
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function timingSafeStringEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeEndpoint(value, { allowEmpty = false } = {}) {
  const text = String(value || "").trim().replace(/\/+$/, "");
  if (!text && allowEmpty) return "";
  let url;
  try {
    url = new URL(text);
  } catch {
    const error = new Error("Enter a complete server URL, including https://");
    error.status = 400;
    throw error;
  }
  const localHttp = url.protocol === "http:" && isPrivateHostname(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    const error = new Error("Remote Shelf servers must use HTTPS");
    error.status = 400;
    throw error;
  }
  if (url.username || url.password || url.search || url.hash) {
    const error = new Error("Server URLs cannot contain credentials, query parameters, or fragments");
    error.status = 400;
    throw error;
  }
  return url.toString().replace(/\/$/, "");
}

function isPrivateHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" ||
    /^10\./.test(hostname) || /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) || hostname.endsWith(".local");
}

async function fetchServerIdentity(endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${endpoint}/.well-known/shelfstream-server`, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Server identity check returned ${response.status}`);
    return response.json();
  } catch (cause) {
    const error = new Error(`Shelf could not verify that server address: ${cause.message}`);
    error.status = 400;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLibraryPath(value, allowedRoot) {
  const resolved = path.resolve(String(value || ""));
  if (!isPathWithin(resolved, path.resolve(allowedRoot))) {
    const error = new Error(`Library folders must be inside ${allowedRoot}`);
    error.status = 400;
    throw error;
  }
  return resolved;
}

function isPathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function signEnvelope(payload, privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "SST" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const content = `${header}.${body}`;
  const signature = crypto.sign(null, Buffer.from(content), crypto.createPrivateKey(privateKey));
  return `${content}.${signature.toString("base64url")}`;
}

function verifyEnvelope(ticket, publicKey) {
  const [header, body, signature, extra] = String(ticket || "").split(".");
  if (!header || !body || !signature || extra) {
    const error = new Error("Connection ticket is malformed");
    error.status = 400;
    throw error;
  }
  const content = `${header}.${body}`;
  const valid = crypto.verify(
    null,
    Buffer.from(content),
    crypto.createPublicKey(publicKey),
    Buffer.from(signature, "base64url")
  );
  if (!valid) {
    const error = new Error("Connection ticket signature is invalid");
    error.status = 403;
    throw error;
  }
  return safeJson(Buffer.from(body, "base64url").toString("utf8"), {});
}
