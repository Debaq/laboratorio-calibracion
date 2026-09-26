// Pruebas del núcleo matemático. Ejecutar con: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/core/linalg.js');
const S = require('../js/core/stats.js');
const P = require('../js/core/physics.js');
const U = require('../js/core/uncertainty.js');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} esperado ${b}, obtenido ${a}`);

test('lstsq resuelve un sistema exacto', () => {
    const A = [[1, 1], [1, 2], [1, 3]];
    const r = L.lstsq(A, [3, 5, 7]);
    close(r.x[0], 1, 1e-12);
    close(r.x[1], 2, 1e-12);
    close(r.rss, 0, 1e-20);
});

test('lstsq detecta sistema singular', () => {
    assert.throws(() => L.lstsq([[1, 2], [2, 4], [3, 6]], [1, 2, 3]));
});

test('inv de 3x3', () => {
    const A = [[2, 0, 1], [1, 3, 0], [0, 1, 4]];
    const I = L.matmul(A, L.inv(A));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(I[i][j], i === j ? 1 : 0, 1e-12);
});

test('desviación estándar muestral usa n−1', () => {
    close(S.sd([2, 4, 4, 4, 5, 5, 7, 9]), 2.13809, 1e-5);
});

test('cuantiles t y F coinciden con tablas', () => {
    close(S.tInv(0.95, 10), 2.2281, 1e-3);
    close(S.tInv(0.95, 2), 4.3027, 1e-3);
    close(S.tInv(0.9545, 1e6), 2.0, 1e-3);
    close(1 - S.fCdf(4.96, 1, 10), 0.05, 1e-3);
});

test('regresión lineal: coeficientes y errores estándar (Anscombe I)', () => {
    const x = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5];
    const y = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68];
    const f = S.polyfit(x, y, 1);
    close(f.coef[0], 3.0001, 1e-3);
    close(f.coef[1], 0.5001, 1e-3);
    close(f.se[1], 0.1179, 1e-3);
    close(f.r2, 0.6665, 1e-3);
});

test('polyfit grado 2 recupera una parábola y la prueba F la detecta', () => {
    const x = [0, 1, 2, 3, 4, 5, 6, 7];
    const noise = [0.01, -0.02, 0.015, 0, -0.01, 0.02, -0.015, 0.005];
    const y = x.map((v, i) => 1 + 2 * v + 0.3 * v * v + noise[i]);
    const f1 = S.polyfit(x, y, 1), f2 = S.polyfit(x, y, 2);
    close(f2.coef[2], 0.3, 5e-3);
    assert.ok(S.fTestNested(f1, f2).p < 0.001);
});

test('recta por el origen', () => {
    const f = S.polyfit([1, 2, 3], [2, 4, 6.1], 1, { origin: true });
    assert.equal(f.coef[0], 0);
    close(f.coef[1], (2 + 8 + 18.3) / 14, 1e-12);
});

test('densidad del agua (Tanaka 2001)', () => {
    close(P.waterDensity(4), 999.975, 2e-3);
    close(P.waterDensity(20), 998.207, 2e-3);
    close(P.waterDensity(25), 997.047, 2e-3);
});

test('gravedad local', () => {
    close(P.gLocal(0), 9.7803, 1e-4);
    close(P.gLocal(-39.81, 10), 9.8015, 2e-4);
    close(P.gLocal(45), 9.8062, 2e-4);
});

test('densidad y viscosidad del aire', () => {
    close(P.airDensity(20, 1013.25, 0), 1.2041, 2e-3);
    close(P.airViscosity(20), 1.81e-5, 5e-7);
    close(P.waterViscosity(20), 1.002e-3, 2e-5);
});

test('voladizo: fórmulas clásicas en la punta', () => {
    const F = 10, Lb = 1, EI = 100;
    close(P.cantileverDeflection(F, Lb, Lb, EI), F / (3 * EI), 1e-12);
    close(P.cantileverSlope(F, Lb, Lb, EI), F / (2 * EI), 1e-12);
});

test('incertidumbre tipo B y combinación', () => {
    close(U.fromResolution(1), 0.288675, 1e-6);
    close(U.combine(3, 4), 5, 1e-12);
});
