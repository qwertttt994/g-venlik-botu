const { EmbedBuilder } = require('discord.js');
const { getGuildConfig, addRisk, getRisk, createCase } = require('../database/database');
const { isWhitelisted } = require('../services/permissions');

const PHISHING_PATTERNS = [
  /free[\s-]?nitro/i,
  /discord[\s-]?gift/i,
  /steam[\s-]?gift/i,
  /airdrop[\s-]?claim/i,
  /dliscord\.com/i,
  /discorcl\.com/i,
  /discord-nitro\.gift/i,
  /steamcommunity\.ru/i,
  /xn--/i,
];

const PROFANITY_PATTERNS = [
  /\b(amk|aq|orospu|pi[cç]|sikerim|siktir|kahpe|ibne|g[oö]t)\b/i,
];

const SPAM_TRACKER = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [userId, items] of SPAM_TRACKER.entries()) {
    const fresh = items.filter((i) => now - i.ts < 15000);
    if (fresh.length === 0) {
      SPAM_TRACKER.delete(userId);
    } else {
      SPAM_TRACKER.set(userId, fresh);
    }
  }
}, 60 * 1000);

function countEmojis(text) {
  const custom = (text.match(/<a?:[a-zA-Z0-9_]+:\d+>/g) || []).length;
  const unicode = (
    text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []
  ).length;
  return custom + unicode;
}

function isExempt(message, gcfg) {
  if (gcfg.autoMod.exemptChannelIds.includes(message.channel.id)) return true;
  if (message.member?.roles?.cache?.some((r) => gcfg.autoMod.exemptRoleIds.includes(r.id))) {
    return true;
  }
  return false;
}

function detectThreat(message, gcfg) {
  const content = message.content || '';
  const lower = content.toLowerCase();

  if (gcfg.autoMod.blockPhishing) {
    for (const rx of PHISHING_PATTERNS) {
      if (rx.test(lower)) {
        return { reason: 'Zararli / sahte baglanti veya punycode', risk: 25, baseTimeoutMs: 15 * 60 * 1000 };
      }
    }
  }

  if (gcfg.autoMod.blockProfanity) {
    for (const rx of PROFANITY_PATTERNS) {
      if (rx.test(lower)) {
        return { reason: 'Kufur / hakaret icerigi', risk: 10, baseTimeoutMs: 5 * 60 * 1000 };
      }
    }
  }

  if (gcfg.autoMod.blockInvites && /(discord\.gg\/|discordapp\.com\/invite\/|discord\.com\/invite\/)/i.test(content)) {
    return { reason: 'Izinsiz Discord davet baglantisi', risk: 15, baseTimeoutMs: 10 * 60 * 1000 };
  }

  if (
    gcfg.autoMod.blockShortLinks &&
    /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|rb\.gy|cutt\.ly|is\.gd|ow\.ly)\//i.test(content)
  ) {
    return { reason: 'Kisaltilmis harici baglanti', risk: 15, baseTimeoutMs: 10 * 60 * 1000 };
  }

  if (message.mentions.users.size >= gcfg.autoMod.maxMentions) {
    return { reason: 'Toplu kullanici etiketleme (Mass Mention)', risk: 15, baseTimeoutMs: 10 * 60 * 1000 };
  }

  const emojiCount = countEmojis(content) + (message.stickers?.size || 0) * 3;
  if (emojiCount > gcfg.autoMod.maxEmojis) {
    return { reason: `Asiri emoji/sticker kullanimi (${emojiCount})`, risk: 8, baseTimeoutMs: null };
  }

  const letters = content.replace(/[^a-zA-ZçğıöşüÇĞİÖŞÜ]/g, '');
  if (letters.length >= gcfg.autoMod.capsMinLetters) {
    const upperCount = letters.replace(/[^A-ZÇĞİÖŞÜ]/g, '').length;
    if (upperCount / letters.length >= gcfg.autoMod.capsRatioThreshold) {
      return { reason: 'Asiri buyuk harf (Caps Lock)', risk: 5, baseTimeoutMs: null };
    }
  }

  const now = Date.now();
  const recent = (SPAM_TRACKER.get(message.author.id) || []).filter(
    (item) => now - item.ts < gcfg.autoMod.floodWindowMs
  );
  recent.push({ ts: now, text: lower.trim() });
  SPAM_TRACKER.set(message.author.id, recent);

  const dupes = recent.filter((item) => item.text && item.text === lower.trim()).length;
  if (recent.length >= gcfg.autoMod.floodMaxMessages || dupes >= gcfg.autoMod.floodMaxDuplicates) {
    SPAM_TRACKER.delete(message.author.id);
    return { reason: 'Mesaj flood / tekrarlayan icerik', risk: 15, baseTimeoutMs: 10 * 60 * 1000 };
  }

  return null;
}

async function handleAutoMod(message, logger) {
  if (!message.guild || message.author.bot) return;
  if (isWhitelisted(message.member, message.guild)) return;

  const gcfg = getGuildConfig();
  if (!gcfg.autoMod.enabled || isExempt(message, gcfg)) return;

  const threat = detectThreat(message, gcfg);
  if (!threat) return;

  let deleted = false;
  try {
    await message.delete();
    deleted = true;
  } catch (err) {
    logger.logError('AUTOMOD_DELETE', err, { messageId: message.id });
  }

  const currentRisk = getRisk(message.author.id);
  const multiplier = currentRisk >= 60 ? 2 : currentRisk >= 30 ? 1.5 : 1;
  const finalTimeoutMs = threat.baseTimeoutMs ? Math.round(threat.baseTimeoutMs * multiplier) : null;

  let timedOut = false;
  if (finalTimeoutMs && message.member?.moderatable) {
    try {
      await message.member.timeout(finalTimeoutMs, `AutoMod: ${threat.reason}`);
      timedOut = true;
    } catch (err) {
      logger.logError('AUTOMOD_TIMEOUT', err, { userId: message.author.id });
    }
  }

  const risk = addRisk(message.author.id, threat.risk, `AutoMod: ${threat.reason}`);
  const caseEntry = createCase({
    type: 'AUTOMOD',
    targetId: message.author.id,
    moderatorId: message.client.user.id,
    reason: threat.reason,
    meta: { deleted, timedOut, finalTimeoutMs, channelId: message.channel.id },
  });

  const embed = new EmbedBuilder()
    .setColor(0xeab308)
    .setTitle('🛡️ AUTOMOD 2.0 MÜDAHALESİ')
    .setDescription(
      `**Kullanıcı:** <@${message.author.id}> (\`${message.author.id}\`)\n` +
        `**Vaka:** \`${caseEntry.id}\`\n` +
        `**Kanal:** <#${message.channel.id}>\n` +
        `**Neden:** ${threat.reason}\n` +
        `**Yaptırım:** Silindi: \`${deleted ? 'Evet' : 'Hayır'}\` | Susturma: \`${timedOut ? `${Math.round(finalTimeoutMs / 60000)}dk` : 'Hayır'}\`\n` +
        `**Risk Puanı:** \`${risk}/100\``
    )
    .setTimestamp();

  await logger.sendEmbed(message.guild, embed);
}

module.exports = { handleAutoMod };
