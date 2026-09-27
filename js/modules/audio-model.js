/*
 * LabAudio — análisis de estímulos auditivos grabados (tonos, tone bursts, ruido con gaps, clicks).
 *
 *  - Lectura y escritura de WAV (PCM 8/16/24/32 bits y coma flotante 32/64, WAVE_FORMAT_EXTENSIBLE, RF64).
 *  - Envolvente por la transformada de Hilbert (señal analítica), por bloques con solape: sirve para archivos largos.
 *  - Detección de estímulos por umbral relativo al pico, con fusión de silencios cortos.
 *  - Por estímulo: instantes al 10/50/90 % de la meseta (interpolados entre muestras), subida y bajada 10–90 %,
 *    duraciones, forma y duración nominal de la rampa (lineal, coseno, coseno²), frecuencia (FFT con relleno de ceros
 *    e interpolación parabólica), tonalidad, THD, banda, nivel RMS y pico en dBFS y recortes.
 *  - Intervalos entre estímulos, clases (frecuencia × duración), ítems/secuencias y patrón (G/A, C/L).
 *  - Espectrograma (STFT) de un tramo.
 *
 * Convención de nivel: dBFS referido a una sinusoide de escala completa (AES17): un seno de amplitud 1 = 0 dBFS RMS.
 */
