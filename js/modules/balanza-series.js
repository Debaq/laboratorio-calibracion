/*
 * Ensayos con series de tiempo para la plataforma de fuerza:
 *
 *  1) Ruido de fondo: carga inmóvil 30–60 s. Las métricas de estabilometría de una carga que NO se mueve
 *     son el piso del instrumento; las de un sujeto deben quedar muy por encima.
 *
 *  2) Dinámico con masa giratoria (fantoma): una masa m gira a radio r y altura h sobre el plano de las celdas.
 *     El CoP teórico describe un círculo de radio
 *         R(ω) = (m·r / M) · (1 + ω²·h / g)
 *     El segundo término es la fuerza centrípeta m·ω²·r (horizontal) aplicada a la altura h: la plataforma
 *     la "ve" como momento. Es el mismo fenómeno por el que el CoP de una persona difiere de su CoM.
 *     R_medido / R_teórico en función de la frecuencia es la respuesta en amplitud de toda la cadena
 *     (celdas → HX711 → muestreo → filtro).
 *
 * Formatos CSV aceptados (encabezado recomendado; separador , ; o tab):
 *     t_ms,c1,c2,c3,c4        cuentas crudas por celda (se aplica la calibración estática)
 *     t_ms,F1,F2,F3,F4        fuerzas por celda en N
 *     t_ms,cop_x,cop_y,fz     CoP en mm y fuerza total en N
 *  Tiempo: t_ms / millis (ms), t_us / micros (µs) o t (s). Sin encabezado y 5 columnas → t_ms,c1..c4.
 */
