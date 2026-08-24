const config = require('./config');

// Может ли участник вообще пользоваться командами/кнопками бота
function hasBotAccess(member) {
  if (!member) return false;
  if (member.id === config.OWNER_USER_ID) return true;
  return member.roles.cache.has(config.ROLE_PLUS) || member.roles.cache.has(config.ROLE_ADMIN);
}

// Может ли участник взаимодействовать со списком участников
// (Добавить/Уволить/Изменить/Повысить/Понизить/Найти)
function canManageMembersList(member) {
  if (!member) return false;
  if (member.id === config.OWNER_USER_ID) return true;
  if (member.roles.cache.has(config.ROLE_ADMIN)) return true;
  return config.ROLES_MEMBERS_LIST_ALLOWED.some((roleId) => member.roles.cache.has(roleId));
}

// Владелец (OWNER_USER_ID) неприкосновенен для действий ДРУГИХ людей —
// но сам может свободно управлять собственной записью.
function isProtectedTarget(targetDiscordId, actorId) {
  if (targetDiscordId !== config.OWNER_USER_ID) return false;
  return actorId !== config.OWNER_USER_ID;
}

// Индекс роли в иерархии ROLE_IDS (0 = самый высокий ранг). -1, если роли нет в иерархии.
function getRankIndex(roleId) {
  return config.ROLE_IDS.indexOf(roleId);
}

// Индекс самого высокого ранга среди ролей участника на сервере (0 = высший).
// Infinity, если ни одной ранговой роли нет.
function getActorRankIndex(member) {
  let best = Infinity;
  for (const roleId of config.ROLE_IDS) {
    if (member.roles.cache.has(roleId)) {
      const idx = config.ROLE_IDS.indexOf(roleId);
      if (idx < best) best = idx;
    }
  }
  return best;
}

// Может ли actor управлять/менять роль участнику с рангом targetRoleId
// (нельзя действовать на свой ранг и выше — только строго ниже).
function canActOnRank(actorMember, targetRoleId) {
  if (actorMember.id === config.OWNER_USER_ID) return true;
  if (actorMember.roles.cache.has(config.ROLE_ADMIN)) return true;

  const actorIndex = getActorRankIndex(actorMember);
  if (actorIndex === Infinity) return false;

  const targetIndex = getRankIndex(targetRoleId);
  if (targetIndex === -1) return true; // цель не входит в иерархию — не блокируем

  return targetIndex > actorIndex;
}

// Может ли участник управлять чёрным списком (внести/убрать)
function canManageBlacklist(member) {
  if (!member) return false;
  if (member.id === config.OWNER_USER_ID) return true;
  if (member.roles.cache.has(config.ROLE_ADMIN)) return true;
  return config.ROLES_BLACKLIST_ALLOWED.some((roleId) => member.roles.cache.has(roleId));
}

// Может ли участник рассматривать заявки/проверять контракты (шире, чем
// управление списком участников — сюда входит и HR-Менеджер)
function canReview(member) {
  if (!member) return false;
  if (member.id === config.OWNER_USER_ID) return true;
  if (member.roles.cache.has(config.ROLE_ADMIN)) return true;
  return config.ROLES_REVIEW_ALLOWED.some((roleId) => member.roles.cache.has(roleId));
}

// Строка упоминаний ролей руководства для новых заявок (включая HR),
// от старшей роли к младшей: Владелец → Зам. Владелец → HR-Менеджер.
function mentionManagementRoles() {
  const ordered = [...config.ROLES_REVIEW_ALLOWED].sort((a, b) => {
    const ia = config.ROLE_IDS.indexOf(a);
    const ib = config.ROLE_IDS.indexOf(b);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });
  return ordered.map((r) => `<@&${r}>`).join(' ');
}

// Управлять гайдами FAQ может только владелец бота или роль Владельца
function canManageFaq(member) {
  if (!member) return false;
  if (member.id === config.OWNER_USER_ID) return true;
  if (member.roles.cache.has(config.ROLE_ADMIN)) return true;
  return member.roles.cache.has(config.ROLE_OWNER);
}

// Владелец и выше (роли +/./Владелец, либо личный аккаунт владельца бота)
function isOwnerTier(member) {
  if (hasBotAccess(member)) return true;
  return member.roles.cache.has(config.ROLE_OWNER);
}

// Зам. Владелец и выше
function isDeputyTier(member) {
  if (hasBotAccess(member)) return true;
  if (member.roles.cache.has(config.ROLE_OWNER)) return true;
  return member.roles.cache.has(config.ROLE_DEPUTY);
}

// HR-Менеджер и выше
function isHrTier(member) {
  if (hasBotAccess(member)) return true;
  if (member.roles.cache.has(config.ROLE_OWNER)) return true;
  if (member.roles.cache.has(config.ROLE_DEPUTY)) return true;
  return member.roles.cache.has(config.ROLE_HR);
}

module.exports = {
  hasBotAccess,
  isOwnerTier,
  isDeputyTier,
  isHrTier,
  canManageMembersList,
  canManageBlacklist,
  canReview,
  canManageFaq,
  mentionManagementRoles,
  isProtectedTarget,
  getRankIndex,
  getActorRankIndex,
  canActOnRank,
};
