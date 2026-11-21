const http = require('http');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  EmbedBuilder,
  AuditLogEvent,
} = require('discord.js');
const config = require('./config/config');
const db = require('./database/database');
const { createLogger } = require('./services/logger');
const { findExecutor } = require('./services/auditLog');
const { isDangerousRole, isWhitelisted } = require('./services/permissions');
const {
  captureGuildSnapshot,
  restoreDeletedChannel,
  restoreDeletedRole,
} = require('./services/snapshot');
const { isAuthorized, buildOverview, renderDashboardHtml } = require('./services/dashboard');
const { handleAntiNuke } = require('./security/antiNuke');
const { evaluateMemberJoin, evaluateVoiceBurst } = require('./security/antiRaid');
const { handleAutoMod } = require('./security/autoMod');
const { commands } = require('./commands/definitions');
const { handleCommand } = require('./commands/handler');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.GuildMember, Partials.Message, Partials.Channel],
});

const logger = createLogger(client);

http
  .createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${config.port}`);

    if (parsedUrl.pathname === '/health') {
      const ready = Boolean(client.isReady() && client.user);
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: ready ? 'ok' : 'starting',
          botReady: ready,
          pingMs: ready ? client.ws.ping : null,
          uptimeSec: Math.floor(process.uptime()),
          timestamp: Date.now(),
        })
      );
      return;
    }

    if (parsedUrl.pathname === '/api/overview') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(buildOverview(client)));
      return;
    }

    if (parsedUrl.pathname === '/api/config' && req.method === 'POST') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          db.updateGuildConfigPatch((c) => {
            if (typeof parsed.antiNukeThreshold === 'number') {
              c.antiNuke.threshold = Math.max(1, Math.min(20, parsed.antiNukeThreshold));
            }
            if (typeof parsed.raidJoinThreshold === 'number') {
              c.raid.joinThreshold = Math.max(2, Math.min(50, parsed.raidJoinThreshold));
            }
            if (typeof parsed.autoModEnabled === 'boolean') {
              c.autoMod.enabled = parsed.autoModEnabled;
            }
            return c;
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Gecersiz JSON' }));
        }
      });
      return;
    }

    if (parsedUrl.pathname === '/api/backup' && req.method === 'POST') {
      if (!isAuthorized(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      (async () => {
        try {
          const guild = client.guilds.cache.get(config.guildId);
          if (guild) await captureGuildSnapshot(guild, logger);
          const backupPath = await db.createBackupSnapshot();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, file: backupPath.split('/').pop() }));
        } catch (err) {
          logger.logError('DASHBOARD_BACKUP', err);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Yedek alinamadi' }));
        }
      })();
      return;
    }

    if (parsedUrl.pathname === '/dashboard') {
      if (!isAuthorized(req)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDashboardHtml(''));
        return;
      }
      const tokenParam = parsedUrl.searchParams.get('token') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboardHtml(tokenParam));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('7/24 aktif ve calisiyor');
  })
  .listen(config.port, () => {
    logger.logInfo('HTTP', `Sunucu ${config.port} portunda aktif.`);
  });

setInterval(() => {
  fetch(`${config.selfPingUrl}/health`).catch((err) => logger.logError('SELF_PING', err));
}, 5 * 60 * 1000);

setInterval(async () => {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) return;

    const expired = db.getExpiredQuarantines();
    if (expired.length > 0 && config.quarantineRoleId) {
      const qRole = guild.roles.cache.get(config.quarantineRoleId);
      for (const item of expired) {
        try {
          const member = await guild.members.fetch(item.user_id).catch(() => null);
          if (member && qRole) {
            await member.roles.remove(qRole, 'Karantina suresi doldu').catch(() => null);
            if (item.roles?.length) {
              const restore = item.roles
                .map((id) => guild.roles.cache.get(id))
                .filter((r) => r && r.editable);
              if (restore.length > 0) {
                await member.roles.add(restore, 'Karantina bitis rol iadesi').catch(() => null);
              }
            }
          }
          db.deleteQuarantine(item.user_id);
        } catch (err) {
          logger.logError('QUARANTINE_EXPIRE_RELEASE', err, { userId: item.user_id });
        }
      }
    }

    db.decayLowRisks(5, 30);
  } catch (err) {
    logger.logError('MAINTENANCE_TICK', err);
  }
}, 60 * 1000);

setInterval(async () => {
  try {
    const guild = client.guilds.cache.get(config.guildId);
    if (guild) await captureGuildSnapshot(guild, logger);
    await db.createBackupSnapshot();
  } catch (err) {
    logger.logError('PERIODIC_BACKUP', err);
  }
}, 30 * 60 * 1000);

client.once('ready', async () => {
  try {
    const rest = new REST({ version: '10' }).setToken(config.token);
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
    const guild = client.guilds.cache.get(config.guildId) || (await client.guilds.fetch(config.guildId));
    if (guild) await captureGuildSnapshot(guild, logger);
    logger.logInfo('READY', `Bot aktif: ${client.user.tag}`);
  } catch (err) {
    logger.logError('READY_INIT', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await handleCommand(interaction, logger);
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.guild.id !== config.guildId) return;
  await handleAutoMod(message, logger);
});

client.on('messageDeleteBulk', async (messages, channel) => {
  if (!channel.guild || channel.guild.id !== config.guildId) return;
  await logger.sendSystemAlert(
    channel.guild,
    '🧹 TOPLU MESAJ SİLME',
    `**Kanal:** <#${channel.id}> | **Adet:** \`${messages.size}\``,
    0x64748b
  );
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.guild || newState.guild.id !== config.guildId) return;
  if (!oldState.channelId && newState.channelId) {
    await evaluateVoiceBurst(newState, logger);
  }
});

