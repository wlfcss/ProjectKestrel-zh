(function(global) {
  'use strict';

  function shouldSkipRow(row, skipEmptyLines) {
    if (!skipEmptyLines) return false;
    return row.every((cell) => String(cell ?? '').trim() === '');
  }

  function parseRows(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1];

      if (inQuotes) {
        if (ch === '"') {
          if (next === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        continue;
      }

      if (ch === delimiter) {
        row.push(field);
        field = '';
        continue;
      }

      if (ch === '\r') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        if (next === '\n') i++;
        continue;
      }

      if (ch === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        continue;
      }

      field += ch;
    }

    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    return rows;
  }

  function normalizeRows(rows, skipEmptyLines) {
    return rows.filter((row) => !shouldSkipRow(row, skipEmptyLines));
  }

  function rowsToObjects(fields, rows) {
    return rows.map((row) => {
      const obj = {};
      for (let i = 0; i < fields.length; i++) obj[fields[i]] = row[i] ?? '';
      return obj;
    });
  }

  const Papa = {
    parse(input, config = {}) {
      const text = typeof input === 'string' ? input : String(input ?? '');
      const delimiter = config.delimiter || ',';
      const linebreak = text.includes('\r\n') ? '\r\n' : '\n';
      const rawRows = normalizeRows(parseRows(text, delimiter), config.skipEmptyLines);

      if (config.header) {
        const fields = rawRows.shift() || [];
        return {
          data: rowsToObjects(fields, rawRows),
          errors: [],
          meta: { delimiter, linebreak, fields },
        };
      }

      return {
        data: rawRows,
        errors: [],
        meta: { delimiter, linebreak },
      };
    },
  };

  global.Papa = Papa;
})(typeof window !== 'undefined' ? window : globalThis);
