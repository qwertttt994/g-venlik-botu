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
    case_id TEXT,
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

function nextSeq(counterName, prefix) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(counterName);
    const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(counterName);
    const seq = Number(row.value);
    return { seq, id: `${prefix}-${String(seq).padStart(4, '0')}` };
  });
  return tx();
}

function getGuildConfig() {
  const stored = getState('guild_config', null);
  return {
    antiNuke: { ...config.defaults.antiNuke, ...(stored?.antiNuke || {}) },
    antiRaid: { ...config.defaults.antiRaid, ...(stored?.antiRaid || {}) },
    autoMod: {
      ...config.defaults.autoMod,
      ...(stored?.autoMod || {}),
      exemptChannels: Array.isArray(stored?.autoMod?.exemptChannels)
        ? stored.autoMod.exemptChannels
        : config.defaults.autoMod.exemptChannels,
      exemptRoles: Array.isArray(stored?.autoMod?.exemptRoles)
        ? stored.autoMod.exemptRoles
        : config.defaults.autoMod.exemptRoles,
    },
    adaptive: { ...config.defaults.adaptive, ...(stored?.adaptive || {}) },
    riskDecay: { ...config.defaults.riskDecay, ...(stored?.riskDecay || {}) },
  };
}

function updateGuildConfig(patch) {
  const current = getGuildConfig();
  const next = {
    antiNuke: { ...current.antiNuke, ...(patch.antiNuke || {}) },
    antiRaid: { ...current.antiRaid, ...(patch.antiRaid || {}) },
    autoMod: { ...current.autoMod, ...(patch.autoMod || {}) },
    adaptive: { ...current.adaptive, ...(patch.adaptive || {}) },
    riskDecay: { ...current.riskDecay, ...(patch.riskDecay || {}) },
  };
  setState('guild_config', next);
  return next;
}

function exportConfigJson() {
  return JSON.stringify(getGuildConfig(), null, 2);
}

function importConfigJson(rawJson) {
  const parsed = JSON.parse(rawJson);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Gecersiz JSON konfigurasyonu');
  }
  return updateGuildConfig(parsed);
}

