const { EmbedBuilder } = require('discord.js');
const { addRisk, createCase } = require('../database/database');
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
    const fresh = items.filter((i) => now - i.ts < 10000);
    if (fresh.length === 0) {
      SPAM_TRACKER.delete(userId);
    } else {
      SPAM_TRACKER.set(userId, fresh);
    }
  }
}, 60 * 1000);

function detectThreat(message) {
  const content = message.content || '';
  const lower = content.toLowerCase();

  for (const rx of PHISHING_PATTERNS) {
    if (rx.test(lower)) {
      return { reason: 'Zararli / sahte baglanti veya punycode', risk: 25, timeoutMs: 15 * 60 * 1000 };
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
  const recent = (SPAM_TRACKER.get(message.author.id) || []).filter((item) => now - item.ts < 7000);
  recent.push({ ts: now, text: lower.trim() });
  SPAM_TRACKER.set(message.author.id, recent);

  const dupes = recent.filter((item) => item.text && item.text === lower.trim()).length;
  if (recent.length >= 6 || dupes >= 3) {
    SPAM_TRACKER.delete(message.author.id);
    return { reason: 'Mesaj flood / tekrarlayan icerik', risk: 15, timeoutMs: 10 * 60 * 1000 };
  }

  return null;
}

async function handleAutoMod(message, logger) {
  if (!message.guild || message.author.bot) return;
  if (isWhitelisted(message.member, message.guild)) return;

  const threat = detectThreat(message);
  if (!threat) return;

  let deleted = false;
  try {
    await message.delete();
    deleted = true;
  } catch (err) {
    logger.logError('AUTOMOD_DELETE', err, { messageId: message.id });
  }

  let timedOut = false;
  if (threat.timeoutMs && message.member?.moderatable) {
    try {
      await message.member.timeout(threat.timeoutMs, `AutoMod: ${threat.reason}`);
      timedOut = true;
    } catch (err) {
      logger.logError('AUTOMOD_TIMEOUT', err, { userId: message.author.id });
    }
  }

  const risk = addRisk(message.author.id, threat.risk);
  const caseEntry = createCase({
    type: 'AUTOMOD',
    targetId: message.author.id,
    moderatorId: message.client.user.id,
    reason: threat.reason,
    meta: { deleted, timedOut, channelId: message.channel.id },
  });

  const embed = new EmbedBuilder()
    .setColor(0xeab308)
    .setTitle('🛡️ AUTOMOD MÜDAHALESİ')
    .setDescription(
      `**Kullanıcı:** <@${message.author.id}> (\`${message.author.id}\`)\n` +
        `**Vaka:** \`${caseEntry.id}\`\n` +
        `**Kanal:** <#${message.channel.id}>\n` +
        `**Neden:** ${threat.reason}\n` +
        `**Yaptırım:** Silindi: \`${deleted ? 'Evet' : 'Hayır'}\` | Susturma: \`${timedOut ? 'Evet' : 'Hayır'}\`\n` +
        `**Risk Puanı:** \`${risk}/100\``
    )
    .setTimestamp();

  await logger.sendEmbed(message.guild, embed);
}

module.exports = { handleAutoMod };
