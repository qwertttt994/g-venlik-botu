const { EmbedBuilder } = require('discord.js');
const config = require('../config/config');

function formatError(err) {
  if (!err) return 'Bilinmeyen hata';
  const code = err.code ? `[Code: ${err.code}] ` : '';
  return `${code}${err.message || String(err)}`.slice(0, 900);
}

function createLogger(client) {
  function logError(context, err, meta = {}) {
    console.error(`[ERROR][${context}]`, formatError(err), meta);
  }

  function logInfo(context, message) {
    console.log(`[INFO][${context}] ${message}`);
  }

  async function sendEmbed(guild, embed) {
    if (!guild || !config.logChannelId) return false;
    try {
      const channel =
        guild.channels.cache.get(config.logChannelId) ||
        (await guild.channels.fetch(config.logChannelId));
      if (!channel || !channel.isTextBased()) {
        logError('LOGGER', new Error('Log kanali metin kanali degil veya bulunamadi'), {
          channelId: config.logChannelId,
        });
        return false;
      }
      await channel.send({ embeds: [embed] });
      return true;
    } catch (err) {
      logError('LOGGER_SEND', err);
      return false;
    }
  }

  async function sendSystemAlert(guild, title, description, color = 0xdc2626) {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(String(description).slice(0, 3900))
      .setTimestamp();
    return sendEmbed(guild, embed);
  }

  return { logError, logInfo, sendEmbed, sendSystemAlert, formatError };
}

module.exports = { createLogger, formatError };
