const { EmbedBuilder } = require('discord.js');
const config = require('../config/config');
const {
  recordActionAndCount,
  addRisk,
  createCase,
  getState,
  setState,
} = require('../database/database');
const { isDangerousRole, isWhitelisted } = require('../services/permissions');

const COOLDOWN_KEY = 'antinuke_cooldowns';

async function isolateDangerousRoles(member, guild, reason, logger) {
  if (!member || !member.manageable) return [];
  const removable = member.roles.cache.filter((r) => isDangerousRole(r, guild));
  const removedNames = [];
  if (removable.size === 0) return removedNames;

  try {
    await member.roles.remove(removable, reason);
    removable.forEach((r) => removedNames.push(r.name));
  } catch (err) {
    logger.logError('ISOLATE_ROLES', err, { userId: member.id });
  }
  return removedNames;
}

async function handleAntiNuke(client, guild, executorId, actionType, targetId, summary, logger, extraMeta = {}) {
  if (!executorId || executorId === config.ownerId || executorId === client.user.id) return false;
  if (isWhitelisted(executorId, guild)) return false;

  const count = recordActionAndCount(executorId, actionType, targetId, config.antiNuke.windowMs);
  if (count < config.antiNuke.threshold) return false;

  const cooldowns = getState(COOLDOWN_KEY, {});
  const cdKey = `${executorId}:${actionType}`;
  const now = Date.now();
  if (cooldowns[cdKey] && now < cooldowns[cdKey]) {
    return false;
  }
  cooldowns[cdKey] = now + config.antiNuke.cooldownMs;
  setState(COOLDOWN_KEY, cooldowns);

  const member = await guild.members.fetch(executorId).catch((err) => {
    logger.logError('ANTINUKE_FETCH_MEMBER', err, { executorId });
    return null;
  });

  const removedRoles = await isolateDangerousRoles(
    member,
    guild,
    `Anti-Nuke: ${actionType} esigi (${config.antiNuke.threshold}) asildi`,
    logger
  );

  const risk = addRisk(executorId, 35);
  const caseEntry = createCase({
    type: 'ANTI_NUKE',
    targetId: targetId || executorId,
    moderatorId: client.user.id,
    reason: `${summary} (${count} islem / ${config.antiNuke.windowMs / 1000}s)`,
    meta: { executorId, actionType, removedRoles, ...extraMeta },
  });

  const embed = new EmbedBuilder()
    .setColor(0xdc2626)
    .setTitle('🚨 ANTI-NUKE MÜDAHALESİ')
    .setDescription(
      `<@${config.ownerId}> **<@${executorId}>** (\`${executorId}\`) kritik işlem eşiğine ulaştı.\n` +
        `**Vaka:** \`${caseEntry.id}\`\n` +
        `**İşlem:** ${summary}\n` +
        `**Alınan Tehlikeli Roller:** ${
          removedRoles.length > 0 ? removedRoles.map((n) => `\`${n}\``).join(', ') : 'Yok / Hiyerarşi engeli'
        }\n` +
        `**Koruma:** \`Verified\` ve güvenli roller korunmuştur.\n` +
        `**Risk Puanı:** \`${risk}/100\``
    )
    .setTimestamp();

  await logger.sendEmbed(guild, embed);
  return true;
}

module.exports = { handleAntiNuke, isolateDangerousRoles };
