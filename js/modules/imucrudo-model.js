/*
 * Calibración de los sensores CRUDOS de una IMU (3, 6 o 9 DOF): acelerómetro, giroscopio, magnetómetro.
 *
 * Acelerómetro — método de 6 posiciones (gravedad como patrón, sin equipos):
 *   lectura = S·a + b,  con a = ±g·eᵢ en cada posición.
 *   Columna i de S = (L(+i) − L(−i)) / (2g)        b = (L(+i) + L(−i)) / 2   (3 estimaciones)
 *   Corrección: a = S⁻¹ · (lectura − b).  Diagonal de S = escala; fuera de la diagonal = desalineación.
 *
 * Giroscopio — reposo: sesgo, ruido y desviación de Allan (ARW, inestabilidad de sesgo);
 *   giro de ángulo conocido contra topes: ∫(ω − sesgo)dt / ángulo verdadero → error de escala.
 *
 * Magnetómetro — girar en todas direcciones: los puntos forman un elipsoide
 *   (hierro duro = centro desplazado; hierro blando = deformación). Corrección: m = W·(lectura − c).
 */
(function (root, factory) {
    const req = n => (typeof require === 'function') ? require(n) : null;
    const S = req('../core/stats.js') || root.LabStats;
    const L = req('../core/linalg.js') || root.LabLinalg;
    const P = req('../core/physics.js') || root.LabPhys;
    const Sig = req('../core/signal.js') || root.LabSignal;
    const CSV = req('../core/csv.js') || root.LabCSV;
    const m = factory(S, L, P, Sig, CSV);
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.ImuCrudoModel = m;
})(typeof self !== 'undefined' ? self : this, function (S, L, P, Sig, CSV) {
    'use strict';

    const AX = ['x', 'y', 'z'];
    const POS = ['+Z', '-Z', '+X', '-X', '+Y', '-Y'];
    const POS_TXT = {
        '+Z': 'cara superior (+Z) hacia ARRIBA — placa acostada normal',
        '-Z': 'cara superior hacia ABAJO (+Z apunta al suelo) — placa dada vuelta',
        '+X': 'eje +X hacia ARRIBA — placa parada sobre su borde −X',
        '-X': 'eje +X hacia ABAJO — placa parada sobre su borde +X',
        '+Y': 'eje +Y hacia ARRIBA — placa parada sobre su borde −Y',
        '-Y': 'eje +Y hacia ABAJO — placa parada sobre su borde +Y'
    };
    const DEG = 180 / Math.PI;

    function defaultConfig() {
        return {
            name: '',
            sensor: { model: 'MPU6050', maker: 'InvenSense', dof: 'imu6', notes: '' },
            accUnit: 'ms2', countsPerG: 16384,
            cycles: 2, reps: 1,
            tolBias_g: 0.02, tolScale_pct: 1,
            gyroUnit: 'dps',
            magField_uT: 0,
            env: { lat: -39.81, alt: 10, temp: 20 }
        };
    }

    function buildPlan(cfg) {
        const plan = [];
        for (let c = 1; c <= cfg.cycles; c++)
            POS.forEach(p => { for (let r = 1; r <= cfg.reps; r++) plan.push({ cycle: c, pos: p, action: `Ciclo ${c}, posición ${p}: ${POS_TXT[p]}. Apoye contra una escuadra sobre superficie NIVELADA, quieta 3 s. Registre el promedio de ax, ay, az (≥ 2 s).${cfg.reps > 1 ? ` Lectura ${r} de ${cfg.reps}.` : ''}` }); });
        return plan;
    }

    /** Valor de la gravedad en las unidades del sensor. */
    function gRef(cfg) {
        const g = P.gLocal(cfg.env.lat, cfg.env.alt);
        return cfg.accUnit === 'ms2' ? g : cfg.accUnit === 'g' ? g / P.G_STANDARD : 1;
    }

    function analyze(cfg, rows) {
        const warnings = [];
        const valid = rows.filter(r => POS.includes(r.pos) && AX.every(a => isFinite(r['a' + a])));
        const byPos = {};
        POS.forEach(p => { byPos[p] = valid.filter(r => r.pos === p); });
        const missing = POS.filter(p => !byPos[p].length);
        if (missing.length) return { ok: false, warnings: [`Faltan posiciones: ${missing.join(', ')}. Se necesitan las 6.`] };
        const mean = p => AX.map(a => S.mean(byPos[p].map(r => r['a' + a])));
        const Mn = Object.fromEntries(POS.map(p => [p, mean(p)]));
        const g = gRef(cfg);
        const pairs = [['+X', '-X'], ['+Y', '-Y'], ['+Z', '-Z']];
        // S[j][i]: eje medido j, estímulo en eje i
        const Smat = L.zeros(3, 3);
        pairs.forEach(([pp, pn], i) => AX.forEach((_, j) => { Smat[j][i] = (Mn[pp][j] - Mn[pn][j]) / (2 * g); }));
        const bEst = pairs.map(([pp, pn]) => AX.map((_, j) => (Mn[pp][j] + Mn[pn][j]) / 2));
        const b = AX.map((_, j) => S.mean(bEst.map(e => e[j])));
        const bSpread = AX.map((_, j) => Math.max(...bEst.map(e => e[j])) - Math.min(...bEst.map(e => e[j])));
        let Sinv;
        try { Sinv = L.inv(Smat); } catch (e) { return { ok: false, warnings: ['La matriz de escala es singular: ¿posiciones confundidas?'] }; }

        const noise = AX.map(a => S.pooledSD(POS.map(p => byPos[p].map(r => r['a' + a]))).s);
        const unitG = cfg.accUnit === 'cuentas' ? 1 : g; // magnitud de 1 g en las unidades de salida corregidas
        const expected = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
        const after = POS.map(p => {
            const a = L.matvec(Sinv, Mn[p].map((v, j) => v - b[j]));
            const norm = Math.hypot(...a);
            const cos = a.reduce((s, v, j) => s + v * expected[p][j], 0) / norm;
            const rawNorm = Math.hypot(...Mn[p]);
            return { pos: p, raw: Mn[p], cal: a, normErrPct: 100 * (norm / unitG - 1), angErr: Math.acos(Math.min(1, cos)) * DEG, rawNorm, n: byPos[p].length };
        });

        // Parámetros físicos para informar
        const scale = AX.map((_, i) => Smat[i][i]);
        const scaleErrPct = cfg.accUnit === 'cuentas' ? scale.map(s => 100 * (s / cfg.countsPerG - 1)) : scale.map(s => 100 * (s - 1));
        const biasG = b.map(v => v / (cfg.accUnit === 'cuentas' ? S.mean(scale) : g));  // en g
        const tiltErr = biasG.map(v => Math.asin(Math.max(-1, Math.min(1, v))) * DEG);
        const misalign = [];
        for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) if (i !== j) misalign.push({ meas: AX[j], stim: AX[i], deg: Math.atan(Smat[j][i] / Smat[i][i]) * DEG });

        if (cfg.accUnit !== 'cuentas') {
            const off = after.map(a => a.rawNorm / g - 1).filter(v => Math.abs(v) > 0.15);
            if (off.length) warnings.push('Las magnitudes crudas difieren más de 15 % de 1 g: revise la unidad elegida (m/s², g o cuentas) y el rango (±2 g, ±4 g…).');
        }
        if (scale.some(s => s <= 0)) warnings.push('Algún eje tiene escala negativa: se confundieron posiciones (+ con −) o el eje del sensor no coincide con la placa.');
        bSpread.forEach((sp, j) => { if (sp > 6 * noise[j] && sp > 0.005 * g) warnings.push(`Eje ${AX[j]}: las 3 estimaciones del sesgo difieren ${sp.toPrecision(2)} (unid.): superficie no nivelada o placa no escuadrada en alguna posición.`); });
        const conformBias = biasG.every(v => Math.abs(v) <= cfg.tolBias_g);
        const conformScale = scaleErrPct.every(v => Math.abs(v) <= cfg.tolScale_pct);
        if (!conformBias) warnings.push(`Sesgo mayor a ${cfg.tolBias_g} g: sin corregir produce hasta ${Math.max(...tiltErr.map(Math.abs)).toFixed(2)}° de error de inclinación.`);

        return {
            ok: true, warnings, means: Mn, S: Smat, Sinv, b, bEst, bSpread, noise, after, scale, scaleErrPct, biasG, tiltErr, misalign, g,
            metrics: { conformBias, conformScale, maxNormErrAfter: Math.max(...after.map(a => Math.abs(a.normErrPct))), maxAngErrAfter: Math.max(...after.map(a => a.angErr)) }
        };
    }

    function accelCode(res, cfg) {
        const f = v => v.toPrecision(8);
        return `// Corrección del acelerómetro (6 posiciones) — ${cfg.sensor.model} — ${new Date().toLocaleDateString('es-CL')}
// a_corr = M · (a_crudo − b)     salida en ${cfg.accUnit === 'cuentas' ? 'g (1 = gravedad local)' : cfg.accUnit === 'ms2' ? 'm/s²' : 'g'}
const float B[3] = { ${res.b.map(f).join(', ')} };
const float M[3][3] = {
  { ${res.Sinv[0].map(f).join(', ')} },
  { ${res.Sinv[1].map(f).join(', ')} },
  { ${res.Sinv[2].map(f).join(', ')} } };
void corregirAcel(const float raw[3], float out[3]) {
  float d[3] = { raw[0] - B[0], raw[1] - B[1], raw[2] - B[2] };
  for (int i = 0; i < 3; i++) out[i] = M[i][0] * d[0] + M[i][1] * d[1] + M[i][2] * d[2];
}`;
    }

    // ---------------- Series CSV ----------------
    function xyzColumns(table, prefix) {
        const pats = {
            a: [/^a(cc|ccel)?_?([xyz])$/], g: [/^g(yr|yro)?_?([xyz])$/, /^w_?([xyz])$/], m: [/^m(ag)?_?([xyz])$/]
        }[prefix];
        const cols = AX.map(a => table.keys.findIndex(k => pats.some(p => { const mm = k.match(p); return mm && mm[mm.length - 1] === a; })));
        if (cols.every(c => c >= 0)) return cols;
        const tc = CSV.timeColumn(table);
        const rest = table.keys.map((_, i) => i).filter(i => !tc || i !== tc.index);
        if (rest.length >= 3) return rest.slice(0, 3);
        throw new Error('No se encontraron 3 columnas (x, y, z).');
    }

    /** Reposo: sesgo, ruido y Allan por eje. Se guarda solo el resumen (los registros largos no caben en el navegador). */
    function gyroStatic(text, cfg, name = 'reposo') {
        const tb = CSV.parseTable(text);
        const tc = CSV.timeColumn(tb);
        if (!tc) throw new Error('El registro necesita columna de tiempo (t_ms).');
        const cols = xyzColumns(tb, 'g');
        const k = cfg.gyroUnit === 'rads' ? DEG : 1;
        const samp = Sig.sampling(tc.t);
        const axes = cols.map((c, i) => {
            const x = tb.cols[c].map(v => v * k);
            const allan = Sig.allanDeviation(x, samp.fs, 36);
            const at1 = allan.reduce((best, p) => Math.abs(Math.log(p.tau)) < Math.abs(Math.log(best.tau)) ? p : best);
            const min = allan.reduce((a, b2) => b2.adev < a.adev ? b2 : a);
            return {
                axis: AX[i], bias: S.mean(x), sd: S.sd(x), allan,
                arw: at1.adev * Math.sqrt(at1.tau) * 60,                // °/√h
                biasInst: min.adev / 0.664 * 3600, tauMin: min.tau,      // °/h
                drift: S.polyfit(tc.t, x, 1).coef[1] * 60                 // °/s por minuto
            };
        });
        const w = [];
        if (samp.duration < 300) w.push(`Registro de ${samp.duration.toFixed(0)} s: para ver la inestabilidad de sesgo en la curva de Allan registre ≥ 10–30 min.`);
        return { name, n: tb.n, fs: samp.fs, duration: samp.duration, axes, warnings: w };
    }

    /** Giro de ángulo conocido: integral por eje (el sesgo se descuenta al analizar). */
    function gyroRotation(text, cfg, axis, angle, name) {
        const tb = CSV.parseTable(text);
        const tc = CSV.timeColumn(tb);
        if (!tc) throw new Error('El registro necesita columna de tiempo.');
        const cols = xyzColumns(tb, 'g');
        const k = cfg.gyroUnit === 'rads' ? DEG : 1;
        const t = tc.t, T = t[t.length - 1] - t[0];
        const I = [0, 0, 0], bias0 = [0, 0, 0];
        const n1 = Math.max(5, t.findIndex(v => v >= 1));
        cols.forEach((c, i) => {
            const x = tb.cols[c].map(v => v * k);
            for (let j = 1; j < x.length; j++) I[i] += 0.5 * (x[j] + x[j - 1]) * (t[j] - t[j - 1]);
            bias0[i] = S.mean(x.slice(0, n1));
        });
        return { name: name || `giro ${axis}`, axis, angle, I, T, bias0 };
    }

    function rotationResults(rots, staticRes) {
        return rots.map(r => {
            const bias = staticRes ? staticRes.axes.map(a => a.bias) : r.bias0;
            const ang = r.I.map((v, i) => v - bias[i] * r.T);
            const i = AX.indexOf(r.axis);
            return { ...r, measured: ang[i], scaleErrPct: 100 * (ang[i] / r.angle - 1), cross: AX.map((a, j) => j === i ? null : { axis: a, pct: 100 * ang[j] / r.angle }).filter(Boolean), biasSource: staticRes ? 'reposo' : 'primer segundo' };
        });
    }

    /** Magnetómetro: puntos (≤ 3000, se diezman) y ajuste de elipsoide. */
    function magPoints(text) {
        const tb = CSV.parseTable(text);
        const cols = xyzColumns(tb, 'm');
        let P3 = tb.cols[cols[0]].map((_, i) => cols.map(c => tb.cols[c][i]));
        if (P3.length > 3000) { const st = Math.ceil(P3.length / 3000); P3 = P3.filter((_, i) => i % st === 0); }
        return P3;
    }

    function magAnalyze(P3, cfg) {
        if (P3.length < 50) throw new Error('Muy pocos puntos: gire el sensor lentamente en todas direcciones durante ~60 s.');
        const f = Sig.ellipsoidFit(P3, cfg.magField_uT > 0 ? cfg.magField_uT : 0);
        const spread = v => 100 * S.sd(v) / S.mean(v);
        const maxDev = v => { const mu = S.mean(v); return Math.max(...v.map(x => Math.abs(x / mu - 1))); };
        const w = [];
        const aniso = Math.max(...f.radii) / Math.min(...f.radii);
        if (aniso > 1.3) w.push(`Hierro blando fuerte (ejes del elipsoide en razón ${aniso.toFixed(2)}): hay metal ferromagnético cerca del sensor.`);
        // Cobertura: fracción de octantes con puntos
        const oct = new Set(P3.map(p => p.map((v, i) => v > f.center[i] ? 1 : 0).join('')));
        if (oct.size < 8) w.push(`Solo ${oct.size} de 8 octantes con datos: gire el sensor en TODAS direcciones (también boca abajo).`);
        return {
            ...f, aniso, octants: oct.size, warnings: w,
            spreadRaw: spread(f.rawNorm), spreadBefore: spread(f.before), spreadAfter: spread(f.after),
            headingErrRaw: Math.asin(Math.min(1, maxDev(f.rawNorm))) * DEG, headingErrAfter: Math.asin(Math.min(1, maxDev(f.after))) * DEG
        };
    }

    function magCode(res) {
        const f = v => v.toPrecision(7);
        return `// Corrección del magnetómetro (hierro duro + blando):  m = W · (m_crudo − C)
const float C[3] = { ${res.center.map(f).join(', ')} };
const float W[3][3] = {
  { ${res.W[0].map(f).join(', ')} },
  { ${res.W[1].map(f).join(', ')} },
  { ${res.W[2].map(f).join(', ')} } };`;
    }

    // ---------------- Datos simulados ----------------
    function rng(seed) { let s = seed; const u = () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; return sd => sd * Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); }
    const TRUTH = { S: [[1.012, 0.004, -0.008], [-0.006, 0.994, 0.011], [0.009, -0.003, 1.021]], b: [0.18, -0.25, 0.42] };

    function exampleData(cfg) {
        const gauss = rng(9), g = gRef(cfg);
        const k = cfg.accUnit === 'cuentas' ? cfg.countsPerG : 1;
        const bb = TRUTH.b.map(v => v * (cfg.accUnit === 'ms2' ? 1 : cfg.accUnit === 'g' ? 1 / 9.80665 : cfg.countsPerG / 9.80665));
        const dir = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] };
        const rows = buildPlan(cfg).map(st => {
            const a = dir[st.pos].map(v => v * g * k);
            const raw = L.matvec(TRUTH.S, a).map((v, j) => v + bb[j] + gauss(0.004 * g * k));
            return { cycle: st.cycle, pos: st.pos, ax: +raw[0].toFixed(4), ay: +raw[1].toFixed(4), az: +raw[2].toFixed(4) };
        });
        return { rows, truth: TRUTH };
    }

    function exampleGyroStatic() {
        const gauss = rng(21), fs = 100, lines = ['t_ms,gx,gy,gz'];
        let rw = [0, 0, 0];
        for (let i = 0; i < fs * 600; i++) {
            rw = rw.map(v => v + gauss(0.0001));
            lines.push(`${Math.round(i * 10)},${(0.8 + rw[0] + gauss(0.05)).toFixed(4)},${(-1.3 + rw[1] + gauss(0.05)).toFixed(4)},${(0.25 + rw[2] + gauss(0.06)).toFixed(4)}`);
        }
        return lines.join('\n');
    }

    function exampleGyroRotation(axis, angle = 360, scale = 1.015) {
        const gauss = rng(33 + AX.indexOf(axis)), fs = 100, lines = ['t_ms,gx,gy,gz'];
        const bias = [0.8, -1.3, 0.25], T = 8, i = AX.indexOf(axis);
        for (let j = 0; j < fs * T; j++) {
            const t = j / fs;
            const w = t < 2 || t > 6 ? 0 : angle / 4 * (1 - Math.cos(2 * Math.PI * (t - 2) / 4)); // perfil suave de 4 s
            const v = bias.map((b0, k) => b0 + gauss(0.05) + (k === i ? scale * w : 0.004 * w));
            lines.push(`${Math.round(t * 1000)},${v.map(x => x.toFixed(4)).join(',')}`);
        }
        return lines.join('\n');
    }

    function exampleMag() {
        const gauss = rng(44), c = [18, -32, 7], A = [[1.15, 0.08, 0.02], [0.08, 0.88, -0.04], [0.02, -0.04, 1.02]];
        const lines = ['t_ms,mx,my,mz'];
        for (let i = 0; i < 1500; i++) {
            const u = 1 - 2 * (i + 0.5) / 1500, ph = i * 2.39996; // espiral de Fibonacci: cobertura uniforme
            const d = [Math.sqrt(1 - u * u) * Math.cos(ph), Math.sqrt(1 - u * u) * Math.sin(ph), u].map(v => 23 * v);
            const m = L.matvec(A, d).map((v, k) => v + c[k] + gauss(0.3));
            lines.push(`${i * 40},${m.map(x => x.toFixed(2)).join(',')}`);
        }
        return lines.join('\n');
    }

    return { AX, POS, POS_TXT, defaultConfig, buildPlan, gRef, analyze, accelCode, gyroStatic, gyroRotation, rotationResults, magPoints, magAnalyze, magCode, exampleData, exampleGyroStatic, exampleGyroRotation, exampleMag, TRUTH };
});