client.on('guildBanRemove', async (ban) => {
  const guild = ban.guild;
  if (guild.id !== config.guildId) return;

  const bl = db.getBlacklist(ban.user.id);
  const ipFlag = db.isIpBannedForUserOrTag(ban.user.id, `UID-${ban.user.id}`);
  const executor = await findExecutor(guild, AuditLogEvent.MemberBanRemove, ban.user.id);

  if ((bl || ipFlag) && (!executor || executor.id !== config.ownerId)) {
    let reBanned = false;
    try {
      await guild.members.ban(ban.user.id, {
        reason: 'Anti-Unban: Kara liste / IP izolasyonundaki kullanicinin yasagi yetkisiz kaldirildi.',
      });
      reBanned = true;
    } catch (err) {
      logger.logError('ANTI_UNBAN_REBAN', err, { userId: ban.user.id });
    }

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle('🛡️ ANTI-UNBAN ENGELİ')
      .setDescription(
        `**Hedef:** ${ban.user.tag} (\`${ban.user.id}\`) | **Geri Ban:** \`${reBanned ? 'Evet' : 'Hayır'}\`\n` +
          `**Kaldıran:** ${executor ? `${executor.tag} (\`${executor.id}\`)` : 'Bilinmiyor'}\n` +
          `**Sebep:** ${bl?.reason || 'IP / Ag Izolasyonu'}`
      )
      .setTimestamp();
    await logger.sendEmbed(guild, embed);

    if (executor) {
      await handleAntiNuke(
        client,
        guild,
        executor.id,
        'UNBAN_BLACKLIST',
        ban.user.id,
        `Ban kaldirma (${ban.user.id})`,
        logger
      );
    }
  }
});

client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== config.guildId) return;

  const bl = db.getBlacklist(member.id);
  const ipFlag = db.isIpBannedForUserOrTag(member.id, `UID-${member.id}`);
  if (bl || ipFlag) {
    let banned = false;
    try {
      await member.ban({
        reason: ipFlag ? 'IP / Ag Izolasyonu Aktif' : `Kara Liste Korumasi: ${bl.reason}`,
      });
      banned = true;
    } catch (err) {
      logger.logError('BLACKLIST_MEMBER_ADD_BAN', err, { userId: member.id });
    }
    const embed = new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle(ipFlag ? '🚫 IP / AĞ İZOLASYONU GİRİŞİ' : '⛔ KARA LİSTE GİRİŞİ')
      .setDescription(
        `**Üye:** ${member.user.tag} (\`${member.id}\`) | **Yasaklandı:** \`${banned ? 'Evet' : 'Hayır'}\`\n**Sebep:** ${ipFlag ? 'IP / Ag Izolasyonu' : bl.reason}`
      )
      .setTimestamp();
    await logger.sendEmbed(member.guild, embed);
    return;
  }

  if (member.user.bot) {
    const adder = await findExecutor(member.guild, AuditLogEvent.BotAdd, member.id);
    if (!adder || (adder.id !== config.ownerId && !isWhitelisted(adder.id, member.guild))) {
      let kicked = false;
      try {
        await member.kick('Yetkisiz bot ekleme engellendi');
        kicked = true;
      } catch (err) {
        logger.logError('ANTI_BOT_KICK', err, { botId: member.id });
      }
      if (adder) {
        await handleAntiNuke(
          client,
          member.guild,
          adder.id,
          'BOT_ADD',
          member.id,
          `Yetkisiz bot ekleme (${member.user.tag})`,
          logger
        );
      }
      await logger.sendSystemAlert(
        member.guild,
        '🤖 YETKİSİZ BOT MÜDAHALESİ',
        `**Bot:** ${member.user.tag} (\`${member.id}\`)\n**Ekleyen:** ${adder ? `<@${adder.id}>` : 'Bilinmiyor'}\n**Atıldı:** \`${kicked ? 'Evet' : 'Hayır'}\``
      );
    }
    return;
  }

  await evaluateMemberJoin(member, logger);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.guild.id !== config.guildId) return;
  const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
  const dangerous = added.filter((r) => isDangerousRole(r, newMember.guild));
  if (dangerous.size === 0) return;

  const executor = await findExecutor(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id);
  if (executor) {
    await handleAntiNuke(
      client,
      newMember.guild,
      executor.id,
      'DANGEROUS_ROLE_ASSIGN',
      newMember.id,
      `Tehlikeli rol atama -> ${newMember.user.tag} (${dangerous.map((r) => r.name).join(', ')})`,
      logger
    );
  }
});

