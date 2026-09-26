/*
 * Modelo de calibración del posturógrafo de balanza (plataforma con 4 celdas de carga + HX711).
 *
 * Cada celda i entrega cuentas crudas r_i. Tras la tara (plataforma vacía, r0_i):
 *      F_i = k_i · (r_i − r0_i)            k_i en N/cuenta
 * Con una masa M apoyada en (x, y) la estática exige:
 *      Σ F_i        = M g
 *      Σ F_i · x_i  = M g x
 *      Σ F_i · y_i  = M g y
 * Cada carga aporta 3 ecuaciones lineales en k_1..k_4 → mínimos cuadrados con todas las cargas.
 * Luego:  Fz = Σ F_i,   CoP_x = Σ F_i x_i / Fz,   CoP_y = Σ F_i y_i / Fz.
 */
(function (root, factory) {
    const req = n => (typeof require === 'function') ? require(n) : null;
    const S = req('../core/stats.js') || root.LabStats;
    const P = req('../core/physics.js') || root.LabPhys;
    const U = req('../core/uncertainty.js') || root.LabUnc;
    const Lin = req('../core/linalg.js') || root.LabLinalg;
    const m = factory(S, P, U, Lin);
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.BalanzaModel = m;
})(typeof self !== 'undefined' ? self : this, function (S, P, U, Lin) {
    'use strict';

    const NC = 4;

    function defaultConfig() {
        return {
            name: '',
            sensor: { model: 'Celda de carga 50 kg ×4', maker: '', adc: 'HX711 (ganancia 128)', notes: '' },
            cells: [
                { name: 'C1 delantera izq.', x: -180, y: 180 },
                { name: 'C2 delantera der.', x: 180, y: 180 },
                { name: 'C3 trasera der.', x: 180, y: -180 },
                { name: 'C4 trasera izq.', x: -180, y: -180 }
            ],
            masses_kg: [10, 20],
            positions: [
                { label: 'Centro', x: 0, y: 0 },
                { label: 'Del. der.', x: 100, y: 100 },
                { label: 'Del. izq.', x: -100, y: 100 },
                { label: 'Tras. izq.', x: -100, y: -100 },
                { label: 'Tras. der.', x: 100, y: -100 }
            ],
            cycles: 2,
            bidirectional: true,
            uMass_g: 5,          // incertidumbre estándar de la masa aplicada
            resPos_mm: 1,        // resolución con que se ubica la masa
            tolFz_pct: 1,        // tolerancia de fuerza, % de la carga máxima
            tolCoP_mm: 5,        // tolerancia de centro de presión
            env: { lat: -39.81, alt: 10, temp: 20 },
            notes: ''
        };
    }

    function buildPlan(cfg) {
        const ms = [...cfg.masses_kg].filter(m => m > 0).sort((a, b) => a - b);
        const plan = [];
        for (let c = 1; c <= cfg.cycles; c++) {
            plan.push({ cycle: c, dir: 'tara', mass_kg: 0, x: 0, y: 0, action: `Ciclo ${c}: plataforma VACÍA. Espere 10 s y registre la TARA de las 4 celdas.` });
            cfg.positions.forEach(p => {
                ms.forEach(m => plan.push({ cycle: c, dir: 'carga', mass_kg: m, x: p.x, y: p.y, action: `Ciclo ${c} ↑: coloque ${m} kg centrados en ${p.label} (x = ${p.x}, y = ${p.y} mm). Espere 5 s y registre.` }));
                if (cfg.bidirectional)
                    [...ms].reverse().forEach(m => plan.push({ cycle: c, dir: 'descarga', mass_kg: m, x: p.x, y: p.y, action: `Ciclo ${c} ↓: retire masa hasta dejar ${m} kg en ${p.label}. Espere 5 s y registre.` }));
            });
            plan.push({ cycle: c, dir: 'tara', mass_kg: 0, x: 0, y: 0, action: `Ciclo ${c}: retire todo y registre la TARA final (deriva del cero).` });
        }
        return plan;
    }

    const raw = r => [r.c1, r.c2, r.c3, r.c4];

    function tares(rows) {
        const t = rows.filter(r => r.dir === 'tara');
        const byCycle = S.groupBy(t, r => r.cycle);
        const avg = list => [0, 1, 2, 3].map(i => S.mean(list.map(r => raw(r)[i])));
        const global = t.length ? avg(t) : null;
        const base = {}, drift = [];
        for (const c of new Set(rows.map(r => r.cycle))) {
            const z = byCycle.get(c);
            base[c] = z && z.length ? avg(z) : global;
            if (z && z.length >= 2) drift.push({ cycle: c, counts: [0, 1, 2, 3].map(i => raw(z[z.length - 1])[i] - raw(z[0])[i]) });
        }
        return { base, drift, has: t.length > 0 };
    }

    /** Ajusta k_i con todas las cargas. Devuelve k, su covarianza y las filas usadas. */
    function fitScale(cfg, rows, base, g) {
        const Lc = Math.max(...cfg.cells.map(c => Math.max(Math.abs(c.x), Math.abs(c.y)))) || 1;
        const A = [], b = [];
        const used = rows.filter(r => r.dir !== 'tara' && r.mass_kg > 0 && base[r.cycle]);
        for (const r of used) {
            const d = raw(r).map((v, i) => v - base[r.cycle][i]);
            const W = r.mass_kg * g;
            A.push(d);                                            b.push(W);
            A.push(d.map((v, i) => v * cfg.cells[i].x / Lc));    b.push(W * r.x / Lc);
            A.push(d.map((v, i) => v * cfg.cells[i].y / Lc));    b.push(W * r.y / Lc);
        }
        const sol = Lin.lstsq(A, b);
        return { k: sol.x, cov: sol.cov, used, see: Math.sqrt(sol.s2) };
    }

    function evaluate(cfg, k, base, r) {
        const d = raw(r).map((v, i) => v - base[r.cycle][i]);
        const F = d.map((v, i) => k[i] * v);
        const Fz = S.sum(F);
        const cx = S.sum(F.map((f, i) => f * cfg.cells[i].x)) / Fz;
        const cy = S.sum(F.map((f, i) => f * cfg.cells[i].y)) / Fz;
        return { F, Fz, cx, cy };
    }

    function analyze(cfg, rows) {
        const warnings = [];
        const valid = rows.filter(r => raw(r).every(isFinite) && isFinite(r.mass_kg));
        const { base, drift, has } = tares(valid);
        if (!has) return { ok: false, warnings: ['Falta la TARA (plataforma vacía). Sin ella no se puede calibrar.'] };
        const g = P.gLocal(cfg.env.lat, cfg.env.alt);

        const loads = valid.filter(r => r.dir !== 'tara' && r.mass_kg > 0);
        const nPos = new Set(loads.map(r => `${r.x},${r.y}`)).size;
        if (loads.length < 2 || nPos < 2) return { ok: false, warnings: ['Se necesitan cargas en al menos 2 posiciones distintas (idealmente centro + 4 cuadrantes).'] };

        let sc;
        try { sc = fitScale(cfg, valid, base, g); }
        catch (e) { return { ok: false, warnings: [`No se pudo ajustar: ${e.message}. Use más posiciones (no todas alineadas).`] }; }
        const k = sc.k;
        const seK = k.map((_, i) => Math.sqrt(sc.cov[i][i]));

        if (k.some(v => v <= 0)) warnings.push('Alguna celda tiene factor negativo o nulo: revise cableado (E+/E−, A+/A−) o el orden de las celdas.');
        const kMean = S.mean(k), kDisp = (Math.max(...k) - Math.min(...k)) / kMean;
        if (kDisp > 0.3) warnings.push(`Los factores de las celdas difieren ${(kDisp * 100).toFixed(0)} %: verifique que las 4 celdas sean iguales y estén bien apoyadas.`);

        const pts = loads.map(r => {
            const e = evaluate(cfg, k, base, r);
            const W = r.mass_kg * g;
            return { ...r, ...e, W, errF: e.Fz - W, errX: e.cx - r.x, errY: e.cy - r.y, errCoP: Math.hypot(e.cx - r.x, e.cy - r.y) };
        });

        const FS = Math.max(...pts.map(p => p.W));
        const fitF = S.polyfit(pts.map(p => p.W), pts.map(p => p.Fz), 1);
        const groups = S.groupBy(pts, p => `${p.x},${p.y},${p.mass_kg},${p.dir}`);
        const repF = S.pooledSD([...groups.values()].map(g => g.map(p => p.Fz)));
        const repCoP = S.pooledSD([...groups.values()].flatMap(g => [g.map(p => p.cx), g.map(p => p.cy)]));

        const hystRows = [];
        for (const key of new Set(pts.map(p => `${p.x},${p.y},${p.mass_kg}`))) {
            const up = pts.filter(p => `${p.x},${p.y},${p.mass_kg}` === key && p.dir === 'carga');
            const dn = pts.filter(p => `${p.x},${p.y},${p.mass_kg}` === key && p.dir === 'descarga');
            if (up.length && dn.length) hystRows.push({ key, diff: S.mean(up.map(p => p.Fz)) - S.mean(dn.map(p => p.Fz)) });
        }
        const hyst = hystRows.length ? S.maxAbs(hystRows.map(h => h.diff)) : NaN;

        const byMass = [...S.groupBy(pts, p => p.mass_kg).entries()].sort((a, b) => a[0] - b[0]).map(([m, list]) => ({
            mass: m, n: list.length,
            errFmean: S.mean(list.map(p => p.errF)), errFmax: S.maxAbs(list.map(p => p.errF)),
            copRms: S.rms(list.map(p => p.errCoP)), copMax: Math.max(...list.map(p => p.errCoP))
        }));
        const byPos = [...S.groupBy(pts, p => `${p.x},${p.y}`).entries()].map(([key, list]) => ({
            x: list[0].x, y: list[0].y, label: (cfg.positions.find(q => `${q.x},${q.y}` === key) || {}).label || key,
            cxMean: S.mean(list.map(p => p.cx)), cyMean: S.mean(list.map(p => p.cy)),
            errMean: Math.hypot(S.mean(list.map(p => p.errX)), S.mean(list.map(p => p.errY)))
        }));

        const uW = g * cfg.uMass_g / 1000;
        const uPos = U.fromResolution(cfg.resPos_mm);
        const rmsF = S.rms(pts.map(p => p.errF));
        const rmsCoP = S.rms(pts.map(p => p.errCoP));
        const U_F = U.expanded(U.combine(rmsF, uW));
        const U_CoP = U.expanded(U.combine(rmsCoP, uPos));
        const maxErrFpct = 100 * S.maxAbs(pts.map(p => p.errF)) / FS;
        const maxCoP = Math.max(...pts.map(p => p.errCoP));
        const conformF = maxErrFpct + 100 * U.expanded(uW) / FS <= cfg.tolFz_pct;
        const conformCoP = maxCoP + U.expanded(uPos) <= cfg.tolCoP_mm;

        drift.forEach(d => {
            const N = d.counts.map((c, i) => c * k[i]);
            d.N = N; d.Ntot = S.sum(N);
            if (Math.abs(d.Ntot) > 0.005 * FS) warnings.push(`Deriva de tara en ciclo ${d.cycle}: ${d.Ntot.toFixed(2)} N. Caliente el equipo 15 min antes y evite corrientes de aire.`);
        });
        const small = byMass[0];
        if (small && byMass.length > 1 && small.copRms > 2 * byMass[byMass.length - 1].copRms)
            warnings.push('El error de CoP crece con cargas bajas (esperable: CoP = momento / fuerza). Informe la carga mínima válida.');

        return {
            ok: true, warnings, g, k, seK, pts, fitF, byMass, byPos, drift, hystRows,
            metrics: {
                FS, gainF: fitF.coef[1], offsetF: fitF.coef[0], linF: S.maxAbs(fitF.residuals), linFpct: 100 * S.maxAbs(fitF.residuals) / FS,
                rmsF, maxErrFpct, repF: repF.s, hystF: hyst, hystFpct: 100 * hyst / FS,
                rmsCoP, maxCoP, repCoP: repCoP.s, U_F, U_CoP, conformF, conformCoP
            }
        };
    }

    function arduinoSnippet(cfg, res) {
        const f = v => v.toExponential(6);
        const cps = res.k.map(v => (1 / v).toFixed(3));
        return `// Calibración plataforma de fuerza — ${cfg.name || 'sin nombre'} (${new Date().toLocaleDateString('es-CL')})
// F_i = K[i] * (raw_i - tara_i)   [N]
const float K[4]  = { ${res.k.map(f).join(', ')} };  // N por cuenta
const float CX[4] = { ${cfg.cells.map(c => c.x.toFixed(1)).join(', ')} };  // mm
const float CY[4] = { ${cfg.cells.map(c => c.y.toFixed(1)).join(', ')} };  // mm
long tara[4];  // promedio de ~50 lecturas con la plataforma vacía, al encender

// Si usa la librería HX711 (bogde): scale.set_scale(cuentas por N)
// Celda 1..4: ${cps.join(', ')} cuentas/N

void calcular(const long raw[4], float &Fz, float &copX, float &copY) {
  float F[4]; Fz = 0; copX = 0; copY = 0;
  for (int i = 0; i < 4; i++) { F[i] = K[i] * (raw[i] - tara[i]); Fz += F[i]; }
  for (int i = 0; i < 4; i++) { copX += F[i] * CX[i]; copY += F[i] * CY[i]; }
  copX /= Fz; copY /= Fz;   // válido solo si Fz supera la carga mínima validada
}`;
    }

    function exampleData(cfg, seed = 7) {
        let s = seed;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const gauss = sd => sd * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
        const g = P.gLocal(cfg.env.lat, cfg.env.alt);
        const truth = { k: [2.10e-4, 1.92e-4, 2.05e-4, 1.97e-4], tare: [84210, -15320, 40210, 5120], noise: 40 };
        // Reparto estático exacto de una carga puntual en una placa rígida con 4 apoyos simétricos (bilineal)
        const share = (x, y) => {
            const xs = cfg.cells.map(c => c.x), ys = cfg.cells.map(c => c.y);
            const W = Math.max(...xs) - Math.min(...xs), D = Math.max(...ys) - Math.min(...ys);
            const u = (x - Math.min(...xs)) / W, v = (y - Math.min(...ys)) / D;
            return cfg.cells.map(c => (c.x > 0 ? u : 1 - u) * (c.y > 0 ? v : 1 - v));
        };
        let drift = 0;
        const rows = buildPlan(cfg).map(st => {
            drift += 3;
            const sh = share(st.x, st.y);
            const r = { cycle: st.cycle, dir: st.dir, mass_kg: st.mass_kg, x: st.x, y: st.y };
            const hyst = st.dir === 'descarga' ? 1.002 : 1;
            [0, 1, 2, 3].forEach(i => {
                r[`c${i + 1}`] = Math.round(truth.tare[i] + drift + (st.mass_kg * g * sh[i] * hyst) / truth.k[i] + gauss(truth.noise));
            });
            return r;
        });
        return { rows, truth };
    }

    return { NC, defaultConfig, buildPlan, analyze, evaluate, arduinoSnippet, exampleData };
});
