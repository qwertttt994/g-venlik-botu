const { getRisk, getRiskHistory, getState, setState } = require('../database/database');

const ADAPTIVE_KEY = 'adaptive_security_state';

function getAdaptiveState() {
  const raw = getState(ADAPTIVE_KEY, {
    elevated: false,
    elevatedUntil: 0,
    reason: null,
  });
  const now = Date.now();
  if (raw.elevated && now >= Number(raw.elevatedUntil || 0)) {
    const reset = { elevated: false, elevatedUntil: 0, reason: null };
    setState(ADAPTIVE_KEY, reset);
    return reset;
  }
  return {
    elevated: Boolean(raw.elevated),
    elevatedUntil: Number(raw.elevatedUntil || 0),
    reason: raw.reason || null,
  };
}

async function triggerAdaptiveElevation(guild, reason, logger, durationMs = 15 * 60 * 1000) {
  const next = {
    elevated: true,
    elevatedUntil: Date.now() + durationMs,
    reason,
  };
  setState(ADAPTIVE_KEY, next);
  if (guild && logger) {
    await logger.sendSystemAlert(
      guild,
      '⚡ ADAPTİF GÜVENLİK YÜKSELTMESİ',
      `**Durum:** Yüksek Koruma Modu Aktif\n**Sebep:** ${reason}\n**Süre:** \`${Math.round(durationMs / 60000)} dakika\``,
      0x8b5cf6
    );
  }
  return next;
}

function checkAccountCompromise(userId) {
  const score = getRisk(userId);
  const history = getRiskHistory(userId, 5);
  const now = Date.now();
  const recentSpikes = history.filter((h) => now - Number(h.created_at || 0) < 10 * 60 * 1000 && h.delta > 0);
  const recentDeltaSum = recentSpikes.reduce((acc, item) => acc + Number(item.delta || 0), 0);

  return {
    compromisedSuspect: score >= 65 || recentDeltaSum >= 45 || recentSpikes.length >= 3,
    score,
    recentDeltaSum,
    spikeCount: recentSpikes.length,
  };
}

module.exports = {
  getAdaptiveState,
  triggerAdaptiveElevation,
  checkAccountCompromise,
};
