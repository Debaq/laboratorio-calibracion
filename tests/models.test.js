// Pruebas de los modelos: con datos sintéticos de parámetros conocidos, el análisis debe recuperarlos.
const test = require('node:test');
const assert = require('node:assert/strict');
const Imu = require('../js/modules/imu-model.js');
const Bal = require('../js/modules/balanza-model.js');
const Pre = require('../js/modules/presion-model.js');
const Flu = require('../js/modules/flujo-model.js');
const P = require('../js/core/physics.js');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} esperado ${b} ± ${tol}, obtenido ${a}`);

// ---------- IMU ----------
test('IMU: ángulo de referencia por seno y su incertidumbre', () => {
    const cfg = { ...Imu.defaultConfig(), L_mm: 1000, resRef: 1, uL_mm: 1 };
    const r = Imu.referenceAngle(cfg, 500);
    close(r.theta, 30, 1e-9);
    // u_d = √2·1/√12 mm ; dθ/dd = 1/(L cos30°) ; dθ/dL = −tan30°/L
    const ud = Math.SQRT2 / Math.sqrt(12);
    const expected = Math.hypot(ud / (1000 * Math.cos(Math.PI / 6)), Math.tan(Math.PI / 6) / 1000) * 180 / Math.PI;
    close(r.u, expected, 1e-12);
});

test('IMU: método de cuerda', () => {
    const cfg = { ...Imu.defaultConfig(), refMethod: 'cuerda', r_mm: 100 };
    close(Imu.referenceAngle(cfg, 100).theta, 60, 1e-9); // cuerda = r → 60°
});

test('IMU: envolvente angular para yaw', () => {
    assert.equal(Imu.wrapDeg(359 - 1), -2);
    assert.equal(Imu.wrapDeg(1 - 359), 2);
    assert.equal(Imu.wrapDeg(180), 180);
});

test('IMU: sin flexión, θ esperado = θ de referencia; con flexión el IMU ve más ángulo', () => {
    const cfg = Imu.defaultConfig();
    const a = Imu.expectedAngle(cfg, 200);
    assert.equal(a.thetaExp, a.theta);
    const cfgF = { ...cfg, flex: { enabled: true, tipMass_g: 300, EI_Nm2: 20, barLength_mm: 1000, sensorPos_mm: 1000, dAtTip: false } };
    const b = Imu.expectedAngle(cfgF, 200);
    // φ = m g sinθ L² / (2EI)
    const th = Math.asin(0.2);
    const phi = 0.3 * P.gLocal(-39.81, 10) * Math.sin(th) * 1 / (2 * 20) * 180 / Math.PI;
    close(b.phi, phi, 1e-9);
    close(b.thetaExp, b.theta + phi, 1e-9);
});

test('IMU: flexión con d medido en la punta resuelve d = L sinθ + δ cosθ', () => {
    const cfg = { ...Imu.defaultConfig(), flex: { enabled: true, tipMass_g: 500, EI_Nm2: 10, barLength_mm: 1000, sensorPos_mm: 1000, dAtTip: true } };
    const e = Imu.expectedAngle(cfg, 300);
    const th = e.thetaPivot * Math.PI / 180;
    const F = 0.5 * P.gLocal(-39.81, 10) * Math.sin(th);
    const delta = P.cantileverDeflection(F, 1, 1, 10);
    close(Math.sin(th) + delta * Math.cos(th), 0.3, 1e-9);
    assert.ok(e.thetaPivot < e.theta);
});

test('IMU: el análisis recupera ganancia y acoplamiento del ejemplo', () => {
    const cfg = { ...Imu.defaultConfig(), axis: 'pitch', cycles: 5 };
    const { rows, truth } = Imu.exampleData(cfg);
    const r = Imu.analyze(cfg, rows);
    assert.ok(r.ok);
    close(r.metrics.gain, truth.gain, 0.01, 'ganancia');
    const roll = r.crosstalk.find(c => c.axis === 'roll');
    close(roll.slope, truth.cross.roll, 0.01, 'crosstalk roll');
    close(r.metrics.hysteresis, truth.hyst, 0.1, 'histéresis');
    assert.ok(r.metrics.repeatability < 0.2);
});

test('IMU: yaw con heading cerca de 0/360 no produce saltos', () => {
    const cfg = { ...Imu.defaultConfig(), axis: 'yaw', refMethod: 'directo', levels: [-20, -10, 10, 20], resRef: 0.1 };
    const rows = [];
    for (let c = 1; c <= 2; c++) {
        rows.push({ cycle: c, dir: 'cero', ref: 0, pitch: 0, roll: 0, yaw: 355 });
        for (const v of [-20, -10, 10, 20]) rows.push({ cycle: c, dir: 'sube', ref: v, pitch: 0, roll: 0, yaw: ((355 + v) % 360 + 360) % 360 });
    }
    const r = Imu.analyze(cfg, rows);
    close(r.metrics.gain, 1, 1e-9);
    close(r.metrics.maxErr, 0, 1e-9);
});

test('IMU: matriz multi-eje invierte el acoplamiento', () => {
    const mk = (axis, gain, cross) => ({ axis, res: { metrics: { gain, offset: 0 }, crosstalk: Object.entries(cross).map(([a, s]) => ({ axis: a, slope: s, offset: 0 })) } });
    const m = Imu.multiAxis([mk('pitch', 1.02, { roll: 0.03, yaw: 0 }), mk('roll', 0.98, { pitch: -0.02, yaw: 0 }), mk('yaw', 1, { pitch: 0, roll: 0 })]);
    close(m.A[1][0], 0.03, 1e-12);
    close(m.A[0][1], -0.02, 1e-12);
    const I = m.A.map((row, i) => m.C[0].map((_, j) => row.reduce((s, v, k) => s + v * m.C[k][j], 0)));
    close(I[0][1], 0, 1e-12);
});

test('IMU: flexión 3 puntos recupera EI', () => {
    const EI = 25, Ls = 1, a = 0.5, g = P.gLocal(-39.81, 0);
    const c = P.simplySupportedCompliance(a, Ls) / EI;
    const rows = [0, 200, 400, 600].map(m => ({ mass_g: m, reading_mm: 800 - 1000 * c * (m / 1000) * g }));
    const r = Imu.flexion({ span_mm: 1000, loadPos_mm: 500, lat: -39.81, alt: 0 }, rows);
    assert.ok(r.ok);
    close(r.EI, EI, 1e-6);
});

// ---------- Balanza ----------
test('Balanza: recupera los factores k de las 4 celdas y el CoP', () => {
    const cfg = Bal.defaultConfig();
    const { rows, truth } = Bal.exampleData(cfg);
    const r = Bal.analyze(cfg, rows);
    assert.ok(r.ok, r.warnings.join(' | '));
    r.k.forEach((k, i) => close(k / truth.k[i], 1, 0.01, `k${i + 1}`));
    assert.ok(r.metrics.rmsCoP < 2, `CoP RMS ${r.metrics.rmsCoP}`);
    assert.ok(r.metrics.hystFpct > 0.05 && r.metrics.hystFpct < 0.5, `histéresis ${r.metrics.hystFpct}`);
});

test('Balanza: sin tara no calibra', () => {
    const cfg = Bal.defaultConfig();
    const { rows } = Bal.exampleData(cfg);
    assert.equal(Bal.analyze(cfg, rows.filter(r => r.dir !== 'tara')).ok, false);
});

// ---------- Presión ----------
test('Presión: referencia de tubo en U', () => {
    const cfg = Pre.defaultConfig();
    const ref = Pre.reference(cfg, { hA: 100, hB: 300 });
    const expected = (P.waterDensity(20) - P.airDensity(20, 1013, 60)) * P.gLocal(-39.81, 10) * 0.2;
    close(ref.dP, expected, 1e-9);
    close(ref.dP, 1954.4, 0.5);
});

test('Presión: recupera sensibilidad del ejemplo y elige modelo lineal', () => {
    const cfg = Pre.defaultConfig();
    const { rows, truth } = Pre.exampleData(cfg);
    const r = Pre.analyze(cfg, rows);
    assert.ok(r.ok);
    assert.equal(r.metrics.deg, 1);
    close(r.metrics.sens_mV_kPa, truth.sens * 1e6, 5, 'sensibilidad');
    close(r.metrics.zeroV, truth.V0, 0.01, 'cero');
    const cal = Pre.exportCalibration(cfg, r);
    close(cal.coef[0] + cal.coef[1] * 1.1, (1.1 - truth.V0) / truth.sens, 30);
});

// ---------- Flujo ----------
test('Venturi: recupera C_d', () => {
    const cfg = Flu.defaultConfig('venturi');
    const { rows, cal } = Flu.exampleData(cfg);
    cfg.calA = cal;
    const r = Flu.analyze(cfg, rows);
    assert.ok(r.ok, r.warnings.join(' | '));
    close(r.metrics.C, 0.965, 0.01);
});

test('Pitot: recupera C', () => {
    const cfg = Flu.defaultConfig('pitot');
    const { rows, cal } = Flu.exampleData(cfg);
    cfg.calA = cal;
    const r = Flu.analyze(cfg, rows);
    assert.ok(r.ok, r.warnings.join(' | '));
    close(r.metrics.C, 0.99, 0.01);
});

test('Flujo: sin calibración de presión no analiza', () => {
    assert.equal(Flu.analyze(Flu.defaultConfig('venturi'), []).ok, false);
});

test('IMU: acelerómetro 3 DOF analiza sin yaw y rechaza evaluar yaw', () => {
    const cfg = { ...Imu.defaultConfig(), sensor: { ...Imu.defaultConfig().sensor, dof: 'acc3' }, axis: 'roll', cycles: 3 };
    const { rows } = Imu.exampleData(cfg);
    assert.ok(rows.every(r => r.yaw === undefined));
    const r = Imu.analyze(cfg, rows);
    assert.ok(r.ok, r.warnings.join(' | '));
    assert.equal(r.crosstalk.length, 1);
    assert.equal(Imu.analyze({ ...cfg, axis: 'yaw' }, rows).ok, false);
});
