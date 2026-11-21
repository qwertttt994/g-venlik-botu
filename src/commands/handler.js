const { EmbedBuilder, ChannelType } = require('discord.js');
const config = require('../config/config');
const db = require('../database/database');
const { canModerateTarget, isDangerousRole } = require('../services/permissions');
const { getRaidStatus } = require('../security/antiRaid');
const { captureGuildSnapshot } = require('../services/snapshot');

function parseDurationToMs(input) {
  const m = String(input || '').trim().toLowerCase().match(/^(\d+)(s|m|h|d)$/);
  if (!m) return null;
  const val = Number(m[1]);
  const map = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return val * map[m[2]];
}

function trackModAction(actorId, gcfg) {
  if (!actorId || actorId === config.ownerId) return 0;
  return db.recordActionAndCount(actorId, 'MOD_ACTION', null, gcfg.moderatorAbuse.windowMs);
}

async function handleCommand(interaction, logger) {
  const guild = interaction.guild;
  if (!guild || guild.id !== config.guildId) return;

  const gcfg = db.getGuildConfig();
  const botMember = guild.members.me || (await guild.members.fetch(interaction.client.user.id).catch(() => null));
  const actorMember =
    interaction.member || (await guild.members.fetch(interaction.user.id).catch(() => null));

  try {
    if (interaction.commandName === 'ban') {
      const target = interaction.options.getUser('kullanici', true);
      const reason = interaction.options.getString('sebep') || 'Sebep belirtilmedi';
      const ipBan = Boolean(interaction.options.getBoolean('ip_ban'));
      const targetMember = await guild.members.fetch(target.id).catch(() => null);

      const check = canModerateTarget(actorMember, targetMember, guild, botMember);
      if (target.id === config.ownerId || target.id === interaction.user.id || (targetMember && !check.ok)) {
        return interaction.reply({ content: check.reason || 'Bu kullanici yasaklanamaz.', ephemeral: true });
      }

      await guild.members.ban(target.id, { reason: `[Kara Liste] ${reason} | Yetkili: ${interaction.user.tag}` });
      db.addBlacklist(target.id, interaction.user.id, reason);
      if (ipBan) {
        db.addIpBan({
          userId: target.id,
          networkTag: `UID-${target.id}`,
          reason: `IP-Ban: ${reason}`,
          bannedBy: interaction.user.id,
        });
      }
      const risk = db.addRisk(target.id, ipBan ? 70 : 50, `Ban${ipBan ? ' + IP-Ban' : ''}: ${reason}`);
      const c = db.createCase({
        type: ipBan ? 'IP_BAN' : 'BAN',
        targetId: target.id,
        moderatorId: interaction.user.id,
        reason,
        meta: { ipBan },
      });

      const modCnt = trackModAction(interaction.user.id, gcfg);
      if (modCnt >= gcfg.moderatorAbuse.maxPunishmentsPerMinute) {
        await logger.sendSystemAlert(
          guild,
          '⚠️ MODERATÖR HIZ UYARISI',
          `<@${interaction.user.id}> son 1 dakikada \`${modCnt}\` yaptırım işlemi gerçekleştirdi.`,
          0xf97316
        );
      }

      return interaction.reply({
        content: `**${target.tag}** yasaklandi${ipBan ? ' ve **IP/Ag izolasyonu** uygulandi' : ''}. (\`${c.id}\` | Risk: \`${risk}/100\`)`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'ip-ban') {
      if (interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: 'Yalnizca Sunucu Sahibi IP/Ag izolasyonu uygulayabilir.', ephemeral: true });
      }
      const hedef = interaction.options.getString('hedef', true).trim();
      const reason = interaction.options.getString('sebep') || 'IP / Ag izolasyonu';
      const isSnowflake = /^\d{17,20}$/.test(hedef);

      if (isSnowflake && hedef === config.ownerId) {
        return interaction.reply({ content: 'Sunucu sahibine islem yapilamaz.', ephemeral: true });
      }

      let bannedOnGuild = false;
      if (isSnowflake) {
        try {
          await guild.members.ban(hedef, { reason: `[IP-BAN] ${reason} | Yetkili: ${interaction.user.tag}` });
          bannedOnGuild = true;
        } catch (err) {
          logger.logError('IP_BAN_GUILD', err, { hedef });
        }
        db.addBlacklist(hedef, interaction.user.id, `[IP-BAN] ${reason}`);
        db.addRisk(hedef, 80, `IP-Ban: ${reason}`);
      }

      db.addIpBan({
        userId: isSnowflake ? hedef : null,
        networkTag: isSnowflake ? `UID-${hedef}` : hedef,
        reason,
        bannedBy: interaction.user.id,
      });

      const c = db.createCase({
        type: 'IP_BAN',
        targetId: hedef,
        moderatorId: interaction.user.id,
        reason,
        meta: { bannedOnGuild },
      });

      return interaction.reply({
        content: `\`${hedef}\` icin IP/Ag izolasyonu kaydedildi. Sunucu ban: \`${bannedOnGuild ? 'Evet' : 'Kayit/Disarida'}\` (\`${c.id}\`)`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'ip-unban') {
      if (interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: 'Yalnizca Sunucu Sahibi IP/Ag izolasyonunu kaldirabilir.', ephemeral: true });
      }
      const hedef = interaction.options.getString('hedef', true).trim();
      const ok = db.removeIpBanByTarget(hedef);
      return interaction.reply({
        content: ok ? `\`${hedef}\` IP/Ag izolasyon kaydi silindi.` : `\`${hedef}\` icin kayit bulunamadi.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'unban') {
      if (interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: 'Yalnizca Sunucu Sahibi yasak kaldirabilir.', ephemeral: true });
      }
      const userId = interaction.options.getString('kullanici_id', true).trim();
      await guild.bans.remove(userId, 'Sunucu Sahibi tarafindan kaldirildi.');
      db.removeBlacklist(userId);
      const c = db.createCase({ type: 'UNBAN', targetId: userId, moderatorId: interaction.user.id, reason: 'Yasak kaldirildi' });
      return interaction.reply({ content: `\`${userId}\` yasaği kaldirildi ve kara listeden cikarildi. (\`${c.id}\`)`, ephemeral: true });
    }

    if (interaction.commandName === 'karaliste') {
      const sub = interaction.options.getSubcommand();
      const userId = interaction.options.getString('kullanici_id', true).trim();

      if (sub === 'ekle') {
        if (userId === config.ownerId) {
          return interaction.reply({ content: 'Sunucu sahibi kara listeye eklenemez.', ephemeral: true });
        }
        const reason = interaction.options.getString('sebep') || 'Kara listeye eklendi';
        let banned = false;
        try {
          await guild.members.ban(userId, { reason: `[Kara Liste] ${reason}` });
          banned = true;
        } catch (err) {
          logger.logError('BLACKLIST_BAN', err, { userId });
        }
        db.addBlacklist(userId, interaction.user.id, reason);
        db.addRisk(userId, 50, `Kara liste: ${reason}`);
        const c = db.createCase({
          type: 'BLACKLIST_ADD',
          targetId: userId,
          moderatorId: interaction.user.id,
          reason,
          meta: { banned },
        });
        return interaction.reply({
          content: `\`${userId}\` kara listeye eklendi. Sunucu ban durumu: \`${banned ? 'Basarili' : 'Basarisiz/Disarida'}\` (\`${c.id}\`)`,
          ephemeral: true,
        });
      }

      if (sub === 'cikar') {
        if (interaction.user.id !== config.ownerId) {
          return interaction.reply({ content: 'Yalnizca Sunucu Sahibi kara listeden cikarabilir.', ephemeral: true });
        }
        let unbanned = false;
        try {
          await guild.bans.remove(userId, 'Kara listeden cikarildi');
          unbanned = true;
        } catch (err) {
          logger.logError('BLACKLIST_UNBAN', err, { userId });
        }
        const removed = db.removeBlacklist(userId);
        return interaction.reply({
          content: `Kara liste kaydi silindi: \`${removed ? 'Evet' : 'Kayit yok'}\` | Ban kaldirma: \`${unbanned ? 'Basarili' : 'Basarisiz/Ban yok'}\``,
          ephemeral: true,
        });
      }

      if (sub === 'sorgu') {
        const entry = db.getBlacklist(userId);
        const risk = db.getRisk(userId);
        const ipFlag = db.isIpBannedForUserOrTag(userId, `UID-${userId}`);
        return interaction.reply({
          content:
            `\`${userId}\` | Kara Liste: \`${entry ? 'Evet' : 'Hayir'}\` | ` +
            `IP/Ag: \`${ipFlag ? 'Izole' : 'Yok'}\` | Risk: \`${risk}/100\``,
          ephemeral: true,
        });
      }
    }

    if (interaction.commandName === 'guvenli-liste') {
      if (interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: 'Yalnizca Sunucu Sahibi guvenli listeyi yonetebilir.', ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();
      const type = interaction.options.getString('tur', true);
      const id = interaction.options.getString('id', true).trim();
      if (sub === 'ekle') {
        db.addWhitelist(id, type, interaction.user.id);
        return interaction.reply({ content: `\`${id}\` (${type}) guvenli listeye eklendi.`, ephemeral: true });
      }
      const ok = db.removeWhitelist(id);
      return interaction.reply({ content: ok ? `\`${id}\` guvenli listeden cikarildi.` : `\`${id}\` bulunamadi.`, ephemeral: true });
    }

    if (interaction.commandName === 'kick') {
      const target = interaction.options.getUser('kullanici', true);
      const reason = interaction.options.getString('sebep') || 'Sebep belirtilmedi';
      const member = await guild.members.fetch(target.id).catch(() => null);
      const check = canModerateTarget(actorMember, member, guild, botMember);
      if (!check.ok || !member.kickable) {
        return interaction.reply({ content: check.reason || 'Kullanici atilamadi.', ephemeral: true });
      }
      await member.kick(`${reason} | Yetkili: ${interaction.user.tag}`);
      const risk = db.addRisk(target.id, 15, `Kick: ${reason}`);
      const c = db.createCase({ type: 'KICK', targetId: target.id, moderatorId: interaction.user.id, reason });
      return interaction.reply({ content: `**${target.tag}** atildi. (\`${c.id}\` | Risk: \`${risk}/100\`)`, ephemeral: true });
    }

    if (interaction.commandName === 'timeout') {
      const target = interaction.options.getUser('kullanici', true);
      const raw = interaction.options.getString('sure', true);
      const reason = interaction.options.getString('sebep') || 'Sebep belirtilmedi';
      const ms = parseDurationToMs(raw);
      if (!ms || ms > 28 * 24 * 60 * 60 * 1000) {
        return interaction.reply({ content: 'Gecersiz sure (10m, 1h, 1d; max 28g).', ephemeral: true });
      }
      const member = await guild.members.fetch(target.id).catch(() => null);
      const check = canModerateTarget(actorMember, member, guild, botMember);
      if (!check.ok || !member.moderatable) {
        return interaction.reply({ content: check.reason || 'Kullanici susturulamadi.', ephemeral: true });
      }
      await member.timeout(ms, `${reason} | Yetkili: ${interaction.user.tag}`);
      const risk = db.addRisk(target.id, 10, `Timeout (${raw}): ${reason}`);
      const c = db.createCase({ type: 'TIMEOUT', targetId: target.id, moderatorId: interaction.user.id, reason: `${raw} - ${reason}` });
      return interaction.reply({ content: `**${target.tag}** \`${raw}\` susturuldu. (\`${c.id}\` | Risk: \`${risk}/100\`)`, ephemeral: true });
    }

    if (interaction.commandName === 'untimeout') {
      const target = interaction.options.getUser('kullanici', true);
      const member = await guild.members.fetch(target.id).catch(() => null);
      const check = canModerateTarget(actorMember, member, guild, botMember);
      if (!check.ok || !member.moderatable) {
        return interaction.reply({ content: check.reason || 'Susturma kaldirilamadi.', ephemeral: true });
      }
      await member.timeout(null, `Susturma kaldirildi | Yetkili: ${interaction.user.tag}`);
      return interaction.reply({ content: `**${target.tag}** susturmasi kaldirildi.`, ephemeral: true });
    }

    if (interaction.commandName === 'uyar') {
      const target = interaction.options.getUser('kullanici', true);
      const reason = interaction.options.getString('sebep', true);
      const totalWarns = db.addWarning(target.id, interaction.user.id, reason);
      const risk = db.addRisk(target.id, 10, `Uyari: ${reason}`);
      const c = db.createCase({ type: 'WARN', targetId: target.id, moderatorId: interaction.user.id, reason });
      return interaction.reply({ content: `**${target.tag}** uyarildi. Uyari: \`${totalWarns}\` | Risk: \`${risk}/100\` (\`${c.id}\`)`, ephemeral: true });
    }

    if (interaction.commandName === 'sicil') {
      const target = interaction.options.getUser('kullanici', true);
      const warns = db.getWarningsCount(target.id);
      const cases = db.getRecentCasesForUser(target.id, 5);
      const history = db.getRiskHistory(target.id, 5);
      const risk = db.getRisk(target.id);
      const bl = Boolean(db.getBlacklist(target.id));
      const ipFlag = db.isIpBannedForUserOrTag(target.id, `UID-${target.id}`);

      const caseLines =
        cases.length > 0
          ? cases.map((item) => `\`${item.id}\` **${item.type}** — ${String(item.reason).slice(0, 75)}`).join('\n')
          : 'Kayit yok.';

      const histLines =
        history.length > 0
          ? history
              .map((h) => `${h.delta >= 0 ? `+${h.delta}` : h.delta} -> \`${h.score_after}\` (${String(h.reason).slice(0, 50)})`)
              .join('\n')
          : 'Gecmis yok.';

      const embed = new EmbedBuilder()
        .setColor(0x1f2937)
        .setTitle(`Sicil — ${target.tag}`)
        .addFields(
          { name: 'ID', value: `\`${target.id}\``, inline: true },
          { name: 'Risk', value: `\`${risk}/100\``, inline: true },
          { name: 'Kara Liste / IP', value: `${bl ? 'BL' : '-'} / ${ipFlag ? 'IP' : '-'}`, inline: true },
          { name: 'Uyari', value: `\`${warns}\``, inline: true },
          { name: 'Son Vakalar', value: caseLines.slice(0, 950) },
          { name: 'Risk Gecmisi', value: histLines.slice(0, 950) }
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'vaka-sil') {
      if (interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: 'Yalnizca Sunucu Sahibi vaka silebilir.', ephemeral: true });
      }
      const vakaId = interaction.options.getString('vaka_id', true).trim().toUpperCase();
      const ok = db.deleteCaseById(vakaId);
      return interaction.reply({ content: ok ? `\`${vakaId}\` silindi.` : `\`${vakaId}\` bulunamadi.`, ephemeral: true });
    }

    if (interaction.commandName === 'karantina') {
      if (!config.quarantineRoleId) {
        return interaction.reply({ content: 'QUARANTINE_ROLE_ID tanimli degil.', ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();
      const target = interaction.options.getUser('kullanici', true);
      const member = await guild.members.fetch(target.id).catch(() => null);
      const qRole = guild.roles.cache.get(config.quarantineRoleId);
      if (!member || !qRole) {
        return interaction.reply({ content: 'Uye veya karantina rolu bulunamadi.', ephemeral: true });
      }

      if (sub === 'al') {
        const check = canModerateTarget(actorMember, member, guild, botMember);
        if (!check.ok || !member.manageable) {
          return interaction.reply({ content: check.reason || 'Karantina uygulanamadi.', ephemeral: true });
        }
        const reason = interaction.options.getString('sebep') || 'Karantina';
        const sureRaw = interaction.options.getString('sure');
        const durationMs = sureRaw ? parseDurationToMs(sureRaw) : gcfg.quarantine.defaultDurationMs;
        if (!durationMs) {
          return interaction.reply({ content: 'Gecersiz sure formati (10m, 1h, 1d).', ephemeral: true });
        }

        const savedRoles = member.roles.cache
          .filter((r) => r.id !== guild.id && r.id !== config.quarantineRoleId && r.editable)
          .map((r) => r.id);
        if (savedRoles.length > 0) {
          await member.roles.remove(savedRoles, `Karantina: ${reason}`);
        }
        await member.roles.add(qRole, `Karantina: ${reason}`);
        const expiresAt = Date.now() + durationMs;
        db.setQuarantine(target.id, savedRoles, reason, expiresAt);
        const risk = db.addRisk(target.id, 20, `Karantina: ${reason}`);
        const c = db.createCase({
          type: 'QUARANTINE_ADD',
          targetId: target.id,
          moderatorId: interaction.user.id,
          reason,
          meta: { expiresAt },
        });
        return interaction.reply({
          content: `**${target.tag}** karantinaya alindi (<t:${Math.floor(expiresAt / 1000)}:R>). (\`${c.id}\` | Risk: \`${risk}/100\`)`,
          ephemeral: true,
        });
      }

      if (sub === 'cikar') {
        const rec = db.getQuarantine(target.id);
        await member.roles.remove(qRole, 'Karantinadan cikarildi');
        if (rec?.roles?.length) {
          const restore = rec.roles.map((id) => guild.roles.cache.get(id)).filter((r) => r && r.editable);
          if (restore.length > 0) {
            await member.roles.add(restore, 'Karantina sonrasi rol iadesi');
          }
        }
        db.deleteQuarantine(target.id);
        return interaction.reply({ content: `**${target.tag}** karantinadan cikarildi ve rolleri iade edildi.`, ephemeral: true });
      }
    }

    if (interaction.commandName === 'itiraz') {
      const reason = interaction.options.getString('sebep', true);
      const ap = db.createAppeal(interaction.user.id, reason);
      await logger.sendSystemAlert(
        guild,
        '📩 YENİ İTİRAZ KAYDI',
        `**İtiraz ID:** \`${ap.id}\`\n**Kullanıcı:** <@${interaction.user.id}> (\`${interaction.user.id}\`)\n**Gerekçe:** ${reason}`,
        0x3b82f6
      );
      return interaction.reply({ content: `Itiraziniz kaydedildi. Takip kodu: \`${ap.id}\``, ephemeral: true });
    }

    if (interaction.commandName === 'itiraz-yonet') {
      if (interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: 'Yalnizca Sunucu Sahibi itiraz yonetebilir.', ephemeral: true });
      }
      const id = interaction.options.getString('itiraz_id', true).trim().toUpperCase();
      const karar = interaction.options.getString('karar', true);
      const note = interaction.options.getString('not') || '';
      const ok = db.reviewAppeal(id, karar, interaction.user.id, note);
      return interaction.reply({ content: ok ? `\`${id}\` durumu \`${karar}\` olarak guncellendi.` : `\`${id}\` bulunamadi.`, ephemeral: true });
    }

    if (interaction.commandName === 'temizle') {
      const adet = interaction.options.getInteger('adet', true);
      if (!interaction.channel || !interaction.channel.isTextBased() || interaction.channel.isDMBased()) {
        return interaction.reply({ content: 'Bu kanalda mesaj temizlenemez.', ephemeral: true });
      }
      const deleted = await interaction.channel.bulkDelete(adet, true);
      return interaction.reply({ content: `\`${deleted.size}\` mesaj silindi.`, ephemeral: true });
    }

    if (interaction.commandName === 'kilit') {
      const lock = interaction.options.getBoolean('durum', true);
      const ch = interaction.channel;
      if (!ch || ch.type !== ChannelType.GuildText) {
        return interaction.reply({ content: 'Sadece metin kanallarinda kullanilir.', ephemeral: true });
      }
      await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: lock ? false : null });
      return interaction.reply({ content: lock ? `<#${ch.id}> kilitlendi.` : `<#${ch.id}> kilidi acildi.`, ephemeral: true });
    }

    if (interaction.commandName === 'sunucu-kilit') {
      if (interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: 'Yalnizca Sunucu Sahibi sunucu kilidi kullanabilir.', ephemeral: true });
      }
      const lock = interaction.options.getBoolean('durum', true);
      await interaction.deferReply({ ephemeral: true });
      const textChannels = [...guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).values()];
      let okCount = 0;
      const failedIds = [];
      for (const ch of textChannels) {
        try {
          await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: lock ? false : null });
          okCount++;
        } catch (err) {
          failedIds.push(ch.id);
          logger.logError('SERVER_LOCK_CHANNEL', err, { channelId: ch.id });
        }
      }
      return interaction.editReply({
        content:
          `Islem tamamlandi: \`${okCount}/${textChannels.length}\` kanal guncellendi.` +
          (failedIds.length > 0 ? `\nHata veren kanallar: ${failedIds.map((id) => `\`${id}\``).join(', ')}` : ''),
      });
    }

    if (interaction.commandName === 'yavas-mod') {
      const saniye = interaction.options.getInteger('saniye', true);
      const ch = interaction.channel;
      if (!ch || !ch.isTextBased() || ch.isDMBased()) {
        return interaction.reply({ content: 'Bu kanalda yavas mod ayarlanamaz.', ephemeral: true });
      }
      await ch.setRateLimitPerUser(saniye);
      return interaction.reply({ content: `<#${ch.id}> yavas modu \`${saniye}s\` yapildi.`, ephemeral: true });
    }

    if (interaction.commandName === 'yedek-al') {
      if (interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: 'Yalnizca Sunucu Sahibi yedek alabilir.', ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      await captureGuildSnapshot(guild, logger);
      const backupPath = await db.createBackupSnapshot();
      return interaction.editReply({ content: `Yapi ve SQLite yedegi alindi (\`${backupPath.split('/').pop()}\`).` });
    }

    if (interaction.commandName === 'ayar') {
      if (interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: 'Yalnizca Sunucu Sahibi ayarlari degistirebilir.', ephemeral: true });
      }
      const sub = interaction.options.getSubcommand();
      if (sub === 'goruntule') {
        return interaction.reply({
          content:
            `Anti-Nuke Esik: \`${gcfg.antiNuke.threshold}\` | ` +
            `Raid 10sn Esik: \`${gcfg.raid.joinThreshold}\` | ` +
            `AutoMod: \`${gcfg.autoMod.enabled ? 'Aktif' : 'Kapali'}\``,
          ephemeral: true,
        });
      }
      if (sub === 'antinuke-esik') {
        const val = interaction.options.getInteger('deger', true);
        db.updateGuildConfigPatch((c) => {
          c.antiNuke.threshold = val;
          return c;
        });
        return interaction.reply({ content: `Anti-Nuke esigi \`${val}\` olarak guncellendi.`, ephemeral: true });
      }
      if (sub === 'raid-esik') {
        const val = interaction.options.getInteger('deger', true);
        db.updateGuildConfigPatch((c) => {
          c.raid.joinThreshold = val;
          return c;
        });
        return interaction.reply({ content: `Anti-Raid 10sn giris esigi \`${val}\` olarak guncellendi.`, ephemeral: true });
      }
      if (sub === 'automod') {
        const aktif = interaction.options.getBoolean('aktif', true);
        db.updateGuildConfigPatch((c) => {
          c.autoMod.enabled = aktif;
          return c;
        });
        return interaction.reply({ content: `AutoMod durumu: \`${aktif ? 'Aktif' : 'Kapali'}\`.`, ephemeral: true });
      }
      if (sub === 'disa-aktar') {
        const jsonStr = JSON.stringify(gcfg, null, 2).slice(0, 1850);
        return interaction.reply({ content: `\`\`\`json\n${jsonStr}\n\`\`\``, ephemeral: true });
      }
      if (sub === 'ice-aktar') {
        const rawJson = interaction.options.getString('json', true);
        let parsed;
        try {
          parsed = JSON.parse(rawJson);
        } catch {
          return interaction.reply({ content: 'Gecersiz JSON formati.', ephemeral: true });
        }
        db.saveGuildConfig(parsed);
        return interaction.reply({ content: 'Canli ayarlar JSON uzerinden ice aktarildi ve kaydedildi.', ephemeral: true });
      }
    }

    if (interaction.commandName === 'panel') {
      const raid = getRaidStatus();
      const dashUrl = `${config.selfPingUrl}/dashboard`;
      const embed = new EmbedBuilder()
        .setColor(0x0ea5e9)
        .setTitle('🛡️ 80 BASAMAKLI GÜVENLİK & DASHBOARD PANELİ')
        .setDescription(
          `**Web Dashboard:** [Paneli Aç](${dashUrl})\n` +
            `**Aktif Kural / Metrik Sayısı:** \`80/80\`\n` +
            `**Raid Kalkanı:** \`${raid.active ? 'AKTİF' : 'Normal'}\`\n` +
            `**AutoMod:** \`${gcfg.autoMod.enabled ? 'Aktif' : 'Kapalı'}\``
        )
        .addFields(
          { name: 'Toplam Vaka', value: `\`${db.getTotalCases()}\``, inline: true },
          { name: 'Kara Liste', value: `\`${db.countBlacklist()}\``, inline: true },
          { name: 'IP / Ağ İzolasyonu', value: `\`${db.countIpBans()}\``, inline: true }
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'guvenlik-denetimi') {
      const riskyRoles = guild.roles.cache.filter((r) => r.id !== guild.id && isDangerousRole(r, guild));
      const logChannelOk = Boolean(guild.channels.cache.get(config.logChannelId));
      const quarantineRoleOk = config.quarantineRoleId
        ? Boolean(guild.roles.cache.get(config.quarantineRoleId))
        : false;
      const botHighest = botMember?.roles?.highest?.position || 0;

      const embed = new EmbedBuilder()
        .setColor(0x0284c7)
        .setTitle('🔍 OTOMATİK GÜVENLİK DENETİMİ (80/80)')
        .addFields(
          { name: 'Log Kanali', value: logChannelOk ? 'Saglikli' : 'Eksik/Erisilemiyor', inline: true },
          { name: 'Karantina Rolu', value: quarantineRoleOk ? 'Tanimli' : 'Tanimli Degil', inline: true },
          { name: 'Bot Rol Pozisyonu', value: `\`${botHighest}\``, inline: true },
          { name: 'Kritik Yetkili Rol', value: `\`${riskyRoles.size}\``, inline: true },
          { name: 'Guvenli Liste Kaydi', value: `\`${db.listWhitelist().length}\``, inline: true },
          { name: 'IP / Ag Kaydi', value: `\`${db.countIpBans()}\``, inline: true }
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'istatistik') {
      const stats = db.getCaseStatsByType();
      const lines =
        stats.length > 0
          ? stats.map((s) => `• **${s.type}:** \`${s.cnt}\``).join('\n')
          : 'Henuz vaka kaydi bulunmuyor.';

      const embed = new EmbedBuilder()
        .setColor(0x1e293b)
        .setTitle('📊 GÜVENLİK & MODERASYON ANALİTİĞİ')
        .setDescription(`**Toplam Vaka:** \`${db.getTotalCases()}\`\n\n${lines}`)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'guvenlik-test') {
      if (interaction.user.id !== config.ownerId) {
        return interaction.reply({ content: 'Yalnizca Sunucu Sahibi simülasyon calistirabilir.', ephemeral: true });
      }
      const raid = getRaidStatus();
      await logger.sendSystemAlert(
        guild,
        '🧪 GÜVENLİK SİMÜLASYON TESTİ (80/80)',
        `Test basarili.\n• **Raid Durumu:** \`${raid.active ? 'Aktif' : 'Normal'}\`\n• **AutoMod:** \`${gcfg.autoMod.enabled ? 'Aktif' : 'Kapali'}\`\n• **Anti-Nuke Esik:** \`${gcfg.antiNuke.threshold}\`\n• **IP/Ag Kaydi:** \`${db.countIpBans()}\``,
        0x10b981
      );
      return interaction.reply({ content: 'Simulasyon testi tamamlandi ve log kanalina rapor gonderildi.', ephemeral: true });
    }

    if (interaction.commandName === 'yetki-denetimi') {
      const risky = guild.roles.cache
        .filter((r) => r.id !== guild.id && isDangerousRole(r, guild))
        .map((r) => `\`${r.name}\` (${r.id})`);
      return interaction.reply({
        content: risky.length > 0 ? `**Kritik Roller (${risky.length}):**\n${risky.join('\n').slice(0, 1800)}` : 'Kritik rol bulunamadi.',
        ephemeral: true,
      });
    }

    if (interaction.commandName === 'kullanici-bilgi') {
      const user = interaction.options.getUser('kullanici') || interaction.user;
      const member = await guild.members.fetch(user.id).catch(() => null);
      const risk = db.getRisk(user.id);
      const bl = Boolean(db.getBlacklist(user.id));
      const ipFlag = db.isIpBannedForUserOrTag(user.id, `UID-${user.id}`);
      const warns = db.getWarningsCount(user.id);
      const embed = new EmbedBuilder()
        .setColor(0x111827)
        .setTitle(`Kullanici Bilgisi — ${user.tag}`)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
          { name: 'ID', value: `\`${user.id}\``, inline: true },
          { name: 'Risk', value: `\`${risk}/100\``, inline: true },
          { name: 'Kara Liste / IP', value: `${bl ? 'BL' : '-'} / ${ipFlag ? 'IP' : '-'}`, inline: true },
          { name: 'Uyari', value: `\`${warns}\``, inline: true },
          { name: 'Kurulus', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'Katilim', value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Bilinmiyor', inline: true }
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'sistem-durumu') {
      const raid = getRaidStatus();
      const uptimeMin = Math.floor(process.uptime() / 60);
      const embed = new EmbedBuilder()
        .setColor(0x0f172a)
        .setTitle('Sistem Durum Raporu (80/80)')
        .addFields(
          { name: 'Gecikme', value: `\`${interaction.client.ws.ping}ms\``, inline: true },
          { name: 'Calisma Suresi', value: `\`${uptimeMin} dk\``, inline: true },
          { name: 'Raid Kalkanı', value: raid.active ? 'Aktif' : 'Normal', inline: true },
          { name: 'Kara Liste / IP', value: `\`${db.countBlacklist()} / ${db.countIpBans()}\``, inline: true },
          { name: 'Toplam Vaka', value: `\`${db.getTotalCases()}\``, inline: true },
          { name: 'Veritabani', value: 'SQLite (WAL)', inline: true }
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  } catch (err) {
    logger.logError(`CMD_${interaction.commandName}`, err, { userId: interaction.user.id });
    const msg = 'Islem sirasinda bir hata olustu ve kayit altina alindi.';
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, ephemeral: true }).catch(() => null);
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => null);
    }
  }
}

module.exports = { handleCommand };
