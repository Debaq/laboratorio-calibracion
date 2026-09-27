// Pruebas del módulo de sensores inerciales crudos y del motor genérico de perfiles.
const test = require('node:test');
const assert = require('node:assert/strict');
const IC = require('../js/modules/imucrudo-model.js');
const G = require('../js/modules/generico-model.js');
const R = require('../js/perfiles/registry.js');
for (const f of ['temperatura', 'humedad', 'distancia', 'fuerza-electricos', 'varios', 'biomedicos']) require(`../js/perfiles/${f}.js`);

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} esperado ${b} ± ${tol}, obtenido ${a}`);

test('acelerómetro 6 posiciones: recupera matriz de escala y sesgo', () => {
    for (const unit of ['ms2', 'g', 'cuentas']) {
        const cfg = { ...IC.defaultConfig(), accUnit: unit, cycles: 3 };
        const { rows, truth } = IC.exampleData(cfg);
        const r = IC.analyze(cfg, rows);
        assert.ok(r.ok, r.warnings.join(' | '));
        const k = unit === 'cuentas' ? cfg.countsPerG : 1;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(r.S[i][j] / k, truth.S[i][j], 0.004, `S[${i}][${j}] (${unit})`);
        close(r.biasG[2], 0.42 / 9.80665 * (unit === 'ms2' ? 9.80665 / r.g : 1), 0.002, `sesgo z (${unit})`);
        assert.ok(r.metrics.maxAngErrAfter < 0.3, `error angular tras corregir ${r.metrics.maxAngErrAfter}`);
    }
});

test('acelerómetro: faltan posiciones', () => {
    const cfg = IC.defaultConfig();
    const { rows } = IC.exampleData(cfg);
    assert.equal(IC.analyze(cfg, rows.filter(r => r.pos !== '-Y')).ok, false);
});

test('giroscopio en reposo: sesgo y ARW', () => {
    const r = IC.gyroStatic(IC.exampleGyroStatic(), IC.defaultConfig());
    close(r.fs, 100, 0.5);
    close(r.axes[0].bias, 0.8, 0.05);
    // ruido blanco σ = 0,05 °/s a 100 Hz → ARW = σ/√fs · 60 = 0,3 °/√h
    close(r.axes[0].arw, 0.05 / Math.sqrt(100) * 60, 0.05);
});

test('giroscopio: error de escala por giro contra topes', () => {
    const cfg = IC.defaultConfig();
    const st = IC.gyroStatic(IC.exampleGyroStatic(), cfg);
    const rot = IC.gyroRotation(IC.exampleGyroRotation('z', 360, 1.015), cfg, 'z', 360);
    const [res] = IC.rotationResults([rot], st);
    close(res.scaleErrPct, 1.5, 0.15);
    const [res0] = IC.rotationResults([rot], null); // sesgo del primer segundo
    close(res0.scaleErrPct, 1.5, 0.3);
});

test('magnetómetro: centro de hierro duro y esfera tras corregir', () => {
    const r = IC.magAnalyze(IC.magPoints(IC.exampleMag()), IC.defaultConfig());
    [18, -32, 7].forEach((c, i) => close(r.center[i], c, 0.3));
    assert.ok(r.spreadAfter < 2, `dispersión ${r.spreadAfter}`);
    assert.ok(r.spreadRaw > 10);
    assert.equal(r.octants, 8);
});

test('motor genérico: todos los perfiles analizan su ejemplo', () => {
    const list = R.list();
    assert.ok(list.length >= 26);
    for (const p of list) {
        const m = G.create(p), cfg = m.defaultConfig();
        const r = m.analyze(cfg, m.exampleData(cfg).rows);
        assert.ok(r.ok, `${p.id}: ${(r.warnings || []).join(' | ')}`);
    }
});

test('motor genérico: Steinhart–Hart recupera el termistor y τ en °C', () => {
    const m = G.create(R.get('ntc')), cfg = m.defaultConfig();
    const r = m.analyze(cfg, m.exampleData(cfg).rows);
    assert.equal(r.fit.id, 'steinhart');
    close(r.fit.coef[1], 2.378405444e-4, 2e-6);
    assert.ok(r.metrics.see < 0.05);
    close(m.timeResponse(m.exampleStep(cfg), cfg, r.fit).tau, 6, 0.05);
});

test('motor genérico: humedad con sales usa la tabla de Greenspan', () => {
    const m = G.create(R.get('hr')), cfg = m.defaultConfig();
    const y = m.yOf({ level: 75, temp: 25 }, cfg);
    close(y.value, 75.29, 1e-9);
});

test('motor genérico: Bland–Altman recupera el sesgo', () => {
    const m = G.create(R.get('spo2')), cfg = m.defaultConfig();
    const r = m.analyze(cfg, m.exampleData(cfg).rows);
    assert.equal(r.mode, 'comparacion');
    close(r.metrics.bias, 0.8, 0.8);
    assert.ok(r.metrics.loa[0] < r.metrics.bias && r.metrics.bias < r.metrics.loa[1]);
});

test('modelos transformados: potencia e inverso exactos', () => {
    const x = [1, 2, 4, 8, 16], yp = x.map(v => 3 * v ** -0.7), yi = x.map(v => 2 + 5 / v);
    const fp = G.fitModel('potencia', x, yp), fi = G.fitModel('inverso', x, yi);
    close(Math.exp(fp.coef[0]), 3, 1e-9); close(fp.coef[1], -0.7, 1e-9);
    close(fi.coef[0], 2, 1e-9); close(fi.coef[1], 5, 1e-9);
});
