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
  ChannelType,
} = require('discord.js');

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  OWNER_ID,
  LOG_CHANNEL_ID,
  VERIFIED_ROLE_ID,
  QUARANTINE_ROLE_ID,
  PORT = 3000,
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !OWNER_ID || !LOG_CHANNEL_ID) {
  console.error('Eksik ortam degiskeni var. Render Environment bolumunu kontrol et.');
  process.exit(1);
}

const SELF_PING_URL = process.env.SELF_PING_URL || 'https://g-venlik-botu-3.onrender.com';

const dbPath = path.join(__dirname, 'blacklist-db.json');
const defaultDb = {
  blacklist: {},
  actions: [],
  cases: [],
  warnings: {},
  riskScores: {},
  quarantined: {},
  whitelist: { users: [], roles: [] },
  raidMode: { active: false, until: 0 },
};

if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify(defaultDb, null, 2));
}

function readDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    return {
      ...defaultDb,
      ...parsed,
      blacklist: parsed.blacklist || {},
      actions: parsed.actions || [],
      cases: parsed.cases || [],
      warnings: parsed.warnings || {},
      riskScores: parsed.riskScores || {},
      quarantined: parsed.quarantined || {},
      whitelist: {
        users: parsed.whitelist?.users || [],
        roles: parsed.whitelist?.roles || [],
      },
      raidMode: {
        active: Boolean(parsed.raidMode?.active),
        until: Number(parsed.raidMode?.until || 0),
      },
    };
  } catch {
    return { ...defaultDb };
  }
}

function writeDb(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
  ],
  partials: [Partials.GuildMember, Partials.Message, Partials.Channel],
});

// Render HTTP saglik ve canlilik sunucusu
http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          botReady: Boolean(client.user),
          pingMs: client.ws.ping ?? null,
          uptimeSec: Math.floor(process.uptime()),
          timestamp: Date.now(),
        })
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('7/24 aktif ve calisiyor');
  })
  .listen(PORT, () => {
    console.log(`HTTP sunucu ${PORT} portunda aktif.`);
  });

// Her 5 dakikada bir kendi HTTP adresine istek atar
setInterval(() => {
  fetch(SELF_PING_URL).catch(() => {});
  fetch(`${SELF_PING_URL}/health`).catch(() => {});
}, 5 * 60 * 1000);

function addRisk(userId, points) {
  const db = readDb();
  const current = Number(db.riskScores[userId] || 0);
  const next = Math.max(0, Math.min(100, current + points));
  db.riskScores[userId] = next;
  writeDb(db);
  return next;
}

function getRisk(userId) {
  const db = readDb();
  return Number(db.riskScores[userId] || 0);
}

function createCase(type, targetId, moderatorId, reason, extra = {}) {
  const db = readDb();
  const caseNumber = db.cases.length + 1;
  const caseId = `CASE-${String(caseNumber).padStart(4, '0')}`;
  const entry = {
    id: caseId,
    type,
    targetId,
    moderatorId,
    reason: reason || 'Sebep belirtilmedi',
    timestamp: Date.now(),
    ...extra,
  };
  db.cases.push(entry);
  writeDb(db);
  return entry;
}

function addBlacklist(userId, bannedBy, reason) {
  const db = readDb();
  db.blacklist[userId] = {
    banned_by: bannedBy,
    reason: reason || 'Sebep belirtilmedi',
    created_at: Date.now(),
  };
  writeDb(db);
  addRisk(userId, 50);
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

function recordAndCountAction(adminId, actionType, targetId, windowMs = 60000) {
  const db = readDb();
  const now = Date.now();
  db.actions = db.actions.filter((a) => now - a.created_at < windowMs);
  db.actions.push({ admin_id: adminId, action_type: actionType, target_id: targetId, created_at: now });
  writeDb(db);
  return db.actions.filter((a) => a.admin_id === adminId && a.action_type === actionType).length;
}

function isWhitelisted(memberOrId, guild) {
  const db = readDb();
  const userId = typeof memberOrId === 'string' ? memberOrId : memberOrId?.id;
  if (!userId) return false;
  if (userId === OWNER_ID || db.whitelist.users.includes(userId)) return true;
  if (typeof memberOrId === 'object' && memberOrId?.roles?.cache) {
    return memberOrId.roles.cache.some((r) => db.whitelist.roles.includes(r.id));
  }
  if (guild && userId) {
    const m = guild.members.cache.get(userId);
    if (m?.roles?.cache?.some((r) => db.whitelist.roles.includes(r.id))) return true;
  }
  return false;
}

const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ManageWebhooks,
];

function isProtectedRole(role, guild) {
  if (!role || role.id === guild.id) return true;
  if (VERIFIED_ROLE_ID && role.id === VERIFIED_ROLE_ID) return true;
  if (QUARANTINE_ROLE_ID && role.id === QUARANTINE_ROLE_ID) return true;
  if (role.name && role.name.trim().toLowerCase() === 'verified') return true;
  return false;
}