client.on('webhooksUpdate', async (channel) => {
  if (!channel.guild || channel.guild.id !== config.guildId) return;
  const executor = await findExecutor(channel.guild, AuditLogEvent.WebhookCreate, null);
  if (
    !executor ||
    executor.id === config.ownerId ||
    executor.id === client.user.id ||
    isWhitelisted(executor.id, channel.guild)
  ) {
    return;
  }

  try {
    const hooks = await channel.fetchWebhooks();
    for (const [, hook] of hooks) {
      if (hook.owner?.id === executor.id) {
        await hook.delete('Anti-Webhook: Yetkisiz webhook silindi');
      }
    }
  } catch (err) {
    logger.logError('ANTI_WEBHOOK_DELETE', err, { channelId: channel.id });
  }

  await handleAntiNuke(
    client,
    channel.guild,
    executor.id,
    'WEBHOOK_CREATE',
    channel.id,
    `Yetkisiz webhook (#${channel.name})`,
    logger
  );
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild || channel.guild.id !== config.guildId) return;
  const executor = await findExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
  if (!executor) return;

  const triggered = await handleAntiNuke(
    client,
    channel.guild,
    executor.id,
    'CHANNEL_DELETE',
    channel.id,
    `Kanal silme (#${channel.name})`,
    logger
  );

  const gcfg = db.getGuildConfig();
  if (triggered && gcfg.antiNuke.autoRollbackChannels) {
    const restored = await restoreDeletedChannel(channel.guild, channel, logger);
    if (restored) {
      await logger.sendSystemAlert(
        channel.guild,
        '♻️ KANAL GERİ OLUŞTURULDU',
        `Silinen \`#${channel.name}\` kanalı **Anti-Nuke Rollback** ile yeniden açıldı: <#${restored.id}>`,
        0x10b981
      );
    }
  }
});

client.on('channelCreate', async (channel) => {
  if (!channel.guild || channel.guild.id !== config.guildId) return;
  const executor = await findExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
  if (executor) {
    await handleAntiNuke(
      client,
      channel.guild,
      executor.id,
      'CHANNEL_CREATE',
      channel.id,
      `Kanal olusturma (#${channel.name})`,
      logger
    );
  }
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (!newChannel.guild || newChannel.guild.id !== config.guildId) return;
  const executor = await findExecutor(newChannel.guild, AuditLogEvent.ChannelOverwriteUpdate, newChannel.id);
  if (executor) {
    await handleAntiNuke(
      client,
      newChannel.guild,
      executor.id,
      'CHANNEL_PERM_UPDATE',
      newChannel.id,
      `Kanal izin degisikligi (#${newChannel.name})`,
      logger
    );
  }
});

