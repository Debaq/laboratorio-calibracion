/* Interfaz del módulo Sensor de presión */
(function () {
    'use strict';
    const M = window.PresionModel;
    const P = window.LabPhys;
    const { $, $$, esc, fmt, sig, table, plot, download, slug, toast } = window.LabUI;
    const Store = window.LabStore;

    const app = window.LabApp.create({
        id: 'presion',
        model: M,
        stepFields: [
            { key: 'cycle', label: 'Ciclo', decimals: 0 },
            { key: 'dir', label: 'Tipo', type: 'select', options: [['cero', 'Cero'], ['sube', '↑ Sube'], ['baja', '↓ Baja']] },
            { key: 'level', label: 'Nivel objetivo', unit: 'mm', decimals: 0 }
        ],
        measureFields: cfg => [
            ...(cfg.mode === 'U'
                ? [{ key: 'hA', label: 'h_A rama presurizada', short: 'h_A', unit: 'mm', decimals: 1 }, { key: 'hB', label: 'h_B rama abierta', short: 'h_B', unit: 'mm', decimals: 1 }]
                : [{ key: 'h', label: 'Altura columna', short: 'h', unit: 'mm', decimals: 1 }]),
            { key: 'V', label: 'Salida del sensor', short: 'Salida', unit: cfg.sensor.outputUnit, decimals: 4 }
        ],
        measureNote: 'Lea cada menisco en su punto más bajo y con los ojos a su altura. Espere 10 s tras mover la jeringa.',

        validateConfig(cfg) {
            if (!cfg.name) return 'Escriba un nombre para el experimento.';
            if (!(cfg.water.temp > 0 && cfg.water.temp < 40)) return 'Temperatura del agua fuera de 0–40 °C.';
            if (cfg.levels.filter(v => v > 0).length < 3) return 'Defina al menos 3 niveles.';
            return null;
        },

        checkRow(cfg, row) {
            if (cfg.mode === 'U' && row.dir !== 'cero' && row.hB - row.hA < 0) return 'h_B es menor que h_A: ¿ramas cambiadas? La presión saldría negativa.';
            return null;
        },

        protocolSummary(cfg) {
            const rho = P.waterDensity(cfg.water.temp), g = P.gLocal(cfg.env.lat, cfg.env.alt);
            return [
                ['Sensor', esc(`${cfg.sensor.model} · ${cfg.sensor.maker} · salida en ${cfg.sensor.outputUnit} · FS ${fmt(cfg.sensor.FS_Pa, 0)} Pa`)],
                ['Manómetro', cfg.mode === 'U' ? 'Tubo en U: leer h_A (rama presurizada) y h_B (rama abierta)' : `Columna con estanque: h₀ = ${fmt(cfg.h0_mm, 1)} mm`],
                ['Regla', `resolución ${fmt(cfg.resRuler_mm, 1)} mm`],
                ['Agua', `${fmt(cfg.water.temp, 1)} °C → ρ = ${fmt(rho, 3)} kg/m³ · g = ${fmt(g, 5)} m/s²`],
                ['Niveles de Δh', `${cfg.levels.map(v => fmt(v, 0)).join(' ; ')} mm`],
                ['Ciclos', `${cfg.cycles}${cfg.bidirectional ? ' · subiendo y bajando' : ''}`],
                ['Tolerancia', `±${fmt(cfg.tol_pctFS, 2)} % FS`]
            ];
        },
        protocolExtra(cfg) {
            const k = (P.waterDensity(cfg.water.temp) - 1.2) * P.gLocal(cfg.env.lat, cfg.env.alt) / 1000;
            return `<h3>Presión esperada en cada nivel</h3>` + table(['Δh (mm)', 'ΔP (Pa)', 'ΔP (kPa)', '% FS'],
                [...cfg.levels].sort((a, b) => a - b).map(v => [fmt(v, 0), fmt(k * v, 1), fmt(k * v / 1000, 3), fmt(100 * k * v / cfg.sensor.FS_Pa, 1)]));
        },
        fillConfig: rhoInfo,
        onConfigChange: rhoInfo,
        extraSavedAction: e => `<button data-cal="${e.id}">Ecuación</button>`,
        bindSavedActions(el) {
            $$('[data-cal]', el).forEach(b => b.addEventListener('click', () => {
                const e = Store.getExperiment('presion', b.dataset.cal);
                const r = M.analyze(e.cfg, e.rows);
                if (!r.ok) { toast('Ese experimento no se puede analizar', 'error'); return; }
                download(`ecuacion_${slug(e.name)}.json`, JSON.stringify(M.exportCalibration(e.cfg, r, e.id), null, 2), 'application/json');
            }));
        },
        renderResults
    });

    function rhoInfo(app) {
        const c = app.cfg;
        const rho = P.waterDensity(c.water.temp), g = P.gLocal(c.env.lat, c.env.alt);
        $('#rho-info').textContent = isFinite(rho) && isFinite(g)
            ? `ρ agua = ${fmt(rho, 3)} kg/m³ · g = ${fmt(g, 5)} m/s² · 1 mm de agua = ${fmt((rho - 1.2) * g / 1000, 4)} Pa`
            : '';
    }

    const kpi = (l, v, s = '', c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

    function renderResults(el, cfg, rows, res) {
        const m = res.metrics, u = cfg.sensor.outputUnit;
        const eq = m.deg === 2
            ? `ΔP [Pa] = ${sig(m.coef[0], 6)} + ${sig(m.coef[1], 6)}·V + ${sig(m.coef[2], 6)}·V²`
            : `ΔP [Pa] = ${sig(m.coef[0], 6)} + ${sig(m.coef[1], 6)}·V`;
        el.innerHTML = `
            <h2>Resultado: ${esc(cfg.sensor.model)}</h2>
            <div class="kpis">
                ${kpi('Veredicto', m.conform ? 'Cumple' : 'No cumple', `tolerancia ±${fmt(cfg.tol_pctFS, 2)} % FS`, m.conform ? 'good' : 'bad')}
                ${kpi('Sensibilidad', fmt(m.sens_mV_kPa, 2), `m${u === 'V' ? 'V' : u}/kPa`)}
                ${kpi('Salida en cero', fmt(m.zeroV, 4), u)}
                ${kpi('No linealidad', fmt(m.linPctFS, 3) + ' %', 'FS, respecto a recta')}
                ${kpi('Histéresis', isFinite(m.hystPctFS) ? fmt(m.hystPctFS, 3) + ' %' : '—', `${fmt(m.hyst, 1)} Pa`)}
                ${kpi('Repetibilidad', fmt(m.repeat, 1) + ' Pa', 'desv. est. combinada')}
                ${kpi('SEE', fmt(m.see, 1) + ' Pa', `ajuste grado ${m.deg}`)}
                ${kpi('U a fondo de escala', fmt(m.U_fs, 1) + ' Pa', `${fmt(m.U_pctFS, 2)} % FS · k = 2`)}
                ${kpi('Rango calibrado', `${fmt(m.Vmin, 3)}–${fmt(m.Vmax, 3)}`, u)}
            </div>
            ${app.warningsHtml(res.warnings)}
            <div class="card"><h3>Ecuación de calibración</h3>
                <div class="math">${esc(eq)}
válida para ${fmt(m.Vmin, 3)} ≤ V ≤ ${fmt(m.Vmax, 3)} ${esc(u)}</div>
                ${table(['Coeficiente', 'Valor', 'Error estándar'], m.coef.map((c, i) => [`c${i}`, sig(c, 6), sig(m.se[i], 3)]))}
                <p class="muted small">Prueba F (grado 2 vs 1): ${isFinite(res.ftest.p) ? `p = ${sig(res.ftest.p, 2)} → ${res.ftest.p < 0.05 ? 'la curvatura es significativa' : 'la recta basta'}` : 'no aplica'}.
                    ρ agua = ${fmt(m.rhoW, 3)} kg/m³, g = ${fmt(m.g, 5)} m/s².</p>
            </div>
            <div class="plots"><div id="p1"></div><div id="p2"></div><div id="p3"></div></div>
            ${res.hyst.length ? `<div class="card"><h3>Histéresis por nivel</h3>
                ${table(['Nivel (mm)', 'Residuo sube − baja (Pa)', '% FS'], res.hyst.map(h => [fmt(h.level, 0), fmt(h.diff, 2), fmt(100 * h.diff / m.FS, 3)]))}</div>` : ''}
            <div class="card"><h3>¿Cómo interpretar?</h3><ul>
                <li><strong>Residuos en forma de “U” o arco</strong>: no linealidad. Si la prueba F la confirma, use el ajuste cuadrático.</li>
                <li><strong>Residuos que se separan entre subida y bajada</strong>: histéresis del sensor o fuga lenta de aire.</li>
                <li><strong>Sensibilidad distinta al datasheet</strong>: revise la tensión de alimentación (los sensores ratiométricos escalan con Vcc).</li>
                <li><strong>Ecuación</strong>: guárdela y úsela en los módulos Venturi y Pitot, o descárguela en Guardados → Ecuación.</li>
            </ul></div>`;

        const pts = res.pts;
        const up = pts.filter(p => p.dir !== 'baja'), dn = pts.filter(p => p.dir === 'baja');
        const vs = [m.Vmin, m.Vmax];
        const curve = Array.from({ length: 30 }, (_, i) => vs[0] + (vs[1] - vs[0]) * i / 29);
        plot($('#p1'), {
            title: 'Presión de referencia vs salida del sensor', xLabel: `Salida (${u})`, yLabel: 'ΔP (Pa)',
            series: [{ label: 'subiendo', points: up.map(p => [p.V, p.dP]) }, { label: 'bajando', color: 2, points: dn.map(p => [p.V, p.dP]) },
                { label: 'ajuste', kind: 'line', color: 3, points: curve.map(v => [v, res.fit.predict(v)]) }]
        });
        plot($('#p2'), {
            title: 'Residuos (con incertidumbre de la referencia)', xLabel: 'ΔP (Pa)', yLabel: 'Residuo (Pa)',
            series: [{ label: 'subiendo', points: up.map(p => [p.dP, p.res]), err: up.map(p => 2 * p.uRand) },
                { label: 'bajando', color: 2, points: dn.map(p => [p.dP, p.res]), err: dn.map(p => 2 * p.uRand) }]
        });
        plot($('#p3'), {
            title: 'Incertidumbre expandida de la ecuación (k = 2)', xLabel: `Salida (${u})`, yLabel: 'U (Pa)',
            series: [{ label: 'U(ΔP)', kind: 'line', color: 4, points: curve.map(v => [v, 2 * res.uAt(v)]) }]
        });
    }

    app.init();
})();