(function (root, factory) {
    const req = n => (typeof require === 'function') ? require(n) : null;
    const S = req('../core/stats.js') || root.LabStats;
    const Sig = req('../core/signal.js') || root.LabSignal;
    const P = req('../core/physics.js') || root.LabPhys;
    const U = req('../core/uncertainty.js') || root.LabUnc;
    const m = factory(S, Sig, P, U);
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.BalanzaSeries = m;
})(typeof self !== 'undefined' ? self : this, function (S, Sig, P, U) {
    'use strict';

    function defaultSeriesConfig() {
        return {
            filterHz: 10,        // mismo filtro que se usará con los sujetos
            tareMode: 'inicio',  // 'inicio' (primeros segundos vacíos) | 'estatica' (tara de la calibración)
            tareSec: 3,
            settleSec: 2,        // se descarta tras detectar la carga
            fsDefault: 80,       // si el CSV no trae tiempo
            noise: { mass_kg: 70, refVel_mms: 10, pct: 10 },
            dyn: { m_kg: 2, um_g: 2, r_mm: 150, ur_mm: 1, h_mm: 100, uh_mm: 3, Mtot_kg: 0, uMtot_kg: 0.2, tol_pct: 5, fmax_Hz: 2 }
        };
    }

    // ---------------- Lectura de CSV ----------------
    const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\[.*?\]|\(.*?\)/g, '').replace(/[\s"']/g, '');

    function classify(name) {
        const n = norm(name);
        let m;
        if (/^(t_?ms|millis|tiempo_?ms|time_?ms|ms)$/.test(n)) return { type: 't', scale: 1e-3 };
        if (/^(t_?us|micros|us)$/.test(n)) return { type: 't', scale: 1e-6 };
        if (/^(t|t_?s|tiempo|time|seg|s)$/.test(n)) return { type: 't', scale: 1 };
        if ((m = n.match(/^(c|raw|celda|cell|r|hx)_?([1-4])$/))) return { type: 'c', i: +m[2] - 1 };
        if ((m = n.match(/^f_?([1-4])$/))) return { type: 'F', i: +m[1] - 1 };
        if (/^(cop_?x|x|cop_?ml|ml)$/.test(n)) return { type: 'cx' };
        if (/^(cop_?y|y|cop_?ap|ap)$/.test(n)) return { type: 'cy' };
        if (/^(fz|f_?z|f_?total|ftot|f)$/.test(n)) return { type: 'fz' };
        return null;
    }

    function parseCSV(text, name = 'serie') {
        const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (!lines.length) throw new Error('El archivo está vacío.');
        const delimOf = l => l.includes('\t') ? '\t' : l.includes(';') ? ';' : ',';
        let hIdx = lines.findIndex(l => l.split(delimOf(l)).filter(c => classify(c)).length >= 2);
        let delim, cols;
        if (hIdx >= 0) {
            delim = delimOf(lines[hIdx]);
            cols = lines[hIdx].split(delim).map(classify);
        } else {
            const first = lines.findIndex(l => /^-?\d/.test(l));
            if (first < 0) throw new Error('No se encontraron datos numéricos.');
            delim = delimOf(lines[first]);
            const n = lines[first].split(delim).length;
            if (n === 5) cols = [{ type: 't', scale: 1e-3 }, ...[0, 1, 2, 3].map(i => ({ type: 'c', i }))];
            else if (n === 4) cols = [0, 1, 2, 3].map(i => ({ type: 'c', i }));
            else throw new Error(`Sin encabezado y con ${n} columnas: agregue un encabezado (ej.: t_ms,c1,c2,c3,c4).`);
            hIdx = first - 1;
        }
        const has = t => cols.some(c => c && c.type === t);
        const idx = (t, i) => cols.findIndex(c => c && c.type === t && (i === undefined || c.i === i));
        let kind;
        if ([0, 1, 2, 3].every(i => idx('c', i) >= 0)) kind = 'raw';
        else if ([0, 1, 2, 3].every(i => idx('F', i) >= 0)) kind = 'force';
        else if (has('cx') && has('cy')) kind = 'cop';
        else throw new Error('Columnas no reconocidas. Use c1..c4 (cuentas), F1..F4 (N) o cop_x, cop_y, fz.');

        const decimalComma = delim !== ',';
        const num = s => Number(decimalComma ? s.replace(',', '.') : s);
        const need = kind === 'raw' ? [0, 1, 2, 3].map(i => idx('c', i)) : kind === 'force' ? [0, 1, 2, 3].map(i => idx('F', i)) : [idx('cx'), idx('cy')];
        const it = idx('t'), ifz = idx('fz');
        const out = { t: [], a: [[], [], [], []], fz: [] };
        let skipped = 0;
        for (let li = hIdx + 1; li < lines.length; li++) {
            const f = lines[li].split(delim);
            const vals = need.map(j => num(f[j] ?? ''));
            const tv = it >= 0 ? num(f[it] ?? '') : NaN;
            if (vals.some(v => !isFinite(v)) || (it >= 0 && !isFinite(tv))) { skipped++; continue; }
            vals.forEach((v, j) => out.a[j].push(v));
            if (it >= 0) out.t.push(tv * cols[it].scale);
            if (ifz >= 0) out.fz.push(num(f[ifz] ?? ''));
        }
        const n = out.a[0].length;
        if (n < 20) throw new Error(`Solo ${n} filas válidas.`);
        const warnings = [];
        let cut = n;
        if (out.t.length) {
            for (let i = 1; i < n; i++) if (out.t[i] <= out.t[i - 1]) { cut = i; break; }
            if (cut < n) warnings.push(`El tiempo retrocede en la fila ${cut + 1} (¿se reinició el Arduino?). Se usan solo las primeras ${cut} muestras.`);
        }
        const t0 = out.t.length ? out.t[0] : 0;
        const series = {
            name, kind, n: cut, skipped,
            tms: out.t.length ? out.t.slice(0, cut).map(v => Math.round((v - t0) * 1e4) / 10) : null,
            cols: {}
        };
        if (kind === 'raw') [0, 1, 2, 3].forEach(i => series.cols[`c${i + 1}`] = out.a[i].slice(0, cut).map(Math.round));
        if (kind === 'force') [0, 1, 2, 3].forEach(i => series.cols[`F${i + 1}`] = out.a[i].slice(0, cut).map(v => +v.toFixed(4)));
        if (kind === 'cop') { series.cols.cx = out.a[0].slice(0, cut); series.cols.cy = out.a[1].slice(0, cut); }
        if (ifz >= 0 && kind !== 'raw') series.cols.fz = out.fz.slice(0, cut);
        if (skipped) warnings.push(`${skipped} líneas ignoradas (texto o valores incompletos).`);
        series.warnings = warnings;
        return series;
    }

    // ---------------- Conversión a CoP ----------------
    /**
     * calib: { k:[4], cells:[{x,y}], tareStatic:[4]|null } (del análisis estático) — requerido para 'raw'.
     * Devuelve la serie recortada al tramo cargado y filtrada.
     */
    function toCoP(series, calib, sc) {
        const warnings = [...(series.warnings || [])];
        const n = series.n;
        const t = series.tms ? series.tms.map(v => v / 1000) : Array.from({ length: n }, (_, i) => i / sc.fsDefault);
        if (!series.tms) warnings.push(`El archivo no trae tiempo: se asumió muestreo de ${sc.fsDefault} Hz.`);
        let F = null, cx, cy, fz;

        if (series.kind === 'raw') {
            if (!calib) return { ok: false, warnings: [...warnings, 'Las cuentas crudas necesitan la calibración estática: complete primero la pestaña Medición.'] };
            const c = [1, 2, 3, 4].map(i => series.cols[`c${i}`]);
            let tare;
            if (sc.tareMode === 'estatica') {
                if (!calib.tareStatic) return { ok: false, warnings: [...warnings, 'No hay tara en la calibración estática.'] };
                tare = calib.tareStatic;
                warnings.push('Tara tomada de la calibración estática: si el equipo se apagó entre medio, use la tara al inicio del archivo.');
            } else {
                const k0 = t.findIndex(v => v >= sc.tareSec);
                const m = k0 > 5 ? k0 : Math.min(n, Math.round(sc.tareSec * 10));
                tare = c.map(col => S.mean(col.slice(0, m)));
            }
            F = c.map((col, i) => col.map(v => calib.k[i] * (v - tare[i])));
        } else if (series.kind === 'force') {
            F = [1, 2, 3, 4].map(i => series.cols[`F${i}`]);
        }
        if (F) {
            const cells = calib ? calib.cells : null;
            if (!cells) return { ok: false, warnings: [...warnings, 'Faltan las posiciones de las celdas.'] };
            fz = t.map((_, j) => F[0][j] + F[1][j] + F[2][j] + F[3][j]);
            cx = t.map((_, j) => (F[0][j] * cells[0].x + F[1][j] * cells[1].x + F[2][j] * cells[2].x + F[3][j] * cells[3].x) / fz[j]);
            cy = t.map((_, j) => (F[0][j] * cells[0].y + F[1][j] * cells[1].y + F[2][j] * cells[2].y + F[3][j] * cells[3].y) / fz[j]);
        } else {
            cx = series.cols.cx; cy = series.cols.cy; fz = series.cols.fz && series.cols.fz.length ? series.cols.fz : null;
        }

        // Tramo cargado: tramo continuo más largo con Fz sobre la mitad del percentil 98
        let i0 = 0, i1 = n - 1;
        if (fz) {
            const top = fz.slice().sort((a, b) => a - b)[Math.floor(0.98 * (n - 1))];
            if (!(top > 0)) return { ok: false, warnings: [...warnings, 'No se detectó carga. ¿La plataforma estaba vacía al comenzar el registro? (o cambie el modo de tara)'] };
            let best = [0, -1], start = -1;
            for (let j = 0; j <= n; j++) {
                const on = j < n && fz[j] > 0.5 * top;
                if (on && start < 0) start = j;
                if (!on && start >= 0) { if (j - 1 - start > best[1] - best[0]) best = [start, j - 1]; start = -1; }
            }
            i0 = best[0]; i1 = best[1];
            const tStart = t[i0] + sc.settleSec;
            while (i0 < i1 && t[i0] < tStart) i0++;
            while (i1 > i0 && t[i1] > t[best[1]] - 0.5) i1--;
        }
        if (i1 - i0 < 20) return { ok: false, warnings: [...warnings, 'El tramo con carga es demasiado corto.'] };

        const ts = t.slice(i0, i1 + 1).map(v => v - t[i0]);
        const samp = Sig.sampling(ts);
        const fc = sc.filterHz;
        const f = arr => Sig.lowpass(arr.slice(i0, i1 + 1), fc, samp.fs);
        const out = { ok: true, warnings, t: ts, cx: f(cx), cy: f(cy), fz: fz ? f(fz) : null, samp, seg: [t[i0], t[i1]], filtered: fc > 0 && fc < samp.fs / 2 };
        if (fc >= samp.fs / 2) warnings.push(`El filtro de ${fc} Hz no se aplicó: es mayor que la mitad del muestreo (${(samp.fs / 2).toFixed(1)} Hz).`);
        if (samp.fs < 20) warnings.push(`Muestreo de ${samp.fs.toFixed(1)} Hz: bajo para posturografía. Configure el HX711 a 80 Hz (pin RATE a VCC).`);
        if (samp.gaps > 0) warnings.push(`${samp.gaps} saltos en el tiempo (muestras perdidas): suba la velocidad del puerto serie o reduzca lo que imprime.`);
        else if (samp.jitter > 0.25 * samp.dt) warnings.push(`El intervalo entre muestras varía mucho (σ = ${(samp.jitter * 1000).toFixed(1)} ms).`);
        return out;
    }

    // ---------------- Ensayo 1: ruido de fondo ----------------
    function noiseAnalysis(series, calib, sc, g) {
        const d = toCoP(series, calib, sc);
        if (!d.ok) return d;
        const w = d.warnings;
        const m = Sig.swayMetrics(d.t, d.cx, d.cy);
        if (m.T < 20) w.push(`Registro de ${m.T.toFixed(0)} s: use al menos 30 s (lo mismo que dura un ensayo con personas).`);
        let massEst = null;
        if (d.fz) {
            massEst = S.mean(d.fz) / g;
            if (sc.noise.mass_kg > 0 && Math.abs(massEst - sc.noise.mass_kg) > 0.02 * sc.noise.mass_kg)
                w.push(`La masa estimada (${massEst.toFixed(2)} kg) difiere más de 2 % de la declarada (${sc.noise.mass_kg} kg): revise tara o calibración.`);
        }
        const ratio = sc.noise.refVel_mms > 0 ? 100 * m.velMean / sc.noise.refVel_mms : NaN;
        const ok = isFinite(ratio) ? ratio <= sc.noise.pct : null;
        if (Math.hypot(m.driftX, m.driftY) * 30 > 1) w.push(`Deriva del CoP de ${(Math.hypot(m.driftX, m.driftY) * 30).toFixed(2)} mm en 30 s con carga inmóvil: fluencia de celdas o calentamiento.`);
        return { ok: true, warnings: w, data: d, metrics: m, massEst, fzSd: d.fz ? S.sd(d.fz) : NaN, ratio, verdict: ok };
    }

    // ---------------- Ensayo 2: masa giratoria ----------------
    function predictedRadius(dyn, M, w, g) {
        const h = dyn.h_mm / 1000;
        const cent = 1 + w * w * h / g;
        const R = dyn.m_kg * dyn.r_mm / M * cent;
        const uRel = U.combine(dyn.um_g / 1000 / dyn.m_kg, dyn.ur_mm / dyn.r_mm, (dyn.uM ?? 0) / M, (w * w * dyn.uh_mm / 1000 / g) / cent);
        return { R, uRel, cent };
    }

    function rotationAnalysis(series, calib, sc, g) {
        const d = toCoP(series, calib, sc);
        if (!d.ok) return d;
        const w = d.warnings, dyn = sc.dyn;
        const c = Sig.circleFit(d.cx, d.cy);
        const ph = Sig.unwrap(d.cx.map((x, i) => Math.atan2(d.cy[i] - c.yc, x - c.xc)));
        const pf = S.polyfit(d.t, ph, 1);
        const omega = Math.abs(pf.coef[1]);
        const revs = Math.abs(ph[ph.length - 1] - ph[0]) / (2 * Math.PI);
        let M, uM;
        if (dyn.Mtot_kg > 0) { M = dyn.Mtot_kg; uM = dyn.uMtot_kg; }
        else if (d.fz) { M = S.mean(d.fz) / g; uM = 0.002 * M; }
        else return { ok: false, warnings: [...w, 'El archivo no trae fuerza total: ingrese la masa total M en la configuración.'] };
        const pred = predictedRadius({ ...dyn, uM }, M, omega, g);
        const ratio = c.R / pred.R;
        const ripple = d.fz ? 100 * Sig.toneAmplitude(d.t, d.fz, omega) / S.mean(d.fz) : NaN;
        if (revs < 3) w.push(`Solo ${revs.toFixed(1)} vueltas: registre al menos 3 para un ajuste confiable.`);
        if (c.radialRms > 0.1 * c.R) w.push('La trayectoria no es un círculo limpio: velocidad irregular, masa suelta o desfase entre los canales del HX711.');
        if (ripple > 1) w.push(`Fz oscila ${ripple.toFixed(2)} % a la frecuencia de giro: la fuerza vertical debería ser constante (¿plataforma desnivelada o canales desfasados?).`);
        const phaseRes = S.rms(pf.residuals) * 180 / Math.PI;
        if (phaseRes > 15) w.push('La velocidad de giro no fue constante: use un motor con reductora o fuente estable.');
        return {
            ok: true, warnings: w, data: d, circle: c, omega, f: omega / (2 * Math.PI), revs, M, uM,
            Rpred: pred.R, uRel: pred.uRel, centrifugalPct: 100 * (pred.cent - 1), ratio, ripple, phaseRes
        };
    }

    /** Resume varias corridas: respuesta en amplitud y veredicto hasta fmax. */
    function frequencyResponse(results, sc) {
        const ok = results.filter(r => r.ok).sort((a, b) => a.f - b.f);
        const inBand = ok.filter(r => r.f <= sc.dyn.fmax_Hz * 1.05);
        const tol = sc.dyn.tol_pct / 100;
        const fails = inBand.filter(r => Math.abs(r.ratio - 1) + 2 * r.uRel * r.ratio > tol);
        const warnings = [];
        if (!inBand.length) warnings.push('Ninguna corrida dentro de la banda de interés.');
        else if (Math.max(...inBand.map(r => r.f)) < 0.8 * sc.dyn.fmax_Hz)
            warnings.push(`La frecuencia más alta probada (${Math.max(...inBand.map(r => r.f)).toFixed(2)} Hz) no llega a la banda de interés (${sc.dyn.fmax_Hz} Hz).`);
        return { runs: ok, verdict: inBand.length ? fails.length === 0 : null, fails, warnings };
    }

    // ---------------- Datos simulados (para ejemplo y pruebas) ----------------
    function rng(seed) {
        let s = seed;
        const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        return sd => sd * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    }

    function cellShare(cells, x, y) {
        const xs = cells.map(c => c.x), ys = cells.map(c => c.y);
        const W = Math.max(...xs) - Math.min(...xs), D = Math.max(...ys) - Math.min(...ys);
        const u = (x - Math.min(...xs)) / W, v = (y - Math.min(...ys)) / D;
        return cells.map(c => (c.x > 0 ? u : 1 - u) * (c.y > 0 ? v : 1 - v));
    }

    /**
     * Genera cuentas crudas de 4 HX711 a partir de una trayectoria de fuerza/CoP.
     * copAt(t) → {fz, x, y} o null (plataforma vacía). Cada canal muestrea con su propio desfase (≤ 1 período).
     */
    function simulateRaw(cfg, truth, copAt, T, fs = 80, seed = 5, noise = 40) {
        const gauss = rng(seed);
        const skew = [0, 0.3, 0.6, 0.9].map(f => f / fs);
        const tms = [], cols = { c1: [], c2: [], c3: [], c4: [] };
        for (let j = 0; j < T * fs; j++) {
            const t = j / fs + gauss(0.0005);
            tms.push(Math.round(t * 1000));
            [0, 1, 2, 3].forEach(i => {
                const s = copAt(t - skew[i]);
                const Fi = s ? s.fz * cellShare(cfg.cells, s.x, s.y)[i] : 0;
                cols[`c${i + 1}`].push(Math.round(truth.tare[i] + Fi / truth.k[i] + gauss(noise)));
            });
        }
        return { name: 'simulado', kind: 'raw', n: tms.length, skipped: 0, tms, cols, warnings: [] };
    }

    function exampleNoise(cfg, truth, g, sc) {
        const W = sc.noise.mass_kg * g;
        // ruido de 150 cuentas por canal: típico de un HX711 a 80 Hz
        return { ...simulateRaw(cfg, truth, t => (t < 3.5 ? null : { fz: W, x: 5 + 0.004 * t, y: -12 }), 45, 80, 21, 150), name: 'Lastre 70 kg (simulado)' };
    }

    function exampleRotation(cfg, truth, g, sc, freqs = [0.2, 0.5, 1, 1.5, 2]) {
        const d = sc.dyn, M0 = 20; // masa base (motor + brazo + lastre) en el centro
        const M = M0 + d.m_kg, h = d.h_mm / 1000;
        return freqs.map((f, k) => {
            const w = 2 * Math.PI * f;
            const T = 3.5 + 2.5 + Math.max(20, 4 / f);
            const copAt = t => {
                if (t < 3.5) return null;
                const ph = w * t;
                const R = d.m_kg * d.r_mm / M * (1 + w * w * h / g);
                return { fz: M * g, x: R * Math.cos(ph), y: R * Math.sin(ph) };
            };
            return { ...simulateRaw(cfg, truth, copAt, T, 80, 31 + k), name: `${(f * 60).toFixed(0)} rpm (simulado)` };
        });
    }

    return { defaultSeriesConfig, parseCSV, toCoP, noiseAnalysis, predictedRadius, rotationAnalysis, frequencyResponse, simulateRaw, exampleNoise, exampleRotation };
});
