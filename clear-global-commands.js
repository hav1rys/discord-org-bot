// Разовый скрипт: удаляет ГЛОБАЛЬНЫЕ слэш-команды бота (не трогает
// команды, зарегистрированные на конкретный сервер через GUILD_ID).
// Запустить один раз: node clear-global-commands.js
require('dotenv').config();
const { REST, Routes } = require('discord.js');

const rest = new REST({ version: '10' }).setToken(process.env.API_TOKEN || process.env.DISCORD_TOKEN);

(async () => {
  if (!process.env.CLIENT_ID) {
    console.error('CLIENT_ID не задан в .env');
    return;
  }
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
  console.log('Глобальные команды очищены. Перезапустите обычного бота (node index.js) — останутся только серверные.');
})();
