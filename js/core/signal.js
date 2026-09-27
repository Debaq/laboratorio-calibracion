/*
 * LabSignal — procesamiento de series de tiempo: filtro Butterworth de fase cero,
 * ajuste de círculo, desenvolvimiento de fase y métricas de estabilometría.
 */
(function (root, factory) {
    const req = n => (typeof require === 'function') ? require(n) : null;
    const S = req('./stats.js') || root.LabStats;
    const L = req('./linalg.js') || root.LabLinalg;
    const m = factory(S, L);
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.LabSignal = m;
})(typeof self !== 'undefined' ? self : this, function (S, L) {
    'use strict';

    /**
     * Frecuencia de muestreo media ((n−1)/duración; robusta a tiempos redondeados a ms),
     * variación del intervalo (jitter) y saltos (> 3 intervalos medianos).
     */
    function sampling(t) {
        const dt = [];
        for (let i = 1; i < t.length; i++) dt.push(t[i] - t[i - 1]);
        const med = dt.slice().sort((a, b) => a - b)[Math.floor(dt.length / 2)];
        const duration = t[t.length - 1] - t[0];
        const fs = (t.length - 1) / duration;
        return { fs, dt: 1 / fs, jitter: S.sd(dt), gaps: dt.filter(d => d > 3 * med).length, duration };
    }

    /** Butterworth pasa bajos de 2º orden (transformación bilineal). */
    function butter2(fc, fs) {
        const K = Math.tan(Math.PI * fc / fs);
        const n = 1 / (1 + Math.SQRT2 * K + K * K);
        const b0 = K * K * n;
        return { b: [b0, 2 * b0, b0], a: [2 * (K * K - 1) * n, (1 - Math.SQRT2 * K + K * K) * n] };
    }

    function lfilter(c, x) {
        const y = new Array(x.length);
        let x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0]; // estado inicial estacionario (ganancia DC = 1)
        for (let i = 0; i < x.length; i++) {
            const v = c.b[0] * x[i] + c.b[1] * x1 + c.b[2] * x2 - c.a[0] * y1 - c.a[1] * y2;
            x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
        }
        return y;
    }

    /**
     * Filtro de fase cero (adelante y atrás): no desplaza la señal en el tiempo.
     * Equivale a 4º orden; la atenuación en fc es −6 dB. fc ≤ 0 o ≥ fs/2 → sin filtrar.
     */
    function lowpass(x, fc, fs) {
        if (!(fc > 0) || fc >= fs / 2 || x.length < 8) return x.slice();
        const c = butter2(fc, fs);
        const pad = Math.min(x.length - 1, 3 * Math.ceil(fs / fc));
        const ext = [];
        for (let i = pad; i >= 1; i--) ext.push(2 * x[0] - x[i]);
        ext.push(...x);
        for (let i = 1; i <= pad; i++) ext.push(2 * x[x.length - 1] - x[x.length - 1 - i]);
        const y = lfilter(c, lfilter(c, ext).reverse()).reverse();
        return y.slice(pad, pad + x.length);
    }

    /** Ajuste algebraico de círculo (Kåsa): x² + y² + D x + E y + F = 0. */
    function circleFit(x, y) {
        const A = x.map((xi, i) => [xi, y[i], 1]);
        const b = x.map((xi, i) => -(xi * xi + y[i] * y[i]));
        const s = L.lstsq(A, b).x;
        const xc = -s[0] / 2, yc = -s[1] / 2;
        const R = Math.sqrt(xc * xc + yc * yc - s[2]);
        const radial = x.map((xi, i) => Math.hypot(xi - xc, y[i] - yc) - R);
        return { xc, yc, R, radialRms: S.rms(radial), radial };
    }

    function unwrap(ph) {
        const out = [ph[0]];
        for (let i = 1; i < ph.length; i++) {
            let d = ph[i] - ph[i - 1];
            d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
            out.push(out[i - 1] + d);
        }
        return out;
    }

    /** Amplitud de la componente de frecuencia ω en la señal (proyección seno/coseno). */
    function toneAmplitude(t, x, w) {
        const m = S.mean(x);
        let c = 0, s = 0;
        for (let i = 0; i < x.length; i++) { c += (x[i] - m) * Math.cos(w * t[i]); s += (x[i] - m) * Math.sin(w * t[i]); }
        return 2 * Math.hypot(c, s) / x.length;
    }

    /**
     * Métricas de estabilometría del CoP (mm, s):
     * RMS, rango, largo de trayectoria, velocidad media y área de la elipse de predicción del 95 %
     * (área = π·χ²₀.₉₅,₂·√det Σ, con χ² = 5,991).
     */
    function swayMetrics(t, x, y) {
        const n = x.length, T = t[n - 1] - t[0];
        const mx = S.mean(x), my = S.mean(y);
        const xs = x.map(v => v - mx), ys = y.map(v => v - my);
        let path = 0, pathX = 0, pathY = 0;
        for (let i = 1; i < n; i++) {
            const dx = x[i] - x[i - 1], dy = y[i] - y[i - 1];
            path += Math.hypot(dx, dy); pathX += Math.abs(dx); pathY += Math.abs(dy);
        }
        const sxx = S.variance(xs), syy = S.variance(ys);
        const sxy = S.sum(xs.map((v, i) => v * ys[i])) / (n - 1);
        const det = sxx * syy - sxy * sxy;
        const tr = (sxx + syy) / 2, dd = Math.sqrt(Math.max(tr * tr - det, 0));
        const l1 = tr + dd, l2 = tr - dd;
        const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        const fx = S.polyfit(t, x, 1), fy = S.polyfit(t, y, 1);
        return {
            n, T, meanX: mx, meanY: my,
            rmsX: Math.sqrt(sxx * (n - 1) / n), rmsY: Math.sqrt(syy * (n - 1) / n),
            rangeX: Math.max(...x) - Math.min(...x), rangeY: Math.max(...y) - Math.min(...y),
            path, velMean: path / T, velX: pathX / T, velY: pathY / T,
            area95: Math.PI * 5.991 * Math.sqrt(Math.max(det, 0)),
            ellipse: { a: Math.sqrt(5.991 * l1), b: Math.sqrt(5.991 * Math.max(l2, 0)), angle: ang, cx: mx, cy: my },
            driftX: fx.coef[1], driftY: fy.coef[1]
        };
    }

    /**
     * Desviación de Allan solapada de una señal de tasa (p. ej. giroscopio en °/s) muestreada a fs.
     * σ²(τ) = 1/(2τ²(N−2m)) Σ (θ[k+2m] − 2θ[k+m] + θ[k])²,  θ = integral de la señal, τ = m/fs.
     */
    function allanDeviation(x, fs, points = 40) {
        const N = x.length, t0 = 1 / fs;
        const theta = new Float64Array(N + 1);
        for (let i = 0; i < N; i++) theta[i + 1] = theta[i] + x[i] * t0;
        const mMax = Math.floor((N - 1) / 2);
        const ms = [...new Set(Array.from({ length: points }, (_, i) => Math.round(10 ** (Math.log10(mMax) * i / (points - 1)))))].filter(m => m >= 1 && m <= mMax);
        return ms.map(m => {
            const tau = m * t0;
            let s = 0;
            const K = N + 1 - 2 * m;
            for (let k = 0; k < K; k++) { const d = theta[k + 2 * m] - 2 * theta[k + m] + theta[k]; s += d * d; }
            return { tau, adev: Math.sqrt(s / (2 * tau * tau * K)), n: K };
        });
    }

    /**
     * Ajuste algebraico de elipsoide a puntos 3D (magnetómetro / acelerómetro):
     *   (p − c)ᵀ Q (p − c) = 1.  Devuelve centro c, matriz de forma Q, radios y la matriz de corrección
     *   W = R·Q^½ tal que |W (p − c)| = R  (R = radio medio que conserva el volumen, o el indicado).
     */
    function ellipsoidFit(P, Rtarget) {
        const A = P.map(([x, y, z]) => [x * x, y * y, z * z, 2 * x * y, 2 * x * z, 2 * y * z, 2 * x, 2 * y, 2 * z]);
        const s = L.lstsq(A, P.map(() => 1)).x;
        const M = [[s[0], s[3], s[4]], [s[3], s[1], s[5]], [s[4], s[5], s[2]]];
        const v = [s[6], s[7], s[8]];
        const c = L.matvec(L.inv(M), v).map(u => -u);
        const k = 1 + c.reduce((acc, ci, i) => acc + ci * M[i].reduce((a2, mij, j) => a2 + mij * c[j], 0), 0);
        const Q = M.map(r => r.map(u => u / k));
        const eig = L.eigSym(Q);
        if (eig.values.some(l => !(l > 0))) throw new Error('Los datos no forman un elipsoide: gire el sensor en TODAS las direcciones.');
        const radii = eig.values.map(l => 1 / Math.sqrt(l));
        const R = Rtarget > 0 ? Rtarget : Math.cbrt(radii[0] * radii[1] * radii[2]);
        const W = L.symFun(Q, l => R * Math.sqrt(l));
        const norms = pts => pts.map(p => Math.hypot(...p));
        const corrected = P.map(p => L.matvec(W, p.map((u, i) => u - c[i])));
        return { center: c, Q, radii, R, W, corrected, before: norms(P.map(p => p.map((u, i) => u - c[i]))), after: norms(corrected), rawNorm: norms(P) };
    }

    /**
     * Respuesta a un escalón de un sistema de primer orden: y = y∞ + (y0 − y∞)·e^(−(t − t0)/τ).
     * Se ajusta ln|y∞ − y| lineal en t entre el 10 % y el 90 % del cambio.
     */
    function firstOrderStep(t, y) {
        const n = y.length, q = Math.max(3, Math.floor(n * 0.08));
        const med = a => { const s = a.slice().sort((p, r) => p - r); return s[Math.floor(s.length / 2)]; };
        const y0 = med(y.slice(0, q)), yEnd = med(y.slice(n - q));
        const span0 = yEnd - y0;
        if (!(Math.abs(span0) > 0)) throw new Error('No se detecta un escalón en la señal.');
        const frac0 = y.map(v => (v - y0) / span0);
        const i10 = frac0.findIndex(f => f >= 0.1), i90 = frac0.findIndex(f => f >= 0.9);
        if (i10 < 0 || i90 <= i10 + 2) throw new Error('El escalón es muy rápido para el muestreo o no llega al 90 %.');

        // Para un y∞ dado: ajuste log-lineal entre 10 % y 90 % → (τ, t0); error del modelo en todo el tramo posterior
        const fitFor = yInf => {
            const span = yInf - y0, tt = [], ll = [];
            for (let i = i10; i <= i90; i++) { const r = (yInf - y[i]) / span; if (r > 0) { tt.push(t[i]); ll.push(Math.log(r)); } }
            if (tt.length < 3) return null;
            const f = S.polyfit(tt, ll, 1);
            const tau = -1 / f.coef[1], t0 = f.coef[0] * tau;
            let rss = 0;
            for (let i = i10; i < n; i++) { const m = yInf - span * Math.exp(-(t[i] - t0) / tau); rss += (y[i] - m) ** 2; }
            return { tau, t0, rss, r2: f.r2, span };
        };
        // y∞ se refina (sección áurea): el registro puede terminar antes de estabilizarse del todo
        let a = yEnd - 0.1 * span0, b = yEnd + 0.1 * span0;
        const gr = (Math.sqrt(5) - 1) / 2, cost = v => { const r = fitFor(v); return r && r.tau > 0 ? r.rss : Infinity; };
        let c = b - gr * (b - a), d = a + gr * (b - a), fc = cost(c), fd = cost(d);
        for (let k = 0; k < 60; k++) {
            if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = cost(c); }
            else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = cost(d); }
        }
        const yInf = (a + b) / 2, best = fitFor(yInf);
        const { tau, t0, span } = best;
        const frac = y.map(v => (v - y0) / span);
        const cross = level => { const i = frac.findIndex(v => v >= level); return i > 0 ? t[i - 1] + (t[i] - t[i - 1]) * (level - frac[i - 1]) / (frac[i] - frac[i - 1]) : NaN; };
        return { y0, yInf, span, tau, t0, t63: cross(0.632) - t0, t90: cross(0.9) - t0, r2: best.r2, settled: Math.abs(yInf - yEnd) < 0.01 * Math.abs(span),
            model: tv => tv < t0 ? y0 : yInf - span * Math.exp(-(tv - t0) / tau) };
    }

    return { sampling, butter2, lowpass, circleFit, unwrap, toneAmplitude, swayMetrics, allanDeviation, ellipsoidFit, firstOrderStep };
});
