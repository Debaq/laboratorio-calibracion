/*
 * Modelo de calibración del posturógrafo IMU.
 *
 * Referencia angular (θ_ref) a partir de la geometría, con propagación de incertidumbre:
 *   - 'seno'    : desplazamiento horizontal d medido a distancia L del pivote → θ = asin(d / L)
 *   - 'cuerda'  : cuerda c recorrida a radio r (giros en yaw)                → θ = 2·asin(c / 2r)
 *   - 'directo' : ángulo leído en inclinómetro / transportador / goniómetro
 *
 * Flexión de la barra (opcional, solo pitch/roll): la barra es un voladizo con masa m en la punta.
 * Al inclinarse θ, la componente F⊥ = m·g·sinθ la curva:
 *   δ(x) = F⊥ x² (3L − x) / (6EI)      φ(x) = F⊥ x (2L − x) / (2EI)
 * El IMU (a distancia x_s del pivote) ve θ + φ(x_s). Si d se midió en la punta, d incluye δ.
 *
 * Lectura del IMU: Δ = lectura − cero del ciclo (el cero elimina el offset de montaje).
 * Modelo de error: Δ_eje = a + b·θ_esperado (b = ganancia, a = offset). Ejes secundarios:
 * Δ_sec = a' + c·θ_esperado  → c = acoplamiento (crosstalk) en °/°.
 */
