const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  AuditLogEvent,
} = require('discord.js');

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  OWNER_ID,
  LOG_CHANNEL_ID,
  PORT = 3000,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !OWNER_ID || !LOG_CHANNEL_ID) {
  console.error('Eksik ortam degiskeni var. Render Environment bolumunu kontrol et.');
  process.exit(1);
}

// Render web servis saglik kontrolu icin basit HTTP sunucu
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('7/24 aktif ve calisiyor');
  })
  .listen(PORT, () => {
    console.log(`HTTP sunucu ${PORT} portunda aktif.`);
  });

const dbPath = path.join(__dirname, 'blacklist-db.json');
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify({ blacklist: {}, actions: [] }, null, 2));
}

function readDb() {
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch {
    return { blacklist: {}, actions: [] };
  }
}

function writeDb(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

function addBlacklist(userId, bannedBy, reason) {
  const db = readDb();
  db.blacklist[userId] = {
    banned_by: bannedBy,
    reason: reason || 'Sebep belirtilmedi',
    created_at: Date.now(),
  };
  writeDb(db);
}

function removeBlacklist(userId) {
  const db = readDb();
  if (!db.blacklist[userId]) return false;
  delete db.blacklist[userId];
  writeDb(db);
  return true;
}

function getBlacklist(userId) {
  const db = readDb();
  return db.blacklist[userId] || null;
}

function recordAndCountAction(adminId, actionType, targetId) {
  const db = readDb();
  const now = Date.now();
  db.actions = db.actions.filter((a) => now - a.created_at < 60000);
  db.actions.push({ admin_id: adminId, action_type: actionType, target_id: targetId, created_at: now });
  writeDb(db);
  return db.actions.filter((a) => a.admin_id === adminId && a.action_type === actionType).length;
}

const commands = [
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Kullaniciyi yasaklar ve kalici kara listeye ekler.')
    .addUserOption((opt) =>
      opt.setName('kullanici').setDescription('Yasaklanacak kullanici').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('sebep').setDescription('Yasaklanma sebebi').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Kara listedeki kullanicinin yasagini kaldirir (Yalnizca Sunucu Sahibi).')
    .addStringOption((opt) =>
      opt.setName('kullanici_id').setDescription('Kullanici ID').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
].map((c) => c.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.GuildMember],
});

async function sendLog(guild, embed) {
  const channel =
    guild.channels.cache.get(LOG_CHANNEL_ID) ||
    (await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null));
  if (channel && channel.isTextBased()) {
    await channel.send({ embeds: [embed] }).catch(() => null);
  }
}

async function handleAntiNuke(guild, executorId, actionType, targetId, summary) {
  if (!executorId || executorId === OWNER_ID || executorId === client.user.id) return;
  const count = recordAndCountAction(executorId, actionType, targetId);
  if (count >= 3) {
    const member = await guild.members.fetch(executorId).catch(() => null);
    let neutralized = false;
    if (member && member.manageable) {
      const roles = member.roles.cache.filter((r) => r.id !== guild.id && r.editable);
      if (roles.size > 0) {
        await member.roles.remove(roles, `Anti-Nuke: ${actionType}`).catch(() => null);
      }
      neutralized = true;
    }

    const embed = new EmbedBuilder()
      .setColor(0xdc2626)
      .setTitle('🚨 ANTI-NUKE TETİKLENDİ')
      .setDescription(
        `<@${OWNER_ID}> **<@${executorId}>** (\`${executorId}\`) 60 saniye içinde kritik işlem eşiğine ulaştı!\n` +
          `**İşlem:** ${summary}\n` +
          `**Müdahale:** ${neutralized ? 'Yetkili rolleri temizlendi.' : 'Manuel müdahale gerekiyor!'}`
      )
      .setTimestamp();

    await sendLog(guild, embed);
  }
}

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log(`Bot aktif: ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ban') {
    const target = interaction.options.getUser('kullanici', true);
    const reason = interaction.options.getString('sebep') || 'Sebep belirtilmedi';

    if (target.id === interaction.user.id) {
      return interaction.reply({ content: 'Kendini yasaklayamazsın.', ephemeral: true });
    }
    if (target.id === OWNER_ID) {
      return interaction.reply({ content: 'Sunucu sahibini yasaklayamazsın.', ephemeral: true });
    }

    await interaction.guild.members.ban(target.id, {
      reason: `[Kara Liste] ${reason} | Yetkili: ${interaction.user.tag}`,
    });
    addBlacklist(target.id, interaction.user.id, reason);

    return interaction.reply({
      content: `**${target.tag}** (\`${target.id}\`) yasaklandı ve **kara listeye** alındı.`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'unban') {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({
        content: 'Kara listedeki yasağı yalnızca **Sunucu Sahibi** kaldırabilir.',
        ephemeral: true,
      });
    }

    const userId = interaction.options.getString('kullanici_id', true).trim();
    const removed = removeBlacklist(userId);
    if (!removed) {
      return interaction.reply({ content: `\`${userId}\` kara listede değil.`, ephemeral: true });
    }

    await interaction.guild.bans.remove(userId, 'Sunucu Sahibi tarafından kaldırıldı.').catch(() => null);
    return interaction.reply({ content: `\`${userId}\` kara listeden çıkarıldı ve banı açıldı.`, ephemeral: true });
  }
});