function isDangerousRole(role, guild) {
  if (!role || isProtectedRole(role, guild) || !role.editable) return false;
  return DANGEROUS_PERMISSIONS.some((perm) => role.permissions.has(perm));
}

function parseDurationToMs(input) {
  if (!input) return null;
  const match = input.trim().toLowerCase().match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return value * multipliers[unit];
}

const PHISHING_PATTERNS = [
  /free[\s-]?nitro/i,
  /discord[\s-]?gift/i,
  /steam[\s-]?gift/i,
  /airdrop[\s-]?claim/i,
  /dliscord\.com/i,
  /discorcl\.com/i,
  /discord-nitro\.gift/i,
  /steamcommunity\.ru/i,
];

const PROFANITY_PATTERNS = [
  /\b(amk|aq|orospu|pi[cç]|sikerim|siktir|kahpe|ibne|g[oö]t)\b/i,
];

const SPAM_TRACKER = new Map();

function checkMessageThreat(message) {
  const content = message.content || '';
  const lower = content.toLowerCase();

  for (const rx of PHISHING_PATTERNS) {
    if (rx.test(lower)) {
      return { reason: 'Zararli / sahte baglanti tespit edildi', risk: 25, timeoutMs: 15 * 60 * 1000 };
    }
  }

  for (const rx of PROFANITY_PATTERNS) {
    if (rx.test(lower)) {
      return { reason: 'Kufur / hakaret icerigi', risk: 10, timeoutMs: 5 * 60 * 1000 };
    }
  }

  if (/(discord\.gg\/|discordapp\.com\/invite\/|discord\.com\/invite\/)/i.test(content)) {
    return { reason: 'Izinsiz Discord davet baglantisi', risk: 15, timeoutMs: 10 * 60 * 1000 };
  }

  if (/https?:\/\/(bit\.ly|tinyurl\.com|t\.co|rb\.gy|cutt\.ly|is\.gd)\//i.test(content)) {
    return { reason: 'Kisaltilmis harici baglanti', risk: 15, timeoutMs: 10 * 60 * 1000 };
  }

  if (message.mentions.users.size >= 6) {
    return { reason: 'Toplu kullanici etiketleme (Mass Mention)', risk: 15, timeoutMs: 10 * 60 * 1000 };
  }

  const letters = content.replace(/[^a-zA-ZçğıöşüÇĞİÖŞÜ]/g, '');
  if (letters.length >= 14) {
    const upperCount = letters.replace(/[^A-ZÇĞİÖŞÜ]/g, '').length;
    if (upperCount / letters.length >= 0.75) {
      return { reason: 'Asiri buyuk harf (Caps Lock)', risk: 5, timeoutMs: null };
    }
  }

  const now = Date.now();
  const userKey = message.author.id;
  const recent = (SPAM_TRACKER.get(userKey) || []).filter((item) => now - item.ts < 7000);
  recent.push({ ts: now, text: lower.trim() });
  SPAM_TRACKER.set(userKey, recent);

  const duplicateCount = recent.filter((item) => item.text && item.text === lower.trim()).length;
  if (recent.length >= 6 || duplicateCount >= 3) {
    SPAM_TRACKER.set(userKey, []);
    return { reason: 'Mesaj flood / tekrarlayan icerik', risk: 15, timeoutMs: 10 * 60 * 1000 };
  }

  return null;
}

