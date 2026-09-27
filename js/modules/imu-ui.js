/* Interfaz del módulo Posturógrafo IMU */
(function () {
    'use strict';
    const M = window.ImuModel;
    const { $, $$, esc, num, fmt, sig, table, badge, plot, toast, download } = window.LabUI;
    const Store = window.LabStore;
    const AX = { pitch: 'Pitch', roll: 'Roll', yaw: 'Yaw' };

    const refUnit = cfg => cfg.refMethod === 'directo' ? '°' : 'mm';

    const app = window.LabApp.create({
        id: 'imu',
        model: M,
        stepFields: [
            { key: 'cycle', label: 'Ciclo', decimals: 0 },
            { key: 'dir', label: 'Tipo', type: 'select', options: [['cero', 'Cero'], ['sube', '↑ Sube'], ['baja', '↓ Baja']] },
            { key: 'ref', label: 'Referencia', short: 'Ref.', unit: 'mm / °', decimals: 2 }
        ],
        measureFields: cfg => M.axesFor(cfg).map(a => ({ key: a, label: `${AX[a]} ${cfg.sensor.dof === 'incl' ? 'inclinómetro' : 'IMU'}`, unit: '°' })),
        measureNote: 'Lea los tres ángulos en el mismo instante (congele la pantalla o use el valor promedio de 1 s).',

        validateConfig(cfg) {
            if (!cfg.name) return 'Escriba un nombre para el experimento.';
            if (!M.axesFor(cfg).includes(cfg.axis)) return `Un ${M.DOF[cfg.sensor.dof].label} no mide yaw: elija pitch o roll.`;
            if (cfg.refMethod === 'seno' && !(cfg.L_mm > 0)) return 'L debe ser positiva.';
            if (cfg.refMethod === 'cuerda' && !(cfg.r_mm > 0)) return 'r debe ser positivo.';
            if (cfg.levels.filter(v => v !== 0).length < 3) return 'Defina al menos 3 niveles distintos de cero.';
            const bad = cfg.levels.find(v => !isFinite(M.referenceAngle(cfg, v).theta));
            if (bad !== undefined) return `El nivel ${bad} es imposible con esa geometría (|d| debe ser menor que L).`;
            if (!(cfg.cycles >= 1)) return 'Al menos 1 ciclo (se recomiendan 3).';
            return null;
        },

        checkRow(cfg, row) {
            if (row.dir === 'cero') return null;
            const e = M.expectedAngle(cfg, row.ref);
            const zeros = app.rows.filter(r => r.dir === 'cero' && r.cycle === row.cycle);
            if (!zeros.length || !isFinite(e.thetaExp)) return null;
            const z = zeros[0][cfg.axis];
            const d = M.wrapDeg(row[cfg.axis] - z);
            if (Math.abs(d - e.thetaExp) > Math.max(3, 0.3 * Math.abs(e.thetaExp)))
                return `El ${AX[cfg.axis]} cambió ${fmt(d, 2)}° pero se esperaban ≈ ${fmt(e.thetaExp, 2)}°. ¿Eje equivocado, signo invertido o posición mal puesta?`;
            return null;
        },

        protocolSummary(cfg) {
            const method = { seno: `Seno: d medido a L = ${fmt(cfg.L_mm, 0)} mm del pivote (u(L) = ${fmt(cfg.uL_mm, 1)} mm)`,
                cuerda: `Cuerda a radio r = ${fmt(cfg.r_mm, 0)} mm (u(r) = ${fmt(cfg.uL_mm, 1)} mm)`, directo: 'Directo: inclinómetro / goniómetro' }[cfg.refMethod];
            return [
                ['Sensor', esc(`${cfg.sensor.model} · ${cfg.sensor.maker} · ${M.DOF[cfg.sensor.dof].label} · modo ${cfg.sensor.mode}`)],
                ['Eje evaluado', AX[cfg.axis]],
                ['Referencia', esc(method)],
                ['Resolución referencia / IMU', `${fmt(cfg.resRef, 2)} ${refUnit(cfg)} / ${fmt(cfg.resImu, 4)}°`],
                ['Tolerancia de aceptación', `±${fmt(cfg.tolerance_deg, 2)}°`],
                ['Niveles', `${cfg.levels.map(v => fmt(v, 1)).join(' ; ')} ${refUnit(cfg)}`],
                ['Ciclos', `${cfg.cycles}${cfg.bidirectional ? ' · subiendo y bajando' : ''}`],
                ['Flexión de la barra', cfg.flex.enabled ? `se corrige: m = ${fmt(cfg.flex.tipMass_g, 0)} g, EI = ${sig(cfg.flex.EI_Nm2, 4)} N·m²` : 'no se corrige']
            ];
        },
        protocolExtra(cfg) {
            const lv = [...cfg.levels].filter(v => v !== 0).sort((a, b) => a - b);
            return `<h3>Ángulo esperado en cada nivel (para verificar en el momento)</h3>` + table([`Nivel (${refUnit(cfg)})`, 'θ referencia (°)', 'θ esperado IMU (°)', 'U ref, k=2 (°)'],
                lv.map(v => { const e = M.expectedAngle(cfg, v); return [fmt(v, 1), fmt(e.theta, 3), fmt(e.thetaExp, 3), fmt(2 * e.u, 3)]; }));
        },
        setupConfig(app) { setupFlexTest(app); },
        fillConfig(app) { updatePreview(app); fillFlexTest(app); },
        onConfigChange(app) { updatePreview(app); },
        onTab(name, app) { if (name === 'multi') renderMultiSelects(); },
        renderResults
    });

    // ---------- Vista previa de ángulos de cada nivel ----------
    function updatePreview(app) {
        const cfg = app.cfg;
        $('#res-unit').textContent = `(${refUnit(cfg)})`;
        $('#lv-unit').textContent = `(${refUnit(cfg)})`;
        const lv = [...cfg.levels].filter(v => v !== 0).sort((a, b) => a - b);
        if (!lv.length) { $('#levels-preview').innerHTML = ''; return; }
        const rows = lv.map(v => {
            const e = M.expectedAngle(cfg, v);
            return [fmt(v, 1), isFinite(e.theta) ? fmt(e.theta, 3) : '<span class="badge bad">imposible</span>',
                fmt(e.u, 3), cfg.flex.enabled ? fmt(e.phi, 4) : '—', fmt(e.thetaExp, 3)];
        });
        const nSteps = M.buildPlan(cfg).length;
        $('#levels-preview').innerHTML = `<p class="muted small">Ángulos que corresponden a cada nivel (${nSteps} mediciones en total):</p>` +
            table([`Nivel (${refUnit(cfg)})`, 'θ ref (°)', 'u(θ) (°)', 'Flexión φ (°)', 'θ esperado IMU (°)'], rows, { className: 'compact' });
    }

    // ---------- Ensayo de flexión ----------
    function setupFlexTest(app) {
        const ensure = () => { app.cfg.flexTest = app.cfg.flexTest || { span_mm: NaN, loadPos_mm: NaN, readingIncreases: false, rows: [] }; return app.cfg.flexTest; };
        $('#fx-span').addEventListener('input', e => { ensure().span_mm = num(e.target.value); app.saveDraft(); renderFlex(app); });
        $('#fx-pos').addEventListener('input', e => { ensure().loadPos_mm = num(e.target.value); app.saveDraft(); renderFlex(app); });
        $('#fx-inc').addEventListener('change', e => { ensure().readingIncreases = e.target.checked; app.saveDraft(); renderFlex(app); });
        $('#fx-add').addEventListener('click', () => {
            const m = num($('#fx-m').value), r = num($('#fx-r').value);
            if (!isFinite(m) || !isFinite(r)) { toast('Ingrese masa y lectura', 'error'); return; }
            ensure().rows.push({ mass_g: m, reading_mm: r });
            $('#fx-m').value = ''; $('#fx-r').value = ''; $('#fx-m').focus();
            app.saveDraft(); renderFlex(app);
        });
    }

    function fillFlexTest(app) {
        const ft = app.cfg.flexTest || {};
        $('#fx-span').value = isFinite(ft.span_mm) ? String(ft.span_mm).replace('.', ',') : '';
        $('#fx-pos').value = isFinite(ft.loadPos_mm) ? String(ft.loadPos_mm).replace('.', ',') : '';
        $('#fx-inc').checked = !!ft.readingIncreases;
        renderFlex(app);
    }

    function renderFlex(app) {
        const ft = app.cfg.flexTest;
        const out = $('#fx-out');
        if (!ft || !ft.rows.length) { out.innerHTML = ''; return; }
        const tbl = table(['#', 'Masa (g)', 'Lectura (mm)', ''], ft.rows.map((r, i) => [i + 1, fmt(r.mass_g, 1), fmt(r.reading_mm, 2), `<button class="icon" data-fxdel="${i}">✕</button>`]), { className: 'compact' });
        const res = M.flexion({ span_mm: ft.span_mm, loadPos_mm: ft.loadPos_mm, readingIncreases: ft.readingIncreases, lat: app.cfg.env.lat, alt: app.cfg.env.alt }, ft.rows);
        let html = tbl;
        if (res.ok) {
            html += `<div class="callout ok">EI = <strong>${sig(res.EI, 4)} ± ${sig(res.uEI, 2)} N·m²</strong> (R² = ${fmt(res.fit.r2, 5)})
                <button type="button" id="fx-use" class="primary" style="margin-left:10px">Usar este EI</button></div><div id="fx-plot"></div>`;
        } else html += `<div class="callout warn">${esc(res.error)}</div>`;
        out.innerHTML = html;
        $$('[data-fxdel]', out).forEach(b => b.addEventListener('click', () => { ft.rows.splice(+b.dataset.fxdel, 1); app.saveDraft(); renderFlex(app); }));
        if (res.ok) {
            $('#fx-use').addEventListener('click', () => {
                app.cfg.flex.EI_Nm2 = +res.EI.toPrecision(5);
                app.saveDraft(); app.fillConfig(); toast('EI aplicado a la corrección de flexión', 'ok');
            });
            plot($('#fx-plot'), {
                title: 'Flecha vs fuerza', xLabel: 'F (N)', yLabel: 'δ (mm)',
                series: [{ label: 'medido', points: res.F.map((f, i) => [f, res.delta[i] * 1000]) },
                    { label: 'ajuste', kind: 'line', color: 2, points: res.F.map(f => [f, 1000 * res.fit.predict(f)]) }]
            });
        }
    }

    // ---------- Resultados ----------
    function kpi(label, value, sub = '', cls = '') {
        return `<div class="kpi ${cls}"><div class="l">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
    }

    function renderResults(el, cfg, rows, res) {
        const m = res.metrics, ax = AX[cfg.axis];
        el.innerHTML = `
            <h2>Resultado: ${esc(ax)} — ${esc(cfg.sensor.model)}</h2>
            <div class="kpis">
                ${kpi('Veredicto', m.conform ? 'Cumple' : 'No cumple', `tolerancia ±${fmt(cfg.tolerance_deg, 2)}°`, m.conform ? 'good' : 'bad')}
                ${kpi('Error máximo', fmt(m.maxErr, 3) + '°', 'sin corregir')}
                ${kpi('Ganancia b', fmt(m.gain, 4), `± ${fmt(m.seGain, 4)} (ideal 1)`)}
                ${kpi('Offset a', fmt(m.offset, 3) + '°', `± ${fmt(m.seOffset, 3)}°`)}
                ${kpi('Sesgo medio', fmt(m.bias, 3) + '°', `s = ${fmt(m.sdErr, 3)}°`)}
                ${kpi('Repetibilidad', fmt(m.repeatability, 3) + '°', 'desv. est. combinada')}
                ${kpi('Histéresis', isFinite(m.hysteresis) ? fmt(m.hysteresis, 3) + '°' : '—', 'máx. |sube − baja|')}
                ${kpi('No linealidad', fmt(m.linearity, 3) + '°', 'máx. residuo')}
                ${kpi('U sin corregir', fmt(m.U_raw, 3) + '°', 'k = 2')}
                ${kpi('U corregido', fmt(m.U_corr, 3) + '°', 'con la ecuación, k = 2')}
                ${kpi('Referencia', fmt(2 * m.uRef, 3) + '°', `U(k=2) · TUR ${fmt(m.TUR, 1)}:1`, m.TUR >= 4 ? '' : 'bad')}
            </div>
            ${app.warningsHtml(res.warnings)}
            <div class="card">
                <h3>Ecuación de corrección</h3>
                <div class="math">${window.LabMath.tex(`\\theta_\\text{${cfg.axis}} = \\frac{\\Delta_\\text{${cfg.axis}} ${m.offset < 0 ? '+' : '-'} ${window.LabMath.num(Math.abs(m.offset), 4)}^{\\circ}}{${window.LabMath.num(m.gain, 5)}}`, true)}
                    <p>\\(\\Delta\\) = lectura − lectura en posición neutra (tome el cero al iniciar cada sesión).</p></div>
                <p class="muted small">Con la corrección, la incertidumbre baja de ${fmt(m.U_raw, 3)}° a ${fmt(m.U_corr, 3)}° (k = 2).
                    Si la ganancia no difiere significativamente de 1, basta con restar el cero.</p>
            </div>
            <div class="plots">
                <div id="p1"></div><div id="p2"></div><div id="p3"></div><div id="p4"></div>
            </div>
            <div class="card"><h3>Por nivel</h3>
                ${table([`Nivel (${refUnit(cfg)})`, 'θ esperado (°)', 'U ref (°)', 'n', `Δ ${ax} medio (°)`, 's (°)', 'Sesgo (°)', 'Histéresis (°)'],
                    res.perLevel.map(l => [fmt(l.ref, 1), fmt(l.thetaExp, 3), fmt(2 * l.uRef, 3), l.n, fmt(l.meanImu, 3), fmt(l.sd, 3), fmt(l.bias, 3), fmt(l.hyst, 3)]))}
            </div>
            <div class="card"><h3>Acoplamiento (crosstalk)</h3>
                ${table(['Eje', 'Pendiente (°/°)', '± se', '%', 'Desalineación ≈ (°)', 'Máx. |Δ| (°)'],
                    res.crosstalk.map(c => [AX[c.axis], fmt(c.slope, 4), fmt(c.seSlope, 4), fmt(100 * c.slope, 2) + ' %', fmt(c.angle, 2), fmt(c.maxAbs, 2)]))}
                <p class="muted small">Una pendiente de 0,02 °/° significa que por cada 10° en ${ax} el otro eje marca 0,2° falsos.
                    Pendientes mayores a ~2 % indican que el sensor está girado respecto a la barra.</p>
            </div>
            ${res.drift.length ? `<div class="card"><h3>Deriva del cero (final − inicial)</h3>
                ${table(['Ciclo', 'Pitch (°)', 'Roll (°)', 'Yaw (°)'], res.drift.map(d => [d.cycle, fmt(d.pitch, 3), fmt(d.roll, 3), fmt(d.yaw, 3)]))}</div>` : ''}
            <div class="card"><h3>¿Cómo interpretar?</h3>
                <ul>
                    <li><strong>Ganancia ≠ 1</strong>: el sensor exagera (b &gt; 1) o subestima (b &lt; 1) el ángulo. Suele deberse a la calibración interna del acelerómetro.</li>
                    <li><strong>Residuos con forma</strong> (curva, “S”): no linealidad. Aleatorios alrededor de 0: el modelo lineal basta.</li>
                    <li><strong>Histéresis</strong> comparable a la repetibilidad: la fricción del pivote o el juego mecánico, no el sensor.</li>
                    <li><strong>U corregido &lt; tolerancia</strong>: el sensor sirve si se aplica la ecuación de corrección.</li>
                </ul>
            </div>`;

        const pts = res.pts;
        const up = pts.filter(p => p.dir !== 'baja'), dn = pts.filter(p => p.dir === 'baja');
        const xs = pts.map(p => p.thetaExp);
        const line = [Math.min(...xs), Math.max(...xs)];
        plot($('#p1'), {
            title: `Δ ${ax} medido vs ángulo esperado`, xLabel: 'θ esperado (°)', yLabel: `Δ ${ax} IMU (°)`,
            series: [{ label: 'subiendo', points: up.map(p => [p.thetaExp, p.delta[cfg.axis]]) },
                { label: 'bajando', color: 2, points: dn.map(p => [p.thetaExp, p.delta[cfg.axis]]) },
                { label: 'ideal (y = x)', kind: 'line', color: 3, points: line.map(v => [v, v]) }]
        });
        plot($('#p2'), {
            title: 'Error (IMU − referencia) con U de la referencia', xLabel: 'θ esperado (°)', yLabel: 'Error (°)',
            series: [{ label: 'subiendo', points: up.map(p => [p.thetaExp, p.err]), err: up.map(p => 2 * p.u) },
                { label: 'bajando', color: 2, points: dn.map(p => [p.thetaExp, p.err]), err: dn.map(p => 2 * p.u) }],
            hlines: [{ y: cfg.tolerance_deg, label: '+tol' }, { y: -cfg.tolerance_deg, label: '−tol' }]
        });
        plot($('#p3'), {
            title: 'Residuos respecto a la recta ajustada', xLabel: 'θ esperado (°)', yLabel: 'Residuo (°)',
            series: [{ label: 'residuo', color: 4, points: pts.map((p, i) => [p.thetaExp, res.fit.residuals[i]]) }]
        });
        plot($('#p4'), {
            title: 'Ejes secundarios (acoplamiento)', xLabel: `θ esperado ${ax} (°)`, yLabel: 'Δ (°)',
            series: res.crosstalk.map((c, i) => ({ label: AX[c.axis], color: i + 5, points: pts.map(p => [p.thetaExp, p.delta[c.axis]]) }))
        });
    }

    // ---------- Multi-eje ----------
    function renderMultiSelects() {
        const saved = Store.listExperiments('imu');
        $('#multi-selects').innerHTML = M.AXES.map(a => {
            const opts = saved.filter(e => e.cfg.axis === a);
            return `<div class="field"><label>${AX[a]}</label><select id="ms-${a}"><option value="">— sin experimento —</option>
                ${opts.map(e => `<option value="${e.id}">${esc(e.name)} (${e.rows.length} med.)</option>`).join('')}</select></div>`;
        }).join('');
        if (!saved.length) $('#multi-out').innerHTML = '<div class="callout warn">Aún no hay experimentos guardados. Guarde al menos dos (de ejes distintos) en la pestaña Guardados.</div>';
    }

    $('#multi-run').addEventListener('click', () => {
        const chosen = M.AXES.map(a => ({ a, id: $(`#ms-${a}`).value })).filter(x => x.id);
        if (chosen.length < 2) { toast('Elija al menos 2 ejes', 'error'); return; }
        const results = [];
        for (const { a, id } of chosen) {
            const e = Store.getExperiment('imu', id);
            const r = M.analyze(e.cfg, e.rows);
            if (!r.ok) { toast(`"${e.name}" no se puede analizar`, 'error'); return; }
            results.push({ axis: a, res: r });
        }
        const mx = M.multiAxis(results);
        const mat = (A, d = 4) => table(['', ...M.AXES.map(a => `θ ${AX[a]}`)], A.map((row, i) => [`<strong>Δ ${AX[M.AXES[i]]}</strong>`, ...row.map(v => fmt(v, d))]), { className: 'matrix' });
        const matC = (A, d = 5) => table(['', ...M.AXES.map(a => `Δ ${AX[a]}`)], A.map((row, i) => [`<strong>θ ${AX[M.AXES[i]]}</strong>`, ...row.map(v => fmt(v, d))]), { className: 'matrix' });
        const missing = M.AXES.filter((_, i) => !mx.have[i]).map(a => AX[a]);
        $('#multi-out').innerHTML = `
            ${missing.length ? `<div class="callout warn">Sin experimento para ${missing.join(', ')}: se asume columna ideal (sin acoplamiento hacia los demás ejes).</div>` : ''}
            <div class="card"><h3>Matriz de sensibilidad A</h3>${mat(mx.A)}</div>
            ${mx.C ? `<div class="card"><h3>Matriz de corrección C = A⁻¹</h3>${matC(mx.C)}
                <p>Offsets a (°): ${mx.offset.map((v, i) => `${AX[M.AXES[i]]} ${fmt(v, 3)}`).join(' · ')}</p>
                <pre id="multi-code"></pre>
                <button type="button" id="multi-dl">Descargar matriz (JSON)</button></div>`
                : `<div class="callout error">${esc(mx.error)}</div>`}
            <div class="card"><h3>Desalineación entre pares de ejes</h3>
                ${table(['Par', 'Rotación relativa ≈ (°)', 'No ortogonalidad ≈ (°)', 'Datos'], mx.pairs.map(p => [p.pair, fmt(p.rotation, 2), fmt(p.skew, 2), p.complete ? 'completos' : '<span class="badge warn">parcial</span>']))}
                <p class="muted small">La parte antisimétrica de A es un giro rígido del sensor respecto de la barra (se corrige re-montando).
                    La parte simétrica indica ejes internos no perpendiculares (propio del sensor).</p></div>`;
        if (mx.C) {
            const f = v => v.toFixed(6);
            $('#multi-code').textContent = `// Corrección 3D del IMU: θ = C·(Δ − a)   [pitch, roll, yaw]
const float C[3][3] = {
  { ${mx.C[0].map(f).join(', ')} },
  { ${mx.C[1].map(f).join(', ')} },
  { ${mx.C[2].map(f).join(', ')} } };
const float A0[3] = { ${mx.offset.map(f).join(', ')} };`;
            $('#multi-dl').addEventListener('click', () => download('matriz_imu.json', JSON.stringify({ axes: mx.axes, A: mx.A, C: mx.C, offset: mx.offset, date: new Date().toISOString() }, null, 2), 'application/json'));
        }
    });

    app.init();
})();
