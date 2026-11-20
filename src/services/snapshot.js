const { ChannelType } = require('discord.js');
const { getState, setState } = require('../database/database');
const { isProtectedRole } = require('./permissions');

const SNAPSHOT_KEY = 'guild_structure_snapshot';

async function captureGuildSnapshot(guild, logger) {
  try {
    const channels = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildCategory)
      .sort((a, b) => a.position - b.position)
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        parentId: c.parentId || null,
        position: c.position,
        topic: c.topic || null,
        rateLimitPerUser: c.rateLimitPerUser || 0,
      }));

    const roles = guild.roles.cache
      .filter((r) => !isProtectedRole(r, guild))
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissionsBitfield: r.permissions.bitfield.toString(),
      }));

    const snapshot = {
      capturedAt: Date.now(),
      channels,
      roles,
    };
    setState(SNAPSHOT_KEY, snapshot);
    return snapshot;
  } catch (err) {
    logger.logError('SNAPSHOT_CAPTURE', err);
    return null;
  }
}

async function restoreDeletedChannel(guild, deletedChannel, logger) {
  try {
    const snap = getState(SNAPSHOT_KEY);
    const saved = snap?.channels?.find((c) => c.id === deletedChannel.id);
    if (!saved || saved.type !== ChannelType.GuildText) return null;

    const parent =
      saved.parentId && guild.channels.cache.get(saved.parentId)?.type === ChannelType.GuildCategory
        ? saved.parentId
        : null;

    return await guild.channels.create({
      name: saved.name,
      type: ChannelType.GuildText,
      parent,
      topic: saved.topic || undefined,
      rateLimitPerUser: saved.rateLimitPerUser || 0,
      reason: 'Anti-Nuke Rollback: Silinen kanal geri olusturuldu',
    });
  } catch (err) {
    logger.logError('SNAPSHOT_RESTORE_CHANNEL', err, { channelId: deletedChannel.id });
    return null;
  }
}

async function restoreDeletedRole(guild, deletedRole, logger) {
  try {
    const snap = getState(SNAPSHOT_KEY);
    const saved = snap?.roles?.find((r) => r.id === deletedRole.id);
    if (!saved) return null;

    return await guild.roles.create({
      name: saved.name,
      color: saved.color,
      hoist: saved.hoist,
      mentionable: saved.mentionable,
      permissions: BigInt(saved.permissionsBitfield || '0'),
      reason: 'Anti-Nuke Rollback: Silinen rol geri olusturuldu',
    });
  } catch (err) {
    logger.logError('SNAPSHOT_RESTORE_ROLE', err, { roleId: deletedRole.id });
    return null;
  }
}

module.exports = {
  captureGuildSnapshot,
  restoreDeletedChannel,
  restoreDeletedRole,
};