const commands = [
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Kullaniciyi yasaklar, vaka olusturur ve kara listeye ekler.')
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

  new SlashCommandBuilder()
    .setName('karaliste')
    .setDescription('Kara liste islemlerini yonetir.')
    .addSubcommand((sub) =>
      sub
        .setName('ekle')
        .setDescription('Kullaniciyi kara listeye ekler ve yasaklar.')
        .addStringOption((opt) =>
          opt.setName('kullanici_id').setDescription('Kullanici ID').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('sebep').setDescription('Sebep').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('cikar')
        .setDescription('Kullaniciyi kara listeden cikarir (Yalnizca Sunucu Sahibi).')
        .addStringOption((opt) =>
          opt.setName('kullanici_id').setDescription('Kullanici ID').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('sorgu')
        .setDescription('Kullanicinin kara liste ve risk durumunu sorgular.')
        .addStringOption((opt) =>
          opt.setName('kullanici_id').setDescription('Kullanici ID').setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('guvenli-liste')
    .setDescription('Guvenli liste (whitelist) islemlerini yonetir (Yalnizca Sunucu Sahibi).')
    .addSubcommand((sub) =>
      sub
        .setName('ekle')
        .setDescription('Kullanici veya rol ID ekler.')
        .addStringOption((opt) =>
          opt.setName('tur').setDescription('kullanici veya rol').setRequired(true).addChoices(
            { name: 'kullanici', value: 'kullanici' },
            { name: 'rol', value: 'rol' }
          )
        )
        .addStringOption((opt) =>
          opt.setName('id').setDescription('Kullanici veya Rol ID').setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('cikar')
        .setDescription('Kullanici veya rol ID cikarir.')
        .addStringOption((opt) =>
          opt.setName('tur').setDescription('kullanici veya rol').setRequired(true).addChoices(
            { name: 'kullanici', value: 'kullanici' },
            { name: 'rol', value: 'rol' }
          )
        )
        .addStringOption((opt) =>
          opt.setName('id').setDescription('Kullanici veya Rol ID').setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kullaniciyi sunucudan atar ve vaka kaydeder.')
    .addUserOption((opt) =>
      opt.setName('kullanici').setDescription('Atilacak kullanici').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('sebep').setDescription('Sebep').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Kullaniciya sureli susturma uygular (ornek: 10m, 1h, 1d).')
    .addUserOption((opt) =>
      opt.setName('kullanici').setDescription('Susturulacak kullanici').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('sure').setDescription('Sure (10m, 1h, 1d)').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('sebep').setDescription('Sebep').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Kullanicinin susturmasini kaldirir.')
    .addUserOption((opt) =>
      opt.setName('kullanici').setDescription('Kullanici').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('uyar')
    .setDescription('Kullaniciya resmi uyari verir ve risk puanini gunceller.')
    .addUserOption((opt) =>
      opt.setName('kullanici').setDescription('Uyarilacak kullanici').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('sebep').setDescription('Uyari sebebi').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('sicil')
    .setDescription('Kullanicinin uyari, vaka ve risk puanini goruntuler.')
    .addUserOption((opt) =>
      opt.setName('kullanici').setDescription('Sorgulanacak kullanici').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('vaka-sil')
    .setDescription('Belirtilen vaka kaydini siler (Yalnizca Sunucu Sahibi).')
    .addStringOption((opt) =>
      opt.setName('vaka_id').setDescription('Ornek: CASE-0001').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('karantina')
    .setDescription('Kullaniciyi karantinaya alir veya karantinadan cikarir.')
    .addSubcommand((sub) =>
      sub
        .setName('al')
        .setDescription('Kullanicinin rollerini yedekleyip karantinaya alir.')
        .addUserOption((opt) =>
          opt.setName('kullanici').setDescription('Kullanici').setRequired(true)
        )
        .addStringOption((opt) =>
          opt.setName('sebep').setDescription('Sebep').setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('cikar')
        .setDescription('Kullaniciyi karantinadan cikarip rollerini iade eder.')
        .addUserOption((opt) =>
          opt.setName('kullanici').setDescription('Kullanici').setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('temizle')
    .setDescription('Kanaldaki son mesajlari siler (1-100).')
    .addIntegerOption((opt) =>
      opt
        .setName('adet')
        .setDescription('Silinecek mesaj sayisi (1-100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('kilit')
    .setDescription('Mevcut kanali yazmaya kapatir veya acar.')
    .addBooleanOption((opt) =>
      opt.setName('durum').setDescription('true = kilitle, false = kilidi ac').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName('sunucu-kilit')
    .setDescription('Tum metin kanallarini kilitler veya acar (Yalnizca Sunucu Sahibi).')
    .addBooleanOption((opt) =>
      opt.setName('durum').setDescription('true = tum kanallari kilitle, false = ac').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('yavas-mod')
    .setDescription('Kanalin yavas mod suresini ayarlar (0-21600 saniye).')
    .addIntegerOption((opt) =>
      opt
        .setName('saniye')
        .setDescription('Yavas mod suresi (saniye)')
        .setMinValue(0)
        .setMaxValue(21600)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName('yetki-denetimi')
    .setDescription('Sunucudaki kritik yetkili rolleri listeler.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('kullanici-bilgi')
    .setDescription('Kullanici hakkinda guvenlik ve hesap bilgilerini gosterir.')
    .addUserOption((opt) =>
      opt.setName('kullanici').setDescription('Kullanici').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('sistem-durumu')
    .setDescription('Guvenlik sisteminin ve botun anlik durumunu gosterir.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

async function sendLog(guild, embed) {
  const channel =
    guild.channels.cache.get(LOG_CHANNEL_ID) ||
    (await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null));
  if (channel && channel.isTextBased()) {
    await channel.send({ embeds: [embed] }).catch(() => null);
  }
}

async function isolateDangerousRoles(member, guild, reason) {
  if (!member || !member.manageable) return [];
  const removable = member.roles.cache.filter((r) => isDangerousRole(r, guild));
  const removedNames = [];
  if (removable.size > 0) {
    await member.roles.remove(removable, reason).catch(() => null);
    removable.forEach((r) => removedNames.push(r.name));
  }
  return removedNames;
}

async function handleAntiNuke(guild, executorId, actionType, targetId, summary) {
  if (!executorId || executorId === OWNER_ID || executorId === client.user.id) return;
  if (isWhitelisted(executorId, guild)) return;

  const count = recordAndCountAction(executorId, actionType, targetId);
  if (count >= 3) {
    const member = await guild.members.fetch(executorId).catch(() => null);
    const removedRoles = await isolateDangerousRoles(
      member,
      guild,
      `Anti-Nuke: ${actionType} esigi asildi`
    );
    const risk = addRisk(executorId, 35);
    const caseEntry = createCase('ANTI_NUKE', targetId, executorId, summary, {
      removedRoles,
    });

    const embed = new EmbedBuilder()
      .setColor(0xdc2626)
      .setTitle('🚨 ANTI-NUKE MÜDAHALESİ')
      .setDescription(
        `<@${OWNER_ID}> **<@${executorId}>** (\`${executorId}\`) 60 saniye içinde kritik işlem eşiğine ulaştı.\n` +
          `**Vaka:** \`${caseEntry.id}\`\n` +
          `**İşlem:** ${summary}\n` +
          `**Alınan Tehlikeli Roller:** ${
            removedRoles.length > 0 ? removedRoles.map((n) => `\`${n}\``).join(', ') : 'Yok / Yetki yetersiz'
          }\n` +
          `**Koruma:** \`Verified\` ve güvenli roller korunmuştur.\n` +
          `**Risk Puanı:** \`${risk}/100\``
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
  const guild = interaction.guild;
  if (!guild || guild.id !== GUILD_ID) return;

  if (interaction.commandName === 'ban') {
    const target = interaction.options.getUser('kullanici', true);
    const reason = interaction.options.getString('sebep') || 'Sebep belirtilmedi';

    if (target.id === interaction.user.id) {
      return interaction.reply({ content: 'Kendini yasaklayamazsın.', ephemeral: true });
    }
    if (target.id === OWNER_ID) {
      return interaction.reply({ content: 'Sunucu sahibini yasaklayamazsın.', ephemeral: true });
    }

    await guild.members.ban(target.id, {
      reason: `[Kara Liste] ${reason} | Yetkili: ${interaction.user.tag}`,
    });
    addBlacklist(target.id, interaction.user.id, reason);
    const caseEntry = createCase('BAN', target.id, interaction.user.id, reason);

    return interaction.reply({
      content: `**${target.tag}** (\`${target.id}\`) yasaklandı ve kara listeye alındı. (\`${caseEntry.id}\`)`,
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

    await guild.bans.remove(userId, 'Sunucu Sahibi tarafından kaldırıldı.').catch(() => null);
    const caseEntry = createCase('UNBAN', userId, interaction.user.id, 'Kara listeden çıkarıldı');
    return interaction.reply({
      content: `\`${userId}\` kara listeden çıkarıldı ve yasağı kaldırıldı. (\`${caseEntry.id}\`)`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'karaliste') {
    const sub = interaction.options.getSubcommand();
    const userId = interaction.options.getString('kullanici_id', true).trim();

    if (sub === 'ekle') {
      const reason = interaction.options.getString('sebep') || 'Kara listeye eklendi';
      if (userId === OWNER_ID) {
        return interaction.reply({ content: 'Sunucu sahibi kara listeye eklenemez.', ephemeral: true });
      }
      await guild.members.ban(userId, { reason: `[Kara Liste] ${reason}` }).catch(() => null);
      addBlacklist(userId, interaction.user.id, reason);
      const caseEntry = createCase('BLACKLIST_ADD', userId, interaction.user.id, reason);
      return interaction.reply({
        content: `\`${userId}\` kara listeye eklendi. (\`${caseEntry.id}\`)`,
        ephemeral: true,
      });
    }

    if (sub === 'cikar') {
      if (interaction.user.id !== OWNER_ID) {
        return interaction.reply({
          content: 'Kara listeden çıkarma yetkisi yalnızca **Sunucu Sahibi**ne aittir.',
          ephemeral: true,
        });
      }
      const ok = removeBlacklist(userId);
      if (!ok) {
        return interaction.reply({ content: `\`${userId}\` kara listede bulunamadı.`, ephemeral: true });
      }
      await guild.bans.remove(userId, 'Kara listeden çıkarıldı').catch(() => null);
      return interaction.reply({ content: `\`${userId}\` kara listeden çıkarıldı.`, ephemeral: true });
    }

    if (sub === 'sorgu') {
      const entry = getBlacklist(userId);
      const risk = getRisk(userId);
      if (!entry) {
        return interaction.reply({
          content: `\`${userId}\` kara listede değil. | Risk Puanı: \`${risk}/100\``,
          ephemeral: true,
        });
      }
      return interaction.reply({
        content:
          `\`${userId}\` **kara listede** kayıtlı.\n` +
          `Yetkili: <@${entry.banned_by}> | Sebep: ${entry.reason} | Risk: \`${risk}/100\``,
        ephemeral: true,
      });
    }
  }

  if (interaction.commandName === 'guvenli-liste') {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({
        content: 'Güvenli liste yalnızca **Sunucu Sahibi** tarafından yönetilebilir.',
        ephemeral: true,
      });
    }
    const sub = interaction.options.getSubcommand();
    const type = interaction.options.getString('tur', true);
    const id = interaction.options.getString('id', true).trim();
    const bucket = type === 'kullanici' ? 'users' : 'roles';
    const db = readDb();

    if (sub === 'ekle') {
      if (!db.whitelist[bucket].includes(id)) {
        db.whitelist[bucket].push(id);
        writeDb(db);
      }
      return interaction.reply({ content: `\`${id}\` (${type}) güvenli listeye eklendi.`, ephemeral: true });
    }

    if (sub === 'cikar') {
      db.whitelist[bucket] = db.whitelist[bucket].filter((x) => x !== id);
      writeDb(db);
      return interaction.reply({ content: `\`${id}\` (${type}) güvenli listeden çıkarıldı.`, ephemeral: true });
    }
  }

  if (interaction.commandName === 'kick') {
    const target = interaction.options.getUser('kullanici', true);
    const reason = interaction.options.getString('sebep') || 'Sebep belirtilmedi';
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (!member || !member.kickable) {
      return interaction.reply({ content: 'Bu kullanıcı sunucudan atılamıyor.', ephemeral: true });
    }
    await member.kick(`${reason} | Yetkili: ${interaction.user.tag}`);
    const risk = addRisk(target.id, 15);
    const caseEntry = createCase('KICK', target.id, interaction.user.id, reason);
    return interaction.reply({
      content: `**${target.tag}** sunucudan atıldı. (\`${caseEntry.id}\` | Risk: \`${risk}/100\`)`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'timeout') {
    const target = interaction.options.getUser('kullanici', true);
    const durationRaw = interaction.options.getString('sure', true);
    const reason = interaction.options.getString('sebep') || 'Sebep belirtilmedi';
    const ms = parseDurationToMs(durationRaw);
    if (!ms || ms > 28 * 24 * 60 * 60 * 1000) {
      return interaction.reply({
        content: 'Geçerli bir süre girin (örnek: `10m`, `1h`, `1d`; en fazla 28 gün).',
        ephemeral: true,
      });
    }
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (!member || !member.moderatable) {
      return interaction.reply({ content: 'Bu kullanıcı susturulamıyor.', ephemeral: true });
    }
    await member.timeout(ms, `${reason} | Yetkili: ${interaction.user.tag}`);
    const risk = addRisk(target.id, 10);
    const caseEntry = createCase('TIMEOUT', target.id, interaction.user.id, `${durationRaw} - ${reason}`);
    return interaction.reply({
      content: `**${target.tag}** \`${durationRaw}\` süreyle susturuldu. (\`${caseEntry.id}\` | Risk: \`${risk}/100\`)`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'untimeout') {
    const target = interaction.options.getUser('kullanici', true);
    const member = await guild.members.fetch(target.id).catch(() => null);
    if (!member || !member.moderatable) {
      return interaction.reply({ content: 'Susturma kaldırılamadı.', ephemeral: true });
    }
    await member.timeout(null, `Susturma kaldırıldı | Yetkili: ${interaction.user.tag}`);
    return interaction.reply({ content: `**${target.tag}** kullanıcısının susturması kaldırıldı.`, ephemeral: true });
  }

  if (interaction.commandName === 'uyar') {
    const target = interaction.options.getUser('kullanici', true);
    const reason = interaction.options.getString('sebep', true);
    const db = readDb();
    db.warnings[target.id] = db.warnings[target.id] || [];
    db.warnings[target.id].push({
      reason,
      moderatorId: interaction.user.id,
      timestamp: Date.now(),
    });
    writeDb(db);
    const risk = addRisk(target.id, 10);
    const caseEntry = createCase('WARN', target.id, interaction.user.id, reason);
    return interaction.reply({
      content: `**${target.tag}** uyarıldı. Toplam uyarı: \`${db.warnings[target.id].length}\` | Risk: \`${risk}/100\` (\`${caseEntry.id}\`)`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'sicil') {
    const target = interaction.options.getUser('kullanici', true);
    const db = readDb();
    const warns = db.warnings[target.id] || [];
    const cases = db.cases.filter((c) => c.targetId === target.id).slice(-5);
    const risk = getRisk(target.id);
    const bl = Boolean(getBlacklist(target.id));

    const embed = new EmbedBuilder()
      .setColor(0x1f2937)
      .setTitle(`Sicil Kaydı — ${target.tag}`)
      .addFields(
        { name: 'Kullanıcı ID', value: `\`${target.id}\``, inline: true },
        { name: 'Risk Puanı', value: `\`${risk}/100\``, inline: true },
        { name: 'Kara Liste', value: bl ? 'Evet' : 'Hayır', inline: true },
        { name: 'Uyarı Sayısı', value: `\`${warns.length}\``, inline: true },
        {
          name: 'Son Vakalar',
          value:
            cases.length > 0
              ? cases.map((c) => `\`${c.id}\` **${c.type}** — ${c.reason}`).join('\n')
              : 'Kayıt bulunmuyor.',
        }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === 'vaka-sil') {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({
        content: 'Vaka silme yetkisi yalnızca **Sunucu Sahibi**ne aittir.',
        ephemeral: true,
      });
    }
    const vakaId = interaction.options.getString('vaka_id', true).trim().toUpperCase();
    const db = readDb();
    const before = db.cases.length;
    db.cases = db.cases.filter((c) => c.id !== vakaId);
    if (db.cases.length === before) {
      return interaction.reply({ content: `\`${vakaId}\` bulunamadı.`, ephemeral: true });
    }
    writeDb(db);
    return interaction.reply({ content: `\`${vakaId}\` silindi.`, ephemeral: true });
  }

  if (interaction.commandName === 'karantina') {
    if (!QUARANTINE_ROLE_ID) {
      return interaction.reply({
        content: 'Karantina rolü (`QUARANTINE_ROLE_ID`) tanımlanmamış.',
        ephemeral: true,
      });
    }
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getUser('kullanici', true);
    const member = await guild.members.fetch(target.id).catch(() => null);
    const qRole = guild.roles.cache.get(QUARANTINE_ROLE_ID);

    if (!member || !qRole) {
      return interaction.reply({ content: 'Üye veya karantina rolü bulunamadı.', ephemeral: true });
    }

    if (sub === 'al') {
      const reason = interaction.options.getString('sebep') || 'Karantina işlemi';
      const savedRoles = member.roles.cache
        .filter((r) => r.id !== guild.id && r.id !== QUARANTINE_ROLE_ID && r.editable)
        .map((r) => r.id);

      const db = readDb();
      db.quarantined[target.id] = { roles: savedRoles, reason, since: Date.now() };
      writeDb(db);

      if (savedRoles.length > 0) {
        await member.roles.remove(savedRoles, `Karantina: ${reason}`).catch(() => null);
      }
      await member.roles.add(qRole, `Karantina: ${reason}`).catch(() => null);
      const risk = addRisk(target.id, 20);
      const caseEntry = createCase('QUARANTINE_ADD', target.id, interaction.user.id, reason);

      return interaction.reply({
        content: `**${target.tag}** karantinaya alındı. (\`${caseEntry.id}\` | Risk: \`${risk}/100\`)`,
        ephemeral: true,
      });
    }

    if (sub === 'cikar') {
      const db = readDb();
      const record = db.quarantined[target.id];
      await member.roles.remove(qRole, 'Karantinadan çıkarıldı').catch(() => null);
      if (record?.roles?.length) {
        const restore = record.roles.map((id) => guild.roles.cache.get(id)).filter(Boolean);
        if (restore.length > 0) {
          await member.roles.add(restore, 'Karantina sonrası rol iadesi').catch(() => null);
        }
      }
      delete db.quarantined[target.id];
      writeDb(db);
      return interaction.reply({ content: `**${target.tag}** karantinadan çıkarıldı.`, ephemeral: true });
    }
  }

  if (interaction.commandName === 'temizle') {
    const count = interaction.options.getInteger('adet', true);
    if (!interaction.channel || !interaction.channel.isTextBased() || interaction.channel.isDMBased()) {
      return interaction.reply({ content: 'Bu kanalda mesaj temizlenemez.', ephemeral: true });
    }
    const deleted = await interaction.channel.bulkDelete(count, true).catch(() => null);
    return interaction.reply({
      content: `\`${deleted ? deleted.size : 0}\` mesaj temizlendi.`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'kilit') {
    const lock = interaction.options.getBoolean('durum', true);
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
      return interaction.reply({ content: 'Bu komut metin kanallarında kullanılabilir.', ephemeral: true });
    }
    await channel.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: lock ? false : null,
    });
    return interaction.reply({
      content: lock ? `<#${channel.id}> yazmaya kapatıldı.` : `<#${channel.id}> kilidi açıldı.`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'sunucu-kilit') {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({
        content: 'Sunucu geneli kilit işlemi yalnızca **Sunucu Sahibi**ne aittir.',
        ephemeral: true,
      });
    }
    const lock = interaction.options.getBoolean('durum', true);
    await interaction.deferReply({ ephemeral: true });

    let affected = 0;
    const textChannels = guild.channels.cache.filter((c) => c.type === ChannelType.GuildText);
    for (const [, ch] of textChannels) {
      const ok = await ch.permissionOverwrites
        .edit(guild.roles.everyone, { SendMessages: lock ? false : null })
        .then(() => true)
        .catch(() => false);
      if (ok) affected++;
    }

    return interaction.editReply({
      content: lock
        ? `Acil kilit aktif: \`${affected}\` metin kanalı yazmaya kapatıldı.`
        : `Sunucu kilidi kaldırıldı: \`${affected}\` metin kanalı açıldı.`,
    });
  }

  if (interaction.commandName === 'yavas-mod') {
    const seconds = interaction.options.getInteger('saniye', true);
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      return interaction.reply({ content: 'Bu kanalda yavaş mod ayarlanamaz.', ephemeral: true });
    }
    await channel.setRateLimitPerUser(seconds);
    return interaction.reply({
      content: `<#${channel.id}> yavaş modu \`${seconds}s\` olarak ayarlandı.`,
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'yetki-denetimi') {
    const riskyRoles = guild.roles.cache
      .filter((r) => r.id !== guild.id && isDangerousRole(r, guild))
      .map((r) => `\`${r.name}\` (${r.id})`);

    return interaction.reply({
      content:
        riskyRoles.length > 0
          ? `**Kritik Yetkili Roller (${riskyRoles.length}):**\n${riskyRoles.join('\n')}`
          : 'Denetlenebilir kritik yetkili rol bulunamadı.',
      ephemeral: true,
    });
  }

  if (interaction.commandName === 'kullanici-bilgi') {
    const user = interaction.options.getUser('kullanici') || interaction.user;
    const member = await guild.members.fetch(user.id).catch(() => null);
    const risk = getRisk(user.id);
    const bl = Boolean(getBlacklist(user.id));

    const embed = new EmbedBuilder()
      .setColor(0x111827)
      .setTitle(`Kullanıcı Bilgisi — ${user.tag}`)
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: 'ID', value: `\`${user.id}\``, inline: true },
        { name: 'Risk Puanı', value: `\`${risk}/100\``, inline: true },
        { name: 'Kara Liste', value: bl ? 'Aktif' : 'Hayır', inline: true },
        { name: 'Hesap Kuruluşu', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
        {
          name: 'Sunucuya Katılım',
          value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Bilinmiyor',
          inline: true,
        }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === 'sistem-durumu') {
    const db = readDb();
    const raidActive = db.raidMode.active && Date.now() < db.raidMode.until;
    const uptimeMin = Math.floor(process.uptime() / 60);

    const embed = new EmbedBuilder()
      .setColor(0x0f172a)
      .setTitle('Sistem Durum Raporu')
      .addFields(
        { name: 'Gecikme', value: `\`${client.ws.ping}ms\``, inline: true },
        { name: 'Çalışma Süresi', value: `\`${uptimeMin} dk\``, inline: true },
        { name: 'Raid Kalkanı', value: raidActive ? 'Aktif' : 'Normal', inline: true },
        { name: 'Kara Liste Kaydı', value: `\`${Object.keys(db.blacklist).length}\``, inline: true },
        { name: 'Toplam Vaka', value: `\`${db.cases.length}\``, inline: true },
        {
          name: 'Verified Koruması',
          value: VERIFIED_ROLE_ID ? `ID: \`${VERIFIED_ROLE_ID}\`` : 'İsim tabanlı (`verified`)',
          inline: true,
        }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.guild.id !== GUILD_ID) return;
  if (message.author.bot) return;
  if (isWhitelisted(message.member, message.guild)) return;

  const threat = checkMessageThreat(message);
  if (!threat) return;

  await message.delete().catch(() => null);
  const risk = addRisk(message.author.id, threat.risk);
  createCase('AUTOMOD', message.author.id, client.user.id, threat.reason);

  if (threat.timeoutMs && message.member?.moderatable) {
    await message.member.timeout(threat.timeoutMs, `AutoMod: ${threat.reason}`).catch(() => null);
  }

  const embed = new EmbedBuilder()
    .setColor(0xeab308)
    .setTitle('🛡️ AUTOMOD MÜDAHALESİ')
    .setDescription(
      `**Kullanıcı:** <@${message.author.id}> (\`${message.author.id}\`)\n` +
        `**Kanal:** <#${message.channel.id}>\n` +
        `**Neden:** ${threat.reason}\n` +
        `**Yaptırım:** Mesaj silindi${threat.timeoutMs ? ' + Süreli susturma uygulandı' : ''}\n` +
        `**Risk Puanı:** \`${risk}/100\``
    )
    .setTimestamp();

  await sendLog(message.guild, embed);
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
    await guild.members
      .ban(ban.user.id, {
        reason: 'Anti-Unban: Kara listedeki kullanıcının yasağı yetkisiz kaldırıldı.',
      })
      .catch(() => null);

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
  if (blacklisted) {
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
    return;
  }

  if (member.user.bot) {
    const logs = await member.guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 }).catch(() => null);
    const entry = logs?.entries.find(
      (e) => e.target?.id === member.id && Date.now() - e.createdTimestamp < 10000
    );
    const adder = entry?.executor;

    if (!adder || (adder.id !== OWNER_ID && !isWhitelisted(adder.id, member.guild))) {
      await member.kick('Yetkisiz bot ekleme engellendi').catch(() => null);
      if (adder) {
        await handleAntiNuke(member.guild, adder.id, 'BOT_ADD', member.id, `Yetkisiz bot ekleme (${member.user.tag})`);
      }
      const embed = new EmbedBuilder()
        .setColor(0xdc2626)
        .setTitle('🤖 YETKİSİZ BOT ENGELLENDİ')
        .setDescription(
          `**Bot:** ${member.user.tag} (\`${member.id}\`)\n` +
            `**Ekleyen:** ${adder ? `<@${adder.id}> (\`${adder.id}\`)` : 'Bilinmiyor'}\n` +
            `**İşlem:** Bot sunucudan çıkarıldı.`
        )
        .setTimestamp();
      await sendLog(member.guild, embed);
    }
    return;
  }

  const joinCount = recordAndCountAction('SYSTEM_RAID', 'MEMBER_JOIN', member.id, 10000);
  const db = readDb();
  if (joinCount >= 8) {
    db.raidMode = { active: true, until: Date.now() + 10 * 60 * 1000 };
    writeDb(db);
  }

  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
  const raidActive = db.raidMode.active && Date.now() < db.raidMode.until;

  if (raidActive && accountAgeDays < 7 && QUARANTINE_ROLE_ID) {
    const qRole = member.guild.roles.cache.get(QUARANTINE_ROLE_ID);
    if (qRole) {
      await member.roles.add(qRole, 'Raid koruması: Yeni hesap karantinaya alındı').catch(() => null);
    }
    addRisk(member.id, 30);

    const embed = new EmbedBuilder()
      .setColor(0xf97316)
      .setTitle('⚠️ RAİD KALKANI — ŞÜPHELİ HESAP KARANTİNADA')
      .setDescription(
        `**Üye:** <@${member.id}> (\`${member.id}\`)\n` +
          `**Hesap Yaşı:** \`${accountAgeDays.toFixed(1)} gün\`\n` +
          `**İşlem:** Karantina rolü uygulandı.`
      )
      .setTimestamp();

    await sendLog(member.guild, embed);
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  if (newMember.guild.id !== GUILD_ID) return;

  const addedRoles = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
  const dangerousAdded = addedRoles.filter((r) => isDangerousRole(r, newMember.guild));
  if (dangerousAdded.size === 0) return;

  const logs = await newMember.guild
    .fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 5 })
    .catch(() => null);
  const entry = logs?.entries.find(
    (e) => e.target?.id === newMember.id && Date.now() - e.createdTimestamp < 10000
  );
  const executor = entry?.executor;

  if (!executor || executor.id === OWNER_ID || executor.id === client.user.id) return;
  if (isWhitelisted(executor.id, newMember.guild)) return;

  await handleAntiNuke(
    newMember.guild,
    executor.id,
    'DANGEROUS_ROLE_ASSIGN',
    newMember.id,
    `Tehlikeli rol atama -> ${newMember.user.tag} (${dangerousAdded.map((r) => r.name).join(', ')})`
  );
});

client.on('webhooksUpdate', async (channel) => {
  if (!channel.guild || channel.guild.id !== GUILD_ID) return;
  const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.WebhookCreate, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => Date.now() - e.createdTimestamp < 10000);
  if (!entry?.executor) return;

  const executorId = entry.executor.id;
  if (executorId === OWNER_ID || executorId === client.user.id || isWhitelisted(executorId, channel.guild)) {
    return;
  }

  const webhooks = await channel.fetchWebhooks().catch(() => null);
  if (webhooks && entry.target?.id) {
    const created = webhooks.get(entry.target.id);
    if (created) {
      await created.delete('Anti-Webhook: Yetkisiz webhook silindi').catch(() => null);
    }
  }

  await handleAntiNuke(
    channel.guild,
    executorId,
    'WEBHOOK_CREATE',
    entry.target?.id || channel.id,
    `Yetkisiz webhook oluşturma (#${channel.name})`
  );
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild || channel.guild.id !== GUILD_ID) return;
  const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => e.target?.id === channel.id && Date.now() - e.createdTimestamp < 10000);
  if (entry?.executor) {
    await handleAntiNuke(channel.guild, entry.executor.id, 'CHANNEL_DELETE', channel.id, `Kanal silme (#${channel.name})`);
  }
});

client.on('channelCreate', async (channel) => {
  if (!channel.guild || channel.guild.id !== GUILD_ID) return;
  const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => e.target?.id === channel.id && Date.now() - e.createdTimestamp < 10000);
  if (entry?.executor) {
    await handleAntiNuke(channel.guild, entry.executor.id, 'CHANNEL_CREATE', channel.id, `Kanal oluşturma (#${channel.name})`);
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

client.on('roleCreate', async (role) => {
  if (role.guild.id !== GUILD_ID) return;
  const logs = await role.guild.fetchAuditLogs({ type: AuditLogEvent.RoleCreate, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => e.target?.id === role.id && Date.now() - e.createdTimestamp < 10000);
  if (entry?.executor) {
    await handleAntiNuke(role.guild, entry.executor.id, 'ROLE_CREATE', role.id, `Rol oluşturma (@${role.name})`);
  }
});

client.on('guildUpdate', async (oldGuild, newGuild) => {
  if (newGuild.id !== GUILD_ID) return;
  const logs = await newGuild.fetchAuditLogs({ type: AuditLogEvent.GuildUpdate, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => Date.now() - e.createdTimestamp < 10000);
  if (entry?.executor) {
    await handleAntiNuke(
      newGuild,
      entry.executor.id,
      'GUILD_UPDATE',
      newGuild.id,
      `Sunucu ayarı değişikliği (${oldGuild.name} -> ${newGuild.name})`
    );
  }
});

client.login(DISCORD_TOKEN);
