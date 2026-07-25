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

// Строка упоминаний ролей руководства для новых заявок
function mentionManagementRoles() {
  return config.ROLES_MEMBERS_LIST_ALLOWED.map((r) => `<@&${r}>`).join(' ');
}

module.exports = {
  hasBotAccess,
  canManageMembersList,
  canManageBlacklist,
  mentionManagementRoles,
  isProtectedTarget,
  getRankIndex,
  getActorRankIndex,
  canActOnRank,
};