function createCase({ type, targetId, moderatorId, reason, meta = null }) {
  const tx = db.transaction(() => {
    const { seq, id } = nextSeq('case_seq', 'CASE');
    const now = Date.now();
    const cleanReason = String(reason || 'Sebep belirtilmedi').slice(0, 500);
    db.prepare(
      `INSERT INTO cases (id, seq, type, target_id, moderator_id, reason, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      seq,
      String(type),
      String(targetId),
      String(moderatorId),
      cleanReason,
      meta ? JSON.stringify(meta).slice(0, 2000) : null,
      now
    );
    return { id, seq, type, targetId, moderatorId, reason: cleanReason, createdAt: now };
  });
  return tx();
}

function deleteCaseById(caseId) {
  const normalized = String(caseId).trim().toUpperCase();
  const info = db.prepare('DELETE FROM cases WHERE id = ?').run(normalized);
  return info.changes > 0;
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

function listWhitelist() {
  return db.prepare('SELECT * FROM whitelist ORDER BY created_at DESC LIMIT 50').all();
}

function isWhitelistedId(id) {
  return Boolean(db.prepare('SELECT 1 FROM whitelist WHERE target_id = ?').get(String(id)));
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

function addRisk(userId, delta, reason = 'Guvenlik olayi') {
  const tx = db.transaction(() => {
    const now = Date.now();
    const currentRow = db.prepare('SELECT score FROM risk_scores WHERE user_id = ?').get(String(userId));
    const current = currentRow ? Number(currentRow.score) : 0;
    const step = Number(delta || 0);
    const next = Math.max(0, Math.min(100, current + step));
    db.prepare(
      `INSERT INTO risk_scores (user_id, score, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`
    ).run(String(userId), next, now);
    db.prepare(
      `INSERT INTO risk_history (user_id, delta, score_after, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(String(userId), step, next, String(reason).slice(0, 250), now);
    return next;
  });
  return tx();
}

function getRisk(userId) {
  const row = db.prepare('SELECT score FROM risk_scores WHERE user_id = ?').get(String(userId));
  return row ? Number(row.score) : 0;
}

function getRiskHistory(userId, limit = 8) {
  return db
    .prepare('SELECT * FROM risk_history WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(String(userId), limit);
}

function decayAllRisks(amount = 5) {
  const step = Math.max(1, Number(amount || 5));
  const now = Date.now();
  const tx = db.transaction(() => {
    const rows = db.prepare('SELECT user_id, score FROM risk_scores WHERE score > 0').all();
    let updated = 0;
    for (const r of rows) {
      const next = Math.max(0, Number(r.score) - step);
      db.prepare('UPDATE risk_scores SET score = ?, updated_at = ? WHERE user_id = ?').run(
        next,
        now,
        r.user_id
      );
      db.prepare(
        `INSERT INTO risk_history (user_id, delta, score_after, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(r.user_id, next - Number(r.score), next, 'Zamanla risk erimesi (Decay)', now);
      updated++;
    }
    return updated;
  });
  return tx();
}

function setQuarantine(userId, roleIds, reason, durationMs = null) {
  const now = Date.now();
  const expiresAt = durationMs && durationMs > 0 ? now + durationMs : null;
  db.prepare(
    `INSERT OR REPLACE INTO quarantine (user_id, roles_json, reason, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(String(userId), JSON.stringify(roleIds), String(reason || 'Karantina').slice(0, 500), expiresAt, now);
  return expiresAt;
}

function getQuarantine(userId) {
  const row = db.prepare('SELECT * FROM quarantine WHERE user_id = ?').get(String(userId));
  if (!row) return null;
  return { ...row, roles: JSON.parse(row.roles_json || '[]') };
}

function getExpiredQuarantines(now = Date.now()) {
  return db
    .prepare('SELECT * FROM quarantine WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .all(now)
    .map((row) => ({ ...row, roles: JSON.parse(row.roles_json || '[]') }));
}

function deleteQuarantine(userId) {
  db.prepare('DELETE FROM quarantine WHERE user_id = ?').run(String(userId));
}

function createAppeal({ userId, caseId, reason }) {
  const tx = db.transaction(() => {
    const { seq, id } = nextSeq('appeal_seq', 'APL');
    const now = Date.now();
    const cleanReason = String(reason).slice(0, 800);
    const cleanCase = caseId ? String(caseId).trim().toUpperCase() : null;
    db.prepare(
      `INSERT INTO appeals (id, seq, user_id, case_id, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`
    ).run(id, seq, String(userId), cleanCase, cleanReason, now, now);
    return { id, seq, userId, caseId: cleanCase, reason: cleanReason, status: 'PENDING', createdAt: now };
  });
  return tx();
}

function reviewAppeal(appealId, status, reviewerId, note = '') {
  const normalizedId = String(appealId).trim().toUpperCase();
  const normalizedStatus = String(status).toUpperCase();
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE appeals
       SET status = ?, reviewed_by = ?, review_note = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(normalizedStatus, String(reviewerId), String(note || '').slice(0, 500), now, normalizedId);
  if (info.changes === 0) return null;
  return db.prepare('SELECT * FROM appeals WHERE id = ?').get(normalizedId);
}

function getAppealById(appealId) {
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

function getRecentCasesForUser(userId, limit = 5) {
  return db
    .prepare('SELECT * FROM cases WHERE target_id = ? ORDER BY seq DESC LIMIT ?')
    .all(String(userId), limit);
}

function getTotalCases() {
  return db.prepare('SELECT COUNT(*) AS cnt FROM cases').get().cnt;
}

function getCaseBreakdown(sinceMs = 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - sinceMs;
  return db
    .prepare(
      `SELECT type, COUNT(*) AS cnt
       FROM cases
       WHERE created_at >= ?
       GROUP BY type
       ORDER BY cnt DESC`
    )
    .all(cutoff);
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

function listBackups() {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith('.db'))
    .sort()
    .reverse();
}

function restoreDatabaseFromBackup(backupFileName) {
  const safeName = path.basename(String(backupFileName || ''));
  const source = path.join(backupDir, safeName);
  if (!safeName || !fs.existsSync(source)) {
    throw new Error('Yedek dosyasi bulunamadi');
  }
  const srcDb = new Database(source, { readonly: true });
  try {
    const tables = [
      'counters',
      'blacklist',
      'whitelist',
      'cases',
      'warnings',
      'risk_scores',
      'risk_history',
      'quarantine',
      'appeals',
      'kv_state',
    ];
    const tx = db.transaction(() => {
      for (const tbl of tables) {
        db.prepare(`DELETE FROM ${tbl}`).run();
        const rows = srcDb.prepare(`SELECT * FROM ${tbl}`).all();
        if (rows.length === 0) continue;
        const cols = Object.keys(rows[0]);
        const placeholders = cols.map(() => '?').join(', ');
        const stmt = db.prepare(
          `INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${placeholders})`
        );
        for (const row of rows) {
          stmt.run(...cols.map((c) => row[c]));
        }
      }
    });
    tx();
    return safeName;
  } finally {
    srcDb.close();
  }
}

module.exports = {
  db,
  getGuildConfig,
  updateGuildConfig,
  exportConfigJson,
  importConfigJson,
  createCase,
  deleteCaseById,
  addBlacklist,
  removeBlacklist,
  getBlacklist,
  countBlacklist,
  addWhitelist,
  removeWhitelist,
  listWhitelist,
  isWhitelistedId,
  addWarning,
  getWarningsCount,
  addRisk,
  getRisk,
  getRiskHistory,
  decayAllRisks,
  setQuarantine,
  getQuarantine,
  getExpiredQuarantines,
  deleteQuarantine,
  createAppeal,
  reviewAppeal,
  getAppealById,
  recordActionAndCount,
  getState,
  setState,
  getRecentCasesForUser,
  getTotalCases,
  getCaseBreakdown,
  createBackupSnapshot,
  listBackups,
  restoreDatabaseFromBackup,
};
