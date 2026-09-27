// Pruebas de procesamiento de señales y de los ensayos dinámicos de la plataforma.
const test = require('node:test');
const assert = require('node:assert/strict');
const Sig = require('../js/core/signal.js');
const P = require('../js/core/physics.js');
const B = require('../js/modules/balanza-model.js');
const BS = require('../js/modules/balanza-series.js');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} esperado ${b} ± ${tol}, obtenido ${a}`);
const g = P.gLocal(-39.81, 10);

test('filtro de fase cero: ganancia 1 en DC, −6 dB en fc, sin desfase', () => {
    const fs = 100, n = 2000, t = Array.from({ length: n }, (_, i) => i / fs);
    const dc = Sig.lowpass(new Array(n).fill(3), 10, fs);
    close(dc[500], 3, 1e-9);
    const amp = f => {
        const y = Sig.lowpass(t.map(v => Math.sin(2 * Math.PI * f * v)), 10, fs);
        return Sig.toneAmplitude(t.slice(200, 1800), y.slice(200, 1800), 2 * Math.PI * f);
    };
    close(amp(1), 1, 0.002, 'banda de paso');
    close(amp(10), 0.5, 0.02, 'en fc');
    assert.ok(amp(30) < 0.02, 'banda de rechazo');
    const y = Sig.lowpass(t.map(v => Math.sin(2 * Math.PI * 1 * v)), 10, fs);
    close(y[1000], Math.sin(2 * Math.PI * 10), 0.005, 'fase cero');
});

test('ajuste de círculo exacto', () => {
    const x = [], y = [];
    for (let i = 0; i < 50; i++) { x.push(3 + 7 * Math.cos(i / 5)); y.push(-2 + 7 * Math.sin(i / 5)); }
    const c = Sig.circleFit(x, y);
    close(c.xc, 3, 1e-9); close(c.yc, -2, 1e-9); close(c.R, 7, 1e-9);
});

test('métricas de estabilometría con señal conocida', () => {
    // x = A sin(2π f t): trayectoria = 4A por ciclo → velocidad media = 4 A f
    const fs = 1000, T = 10, A = 5, f = 0.5;
    const t = Array.from({ length: T * fs + 1 }, (_, i) => i / fs);
    const m = Sig.swayMetrics(t, t.map(v => A * Math.sin(2 * Math.PI * f * v)), t.map(() => 0));
    close(m.velMean, 4 * A * f, 0.01);
    close(m.rmsX, A / Math.SQRT2, 0.01);
    close(m.area95, 0, 1e-9);
});

test('lectura de CSV: encabezado, coma decimal, basura y tiempo en ms', () => {
    const txt = 'Iniciando...\nt_ms;F1;F2;F3;F4\n0;1,5;2;3;4\n' + Array.from({ length: 30 }, (_, i) => `${(i + 1) * 12};1,5;2;3;4`).join('\n') + '\nerror de lectura\n';
    const s = BS.parseCSV(txt);
    assert.equal(s.kind, 'force');
    assert.equal(s.n, 31);
    assert.equal(s.cols.F1[0], 1.5);
    assert.equal(s.tms[1], 12);
    assert.equal(s.skipped, 1);
});

test('lectura de CSV sin encabezado (sketch de la guía)', () => {
    const txt = Array.from({ length: 40 }, (_, i) => `${1000 + i * 13},${100 + i},200,300,400`).join('\n');
    const s = BS.parseCSV(txt);
    assert.equal(s.kind, 'raw');
    assert.equal(s.tms[0], 0);
    assert.equal(s.cols.c1[5], 105);
});

test('CSV con reinicio del Arduino se corta', () => {
    const txt = 't_ms,cop_x,cop_y\n' + Array.from({ length: 30 }, (_, i) => `${i * 10},1,2`).join('\n') + '\n0,1,2\n10,1,2';
    const s = BS.parseCSV(txt);
    assert.equal(s.n, 30);
    assert.ok(s.warnings.some(w => w.includes('retrocede')));
});

function staticCalib() {
    const cfg = B.defaultConfig();
    const ex = B.exampleData(cfg);
    const r = B.analyze(cfg, ex.rows);
    return { cfg, truth: ex.truth, calib: { k: r.k, cells: cfg.cells, tareStatic: null } };
}

test('ruido de fondo: detecta el tramo cargado y estima la masa', () => {
    const { cfg, truth, calib } = staticCalib();
    const sc = BS.defaultSeriesConfig();
    const r = BS.noiseAnalysis(BS.exampleNoise(cfg, truth, g, sc), calib, sc, g);
    assert.ok(r.ok, (r.warnings || []).join(' | '));
    close(r.massEst, 70, 0.1, 'masa');
    close(r.metrics.meanX, 5 + 0.004 * 25, 0.3, 'CoP x medio');
    assert.ok(r.metrics.velMean < 5, `velocidad de piso ${r.metrics.velMean}`);
    close(r.data.samp.fs, 80, 1);
});

test('masa giratoria: el radio medido coincide con R(ω) incluyendo la fuerza centrípeta', () => {
    const { cfg, truth, calib } = staticCalib();
    const sc = BS.defaultSeriesConfig();
    const runs = BS.exampleRotation(cfg, truth, g, sc, [0.2, 1, 2]);
    const res = runs.map(s => BS.rotationAnalysis(s, calib, sc, g));
    res.forEach(r => assert.ok(r.ok, (r.warnings || []).join(' | ')));
    close(res[0].f, 0.2, 0.005);
    close(res[2].f, 2, 0.01);
    res.forEach(r => close(r.ratio, 1, 0.02, `razón a ${r.f.toFixed(2)} Hz`));
    // a 2 Hz con h = 100 mm el término centrípeto agrega ω²h/g ≈ 161 %
    close(res[2].centrifugalPct, 100 * (2 * Math.PI * 2) ** 2 * 0.1 / g, 0.01);
    const fr = BS.frequencyResponse(res, sc);
    assert.equal(fr.verdict, true);
});

test('masa giratoria: un filtro muy bajo se detecta como pérdida de amplitud', () => {
    const { cfg, truth, calib } = staticCalib();
    const sc = { ...BS.defaultSeriesConfig(), filterHz: 1.5 };
    const r = BS.rotationAnalysis(BS.exampleRotation(cfg, truth, g, sc, [2])[0], calib, sc, g);
    assert.ok(r.ratio < 0.85, `razón ${r.ratio}`);
    assert.equal(BS.frequencyResponse([r], sc).verdict, false);
});

test('plan estático: escalera en el centro, una masa por posición y fluencia', () => {
    const cfg = B.defaultConfig();
    const plan = B.buildPlan(cfg);
    assert.equal(plan.length, 2 * (1 + 4 + 3 + 4 + 1) + 2);
    assert.equal(plan[plan.length - 1].dir, 'fluencia60');
    const r = B.analyze(cfg, B.exampleData(cfg).rows);
    close(r.creep.pct, 0.04, 0.02, 'fluencia');
});

// ---------- Núcleo agregado para el catálogo de sensores ----------
const Lg = require('../js/core/linalg.js');
const CSV = require('../js/core/csv.js');

test('autovalores de matriz simétrica (Jacobi)', () => {
    const A = [[4, 1, 2], [1, 3, 0], [2, 0, 5]];
    const { values, vectors: V } = Lg.eigSym(A);
    for (let k = 0; k < 3; k++) {
        const v = V.map(r => r[k]);
        const Av = Lg.matvec(A, v);
        Av.forEach((x, i) => close(x, values[k] * v[i], 1e-9));
    }
    const R = Lg.symFun(A, Math.sqrt);
    Lg.matmul(R, R).forEach((row, i) => row.forEach((x, j) => close(x, A[i][j], 1e-9)));
});

test('ajuste de elipsoide recupera offset y corrige hierro duro/blando', () => {
    const c = [12, -30, 5], S = [[1.2, 0.1, 0], [0.1, 0.8, 0.05], [0, 0.05, 1.0]];
    const pts = [];
    for (let i = 0; i < 400; i++) {
        const u = 1 - 2 * (i + 0.5) / 400, ph = i * 2.39996;
        const d = [Math.sqrt(1 - u * u) * Math.cos(ph), Math.sqrt(1 - u * u) * Math.sin(ph), u].map(v => 40 * v);
        pts.push(Lg.matvec(S, d).map((v, k) => v + c[k]));
    }
    const f = Sig.ellipsoidFit(pts, 40);
    f.center.forEach((v, i) => close(v, c[i], 1e-6));
    f.after.forEach(r => close(r, 40, 1e-6));
});

test('Allan: ruido blanco cae como τ^−½', () => {
    let s = 3; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const x = Array.from({ length: 20000 }, () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd()));
    const a = Sig.allanDeviation(x, 100);
    const p1 = a.find(p => p.tau >= 0.1), p2 = a.find(p => p.tau >= 1);
    close(Math.log10(p2.adev / p1.adev) / Math.log10(p2.tau / p1.tau), -0.5, 0.08);
    close(a[0].adev, 1, 0.03); // en τ = 1 muestra, σ ≈ desviación de la señal
});

test('escalón de primer orden: recupera τ y t0', () => {
    const t = Array.from({ length: 600 }, (_, i) => i * 0.1);
    const y = t.map(v => v < 5 ? 20 : 0 + 20 * Math.exp(-(v - 5) / 7.5));
    const r = Sig.firstOrderStep(t, y);
    close(r.tau, 7.5, 0.01); close(r.t0, 5, 0.02); close(r.t90, 7.5 * Math.log(10), 0.05);
});

test('CSV genérico: encabezado con unidades y columna de tiempo', () => {
    const tb = CSV.parseTable('Registro\nt_ms;Temp [°C]\n0;21,5\n1000;21,6\nfin');
    assert.equal(tb.n, 2); assert.equal(tb.cols[1][0], 21.5);
    const tc = CSV.timeColumn(tb);
    assert.deepEqual(tc.t, [0, 1]);
});