(function (root, factory) {
    const m = factory();
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.LabAudio = m;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---------------- Utilidades numéricas ----------------
    const nextPow2 = n => { let p = 1; while (p < n) p <<= 1; return p; };
    const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
    const sd = a => {
        if (a.length < 2) return NaN;
        const m = mean(a);
        return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
    };
    /** Resumen de una lista: n, media, DE, mínimo y máximo (ignora NaN). */
    function summary(vals) {
        const v = vals.filter(isFinite);
        return { n: v.length, mean: mean(v), sd: sd(v), min: v.length ? Math.min(...v) : NaN, max: v.length ? Math.max(...v) : NaN };
    }
    function percentile(arr, p) {
        if (!arr.length) return NaN;
        const s = Float64Array.from(arr).sort();
        const k = (s.length - 1) * p, i = Math.floor(k);
        return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (k - i) : s[i];
    }
    const db = v => 20 * Math.log10(v);

    // ---------------- WAV ----------------
    /** Lee un WAV. Devuelve { fs, channels: [Float32Array…] (escala ±1), bits, format: 'pcm'|'float', n, duration }. */
    function parseWav(buf) {
        const dv = new DataView(buf);
        const tag = o => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
        if (buf.byteLength < 12 || !['RIFF', 'RF64'].includes(tag(0)) || tag(8) !== 'WAVE') throw new Error('No es un archivo WAV (RIFF/WAVE).');
        let fmt = null, data = null, o = 12;
        while (o + 8 <= buf.byteLength) {
            const id = tag(o), body = o + 8;
            let size = dv.getUint32(o + 4, true);
            if (id === 'fmt ') {
                let code = dv.getUint16(body, true);
                if (code === 0xFFFE && size >= 26) code = dv.getUint16(body + 24, true); // EXTENSIBLE: subformato en el GUID
                fmt = { code, ch: dv.getUint16(body + 2, true), fs: dv.getUint32(body + 4, true), align: dv.getUint16(body + 12, true), bits: dv.getUint16(body + 14, true) };
            } else if (id === 'data') {
                if (size === 0xFFFFFFFF || body + size > buf.byteLength) size = buf.byteLength - body; // RF64 o encabezado truncado
                data = { offset: body, size };
                if (fmt) break;
            }
            o = body + size + (size & 1);
        }
        if (!fmt) throw new Error('WAV sin bloque "fmt ".');
        if (!data) throw new Error('WAV sin bloque de datos.');
        if (fmt.code !== 1 && fmt.code !== 3) throw new Error(`Codificación WAV no soportada (código ${fmt.code}). Exporte como PCM o coma flotante.`);
        const bps = fmt.align / fmt.ch;
        const n = Math.floor(data.size / fmt.align);
        const channels = Array.from({ length: fmt.ch }, () => new Float32Array(n));
        const rd = {
            1: p => (dv.getUint8(p) - 128) / 128,
            2: p => dv.getInt16(p, true) / 32768,
            3: p => { const v = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16); return v / 8388608; },
            4: fmt.code === 3 ? p => dv.getFloat32(p, true) : p => dv.getInt32(p, true) / 2147483648,
            8: p => dv.getFloat64(p, true)
        }[bps];
        if (!rd || (fmt.code === 3 && bps !== 4 && bps !== 8)) throw new Error(`Formato de muestra no soportado (${fmt.bits} bits).`);
        for (let i = 0, p = data.offset; i < n; i++)
            for (let c = 0; c < fmt.ch; c++, p += bps) channels[c][i] = rd(p);
        return { fs: fmt.fs, channels, bits: fmt.bits, format: fmt.code === 3 ? 'float' : 'pcm', n, duration: n / fmt.fs };
    }

    /** WAV en coma flotante de 32 bits (sin pérdida para lo grabado por el navegador). */
    function encodeWav(channels, fs) {
        const ch = channels.length, n = channels[0].length, bytes = n * ch * 4;
        const buf = new ArrayBuffer(58 + bytes), dv = new DataView(buf);
        const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
        w(0, 'RIFF'); dv.setUint32(4, 50 + bytes, true); w(8, 'WAVE');
        w(12, 'fmt '); dv.setUint32(16, 18, true); dv.setUint16(20, 3, true); dv.setUint16(22, ch, true);
        dv.setUint32(24, fs, true); dv.setUint32(28, fs * ch * 4, true); dv.setUint16(32, ch * 4, true); dv.setUint16(34, 32, true); dv.setUint16(36, 0, true);
        w(38, 'fact'); dv.setUint32(42, 4, true); dv.setUint32(46, n, true);
        w(50, 'data'); dv.setUint32(54, bytes, true);
        for (let i = 0, p = 58; i < n; i++) for (let c = 0; c < ch; c++, p += 4) dv.setFloat32(p, channels[c][i], true);
        return buf;
    }

    // ---------------- FFT (radix 2, en el lugar) ----------------
    const twiddles = new Map();
    function fft(re, im, inverse = false) {
        const n = re.length;
        if (n & (n - 1)) throw new Error('fft: el largo debe ser potencia de 2');
        let tw = twiddles.get(n);
        if (!tw) {
            tw = { c: new Float64Array(n / 2), s: new Float64Array(n / 2) };
            for (let k = 0; k < n / 2; k++) { tw.c[k] = Math.cos(2 * Math.PI * k / n); tw.s[k] = Math.sin(2 * Math.PI * k / n); }
            if (twiddles.size > 12) twiddles.clear();
            twiddles.set(n, tw);
        }
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        const sg = inverse ? 1 : -1;
        for (let len = 2; len <= n; len <<= 1) {
            const half = len >> 1, step = n / len;
            for (let i = 0; i < n; i += len) {
                for (let k = 0; k < half; k++) {
                    const wr = tw.c[k * step], wi = sg * tw.s[k * step];
                    const a = i + k, b = a + half;
                    const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                }
            }
        }
        if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }

    // ---------------- Envolvente ----------------
    /**
     * Envolvente |x + j·H{x}| por bloques de 65 536 muestras con 4096 de margen a cada lado
     * (el error del borde circular queda bajo −80 dB). Resta la media antes.
     */
    function envelope(x) {
        const n = x.length, env = new Float32Array(n);
        let m = 0;
        for (let i = 0; i < n; i++) m += x[i];
        m /= n || 1;
        const N = 1 << 16, M = 4096, H = N - 2 * M;
        const re = new Float64Array(N), im = new Float64Array(N);
        for (let start = -M; start + M < n; start += H) {
            for (let i = 0; i < N; i++) { const j = start + i; re[i] = j >= 0 && j < n ? x[j] - m : 0; im[i] = 0; }
            fft(re, im);
            for (let k = 1; k < N / 2; k++) { re[k] *= 2; im[k] *= 2; }
            for (let k = N / 2 + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
            fft(re, im, true);
            for (let i = M; i < M + H; i++) { const j = start + i; if (j >= 0 && j < n) env[j] = Math.hypot(re[i], im[i]); }
        }
        return env;
    }

    /** Pasa bajos Butterworth de 2º orden aplicado adelante y atrás (fase cero, −6 dB en fc). */
    function smooth(x, fc, fs) {
        const n = x.length;
        if (!(fc > 0) || fc >= fs / 2 || n < 8) return x;
        const K = Math.tan(Math.PI * fc / fs), nn = 1 / (1 + Math.SQRT2 * K + K * K);
        const b0 = K * K * nn, b1 = 2 * b0, a1 = 2 * (K * K - 1) * nn, a2 = (1 - Math.SQRT2 * K + K * K) * nn;
        const pad = Math.min(n - 1, 3 * Math.ceil(fs / fc));
        const L = n + 2 * pad, y = new Float64Array(L);
        for (let i = 0; i < L; i++) {
            const j = i - pad;
            y[i] = j < 0 ? 2 * x[0] - x[-j] : j >= n ? 2 * x[n - 1] - x[2 * (n - 1) - j] : x[j];
        }
        const pass = (from, to, dir) => {
            let x1 = y[from], x2 = y[from], y1 = y[from], y2 = y[from];
            for (let i = from; i !== to; i += dir) {
                const v = b0 * y[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
                x2 = x1; x1 = y[i]; y2 = y1; y1 = v; y[i] = v;
            }
        };
        pass(0, L, 1);
        pass(L - 1, -1, -1);
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = Math.max(0, y[i + pad]);
        return out;
    }

    // ---------------- Detección ----------------
    /** Tramos donde la envolvente supera el umbral (dB bajo el pico). Fusiona silencios < minGap y descarta tramos < minDur. */
    function detect(env, fs, o) {
        const n = env.length;
        let peak = 0;
        for (let i = 0; i < n; i++) if (env[i] > peak) peak = env[i];
        const thr = peak * 10 ** (-o.thresholdDb / 20);
        const raw = [];
        let i0 = -1;
        for (let i = 0; i < n; i++) {
            const on = env[i] >= thr;
            if (on && i0 < 0) i0 = i;
            else if (!on && i0 >= 0) { raw.push([i0, i - 1]); i0 = -1; }
        }
        if (i0 >= 0) raw.push([i0, n - 1]);
        const minGap = Math.round((o.minGapMs || 0) * fs / 1000), minDur = Math.round((o.minDurMs || 0) * fs / 1000);
        const merged = [];
        for (const s of raw) {
            const last = merged[merged.length - 1];
            if (last && s[0] - last[1] - 1 < minGap) last[1] = s[1];
            else merged.push(s.slice());
        }
        const segs = merged.filter(s => s[1] - s[0] + 1 >= Math.max(1, minDur));
        // Piso: mediana de la envolvente fuera de los estímulos (submuestreada)
        const outside = [];
        const stride = Math.max(1, Math.floor(n / 200000));
        let si = 0;
        for (let i = 0; i < n; i += stride) {
            while (si < segs.length && segs[si][1] < i) si++;
            if (si < segs.length && i >= segs[si][0]) continue;
            outside.push(env[i]);
        }
        const floor = outside.length ? percentile(outside, 0.5) : NaN;
        return { segs, peak, thr, floor };
    }

    // ---------------- Instantes y rampas ----------------
    /** Cruce ascendente del nivel L buscando hacia atrás desde k (índice fraccionario). */
    function crossBack(E, k, L, lo) {
        let j = k;
        while (j > lo && E[j - 1] >= L) j--;
        if (j <= lo) return j;
        return j - 1 + (L - E[j - 1]) / (E[j] - E[j - 1]);
    }
    /** Cruce descendente del nivel L buscando hacia adelante desde k. */
    function crossFwd(E, k, L, hi) {
        let j = k;
        while (j < hi && E[j + 1] >= L) j++;
        if (j >= hi) return j;
        return j + (E[j] - L) / (E[j] - E[j + 1]);
    }

    const SHAPES = [
        { id: 'lineal', name: 'lineal', en: 'linear', g: p => p },
        { id: 'cos', name: 'coseno (¼ de ciclo)', en: 'quarter-cosine', g: p => 2 / Math.PI * Math.asin(p) },
        { id: 'cos2', name: 'coseno² (Hann)', en: 'raised-cosine (cos²)', g: p => 2 / Math.PI * Math.asin(Math.sqrt(p)) }
    ];
    const LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

    /**
     * Ajusta t_p = t0 + T·g(p) (tiempos de cruce en s para los niveles p) con cada forma de rampa.
     * Devuelve la de menor residuo: { shape, T (duración nominal 0→100 %), t0 (inicio de la rampa), rel (residuo / T) }.
     */
    function fitRamp(ps, ts) {
        let best = null;
        for (const sh of SHAPES) {
            const g = ps.map(sh.g), mg = mean(g), mt = mean(ts);
            let sxy = 0, sxx = 0;
            g.forEach((gi, i) => { sxy += (gi - mg) * (ts[i] - mt); sxx += (gi - mg) ** 2; });
            const T = sxy / sxx, t0 = mt - T * mg;
            const res = Math.sqrt(mean(g.map((gi, i) => (ts[i] - t0 - T * gi) ** 2)));
            const rel = T > 0 ? res / T : Infinity;
            if (!best || rel < best.rel) best = { shape: sh.id, T, t0, rel };
        }
        return best;
    }

    // ---------------- Espectro ----------------
    /**
     * Espectro de x[a..b] (ventana de Hann, relleno ×8, máx. 0,5 s centrales).
     * mag[k] en amplitud de seno equivalente (1 = seno de escala completa).
     */
    function spectrum(x, a, b, fs, opts = {}) {
        let L = b - a + 1;
        const maxL = Math.round(fs * (opts.maxSec || 0.5));
        if (L > maxL) { a += (L - maxL) >> 1; L = maxL; }
        if (L < 16) return null;
        const N = Math.max(nextPow2(L), Math.min(nextPow2(L) * (opts.pad || 8), 1 << 19));
        const re = new Float64Array(N), im = new Float64Array(N);
        let m = 0;
        for (let i = 0; i < L; i++) m += x[a + i];
        m /= L;
        let sw = 0;
        for (let i = 0; i < L; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1)); re[i] = (x[a + i] - m) * w; sw += w; }
        fft(re, im);
        const H = N / 2, mag = new Float64Array(H + 1);
        for (let k = 0; k <= H; k++) mag[k] = 2 * Math.hypot(re[k], im[k]) / sw;
        const df = fs / N, lobe = Math.ceil(2 * N / L);
        const kmin = Math.max(lobe, Math.ceil(20 / df));
        let kp = kmin, total = 0;
        for (let k = kmin; k < H; k++) { if (mag[k] > mag[kp]) kp = k; }
        for (let k = 1; k < H; k++) total += mag[k] * mag[k];
        let delta = 0, amp = mag[kp];
        if (kp > 0 && kp < H && mag[kp - 1] > 0 && mag[kp + 1] > 0) {
            const al = Math.log(mag[kp - 1]), be = Math.log(mag[kp]), ga = Math.log(mag[kp + 1]);
            const den = al - 2 * be + ga;
            if (den < 0) { delta = 0.5 * (al - ga) / den; amp = Math.exp(be - 0.25 * (al - ga) * delta); }
        }
        const f = (kp + delta) * df;
        let inPeak = 0;
        for (let k = Math.max(1, kp - 3 * lobe); k <= Math.min(H - 1, kp + 3 * lobe); k++) inPeak += mag[k] * mag[k];
        let h2 = 0;
        for (let h = 2; h <= 10 && h * f < fs / 2 - 2 * lobe * df; h++) {
            const kc = Math.round(h * f / df);
            let mx = 0;
            for (let k = kc - lobe; k <= kc + lobe; k++) if (k > 0 && k < H && mag[k] > mx) mx = mag[k];
            h2 += mx * mx;
        }
        let cum = 0, cen = 0, f05 = NaN, f95 = NaN;
        for (let k = 1; k < H; k++) {
            cum += mag[k] * mag[k]; cen += k * df * mag[k] * mag[k];
            if (isNaN(f05) && cum >= 0.05 * total) f05 = k * df;
            if (isNaN(f95) && cum >= 0.95 * total) f95 = k * df;
        }
        return { f, amp, tonal: total > 0 ? inPeak / total : 0, thd: amp > 0 ? Math.sqrt(h2) / amp : NaN, centroid: cen / total, f05, f95, mag, df, L };
    }

    // ---------------- Medición de un estímulo ----------------
    function levels(x, a, b) {
        let s = 0, pk = 0;
        for (let i = a; i <= b; i++) { s += x[i] * x[i]; const v = Math.abs(x[i]); if (v > pk) pk = v; }
        return { rms: Math.sqrt(s / Math.max(1, b - a + 1)), peak: pk };
    }

    function crossings(E, a, b, lo, hi, A) {
        let kp = a; while (kp < b && E[kp] < 0.9 * A) kp++;
        let kq = b; while (kq > a && E[kq] < 0.9 * A) kq--;
        const up = LEVELS.map(p => crossBack(E, kp, p * A, lo));
        const dn = LEVELS.map(p => crossFwd(E, kq, p * A, hi));
        return { kp, kq, up, dn, cut: up[0] <= lo || dn[0] >= hi };
    }

    function measureOne(x, env, getSmooth, fs, seg, lo, hi, o) {
        const [a, b] = seg;
        const A0 = percentile(env.subarray(a, b + 1), 0.95);
        let E = env, A = A0, cr = crossings(env, a, b, lo, hi, A0);
        const i50a = cr.up[4], i50b = cr.dn[4];
        const pa = cr.kq - cr.kp >= Math.max(32, 0.002 * fs) ? [cr.kp, cr.kq] : [Math.round(i50a), Math.round(i50b)];
        const sp = spectrum(x, Math.max(0, pa[0]), Math.min(x.length - 1, pa[1]), fs);
        const dur50 = (i50b - i50a) / fs;
        let type = 'tono';
        if (dur50 < 0.002) type = 'click';
        else if (!sp || sp.tonal < 0.9) type = sp && sp.tonal < 0.5 && sp.f95 - sp.f05 > 1000 ? 'ruido' : 'complejo';
        if (type === 'ruido' && o.noiseSmoothHz > 0) {
            // La envolvente del ruido fluctúa: se suaviza y se usa la mediana como amplitud de la meseta
            E = getSmooth();
            A = percentile(E.subarray(a, b + 1), 0.5);
            cr = crossings(E, a, b, lo, hi, A);
        }
        const t = i => i / fs;
        const [on10, , , , on50, , , , on90] = cr.up.map(t);
        const [off10, , , , off50, , , , off90] = cr.dn.map(t);
        const rise = on90 - on10, fall = off10 - off90;
        const abrupt = rise * fs < 3;
        const rOn = abrupt ? null : fitRamp(LEVELS, cr.up.map(t));
        const rOffRaw = fall * fs < 3 ? null : fitRamp(LEVELS, cr.dn.map(i => -t(i)));
        const rOff = rOffRaw && { ...rOffRaw, t0: -rOffRaw.t0 }; // t0 = fin de la rampa de bajada
        const okShape = r => r && r.rel < 0.03;
        // Nivel en la meseta propiamente tal (envolvente ≥ 99 %; en ruido, entre los cruces del 90 %)
        let pa0 = cr.kp, pb0 = cr.kq;
        if (type !== 'ruido') { while (pa0 < pb0 && E[pa0] < 0.99 * A) pa0++; while (pb0 > pa0 && E[pb0] < 0.99 * A) pb0--; }
        const pl = pb0 - pa0 >= 16 ? [pa0, pb0] : cr.kq - cr.kp >= 1 ? [cr.kp, cr.kq] : [Math.round(cr.up[4]), Math.round(cr.dn[4])];
        const lv = levels(x, pl[0], pl[1]);
        const lvAll = levels(x, Math.max(0, Math.floor(cr.up[0])), Math.min(x.length - 1, Math.ceil(cr.dn[0])));
        let clip = 0;
        for (let i = a; i <= b; i++) if (Math.abs(x[i]) >= 0.999) clip++;
        return {
            a, b, A, on10, on50, on90, off90, off50, off10,
            rise, fall, dur50, dur10: off10 - on10, plateau: off90 - on90,
            rampOn: rOn && { shape: okShape(rOn) ? rOn.shape : 'otra', T: rOn.T, t0: rOn.t0, rel: rOn.rel },
            rampOff: rOff && { shape: okShape(rOff) ? rOff.shape : 'otra', T: rOff.T, t0: rOff.t0, rel: rOff.rel },
            dur0: okShape(rOn) && okShape(rOff) ? rOff.t0 - rOn.t0 : NaN,
            abrupt, cut: cr.cut, type,
            f: type === 'tono' || type === 'complejo' ? sp.f : NaN,
            tonal: sp ? sp.tonal : NaN, thd: type === 'tono' ? sp.thd : NaN,
            centroid: sp ? sp.centroid : NaN, f05: sp ? sp.f05 : NaN, f95: sp ? sp.f95 : NaN,
            rmsDb: db(lv.rms * Math.SQRT2), peakDb: db(lvAll.peak), crestDb: db(lvAll.peak / lv.rms), clip
        };
    }

    // ---------------- Agrupación ----------------
    /** Agrupa valores 1-D: nuevo grupo cuando el salto supera tol(valor anterior). Grupos numerados en orden creciente. */
    function cluster1d(vals, tol) {
        const idx = vals.map((v, i) => i).filter(i => isFinite(vals[i])).sort((i, j) => vals[i] - vals[j]);
        const g = vals.map(() => -1);
        let k = -1, prev = null;
        for (const i of idx) {
            if (prev === null || vals[i] - prev > tol(prev)) k++;
            g[i] = k; prev = vals[i];
        }
        return { g, count: k + 1 };
    }

    const TYPE_LETTER = { ruido: 'R', click: 'K', complejo: 'X' };

    function classify(st) {
        const tonal = st.map(s => s.type === 'tono');
        const fg = cluster1d(st.map((s, i) => tonal[i] ? s.f : NaN), v => Math.max(5, 0.03 * v));
        const dg = cluster1d(st.map((s, i) => tonal[i] ? s.dur50 : NaN), v => Math.max(0.002, 0.05 * v));
        const fl = i => fg.count < 2 ? '' : fg.count === 2 ? 'GA'[fg.g[i]] : `F${fg.g[i] + 1}`;
        const dl = i => dg.count < 2 ? '' : dg.count === 2 ? 'CL'[dg.g[i]] : `D${dg.g[i] + 1}`;
        st.forEach((s, i) => { s.label = tonal[i] ? (fl(i) + dl(i) || 'T') : TYPE_LETTER[s.type]; });
        const labels = [...new Set(st.map(s => s.label))];
        const classes = labels.map(label => {
            const m = st.filter(s => s.label === label);
            const shapes = arr => {
                const c = {};
                arr.forEach(r => { if (r) c[r.shape] = (c[r.shape] || 0) + 1; });
                const top = Object.entries(c).sort((p, q) => q[1] - p[1])[0];
                return top ? top[0] : '';
            };
            return {
                label, n: m.length, type: m[0].type,
                f: summary(m.map(s => s.f)), dur50: summary(m.map(s => s.dur50)), dur0: summary(m.map(s => s.dur0)),
                dur10: summary(m.map(s => s.dur10)), plateau: summary(m.map(s => s.plateau)),
                rise: summary(m.map(s => s.rise)), fall: summary(m.map(s => s.fall)),
                rampOnT: summary(m.map(s => s.rampOn ? s.rampOn.T : NaN)), rampOffT: summary(m.map(s => s.rampOff ? s.rampOff.T : NaN)),
                shapeOn: shapes(m.map(s => s.rampOn)), shapeOff: shapes(m.map(s => s.rampOff)),
                rmsDb: summary(m.map(s => s.rmsDb)), peakDb: summary(m.map(s => s.peakDb)), thd: summary(m.map(s => s.thd)),
                f05: summary(m.map(s => s.f05)), f95: summary(m.map(s => s.f95))
            };
        }).sort((p, q) => (p.f.mean || 0) - (q.f.mean || 0) || p.dur50.mean - q.dur50.mean);
        return classes;
    }

    /** Umbral que separa ítems: el salto (razón ≥ 3) más alto entre los intervalos ordenados. */
    function autoSeqGap(gaps) {
        const g = gaps.filter(v => v > 0).sort((p, q) => p - q);
        let thr = NaN;
        for (let i = 0; i + 1 < g.length; i++) if (g[i + 1] / g[i] >= 3) thr = Math.sqrt(g[i] * g[i + 1]);
        return thr;
    }

    // ---------------- Análisis completo ----------------
    const DEFAULTS = { channel: 0, thresholdDb: 30, minGapMs: 0.5, minDurMs: 0, smoothHz: 0, noiseSmoothHz: 1000, seqGapMs: NaN, maxStimuli: 3000 };

    function analyze(x, fs, cfg = {}) {
        const o = { ...DEFAULTS, ...cfg };
        const warnings = [];
        const n = x.length;
        let dc = 0;
        for (let i = 0; i < n; i++) dc += x[i];
        dc /= n || 1;
        let env = envelope(x);
        if (o.smoothHz > 0) env = smooth(env, o.smoothHz, fs);
        const det = detect(env, fs, o);
        let envS = null;
        const getSmooth = () => envS || (envS = smooth(env, o.noiseSmoothHz, fs));
        let segs = det.segs;
        if (segs.length > o.maxStimuli) {
            warnings.push(`Se detectaron ${segs.length} tramos; se analizan los primeros ${o.maxStimuli}. Suba el umbral o la fusión de silencios.`);
            segs = segs.slice(0, o.maxStimuli);
        }
        const stimuli = segs.map((s, i) => ({ i: i + 1, ...measureOne(x, env, getSmooth, fs, s, i ? segs[i - 1][1] : 0, i + 1 < segs.length ? segs[i + 1][0] : n - 1, o) }));
        const classes = classify(stimuli);
        const gaps = stimuli.slice(1).map((s, i) => s.on50 - stimuli[i].off50);
        const seqGap = isFinite(o.seqGapMs) && o.seqGapMs > 0 ? o.seqGapMs / 1000 : autoSeqGap(gaps);
        const intervals = stimuli.slice(1).map((s, i) => {
            const p = stimuli[i];
            return { from: p.i, to: s.i, gap50: s.on50 - p.off50, gap10: s.on10 - p.off10, soa: s.on50 - p.on50, within: !(gaps[i] >= seqGap) };
        });
        const sequences = [];
        stimuli.forEach((s, i) => {
            if (!i || !intervals[i - 1].within) sequences.push({ i: sequences.length + 1, stimuli: [] });
            sequences[sequences.length - 1].stimuli.push(s);
        });
        sequences.forEach(q => {
            const f = q.stimuli[0], l = q.stimuli[q.stimuli.length - 1];
            q.start = f.on50; q.end = l.off50; q.n = q.stimuli.length;
            q.pattern = q.stimuli.map(s => s.label).join('-');
            q.gaps = intervals.filter(v => v.within && v.from >= f.i && v.to <= l.i).map(v => v.gap50);
            q.stimuli = q.stimuli.map(s => s.i);
        });
        stimuli.forEach(s => { s.seq = (sequences.find(q => q.stimuli.includes(s.i)) || {}).i; });

        const peakDb = db(det.peak), floorDb = db(det.floor);
        const clipTotal = stimuli.reduce((a, s) => a + s.clip, 0);
        if (!stimuli.length) warnings.push('No se detectaron estímulos: revise el canal o baje el umbral.');
        if (clipTotal) warnings.push(`${clipTotal} muestras en escala completa (recorte): baje el volumen de reproducción o la ganancia de grabación.`);
        if (isFinite(floorDb) && peakDb - floorDb < o.thresholdDb + 10) warnings.push(`El ruido de fondo (${floorDb.toFixed(1)} dBFS) está a menos de ${o.thresholdDb + 10} dB del pico: la detección y los instantes al 10 % son poco confiables.`);
        if (Math.abs(dc) > 0.005) warnings.push(`Componente continua de ${(dc * 100).toFixed(2)} % de escala completa (se resta antes de medir).`);
        if (stimuli.some(s => s.cut)) warnings.push('Hay estímulos cortados por el borde del archivo o pegados a otro: sus rampas no son confiables.');
        if (stimuli.some(s => s.type === 'ruido')) warnings.push('En ruido, la envolvente fluctúa: la meseta es la mediana de la envolvente suavizada y las rampas son aproximadas. Los instantes al 50 % (gaps) son los más robustos.');
        if (stimuli.some(s => s.type === 'tono' && ((s.rampOn && s.rampOn.shape === 'otra') || (s.rampOff && s.rampOff.shape === 'otra'))))
            warnings.push('Algunas rampas no calzan con una forma lineal, coseno o coseno²: se informa solo el tiempo 10–90 %.');
        return { fs, n, duration: n / fs, dc, peakDb, floorDb, thrDb: db(det.thr), env, stimuli, intervals, classes, sequences, seqGap, warnings, cfg: o };
    }

    /** Asincronía entre canales: empareja cada estímulo de A con el de B de inicio más cercano. */
    function compareChannels(ra, rb) {
        const pairs = [];
        for (const s of ra.stimuli) {
            let best = null;
            for (const q of rb.stimuli) if (!best || Math.abs(q.on50 - s.on50) < Math.abs(best.on50 - s.on50)) best = q;
            if (best && Math.abs(best.on50 - s.on50) < 0.5 * Math.min(s.dur50, best.dur50))
                pairs.push({ a: s.i, b: best.i, dOn: best.on50 - s.on50, dOff: best.off50 - s.off50, dLevel: best.rmsDb - s.rmsDb });
        }
        return { pairs, onlyA: ra.stimuli.length - pairs.length, onlyB: rb.stimuli.length - pairs.length, dOn: summary(pairs.map(p => p.dOn)), dOff: summary(pairs.map(p => p.dOff)), dLevel: summary(pairs.map(p => p.dLevel)) };
    }

    // ---------------- Espectrograma ----------------
    /** STFT de x entre t0 y t1 (s): matriz cols × rows en dBFS (fila 0 = 0 Hz). */
    function spectrogram(x, fs, t0, t1, o) {
        const Nw = Math.max(16, Math.round(o.winMs * fs / 1000)), Nf = nextPow2(Nw);
        const cols = o.cols, rows = o.rows, fmax = Math.min(o.fmax || fs / 2, fs / 2);
        const w = new Float64Array(Nw);
        let sw = 0;
        for (let i = 0; i < Nw; i++) { w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (Nw - 1)); sw += w[i]; }
        const re = new Float64Array(Nf), im = new Float64Array(Nf);
        const out = new Float32Array(cols * rows);
        const i0 = t0 * fs, span = (t1 - t0) * fs;
        const kOf = f => Math.min(Nf / 2, Math.max(0, Math.round(f * Nf / fs)));
        for (let c = 0; c < cols; c++) {
            const start = Math.round(i0 + (c + 0.5) * span / cols - Nw / 2);
            re.fill(0); im.fill(0);
            for (let i = 0; i < Nw; i++) { const j = start + i; if (j >= 0 && j < x.length) re[i] = x[j] * w[i]; }
            fft(re, im);
            for (let r = 0; r < rows; r++) {
                const ka = kOf(r * fmax / rows), kb = Math.max(ka, kOf((r + 1) * fmax / rows) - 1);
                let mx = 0;
                for (let k = ka; k <= kb; k++) { const v = re[k] * re[k] + im[k] * im[k]; if (v > mx) mx = v; }
                out[c * rows + r] = mx > 0 ? db(2 * Math.sqrt(mx) / sw) : -200;
            }
        }
        return { cols, rows, db: out, t0, t1, fmax, winMs: Nw / fs * 1000 };
    }

    // ---------------- Señal de ejemplo ----------------
    /**
     * Pista simulada tipo prueba de patrones de frecuencia: ítems de 3 tonos (880 / 1122 Hz, 150 ms,
     * rampas coseno² de 10 ms, ISI 200 ms) y un tramo de ruido blanco con gaps de 2, 5 y 10 ms. 16 bits, estéreo.
     */
    function synthExample(fs = 48000) {
        const items = ['GAG', 'AAG', 'GGA', 'AGA', 'GAA', 'AGG'];
        const tone = 0.15, ramp = 0.01, isi = 0.2, between = 1.5, amp = 10 ** (-12 / 20); // −12 dBFS
        const total = 0.5 + items.length * (3 * tone + 2 * isi + between) + 2.4;
        const n = Math.ceil(total * fs), x = new Float32Array(n);
        let seed = 12345;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
        const rampAt = (t, T, dur) => t < T ? Math.sin(Math.PI * t / (2 * T)) ** 2 : t > dur - T ? Math.sin(Math.PI * (dur - t) / (2 * T)) ** 2 : 1;
        let t = 0.5;
        for (const it of items) {
            for (const c of it) {
                const f = c === 'G' ? 880 : 1122, i0 = Math.round(t * fs), m = Math.round(tone * fs);
                for (let i = 0; i < m; i++) x[i0 + i] += amp * rampAt(i / fs, ramp, tone) * Math.sin(2 * Math.PI * f * i / fs);
                t += tone + isi;
            }
            t += between - isi;
        }
        // Ruido con gaps (rampas de 0,5 ms)
        const nStart = t, segs = [[0, 0.4], [0.402, 0.8], [0.805, 1.2], [1.21, 1.6]];
        for (const [s0, s1] of segs) {
            const i0 = Math.round((nStart + s0) * fs), m = Math.round((s1 - s0) * fs);
            for (let i = 0; i < m; i++) x[i0 + i] += 0.08 * rampAt(i / fs, 0.0005, (s1 - s0)) * gauss();
        }
        for (let i = 0; i < n; i++) x[i] = Math.round((x[i] + 1e-5 * gauss()) * 32767) / 32768; // piso ≈ −97 dBFS, 16 bits
        return { fs, channels: [x, Float32Array.from(x)], bits: 16, format: 'pcm', n, duration: n / fs };
    }

    return {
        parseWav, encodeWav, fft, envelope, smooth, detect, fitRamp, spectrum, analyze, compareChannels, spectrogram,
        synthExample, summary, percentile, cluster1d, autoSeqGap, SHAPES, DEFAULTS
    };
});
