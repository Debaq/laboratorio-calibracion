/* Interfaz del módulo IMU: sensores crudos */
(function () {
    'use strict';
    const M = window.ImuCrudoModel;
    const { $, $$, esc, num, fmt, sig, table, plot, toast, readFile } = window.LabUI;
    const unitTxt = cfg => ({ ms2: 'm/s²', g: 'g', cuentas: 'cuentas' })[cfg.accUnit];

    const app = window.LabApp.create({
        id: 'imucrudo',
        model: M,
        stepFields: [
            { key: 'cycle', label: 'Ciclo', decimals: 0 },
            { key: 'pos', label: 'Posición', type: 'select', options: M.POS.map(p => [p, p]) }
        ],
        measureFields: cfg => ['x', 'y', 'z'].map(a => ({ key: 'a' + a, label: `a${a}`, unit: unitTxt(cfg), decimals: 4 })),
        measureNote: 'Promedio de ~2 s con la placa quieta. Verifique que el eje indicado marque ≈ +1 g (o −1 g en las posiciones “−”).',
        validateConfig(cfg) {
            if (!cfg.name) return 'Escriba un nombre para el experimento.';
            if (!(cfg.cycles >= 1 && cfg.reps >= 1)) return 'Ciclos y lecturas deben ser ≥ 1.';
            return null;
        },
        checkRow(cfg, row) {
            const g = M.gRef(cfg) * (cfg.accUnit === 'cuentas' ? cfg.countsPerG : 1);
            const axis = 'a' + row.pos[1].toLowerCase(), sign = row.pos[0] === '+' ? 1 : -1;
            return sign * row[axis] < 0.7 * g ? `En la posición ${row.pos} el eje ${row.pos[1]} debería marcar ≈ ${sign > 0 ? '+' : '−'}1 g, pero marca ${fmt(row[axis], 3)}. ¿Posición o unidad equivocada?` : null;
        },
        onTab(name) { if (name === 'giro') renderGyro(); if (name === 'mag') renderMag(); },
        onExample(a) {
            const cfg = a.state.cfg;
            a.state.extra = {
                gyroStatic: M.gyroStatic(M.exampleGyroStatic(), cfg, 'Reposo 10 min (simulado)'),
                gyroRot: ['x', 'y', 'z'].map(ax => M.gyroRotation(M.exampleGyroRotation(ax), cfg, ax, 360, `${ax} +360° (simulado)`)),
                mag: { name: 'Rotación (simulado)', P: M.magPoints(M.exampleMag()) }
            };
        },
        protocolSummary: cfg => [
            ['Sensor', esc(`${cfg.sensor.model} · ${cfg.sensor.maker} · ${cfg.sensor.dof}`)],
            ['Acelerómetro', `6 posiciones × ${cfg.cycles} ciclos × ${cfg.reps} lectura(s), en ${unitTxt(cfg)}`],
            ['Tolerancias', `sesgo ±${cfg.tolBias_g} g · escala ±${cfg.tolScale_pct} %`],
            ['Giroscopio', `unidad ${cfg.gyroUnit === 'rads' ? 'rad/s' : '°/s'}`]
        ],
        protocolExtra: () => `<h3>Giroscopio</h3>
            <table class="kv"><tr><th>Reposo: duración y archivo</th><td></td></tr></table>
            <table class="sheet" style="margin-top:6px"><thead><tr><th>#</th><th>Eje</th><th>Ángulo verdadero (°)</th><th class="w">Archivo</th><th class="obs">Obs.</th></tr></thead>
            <tbody>${['x', 'y', 'z', 'x', 'y', 'z'].map((a, i) => `<tr><td>${i + 1}</td><td>${a}</td><td>${i < 3 ? '+360' : '−360'}</td><td class="w"></td><td class="obs"></td></tr>`).join('')}</tbody></table>
            <h3>Magnetómetro</h3><table class="kv"><tr><th>Montaje (lugar final)</th><td></td></tr><tr><th>Archivo de rotación</th><td></td></tr></table>`,
        renderResults
    });
    const extra = () => (app.state.extra = app.state.extra || { gyroStatic: null, gyroRot: [], mag: null });
    const kpi = (l, v, s = '', c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

    // ---------------- Acelerómetro ----------------
    function renderResults(el, cfg, rows, res, a) {
        const u = unitTxt(cfg), m = res.metrics;
        const mat = (A, d) => table(['', 'estímulo x', 'estímulo y', 'estímulo z'], A.map((r, i) => [`<strong>eje ${'xyz'[i]}</strong>`, ...r.map(v => fmt(v, d))]), { className: 'matrix' });
        el.innerHTML = `
            <h2>Acelerómetro: ${esc(cfg.sensor.model)}</h2>
            <div class="kpis">
                ${kpi('Sesgo', m.conformBias ? 'Cumple' : 'No cumple', `tolerancia ±${fmt(cfg.tolBias_g, 3)} g`, m.conformBias ? 'good' : 'bad')}
                ${kpi('Escala', m.conformScale ? 'Cumple' : 'No cumple', `tolerancia ±${fmt(cfg.tolScale_pct, 2)} %`, m.conformScale ? 'good' : 'bad')}
                ${['x', 'y', 'z'].map((ax, i) => kpi(`Eje ${ax}`, `${fmt(res.biasG[i] * 1000, 1)} mg`, `escala ${fmt(res.scaleErrPct[i], 2)} % · inclinación ${fmt(res.tiltErr[i], 2)}°`)).join('')}
                ${kpi('Tras corregir', `${fmt(m.maxAngErrAfter, 3)}°`, `error angular máx. · |a| ±${fmt(m.maxNormErrAfter, 2)} %`)}
                ${kpi('g local', `${fmt(res.g, 5)}`, cfg.accUnit === 'cuentas' ? '(1 g)' : u)}
            </div>
            ${a.warningsHtml(res.warnings)}
            <div class="card"><h3>Matriz de sensibilidad S ${cfg.accUnit === 'cuentas' ? '(cuentas/g)' : '(adimensional, ideal = identidad)'}</h3>${mat(res.S, cfg.accUnit === 'cuentas' ? 1 : 5)}
                <h4>Sesgo b (${esc(u)})</h4>${table(['', 'x', 'y', 'z'], [['promedio', ...res.b.map(v => fmt(v, 4))], ...res.bEst.map((e, i) => [`por par ${'XYZ'[i]}`, ...e.map(v => fmt(v, 4))]), ['diferencia máx.', ...res.bSpread.map(v => fmt(v, 4))]])}
                <h4>Desalineación entre ejes</h4>${table(['Eje medido', 'Estímulo', 'Ángulo (°)'], res.misalign.map(x => [x.meas, x.stim, fmt(x.deg, 3)]))}
            </div>
            <div class="card"><h3>Verificación por posición</h3>
                ${table(['Posición', 'n', `ax (${esc(u)})`, `ay (${esc(u)})`, `az (${esc(u)})`, 'Corregido x, y, z', '|a| − 1 g', 'Error de dirección'],
                    res.after.map(p => [p.pos, p.n, ...p.raw.map(v => fmt(v, 4)), p.cal.map(v => fmt(v, 3)).join(' · '), fmt(p.normErrPct, 3) + ' %', fmt(p.angErr, 3) + '°']))}
            </div>
            <div class="card"><h3>Código de corrección</h3><pre>${esc(M.accelCode(res, cfg))}</pre></div>`;
    }

    // ---------------- Giroscopio ----------------
    function withText(textSel, fileSel, runSel, exSel, onText, exFn) {
        $(runSel).addEventListener('click', () => { const t = $(textSel).value.trim(); if (!t) { toast('Pegue los datos', 'error'); return; } onText(t, null); $(textSel).value = ''; });
        $(fileSel).addEventListener('change', async ev => { const f = ev.target.files[0]; if (f) onText(await readFile(f), f.name); ev.target.value = ''; });
        $(exSel).addEventListener('click', () => onText(exFn(), null, true));
    }
    const guard = fn => (...args) => { try { fn(...args); } catch (e) { toast(e.message, 'error'); } };

    withText('#gs-text', '#gs-file', '#gs-run', '#gs-ex', guard((t, name, ex) => {
        extra().gyroStatic = M.gyroStatic(t, app.cfg, ex ? 'Reposo 10 min (simulado)' : name || 'Reposo');
        app.state.savedId = null; app.saveDraft(); renderGyro();
    }), M.exampleGyroStatic);
    withText('#gr-text', '#gr-file', '#gr-run', '#gr-ex', guard((t, name, ex) => {
        const axis = $('#gr-axis').value, angle = num($('#gr-angle').value);
        if (!isFinite(angle) || angle === 0) throw new Error('Ingrese el ángulo verdadero del giro');
        extra().gyroRot.push(M.gyroRotation(t, app.cfg, axis, angle, $('#gr-name').value || name || `${axis} ${angle}°${ex ? ' (simulado)' : ''}`));
        $('#gr-name').value = '';
        app.state.savedId = null; app.saveDraft(); renderGyro();
    }), () => M.exampleGyroRotation($('#gr-axis').value, num($('#gr-angle').value) || 360));

    function renderGyro() {
        const el = $('#giro-out'), ex = extra(), st = ex.gyroStatic;
        const rots = M.rotationResults(ex.gyroRot || [], st);
        if (!st && !rots.length) { el.innerHTML = '<p class="muted">Aún no hay registros del giroscopio.</p>'; return; }
        let html = '';
        if (st) html += `<h2>Reposo: ${esc(st.name)}</h2>
            <p class="muted small">${st.n} muestras · ${fmt(st.fs, 1)} Hz · ${fmt(st.duration / 60, 1)} min</p>
            ${app.warningsHtml(st.warnings)}
            ${table(['Eje', 'Sesgo (°/s)', 'Ruido σ (°/s)', 'ARW (°/√h)', 'Inestab. de sesgo (°/h)', 'en τ (s)', 'Deriva (°/s por min)'],
                st.axes.map(a => [a.axis, fmt(a.bias, 4), fmt(a.sd, 4), fmt(a.arw, 3), fmt(a.biasInst, 1), fmt(a.tauMin, 0), fmt(a.drift, 5)]))}
            <p class="muted small">Sin restar el sesgo, el ángulo integrado deriva sesgo × tiempo: ${fmt(Math.max(...st.axes.map(a => Math.abs(a.bias))) * 60, 1)}° por minuto en el peor eje.</p>
            <div class="plots"><div id="al"></div></div>`;
        if (rots.length) html += `<h2>Giros de ángulo conocido</h2>
            ${table(['Giro', 'Eje', 'Verdadero (°)', 'Medido (°)', 'Error de escala', 'Acoplamiento a otros ejes', 'Sesgo usado', ''],
                rots.map((r, i) => [esc(r.name), r.axis, fmt(r.angle, 1), fmt(r.measured, 2), `<strong>${fmt(r.scaleErrPct, 2)} %</strong>`, r.cross.map(c => `${c.axis}: ${fmt(c.pct, 2)} %`).join(' · '), r.biasSource, `<button class="icon" data-grdel="${i}">✕</button>`]))}
            ${st ? '' : '<p class="muted small">Sin registro de reposo, el sesgo se toma del primer segundo de cada archivo (menos exacto).</p>'}`;
        if (st || rots.length) {
            const scale = ['x', 'y', 'z'].map(ax => { const rr = rots.filter(r => r.axis === ax); return rr.length ? 1 / (1 + rr.reduce((s, r) => s + r.scaleErrPct, 0) / rr.length / 100) : 1; });
            html += `<div class="card"><h3>Código de corrección</h3><pre>${esc(`// Giroscopio: ω_corr = K · (ω_crudo − B)   [°/s]
const float B[3] = { ${(st ? st.axes.map(a => a.bias) : [0, 0, 0]).map(v => v.toFixed(5)).join(', ')} };   // sesgo (repetir al encender si deriva)
const float K[3] = { ${scale.map(v => v.toFixed(6)).join(', ')} };   // factor de escala por eje`)}</pre></div>`;
        }
        el.innerHTML = html;
        $$('[data-grdel]', el).forEach(b => b.addEventListener('click', () => { extra().gyroRot.splice(+b.dataset.grdel, 1); app.saveDraft(); renderGyro(); }));
        if (st) plot($('#al'), {
            title: 'Desviación de Allan', xLabel: 'τ (s)', yLabel: 'σ(τ) (°/s)', xlog: true, ylog: true,
            series: st.axes.map((a, i) => ({ label: `eje ${a.axis}`, kind: 'line', color: i + 1, points: a.allan.map(p => [p.tau, p.adev]) }))
        });
    }

    // ---------------- Magnetómetro ----------------
    withText('#mg-text', '#mg-file', '#mg-run', '#mg-ex', guard((t, name, ex) => {
        extra().mag = { name: ex ? 'Rotación (simulado)' : name || 'Rotación', P: M.magPoints(t) };
        app.state.savedId = null; app.saveDraft(); renderMag();
    }), M.exampleMag);

    function renderMag() {
        const el = $('#mag-out'), mg = extra().mag;
        if (!mg) { el.innerHTML = '<p class="muted">Aún no hay registro del magnetómetro.</p>'; return; }
        let r;
        try { r = M.magAnalyze(mg.P, app.cfg); } catch (e) { el.innerHTML = `<div class="callout error">${esc(e.message)}</div>`; return; }
        el.innerHTML = `
            <h2>Magnetómetro: ${esc(mg.name)}</h2>
            <div class="kpis">
                ${kpi('Hierro duro (centro)', r.center.map(v => fmt(v, 2)).join(' · '), 'x · y · z (unid. del sensor)')}
                ${kpi('Anisotropía', fmt(r.aniso, 3), 'eje mayor / menor (ideal 1)')}
                ${kpi('Dispersión de |m|', `${fmt(r.spreadRaw, 1)} % → ${fmt(r.spreadAfter, 2)} %`, 'crudo → corregido')}
                ${kpi('Error de rumbo aprox.', `±${fmt(r.headingErrRaw, 0)}° → ±${fmt(r.headingErrAfter, 1)}°`, 'peor caso, sensor horizontal')}
                ${kpi('Cobertura', `${r.octants} / 8`, 'octantes con datos')}
                ${kpi('Radio de la esfera', fmt(r.R, 2), app.cfg.magField_uT > 0 ? 'campo local indicado' : 'normalizado (volumen)')}
            </div>
            ${app.warningsHtml(r.warnings)}
            <div class="plots"><div id="m1"></div><div id="m2"></div></div>
            <div class="card"><h3>Código de corrección</h3><pre>${esc(M.magCode(r))}</pre></div>`;
        const P = mg.P, C = r.corrected;
        const proj = (i, j) => [{ label: 'crudo', color: 2, points: P.map(p => [p[i], p[j]]) }, { label: 'corregido', color: 1, points: C.map(p => [p[i], p[j]]) }];
        plot($('#m1'), { title: 'Proyección XY', xLabel: 'mx', yLabel: 'my', equal: true, series: proj(0, 1) });
        plot($('#m2'), { title: 'Proyección XZ', xLabel: 'mx', yLabel: 'mz', equal: true, series: proj(0, 2) });
    }

    app.init();
})();
