/* Interfaz del módulo Posturógrafo de balanza */
(function () {
    'use strict';
    const M = window.BalanzaModel;
    const { $, $$, esc, num, fmt, sig, table, plot } = window.LabUI;

    const app = window.LabApp.create({
        id: 'balanza',
        model: M,
        stepFields: [
            { key: 'cycle', label: 'Ciclo', decimals: 0 },
            { key: 'dir', label: 'Tipo', type: 'select', options: [['tara', 'Tara'], ['carga', '↑ Carga'], ['descarga', '↓ Descarga']] },
            { key: 'mass_kg', label: 'Masa', unit: 'kg', decimals: 3 },
            { key: 'x', label: 'x', unit: 'mm', decimals: 0 },
            { key: 'y', label: 'y', unit: 'mm', decimals: 0 }
        ],
        measureFields: [1, 2, 3, 4].map(i => ({ key: `c${i}`, label: `Celda ${i}`, unit: 'cuentas', decimals: 0, hint: 'lectura cruda' })),
        measureNote: 'Registre las lecturas CRUDAS del HX711 (sin tara ni escala aplicadas en el firmware). Si puede, promedie 10 lecturas.',

        validateConfig(cfg) {
            if (!cfg.name) return 'Escriba un nombre para el experimento.';
            if (cfg.cells.some(c => !isFinite(c.x) || !isFinite(c.y))) return 'Complete las coordenadas de las 4 celdas.';
            if (!cfg.masses_kg.filter(m => m > 0).length) return 'Defina al menos una masa.';
            if (cfg.positions.length < 3) return 'Use al menos 3 posiciones de carga (idealmente centro + 4 cuadrantes).';
            if (cfg.positions.some(p => !isFinite(p.x) || !isFinite(p.y))) return 'Complete las coordenadas de todas las posiciones.';
            return null;
        },

        checkRow(cfg, row) {
            const tare = app.rows.find(r => r.dir === 'tara' && r.cycle === row.cycle);
            if (!tare || row.dir === 'tara') return null;
            const neg = [1, 2, 3, 4].filter(i => row[`c${i}`] - tare[`c${i}`] < 0);
            return neg.length >= 2 ? `Las celdas ${neg.join(', ')} bajaron respecto a la tara. ¿Cables invertidos o lecturas cambiadas de orden?` : null;
        },

        setupConfig: app => { renderCells(app); renderPositions(app); },
        fillConfig: app => { renderCells(app); renderPositions(app); planSize(app); },
        onConfigChange: app => planSize(app),
        renderResults
    });

    function planSize(app) {
        $('#plan-size').textContent = `El plan tiene ${M.buildPlan(app.cfg).length} mediciones.`;
    }

    // ---------- Editores de tablas ----------
    function editor(container, items, fields, onChange, opts = {}) {
        container.innerHTML = `<div class="table-wrap"><table class="compact"><thead><tr>${fields.map(f => `<th>${f.label}</th>`).join('')}${opts.removable ? '<th></th>' : ''}</tr></thead>
            <tbody>${items.map((it, i) => `<tr>${fields.map(f => `<td><input type="text" ${f.num ? 'inputmode="decimal"' : ''} data-i="${i}" data-k="${f.key}" value="${esc(f.num ? String(it[f.key]).replace('.', ',') : it[f.key])}"></td>`).join('')}
            ${opts.removable ? `<td><button class="icon" data-rm="${i}" title="Quitar">✕</button></td>` : ''}</tr>`).join('')}</tbody></table></div>
            ${opts.addable ? '<button type="button" data-add>+ Agregar posición</button>' : ''}`;
        $$('input', container).forEach(inp => inp.addEventListener('input', () => {
            const f = fields.find(f => f.key === inp.dataset.k);
            items[+inp.dataset.i][f.key] = f.num ? num(inp.value) : inp.value;
            inp.classList.toggle('invalid', f.num && !isFinite(num(inp.value)));
            onChange();
        }));
        $$('[data-rm]', container).forEach(b => b.addEventListener('click', () => { items.splice(+b.dataset.rm, 1); onChange(); opts.rerender(); }));
        const add = $('[data-add]', container);
        add && add.addEventListener('click', () => { items.push(opts.blank()); onChange(); opts.rerender(); });
    }

    function renderCells(app) {
        editor($('#cells-editor'), app.cfg.cells, [
            { key: 'name', label: 'Celda' }, { key: 'x', label: 'x (mm)', num: true }, { key: 'y', label: 'y (mm)', num: true }
        ], () => app.saveDraft());
    }

    function renderPositions(app) {
        const rerender = () => { renderPositions(app); planSize(app); };
        editor($('#pos-editor'), app.cfg.positions, [
            { key: 'label', label: 'Nombre' }, { key: 'x', label: 'x (mm)', num: true }, { key: 'y', label: 'y (mm)', num: true }
        ], () => { app.saveDraft(); planSize(app); }, { removable: true, addable: true, rerender, blank: () => ({ label: `P${app.cfg.positions.length + 1}`, x: 0, y: 0 }) });
    }

    // ---------- Resultados ----------
    const kpi = (l, v, s = '', c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

    function renderResults(el, cfg, rows, res) {
        const m = res.metrics;
        el.innerHTML = `
            <h2>Resultado: ${esc(cfg.name)}</h2>
            <div class="kpis">
                ${kpi('Fuerza vertical', m.conformF ? 'Cumple' : 'No cumple', `tolerancia ±${fmt(cfg.tolFz_pct, 2)} % (${fmt(m.FS, 0)} N)`, m.conformF ? 'good' : 'bad')}
                ${kpi('Centro de presión', m.conformCoP ? 'Cumple' : 'No cumple', `tolerancia ±${fmt(cfg.tolCoP_mm, 1)} mm`, m.conformCoP ? 'good' : 'bad')}
                ${kpi('Error máx. fuerza', fmt(m.maxErrFpct, 3) + ' %', 'de la carga máxima')}
                ${kpi('No linealidad Fz', fmt(m.linFpct, 3) + ' %', 'máx. residuo')}
                ${kpi('Histéresis Fz', isFinite(m.hystFpct) ? fmt(m.hystFpct, 3) + ' %' : '—', 'carga vs descarga')}
                ${kpi('Repetibilidad Fz', fmt(m.repF, 3) + ' N', 'desv. est. combinada')}
                ${kpi('Error CoP (RMS)', fmt(m.rmsCoP, 2) + ' mm', `máx. ${fmt(m.maxCoP, 2)} mm`)}
                ${kpi('Repetibilidad CoP', fmt(m.repCoP, 2) + ' mm', '')}
                ${kpi('U fuerza', fmt(m.U_F, 3) + ' N', 'k = 2')}
                ${kpi('U CoP', fmt(m.U_CoP, 2) + ' mm', 'k = 2')}
            </div>
            ${app.warningsHtml(res.warnings)}
            <div class="card"><h3>Factores de escala por celda</h3>
                ${table(['Celda', 'x (mm)', 'y (mm)', 'k (N/cuenta)', '± se', 'cuentas/N', 'cuentas/kg'],
                    cfg.cells.map((c, i) => [esc(c.name), fmt(c.x, 0), fmt(c.y, 0), sig(res.k[i], 5), sig(res.seK[i], 2), fmt(1 / res.k[i], 2), fmt(res.g / res.k[i], 1)]))}
                <h4>Código para el firmware</h4>
                <pre>${esc(M.arduinoSnippet(cfg, res))}</pre>
            </div>
            <div class="plots"><div id="p1"></div><div id="p2"></div><div id="p3"></div><div id="p4"></div></div>
            <div class="card"><h3>Error según la carga</h3>
                ${table(['Masa (kg)', 'n', 'Error Fz medio (N)', 'Error Fz máx. (N)', 'CoP RMS (mm)', 'CoP máx. (mm)'],
                    res.byMass.map(b => [fmt(b.mass, 3), b.n, fmt(b.errFmean, 3), fmt(b.errFmax, 3), fmt(b.copRms, 2), fmt(b.copMax, 2)]))}
                <p class="muted small">Informe como <strong>carga mínima válida</strong> la menor masa cuyo error de CoP esté dentro de la tolerancia.</p>
            </div>
            <div class="card"><h3>CoP por posición (promedio)</h3>
                ${table(['Posición', 'x real', 'y real', 'CoP x', 'CoP y', 'Error medio (mm)'],
                    res.byPos.map(p => [esc(p.label), fmt(p.x, 0), fmt(p.y, 0), fmt(p.cxMean, 1), fmt(p.cyMean, 1), fmt(p.errMean, 2)]))}
                <p class="muted small">Si el error crece hacia una esquina, esa celda apoya mal o su coordenada está mal medida.</p>
            </div>
            ${res.drift.length ? `<div class="card"><h3>Deriva de la tara (final − inicial)</h3>
                ${table(['Ciclo', 'C1 (N)', 'C2 (N)', 'C3 (N)', 'C4 (N)', 'Total (N)'], res.drift.map(d => [d.cycle, ...d.N.map(v => fmt(v, 3)), fmt(d.Ntot, 3)]))}</div>` : ''}`;

        const pts = res.pts;
        const load = pts.filter(p => p.dir !== 'descarga'), unload = pts.filter(p => p.dir === 'descarga');
        const Wr = [0, m.FS];
        plot($('#p1'), {
            title: 'Fuerza medida vs peso aplicado', xLabel: 'M·g (N)', yLabel: 'Fz (N)',
            series: [{ label: 'carga', points: load.map(p => [p.W, p.Fz]) }, { label: 'descarga', color: 2, points: unload.map(p => [p.W, p.Fz]) },
                { label: 'ideal', kind: 'line', color: 3, points: Wr.map(v => [v, v]) }]
        });
        plot($('#p2'), {
            title: 'Error de fuerza (% de la carga máxima)', xLabel: 'M·g (N)', yLabel: 'Error (%)',
            series: [{ label: 'carga', points: load.map(p => [p.W, 100 * p.errF / m.FS]) }, { label: 'descarga', color: 2, points: unload.map(p => [p.W, 100 * p.errF / m.FS]) }],
            hlines: [{ y: cfg.tolFz_pct, label: '+tol' }, { y: -cfg.tolFz_pct, label: '−tol' }]
        });
        plot($('#p3'), {
            title: 'Mapa del centro de presión', xLabel: 'x (mm)', yLabel: 'y (mm)',
            series: [{ label: 'celdas', color: 3, points: cfg.cells.map(c => [c.x, c.y]) },
                { label: 'posición real', color: 2, points: res.byPos.map(p => [p.x, p.y]) },
                { label: 'CoP medido', color: 1, points: pts.map(p => [p.cx, p.cy]) }]
        });
        plot($('#p4'), {
            title: 'Error de CoP según la masa', xLabel: 'Masa (kg)', yLabel: '|error CoP| (mm)',
            series: [{ label: 'medición', color: 4, points: pts.map(p => [p.mass_kg, p.errCoP]) }],
            hlines: [{ y: cfg.tolCoP_mm, label: 'tolerancia' }]
        });
    }

    app.init();
})();
