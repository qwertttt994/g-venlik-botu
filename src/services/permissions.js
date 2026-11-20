const config = require('../config/config');
const { isWhitelistedId } = require('../database/database');

function isProtectedRole(role, guild) {
  if (!role || !guild) return true;
  if (role.id === guild.id) return true;
  if (config.verifiedRoleId && role.id === config.verifiedRoleId) return true;
  if (config.quarantineRoleId && role.id === config.quarantineRoleId) return true;
  if (role.name && role.name.trim().toLowerCase() === 'verified') return true;
  return false;
}

function isDangerousRole(role, guild) {
  if (!role || isProtectedRole(role, guild) || !role.editable) return false;
  return config.dangerousPermissions.some((perm) => role.permissions.has(perm));
}

function isWhitelisted(memberOrId, guild) {
  const userId = typeof memberOrId === 'string' ? memberOrId : memberOrId?.id;
  if (!userId) return false;
  if (userId === config.ownerId || isWhitelistedId(userId)) return true;

  const member =
    typeof memberOrId === 'object' && memberOrId?.roles?.cache
      ? memberOrId
      : guild?.members?.cache?.get(userId);

  if (member?.roles?.cache?.some((r) => isWhitelistedId(r.id))) {
    return true;
  }
  return false;
}

function canModerateTarget(actorMember, targetMember, guild, botMember) {
  if (!targetMember) return { ok: false, reason: 'Hedef uye sunucuda bulunamadi.' };
  if (targetMember.id === config.ownerId) {
    return { ok: false, reason: 'Sunucu sahibine islem yapilamaz.' };
  }
  if (actorMember && targetMember.id === actorMember.id) {
    return { ok: false, reason: 'Kendinize islem yapamazsiniz.' };
  }
  if (actorMember && actorMember.id !== config.ownerId && guild.ownerId !== actorMember.id) {
    if (targetMember.roles.highest.position >= actorMember.roles.highest.position) {
      return {
        ok: false,
        reason: 'Sizinle ayni veya sizden yuksek yetkili bir uyeye islem yapamazsiniz.',
      };
    }
  }
  if (botMember && targetMember.roles.highest.position >= botMember.roles.highest.position) {
    return {
      ok: false,
      reason: 'Botun rol hiyerarsisi bu uyeye islem yapmak icin yetersiz.',
    };
  }
  return { ok: true };
}

module.exports = {
  isProtectedRole,
  isDangerousRole,
  isWhitelisted,
  canModerateTarget,
};
