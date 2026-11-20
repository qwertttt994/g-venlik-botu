const { EmbedBuilder } = require('discord.js');
const config = require('../config/config');
const { recordActionAndCount, getState, setState, addRisk, createCase } = require('../database/database');

const RAID_KEY = 'raid_state';

function getRaidStatus() {
  const raw = getState(RAID_KEY, { active: false, until: 0 });
  const now = Date.now();
  if (raw.active && now >= Number(raw.until || 0)) {
    const cleared = { active: false, until: 0 };
    setState(RAID_KEY, cleared);
    return cleared;
  }
  return {
    active: Boolean(raw.active),
    until: Number(raw.until || 0),
  };
}

async function evaluateMemberJoin(member, logger) {
  const guild = member.guild;
  const joinCount = recordActionAndCount('SYSTEM_RAID', 'MEMBER_JOIN', member.id, config.raid.joinWindowMs);
  let raid = getRaidStatus();

  if (joinCount >= config.raid.joinThreshold) {
    raid = { active: true, until: Date.now() + config.raid.durationMs };
    setState(RAID_KEY, raid);
    await logger.sendSystemAlert(
      guild,
      '⚠️ RAİD KALKANI AKTİF',
      `${config.raid.joinWindowMs / 1000} saniyede \`${joinCount}\` giriş algılandı. Koruma penceresi açıldı.`,
      0xf97316
    );
  }

  if (!raid.active) return;

  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
  if (accountAgeDays < config.raid.minAccountAgeDays) {
    const risk = addRisk(member.id, 30);
    let quarantined = false;

    if (config.quarantineRoleId) {
      const qRole = guild.roles.cache.get(config.quarantineRoleId);
      if (qRole) {
        try {
          await member.roles.add(qRole, 'Raid koruması: Yeni hesap karantinaya alındı');
          quarantined = true;
        } catch (err) {
          logger.logError('RAID_QUARANTINE_ROLE', err, { userId: member.id });
        }
      }
    }

    const caseEntry = createCase({
      type: 'RAID_SUSPECT',
      targetId: member.id,
      moderatorId: guild.client.user.id,
      reason: `Raid sirasinda yeni hesap (${accountAgeDays.toFixed(1)} gun)`,
      meta: { quarantined },
    });

    const embed = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle('🛡️ RAİD KALKANI — ŞÜPHELİ HESAP')
      .setDescription(
        `**Üye:** <@${member.id}> (\`${member.id}\`)\n` +
          `**Vaka:** \`${caseEntry.id}\`\n` +
          `**Hesap Yaşı:** \`${accountAgeDays.toFixed(1)} gün\`\n` +
          `**Karantina:** ${quarantined ? 'Uygulandı' : 'Rol tanımlı değil / uygulanamadı'}\n` +
          `**Risk Puanı:** \`${risk}/100\``
      )
      .setTimestamp();

    await logger.sendEmbed(guild, embed);
  }
}

module.exports = { getRaidStatus, evaluateMemberJoin };
