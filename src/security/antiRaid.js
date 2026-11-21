const { EmbedBuilder } = require('discord.js');
const config = require('../config/config');
const {
  getGuildConfig,
  recordActionAndCount,
  getState,
  setState,
  addRisk,
  createCase,
} = require('../database/database');
const { triggerAdaptiveElevation, checkAccountCompromise } = require('./adaptiveSecurity');

const RAID_KEY = 'raid_state';

function getRaidStatus() {
  const raw = getState(RAID_KEY, { active: false, until: 0, reason: null });
  const now = Date.now();
  if (raw.active && now >= Number(raw.until || 0)) {
    const cleared = { active: false, until: 0, reason: null };
    setState(RAID_KEY, cleared);
    return cleared;
  }
  return {
    active: Boolean(raw.active),
    until: Number(raw.until || 0),
    reason: raw.reason || null,
  };
}

async function activateRaidShield(guild, reason, logger) {
  const gcfg = getGuildConfig();
  const next = {
    active: true,
    until: Date.now() + gcfg.raid.durationMs,
    reason,
  };
  setState(RAID_KEY, next);
  await triggerAdaptiveElevation(guild, `Raid Kalkanı: ${reason}`, logger);
  await logger.sendSystemAlert(
    guild,
    '⚠️ RAİD KALKANI AKTİF',
    `**Sebep:** ${reason}\n**Süre:** \`${Math.round(gcfg.raid.durationMs / 60000)} dakika\``,
    0xf97316
  );
  return next;
}

function isImpersonationAttempt(member, guild) {
  const candidates = [
    member.displayName,
    member.user?.username,
    member.user?.globalName,
  ]
    .filter(Boolean)
    .map((s) => s.trim().toLowerCase());

  const protectedNames = new Set([
    guild.name?.trim().toLowerCase(),
    guild.members.cache.get(config.ownerId)?.displayName?.trim().toLowerCase(),
    guild.members.cache.get(config.ownerId)?.user?.username?.trim().toLowerCase(),
    'admin',
    'administrator',
    'moderator',
    'mod',
    'staff',
    'owner',
    'kurucu',
    'yetkili',
    'support',
    'destek',
  ].filter(Boolean));

  for (const name of candidates) {
    if (protectedNames.has(name)) return name;
  }
  return null;
}

async function evaluateMemberJoin(member, logger) {
  const guild = member.guild;
  const gcfg = getGuildConfig();

  const joinCount = recordActionAndCount(
    'SYSTEM_RAID',
    'MEMBER_JOIN',
    member.id,
    gcfg.raid.joinWindowMs
  );

  let raid = getRaidStatus();
  if (joinCount >= gcfg.raid.joinThreshold) {
    raid = await activateRaidShield(
      guild,
      `${Math.round(gcfg.raid.joinWindowMs / 1000)} saniyede ${joinCount} toplu giriş`,
      logger
    );
  }

  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
  const isFreshAccount = accountAgeDays < gcfg.raid.minAccountAgeDays;
  const impersonatedName = isImpersonationAttempt(member, guild);

  if (isFreshAccount) {
    addRisk(member.id, 15, `Yeni hesap (${accountAgeDays.toFixed(1)} gun)`);
  }

  if (impersonatedName) {
    addRisk(member.id, 30, `Kimliğe bürünme şüphesi (${impersonatedName})`);
    createCase({
      type: 'IMPERSONATION',
      targetId: member.id,
      moderatorId: guild.client.user.id,
      reason: `Taklit / kimliğe bürünme girişimi: ${impersonatedName}`,
    });
  }

  const comp = checkAccountCompromise(member.id);
  if (comp.compromisedSuspect) {
    await logger.sendSystemAlert(
      guild,
      '🕵️ KOMPROMİZE / YÜKSEK RİSKLİ HESAP ŞÜPHESİ',
      `**Üye:** <@${member.id}> (\`${member.id}\`)\n**Risk:** \`${comp.score}/100\` | **10dk Artış:** \`+${comp.recentDeltaSum}\``,
      0xe11d48
    );
  }

  if (!raid.active && !isFreshAccount && !impersonatedName) return;

  if ((raid.active && isFreshAccount) || impersonatedName) {
    const risk = addRisk(member.id, 20, impersonatedName ? 'Kimliğe bürünme müdahalesi' : 'Raid sirasinda yeni hesap');
    let quarantined = false;

    if (config.quarantineRoleId) {
      const qRole = guild.roles.cache.get(config.quarantineRoleId);
      if (qRole) {
        try {
          await member.roles.add(
            qRole,
            impersonatedName ? 'Kimliğe bürünme şüphesi karantinası' : 'Raid korumasi: Yeni hesap karantinaya alindi'
          );
          quarantined = true;
        } catch (err) {
          logger.logError('RAID_QUARANTINE_ROLE', err, { userId: member.id });
        }
      }
    }

    const caseEntry = createCase({
      type: impersonatedName ? 'IMPERSONATION' : 'RAID_SUSPECT',
      targetId: member.id,
      moderatorId: guild.client.user.id,
      reason: impersonatedName
        ? `Kimliğe bürünme şüphesi (${impersonatedName})`
        : `Raid sirasinda yeni hesap (${accountAgeDays.toFixed(1)} gun)`,
      meta: { quarantined, impersonatedName },
    });

    const embed = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle(impersonatedName ? '🎭 KİMLİĞE BÜRÜNME KORUMASI' : '🛡️ RAİD KALKANI — ŞÜPHELİ HESAP')
      .setDescription(
        `**Üye:** <@${member.id}> (\`${member.id}\`)\n` +
          `**Vaka:** \`${caseEntry.id}\`\n` +
          `**Hesap Yaşı:** \`${accountAgeDays.toFixed(1)} gün\`\n` +
          (impersonatedName ? `**Taklit İsim:** \`${impersonatedName}\`\n` : '') +
          `**Karantina:** ${quarantined ? 'Uygulandı' : 'Rol tanımlı değil / uygulanamadı'}\n` +
          `**Risk Puanı:** \`${risk}/100\``
      )
      .setTimestamp();

    await logger.sendEmbed(guild, embed);
  }
}

async function evaluateVoiceBurst(newState, logger) {
  if (!newState.guild || !newState.channelId || !newState.member || newState.member.user.bot) return;
  const gcfg = getGuildConfig();
  const count = recordActionAndCount(
    'SYSTEM_VOICE_RAID',
    'VOICE_JOIN',
    newState.member.id,
    gcfg.raid.voiceBurstWindowMs
  );

  if (count >= gcfg.raid.voiceBurstThreshold) {
    const raid = getRaidStatus();
    if (!raid.active) {
      await activateRaidShield(
        newState.guild,
        `${Math.round(gcfg.raid.voiceBurstWindowMs / 1000)} saniyede ${count} ses kanali hareketi`,
        logger
      );
    }
  }
}

module.exports = {
  getRaidStatus,
  activateRaidShield,
  evaluateMemberJoin,
  evaluateVoiceBurst,
  isImpersonationAttempt,
};
