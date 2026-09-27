/* Interfaz del módulo Posturógrafo de balanza */
(function () {
    'use strict';
    const M = window.BalanzaModel;
    const BS = window.BalanzaSeries;
    const P = window.LabPhys;
    const { $, $$, esc, num, fmt, sig, table, plot, toast, readFile } = window.LabUI;

    const model = { ...M, defaultConfig: () => ({ ...M.defaultConfig(), series: BS.defaultSeriesConfig() }) };

    const app = window.LabApp.create({
        id: 'balanza',
        model,
        stepFields: [
            { key: 'cycle', label: 'Ciclo', decimals: 0 },
            { key: 'dir', label: 'Tipo', type: 'select', options: [['tara', 'Tara'], ['carga', '↑ Carga'], ['descarga', '↓ Descarga'], ['fluencia0', 'Fluencia t = 0'], ['fluencia60', 'Fluencia t = 60 s']] },
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

        protocolSummary(cfg) {
            const ms = [...cfg.masses_kg].sort((a, b) => a - b);
            const mPos = cfg.positionMass_kg > 0 ? cfg.positionMass_kg : ms[ms.length - 1];
            return [
                ['Equipo', esc(`${cfg.sensor.model} · ${cfg.sensor.adc}`)],
                ['Celdas (x, y) mm', cfg.cells.map(c => `${esc(c.name)}: (${fmt(c.x, 0)}, ${fmt(c.y, 0)})`).join('<br>')],
                ['Escalera de masas', `${ms.map(m => fmt(m, 1)).join(' ; ')} kg en ${esc(cfg.positions[0] ? cfg.positions[0].label : '—')}${cfg.bidirectional ? ', subiendo y bajando' : ''}`],
                ['Posiciones de CoP', cfg.positions.slice(1).map(p => `${esc(p.label)} (${fmt(p.x, 0)}, ${fmt(p.y, 0)})`).join(' · ') + ` — con ${fmt(mPos, 1)} kg`],
                ['Peso máximo de uso', `${fmt(cfg.maxUse_kg, 0)} kg`],
                ['Ciclos', `${cfg.cycles}${cfg.creep ? ' · prueba de fluencia al final' : ''}`],
                ['Tolerancias', `fuerza ±${fmt(cfg.tolFz_pct, 2)} % · CoP ±${fmt(cfg.tolCoP_mm, 1)} mm`],
                ['Series (ensayos 2 y 3)', `filtro ${fmt(cfg.series.filterHz, 1)} Hz · tara ${cfg.series.tareMode === 'inicio' ? `primeros ${fmt(cfg.series.tareSec, 0)} s vacíos` : 'de la calibración estática'}`]
            ];
        },
        protocolExtra(cfg) {
            const d = cfg.series.dyn;
            const rpm = [12, 30, 60, 90, 120];
            return `<h3>Ensayo 2 · Ruido de fondo</h3>
                <table class="kv"><tr><th>Masa del lastre (kg)</th><td>${fmt(cfg.series.noise.mass_kg, 1)} — real: ______</td></tr>
                <tr><th>Duración del registro (s)</th><td>45–60 (3 s vacía al inicio)</td></tr>
                <tr><th>Nombre del archivo</th><td></td></tr><tr><th>Observaciones</th><td style="height:40px"></td></tr></table>
                <h3>Ensayo 3 · Masa giratoria</h3>
                <table class="kv"><tr><th>m: masa que gira (kg)</th><td>${fmt(d.m_kg, 3)} — medida: ______</td></tr>
                <tr><th>r: radio de giro (mm)</th><td>${fmt(d.r_mm, 1)} — medido: ______</td></tr>
                <tr><th>h: altura de m sobre las celdas (mm)</th><td>${fmt(d.h_mm, 1)} — medido: ______</td></tr></table>
                <table class="sheet" style="margin-top:8px"><thead><tr><th>#</th><th>Velocidad objetivo</th><th class="w">Tiempo de 10 vueltas (s)</th><th class="w">Archivo</th><th class="obs">Obs.</th></tr></thead>
                <tbody>${rpm.map((r, i) => `<tr><td>${i + 1}</td><td>${r} rpm (${fmt(r / 60, 2)} Hz) — mínimo ${Math.max(3, Math.ceil(r / 60 * 20))} vueltas</td><td class="w"></td><td class="w"></td><td class="obs"></td></tr>`).join('')}</tbody></table>`;
        },
        setupConfig: app => { renderCells(app); renderPositions(app); setupSeries(app); },
        fillConfig: app => { renderCells(app); renderPositions(app); planSize(app); },
        onConfigChange: (app, path) => {
            planSize(app);
            if (path.startsWith('series.')) { clearTimeout(rerenderTimer); rerenderTimer = setTimeout(renderVisibleSeries, 400); }
        },
        onTab: name => { if (name === 'ruido') renderNoise(); if (name === 'dinamico') renderDyn(); },
        onExample: (app, ex) => {
            const cfg = app.state.cfg, g = P.gLocal(cfg.env.lat, cfg.env.alt);
            app.state.extra = { noise: BS.exampleNoise(cfg, ex.truth, g, cfg.series), dyn: BS.exampleRotation(cfg, ex.truth, g, cfg.series) };
        },
        renderResults
    });
    let rerenderTimer = null;

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

    // =============== Ensayos con series de tiempo ===============
    const extra = () => (app.state.extra = app.state.extra || { noise: null, dyn: [] });
    const gLoc = () => P.gLocal(app.cfg.env.lat, app.cfg.env.alt);

    /** Calibración estática del experimento actual (necesaria para cuentas crudas). */
    function staticCalib() {
        if (!app.rows.length) return null;
        try {
            const r = M.analyze(app.cfg, app.rows);
            if (!r.ok) return null;
            const cycles = Object.keys(r.base).map(Number).sort((a, b) => a - b);
            return { k: r.k, cells: app.cfg.cells, tareStatic: r.base[cycles[cycles.length - 1]] };
        } catch (e) { return null; }
    }
    const calibForCells = () => staticCalib() || { k: null, cells: app.cfg.cells, tareStatic: null };

    function calibNote(series) {
        if (series.kind !== 'raw') return `<p class="muted small">Archivo con ${series.kind === 'force' ? 'fuerzas por celda (N)' : 'CoP ya calculado'}: no se usa la calibración estática.</p>`;
        const c = staticCalib();
        return c ? `<p class="muted small">Cuentas crudas convertidas con los factores k de la calibración estática de este experimento.</p>`
            : '';
    }

    function parseInput(text, name) {
        try { return BS.parseCSV(text, name); }
        catch (e) { toast(e.message, 'error'); return null; }
    }

    function setupSeries(app) {
        $('#noise-import').addEventListener('click', () => {
            const s = parseInput($('#noise-text').value, 'Texto pegado');
            if (!s) return;
            extra().noise = s; $('#noise-text').value = '';
            app.state.savedId = null; app.saveDraft(); renderNoise();
        });
        $('#noise-file').addEventListener('change', async ev => {
            const f = ev.target.files[0]; if (!f) return;
            const s = parseInput(await readFile(f), f.name);
            ev.target.value = '';
            if (!s) return;
            extra().noise = s; app.state.savedId = null; app.saveDraft(); renderNoise();
        });
        $('#noise-clear').addEventListener('click', () => { extra().noise = null; app.saveDraft(); renderNoise(); });
        $('#dyn-import').addEventListener('click', () => {
            const s = parseInput($('#dyn-text').value, $('#dyn-label').value || `Corrida ${extra().dyn.length + 1}`);
            if (!s) return;
            extra().dyn.push(s); $('#dyn-text').value = ''; $('#dyn-label').value = '';
            app.state.savedId = null; app.saveDraft(); renderDyn();
        });
        $('#dyn-file').addEventListener('change', async ev => {
            for (const f of ev.target.files) {
                const s = parseInput(await readFile(f), f.name.replace(/\.(csv|txt)$/i, ''));
                if (s) extra().dyn.push(s);
            }
            ev.target.value = '';
            app.state.savedId = null; app.saveDraft(); renderDyn();
        });
    }

    function renderVisibleSeries() {
        if (!$('#tab-ruido').hidden) renderNoise();
        if (!$('#tab-dinamico').hidden) renderDyn();
    }

    function ellipsePoints(e) {
        return Array.from({ length: 73 }, (_, i) => {
            const a = i / 72 * 2 * Math.PI;
            const x = e.a * Math.cos(a), y = e.b * Math.sin(a);
            return [e.cx + x * Math.cos(e.angle) - y * Math.sin(e.angle), e.cy + x * Math.sin(e.angle) + y * Math.cos(e.angle)];
        });
    }

    function renderNoise() {
        const el = $('#noise-out');
        const s = extra().noise;
        if (!s) { el.innerHTML = '<p class="muted">Aún no hay datos. Pegue el texto del monitor serie o abra un archivo.</p>'; return; }
        const sc = app.cfg.series;
        const calib = calibForCells();
        const r = BS.noiseAnalysis(s, s.kind === 'raw' && !calib.k ? null : calib, sc, gLoc());
        if (!r.ok) { el.innerHTML = `<p><strong>${esc(s.name)}</strong> · ${s.n} muestras</p>` + app.warningsHtml(r.warnings, true); return; }
        const m = r.metrics, d = r.data;
        const kpi = (l, v, sub = '', c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
        el.innerHTML = `
            <h2>Piso de ruido: ${esc(s.name)}</h2>
            ${calibNote(s)}
            <div class="kpis">
                ${r.verdict === null ? '' : kpi('Veredicto', r.verdict ? 'Adecuado' : 'Ruido alto', `piso = ${fmt(r.ratio, 1)} % de la referencia (máx. ${fmt(sc.noise.pct, 0)} %)`, r.verdict ? 'good' : 'bad')}
                ${kpi('Velocidad media', fmt(m.velMean, 3) + ' mm/s', `ML ${fmt(m.velX, 3)} · AP ${fmt(m.velY, 3)}`)}
                ${kpi('RMS', `${fmt(m.rmsX, 3)} / ${fmt(m.rmsY, 3)}`, 'mm · ML / AP')}
                ${kpi('Área elipse 95 %', fmt(m.area95, 3) + ' mm²', '')}
                ${kpi('Trayectoria', fmt(m.path, 1) + ' mm', `en ${fmt(m.T, 1)} s`)}
                ${kpi('Deriva', fmt(Math.hypot(m.driftX, m.driftY) * 60, 3) + ' mm/min', 'tendencia lineal del CoP')}
                ${kpi('Masa estimada', r.massEst == null ? '—' : fmt(r.massEst, 2) + ' kg', r.massEst == null ? '' : `σ(Fz) = ${fmt(r.fzSd, 3)} N`)}
                ${kpi('Muestreo', fmt(d.samp.fs, 1) + ' Hz', `filtro ${d.filtered ? fmt(sc.filterHz, 1) + ' Hz' : 'no aplicado'} · jitter ${fmt(d.samp.jitter * 1000, 1)} ms`)}
            </div>
            ${app.warningsHtml(r.warnings)}
            <div class="plots"><div id="n1"></div><div id="n2"></div>${d.fz ? '<div id="n3"></div>' : ''}</div>
            <div class="card"><h3>¿Cómo interpretar?</h3><ul>
                <li>La velocidad media del ruido debe ser una fracción pequeña de la de un sujeto. Si es comparable, las diferencias entre pacientes quedan enmascaradas por el instrumento.</li>
                <li>El ruido de la velocidad <strong>aumenta con el muestreo</strong> y disminuye con el filtro: informe siempre ambos, y use los mismos con los sujetos.</li>
                <li>Una deriva notoria con carga inmóvil suele ser fluencia de las celdas o calentamiento del HX711.</li>
            </ul></div>`;
        plot($('#n1'), {
            title: 'Estatocinesigrama (CoP) con elipse del 95 %', xLabel: 'CoP x — ML (mm)', yLabel: 'CoP y — AP (mm)', equal: true,
            series: [{ label: 'CoP', kind: 'line', sort: false, width: 1, points: d.cx.map((x, i) => [x, d.cy[i]]) },
                { label: 'elipse 95 %', kind: 'line', sort: false, color: 2, points: ellipsePoints(m.ellipse) }]
        });
        plot($('#n2'), {
            title: 'CoP en el tiempo (sin la media)', xLabel: 't (s)', yLabel: 'mm',
            series: [{ label: 'ML (x)', kind: 'line', width: 1, points: d.t.map((t, i) => [t, d.cx[i] - m.meanX]) },
                { label: 'AP (y)', kind: 'line', color: 2, width: 1, points: d.t.map((t, i) => [t, d.cy[i] - m.meanY]) }]
        });
        if (d.fz) plot($('#n3'), {
            title: 'Fuerza vertical', xLabel: 't (s)', yLabel: 'Fz (N)',
            series: [{ label: 'Fz', kind: 'line', color: 4, width: 1, points: d.t.map((t, i) => [t, d.fz[i]]) }]
        });
    }

    let dynSel = -1;
    function renderDyn() {
        const el = $('#dyn-out');
        const runs = extra().dyn;
        if (!runs.length) { el.innerHTML = '<p class="muted">Aún no hay corridas. Agregue una por cada velocidad del motor.</p>'; return; }
        const sc = app.cfg.series, g = gLoc();
        const calib = calibForCells();
        const res = runs.map(s => BS.rotationAnalysis(s, s.kind === 'raw' && !calib.k ? null : calib, sc, g));
        const fr = BS.frequencyResponse(res, sc);
        if (dynSel < 0 || dynSel >= runs.length) dynSel = runs.length - 1;
        const rowsHtml = res.map((r, i) => r.ok
            ? [`<button class="link" data-dsel="${i}">${esc(runs[i].name)}</button>`, fmt(r.f, 3), fmt(r.revs, 1), fmt(r.circle.R, 2), fmt(r.Rpred, 2), fmt(r.centrifugalPct, 1) + ' %',
                `<strong>${fmt(r.ratio, 4)}</strong>`, '± ' + fmt(2 * r.uRel * r.ratio, 4), fmt(r.circle.radialRms, 2), fmt(r.ripple, 2) + ' %',
                `<button class="icon" data-ddel="${i}" title="Quitar">✕</button>`]
            : [esc(runs[i].name), `<span class="badge bad">error</span>`, '', '', '', '', esc((r.warnings || []).slice(-1)[0] || ''), '', '', '', `<button class="icon" data-ddel="${i}">✕</button>`]);
        const allW = [...fr.warnings, ...res.flatMap((r, i) => (r.warnings || []).map(w => `${runs[i].name}: ${w}`))];
        const kpi = (l, v, sub = '', c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
        const okRuns = fr.runs;
        el.innerHTML = `
            <h2>Respuesta dinámica</h2>
            ${calibNote(runs[0])}
            <div class="kpis">
                ${fr.verdict === null ? '' : kpi('Veredicto', fr.verdict ? 'Cumple' : 'No cumple', `±${fmt(sc.dyn.tol_pct, 1)} % hasta ${fmt(sc.dyn.fmax_Hz, 1)} Hz`, fr.verdict ? 'good' : 'bad')}
                ${okRuns.length ? kpi('Rango probado', `${fmt(okRuns[0].f, 2)}–${fmt(okRuns[okRuns.length - 1].f, 2)} Hz`, `${okRuns.length} corridas`) : ''}
                ${okRuns.length ? kpi('Peor razón', fmt(okRuns.reduce((a, r) => Math.abs(r.ratio - 1) > Math.abs(a - 1) ? r.ratio : a, 1), 4), 'R medido / R teórico') : ''}
                ${okRuns.length ? kpi('M usada', fmt(okRuns[0].M, 2) + ' kg', sc.dyn.Mtot_kg > 0 ? 'declarada' : 'de la fuerza medida') : ''}
            </div>
            ${app.warningsHtml(allW)}
            ${table(['Corrida', 'f (Hz)', 'Vueltas', 'R medido (mm)', 'R teórico (mm)', 'Centrífuga', 'Razón', 'U (k=2)', 'Desv. radial (mm)', 'Oscilación Fz', ''], rowsHtml)}
            <div class="plots"><div id="d1"></div><div id="d2"></div></div>
            <div class="card"><h3>¿Cómo interpretar?</h3><ul>
                <li><strong>Razón ≈ 1 en toda la banda</strong>: la plataforma sigue el CoP sin atenuarlo. Si cae con la frecuencia, el filtro o el muestreo son insuficientes.</li>
                <li><strong>Columna “Centrífuga”</strong>: cuánto agranda el círculo la fuerza horizontal. La plataforma la mide correctamente como CoP; es el mismo efecto por el que CoP ≠ CoM en una persona.</li>
                <li><strong>Desviación radial u oscilación de Fz altas</strong>: los canales no se muestrean al mismo tiempo, o la masa y el motor vibran.</li>
            </ul></div>`;
        $$('[data-dsel]', el).forEach(b => b.addEventListener('click', () => { dynSel = +b.dataset.dsel; renderDyn(); }));
        $$('[data-ddel]', el).forEach(b => b.addEventListener('click', () => {
            if (!confirm(`¿Quitar la corrida "${runs[+b.dataset.ddel].name}"?`)) return;
            runs.splice(+b.dataset.ddel, 1); app.state.savedId = null; app.saveDraft(); renderDyn();
        }));
        if (okRuns.length) plot($('#d1'), {
            title: 'Respuesta en amplitud', xLabel: 'Frecuencia (Hz)', yLabel: 'R medido / R teórico',
            series: [{ label: 'corrida (U, k = 2)', points: okRuns.map(r => [r.f, r.ratio]), err: okRuns.map(r => 2 * r.uRel * r.ratio) }],
            hlines: [{ y: 1 + sc.dyn.tol_pct / 100, label: '+tol' }, { y: 1 - sc.dyn.tol_pct / 100, label: '−tol' }]
        });
        const sel = res[dynSel];
        if (sel && sel.ok) {
            const c = sel.circle;
            plot($('#d2'), {
                title: `Trayectoria del CoP — ${runs[dynSel].name}`, xLabel: 'CoP x (mm)', yLabel: 'CoP y (mm)', equal: true,
                series: [{ label: 'CoP medido', kind: 'line', sort: false, width: 1, points: sel.data.cx.map((x, i) => [x, sel.data.cy[i]]) },
                    { label: 'círculo teórico', kind: 'line', sort: false, color: 3, points: Array.from({ length: 73 }, (_, i) => [c.xc + sel.Rpred * Math.cos(i / 72 * 2 * Math.PI), c.yc + sel.Rpred * Math.sin(i / 72 * 2 * Math.PI)]) }]
            });
        }
    }

    app.init();
})();
