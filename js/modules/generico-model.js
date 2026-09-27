/*
 * Motor genérico de calibración de sensores escalares.
 * Cada sensor se describe con un PERFIL (js/perfiles/*.js); este motor aporta:
 *
 *  - Modelos linealizables  g(y) = Σ cₖ·φₖ(x)  (lineal, polinomios, logarítmico, potencia, inverso,
 *    Beta y Steinhart–Hart para termistores). Se ajustan por mínimos cuadrados en el espacio transformado
 *    y los residuos se evalúan en unidades del mensurando. Comparación de modelos por AICc.
 *  - Modo "calibración": referencia conocida vs lectura → ecuación de uso, repetibilidad, histéresis,
 *    incertidumbre de predicción y conformidad.
 *  - Modo "comparación": sensor vs equipo de referencia en las mismas unidades → Bland–Altman.
 *  - Tiempo de respuesta (τ) a partir de una serie de un escalón.
 */
(function (root, factory) {
    const req = n => (typeof require === 'function') ? require(n) : null;
    const S = req('../core/stats.js') || root.LabStats;
    const L = req('../core/linalg.js') || root.LabLinalg;
    const U = req('../core/uncertainty.js') || root.LabUnc;
    const Sig = req('../core/signal.js') || root.LabSignal;
    const CSV = req('../core/csv.js') || root.LabCSV;
    const m = factory(S, L, U, Sig, CSV);
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.GenericoModel = m;
})(typeof self !== 'undefined' ? self : this, function (S, L, U, Sig, CSV) {
    'use strict';

    const K0 = 273.15;
    const pos = v => v > 0;

    // ---------------- Modelos ----------------
    const MODELS = {
        lineal: {
            label: 'Lineal', eq: 'y = c₀ + c₁·x', names: ['c₀', 'c₁'],
            basis: x => [1, x], g: y => y, gi: t => t, dgi: () => 1,
            code: c => `return ${c[0]} + ${c[1]} * x;`
        },
        proporcional: {
            label: 'Proporcional (por el origen)', eq: 'y = c₁·x', names: ['c₁'],
            basis: x => [x], g: y => y, gi: t => t, dgi: () => 1,
            code: c => `return ${c[0]} * x;`
        },
        poly2: {
            label: 'Polinomio grado 2', eq: 'y = c₀ + c₁·x + c₂·x²', names: ['c₀', 'c₁', 'c₂'],
            basis: x => [1, x, x * x], g: y => y, gi: t => t, dgi: () => 1,
            code: c => `return ${c[0]} + x * (${c[1]} + x * ${c[2]});`
        },
        poly3: {
            label: 'Polinomio grado 3', eq: 'y = c₀ + c₁·x + c₂·x² + c₃·x³', names: ['c₀', 'c₁', 'c₂', 'c₃'],
            basis: x => [1, x, x * x, x * x * x], g: y => y, gi: t => t, dgi: () => 1,
            code: c => `return ${c[0]} + x * (${c[1]} + x * (${c[2]} + x * ${c[3]}));`
        },
        log: {
            label: 'Logarítmico', eq: 'y = c₀ + c₁·ln(x)', names: ['c₀', 'c₁'],
            basis: x => [1, Math.log(x)], g: y => y, gi: t => t, dgi: () => 1, xOk: pos,
            code: c => `return ${c[0]} + ${c[1]} * log(x);`
        },
        potencia: {
            label: 'Potencia', eq: 'y = e^c₀ · x^c₁   (ln y = c₀ + c₁·ln x)', names: ['c₀', 'c₁'],
            basis: x => [1, Math.log(x)], g: y => Math.log(y), gi: t => Math.exp(t), dgi: t => Math.exp(t), xOk: pos, yOk: pos,
            code: c => `return exp(${c[0]} + ${c[1]} * log(x));`
        },
        inverso: {
            label: 'Inverso', eq: 'y = c₀ + c₁ / x', names: ['c₀', 'c₁'],
            basis: x => [1, 1 / x], g: y => y, gi: t => t, dgi: () => 1, xOk: x => x !== 0,
            code: c => `return ${c[0]} + ${c[1]} / x;`
        },
        beta: {
            label: 'Termistor Beta', eq: '1/T = c₀ + c₁·ln(R)   (T en K;  B = 1/c₁)', names: ['c₀', 'c₁'],
            basis: x => [1, Math.log(x)], g: y => 1 / (y + K0), gi: t => 1 / t - K0, dgi: t => -1 / (t * t), xOk: pos,
            code: c => `float L = log(x);\n  return 1.0 / (${c[0]} + ${c[1]} * L) - 273.15;`
        },
        steinhart: {
            label: 'Steinhart–Hart', eq: '1/T = c₀ + c₁·ln(R) + c₃·ln(R)³   (T en K)', names: ['c₀', 'c₁', 'c₃'],
            basis: x => { const l = Math.log(x); return [1, l, l * l * l]; }, g: y => 1 / (y + K0), gi: t => 1 / t - K0, dgi: t => -1 / (t * t), xOk: pos,
            code: c => `float L = log(x);\n  return 1.0 / (${c[0]} + ${c[1]} * L + ${c[2]} * L * L * L) - 273.15;`
        }
    };

    /** Ajusta un modelo. Devuelve predicción, incertidumbre, residuos (en unidades de y) y AICc. */
    function fitModel(id, x, y) {
        const M = MODELS[id];
        if (!M) throw new Error(`Modelo desconocido: ${id}`);
        const idx = x.map((_, i) => i).filter(i => (!M.xOk || M.xOk(x[i])) && (!M.yOk || M.yOk(y[i])));
        if (idx.length < x.length) throw new Error(`${M.label}: hay valores fuera del dominio del modelo (x ≤ 0 o y ≤ 0).`);
        const A = x.map(M.basis), b = y.map(M.g);
        const p = A[0].length;
        if (x.length < p + 1) throw new Error(`${M.label}: se necesitan al menos ${p + 1} puntos.`);
        const sol = L.lstsq(A, b);
        const c = sol.x;
        const t = xv => M.basis(xv).reduce((s, phi, k) => s + phi * c[k], 0);
        const predict = xv => M.gi(t(xv));
        const res = y.map((yi, i) => yi - predict(x[i]));
        const n = x.length, rss = S.sum(res.map(r => r * r));
        const see = sol.df > 0 ? Math.sqrt(rss / sol.df) : NaN;
        const uFit = xv => {
            const phi = M.basis(xv);
            let v = 0;
            for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) v += phi[i] * sol.cov[i][j] * phi[j];
            return Math.sqrt(Math.max(v, 0)) * Math.abs(M.dgi(t(xv)));
        };
        const uPred = xv => Math.sqrt(see * see + uFit(xv) ** 2);
        const aicc = n - p - 1 > 0 ? n * Math.log(rss / n) + 2 * p + 2 * p * (p + 1) / (n - p - 1) : NaN;
        const my = S.mean(y), ssTot = S.sum(y.map(v => (v - my) ** 2));
        return {
            id, label: M.label, eq: M.eq, names: M.names, coef: c, se: c.map((_, k) => Math.sqrt(sol.cov[k][k])), cov: sol.cov,
            n, p, df: sol.df, rss, see, r2: 1 - rss / ssTot, aicc, residuals: res, maxRes: S.maxAbs(res),
            predict, uFit, uPred
        };
    }

    /** Código C/Arduino de la ecuación de calibración. */
    function codeFor(fit, profile, cfg, xmin, xmax) {
        const c = fit.coef.map(v => v.toPrecision(9));
        const mode = (profile.readingModes || []).find(m => m.id === cfg.readingMode) || {};
        const lab = profile.labels ? profile.labels(cfg) : { quantity: profile.quantity, unit: profile.unit, reading: mode.label || profile.reading.label, readingUnit: mode.unit || profile.reading.unit };
        return `// ${profile.name}: ${cfg.sensor.model || ''} — calibrado el ${new Date().toLocaleDateString('es-CL')}
// Modelo ${fit.label}: ${fit.eq}
// x = ${mode.xLabel || lab.reading || mode.label || 'lectura'} [${mode.xUnit || lab.readingUnit || mode.unit || ''}]  →  ${lab.quantity} [${lab.unit}]
// Válida para ${xmin.toPrecision(5)} ≤ x ≤ ${xmax.toPrecision(5)}; fuera de ese rango NO está calibrada.
float calibrar(float x) {
  ${MODELS[fit.id].code(c)}
}`;
    }

    // ---------------- Perfil → modelo del módulo ----------------
    function create(profile) {
        const mode = profile.mode || 'calibracion';
        const modes = profile.readingModes || [{ id: 'directo', label: profile.reading.label, unit: profile.reading.unit }];
        const refs = profile.references || [{ id: 'patron', label: 'Instrumento patrón', u: 0 }];

        function defaultConfig() {
            const modeParams = {};
            modes.forEach(m => (m.fields || []).forEach(f => { modeParams[f.key] = f.default; }));
            const params = {};
            (profile.params || []).forEach(f => { params[f.key] = f.default; });
            return {
                name: '', profile: profile.id,
                sensor: { model: profile.defaultSensor || '', maker: '', notes: '' },
                readingMode: modes[0].id, modeParams,
                refType: refs[0].id, uRef: refs[0].u, refRes: profile.refRes ?? 0.1,
                levels: (profile.levels || []).slice(), cycles: profile.cycles ?? 2, reps: profile.reps ?? 1,
                bidirectional: profile.bidirectional ?? (mode === 'calibracion'),
                model: profile.defaultModel || (profile.models || ['lineal'])[0],
                tolerance: profile.tolerance ?? 1,
                params,
                env: { lat: -39.81, alt: 10, temp: 20, p_hPa: 1013 },
                series: { tauMax: profile.tauMax ?? NaN }
            };
        }

        const unitOf = cfg => profile.labels ? profile.labels(cfg).unit : profile.unit;
        const levelLabel = (lv, cfg) => profile.levelLabel ? profile.levelLabel(lv, cfg) : `${lv} ${unitOf(cfg)}`;

        function buildPlan(cfg) {
            const lv = [...cfg.levels];
            if (mode === 'calibracion') lv.sort((a, b) => a - b);
            const plan = [];
            const push = (c, dir, level, rep) => {
                const base = { cycle: c, dir, level, rep };
                const action = profile.stepAction ? profile.stepAction(base, cfg)
                    : mode === 'comparacion'
                        ? `Medición ${plan.length + 1} — ${levelLabel(level, cfg)}${cfg.reps > 1 ? `, repetición ${rep}` : ''}: registre el sensor y la referencia al mismo tiempo.`
                        : `Ciclo ${c} ${dir === 'baja' ? '↓' : '↑'}: lleve la referencia a ≈ ${levelLabel(level, cfg)}${dir === 'baja' ? ' (llegando desde arriba)' : ''}. ${profile.settle || 'Espere a que se estabilice.'}${cfg.reps > 1 ? ` Lectura ${rep} de ${cfg.reps}.` : ''}`;
                plan.push({ ...base, action });
            };
            for (let c = 1; c <= cfg.cycles; c++) {
                lv.forEach(v => { for (let r = 1; r <= cfg.reps; r++) push(c, 'sube', v, r); });
                if (mode === 'calibracion' && cfg.bidirectional)
                    lv.slice().reverse().slice(1).forEach(v => { for (let r = 1; r <= cfg.reps; r++) push(c, 'baja', v, r); });
            }
            return plan;
        }

        /** x: lectura del sensor transformada según el modo (p. ej. cuentas ADC → Ω). */
        function xOf(row, cfg) {
            const m = modes.find(q => q.id === cfg.readingMode) || modes[0];
            return m.toX ? m.toX(row.reading, cfg.modeParams, row, cfg) : row.reading;
        }

        /** y: valor de referencia y su incertidumbre estándar. */
        function yOf(row, cfg) {
            const r = profile.refFromRow ? profile.refFromRow(row, cfg) : { value: row.ref, u: 0 };
            const uType = isFinite(cfg.uRef) ? cfg.uRef : 0;
            return { value: r.value, u: U.combine(uType, r.u || 0, U.fromResolution(cfg.refRes || 0)) };
        }

        function points(cfg, rows) {
            return rows.map(r => ({ ...r, x: xOf(r, cfg), ...(o => ({ y: o.value, uRef: o.u }))(yOf(r, cfg)) }))
                .filter(p => isFinite(p.x) && isFinite(p.y));
        }

        function analyze(cfg, rows) {
            const pts = points(cfg, rows);
            return mode === 'comparacion' ? analyzeComparison(cfg, pts) : analyzeCalibration(cfg, pts);
        }

        function analyzeCalibration(cfg, pts) {
            const warnings = [];
            if (pts.length < 4) return { ok: false, warnings: ['Se necesitan al menos 4 mediciones válidas.'], pts };
            const x = pts.map(p => p.x), y = pts.map(p => p.y);
            const candidates = (profile.models || ['lineal', 'poly2']).map(id => {
                try { return fitModel(id, x, y); } catch (e) { return { id, label: MODELS[id].label, error: e.message }; }
            });
            const okFits = candidates.filter(f => !f.error);
            if (!okFits.length) return { ok: false, warnings: candidates.map(c => c.error), pts };
            const fit = okFits.find(f => f.id === cfg.model) || okFits[0];
            const best = okFits.filter(f => isFinite(f.aicc)).sort((a, b) => a.aicc - b.aicc)[0];
            if (best && best.id !== fit.id && fit.aicc - best.aicc > 4)
                warnings.push(`El modelo "${best.label}" describe mejor los datos (AICc menor en ${(fit.aicc - best.aicc).toFixed(1)}). Considere usarlo.`);
            if (fit.error) warnings.push(fit.error);

            pts.forEach((p, i) => { p.res = fit.residuals[i]; });
            const groups = S.groupBy(pts, p => `${p.level}|${p.dir}`);
            const rep = S.pooledSD([...groups.values()].map(g => g.map(p => p.res)));
            const hyst = [];
            for (const lv of new Set(pts.map(p => p.level))) {
                const up = pts.filter(p => p.level === lv && p.dir === 'sube'), dn = pts.filter(p => p.level === lv && p.dir === 'baja');
                if (up.length && dn.length) hyst.push({ level: lv, diff: S.mean(up.map(p => p.res)) - S.mean(dn.map(p => p.res)) });
            }
            const uRefRms = S.rms(pts.map(p => p.uRef));
            const xmin = Math.min(...x), xmax = Math.max(...x);
            const Uat = xv => U.expanded(U.combine(fit.uPred(xv), uRefRms));
            const Ufit = Math.max(Uat(xmin), Uat(xmax), Uat((xmin + xmax) / 2));
            const tol = cfg.tolerance;
            const conform = fit.maxRes + U.expanded(uRefRms) <= tol;

            let raw = null;
            if (profile.sameUnits) {
                const e = pts.map(p => p.x - p.y);
                raw = { bias: S.mean(e), sd: S.sd(e), rmse: S.rms(e), maxErr: S.maxAbs(e), conform: S.maxAbs(e) + U.expanded(uRefRms) <= tol };
            }
            if (2 * uRefRms > tol / 4) warnings.push(`La referencia es poco exacta frente a la tolerancia: U_ref = ${(2 * uRefRms).toPrecision(2)} ${unitOf(cfg)}, tolerancia ${tol} ${unitOf(cfg)} (se recomienda ≤ 1/4).`);
            const yspan = Math.max(...y) - Math.min(...y);
            if (profile.range && yspan < 0.5 * (profile.range[1] - profile.range[0]))
                warnings.push(`Se cubrió ${yspan.toPrecision(3)} ${unitOf(cfg)} de un rango de uso de ${profile.range[0]}–${profile.range[1]} ${unitOf(cfg)}: la ecuación no vale fuera de lo medido.`);
            const extra = profile.extraMetrics ? profile.extraMetrics(fit, pts, cfg) : [];
            if (profile.extraWarnings) warnings.push(...profile.extraWarnings(fit, pts, cfg));

            return {
                ok: true, mode, warnings, pts, fit, candidates, best, hyst, raw, extra,
                metrics: {
                    see: fit.see, maxRes: fit.maxRes, r2: fit.r2, repeat: rep.s,
                    hyst: hyst.length ? S.maxAbs(hyst.map(h => h.diff)) : NaN,
                    uRef: uRefRms, U: Ufit, conform, xmin, xmax, ymin: Math.min(...y), ymax: Math.max(...y)
                },
                Uat
            };
        }

        /** Bland–Altman: sesgo, límites de acuerdo (95 %) con sus IC, sesgo proporcional y ARMS. */
        function analyzeComparison(cfg, pts) {
            const warnings = [];
            if (pts.length < 5) return { ok: false, warnings: ['Se necesitan al menos 5 pares de mediciones (idealmente 30 o más).'], pts };
            const d = pts.map(p => p.x - p.y), mm = pts.map(p => (p.x + p.y) / 2);
            const n = d.length, bias = S.mean(d), sd = S.sd(d);
            const tq = S.tInv(0.95, n - 1);
            const seB = sd / Math.sqrt(n), seL = sd * Math.sqrt(3 / n);
            const loa = [bias - 1.96 * sd, bias + 1.96 * sd];
            const pf = S.polyfit(mm, d, 1);
            const tStat = pf.coef[1] / pf.se[1];
            const pProp = 2 * (1 - S.tCdf(Math.abs(tStat), pf.df));
            const arms = S.rms(d);
            const tol = cfg.tolerance;
            const crit = profile.criterion || 'loa';
            const conform = crit === 'arms' ? arms <= tol : Math.abs(loa[0]) <= tol && Math.abs(loa[1]) <= tol;
            // ¿Cumpliría restando el sesgo (corrección de offset)?
            const conformOffset = crit === 'arms' ? sd * Math.sqrt((n - 1) / n) <= tol : 1.96 * sd <= tol;
            const fitXY = S.polyfit(pts.map(p => p.y), pts.map(p => p.x), 1);
            if (n < 30) warnings.push(`Con ${n} pares los límites de acuerdo son poco precisos (IC ± ${(tq * seL).toPrecision(2)} ${unitOf(cfg)}). Se recomiendan ≥ 30.`);
            if (pProp < 0.05) warnings.push(`Sesgo proporcional significativo (p = ${pProp.toPrecision(2)}): el error cambia con la magnitud medida.`);
            const yspan = Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y));
            if (profile.range && yspan < 0.3 * (profile.range[1] - profile.range[0]))
                warnings.push('Las mediciones cubren un rango estrecho: la concordancia solo está demostrada en ese rango.');
            return {
                ok: true, mode, warnings, pts, d, mm, fitXY, criterion: crit,
                metrics: { n, bias, sd, ciBias: [bias - tq * seB, bias + tq * seB], loa, ciLoa: tq * seL, propSlope: pf.coef[1], pProp, arms, conform, conformOffset, r: Math.sign(fitXY.coef[1]) * Math.sqrt(fitXY.r2) }
            };
        }

        /**
         * Tiempo de respuesta a partir de un CSV (columna de tiempo + columna de lectura).
         * τ se calcula sobre el MENSURANDO: si hay calibración se convierte la lectura con su ecuación,
         * porque en un sensor no lineal (NTC, LDR) un escalón de temperatura no es exponencial en ohm.
         */
        function timeResponse(text, cfg, fit) {
            const tb = CSV.parseTable(text);
            const tc = CSV.timeColumn(tb);
            if (!tc) throw new Error('El archivo necesita una columna de tiempo (t_ms, millis o t en segundos).');
            const vi = tb.keys.findIndex((k, i) => i !== tc.index);
            if (vi < 0) throw new Error('Falta la columna con la lectura del sensor.');
            const m = modes.find(q => q.id === cfg.readingMode) || modes[0];
            const x = tb.cols[vi].map(v => m.toX ? m.toX(v, cfg.modeParams, {}, cfg) : v);
            let yv = x, basis = 'lectura';
            if (fit) { yv = x.map(fit.predict); basis = 'calibrada'; }
            else if (profile.sameUnits) basis = 'directa';
            const r = Sig.firstOrderStep(tc.t, yv);
            const warnings = [];
            if (basis === 'lectura') warnings.push(`τ se calculó sobre la lectura cruda (${m.xUnit || m.unit || ''}). Si el sensor no es lineal, complete primero la calibración para calcularlo en ${unitOf(cfg)}.`);
            if (!r.settled) warnings.push('El registro termina antes de estabilizarse: el valor final se extrapoló. Registre al menos 5 τ después del escalón.');
            if (r.r2 < 0.98) warnings.push('La respuesta no es de primer orden (R² del ajuste < 0,98): puede haber dos constantes de tiempo (sensor + funda) o agitación irregular.');
            return { ...r, t: tc.t, y: yv, basis, column: tb.headers[vi], n: tb.n, warnings, unit: basis === 'lectura' ? (m.xUnit || m.unit) : unitOf(cfg) };
        }

        // ---------------- Datos de ejemplo ----------------
        function exampleData(cfg) {
            const ex = profile.example || {};
            let s = 17;
            const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
            const gauss = sd => sd * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
            const rows = buildPlan(cfg).map(st => {
                const row = { cycle: st.cycle, dir: st.dir, level: st.level, rep: st.rep };
                if (ex.extra) Object.assign(row, ex.extra(st, gauss, cfg));
                let yTrue;
                if (profile.refFromRow && !ex.refField) yTrue = profile.refFromRow(row, cfg).value;
                else { yTrue = (ex.levelToRef ? ex.levelToRef(st.level, cfg) : st.level) + gauss(ex.refJitter ?? 0); row.ref = +yTrue.toFixed(ex.refDecimals ?? 2); }
                const hyst = (ex.hyst || 0) * (st.dir === 'baja' ? -1 : 1) / 2;
                const truth = mode === 'comparacion' ? yTrue + (ex.bias || 0) + (ex.prop || 0) * (yTrue - (ex.center || 0)) + gauss(ex.sdDiff || 0) : yTrue;
                row.reading = +ex.forward(truth + hyst, cfg, row, gauss).toFixed(ex.decimals ?? 3);
                return row;
            });
            return { rows };
        }

        function exampleStep(cfg) {
            const ex = profile.example || {};
            const tau = ex.tau || 5, y0 = ex.stepFrom ?? 20, y1 = ex.stepTo ?? 0;
            let s = 5;
            const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
            const lines = ['t_ms,lectura'];
            for (let i = 0; i < 300; i++) {
                const t = i * tau / 25, yt = t < 3 ? y0 : y1 + (y0 - y1) * Math.exp(-(t - 3) / tau);
                const v = ex.forward(yt, cfg, {}, () => 0) + (ex.noise || 0) * (rnd() - 0.5);
                lines.push(`${Math.round(t * 1000)},${v.toFixed(4)}`);
            }
            return lines.join('\n');
        }

        return { profile, mode, defaultConfig, buildPlan, analyze, points, xOf, yOf, timeResponse, exampleData, exampleStep, levelLabel, modes, refs };
    }

    return { MODELS, fitModel, codeFor, create };
});
