const DEFAULT_ACTIVITY_TTL_MS = 45_000;

export class ActivityTracker {
  constructor({ ttlMs = DEFAULT_ACTIVITY_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  update(userId, bookId, percent = 0) {
    const now = Date.now();
    const current = this.sessions.get(userId);
    const startedAt = current?.bookId === bookId ? current.startedAt : now;
    const activity = {
      userId,
      bookId,
      percent: clampPercent(percent),
      startedAt,
      lastSeenAt: now
    };

    this.sessions.set(userId, activity);
    return activity;
  }

  remove(userId) {
    this.sessions.delete(userId);
  }

  list() {
    const now = Date.now();
    for (const [userId, activity] of this.sessions) {
      if (now - activity.lastSeenAt > this.ttlMs) {
        this.sessions.delete(userId);
      }
    }

    return [...this.sessions.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.min(1, Math.max(0, numeric));
}
