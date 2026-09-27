/*
 * LabUI — utilidades de interfaz: formato numérico, tablas, gráficos SVG, avisos, descargas.
 * Sin dependencias externas: funciona sin internet.
 */
(function (root) {
    'use strict';

    const $ = (sel, ctx = document) => ctx.querySelector(sel);
    const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Convierte texto a número aceptando coma decimal ("12,5") y signo menos tipográfico. */
    function num(v) {
        if (typeof v === 'number') return v;
        if (v == null) return NaN;
        const s = String(v).trim().replace(/−/g, '-').replace(',', '.');
        return s === '' ? NaN : Number(s);
    }

    /** Lista de números separados por punto y coma o espacios: "−150; −100; 50". */
    function numList(v) {
        return String(v ?? '').split(/[;\s]+/).map(num).filter(isFinite);
    }

    /** Formato con coma decimal (es-CL). d = decimales. */
    function fmt(x, d = 2) {
        if (x == null || !isFinite(x)) return '—';
        return Number(x).toLocaleString('es-CL', { minimumFractionDigits: d, maximumFractionDigits: d });
    }

    /** Formato con cifras significativas, útil para coeficientes de magnitud variable. */
    function sig(x, n = 4) {
        if (x == null || !isFinite(x)) return '—';
        if (x === 0) return '0';
        const a = Math.abs(x);
        if (a >= 1e5 || a < 1e-3) {
            const [m, e] = x.toExponential(n - 1).split('e');
            const sup = String(+e).replace(/[-0-9]/g, c => '⁻⁰¹²³⁴⁵⁶⁷⁸⁹'['-0123456789'.indexOf(c)]);
            return `${String(+m).replace('.', ',')}×10${sup}`;
        }
        const d = Math.max(0, n - 1 - Math.floor(Math.log10(a)));
        return fmt(x, d);
    }

    function table(headers, rows, opts = {}) {
        const cls = opts.className ? ` class="${opts.className}"` : '';
        return `<div class="table-wrap"><table${cls}><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }

    function badge(ok, yes = 'Cumple', no = 'No cumple') {
        return ok ? `<span class="badge ok">${yes}</span>` : `<span class="badge bad">${no}</span>`;
    }

    function toast(msg, kind = 'info') {
        let box = $('#toasts');
        if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
        const t = document.createElement('div');
        t.className = `toast ${kind}`;
        t.textContent = msg;
        box.appendChild(t);
        setTimeout(() => t.classList.add('out'), 3200);
        setTimeout(() => t.remove(), 3700);
    }

    function download(filename, text, mime = 'text/plain') {
        const blob = new Blob([text], { type: mime + ';charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** CSV para Excel en español: separador ';' y coma decimal. */
    function toCSV(headers, rows) {
        const cell = v => {
            if (typeof v === 'number') return isFinite(v) ? String(v).replace('.', ',') : '';
            const s = String(v ?? '');
            return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return '﻿' + [headers, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
    }

    function slug(s) {
        return String(s || 'experimento').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').slice(0, 60);
    }

    function readFile(file) {
        return new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = () => rej(r.error);
            r.readAsText(file);
        });
    }

    // ---------------- Gráficos SVG ----------------
    function niceStep(range, target = 6) {
        const raw = range / target;
        const mag = 10 ** Math.floor(Math.log10(raw));
        const n = raw / mag;
        return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
    }

    function extent(vals, padFrac = 0.06) {
        let lo = Math.min(...vals), hi = Math.max(...vals);
        if (!isFinite(lo)) { lo = 0; hi = 1; }
        if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1; }
        const p = (hi - lo) * padFrac;
        return [lo - p, hi + p];
    }

    /**
     * plot(el, { xLabel, yLabel, series: [{ label, points: [[x,y],…], kind: 'scatter'|'line', color: 1..6, err: [u,…] }],
     *            hlines: [{ y, label, dashed }], xlog })
     */
    function plot(el, opts) {
        const W = 640, H = 340, m = { l: 64, r: 16, t: 14, b: 48 };
        const series = opts.series.filter(s => s.points && s.points.length);
        const tx = v => opts.xlog ? Math.log10(v) : v;
        const ty = v => opts.ylog ? Math.log10(v) : v;
        const allX = series.flatMap(s => s.points.map(p => tx(p[0])));
        const allY = series.flatMap(s => s.points.flatMap((p, i) => s.err && !opts.ylog ? [p[1] - s.err[i], p[1] + s.err[i]] : [p[1]]))
            .concat((opts.hlines || []).map(h => h.y)).map(ty).filter(isFinite);
        let [x0, x1] = extent(allX), [y0, y1] = extent(allY, 0.1);
        if (opts.equal) {
            // misma escala en x e y (trayectorias, círculos): se amplía el eje más corto
            const pw = W - m.l - m.r, ph = H - m.t - m.b;
            const scale = Math.max((x1 - x0) / pw, (y1 - y0) / ph);
            const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
            x0 = cx - scale * pw / 2; x1 = cx + scale * pw / 2;
            y0 = cy - scale * ph / 2; y1 = cy + scale * ph / 2;
        }
        const X = v => m.l + (tx(v) - x0) / (x1 - x0) * (W - m.l - m.r);
        const Xr = v => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r);
        const Yr = v => H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
        const Y = v => Yr(ty(v));

        let g = '';
        const sx = niceStep(x1 - x0), sy = niceStep(y1 - y0);
        // decimales según el paso: evita marcas repetidas ("12,0 12,0 12,0") en rangos estrechos
        const tickLab = (v, step) => Math.abs(v) >= 1e5 ? sig(v, 3) : fmt(v, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
        for (let v = Math.ceil(x0 / sx) * sx; v <= x1; v += sx) {
            if (Math.abs(v) < sx * 1e-6) v = 0;
            const lab = opts.xlog ? sig(10 ** v, 2) : tickLab(v, sx);
            g += `<line class="grid" x1="${Xr(v)}" x2="${Xr(v)}" y1="${m.t}" y2="${H - m.b}"/><text class="tick" x="${Xr(v)}" y="${H - m.b + 16}" text-anchor="middle">${lab}</text>`;
        }
        for (let v = Math.ceil(y0 / sy) * sy; v <= y1; v += sy) {
            if (Math.abs(v) < sy * 1e-6) v = 0;
            g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Yr(v)}" y2="${Yr(v)}"/><text class="tick" x="${m.l - 6}" y="${Yr(v) + 4}" text-anchor="end">${opts.ylog ? sig(10 ** v, 2) : tickLab(v, sy)}</text>`;
        }
        if (!opts.ylog && y0 < 0 && y1 > 0) g += `<line class="axis0" x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;
        (opts.hlines || []).forEach(h => {
            g += `<line class="hline" x1="${m.l}" x2="${W - m.r}" y1="${Y(h.y)}" y2="${Y(h.y)}"/>`;
            if (h.label) g += `<text class="tick" x="${W - m.r - 4}" y="${Y(h.y) - 4}" text-anchor="end">${esc(h.label)}</text>`;
        });

        series.forEach((s, si) => {
            const c = `var(--c${s.color || si + 1})`;
            if (s.kind === 'line') {
                let pts = s.sort === false ? s.points : [...s.points].sort((a, b) => a[0] - b[0]);
                if (pts.length > 1500) { const st = Math.ceil(pts.length / 1500); pts = pts.filter((_, i) => i % st === 0); }
                g += `<polyline fill="none" style="stroke:${c}" stroke-width="${s.width || 2}" stroke-linejoin="round" points="${pts.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}"/>`;
            } else {
                const stp = s.points.length > 800 ? Math.ceil(s.points.length / 800) : 1;
                s.points.forEach((p, i) => {
                    if (i % stp) return;
                    if (s.err && isFinite(s.err[i])) g += `<line style="stroke:${c}" opacity=".5" x1="${X(p[0])}" x2="${X(p[0])}" y1="${Y(p[1] - s.err[i])}" y2="${Y(p[1] + s.err[i])}"/>`;
                    g += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="3.6" style="fill:${c}" fill-opacity=".85"><title>${sig(p[0], 5)} ; ${sig(p[1], 5)}</title></circle>`;
                });
            }
        });

        const legend = series.filter(s => s.label).map((s, i) =>
            `<span class="lg"><i style="background:var(--c${s.color || opts.series.indexOf(s) + 1})"></i>${esc(s.label)}</span>`).join('');
        el.innerHTML = `<figure class="plot">
            <figcaption><span>${esc(opts.title || '')}</span><span class="plot-tools no-print">
                <button type="button" data-exp="png" title="Imagen PNG de alta resolución (para documentos)">PNG</button>
                <button type="button" data-exp="svg" title="Imagen vectorial SVG (escala sin perder calidad)">SVG</button>
                <button type="button" data-exp="csv" title="Datos del gráfico en CSV">CSV</button></span></figcaption>
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || opts.yLabel)}">
              <rect class="frame" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>
              ${g}
              <text class="axlabel" x="${(W + m.l) / 2}" y="${H - 8}" text-anchor="middle">${esc(opts.xLabel)}</text>
              <text class="axlabel" transform="translate(16 ${(H - m.b + m.t) / 2}) rotate(-90)" text-anchor="middle">${esc(opts.yLabel)}</text>
            </svg>
            ${legend ? `<div class="legend">${legend}</div>` : ''}
        </figure>`;
        el._plot = opts;
        el.querySelectorAll('[data-exp]').forEach(b => b.addEventListener('click', () => exportPlot(el, b.dataset.exp)));
    }

    // ---------------- Exportación de gráficos (tesis, informes) ----------------
    const EXPORT_COLORS = { c1: '#1f6feb', c2: '#d4560f', c3: '#1a7f37', c4: '#8250df', c5: '#bf3989', c6: '#0a7d8c' };
    const FONT = 'Helvetica, Arial, sans-serif';

    /** SVG autónomo: fondo blanco, colores fijos de tema claro, título y leyenda dibujados dentro. */
    function standaloneSVG(el) {
        const svg = el.querySelector('svg');
        const opts = el._plot || {};
        const [, , W, H] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
        const series = (opts.series || []).filter(s => s.points && s.points.length && s.label);
        const top = opts.title ? 26 : 8;
        const perRow = 4, rows = Math.ceil(series.length / perRow), legendH = rows ? rows * 18 + 8 : 0;
        const inner = svg.innerHTML.replace(/var\(--(c[1-6])\)/g, (_, c) => EXPORT_COLORS[c]);
        const legend = series.map((s, i) => {
            const c = EXPORT_COLORS['c' + (s.color || opts.series.indexOf(s) + 1)] || '#333';
            const x = 70 + (i % perRow) * ((W - 80) / perRow), y = top + H + 14 + Math.floor(i / perRow) * 18;
            const mark = s.kind === 'line' ? `<line x1="${x}" x2="${x + 16}" y1="${y - 4}" y2="${y - 4}" stroke="${c}" stroke-width="2.5"/>` : `<circle cx="${x + 8}" cy="${y - 4}" r="4" fill="${c}"/>`;
            return `${mark}<text x="${x + 22}" y="${y}" class="lg">${esc(s.label)}</text>`;
        }).join('');
        return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${top + H + legendH}" width="${W * 1.5}" height="${(top + H + legendH) * 1.5}">
<style>
.frame{fill:none;stroke:#b8bfcc}.grid{stroke:#dfe3ea;stroke-width:.6}.axis0{stroke:#5d6778;stroke-width:1}
.hline{stroke:#cf222e;stroke-dasharray:5 4;stroke-width:1.2}.tick{fill:#3d4450;font-size:12px;font-family:${FONT}}
.axlabel{fill:#111;font-size:13px;font-weight:bold;font-family:${FONT}}.ttl{fill:#111;font-size:14px;font-weight:bold;font-family:${FONT}}
.lg{fill:#222;font-size:12px;font-family:${FONT}}
</style>
<rect width="100%" height="100%" fill="#fff"/>
${opts.title ? `<text x="${W / 2}" y="18" text-anchor="middle" class="ttl">${esc(opts.title)}</text>` : ''}
<g transform="translate(0 ${top})">${inner}</g>
${legend}
</svg>`;
    }

    function exportName(el, ext) {
        const opts = el._plot || {};
        return `${slug(`${document.title} - ${opts.title || 'grafico'}`)}.${ext}`;
    }

    function exportPlot(el, kind) {
        const opts = el._plot || {};
        if (kind === 'csv') {
            const rows = [];
            (opts.series || []).forEach(s => (s.points || []).forEach((p, i) => rows.push([s.label || '', +(+p[0]).toPrecision(10), +(+p[1]).toPrecision(10), s.err ? +(+s.err[i]).toPrecision(6) : ''])));
            download(exportName(el, 'csv'), toCSV(['Serie', opts.xLabel || 'x', opts.yLabel || 'y', 'Incertidumbre (barra)'], rows), 'text/csv');
            return;
        }
        const svgText = standaloneSVG(el);
        if (kind === 'svg') { download(exportName(el, 'svg'), svgText, 'image/svg+xml'); return; }
        // PNG ≈ 300 ppp a 21 cm de ancho
        const img = new Image();
        const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
        img.onload = () => {
            const vb = svgText.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
            const scale = 2560 / +vb[1];
            const c = document.createElement('canvas');
            c.width = Math.round(+vb[1] * scale); c.height = Math.round(+vb[2] * scale);
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
            ctx.drawImage(img, 0, 0, c.width, c.height);
            URL.revokeObjectURL(url);
            c.toBlob(b => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(b); a.download = exportName(el, 'png');
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }, 'image/png');
        };
        img.onerror = () => { URL.revokeObjectURL(url); toast('No se pudo generar el PNG; use SVG', 'error'); };
        img.src = url;
    }

    /** Tablas y tarjetas de un contenedor de resultados → CSV por secciones. */
    function resultsCSV(container) {
        const clean = t => t.replace(/\s+/g, ' ').trim();
        const out = [];
        const kpis = [...container.querySelectorAll('.kpi')];
        if (kpis.length) {
            out.push(['Indicadores'], ['Indicador', 'Valor', 'Detalle']);
            kpis.forEach(k => out.push([clean(k.querySelector('.l')?.textContent || ''), clean(k.querySelector('.v')?.textContent || ''), clean(k.querySelector('.s')?.textContent || '')]));
            out.push([]);
        }
        container.querySelectorAll('table').forEach(t => {
            if (t.closest('details:not([open])') && t.closest('details').textContent.includes('Datos crudos')) return;
            const card = t.closest('.card');
            const h = card && card.querySelector('h3, h4');
            out.push([h ? clean(h.textContent) : 'Tabla']);
            t.querySelectorAll('tr').forEach(tr => {
                const cells = [...tr.children].map(c => clean(c.textContent));
                if (cells.some(Boolean)) out.push(cells);
            });
            out.push([]);
        });
        return '\ufeff' + out.map(r => r.map(v => /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(';')).join('\r\n');
    }

    root.LabUI = { $, $$, esc, num, numList, fmt, sig, table, badge, toast, download, toCSV, slug, readFile, plot, exportPlot, standaloneSVG, resultsCSV };
})(typeof self !== 'undefined' ? self : this);
