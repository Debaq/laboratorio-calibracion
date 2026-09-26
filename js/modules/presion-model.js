/*
 * Modelo de calibración de sensores de presión diferencial con manómetro de agua.
 *
 * Referencia (tubo en U):  ΔP = (ρ_agua(T) − ρ_aire) · g_local · Δh,   Δh = h_abierta − h_presurizada
 * Referencia (columna con estanque grande): Δh = h − h0.
 * El sensor debe ver AIRE (no agua) en su puerto: la altura del sensor no influye.
 *
 * Calibración directa en el sentido de uso:  ΔP = c0 + c1·V (+ c2·V²)
 * Se elige grado 2 solo si la prueba F lo justifica (p < 0,05).
 */
(function (root, factory) {
    const req = n => (typeof require === 'function') ? require(n) : null;
    const S = req('../core/stats.js') || root.LabStats;
    const P = req('../core/physics.js') || root.LabPhys;
    const U = req('../core/uncertainty.js') || root.LabUnc;
    const m = factory(S, P, U);
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.PresionModel = m;
})(typeof self !== 'undefined' ? self : this, function (S, P, U) {
    'use strict';

    function defaultConfig() {
        return {
            name: '',
            sensor: { model: 'MPX5010DP', maker: 'NXP', outputUnit: 'V', FS_Pa: 10000, notes: '' },
            mode: 'U',
            h0_mm: 0,
            resRuler_mm: 1,
            water: { temp: 20, uTemp: 0.5 },
            env: { lat: -39.81, alt: 10, p_hPa: 1013, rh: 60 },
            degree: 'auto',
            levels: [100, 200, 300, 400, 500, 600],
            cycles: 3,
            bidirectional: true,
            tol_pctFS: 1,
            notes: ''
        };
    }

    function buildPlan(cfg) {
        const lv = [...cfg.levels].filter(v => v !== 0).sort((a, b) => a - b);
        const plan = [];
        const how = cfg.mode === 'U' ? 'diferencia entre meniscos Δh' : 'altura sobre el nivel cero';
        for (let c = 1; c <= cfg.cycles; c++) {
            plan.push({ cycle: c, dir: 'cero', level: 0, action: `Ciclo ${c}: ambos lados abiertos a la atmósfera (Δh = 0). Registre meniscos y salida del sensor.` });
            lv.forEach(v => plan.push({ cycle: c, dir: 'sube', level: v, action: `Ciclo ${c} ↑: con la jeringa, lleve la ${how} a ≈ ${v} mm. Cierre la llave, espere 10 s, lea meniscos (parte baja) y sensor.` }));
            if (cfg.bidirectional)
                [...lv].reverse().forEach(v => plan.push({ cycle: c, dir: 'baja', level: v, action: `Ciclo ${c} ↓: libere aire lentamente hasta ≈ ${v} mm (sin pasarse). Espere 10 s y registre.` }));
            plan.push({ cycle: c, dir: 'cero', level: 0, action: `Ciclo ${c}: abra a la atmósfera y registre el cero final.` });
        }
        return plan;
    }

    /** Presión de referencia y su incertidumbre para una fila. */
    function reference(cfg, r) {
        const g = P.gLocal(cfg.env.lat, cfg.env.alt);
        const rhoW = P.waterDensity(cfg.water.temp);
        const rhoA = P.airDensity(cfg.env.temp ?? cfg.water.temp, cfg.env.p_hPa, cfg.env.rh);
        const drho = rhoW - rhoA;
        const dh_mm = cfg.mode === 'U' ? r.hB - r.hA : r.h - cfg.h0_mm;
        const dh = dh_mm / 1000;
        const dP = drho * g * dh;
        const uDh = Math.SQRT2 * U.fromResolution(cfg.resRuler_mm) / 1000; // dos lecturas
        const uRhoRel = Math.abs(P.derivative(P.waterDensity, cfg.water.temp)) * cfg.water.uTemp / rhoW;
        return { dh_mm, dP, uRand: drho * g * uDh, uSysRel: uRhoRel, g, rhoW, rhoA };
    }

    function analyze(cfg, rows) {
        const warnings = [];
        const valid = rows.filter(r => isFinite(r.V) && (cfg.mode === 'U' ? isFinite(r.hA) && isFinite(r.hB) : isFinite(r.h)));
        const pts = valid.map(r => ({ ...r, ...reference(cfg, r) }));
        if (pts.length < 4) return { ok: false, warnings: ['Se necesitan al menos 4 puntos (incluyendo el cero).'], pts };

        const V = pts.map(p => p.V), dP = pts.map(p => p.dP);
        const f1 = S.polyfit(V, dP, 1);
        let f2 = null, ftest = { F: NaN, p: NaN };
        if (pts.length >= 5) { f2 = S.polyfit(V, dP, 2); ftest = S.fTestNested(f1, f2); }
        let fit = f1;
        if (cfg.degree === 2 && f2) fit = f2;
        else if (cfg.degree === 'auto' && f2 && ftest.p < 0.05) fit = f2;

        const FS = cfg.sensor.FS_Pa > 0 ? cfg.sensor.FS_Pa : Math.max(...dP.map(Math.abs));
        const span = Math.max(...dP) - Math.min(...dP);
        const res1 = f1.residuals;
        pts.forEach((p, i) => { p.res = fit.residuals[i]; p.resLin = res1[i]; });

        const groups = S.groupBy(pts, p => `${p.level}|${p.dir}`);
        const rep = S.pooledSD([...groups.values()].map(g => g.map(p => p.res)));
        const hyst = [];
        for (const lv of new Set(pts.filter(p => p.dir !== 'cero').map(p => p.level))) {
            const up = pts.filter(p => p.level === lv && p.dir === 'sube'), dn = pts.filter(p => p.level === lv && p.dir === 'baja');
            if (up.length && dn.length) hyst.push({ level: lv, diff: S.mean(up.map(p => p.res)) - S.mean(dn.map(p => p.res)) });
        }
        const hystMax = hyst.length ? S.maxAbs(hyst.map(h => h.diff)) : NaN;

        const Vmin = Math.min(...V), Vmax = Math.max(...V);
        const uAt = v => {
            const p = fit.predict(v);
            return Math.sqrt(fit.uPred(v) ** 2 + (p * pts[0].uSysRel) ** 2);
        };
        const Vfs = Math.abs(fit.predict(Vmax)) >= Math.abs(fit.predict(Vmin)) ? Vmax : Vmin;
        const U_fs = U.expanded(uAt(Vfs));
        const zeroV = fit.deg === 1 ? -fit.coef[0] / fit.coef[1] : solveZero(fit, Vmin, Vmax);
        const sens = 1 / f1.coef[1]; // V/Pa
        const conform = 100 * (S.maxAbs(fit.residuals) + U_fs) / FS <= cfg.tol_pctFS;

        if (span < 0.3 * FS) warnings.push(`Solo se cubrió el ${(100 * span / FS).toFixed(0)} % del fondo de escala: la calibración NO es válida fuera de ${Math.min(...dP).toFixed(0)}–${Math.max(...dP).toFixed(0)} Pa.`);
        if (dP.some(v => v < -0.02 * FS)) warnings.push('Hay presiones negativas: verifique qué rama es la presurizada (hA) y cuál la abierta (hB).');
        if (fit.deg === 2) warnings.push(`El ajuste cuadrático es significativamente mejor (p = ${ftest.p.toExponential(1)}): el sensor no es lineal en este rango.`);
        if (f1.r2 < 0.999) warnings.push('R² < 0,999: revise fugas, burbujas en la manguera o lecturas del menisco con paralaje.');

        return {
            ok: true, warnings, pts, fit, f1, f2, ftest, hyst,
            metrics: {
                deg: fit.deg, coef: fit.coef, se: fit.se, see: fit.see, r2: fit.r2,
                FS, span, linPctFS: 100 * S.maxAbs(res1) / FS, repeat: rep.s, hyst: hystMax,
                hystPctFS: 100 * hystMax / FS, U_fs, U_pctFS: 100 * U_fs / FS,
                zeroV, sens_mV_kPa: sens * 1e6, Vmin, Vmax, conform,
                rhoW: pts[0].rhoW, rhoA: pts[0].rhoA, g: pts[0].g
            },
            uAt
        };
    }

    function solveZero(fit, lo, hi) {
        const [c0, c1, c2] = fit.coef;
        const disc = c1 * c1 - 4 * c2 * c0;
        if (disc < 0) return NaN;
        const r = [(-c1 + Math.sqrt(disc)) / (2 * c2), (-c1 - Math.sqrt(disc)) / (2 * c2)];
        const mid = (lo + hi) / 2;
        return r.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[0];
    }

    /** Objeto portable para usar en Venturi/Pitot u otros sistemas. */
    function exportCalibration(cfg, res, id) {
        return {
            type: 'calibracion-presion', version: 1, id: id ?? null,
            name: cfg.name, sensor: cfg.sensor.model, outputUnit: cfg.sensor.outputUnit,
            equation: 'ΔP[Pa] = c0 + c1·V + c2·V²',
            coef: [res.metrics.coef[0], res.metrics.coef[1], res.metrics.coef[2] ?? 0],
            cov: res.fit.cov, see: res.fit.see, uSysRel: res.pts[0].uSysRel,
            Vmin: res.metrics.Vmin, Vmax: res.metrics.Vmax, U_fs: res.metrics.U_fs,
            date: new Date().toISOString()
        };
    }

    function exampleData(cfg, seed = 3) {
        let s = seed;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const gauss = sd => sd * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
        // Sensor tipo MPX5010DP: V = 0,2 + 0,45 V/kPa · ΔP (a 5 V)
        const truth = { V0: 0.2, sens: 0.45e-3, noise: 0.004 };
        const rows = buildPlan(cfg).map(st => {
            const base = 120;
            const dh = st.level + gauss(3);
            const hA = +(base - dh / 2).toFixed(0), hB = +(base + dh / 2).toFixed(0);
            const ref = reference(cfg, { hA, hB, h: 0 });
            const hyst = st.dir === 'baja' ? -0.003 : 0;
            return { cycle: st.cycle, dir: st.dir, level: st.level, hA, hB, V: +(truth.V0 + truth.sens * ref.dP + hyst + gauss(truth.noise)).toFixed(3) };
        });
        return { rows, truth };
    }

    return { defaultConfig, buildPlan, reference, analyze, exportCalibration, exampleData };
});
