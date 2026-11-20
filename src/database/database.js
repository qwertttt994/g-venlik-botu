const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config/config');

const dataDir = path.join(process.cwd(), 'data');
const backupDir = path.join(dataDir, 'backups');
fs.mkdirSync(backupDir, { recursive: true });

const dbFile = path.join(dataDir, 'security-core.db');
const db = new Database(dbFile);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );

  INSERT OR IGNORE INTO counters (name, value) VALUES ('case_seq', 0);
  INSERT OR IGNORE INTO counters (name, value) VALUES ('appeal_seq', 0);

  CREATE TABLE IF NOT EXISTS guild_config (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    config_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blacklist (
    user_id TEXT PRIMARY KEY,
    banned_by TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS whitelist (
    target_id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL CHECK(target_type IN ('user', 'role')),
    added_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    meta_json TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS warnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    moderator_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS risk_scores (
    user_id TEXT PRIMARY KEY,
    score INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS risk_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    score_after INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS quarantine (
    user_id TEXT PRIMARY KEY,
    roles_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    expires_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS appeals (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    reviewed_by TEXT,
    review_note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS action_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target_id TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
`);

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    if (Array.isArray(v)) {
      out[k] = [...v];
    } else if (v && typeof v === 'object' && out[k] && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function getGuildConfig() {
  const row = db.prepare('SELECT config_json FROM guild_config WHERE id = 1').get();
  if (!row) {
    const initial = structuredClone(config.defaults);
    db.prepare('INSERT OR REPLACE INTO guild_config (id, config_json, updated_at) VALUES (1, ?, ?)').run(
      JSON.stringify(initial),
      Date.now()
    );
    return initial;
  }
  try {
    return deepMerge(config.defaults, JSON.parse(row.config_json));
  } catch {
    return structuredClone(config.defaults);
  }
}

function saveGuildConfig(nextConfig) {
  const merged = deepMerge(config.defaults, nextConfig);
  db.prepare('INSERT OR REPLACE INTO guild_config (id, config_json, updated_at) VALUES (1, ?, ?)').run(
    JSON.stringify(merged),
    Date.now()
  );
  return merged;
}

function updateGuildConfigPatch(patchFn) {
  const tx = db.transaction(() => {
    const current = getGuildConfig();
    const updated = patchFn(current) || current;
    return saveGuildConfig(updated);
  });
  return tx();
}

function nextCaseId() {
  const tx = db.transaction(() => {
    db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run('case_seq');
    const row = db.prepare('SELECT value FROM counters WHERE name = ?').get('case_seq');
    const seq = Number(row.value);
    return { seq, id: `CASE-${String(seq).padStart(4, '0')}` };
  });
  return tx();
}

function nextAppealId() {
  const tx = db.transaction(() => {
    db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run('appeal_seq');
    const row = db.prepare('SELECT value FROM counters WHERE name = ?').get('appeal_seq');
    const seq = Number(row.value);
    return { seq, id: `APL-${String(seq).padStart(4, '0')}` };
  });
  return tx();
}

function createCase({ type, targetId, moderatorId, reason, meta = null }) {
  const tx = db.transaction(() => {
    const { seq, id } = nextCaseId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO cases (id, seq, type, target_id, moderator_id, reason, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      seq,
      type,
      String(targetId),
      String(moderatorId),
      String(reason || 'Sebep belirtilmedi').slice(0, 500),
      meta ? JSON.stringify(meta).slice(0, 2000) : null,
      now
    );
    return { id, seq, type, targetId, moderatorId, reason, createdAt: now };
  });
  return tx();
}

function deleteCaseById(caseId) {
  const normalized = String(caseId).trim().toUpperCase();
  const info = db.prepare('DELETE FROM cases WHERE id = ?').run(normalized);
  return info.changes > 0;
}

function getRecentCasesForUser(userId, limit = 5) {
  return db
    .prepare('SELECT * FROM cases WHERE target_id = ? ORDER BY seq DESC LIMIT ?')
    .all(String(userId), limit);
}

function getTotalCases() {
  return db.prepare('SELECT COUNT(*) AS cnt FROM cases').get().cnt;
}

function getCaseStatsByType() {
  return db
    .prepare('SELECT type, COUNT(*) AS cnt FROM cases GROUP BY type ORDER BY cnt DESC')
    .all();
}

function addBlacklist(userId, bannedBy, reason) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO blacklist (user_id, banned_by, reason, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       banned_by = excluded.banned_by,
       reason = excluded.reason,
       created_at = excluded.created_at`
  ).run(String(userId), String(bannedBy), String(reason || 'Sebep belirtilmedi').slice(0, 500), now);
}

function removeBlacklist(userId) {
  const info = db.prepare('DELETE FROM blacklist WHERE user_id = ?').run(String(userId));
  return info.changes > 0;
}

function getBlacklist(userId) {
  return db.prepare('SELECT * FROM blacklist WHERE user_id = ?').get(String(userId)) || null;
}

function countBlacklist() {
  return db.prepare('SELECT COUNT(*) AS cnt FROM blacklist').get().cnt;
}

function addWhitelist(targetId, targetType, addedBy) {
  db.prepare(
    `INSERT OR REPLACE INTO whitelist (target_id, target_type, added_by, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(String(targetId), targetType, String(addedBy), Date.now());
}

function removeWhitelist(targetId) {
  const info = db.prepare('DELETE FROM whitelist WHERE target_id = ?').run(String(targetId));
  return info.changes > 0;
}

function isWhitelistedId(id) {
  return Boolean(db.prepare('SELECT 1 FROM whitelist WHERE target_id = ?').get(String(id)));
}

function listWhitelist() {
  return db.prepare('SELECT * FROM whitelist ORDER BY created_at DESC').all();
}

function addWarning(userId, moderatorId, reason) {
  db.prepare(
    'INSERT INTO warnings (user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?)'
  ).run(String(userId), String(moderatorId), String(reason).slice(0, 500), Date.now());
  return db.prepare('SELECT COUNT(*) AS cnt FROM warnings WHERE user_id = ?').get(String(userId)).cnt;
}

function getWarningsCount(userId) {
  return db.prepare('SELECT COUNT(*) AS cnt FROM warnings WHERE user_id = ?').get(String(userId)).cnt;
}

function addRisk(userId, delta, reason = 'Risk guncellemesi') {
  const tx = db.transaction(() => {
    const now = Date.now();
    const currentRow = db.prepare('SELECT score FROM risk_scores WHERE user_id = ?').get(String(userId));
    const current = currentRow ? Number(currentRow.score) : 0;
    const change = Number(delta || 0);
    const next = Math.max(0, Math.min(100, current + change));
    db.prepare(
      `INSERT INTO risk_scores (user_id, score, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`
    ).run(String(userId), next, now);
    db.prepare(
      'INSERT INTO risk_history (user_id, delta, score_after, reason, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(String(userId), change, next, String(reason).slice(0, 250), now);
    return next;
  });
  return tx();
}

function getRisk(userId) {
  const row = db.prepare('SELECT score FROM risk_scores WHERE user_id = ?').get(String(userId));
  return row ? Number(row.score) : 0;
}

function getRiskHistory(userId, limit = 6) {
  return db
    .prepare('SELECT * FROM risk_history WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(String(userId), limit);
}

function decayLowRisks(amount = 5, maxTargetScore = 30) {
  const now = Date.now();
  const tx = db.transaction(() => {
    const rows = db
      .prepare('SELECT user_id, score FROM risk_scores WHERE score > 0 AND score <= ?')
      .all(maxTargetScore);
    let updated = 0;
    for (const r of rows) {
      const next = Math.max(0, Number(r.score) - amount);
      db.prepare('UPDATE risk_scores SET score = ?, updated_at = ? WHERE user_id = ?').run(
        next,
        now,
        r.user_id
      );
      updated++;
    }
    return updated;
  });
  return tx();
}

function setQuarantine(userId, roleIds, reason, expiresAt = null) {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO quarantine (user_id, roles_json, reason, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    String(userId),
    JSON.stringify(roleIds),
    String(reason || 'Karantina').slice(0, 500),
    expiresAt ? Number(expiresAt) : null,
    now
  );
}

function getQuarantine(userId) {
  const row = db.prepare('SELECT * FROM quarantine WHERE user_id = ?').get(String(userId));
  if (!row) return null;
  return { ...row, roles: JSON.parse(row.roles_json || '[]') };
}

function deleteQuarantine(userId) {
  db.prepare('DELETE FROM quarantine WHERE user_id = ?').run(String(userId));
}

function getExpiredQuarantines(now = Date.now()) {
  return db
    .prepare('SELECT * FROM quarantine WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .all(now)
    .map((r) => ({ ...r, roles: JSON.parse(r.roles_json || '[]') }));
}

function createAppeal(userId, reason) {
  const tx = db.transaction(() => {
    const { seq, id } = nextAppealId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO appeals (id, seq, user_id, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`
    ).run(id, seq, String(userId), String(reason).slice(0, 600), now, now);
    return { id, seq, userId, reason, status: 'PENDING', createdAt: now };
  });
  return tx();
}

function reviewAppeal(appealId, status, reviewedBy, note = '') {
  const normalizedId = String(appealId).trim().toUpperCase();
  const normalizedStatus = String(status).trim().toUpperCase();
  const info = db
    .prepare(
      `UPDATE appeals
       SET status = ?, reviewed_by = ?, review_note = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(normalizedStatus, String(reviewedBy), String(note).slice(0, 400), Date.now(), normalizedId);
  return info.changes > 0;
}

function getAppeal(appealId) {
  return db.prepare('SELECT * FROM appeals WHERE id = ?').get(String(appealId).trim().toUpperCase()) || null;
}

function recordActionAndCount(actorId, actionType, targetId, windowMs) {
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM action_events WHERE created_at < ?').run(now - windowMs);
    db.prepare(
      'INSERT INTO action_events (actor_id, action_type, target_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(String(actorId), String(actionType), targetId ? String(targetId) : null, now);
    const row = db
      .prepare(
        'SELECT COUNT(*) AS cnt FROM action_events WHERE actor_id = ? AND action_type = ? AND created_at >= ?'
      )
      .get(String(actorId), String(actionType), now - windowMs);
    return Number(row.cnt);
  });
  return tx();
}

function getState(key, fallback = null) {
  const row = db.prepare('SELECT value_json FROM kv_state WHERE key = ?').get(String(key));
  if (!row) return fallback;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return fallback;
  }
}

function setState(key, value) {
  db.prepare(
    `INSERT INTO kv_state (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(String(key), JSON.stringify(value));
}

async function createBackupSnapshot() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `backup-${stamp}.db`);
  await db.backup(dest);
  const files = fs.readdirSync(backupDir).sort();
  while (files.length > 10) {
    const oldest = files.shift();
    if (oldest) fs.unlinkSync(path.join(backupDir, oldest));
  }
  return dest;
}

module.exports = {
  db,
  getGuildConfig,
  saveGuildConfig,
  updateGuildConfigPatch,
  createCase,
  deleteCaseById,
  getRecentCasesForUser,
  getTotalCases,
  getCaseStatsByType,
  addBlacklist,
  removeBlacklist,
  getBlacklist,
  countBlacklist,
  addWhitelist,
  removeWhitelist,
  isWhitelistedId,
  listWhitelist,
  addWarning,
  getWarningsCount,
  addRisk,
  getRisk,
  getRiskHistory,
  decayLowRisks,
  setQuarantine,
  getQuarantine,
  deleteQuarantine,
  getExpiredQuarantines,
  createAppeal,
  reviewAppeal,
  getAppeal,
  recordActionAndCount,
  getState,
  setState,
  createBackupSnapshot,
};
