/*
 * Modelo de validación de caudalímetros diferenciales: Venturi y tubo de Pitot.
 * Usa la ecuación de calibración del sensor de presión (módulo Presión) para obtener ΔP desde V.
 *
 * Venturi (Bernoulli + continuidad):
 *     Q_teo = A₂ · √( 2ΔP / (ρ (1 − β⁴)) ),   β = d/D,  A₂ = π d²/4
 *     C_d  = Q_ref / Q_teo                    (típico 0,95–0,99; menor a bajo Reynolds)
 * Pitot (presión dinámica):
 *     v_teo = √(2ΔP / ρ),   C = v_ref / v_teo  (≈ 1)
 * ρ es la densidad del FLUIDO que circula (aire ≈ 1,2 kg/m³), no la del agua del manómetro.
 */
(function (root, factory) {
    const req = n => (typeof require === 'function') ? require(n) : null;
    const S = req('../core/stats.js') || root.LabStats;
    const P = req('../core/physics.js') || root.LabPhys;
    const U = req('../core/uncertainty.js') || root.LabUnc;
    const Lin = req('../core/linalg.js') || root.LabLinalg;
    const m = factory(S, P, U, Lin);
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.FlujoModel = m;
})(typeof self !== 'undefined' ? self : this, function (S, P, U, Lin) {
    'use strict';

    function defaultConfig(device = 'venturi') {
        return {
            name: '', device,
            fluid: 'aire',
            env: { temp: 20, uTemp: 0.5, p_hPa: 1013, uP_hPa: 1, rh: 60 },
            D_mm: 25, d_mm: 12, uD_mm: 0.05,           // Venturi: entrada y garganta
            ductD_mm: 50, profile: 1,                   // Pitot: diámetro del ducto y v_ref/v_pitot
            pressureMode: 'diferencial',                // 'diferencial' | 'dos' (P1 y P2 con sensores separados)
            calA: null, calB: null,                     // calibraciones de presión (objetos exportados)
            refMode: device === 'pitot' ? 'velocidad' : 'volumen',
            uVol_pct: 1, uTime_s: 0.2, uRef_pct: 2,
            levels: [1, 2, 3, 4, 5, 6],
            reps: 3,
            notes: ''
        };
    }

    function buildPlan(cfg) {
        const plan = [];
        const refTxt = {
            volumen: 'mida volumen y tiempo (cronómetro) — mínimo 20 s por medición',
            caudal: 'lea el caudalímetro de referencia',
            velocidad: 'lea el anemómetro de referencia en el mismo punto que la punta del Pitot'
        }[cfg.refMode];
        cfg.levels.forEach(lv => {
            for (let r = 1; r <= cfg.reps; r++)
                plan.push({ level: lv, rep: r, action: `Posición de válvula/ventilador ${lv}, repetición ${r}: espere régimen estable (30 s), registre la salida del sensor y ${refTxt}.` });
        });
        return plan;
    }

    function calPressure(cal, V) {
        if (!cal) return { dP: NaN, u: NaN, out: false };
        const [c0, c1, c2] = cal.coef;
        const dP = c0 + c1 * V + c2 * V * V;
        const g = [1, V, V * V];
        let v = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) v += g[i] * ((cal.cov[i] || [])[j] || 0) * g[j];
        const u = Math.sqrt(cal.see ** 2 + Math.max(v, 0) + (dP * (cal.uSysRel || 0)) ** 2);
        const margin = 0.05 * (cal.Vmax - cal.Vmin);
        return { dP, u, out: V < cal.Vmin - margin || V > cal.Vmax + margin };
    }

    function fluidProps(cfg) {
        const t = cfg.env.temp;
        if (cfg.fluid === 'agua') {
            const rho = P.waterDensity(t);
            return { rho, mu: P.waterViscosity(t), uRhoRel: Math.abs(P.derivative(P.waterDensity, t)) * cfg.env.uTemp / rho, c: 1480 };
        }
        const rho = P.airDensity(t, cfg.env.p_hPa, cfg.env.rh);
        const uRhoRel = U.combine(cfg.env.uTemp / (t + 273.15), cfg.env.uP_hPa / cfg.env.p_hPa);
        return { rho, mu: P.airViscosity(t), uRhoRel, c: 331.3 * Math.sqrt(1 + t / 273.15) };
    }

    function refValue(cfg, r) {
        if (cfg.refMode === 'volumen') {
            const Q = (r.vol_L / 1000) / r.time_s; // m³/s
            const uRel = U.combine(cfg.uVol_pct / 100, cfg.uTime_s / r.time_s);
            return { Q, uRel };
        }
        if (cfg.refMode === 'caudal') return { Q: r.Q_Lmin / 60000, uRel: cfg.uRef_pct / 100 };
        return { v: r.v_ms, uRel: cfg.uRef_pct / 100 };
    }

    function analyze(cfg, rows) {
        const warnings = [];
        if (!cfg.calA) return { ok: false, warnings: ['Falta importar la calibración del sensor de presión (módulo Presión).'] };
        if (cfg.pressureMode === 'dos' && !cfg.calB) return { ok: false, warnings: ['Modo P₁ y P₂: falta la calibración del segundo sensor.'] };
        const fl = fluidProps(cfg);
        const isV = cfg.device === 'venturi';
        const D = cfg.D_mm / 1000, d = cfg.d_mm / 1000;
        const beta = d / D, A2 = Math.PI * d * d / 4, Aduct = Math.PI * (cfg.ductD_mm / 1000) ** 2 / 4;
        if (isV && !(beta > 0 && beta < 1)) return { ok: false, warnings: ['La garganta d debe ser menor que la entrada D.'] };
        let outOfRange = false;

        const pts = [];
        for (const r of rows) {
            let dP, uP;
            if (cfg.pressureMode === 'dos' && isV) {
                const a = calPressure(cfg.calA, r.V1), b = calPressure(cfg.calB, r.V2);
                dP = a.dP - b.dP; uP = U.combine(a.u, b.u); outOfRange ||= a.out || b.out;
            } else {
                const a = calPressure(cfg.calA, r.V); dP = a.dP; uP = a.u; outOfRange ||= a.out;
            }
            const ref = refValue(cfg, r);
            if (!isFinite(dP) || !(ref.Q > 0 || ref.v > 0)) continue;
            if (dP <= 0) { warnings.push(`Nivel ${r.level}: ΔP ≤ 0, punto descartado.`); continue; }

            if (isV) {
                const Qteo = A2 * Math.sqrt(2 * dP / (fl.rho * (1 - beta ** 4)));
                const Cd = ref.Q / Qteo;
                const Re = 4 * fl.rho * ref.Q / (Math.PI * d * fl.mu);
                const v2 = ref.Q / A2;
                const uRel = U.combine(ref.uRel, 0.5 * uP / dP, 0.5 * fl.uRhoRel, 2 * cfg.uD_mm / cfg.d_mm);
                pts.push({ ...r, dP, uP, Qref: ref.Q, Qteo, C: Cd, uC: Cd * uRel, Re, vThroat: v2, x: Qteo, y: ref.Q });
            } else {
                const vteo = Math.sqrt(2 * dP / fl.rho);
                const vref = ref.v ?? (ref.Q / Aduct) / cfg.profile;
                const C = vref / vteo;
                const Re = fl.rho * vref * (cfg.ductD_mm / 1000) / fl.mu;
                const uRel = U.combine(ref.uRel, 0.5 * uP / dP, 0.5 * fl.uRhoRel);
                pts.push({ ...r, dP, uP, vref, vteo, C, uC: C * uRel, Re, vThroat: vref, x: vteo, y: vref });
            }
        }
        if (pts.length < 3) return { ok: false, warnings: [...warnings, 'Se necesitan al menos 3 puntos válidos.'], pts };
        if (outOfRange) warnings.push('Algunas lecturas están FUERA del rango calibrado del sensor de presión: extrapolar no es confiable.');

        const fit = S.polyfit(pts.map(p => p.x), pts.map(p => p.y), 1, { origin: true });
        const C = fit.coef[1];
        const Cs = pts.map(p => p.C);
        const logRe = pts.map(p => Math.log10(p.Re));
        let reTrend = null;
        if (new Set(logRe.map(v => v.toFixed(2))).size >= 3) {
            // Mínimos cuadrados ponderados (w = 1/u²): los puntos de ΔP bajo, más inciertos, pesan menos.
            const w = pts.map(p => 1 / Math.max(p.uC, 1e-9) ** 2);
            const A = logRe.map((x, i) => [Math.sqrt(w[i]), Math.sqrt(w[i]) * x]);
            const b = Cs.map((c, i) => Math.sqrt(w[i]) * c);
            const sol = Lin.lstsq(A, b);
            const scale = Math.max(1, sol.s2); // si la dispersión supera lo esperado por u, se infla el error
            const se = Math.sqrt(sol.AtAinv[1][1] * scale);
            const slope = sol.x[1];
            reTrend = { slope, se, intercept: sol.x[0], chi2red: sol.s2, significant: Math.abs(slope / se) > S.tInv(0.95, sol.df) };
            if (reTrend.significant) warnings.push(`El coeficiente depende del Reynolds (pendiente ${slope.toFixed(3)} ± ${se.toFixed(3)} por década): use C(Re) o limite el rango de uso.`);
        }
        const uCmean = S.rms(pts.map(p => p.uC));
        const U_C = U.expanded(U.combine(S.sd(Cs), uCmean));
        const machMax = Math.max(...pts.map(p => p.vThroat)) / fl.c;
        if (cfg.fluid === 'aire' && machMax > 0.3) warnings.push(`Mach ${machMax.toFixed(2)} > 0,3 en la garganta: la hipótesis incompresible deja de ser válida.`);
        if (isV && (C > 1.02 || C < 0.85)) warnings.push(`C_d = ${C.toFixed(3)} fuera de lo físicamente esperable (0,85–1,0): revise diámetros, fugas, la calibración de presión o la referencia de caudal.`);
        if (!isV && Math.abs(C - 1) > 0.1) warnings.push(`C = ${C.toFixed(3)} se aleja de 1: revise la alineación del Pitot con el flujo y el punto de medición de la referencia.`);

        // Constante práctica: Q[L/min] = K·√ΔP[Pa]  |  v[m/s] = K·√ΔP[Pa]
        const K = isV ? C * A2 * Math.sqrt(2 / (fl.rho * (1 - beta ** 4))) * 60000 : C * Math.sqrt(2 / fl.rho);

        return {
            ok: true, warnings, pts, fit, reTrend, fluid: fl,
            metrics: { C, seC: fit.se[1], Cmean: S.mean(Cs), Csd: S.sd(Cs), U_C, K, beta, A2, Remin: Math.min(...pts.map(p => p.Re)), Remax: Math.max(...pts.map(p => p.Re)), machMax }
        };
    }

    function exampleData(cfg, seed = 11) {
        let s = seed;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const gauss = sd => sd * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
        const cal = { coef: [-444.4, 2222.2, 0], cov: [[4, -1, 0], [-1, 1, 0], [0, 0, 0]], see: 8, uSysRel: 0.001, Vmin: 0.2, Vmax: 4.7 };
        const fl = fluidProps(cfg);
        const Ctrue = cfg.device === 'venturi' ? 0.965 : 0.99;
        const D = cfg.D_mm / 1000, d = cfg.d_mm / 1000, beta = d / D, A2 = Math.PI * d * d / 4;
        const rows = buildPlan(cfg).map(st => {
            const dP = 150 * st.level ** 1.6;
            const V = +((dP - cal.coef[0]) / cal.coef[1] + gauss(0.003)).toFixed(3);
            if (cfg.device === 'venturi') {
                const Q = Ctrue * A2 * Math.sqrt(2 * dP / (fl.rho * (1 - beta ** 4)));
                const t = 30 + gauss(0.15);
                return { level: st.level, rep: st.rep, V, vol_L: +(Q * t * 1000 * (1 + gauss(0.01))).toFixed(2), time_s: +t.toFixed(2), Q_Lmin: +(Q * 60000).toFixed(2) };
            }
            const v = Ctrue * Math.sqrt(2 * dP / fl.rho);
            return { level: st.level, rep: st.rep, V, v_ms: +(v * (1 + gauss(0.01))).toFixed(2) };
        });
        return { rows, cal: { type: 'calibracion-presion', name: 'Ejemplo MPX5010DP', sensor: 'MPX5010DP', outputUnit: 'V', ...cal } };
    }

    return { defaultConfig, buildPlan, calPressure, fluidProps, analyze, exampleData };
});
