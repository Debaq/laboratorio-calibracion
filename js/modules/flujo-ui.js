/* Interfaz compartida de los módulos Venturi y Pitot (según <body data-device="…">) */
(function () {
    'use strict';
    const device = document.body.dataset.device;
    const isV = device === 'venturi';
    const M = window.FlujoModel;
    const PM = window.PresionModel;
    const { $, $$, esc, fmt, sig, table, plot, toast, readFile } = window.LabUI;
    const Store = window.LabStore;

    const model = { ...M, defaultConfig: () => M.defaultConfig(device) };

    const app = window.LabApp.create({
        id: device,
        model,
        stepFields: [
            { key: 'level', label: 'Posición de válvula', short: 'Válvula', decimals: 0 },
            { key: 'rep', label: 'Repetición', short: 'Rep.', decimals: 0 }
        ],
        measureFields: cfg => {
            const f = [];
            if (isV && cfg.pressureMode === 'dos') f.push({ key: 'V1', label: 'Salida sensor P₁', short: 'V₁', unit: calUnit(cfg.calA), decimals: 4 }, { key: 'V2', label: 'Salida sensor P₂', short: 'V₂', unit: calUnit(cfg.calB), decimals: 4 });
            else f.push({ key: 'V', label: 'Salida sensor ΔP', short: 'V', unit: calUnit(cfg.calA), decimals: 4 });
            if (cfg.refMode === 'volumen') f.push({ key: 'vol_L', label: 'Volumen', unit: 'L', decimals: 3 }, { key: 'time_s', label: 'Tiempo', unit: 's', decimals: 2 });
            else if (cfg.refMode === 'caudal') f.push({ key: 'Q_Lmin', label: 'Caudal de referencia', short: 'Q ref', unit: 'L/min', decimals: 2 });
            else f.push({ key: 'v_ms', label: 'Velocidad de referencia', short: 'v ref', unit: 'm/s', decimals: 2 });
            return f;
        },
        measureNote: 'Promedie la salida del sensor durante el mismo intervalo en que mide la referencia.',

        validateConfig(cfg) {
            if (!cfg.name) return 'Escriba un nombre para el experimento.';
            if (!cfg.calA) return 'Seleccione o importe la calibración del sensor de presión.';
            if (isV && cfg.pressureMode === 'dos' && !cfg.calB) return 'Falta la calibración del sensor P₂.';
            if (isV && !(cfg.d_mm < cfg.D_mm)) return 'La garganta d debe ser menor que la entrada D.';
            if (cfg.levels.length < 3) return 'Use al menos 3 posiciones de válvula distintas.';
            return null;
        },

        setupConfig: setupCal,
        fillConfig: fillCal,
        onConfigChange: (app, path) => { if (path === 'refMode' || path === 'pressureMode') app.saveDraft(); fluidInfo(app); },
        onExample: (app, ex) => { app.state.cfg.calA = ex.cal; },
        renderResults
    });

    function calUnit(cal) { return cal ? cal.outputUnit || 'V' : 'V'; }

    // ---------- Calibraciones de presión ----------
    function savedCalibrations() {
        return Store.listExperiments('presion').map(e => {
            try {
                const r = PM.analyze(PM.defaultConfig && Object.assign(PM.defaultConfig(), e.cfg), e.rows);
                return r.ok ? PM.exportCalibration(Object.assign(PM.defaultConfig(), e.cfg), r, e.id) : null;
            } catch (err) { return null; }
        }).filter(Boolean);
    }

    function calSummary(cal) {
        if (!cal) return '<span class="badge warn">sin calibración</span>';
        const [c0, c1, c2] = cal.coef;
        return `<strong>${esc(cal.name || cal.sensor)}</strong> · ΔP = ${sig(c0, 5)} + ${sig(c1, 5)}·V${c2 ? ` + ${sig(c2, 4)}·V²` : ''} · rango ${fmt(cal.Vmin, 3)}–${fmt(cal.Vmax, 3)} ${esc(cal.outputUnit || 'V')} · SEE ${fmt(cal.see, 1)} Pa`;
    }

    function setupCal(app) {
        ['A', 'B'].forEach(k => {
            if (!$(`#cal${k}-sel`)) return;
            $(`#cal${k}-sel`).addEventListener('change', ev => {
                const id = ev.target.value;
                if (!id) return;
                const cal = savedCalibrations().find(c => c.id === id);
                app.cfg[`cal${k}`] = cal;
                app.saveDraft(); fillCal(app);
            });
            $(`#cal${k}-file`).addEventListener('change', async ev => {
                const f = ev.target.files[0];
                if (!f) return;
                try {
                    const cal = JSON.parse(await readFile(f));
                    if (cal.type !== 'calibracion-presion' || !Array.isArray(cal.coef)) throw new Error('No es una ecuación de calibración de presión');
                    app.cfg[`cal${k}`] = cal;
                    app.saveDraft(); fillCal(app); toast('Calibración importada', 'ok');
                } catch (e) { toast(e.message, 'error'); }
            });
        });
    }

    function fillCal(app) {
        const cals = savedCalibrations();
        ['A', 'B'].forEach(k => {
            const sel = $(`#cal${k}-sel`);
            if (!sel) return;
            const cur = app.cfg[`cal${k}`];
            sel.innerHTML = `<option value="">— elegir de experimentos guardados en Presión (${cals.length}) —</option>` +
                cals.map(c => `<option value="${c.id}" ${cur && cur.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
            $(`#cal${k}-info`).innerHTML = calSummary(cur);
        });
        fluidInfo(app);
    }

    function fluidInfo(app) {
        const fl = M.fluidProps(app.cfg);
        const el = $('#fluid-info');
        if (el) el.textContent = isFinite(fl.rho) ? `ρ = ${fmt(fl.rho, 4)} kg/m³ · μ = ${sig(fl.mu, 4)} Pa·s` +
            (isV ? ` · β = d/D = ${fmt(app.cfg.d_mm / app.cfg.D_mm, 3)}` : '') : '';
    }

    // ---------- Resultados ----------
    const kpi = (l, v, s = '', c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

    function renderResults(el, cfg, rows, res) {
        const m = res.metrics;
        const cName = isV ? 'C<sub>d</sub>' : 'C';
        const eq = isV
            ? `Q [L/min] = ${sig(m.K, 5)} · √ΔP[Pa]\n\nQ = C_d · A₂ · √(2ΔP / (ρ(1 − β⁴)))   con C_d = ${fmt(m.C, 4)}, β = ${fmt(m.beta, 4)}, ρ = ${fmt(res.fluid.rho, 4)} kg/m³`
            : `v [m/s] = ${sig(m.K, 5)} · √ΔP[Pa]\n\nv = C · √(2ΔP / ρ)   con C = ${fmt(m.C, 4)}, ρ = ${fmt(res.fluid.rho, 4)} kg/m³`;
        el.innerHTML = `
            <h2>Resultado: ${esc(cfg.name)}</h2>
            <div class="kpis">
                ${kpi(`Coeficiente ${cName}`, fmt(m.C, 4), `± ${fmt(m.seC, 4)} (ajuste por el origen)`)}
                ${kpi('Promedio de puntos', fmt(m.Cmean, 4), `s = ${fmt(m.Csd, 4)}`)}
                ${kpi(`U(${cName})`, fmt(m.U_C, 4), `k = 2 · ${fmt(100 * m.U_C / m.C, 2)} %`)}
                ${kpi('Reynolds', `${sig(m.Remin, 2)} – ${sig(m.Remax, 2)}`, isV ? 'en la garganta' : 'en el ducto')}
                ${cfg.fluid === 'aire' ? kpi('Mach máx.', fmt(m.machMax, 3), m.machMax < 0.3 ? 'incompresible OK' : 'compresible', m.machMax < 0.3 ? '' : 'bad') : ''}
            </div>
            ${app.warningsHtml(res.warnings)}
            <div class="card"><h3>Ecuación de uso</h3><div class="math">${esc(eq)}</div>
                <p class="muted small">Válida en el rango de Reynolds medido. Para usarla, convierta primero la salida del sensor en ΔP con la ecuación de calibración de presión.</p></div>
            <div class="plots"><div id="p1"></div><div id="p2"></div><div id="p3"></div></div>
            <div class="card"><h3>Puntos</h3>
                ${table(['Válvula', 'Rep.', 'ΔP (Pa)', isV ? 'Q ref (L/min)' : 'v ref (m/s)', isV ? 'Q teórico (L/min)' : 'v teórica (m/s)', cName, `U(${cName})`, 'Re'],
                    res.pts.map(p => [p.level, p.rep, fmt(p.dP, 1), fmt(isV ? p.Qref * 60000 : p.vref, 3), fmt(isV ? p.Qteo * 60000 : p.vteo, 3), fmt(p.C, 4), fmt(2 * p.uC, 4), sig(p.Re, 3)]))}
            </div>
            <div class="card"><h3>¿Cómo interpretar?</h3><ul>
                ${isV ? `<li>Un Venturi bien construido tiene <strong>C<sub>d</sub> entre 0,95 y 0,99</strong>. Valores menores indican pérdidas por rugosidad, un ángulo de difusor brusco, bajo Reynolds o una toma de presión mal ubicada.</li>
                <li>C<sub>d</sub> &gt; 1 no es físico: revise diámetros, fugas en la referencia de caudal o la calibración del sensor.</li>`
                : `<li>Un Pitot bien alineado tiene <strong>C ≈ 1</strong>. Si la referencia es un caudal, recuerde que el Pitot mide la velocidad <em>local</em>, no la media (factor de perfil).</li>
                <li>A velocidades bajas ΔP es muy pequeño: con aire a 2 m/s, ΔP ≈ 2,4 Pa, y el error relativo del sensor domina.</li>`}
                <li>Si ${cName} cambia con el Reynolds, informe la curva ${cName}(Re) o limite el rango de uso.</li>
            </ul></div>`;

        const pts = res.pts;
        const conv = isV ? 60000 : 1, unit = isV ? 'L/min' : 'm/s';
        const xr = [0, Math.max(...pts.map(p => p.x)) * conv];
        plot($('#p1'), {
            title: isV ? 'Caudal de referencia vs teórico' : 'Velocidad de referencia vs teórica', xLabel: `teórico (${unit})`, yLabel: `referencia (${unit})`,
            series: [{ label: 'medido', points: pts.map(p => [p.x * conv, p.y * conv]) },
                { label: `ajuste (${isV ? 'C_d' : 'C'})`, kind: 'line', color: 2, points: xr.map(v => [v, v * m.C]) },
                { label: 'ideal (C = 1)', kind: 'line', color: 3, points: xr.map(v => [v, v]) }]
        });
        plot($('#p2'), {
            title: `${isV ? 'C_d' : 'C'} según el número de Reynolds`, xLabel: 'Re (escala log)', yLabel: isV ? 'C_d' : 'C', xlog: true,
            series: [{ label: 'punto', points: pts.map(p => [p.Re, p.C]), err: pts.map(p => 2 * p.uC) }],
            hlines: [{ y: m.C, label: 'ajuste' }]
        });
        plot($('#p3'), {
            title: 'ΔP medido', xLabel: 'Posición de válvula', yLabel: 'ΔP (Pa)',
            series: [{ label: 'ΔP', color: 4, points: pts.map(p => [p.level, p.dP]), err: pts.map(p => 2 * p.uP) }]
        });
    }

    app.init();
})();