client.on('roleDelete', async (role) => {
  if (role.guild.id !== config.guildId) return;
  const executor = await findExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
  if (!executor) return;

  const triggered = await handleAntiNuke(
    client,
    role.guild,
    executor.id,
    'ROLE_DELETE',
    role.id,
    `Rol silme (@${role.name})`,
    logger
  );

  const gcfg = db.getGuildConfig();
  if (triggered && gcfg.antiNuke.autoRollbackRoles) {
    const restored = await restoreDeletedRole(role.guild, role, logger);
    if (restored) {
      await logger.sendSystemAlert(
        role.guild,
        '♻️ ROL GERİ OLUŞTURULDU',
        `Silinen \`@${role.name}\` rolü **Anti-Nuke Rollback** ile yeniden oluşturuldu: <@&${restored.id}>`,
        0x10b981
      );
    }
  }
});

client.on('roleCreate', async (role) => {
  if (role.guild.id !== config.guildId) return;
  const executor = await findExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
  if (executor) {
    await handleAntiNuke(
      client,
      role.guild,
      executor.id,
      'ROLE_CREATE',
      role.id,
      `Rol olusturma (@${role.name})`,
      logger
    );
  }
});

client.on('roleUpdate', async (oldRole, newRole) => {
  if (newRole.guild.id !== config.guildId) return;
  if (oldRole.permissions.bitfield === newRole.permissions.bitfield) return;

  const executor = await findExecutor(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
  if (executor) {
    await handleAntiNuke(
      client,
      newRole.guild,
      executor.id,
      'ROLE_PERM_UPDATE',
      newRole.id,
      `Rol yetki degisikligi (@${newRole.name})`,
      logger
    );
  }
});

client.on('guildUpdate', async (oldGuild, newGuild) => {
  if (newGuild.id !== config.guildId) return;
  const executor = await findExecutor(newGuild, AuditLogEvent.GuildUpdate, newGuild.id);
  if (executor) {
    await handleAntiNuke(
      client,
      newGuild,
      executor.id,
      'GUILD_UPDATE',
      newGuild.id,
      `Sunucu ayari degisikligi (${oldGuild.name} -> ${newGuild.name})`,
      logger
    );
  }
});

client.on('guildEmojiDelete', async (emoji) => {
  if (!emoji.guild || emoji.guild.id !== config.guildId) return;
  const executor = await findExecutor(emoji.guild, AuditLogEvent.EmojiDelete, emoji.id);
  if (executor && !isWhitelisted(executor.id, emoji.guild)) {
    await logger.sendSystemAlert(
      emoji.guild,
      '😀 EMOJİ SİLİNDİ',
      `**Emoji:** \`:${emoji.name}:\` | **Yapan:** <@${executor.id}>`,
      0x64748b
    );
  }
});

client.on('guildStickerDelete', async (sticker) => {
  if (!sticker.guild || sticker.guild.id !== config.guildId) return;
  const executor = await findExecutor(sticker.guild, AuditLogEvent.StickerDelete, sticker.id);
  if (executor && !isWhitelisted(executor.id, sticker.guild)) {
    await logger.sendSystemAlert(
      sticker.guild,
      '🏷️ STICKER SİLİNDİ',
      `**Sticker:** \`${sticker.name}\` | **Yapan:** <@${executor.id}>`,
      0x64748b
    );
  }
});

client.on('threadDelete', async (thread) => {
  if (!thread.guild || thread.guild.id !== config.guildId) return;
  const executor = await findExecutor(thread.guild, AuditLogEvent.ThreadDelete, thread.id);
  if (executor && !isWhitelisted(executor.id, thread.guild)) {
    await logger.sendSystemAlert(
      thread.guild,
      '🧵 KONU (THREAD) SİLİNDİ',
      `**Konu:** \`${thread.name}\` | **Yapan:** <@${executor.id}>`,
      0x64748b
    );
  }
});

client.on('guildScheduledEventCreate', async (event) => {
  if (!event.guild || event.guild.id !== config.guildId) return;
  await logger.sendSystemAlert(
    event.guild,
    '📅 YENİ ETKİNLİK OLUŞTURULDU',
    `**Etkinlik:** \`${event.name}\``,
    0x3b82f6
  );
});

client.on('guildScheduledEventDelete', async (event) => {
  if (!event.guild || event.guild.id !== config.guildId) return;
  await logger.sendSystemAlert(
    event.guild,
    '🗑️ ETKİNLİK SİLİNDİ',
    `**Etkinlik:** \`${event.name}\``,
    0x64748b
  );
});

client.login(config.token).catch((err) => {
  logger.logError('CLIENT_LOGIN', err);
  process.exit(1);
});