client.on('guildBanRemove', async (ban) => {
  const guild = ban.guild;
  if (guild.id !== GUILD_ID) return;

  const blacklisted = getBlacklist(ban.user.id);
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanRemove, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find(
    (e) => e.target?.id === ban.user.id && Date.now() - e.createdTimestamp < 10000
  );
  const executor = entry?.executor;

  if (blacklisted && (!executor || executor.id !== OWNER_ID)) {
    await guild.members.ban(ban.user.id, {
      reason: 'Anti-Unban: Kara listedeki kullanıcının yasağı yetkisiz kaldırıldı.',
    }).catch(() => null);

    const embed = new EmbedBuilder()
      .setColor(0xf59e0b)
      .setTitle('🛡️ ANTI-UNBAN ENGELİ')
      .setDescription(
        `Kara listedeki **${ban.user.tag}** (\`${ban.user.id}\`) için ban açma girişimi engellendi ve **geri banlandı**.\n` +
          `**Yasağı Kaldıran:** ${executor ? `${executor.tag} (\`${executor.id}\`)` : 'Bilinmiyor'}\n` +
          `**İlk Banlayan:** <@${blacklisted.banned_by}>\n` +
          `**İlk Sebep:** ${blacklisted.reason}`
      )
      .setTimestamp();

    await sendLog(guild, embed);
    if (executor) {
      await handleAntiNuke(guild, executor.id, 'UNBAN_BLACKLIST', ban.user.id, `Ban kaldırma (${ban.user.id})`);
    }
  }
});

client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== GUILD_ID) return;
  const blacklisted = getBlacklist(member.id);
  if (!blacklisted) return;

  await member.ban({ reason: `Kara Liste Koruması: ${blacklisted.reason}` }).catch(() => null);

  const embed = new EmbedBuilder()
    .setColor(0xef4444)
    .setTitle('⛔ KARA LİSTE GİRİŞİ ENGELLENDİ')
    .setDescription(
      `Kara listedeki **${member.user.tag}** (\`${member.id}\`) sunucuya girmeye çalıştı ve **tekrar yasaklandı**.\n` +
        `**İlk Banlayan:** <@${blacklisted.banned_by}>\n` +
        `**Kayıtlı Sebep:** ${blacklisted.reason}`
    )
    .setTimestamp();

  await sendLog(member.guild, embed);
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild || channel.guild.id !== GUILD_ID) return;
  const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => e.target?.id === channel.id && Date.now() - e.createdTimestamp < 10000);
  if (entry?.executor) {
    await handleAntiNuke(channel.guild, entry.executor.id, 'CHANNEL_DELETE', channel.id, `Kanal silme (#${channel.name})`);
  }
});

client.on('roleDelete', async (role) => {
  if (role.guild.id !== GUILD_ID) return;
  const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleDelete, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => e.target?.id === role.id && Date.now() - e.createdTimestamp < 10000);
  if (entry?.executor) {
    await handleAntiNuke(role.guild, entry.executor.id, 'ROLE_DELETE', role.id, `Rol silme (@${role.name})`);
  }
});

client.login(DISCORD_TOKEN);