(function (root, factory) {
    const req = n => (typeof require === 'function') ? require(n) : null;
    const S = req('../core/stats.js') || root.LabStats;
    const P = req('../core/physics.js') || root.LabPhys;
    const U = req('../core/uncertainty.js') || root.LabUnc;
    const Lin = req('../core/linalg.js') || root.LabLinalg;
    const m = factory(S, P, U, Lin);
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.ImuModel = m;
})(typeof self !== 'undefined' ? self : this, function (S, P, U, Lin) {
    'use strict';

    const AXES = ['pitch', 'roll', 'yaw'];
    /**
     * Ejes que entrega cada tipo de sensor:
     *  acc3 (acelerómetro solo) e incl (inclinómetro): pitch y roll — la gravedad no "ve" giros horizontales.
     *  imu6 (acel + giro): los tres, pero yaw es relativo y deriva.  imu9: los tres absolutos.
     */
    const DOF = {
        acc3: { label: 'Acelerómetro 3 DOF (inclinación por gravedad)', axes: ['pitch', 'roll'] },
        incl: { label: 'Inclinómetro (1–2 ejes)', axes: ['pitch', 'roll'] },
        imu6: { label: 'IMU 6 DOF (acelerómetro + giroscopio)', axes: AXES },
        imu9: { label: 'IMU 9 DOF (+ magnetómetro) / BNO055', axes: AXES }
    };
    const axesFor = cfg => (DOF[(cfg.sensor || {}).dof] || DOF.imu9).axes;
    const DEG = P.DEG;

    /** Diferencia angular envuelta a (−180, 180]. Necesaria para yaw (heading 0–360°). */
    function wrapDeg(d) {
        let x = ((d + 180) % 360 + 360) % 360 - 180;
        return x === -180 ? 180 : x;
    }

    function defaultConfig() {
        return {
            name: '',
            sensor: { model: 'BNO055', maker: 'Bosch', dof: 'imu9', mode: 'NDOF', notes: '' },
            axis: 'pitch',
            refMethod: 'seno',
            L_mm: 1000,       // pivote → punto donde se mide d
            r_mm: 300,        // radio para método de cuerda
            uL_mm: 1,         // incertidumbre de L (o r)
            resRef: 1,        // resolución de la referencia (mm o °)
            resImu: 0.0625,   // resolución de salida del IMU (BNO055 Euler: 1/16 °)
            levels: [-150, -100, -50, 50, 100, 150],
            cycles: 3,
            bidirectional: true,
            tolerance_deg: 1,
            flex: { enabled: false, tipMass_g: 0, EI_Nm2: 0, barLength_mm: 1000, sensorPos_mm: 950, dAtTip: true },
            env: { lat: -39.81, alt: 10, temp: 20 },
            notes: ''
        };
    }

    // ---------------- Plan de medición ----------------
    /**
     * Genera la secuencia de acciones: por ciclo → cero inicial, niveles subiendo,
     * (niveles bajando), cero final. Los niveles se ordenan de menor a mayor.
     */
    function buildPlan(cfg) {
        const lv = [...cfg.levels].filter(v => v !== 0).sort((a, b) => a - b);
        const unit = cfg.refMethod === 'directo' ? '°' : 'mm';
        const what = { seno: 'desplazamiento d', cuerda: 'cuerda c', directo: 'ángulo de referencia' }[cfg.refMethod];
        const plan = [];
        for (let c = 1; c <= cfg.cycles; c++) {
            plan.push({ cycle: c, dir: 'cero', ref: 0, action: `Ciclo ${c}: lleve el sistema a la posición neutra (0) y registre el CERO inicial.` });
            lv.forEach(v => plan.push({ cycle: c, dir: 'sube', ref: v, action: `Ciclo ${c} ↑: ${what} = ${v} ${unit}. Mueva siempre en el mismo sentido (sin pasarse y volver).` }));
            if (cfg.bidirectional)
                [...lv].reverse().forEach(v => plan.push({ cycle: c, dir: 'baja', ref: v, action: `Ciclo ${c} ↓: ${what} = ${v} ${unit}, llegando desde arriba (sentido descendente).` }));
            plan.push({ cycle: c, dir: 'cero', ref: 0, action: `Ciclo ${c}: vuelva a 0 y registre el CERO final (permite medir la deriva).` });
        }
        return plan;
    }

    // ---------------- Referencia angular ----------------
    function referenceAngle(cfg, value) {
        const L = cfg.L_mm, r = cfg.r_mm;
        if (cfg.refMethod === 'directo') return { theta: value, u: U.fromResolution(cfg.resRef) };
        if (cfg.refMethod === 'cuerda') {
            const s = value / (2 * r);
            if (Math.abs(s) >= 1) return { theta: NaN, u: NaN, error: 'La cuerda supera el diámetro' };
            const th = 2 * Math.asin(s);
            const uc = Math.SQRT2 * U.fromResolution(cfg.resRef); // cuerda = diferencia de dos lecturas
            const dThdc = 1 / (r * Math.cos(th / 2));
            const dThdr = -2 * Math.tan(th / 2) / r;
            return { theta: th / DEG, u: U.combine(dThdc * uc, dThdr * cfg.uL_mm) / DEG };
        }
        // seno
        const s = value / L;
        if (Math.abs(s) >= 1) return { theta: NaN, u: NaN, error: 'd supera L' };
        const th = Math.asin(s);
        const ud = Math.SQRT2 * U.fromResolution(cfg.resRef); // d = posición − posición en cero
        const dThdd = 1 / (L * Math.cos(th));
        const dThdL = -Math.tan(th) / L;
        return { theta: th / DEG, u: U.combine(dThdd * ud, dThdL * cfg.uL_mm) / DEG };
    }

    /**
     * Ángulo que DEBERÍA ver el IMU, considerando flexión.
     * Devuelve θ_pivote (rotación rígida), φ (giro extra por flexión) y θ_esperado = θ_pivote + φ.
     */
    function expectedAngle(cfg, value) {
        const ref = referenceAngle(cfg, value);
        const f = cfg.flex || {};
        const flexOn = f.enabled && cfg.axis !== 'yaw' && f.EI_Nm2 > 0 && f.tipMass_g > 0;
        if (!flexOn || !isFinite(ref.theta)) return { ...ref, thetaPivot: ref.theta, phi: 0, thetaExp: ref.theta };

        const g = P.gLocal(cfg.env.lat, cfg.env.alt);
        const m = f.tipMass_g / 1000, Lb = f.barLength_mm / 1000, xs = f.sensorPos_mm / 1000, EI = f.EI_Nm2;
        let th = ref.theta * DEG;

        if (cfg.refMethod === 'seno' && f.dAtTip) {
            // d = L sinθ + δ(L)·cosθ  → iteración de punto fijo
            const L = cfg.L_mm / 1000, d = value / 1000;
            for (let i = 0; i < 50; i++) {
                const F = m * g * Math.sin(th);
                const delta = P.cantileverDeflection(F, Lb, Math.min(L, Lb), EI);
                const next = Math.asin(Math.max(-1, Math.min(1, (d - delta * Math.cos(th)) / L)));
                if (Math.abs(next - th) < 1e-12) { th = next; break; }
                th = next;
            }
        }
        const F = m * g * Math.sin(th);
        const phi = P.cantileverSlope(F, Lb, xs, EI);
        return { ...ref, thetaPivot: th / DEG, phi: phi / DEG, thetaExp: (th + phi) / DEG };
    }

    // ---------------- Análisis ----------------
    function baselines(rows, AXES) {
        const byCycle = S.groupBy(rows.filter(r => r.dir === 'cero'), r => r.cycle);
        const all = rows.filter(r => r.dir === 'cero');
        const base = {}, drift = [];
        const avg = list => Object.fromEntries(AXES.map(a => [a, S.mean(list.map(r => r[a]))]));
        const global = all.length ? avg(all) : { pitch: 0, roll: 0, yaw: 0 };
        const cycles = [...new Set(rows.map(r => r.cycle))];
        for (const c of cycles) {
            const z = byCycle.get(c);
            base[c] = z && z.length ? avg(z) : global;
            if (z && z.length >= 2) {
                drift.push({ cycle: c, ...Object.fromEntries(AXES.map(a => [a, wrapDeg(z[z.length - 1][a] - z[0][a])])) });
            }
        }
        return { base, drift, hasZeros: all.length > 0 };
    }

    function analyze(cfg, rows) {
        const warnings = [];
        const AXES = axesFor(cfg);
        if (!AXES.includes(cfg.axis)) return { ok: false, warnings: [`Un ${DOF[cfg.sensor.dof].label} no mide ${cfg.axis}: la gravedad no cambia al girar en horizontal.`] };
        const valid = rows.filter(r => AXES.every(a => isFinite(r[a])) && isFinite(r.ref));
        const { base, drift, hasZeros } = baselines(valid, AXES);
        if (!hasZeros) warnings.push('No hay lecturas de CERO: los offsets de montaje quedan mezclados con el error.');

        const pts = valid.filter(r => r.dir !== 'cero').map(r => {
            const e = expectedAngle(cfg, r.ref);
            const b = base[r.cycle];
            const delta = Object.fromEntries(AXES.map(a => [a, wrapDeg(r[a] - b[a])]));
            return { ...r, ...e, delta, err: delta[cfg.axis] - e.thetaExp };
        }).filter(p => isFinite(p.thetaExp));

        if (pts.length < 3) return { ok: false, warnings: [...warnings, 'Se necesitan al menos 3 mediciones fuera del cero.'], pts };

        const x = pts.map(p => p.thetaExp);
        const y = pts.map(p => p.delta[cfg.axis]);
        const fit = S.polyfit(x, y, 1);
        const errs = pts.map(p => p.err);

        // Repetibilidad (grupos de mismo nivel y sentido) e histéresis (sube vs baja)
        const groups = S.groupBy(pts, p => `${p.ref}|${p.dir}`);
        const rep = S.pooledSD([...groups.values()].map(g => g.map(p => p.delta[cfg.axis])));
        const levels = [...new Set(pts.map(p => p.ref))].sort((a, b) => a - b);
        const perLevel = levels.map(v => {
            const up = pts.filter(p => p.ref === v && p.dir === 'sube');
            const dn = pts.filter(p => p.ref === v && p.dir === 'baja');
            const all = pts.filter(p => p.ref === v);
            const mUp = S.mean(up.map(p => p.delta[cfg.axis])), mDn = S.mean(dn.map(p => p.delta[cfg.axis]));
            return {
                ref: v, thetaExp: all[0].thetaExp, uRef: all[0].u, n: all.length,
                meanImu: S.mean(all.map(p => p.delta[cfg.axis])), sd: S.sd(all.map(p => p.delta[cfg.axis])),
                bias: S.mean(all.map(p => p.err)),
                hyst: (up.length && dn.length) ? mUp - mDn : NaN
            };
        });
        const hystMax = Math.max(0, ...perLevel.map(l => Math.abs(l.hyst)).filter(isFinite));

        // Acoplamiento en ejes secundarios
        const crosstalk = AXES.filter(a => a !== cfg.axis).map(a => {
            const f = S.polyfit(x, pts.map(p => p.delta[a]), 1);
            return { axis: a, slope: f.coef[1], seSlope: f.se[1], offset: f.coef[0], see: f.see, angle: Math.atan(f.coef[1]) / DEG, maxAbs: S.maxAbs(pts.map(p => p.delta[a])) };
        });

        // Incertidumbres
        const uRefMean = S.rms(pts.map(p => p.u));
        const uResImu = U.fromResolution(cfg.resImu);
        const rmse = S.rms(errs);
        const U_raw = U.expanded(U.combine(rmse, uRefMean, uResImu));
        const U_corr = U.expanded(U.combine(fit.see, uRefMean, uResImu));
        const TUR = cfg.tolerance_deg / U.expanded(uRefMean);
        const maxErr = S.maxAbs(errs);
        const conform = maxErr + U.expanded(uRefMean) <= cfg.tolerance_deg;

        if (TUR < 4) warnings.push(`La referencia es poco exacta frente a la tolerancia (TUR = ${TUR.toFixed(1)} < 4). Mejore la resolución de la referencia o aumente L.`);
        if (Math.abs(fit.coef[1] - 1) > 3 * fit.se[1] && Math.abs(fit.coef[1] - 1) > 0.01)
            warnings.push(`La ganancia (${fit.coef[1].toFixed(4)}) difiere significativamente de 1: conviene corregir la escala.`);
        crosstalk.forEach(c => {
            if (Math.abs(c.slope) > 0.02) warnings.push(`Acoplamiento ${c.axis.toUpperCase()} = ${(c.slope * 100).toFixed(1)} % (≈ ${c.angle.toFixed(1)}° de desalineación). Revise el montaje del sensor.`);
        });
        drift.forEach(d => {
            if (Math.abs(d[cfg.axis]) > 0.5) warnings.push(`Deriva del cero en ciclo ${d.cycle}: ${d[cfg.axis].toFixed(2)}° en ${cfg.axis}.`);
        });
        if (cfg.axis === 'yaw' && cfg.sensor.dof === 'imu6')
            warnings.push('Yaw de una IMU 6 DOF es la integral del giroscopio: deriva con el tiempo. Haga ciclos cortos y compare los ceros inicial y final.');
        if (cfg.axis === 'yaw' && cfg.sensor.mode === 'NDOF')
            warnings.push('Yaw en modo NDOF depende del magnetómetro: evite metales cercanos o use modo IMU (sin magnetómetro) para giros relativos.');

        return {
            ok: true, warnings, pts, fit, perLevel, crosstalk, drift,
            metrics: {
                gain: fit.coef[1], seGain: fit.se[1], offset: fit.coef[0], seOffset: fit.se[0], see: fit.see, r2: fit.r2,
                bias: S.mean(errs), sdErr: S.sd(errs), rmse, maxErr,
                linearity: S.maxAbs(fit.residuals),
                repeatability: rep.s, hysteresis: hystMax,
                uRef: uRefMean, U_raw, U_corr, TUR, conform
            }
        };
    }

    /** Corrección inversa a aplicar en el posturógrafo: θ_corregido = (Δ − a) / b. */
    function correctionFormula(res, axis) {
        const a = res.metrics.offset, b = res.metrics.gain;
        return `θ_${axis} = (Δ_${axis} − (${a.toFixed(4)})) / ${b.toFixed(5)}`;
    }

    // ---------------- Análisis multi-eje ----------------
    /**
     * Combina experimentos de ejes distintos en la matriz de sensibilidad A (3×3):
     *   Δ = A·θ + a  →  A[i][j] = pendiente de Δ_i frente a estímulo en eje j.
     * La corrección es θ = A⁻¹ (Δ − a). Ejes sin experimento quedan con columna identidad.
     */
    function multiAxis(results) {
        const A = Lin.identity(3);
        const offs = [[], [], []];
        const have = [false, false, false];
        for (const { axis, res } of results) {
            const j = AXES.indexOf(axis);
            have[j] = true;
            A[j][j] = res.metrics.gain;
            offs[j].push(res.metrics.offset);
            res.crosstalk.forEach(c => {
                const i = AXES.indexOf(c.axis);
                A[i][j] = c.slope;
                offs[i].push(c.offset);
            });
        }
        let C = null, error = null;
        try { C = Lin.inv(A); } catch (e) { error = e.message; }
        const offset = offs.map(o => o.length ? S.mean(o) : 0);
        // Desalineación aproximada entre pares de ejes (parte antisimétrica) y no ortogonalidad (simétrica)
        const pairs = [[0, 1], [0, 2], [1, 2]].map(([i, j]) => ({
            pair: `${AXES[i]}–${AXES[j]}`,
            rotation: Math.atan((A[i][j] - A[j][i]) / 2) / DEG,
            skew: Math.atan((A[i][j] + A[j][i]) / 2) / DEG,
            complete: have[i] && have[j]
        }));
        return { A, C, offset, have, pairs, error, axes: AXES };
    }

    // ---------------- Caracterización de flexión (ensayo 3 puntos) ----------------
    /**
     * Barra biapoyada de luz Ls, carga en a. Filas: { mass_g, reading_mm } (altura o lectura de comparador).
     * δ = lectura(m=0) − lectura(m) (positiva hacia abajo). Ajuste δ = δ0 + c·F → EI = a²b² / (3·Ls·c).
     */
    function flexion(cfg, rows) {
        const g = P.gLocal(cfg.lat ?? -39.81, cfg.alt ?? 0);
        const Ls = cfg.span_mm / 1000, a = cfg.loadPos_mm / 1000;
        const pts = rows.filter(r => isFinite(r.mass_g) && isFinite(r.reading_mm));
        const zeros = pts.filter(r => r.mass_g === 0);
        if (!zeros.length) return { ok: false, error: 'Falta la lectura sin carga (masa = 0).' };
        if (pts.filter(r => r.mass_g > 0).length < 2) return { ok: false, error: 'Se necesitan al menos 2 cargas distintas de cero.' };
        if (!(a > 0 && a < Ls)) return { ok: false, error: 'La posición de la carga debe estar entre los apoyos.' };
        const r0 = S.mean(zeros.map(r => r.reading_mm));
        const F = pts.map(r => r.mass_g / 1000 * g);
        const delta = pts.map(r => (r0 - r.reading_mm) / 1000 * (cfg.readingIncreases ? -1 : 1));
        const fit = S.polyfit(F, delta, 1);
        const c = fit.coef[1];
        if (!(c > 0)) return { ok: false, error: 'La flecha no aumenta con la carga: revise el signo de las lecturas.' };
        const geo = P.simplySupportedCompliance(a, Ls);
        const EI = geo / c;
        const uEI = EI * fit.se[1] / c;
        return { ok: true, EI, uEI, compliance: c, fit, F, delta, g };
    }

    // ---------------- Datos de ejemplo (sintéticos, parámetros conocidos) ----------------
    function exampleData(cfg, seed = 1) {
        let s = seed;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const gauss = (sd) => sd * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
        const truth = { gain: 1.02, offset: 0.15, cross: { pitch: 0, roll: 0.03, yaw: -0.01 }, mount: { pitch: 1.2, roll: -0.8, yaw: 87.0 }, noise: 0.08, hyst: 0.1 };
        truth.cross[cfg.axis] = 0;
        const rows = buildPlan(cfg).map(step => {
            const e = expectedAngle(cfg, step.ref);
            const th = step.dir === 'cero' ? 0 : e.thetaExp;
            const r = { cycle: step.cycle, dir: step.dir, ref: step.ref };
            axesFor(cfg).forEach(a => {
                let v = truth.mount[a] + gauss(truth.noise);
                if (a === cfg.axis) v += truth.offset * (th !== 0) + truth.gain * th + (step.dir === 'baja' ? -truth.hyst : step.dir === 'sube' ? truth.hyst : 0) / 2;
                else v += truth.cross[a] * th;
                r[a] = +(a === 'yaw' ? ((v % 360) + 360) % 360 : v).toFixed(2);
            });
            return r;
        });
        return { rows, truth };
    }

    return { AXES, DOF, axesFor, wrapDeg, defaultConfig, buildPlan, referenceAngle, expectedAngle, analyze, correctionFormula, multiAxis, flexion, exampleData };
});
