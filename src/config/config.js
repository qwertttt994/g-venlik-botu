const { PermissionFlagsBits } = require('discord.js');

const requiredEnv = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID', 'OWNER_ID', 'LOG_CHANNEL_ID'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`[FATAL] Eksik ortam degiskeni: ${key}`);
    process.exit(1);
  }
}

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  ownerId: process.env.OWNER_ID,
  logChannelId: process.env.LOG_CHANNEL_ID,
  verifiedRoleId: process.env.VERIFIED_ROLE_ID || null,
  quarantineRoleId: process.env.QUARANTINE_ROLE_ID || null,
  port: Number(process.env.PORT || 3000),
  selfPingUrl: process.env.SELF_PING_URL || 'https://g-venlik-botu-3.onrender.com',
  defaults: {
    antiNuke: {
      windowMs: 60 * 1000,
      threshold: 3,
      cooldownMs: 120 * 1000,
      autoRollbackChannels: true,
      autoRollbackRoles: true,
    },
    raid: {
      joinWindowMs: 10 * 1000,
      joinThreshold: 8,
      durationMs: 10 * 60 * 1000,
      minAccountAgeDays: 7,
      voiceBurstWindowMs: 10 * 1000,
      voiceBurstThreshold: 7,
    },
    autoMod: {
      enabled: true,
      exemptChannelIds: [],
      exemptRoleIds: [],
      maxMentions: 6,
      maxEmojis: 12,
      capsRatioThreshold: 0.75,
      capsMinLetters: 14,
      floodWindowMs: 7000,
      floodMaxMessages: 6,
      floodMaxDuplicates: 3,
      blockInvites: true,
      blockShortLinks: true,
      blockPhishing: true,
      blockProfanity: true,
    },
    moderatorAbuse: {
      windowMs: 60 * 1000,
      maxPunishmentsPerMinute: 8,
    },
    quarantine: {
      defaultDurationMs: 24 * 60 * 60 * 1000,
    },
  },
  dangerousPermissions: [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ManageWebhooks,
  ],
};
