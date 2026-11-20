async function findExecutor(guild, type, targetId = null, maxAgeMs = 12000) {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 8 });
    const now = Date.now();
    const candidates = logs.entries
      .filter((entry) => {
        if (now - entry.createdTimestamp > maxAgeMs) return false;
        if (targetId && entry.target?.id && entry.target.id !== targetId) return false;
        return true;
      })
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

    return candidates[0]?.executor || null;
  } catch {
    return null;
  }
}

module.exports = { findExecutor };
