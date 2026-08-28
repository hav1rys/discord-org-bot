function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\n');
}

// Разбирает CSV в массив массивов строк. Понимает кавычки, экранированные
// кавычки ("") и переводы строк внутри кавычек (RFC 4180). Разделитель — запятая.
function parseCsv(text) {
  const s = String(text || '')
    .replace(/^﻿/, '') // BOM в начале файла
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const rows = [];
  let record = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n') {
      record.push(field);
      rows.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    rows.push(record);
  }
  return rows;
}

// Разбирает CSV в массив объектов по строке-заголовку. Пустые строки пропускает.
function parseCsvObjects(text) {
  const rows = parseCsv(text).filter((r) => !(r.length === 1 && r[0].trim() === ''));
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
    return obj;
  });
}

module.exports = { buildCsv, parseCsv, parseCsvObjects };
