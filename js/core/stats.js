/*
 * LabStats — estadística para calibración: descriptiva, distribuciones t y F,
 * ajuste polinomial por mínimos cuadrados con incertidumbre de predicción.
 */
(function (root, factory) {
    const L = (typeof require === 'function') ? require('./linalg.js') : root.LabLinalg;
    const m = factory(L);
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.LabStats = m;
})(typeof self !== 'undefined' ? self : this, function (L) {
    'use strict';

    // ---------- Descriptiva ----------
    const sum = a => a.reduce((s, x) => s + x, 0);
    const mean = a => (a.length ? sum(a) / a.length : NaN);

    /** Varianza muestral (divide por n − 1). */
    function variance(a) {
        if (a.length < 2) return NaN;
        const m = mean(a);
        return sum(a.map(x => (x - m) ** 2)) / (a.length - 1);
    }
    const sd = a => Math.sqrt(variance(a));
    const rms = a => Math.sqrt(mean(a.map(x => x * x)));
    const maxAbs = a => Math.max(...a.map(Math.abs));

    /** Desviación estándar combinada de varios grupos (repetibilidad). */
    function pooledSD(groups) {
        let num = 0, den = 0;
        for (const g of groups) {
            if (g.length < 2) continue;
            num += (g.length - 1) * variance(g);
            den += g.length - 1;
        }
        return den > 0 ? { s: Math.sqrt(num / den), df: den } : { s: NaN, df: 0 };
    }

    function groupBy(arr, keyFn) {
        const map = new Map();
        for (const item of arr) {
            const k = keyFn(item);
            if (!map.has(k)) map.set(k, []);
            map.get(k).push(item);
        }
        return map;
    }

    // ---------- Funciones especiales ----------
    function lnGamma(z) {
        const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
            -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
        let x = z, y = z, tmp = x + 5.5;
        tmp -= (x + 0.5) * Math.log(tmp);
        let ser = 1.000000000190015;
        for (const cj of c) ser += cj / ++y;
        return -tmp + Math.log(2.5066282746310005 * ser / x);
    }

    function betacf(a, b, x) {
        const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
        let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
        if (Math.abs(d) < FPMIN) d = FPMIN;
        d = 1 / d;
        let h = d;
        for (let m = 1; m <= MAXIT; m++) {
            const m2 = 2 * m;
            let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
            d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
            c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
            d = 1 / d; h *= d * c;
            aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
            d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
            c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
            d = 1 / d;
            const del = d * c;
            h *= del;
            if (Math.abs(del - 1) < EPS) break;
        }
        return h;
    }

    /** Beta incompleta regularizada I_x(a, b). */
    function ibeta(x, a, b) {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
        return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
    }

    /** CDF de t de Student. */
    function tCdf(t, df) {
        const x = df / (df + t * t);
        const tail = 0.5 * ibeta(x, df / 2, 0.5);
        return t >= 0 ? 1 - tail : tail;
    }

    /** Cuantil bilateral: t tal que P(|T| ≤ t) = p. Ej.: tInv(0.95, 10) = 2.228. */
    function tInv(p, df) {
        if (!isFinite(df) || df > 1e6) df = 1e6;
        let lo = 0, hi = 1e4;
        const target = 0.5 + p / 2;
        for (let i = 0; i < 200; i++) {
            const mid = (lo + hi) / 2;
            if (tCdf(mid, df) < target) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    /** CDF de F de Fisher. */
    function fCdf(f, d1, d2) {
        if (f <= 0) return 0;
        return ibeta(d1 * f / (d1 * f + d2), d1 / 2, d2 / 2);
    }

    /** Factor de cobertura k para ~95,45 % (equivale a k = 2 con muchos grados de libertad). */
    function coverageK(df, p = 0.9545) {
        return df > 0 && isFinite(df) ? tInv(p, df) : 2;
    }

    // ---------- Ajustes ----------
    /**
     * Ajuste polinomial y = c0 + c1 x + … + c_deg x^deg por mínimos cuadrados.
     * opts.origin = true fuerza c0 = 0 (recta por el origen).
     * Devuelve coeficientes, covarianza, SEE, R², residuos y funciones de predicción.
     */
    function polyfit(x, y, deg = 1, opts = {}) {
        const origin = !!opts.origin;
        const powers = [];
        for (let p = origin ? 1 : 0; p <= deg; p++) powers.push(p);
        const A = x.map(xi => powers.map(p => xi ** p));
        const sol = L.lstsq(A, y);

        const coef = new Array(deg + 1).fill(0);
        powers.forEach((p, i) => { coef[p] = sol.x[i]; });
        const cov = L.zeros(deg + 1, deg + 1);
        powers.forEach((p, i) => powers.forEach((q, j) => { cov[p][q] = sol.cov[i][j]; }));

        const n = x.length;
        const see = Math.sqrt(sol.s2);
        const my = mean(y);
        const ssTot = origin ? sum(y.map(v => v * v)) : sum(y.map(v => (v - my) ** 2));
        const r2 = 1 - sol.rss / ssTot;

        const predict = xv => coef.reduce((s, c, p) => s + c * xv ** p, 0);
        /** Incertidumbre estándar de la curva ajustada en xv (sin ruido de una observación nueva). */
        const uFit = xv => {
            const g = coef.map((_, p) => xv ** p);
            let v = 0;
            for (let i = 0; i <= deg; i++) for (let j = 0; j <= deg; j++) v += g[i] * cov[i][j] * g[j];
            return Math.sqrt(Math.max(v, 0));
        };
        /** Incertidumbre estándar al predecir una observación nueva en xv. */
        const uPred = xv => Math.sqrt(sol.s2 + uFit(xv) ** 2);
        const se = coef.map((_, p) => Math.sqrt(cov[p][p]));

        return {
            deg, origin, coef, se, cov, n, df: sol.df, rss: sol.rss, see, r2,
            residuals: sol.residuals, fitted: sol.fitted,
            predict, uFit, uPred,
            nParams: powers.length
        };
    }

    /** Prueba F para modelos anidados: ¿el modelo 2 (más parámetros) mejora significativamente? */
    function fTestNested(fit1, fit2) {
        const d1 = fit2.nParams - fit1.nParams, d2 = fit2.df;
        if (d1 <= 0 || d2 <= 0) return { F: NaN, p: NaN };
        const F = ((fit1.rss - fit2.rss) / d1) / (fit2.rss / d2);
        return { F, p: 1 - fCdf(F, d1, d2) };
    }

    return {
        sum, mean, variance, sd, rms, maxAbs, pooledSD, groupBy,
        lnGamma, ibeta, tCdf, tInv, fCdf, coverageK,
        polyfit, fTestNested
    };
});
