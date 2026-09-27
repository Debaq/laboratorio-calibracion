/*
 * LabCSV — lectura tolerante de tablas numéricas (monitor serie, Excel, instrumentos).
 * Detecta separador (, ; tab), coma decimal, encabezado y líneas basura.
 */
(function (root, factory) {
    const m = factory();
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.LabCSV = m;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\[.*?\]|\(.*?\)/g, '').replace(/[\s"']/g, '');

    function parseTable(text) {
        const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (!lines.length) throw new Error('No hay datos.');
        const delimOf = l => l.includes('\t') ? '\t' : l.includes(';') ? ';' : ',';
        const isNumRow = (l, d) => l.split(d).every(c => c.trim() !== '' && isFinite(Number(d === ',' ? c : c.replace(',', '.'))));
        const first = lines.findIndex(l => isNumRow(l, delimOf(l)));
        if (first < 0) throw new Error('No se encontraron filas numéricas.');
        const delim = delimOf(lines[first]);
        const width = lines[first].split(delim).length;
        let headers = null;
        for (let i = first - 1; i >= 0; i--) {
            const h = lines[i].split(delimOf(lines[i]));
            if (h.length === width) { headers = h.map(x => x.trim()); break; }
        }
        if (!headers) headers = Array.from({ length: width }, (_, i) => `col${i + 1}`);
        const cols = headers.map(() => []);
        let skipped = 0;
        for (let i = first; i < lines.length; i++) {
            const f = lines[i].split(delim);
            if (f.length !== width) { skipped++; continue; }
            const v = f.map(c => Number(delim === ',' ? c : c.replace(',', '.')));
            if (v.some(x => !isFinite(x))) { skipped++; continue; }
            v.forEach((x, j) => cols[j].push(x));
        }
        return { headers, keys: headers.map(norm), cols, n: cols[0].length, skipped };
    }

    /** Índice de la primera columna cuyo nombre normalizado calza con alguna expresión. */
    function findCol(table, ...patterns) {
        return table.keys.findIndex(k => patterns.some(p => p.test(k)));
    }

    /** Columna de tiempo en segundos (acepta t_ms/millis, t_us/micros, t/tiempo en s). null si no hay. */
    function timeColumn(table) {
        let i = findCol(table, /^(t_?ms|millis|ms|tiempo_?ms|time_?ms)$/);
        if (i >= 0) return { index: i, t: table.cols[i].map(v => (v - table.cols[i][0]) / 1000) };
        i = findCol(table, /^(t_?us|micros|us)$/);
        if (i >= 0) return { index: i, t: table.cols[i].map(v => (v - table.cols[i][0]) / 1e6) };
        i = findCol(table, /^(t|t_?s|tiempo|time|seg|s)$/);
        if (i >= 0) return { index: i, t: table.cols[i].map(v => v - table.cols[i][0]) };
        return null;
    }

    return { parseTable, findCol, timeColumn, norm };
});
