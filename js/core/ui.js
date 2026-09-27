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
        if (a >= 1e5 || a < 1e-3) return x.toExponential(n - 1).replace('.', ',');
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
            ${opts.title ? `<figcaption>${esc(opts.title)}</figcaption>` : ''}
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || opts.yLabel)}">
              <rect class="frame" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}"/>
              ${g}
              <text class="axlabel" x="${(W + m.l) / 2}" y="${H - 8}" text-anchor="middle">${esc(opts.xLabel)}</text>
              <text class="axlabel" transform="translate(16 ${(H - m.b + m.t) / 2}) rotate(-90)" text-anchor="middle">${esc(opts.yLabel)}</text>
            </svg>
            ${legend ? `<div class="legend">${legend}</div>` : ''}
        </figure>`;
    }

    root.LabUI = { $, $$, esc, num, numList, fmt, sig, table, badge, toast, download, toCSV, slug, readFile, plot };
})(typeof self !== 'undefined' ? self : this);
