const db = require('./db');
const contentVersions = require('./content_versions');

async function listEntries(category) {
  return db.all('SELECT * FROM faq_entries WHERE category = ? ORDER BY position ASC', [category]);
}

async function getEntry(id) {
  return db.get('SELECT * FROM faq_entries WHERE id = ?', [id]);
}

function versionKey(category, id) {
  return `faq_${category}_${id}`;
}

async function addEntry(category, title, content, userId) {
  const countRow = await db.get('SELECT COUNT(*) as cnt FROM faq_entries WHERE category = ?', [category]);
  const position = countRow ? countRow.cnt : 0;
  const now = new Date().toISOString();
  const result = await db.run(
    'INSERT INTO faq_entries (category, title, content, position, updated_by, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [category, title, content, position, userId, now, now],
  );
  await contentVersions.saveVersion(versionKey(category, result.lastID), `# ${title}\n\n${content}`, userId);
  return result.lastID;
}

async function updateEntry(id, title, content, userId) {
  const entry = await getEntry(id);
  if (!entry) throw new Error('Гайд не найден.');
  await db.run(
    'UPDATE faq_entries SET title = ?, content = ?, updated_by = ?, updated_at = ? WHERE id = ?',
    [title, content, userId, new Date().toISOString(), id],
  );
  await contentVersions.saveVersion(versionKey(entry.category, id), `# ${title}\n\n${content}`, userId);
}

async function deleteEntry(id) {
  const entry = await getEntry(id);
  if (!entry) return;
  await db.run('DELETE FROM faq_entries WHERE id = ?', [id]);
  // Пересчитываем позиции, чтобы не было дыр
  const remaining = await db.all('SELECT id FROM faq_entries WHERE category = ? ORDER BY position ASC', [entry.category]);
  for (let i = 0; i < remaining.length; i++) {
    await db.run('UPDATE faq_entries SET position = ? WHERE id = ?', [i, remaining[i].id]);
  }
}

// Двигает гайд на одну позицию вверх ('up') или вниз ('down') в пределах
// своей категории. Позиции при этом нормализуются в 0..n-1. Возвращает
// категорию перемещённого гайда (или null, если гайд не найден).
async function moveEntry(id, direction) {
  const entry = await getEntry(id);
  if (!entry) return null;
  const siblings = await db.all('SELECT id FROM faq_entries WHERE category = ? ORDER BY position ASC, id ASC', [entry.category]);
  for (let i = 0; i < siblings.length; i++) {
    await db.run('UPDATE faq_entries SET position = ? WHERE id = ?', [i, siblings[i].id]);
  }
  const idx = siblings.findIndex((s) => String(s.id) === String(id));
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (idx === -1 || target < 0 || target >= siblings.length) return entry.category;
  await db.run('UPDATE faq_entries SET position = ? WHERE id = ?', [target, id]);
  await db.run('UPDATE faq_entries SET position = ? WHERE id = ?', [idx, siblings[target].id]);
  return entry.category;
}

module.exports = { listEntries, getEntry, addEntry, updateEntry, deleteEntry, moveEntry, versionKey };
