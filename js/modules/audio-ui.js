/*
 * Interfaz del módulo de estímulos auditivos: carga de archivos, grabación desde el sistema,
 * análisis (LabAudio), gráficos, espectrograma, exportaciones y texto para métodos.
 * No usa LabApp: aquí no hay plan de mediciones sino un archivo que se analiza.
 */
(function (root) {
    'use strict';
    const { $, $$, esc, num, fmt, table, toast, download, toCSV, slug, plot } = root.LabUI;
    const AU = root.LabAudio, Store = root.LabStore;

    const CFG_KEY = 'audio:cfg';
    const DEF = { ...AU.DEFAULTS, calOffset: NaN, calUnit: 'dB SPL', winMs: 20, dynDb: 80, fmax: 8000, recRate: 48000, recCh: 2 };
    const ANALYSIS_KEYS = ['channel', 'thresholdDb', 'minGapMs', 'minDurMs', 'smoothHz', 'noiseSmoothHz', 'seqGapMs'];
    const SHAPE = { lineal: 'lineal', cos: 'coseno', cos2: 'coseno²', otra: 'otra', '': '—' };
    const SHAPE_EN = { lineal: 'linear', cos: 'quarter-cosine', cos2: 'raised-cosine (cos²)', otra: 'non-standard', '': '—' };
    const TYPE = { tono: 'tono', ruido: 'ruido', complejo: 'complejo', click: 'click' };

    const loadCfg = () => {
        const c = { ...DEF, ...Store.read(CFG_KEY, {}) };
        for (const k of Object.keys(c)) if (c[k] === null) c[k] = NaN; // JSON guarda NaN como null
        return c;
    };
    let cfg = loadCfg();
    let src = null;      // { name, origin, fs, channels, bits, format, note }
    let res = null;      // análisis del canal elegido
    let dirty = true;    // hay que volver a analizar
    let view = null;     // { t0, t1 } tramo visible
    let sel = null;      // estímulo seleccionado (objeto)
    let cmp = null;      // comparación entre canales

    const ms = (x, d = 2) => fmt(x * 1e3, d);
    const pm = (s, d = 2, k = 1) => !s || !s.n ? '—' : s.n === 1 || !isFinite(s.sd) ? fmt(s.mean * k, d) : `${fmt(s.mean * k, d)} ± ${fmt(s.sd * k, d)}`;
    const chName = (c, n) => n === 1 ? 'mono' : n === 2 ? ['izquierdo', 'derecho'][c] : `canal ${c + 1}`;
    const cal = v => isFinite(cfg.calOffset) ? v + cfg.calOffset : NaN;
    const hasCal = () => isFinite(cfg.calOffset);

    // ---------------- Pestañas ----------------
    function showTab(name) {
        $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
        $$('.panel').forEach(p => p.hidden = p.id !== `tab-${name}`);
        if (name === 'resultados') renderResults();
        root.LabMath && root.LabMath.render($(`#tab-${name}`));
        try { history.replaceState(null, '', `#${name}`); } catch (e) { /* file:// */ }
        window.scrollTo({ top: 0 });
    }

    function updateStatus() {
        const el = $('#status');
        if (!src) { el.innerHTML = '<span>Sin audio cargado</span>'; return; }
        el.innerHTML = `<strong>${esc(src.name)}</strong><span>${fmt(src.fs / 1000, 1)} kHz · ${src.channels.length} canal${src.channels.length > 1 ? 'es' : ''} · ${fmt(src.channels[0].length / src.fs, 2)} s</span>
            ${res && !dirty ? `<span class="badge ok">${res.stimuli.length} estímulos</span>` : '<span class="badge warn">sin analizar</span>'}`;
    }

    // ---------------- Ajustes ----------------
    function fillCfg() {
        $$('[data-cfg]').forEach(el => {
            const v = cfg[el.dataset.cfg];
            el.value = el.dataset.type === 'number' ? (isFinite(v) ? String(v).replace('.', ',') : '') : (v ?? '');
        });
    }
    function bindCfg() {
        $$('[data-cfg]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
            const k = el.dataset.cfg;
            cfg[k] = el.dataset.type === 'number' ? num(el.value) : el.value;
            if (el.dataset.type === 'number') el.classList.toggle('invalid', el.value.trim() !== '' && !isFinite(cfg[k]));
            if (ANALYSIS_KEYS.includes(k)) { dirty = true; cmp = null; }
            Store.write(CFG_KEY, cfg);
            updateStatus();
        }));
    }

    // ---------------- Carga de audio ----------------
    async function loadFile(f) {
        if (!f) return;
        toast(`Leyendo ${f.name}…`);
        const buf = await f.arrayBuffer();
        let s;
        try {
            s = AU.parseWav(buf);
            s.note = '';
        } catch (e) {
            try {
                const Ctx = root.OfflineAudioContext || root.webkitOfflineAudioContext;
                const ab = await new Ctx(1, 1, 48000).decodeAudioData(buf.slice(0));
                s = { fs: ab.sampleRate, channels: Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c)), bits: NaN, format: 'decodificado', n: ab.length };
                s.note = `Archivo no WAV: el navegador lo decodificó y remuestreó a ${fmt(ab.sampleRate / 1000, 1)} kHz. En formatos comprimidos (MP3, AAC) los tiempos incluyen el retardo del códec y las rampas pueden alterarse: para publicar use el WAV original.`;
            } catch (e2) {
                toast(`No se pudo leer el archivo: ${e.message}`, 'error');
                return;
            }
        }
        setSource({ ...s, name: f.name, origin: 'archivo' });
    }

    function setSource(s) {
        src = s;
        res = null; sel = null; view = null; cmp = null; dirty = true;
        const n = src.channels.length;
        $('#cfg-channel').innerHTML = src.channels.map((_, c) => `<option value="${c}">${c + 1} (${chName(c, n)})</option>`).join('');
        if (!(cfg.channel < n)) cfg.channel = 0;
        // Si el canal elegido está en silencio y otro no, se cambia solo
        const peak = c => { let p = 0; const x = src.channels[c]; for (let i = 0; i < x.length; i += 7) p = Math.max(p, Math.abs(x[i])); return p; };
        if (peak(cfg.channel) < 1e-4) { const alt = src.channels.findIndex((_, c) => peak(c) >= 1e-4); if (alt >= 0) cfg.channel = alt; }
        fillCfg();
        renderSource();
        updateStatus();
        runAnalysis(true);
    }

    function renderSource() {
        $('#src-card').hidden = !src;
        if (!src) return;
        const x = src.channels;
        $('#src-info').innerHTML = table(['Archivo', 'Origen', 'Muestreo', 'Resolución', 'Canales', 'Duración'], [[
            esc(src.name), esc(src.origin), `${fmt(src.fs, 0)} Hz`,
            src.format === 'float' ? `${src.bits} bits flotante` : isFinite(src.bits) ? `${src.bits} bits` : esc(src.format),
            x.length, `${fmt(x[0].length / src.fs, 3)} s`
        ]]) + (src.note ? `<div class="callout warn">${esc(src.note)}</div>` : '');
    }

    // ---------------- Análisis ----------------
    function runAnalysis(go) {
        if (!src) { toast('Primero cargue o grabe un audio', 'error'); return; }
        if (go) showTab('resultados');
        $('#results').innerHTML = '<div class="callout">Analizando…</div>';
        setTimeout(() => {
            try {
                const t = performance.now();
                res = AU.analyze(src.channels[cfg.channel] || src.channels[0], src.fs, cfg);
                res.ms = performance.now() - t;
                dirty = false;
                view = { t0: 0, t1: res.duration };
                sel = res.stimuli[0] || null;
            } catch (e) {
                console.error(e);
                $('#results').innerHTML = `<div class="callout error">Error al analizar: ${esc(e.message)}</div>`;
                return;
            }
            updateStatus();
            renderResults();
        }, 30);
    }

    // ---------------- Resultados ----------------
    function renderResults() {
        const el = $('#results');
        if (!src) {
            el.innerHTML = `<div class="callout">No hay audio. Cárguelo o grábelo en la pestaña <a href="#audio" data-goto="audio">Audio</a>,
                o <button type="button" class="link" data-action="example">vea una pista de ejemplo</button>.</div>`;
            bindCommon(el);
            return;
        }
        if (dirty || !res) { runAnalysis(false); return; }
        const r = res, n = src.channels.length;
        const tones = r.stimuli.filter(s => s.type === 'tono');
        el.innerHTML = `
            <div class="print-only print-head"><h2>${esc(document.title)}</h2><p>${esc(src.name)} · canal ${esc(chName(cfg.channel, n))} · ${new Date().toLocaleString('es-CL')}</p></div>
            <div class="kpis">
                <div class="kpi"><div class="l">Estímulos</div><div class="v">${r.stimuli.length}</div><div class="s">${r.classes.length} clase${r.classes.length === 1 ? '' : 's'} · ${r.sequences.length} ítem${r.sequences.length === 1 ? '' : 's'}</div></div>
                <div class="kpi"><div class="l">Audio</div><div class="v">${fmt(src.fs / 1000, 1)} kHz</div><div class="s">${fmt(r.duration, 2)} s · canal ${esc(chName(cfg.channel, n))}</div></div>
                <div class="kpi"><div class="l">Pico de la envolvente</div><div class="v">${fmt(r.peakDb, 1)} dBFS</div><div class="s">umbral ${fmt(r.thrDb, 1)} dBFS</div></div>
                <div class="kpi ${r.peakDb - r.floorDb >= 40 ? 'good' : 'bad'}"><div class="l">Ruido de fondo</div><div class="v">${isFinite(r.floorDb) ? fmt(r.floorDb, 1) + ' dBFS' : '—'}</div><div class="s">${isFinite(r.floorDb) ? `${fmt(r.peakDb - r.floorDb, 1)} dB bajo el pico` : 'silencio digital'}</div></div>
                ${tones.length ? `<div class="kpi"><div class="l">Resolución temporal</div><div class="v">${fmt(1e3 / src.fs, 4)} ms</div><div class="s">1 muestra; los cruces se interpolan</div></div>` : ''}
            </div>
            ${r.warnings.length ? `<div class="callout warn"><strong>Advertencias</strong><ul>${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}

            <div class="card">
                <h3>Vista de la señal</h3>
                <div class="grid auto no-print">
                    <div class="field"><label>Desde <small>(s)</small></label><input type="text" inputmode="decimal" id="v-t0"></div>
                    <div class="field"><label>Hasta <small>(s)</small></label><input type="text" inputmode="decimal" id="v-t1"></div>
                    <div class="field"><label>Ventana del espectrograma</label><select id="v-win">${[2.5, 5, 10, 20, 40, 80].map(w => `<option value="${w}" ${w === cfg.winMs ? 'selected' : ''}>${fmt(w, w < 10 ? 1 : 0)} ms</option>`).join('')}</select></div>
                    <div class="field"><label>Rango dinámico</label><select id="v-dyn">${[40, 60, 80, 100, 120].map(v => `<option value="${v}" ${v === cfg.dynDb ? 'selected' : ''}>${v} dB</option>`).join('')}</select></div>
                    <div class="field"><label>Frecuencia máx. <small>(Hz)</small></label><input type="text" inputmode="decimal" id="v-fmax" value="${fmt(Math.min(cfg.fmax, src.fs / 2), 0).replace(/\./g, '')}"></div>
                </div>
                <div class="actions no-print"><button type="button" id="v-apply">Aplicar</button><button type="button" id="v-all">Todo el archivo</button>
                    <button type="button" id="v-sel">Estímulo seleccionado</button><button type="button" id="v-prev">← Anterior</button><button type="button" id="v-next">Siguiente →</button></div>
                <div id="p-wave"></div>
                <figure class="plot spec"><figcaption><span>Espectrograma</span><span class="plot-tools no-print"><button type="button" id="spec-png" title="Imagen PNG de alta resolución">PNG</button></span></figcaption>
                    <canvas id="spec" width="1200" height="440"></canvas></figure>
            </div>

            <div class="card"><h3>Clases de estímulos</h3>
                <p class="muted small">Media ± DE. Los tonos se agrupan por frecuencia (G grave, A agudo) y duración (C corto, L largo); R = ruido, K = click, X = complejo.</p>
                ${classesTable()}</div>
            ${sequencesCard()}
            ${intervalsCard()}
            <div class="card"><h3>Estímulos</h3>${stimuliTable()}</div>
            <div class="card" id="detail"></div>
            ${n > 1 ? `<div class="card" id="channels"><h3>Comparación entre canales</h3><div id="cmp-body">${cmpHtml()}</div></div>` : ''}
            <div class="card"><h3>Texto para métodos</h3>
                <p class="muted small no-print">Revise y adapte. Describe lo medido en este archivo y canal.</p>
                <div class="methods" id="m-es">${methodsText('es')}</div>
                <div class="actions no-print"><button type="button" data-copy="m-es">Copiar (español)</button><button type="button" data-copy="m-en">Copiar (inglés)</button></div>
                <details class="no-print"><summary>English</summary><div class="methods" id="m-en">${methodsText('en')}</div></details>
            </div>
            <p class="muted small">Análisis en ${fmt(r.ms / 1000, 2)} s · LabAudio · envolvente de Hilbert, instantes al 10/50/90 % de la meseta.</p>`;
        bindCommon(el);
        bindResults(el);
        renderView();
        renderDetail();
    }

    function classesTable() {
        const c = res.classes;
        if (!c.length) return '<p class="muted">No se detectaron estímulos.</p>';
        return table(['Clase', 'Tipo', 'n', 'Frecuencia (Hz)', 'Duración nominal (ms)', 'Duración 50 % (ms)', 'Rampas (forma, ms)', 'Subida 10–90 (ms)', 'Bajada 90–10 (ms)',
            'Nivel (dBFS)', ...(hasCal() ? [esc(`Nivel (${cfg.calUnit})`)] : []), 'THD (%)'],
        c.map(k => [
            `<strong>${esc(k.label)}</strong>`, TYPE[k.type], k.n,
            k.type === 'ruido' ? `banda ${fmt(k.f05.mean, 0)}–${fmt(k.f95.mean, 0)}` : pm(k.f, 2),
            pm(k.dur0, 2, 1e3), pm(k.dur50, 2, 1e3),
            k.rampOnT.n ? `${SHAPE[k.shapeOn]} ${pm(k.rampOnT, 2, 1e3)} / ${SHAPE[k.shapeOff]} ${pm(k.rampOffT, 2, 1e3)}` : '—',
            pm(k.rise, 3, 1e3), pm(k.fall, 3, 1e3), pm(k.rmsDb, 2),
            ...(hasCal() ? [fmt(cal(k.rmsDb.mean), 1)] : []),
            k.thd.n ? pm(k.thd, 3, 100) : '—'
        ]), { className: 'compact' });
    }

    function intervalKind(v) {
        const a = res.stimuli[v.from - 1], b = res.stimuli[v.to - 1];
        if (a.type === 'ruido' && b.type === 'ruido' && v.within) return 'gap';
        return v.within ? 'dentro' : 'entre';
    }
    const KIND = { dentro: 'Dentro del ítem', entre: 'Entre ítems', gap: 'Gap en ruido' };

    function intervalsCard() {
        const iv = res.intervals;
        if (!iv.length) return '';
        const groups = ['dentro', 'gap', 'entre'].map(k => [k, iv.filter(v => intervalKind(v) === k)]).filter(g => g[1].length);
        const S = AU.summary;
        return `<div class="card"><h3>Intervalos</h3>
            ${table(['Tipo', 'n', 'ISI: fin → inicio al 50 % (ms)', 'Silencio entre cruces del 10 % (ms)', 'SOA: inicio → inicio (ms)', 'Mín – máx ISI (ms)'],
                groups.map(([k, g]) => { const s = S(g.map(v => v.gap50)); return [KIND[k], g.length, pm(s, 3, 1e3), pm(S(g.map(v => v.gap10)), 3, 1e3), pm(S(g.map(v => v.soa)), 3, 1e3), `${ms(s.min, 3)} – ${ms(s.max, 3)}`]; }), { className: 'compact' })}
            <p class="muted small">Separación entre ítems: ${isFinite(res.seqGap) ? `${ms(res.seqGap, 0)} ms (${isFinite(cfg.seqGapMs) && cfg.seqGapMs > 0 ? 'fijada' : 'automática'})` : 'no se encontró un salto claro: todo es un solo ítem'}.</p>
            <details><summary>Todos los intervalos (${iv.length})</summary>
                ${table(['De → a', 'Tipo', 'ISI 50 % (ms)', 'Silencio 10 % (ms)', 'SOA (ms)'], iv.slice(0, 1000).map(v => [`${v.from} → ${v.to}`, KIND[intervalKind(v)], ms(v.gap50, 3), ms(v.gap10, 3), ms(v.soa, 3)]), { className: 'compact' })}
            </details></div>`;
    }

    function sequencesCard() {
        const q = res.sequences;
        if (!q.length || q.length === res.stimuli.length) return '';
        const pats = {};
        q.forEach(s => { pats[s.pattern] = (pats[s.pattern] || 0) + 1; });
        return `<div class="card"><h3>Ítems y patrones</h3>
            <p class="muted small">${Object.entries(pats).sort((a, b) => b[1] - a[1]).map(([p, k]) => `<strong>${esc(p)}</strong> × ${k}`).join(' · ')}</p>
            ${table(['Ítem', 'Inicio (s)', 'Estímulos', 'Patrón', 'Duración del ítem (ms)', 'Intervalos internos (ms)'],
                q.slice(0, 500).map(s => [s.i, fmt(s.start, 4), `${s.stimuli[0]}–${s.stimuli[s.stimuli.length - 1]}`, `<strong>${esc(s.pattern)}</strong>`, ms(s.end - s.start, 2),
                    s.gaps.length ? s.gaps.slice(0, 12).map(g => ms(g, 2)).join('; ') + (s.gaps.length > 12 ? '…' : '') : '—']), { className: 'compact' })}</div>`;
    }

    function stimuliTable() {
        const st = res.stimuli;
        if (!st.length) return '<p class="muted">Ninguno.</p>';
        const max = 600;
        return table(['#', 'Ítem', 'Clase', 'Tipo', 'Inicio 50 % (s)', 'Dur. nominal (ms)', 'Dur. 50 % (ms)', 'Subida (ms)', 'Bajada (ms)', 'Rampa', 'Frecuencia (Hz)', 'Nivel (dBFS)', 'Pico (dBFS)', 'THD (%)', ''],
            st.slice(0, max).map(s => [s.i, s.seq ?? '', esc(s.label), TYPE[s.type], fmt(s.on50, 4), ms(s.dur0), ms(s.dur50), ms(s.rise, 3), ms(s.fall, 3),
                s.rampOn ? `${SHAPE[s.rampOn.shape]} ${ms(s.rampOn.T)}` : s.abrupt ? 'abrupta' : '—',
                s.type === 'ruido' ? `${fmt(s.f05, 0)}–${fmt(s.f95, 0)}` : fmt(s.f, 2), fmt(s.rmsDb, 2), fmt(s.peakDb, 2), isFinite(s.thd) ? fmt(s.thd * 100, 3) : '—',
                `<button type="button" class="no-print" data-sel="${s.i}">Ver</button>`]), { className: 'compact' })
            + (st.length > max ? `<p class="muted small">Se muestran ${max} de ${st.length}. El CSV los incluye todos.</p>` : '');
    }

    // ---------------- Vista: forma de onda + espectrograma ----------------
    function renderView() {
        if (!res) return;
        const x = src.channels[cfg.channel], fs = src.fs, env = res.env;
        const { t0, t1 } = view;
        $('#v-t0').value = fmt(t0, 4); $('#v-t1').value = fmt(t1, 4);
        const useMs = t1 - t0 < 1, k = useMs ? 1e3 : 1;
        const i0 = Math.max(0, Math.floor(t0 * fs)), i1 = Math.min(x.length - 1, Math.ceil(t1 * fs));
        const cols = Math.min(700, i1 - i0 + 1), per = (i1 - i0 + 1) / cols;
        const wave = [], envPts = [];
        for (let c = 0; c < cols; c++) {
            const a = i0 + Math.floor(c * per), b = Math.min(i1, i0 + Math.floor((c + 1) * per) - 1);
            let lo = Infinity, hi = -Infinity, e = 0;
            for (let i = a; i <= Math.max(a, b); i++) { if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; if (env[i] > e) e = env[i]; }
            const t = (a / fs) * k;
            if (per > 1) { wave.push([t, lo], [t, hi]); } else wave.push([t, x[a]]);
            envPts.push([t, e]);
        }
        const inView = res.stimuli.filter(s => s.off50 >= t0 && s.on50 <= t1);
        const marks = inView.length <= 400 ? inView.flatMap(s => [[s.on50 * k, s.A / 2], [s.off50 * k, s.A / 2]]) : [];
        plot($('#p-wave'), {
            title: 'Forma de onda y envolvente', xLabel: useMs ? 'Tiempo (ms)' : 'Tiempo (s)', yLabel: 'Amplitud (escala completa = 1)',
            series: [
                { label: 'Señal', points: wave, kind: 'line', color: 1, width: 1, sort: false },
                { label: 'Envolvente', points: envPts, kind: 'line', color: 2, width: 1.5 },
                { label: 'Inicio / fin al 50 %', points: marks, kind: 'scatter', color: 3 }
            ],
            hlines: [{ y: 10 ** (res.thrDb / 20), label: 'umbral' }]
        });
        drawSpectrogramInto($('#spec'));
    }

    const VIRIDIS = [[68, 1, 84], [72, 36, 117], [65, 68, 135], [53, 95, 141], [42, 120, 142], [33, 145, 140], [34, 168, 132], [68, 191, 112], [122, 209, 81], [189, 223, 38], [253, 231, 37]];
    function viridis(u) {
        u = Math.min(1, Math.max(0, u)) * (VIRIDIS.length - 1);
        const i = Math.min(VIRIDIS.length - 2, Math.floor(u)), f = u - i, a = VIRIDIS[i], b = VIRIDIS[i + 1];
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    function niceStep(range, target) {
        const raw = range / target, mag = 10 ** Math.floor(Math.log10(raw)), nn = raw / mag;
        return (nn < 1.5 ? 1 : nn < 3 ? 2 : nn < 7 ? 5 : 10) * mag;
    }

    let specCache = null;
    function specData(W, H) {
        const key = [src.name, cfg.channel, view.t0, view.t1, cfg.winMs, cfg.fmax, W, H].join('|');
        if (specCache && specCache.key === key) return specCache.S;
        const S = AU.spectrogram(src.channels[cfg.channel], src.fs, view.t0, view.t1, { winMs: cfg.winMs, cols: W, rows: H, fmax: Math.min(cfg.fmax, src.fs / 2) });
        specCache = { key, S };
        return S;
    }

    /** Dibuja el espectrograma con ejes y barra de color. colors: { bg, text, grid }. s = escala (1 pantalla, 2 exportación). */
    function drawSpectrogram(canvas, colors, s, title) {
        const W = canvas.width, H = canvas.height;
        const m = { l: 70 * s, r: 86 * s, t: (title ? 40 : 22) * s, b: 46 * s };
        const pw = Math.round(W - m.l - m.r), ph = Math.round(H - m.t - m.b);
        const S = specData(Math.round(pw / s), Math.round(ph / s));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, W, H);
        let top = -Infinity;
        for (let i = 0; i < S.db.length; i++) if (S.db[i] > top) top = S.db[i];
        top = Math.ceil(top / 10) * 10;
        const bot = top - cfg.dynDb;
        const img = ctx.createImageData(S.cols, S.rows);
        for (let c = 0; c < S.cols; c++) for (let r = 0; r < S.rows; r++) {
            const [R, G, B] = viridis((S.db[c * S.rows + r] - bot) / (top - bot));
            const p = ((S.rows - 1 - r) * S.cols + c) * 4;
            img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = 255;
        }
        const tmp = document.createElement('canvas');
        tmp.width = S.cols; tmp.height = S.rows;
        tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, m.l, m.t, pw, ph);
        // Ejes
        ctx.strokeStyle = colors.grid; ctx.lineWidth = s; ctx.strokeRect(m.l, m.t, pw, ph);
        ctx.fillStyle = colors.text; ctx.font = `${12 * s}px Helvetica, Arial, sans-serif`;
        const useMs = S.t1 - S.t0 < 1, k = useMs ? 1e3 : 1;
        const a = S.t0 * k, b = S.t1 * k, st = niceStep(b - a, 8);
        const dec = Math.max(0, Math.ceil(-Math.log10(st) - 1e-9));
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (let v = Math.ceil(a / st) * st; v <= b; v += st) {
            const X = m.l + (v - a) / (b - a) * pw;
            ctx.fillRect(X, m.t + ph, s, 5 * s);
            ctx.fillText(fmt(v, dec), X, m.t + ph + 8 * s);
        }
        const fk = S.fmax >= 2000, fst = niceStep(fk ? S.fmax / 1000 : S.fmax, 6);
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        for (let v = 0; v <= (fk ? S.fmax / 1000 : S.fmax) + 1e-9; v += fst) {
            const Y = m.t + ph - v / (fk ? S.fmax / 1000 : S.fmax) * ph;
            ctx.fillRect(m.l - 5 * s, Y, 5 * s, s);
            ctx.fillText(fmt(v, fst < 1 ? 1 : 0), m.l - 8 * s, Y);
        }
        ctx.font = `bold ${13 * s}px Helvetica, Arial, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(useMs ? 'Tiempo (ms)' : 'Tiempo (s)', m.l + pw / 2, H - 8 * s);
        ctx.save(); ctx.translate(18 * s, m.t + ph / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(fk ? 'Frecuencia (kHz)' : 'Frecuencia (Hz)', 0, 0); ctx.restore();
        if (title) ctx.fillText(title, W / 2, 20 * s);
        // Barra de color
        const bx = m.l + pw + 18 * s, bw = 14 * s;
        for (let y = 0; y < ph; y++) { const [R, G, B] = viridis(1 - y / ph); ctx.fillStyle = `rgb(${R | 0},${G | 0},${B | 0})`; ctx.fillRect(bx, m.t + y, bw, 1.5); }
        ctx.strokeStyle = colors.grid; ctx.strokeRect(bx, m.t, bw, ph);
        ctx.fillStyle = colors.text; ctx.font = `${11 * s}px Helvetica, Arial, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const dst = niceStep(cfg.dynDb, 5);
        for (let v = top; v >= bot - 1e-9; v -= dst) ctx.fillText(fmt(v, 0), bx + bw + 4 * s, m.t + (top - v) / (top - bot) * ph);
        ctx.textBaseline = 'bottom'; ctx.fillText('dBFS', bx - 2 * s, m.t - 2 * s);
        ctx.textBaseline = 'top'; ctx.fillText(`ventana ${fmt(S.winMs, S.winMs < 10 ? 2 : 1)} ms`, bx - 30 * s, m.t + ph + 22 * s);
    }

    function drawSpectrogramInto(canvas) {
        // Resolución real del canvas = ancho en pantalla × densidad de píxeles: texto nítido y del tamaño correcto
        const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 800;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(Math.min(440, Math.max(260, w * 0.42)) * dpr);
        const css = getComputedStyle(document.documentElement);
        drawSpectrogram(canvas, { bg: css.getPropertyValue('--surface').trim() || '#fff', text: css.getPropertyValue('--text').trim() || '#000', grid: css.getPropertyValue('--border').trim() || '#999' }, dpr);
    }

    function exportSpectrogram() {
        const c = document.createElement('canvas');
        c.width = 2400; c.height = 940;
        drawSpectrogram(c, { bg: '#ffffff', text: '#111111', grid: '#8a93a3' }, 2, `Espectrograma — ${src.name}`);
        c.toBlob(b => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(b);
            a.download = `${slug(`${src.name} - espectrograma ${fmt(view.t0, 3)}-${fmt(view.t1, 3)} s`)}.png`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        }, 'image/png');
    }

    // ---------------- Detalle de un estímulo ----------------
    const SHAPE_FN = { lineal: u => u, cos: u => Math.sin(Math.PI * u / 2), cos2: u => Math.sin(Math.PI * u / 2) ** 2 };

    function renderDetail() {
        const el = $('#detail');
        if (!el) return;
        const s = sel;
        if (!s) { el.innerHTML = '<h3>Detalle del estímulo</h3><p class="muted">Elija un estímulo con “Ver”.</p>'; return; }
        const x = src.channels[cfg.channel], fs = src.fs, env = res.env;
        el.innerHTML = `<h3>Detalle del estímulo ${s.i} <span class="muted small">(clase ${esc(s.label)}, ${TYPE[s.type]}${s.seq ? `, ítem ${s.seq}` : ''})</span></h3>
            ${table(['Magnitud', 'Valor'], [
                ['Inicio al 10 / 50 / 90 % (s)', `${fmt(s.on10, 5)} / ${fmt(s.on50, 5)} / ${fmt(s.on90, 5)}`],
                ['Fin al 90 / 50 / 10 % (s)', `${fmt(s.off90, 5)} / ${fmt(s.off50, 5)} / ${fmt(s.off10, 5)}`],
                ['Duración nominal / al 50 % / al 10 % / meseta 90 % (ms)', `${ms(s.dur0, 3)} / ${ms(s.dur50, 3)} / ${ms(s.dur10, 3)} / ${ms(s.plateau, 3)}`],
                ['Rampa de subida', s.rampOn ? `${SHAPE[s.rampOn.shape]}, T = ${ms(s.rampOn.T, 3)} ms (residuo ${fmt(s.rampOn.rel * 100, 1)} %); 10–90 %: ${ms(s.rise, 3)} ms` : `abrupta; 10–90 %: ${ms(s.rise, 3)} ms`],
                ['Rampa de bajada', s.rampOff ? `${SHAPE[s.rampOff.shape]}, T = ${ms(s.rampOff.T, 3)} ms (residuo ${fmt(s.rampOff.rel * 100, 1)} %); 90–10 %: ${ms(s.fall, 3)} ms` : `abrupta; 90–10 %: ${ms(s.fall, 3)} ms`],
                ['Frecuencia', s.type === 'ruido' ? `banda 5–95 %: ${fmt(s.f05, 0)}–${fmt(s.f95, 0)} Hz; centroide ${fmt(s.centroid, 0)} Hz` : `${fmt(s.f, 3)} Hz (tonalidad ${fmt(s.tonal * 100, 1)} %)`],
                ['Nivel RMS / pico / factor de cresta', `${fmt(s.rmsDb, 2)} dBFS / ${fmt(s.peakDb, 2)} dBFS / ${fmt(s.crestDb, 2)} dB${hasCal() ? ` · ${fmt(cal(s.rmsDb), 1)} ${esc(cfg.calUnit)}` : ''}`],
                ['THD / recortes', `${isFinite(s.thd) ? fmt(s.thd * 100, 4) + ' %' : '—'} / ${s.clip} muestras`]
            ], { className: 'compact' })}
            <div class="plots"><div id="p-on"></div><div id="p-off"></div></div>
            <div id="p-spec"></div>
            <div class="grid auto no-print" style="align-items:end">
                <div class="field"><label>Nivel conocido de este estímulo <small>(${esc(cfg.calUnit)})</small></label><input type="text" inputmode="decimal" id="cal-known" placeholder="p. ej. 94"></div>
                <div class="field"><button type="button" id="cal-set">Usar como referencia de nivel</button></div>
            </div>`;

        const rampPlot = (target, onset) => {
            const ref = onset ? s.on50 : s.off50;
            const span = Math.max(onset ? s.rise : s.fall, 0.5e-3) * 1.6 + 0.5e-3;
            const a = onset ? s.on10 - span : s.off90 - span, b = onset ? s.on90 + span : s.off10 + span;
            const i0 = Math.max(0, Math.floor(a * fs)), i1 = Math.min(x.length - 1, Math.ceil(b * fs));
            const step = Math.max(1, Math.ceil((i1 - i0) / 1400));
            const E = [], W = [];
            for (let i = i0; i <= i1; i += step) E.push([(i / fs - ref) * 1e3, 100 * env[i] / s.A]);
            if (i1 - i0 <= 1400) for (let i = i0; i <= i1; i++) W.push([(i / fs - ref) * 1e3, 100 * x[i] / s.A]);
            const r = onset ? s.rampOn : s.rampOff, fit = [];
            if (r && SHAPE_FN[r.shape]) for (let k = 0; k <= 100; k++) {
                const u = k / 100, t = onset ? r.t0 + u * r.T : r.t0 - u * r.T;
                fit.push([(t - ref) * 1e3, 100 * SHAPE_FN[r.shape](u)]);
            }
            plot(target, {
                title: `${onset ? 'Subida' : 'Bajada'} — estímulo ${s.i}`, xLabel: `Tiempo desde el ${onset ? 'inicio' : 'fin'} al 50 % (ms)`, yLabel: '% de la meseta',
                series: [
                    { label: 'Señal', points: W, kind: 'line', color: 1, width: 0.8, sort: false },
                    { label: 'Envolvente', points: E, kind: 'line', color: 2 },
                    { label: r && SHAPE_FN[r.shape] ? `Ajuste ${SHAPE[r.shape]} (T = ${ms(r.T)} ms)` : '', points: fit, kind: 'line', color: 3, width: 1.5 }
                ],
                hlines: [{ y: 10, label: '10 %' }, { y: 50, label: '50 %' }, { y: 90, label: '90 %' }]
            });
        };
        rampPlot($('#p-on'), true);
        rampPlot($('#p-off'), false);

        const pa = s.plateau > 0.002 ? [s.on90, s.off90] : [s.on50, s.off50];
        const sp = AU.spectrum(x, Math.max(0, Math.round(pa[0] * fs)), Math.min(x.length - 1, Math.round(pa[1] * fs)), fs);
        if (sp) {
            const fmax = Math.min(fs / 2, cfg.fmax), kmax = Math.min(sp.mag.length - 1, Math.floor(fmax / sp.df));
            const per = Math.max(1, Math.ceil(kmax / 1400)), pts = [];
            for (let k = 1; k <= kmax; k += per) {
                let m = 0;
                for (let j = k; j < Math.min(k + per, kmax + 1); j++) if (sp.mag[j] > m) m = sp.mag[j];
                pts.push([k * sp.df, Math.max(-160, 20 * Math.log10(m || 1e-12))]);
            }
            plot($('#p-spec'), { title: `Espectro de la meseta — estímulo ${s.i}`, xLabel: 'Frecuencia (Hz)', yLabel: 'Amplitud (dBFS)', series: [{ label: '', points: pts, kind: 'line', color: 4, width: 1.2 }] });
        }
        $('#cal-set').addEventListener('click', () => {
            const v = num($('#cal-known').value);
            if (!isFinite(v)) { toast('Ingrese el nivel conocido', 'error'); return; }
            cfg.calOffset = v - s.rmsDb;
            Store.write(CFG_KEY, cfg); fillCfg();
            toast(`C = ${fmt(cfg.calOffset, 2)} dB`, 'ok');
            renderResults();
        });
    }

    // ---------------- Canales ----------------
    function cmpHtml() {
        if (!cmp) return `<p class="muted small">Analiza los dos primeros canales con los mismos ajustes y empareja los estímulos por su inicio.
            Útil en pruebas dicóticas o para verificar que ambos oídos reciben lo mismo.</p><button type="button" id="cmp-run">Comparar canales 1 y 2</button>`;
        const c = cmp;
        return `${table(['Magnitud (canal 2 − canal 1)', 'Media ± DE', 'Mín – máx'], [
                ['Asincronía de inicio (ms)', pm(c.dOn, 4, 1e3), `${ms(c.dOn.min, 4)} – ${ms(c.dOn.max, 4)}`],
                ['Asincronía de fin (ms)', pm(c.dOff, 4, 1e3), `${ms(c.dOff.min, 4)} – ${ms(c.dOff.max, 4)}`],
                ['Diferencia de nivel (dB)', pm(c.dLevel, 2), `${fmt(c.dLevel.min, 2)} – ${fmt(c.dLevel.max, 2)}`]
            ], { className: 'compact' })}
            <p class="muted small">${c.pairs.length} pares · ${c.onlyA} solo en el canal 1 · ${c.onlyB} solo en el canal 2.</p>`;
    }

    function runCompare() {
        const body = $('#cmp-body');
        body.innerHTML = '<p class="muted">Analizando…</p>';
        setTimeout(() => {
            const ra = cfg.channel === 0 ? res : AU.analyze(src.channels[0], src.fs, cfg);
            const rb = cfg.channel === 1 ? res : AU.analyze(src.channels[1], src.fs, cfg);
            cmp = AU.compareChannels(ra, rb);
            body.innerHTML = cmpHtml();
        }, 30);
    }

    // ---------------- Texto para métodos ----------------
    function methodsText(lang) {
        const r = res, en = lang === 'en';
        const F = (v, d) => !isFinite(v) ? '—' : en ? (+v).toFixed(d) : fmt(v, d);
        const PM = (s, d, k = 1) => !s || !s.n ? '—' : s.n > 1 && isFinite(s.sd) ? `${F(s.mean * k, d)} ± ${F(s.sd * k, d)}` : F(s.mean * k, d);
        const nch = src.channels.length;
        const chn = en ? (nch === 1 ? 'mono' : nch === 2 ? ['left', 'right'][cfg.channel] : `channel ${cfg.channel + 1}`) : chName(cfg.channel, nch);
        const fmtName = src.format === 'float' ? (en ? `${src.bits}-bit float WAV` : `WAV ${src.bits} bits flotante`) : isFinite(src.bits) ? (en ? `${src.bits}-bit PCM WAV` : `WAV PCM ${src.bits} bits`) : (en ? 'decoded compressed file' : 'archivo comprimido decodificado');
        const origin = src.origin === 'grabación' ? (en ? 'a recording of the playback output' : 'una grabación de la salida de reproducción') : src.origin === 'ejemplo' ? (en ? 'a simulated track' : 'una pista simulada') : (en ? 'the stimulus file' : 'el archivo de estímulos');
        const calTxt = hasCal() ? (en ? `; calibrated levels in ${cfg.calUnit} were obtained by adding ${F(cfg.calOffset, 1)} dB` : `; los niveles en ${cfg.calUnit} se obtuvieron sumando ${F(cfg.calOffset, 1)} dB`) : '';
        const p1 = en
            ? `Stimuli were characterized by digital analysis of ${origin} (${fmtName}, ${F(src.fs / 1000, 1)} kHz, ${chn} channel). The temporal envelope was computed as the magnitude of the analytic signal (Hilbert transform). Onset and offset times were defined at the 50 % crossing of the plateau amplitude, interpolated between samples, and rise/fall times between the 10 % and 90 % crossings. Ramp shape and nominal ramp duration were estimated by fitting the 10–90 % crossings to linear, quarter-cosine and raised-cosine (cos²) ramps. Frequency was estimated on the plateau by FFT (Hann window, 8× zero padding, parabolic peak interpolation). Levels are RMS values in dBFS (0 dBFS = full-scale sinusoid)${calTxt}.`
            : `Los estímulos se caracterizaron mediante el análisis digital de ${origin} (${fmtName}, ${F(src.fs / 1000, 1)} kHz, canal ${chn}). La envolvente temporal se obtuvo como el módulo de la señal analítica (transformada de Hilbert). Los instantes de inicio y fin se definieron en el cruce del 50 % de la amplitud de la meseta, interpolado entre muestras, y los tiempos de subida y bajada entre los cruces del 10 % y del 90 %. La forma y la duración nominal de las rampas se estimaron ajustando los cruces del 10 al 90 % a rampas lineal, coseno y coseno². La frecuencia se estimó en la meseta mediante FFT (ventana de Hann, relleno de ceros ×8 e interpolación parabólica del pico). Los niveles son valores RMS en dBFS (0 dBFS = sinusoide de escala completa)${calTxt}.`;
        const cls = r.classes.map(k => {
            const lvl = `${PM(k.rmsDb, 1)} dBFS${hasCal() ? ` (${F(cal(k.rmsDb.mean), 1)} ${cfg.calUnit})` : ''}`;
            if (k.type === 'tono') {
                const ramp = k.rampOnT.n
                    ? (en ? `${SHAPE_EN[k.shapeOn]} onset ramp of ${PM(k.rampOnT, 2, 1e3)} ms and ${SHAPE_EN[k.shapeOff]} offset ramp of ${PM(k.rampOffT, 2, 1e3)} ms (10–90 % rise ${PM(k.rise, 2, 1e3)} ms, fall ${PM(k.fall, 2, 1e3)} ms)`
                        : `rampa de subida ${SHAPE[k.shapeOn]} de ${PM(k.rampOnT, 2, 1e3)} ms y de bajada ${SHAPE[k.shapeOff]} de ${PM(k.rampOffT, 2, 1e3)} ms (subida 10–90 %: ${PM(k.rise, 2, 1e3)} ms; bajada: ${PM(k.fall, 2, 1e3)} ms)`)
                    : (en ? `abrupt onset (10–90 % rise ${PM(k.rise, 3, 1e3)} ms)` : `inicio abrupto (subida 10–90 %: ${PM(k.rise, 3, 1e3)} ms)`);
                const dur = isFinite(k.dur0.mean) ? (en ? `nominal duration ${PM(k.dur0, 2, 1e3)} ms (${PM(k.dur50, 2, 1e3)} ms at 50 %)` : `duración nominal de ${PM(k.dur0, 2, 1e3)} ms (${PM(k.dur50, 2, 1e3)} ms al 50 %)`)
                    : (en ? `duration ${PM(k.dur50, 2, 1e3)} ms at 50 %` : `duración de ${PM(k.dur50, 2, 1e3)} ms al 50 %`);
                const thd = k.thd.n ? (en ? `, THD ${F(k.thd.mean * 100, 3)} %` : `, THD ${F(k.thd.mean * 100, 3)} %`) : '';
                return en ? `Class ${k.label} (n = ${k.n}): pure tones of ${PM(k.f, 2)} Hz, ${dur}, ${ramp}, level ${lvl}${thd}.`
                    : `Clase ${k.label} (n = ${k.n}): tonos puros de ${PM(k.f, 2)} Hz, ${dur}, ${ramp}, nivel ${lvl}${thd}.`;
            }
            const what = en ? { ruido: 'noise bursts', click: 'clicks', complejo: 'complex sounds' }[k.type] : { ruido: 'segmentos de ruido', click: 'clicks', complejo: 'sonidos complejos' }[k.type];
            const band = k.type === 'ruido' ? (en ? ` (5–95 % energy band ${F(k.f05.mean, 0)}–${F(k.f95.mean, 0)} Hz)` : ` (banda del 5–95 % de la energía: ${F(k.f05.mean, 0)}–${F(k.f95.mean, 0)} Hz)`) : '';
            return en ? `Class ${k.label} (n = ${k.n}): ${what}${band}, duration ${PM(k.dur50, 2, 1e3)} ms at 50 %, level ${lvl}.`
                : `Clase ${k.label} (n = ${k.n}): ${what}${band}, duración de ${PM(k.dur50, 2, 1e3)} ms al 50 %, nivel ${lvl}.`;
        });
        const S = AU.summary, iv = r.intervals;
        const part = k => iv.filter(v => intervalKind(v) === k);
        const ivTxt = [];
        const d = part('dentro'), b = part('entre'), g = part('gap');
        if (d.length) ivTxt.push(en ? `Within items, the inter-stimulus interval (offset to onset, 50 %) was ${PM(S(d.map(v => v.gap50)), 2, 1e3)} ms and the stimulus onset asynchrony ${PM(S(d.map(v => v.soa)), 2, 1e3)} ms (n = ${d.length}).`
            : `Dentro de cada ítem, el intervalo entre estímulos (fin a inicio, 50 %) fue de ${PM(S(d.map(v => v.gap50)), 2, 1e3)} ms y la asincronía de inicio (SOA) de ${PM(S(d.map(v => v.soa)), 2, 1e3)} ms (n = ${d.length}).`);
        if (b.length) ivTxt.push(en ? `Items were separated by ${PM(S(b.map(v => v.gap50)), 1, 1e3)} ms (n = ${b.length}).` : `Los ítems estuvieron separados por ${PM(S(b.map(v => v.gap50)), 1, 1e3)} ms (n = ${b.length}).`);
        if (g.length) {
            const vals = [...new Set(g.map(v => F(v.gap50 * 1e3, 2)))];
            ivTxt.push(en ? `Gaps in noise (50 % crossings) measured ${vals.length <= 15 ? vals.join('; ') : `${F(S(g.map(v => v.gap50)).min * 1e3, 2)} to ${F(S(g.map(v => v.gap50)).max * 1e3, 2)}`} ms (n = ${g.length}).`
                : `Los gaps en el ruido (cruces del 50 %) midieron ${vals.length <= 15 ? vals.join('; ') : `de ${F(S(g.map(v => v.gap50)).min * 1e3, 2)} a ${F(S(g.map(v => v.gap50)).max * 1e3, 2)}`} ms (n = ${g.length}).`);
        }
        const tail = en ? 'Values are mean ± SD.' : 'Valores: media ± DE.';
        const intro = en ? `${r.stimuli.length} stimuli were detected.` : `Se detectaron ${r.stimuli.length} estímulos.`;
        return `<p>${esc(p1)}</p><p>${esc([intro, ...cls, ...ivTxt, tail].join(' '))}</p>`;
    }

    // ---------------- Exportaciones ----------------
    function exportData(kind) {
        if (!res) { toast('Primero analice un audio', 'error'); return; }
        const base = slug(`${src.name.replace(/\.[^.]+$/, '')}_canal${cfg.channel + 1}`);
        const r6 = v => isFinite(v) ? +(+v).toPrecision(9) : '';
        if (kind === 'estimulos') {
            download(`${base}_estimulos.csv`, toCSV(['#', 'Item', 'Clase', 'Tipo', 'Inicio 10% [s]', 'Inicio 50% [s]', 'Inicio 90% [s]', 'Fin 90% [s]', 'Fin 50% [s]', 'Fin 10% [s]',
                'Duracion nominal [ms]', 'Duracion 50% [ms]', 'Duracion 10% [ms]', 'Meseta 90% [ms]', 'Subida 10-90 [ms]', 'Bajada 90-10 [ms]',
                'Rampa subida forma', 'Rampa subida T [ms]', 'Rampa bajada forma', 'Rampa bajada T [ms]', 'Frecuencia [Hz]', 'Tonalidad', 'THD [%]', 'Banda 5% [Hz]', 'Banda 95% [Hz]',
                'Nivel RMS [dBFS]', 'Pico [dBFS]', 'Factor de cresta [dB]', ...(hasCal() ? [`Nivel [${cfg.calUnit}]`] : []), 'Recortes'],
            res.stimuli.map(s => [s.i, s.seq ?? '', s.label, s.type, r6(s.on10), r6(s.on50), r6(s.on90), r6(s.off90), r6(s.off50), r6(s.off10),
                r6(s.dur0 * 1e3), r6(s.dur50 * 1e3), r6(s.dur10 * 1e3), r6(s.plateau * 1e3), r6(s.rise * 1e3), r6(s.fall * 1e3),
                s.rampOn ? s.rampOn.shape : '', s.rampOn ? r6(s.rampOn.T * 1e3) : '', s.rampOff ? s.rampOff.shape : '', s.rampOff ? r6(s.rampOff.T * 1e3) : '',
                r6(s.f), r6(s.tonal), r6(s.thd * 100), r6(s.f05), r6(s.f95), r6(s.rmsDb), r6(s.peakDb), r6(s.crestDb), ...(hasCal() ? [r6(cal(s.rmsDb))] : []), s.clip])), 'text/csv');
        } else if (kind === 'intervalos') {
            download(`${base}_intervalos.csv`, toCSV(['De', 'A', 'Tipo', 'ISI 50% [ms]', 'Silencio 10% [ms]', 'SOA [ms]'],
                res.intervals.map(v => [v.from, v.to, KIND[intervalKind(v)], r6(v.gap50 * 1e3), r6(v.gap10 * 1e3), r6(v.soa * 1e3)])), 'text/csv');
        } else if (kind === 'clases') {
            const cols = [['f', 'Frecuencia [Hz]', 1], ['dur0', 'Duracion nominal [ms]', 1e3], ['dur50', 'Duracion 50% [ms]', 1e3], ['rampOnT', 'Rampa subida T [ms]', 1e3], ['rampOffT', 'Rampa bajada T [ms]', 1e3],
                ['rise', 'Subida 10-90 [ms]', 1e3], ['fall', 'Bajada 90-10 [ms]', 1e3], ['rmsDb', 'Nivel RMS [dBFS]', 1], ['thd', 'THD [%]', 100]];
            download(`${base}_clases.csv`, toCSV(['Clase', 'Tipo', 'n', 'Forma subida', 'Forma bajada', ...cols.flatMap(c => [`${c[1]} media`, `${c[1]} DE`, `${c[1]} min`, `${c[1]} max`])],
                res.classes.map(k => [k.label, k.type, k.n, k.shapeOn, k.shapeOff, ...cols.flatMap(([key, , f]) => [r6(k[key].mean * f), r6(k[key].sd * f), r6(k[key].min * f), r6(k[key].max * f)])])), 'text/csv');
        } else {
            const { env, ...rest } = res;
            download(`${base}_analisis.json`, JSON.stringify({ app: 'laboratorio-calibracion', module: 'audio', date: new Date().toISOString(),
                source: { name: src.name, origin: src.origin, fs: src.fs, bits: src.bits, format: src.format, channels: src.channels.length, samples: src.channels[0].length },
                channel: cfg.channel, cfg, result: rest }, (k, v) => typeof v === 'number' && !isFinite(v) ? null : v, 2), 'application/json');
        }
    }

    // ---------------- Grabación ----------------
    const rec = { stream: null, ctx: null, node: null, chunks: null, n: 0, peak: 0, peakHold: 0, timer: 0 };

    async function refreshDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        const sel = $('#rec-dev'), cur = sel.value;
        const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId !== 'default');
        sel.innerHTML = '<option value="">Predeterminada del sistema</option>' + devs.map((d, i) => {
            const label = d.label || `Entrada ${i + 1} (dé permiso para ver el nombre)`;
            return `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${/monitor|mezcla|stereo mix|loopback|blackhole|cable/i.test(label) ? '⟲ ' : ''}${esc(label)}</option>`;
        }).join('');
    }

    async function startRec() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Este navegador no permite grabar (use Chrome, Edge o Firefox)', 'error'); return; }
        const chN = cfg.recCh === 1 ? 1 : 2, rate = cfg.recRate || 48000, dev = $('#rec-dev').value;
        try {
            rec.stream = await navigator.mediaDevices.getUserMedia({ audio: {
                deviceId: dev ? { exact: dev } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
                channelCount: { ideal: chN }, sampleRate: { ideal: rate } } });
        } catch (e) { toast(`No se pudo abrir la entrada: ${e.message}`, 'error'); return; }
        refreshDevices();
        let ctx, srcNode;
        try { ctx = new AudioContext({ sampleRate: rate }); srcNode = ctx.createMediaStreamSource(rec.stream); }
        catch (e) { if (ctx) ctx.close(); ctx = new AudioContext(); srcNode = ctx.createMediaStreamSource(rec.stream); }
        rec.ctx = ctx; rec.chunks = Array.from({ length: chN }, () => []); rec.n = 0; rec.peak = 0; rec.peakHold = 0;
        const onData = chans => {
            if (!chans.length) return;
            for (let c = 0; c < chN; c++) rec.chunks[c].push(chans[Math.min(c, chans.length - 1)]);
            rec.n += chans[0].length;
            for (const d of chans) for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > rec.peak) rec.peak = v; }
        };
        try {
            const code = "registerProcessor('lab-rec', class extends AudioWorkletProcessor { process(inputs) { const i = inputs[0]; if (i && i.length) this.port.postMessage(i.map(c => c.slice(0))); return true; } });";
            const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
            await ctx.audioWorklet.addModule(url);
            URL.revokeObjectURL(url);
            rec.node = new AudioWorkletNode(ctx, 'lab-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: chN, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
            rec.node.port.onmessage = e => onData(e.data);
        } catch (e) {
            rec.node = ctx.createScriptProcessor(4096, chN, chN);
            rec.node.onaudioprocess = e => onData(Array.from({ length: e.inputBuffer.numberOfChannels }, (_, c) => e.inputBuffer.getChannelData(c).slice(0)));
        }
        const mute = ctx.createGain();
        mute.gain.value = 0;
        srcNode.connect(rec.node); rec.node.connect(mute); mute.connect(ctx.destination);
        const st = rec.stream.getAudioTracks()[0].getSettings ? rec.stream.getAudioTracks()[0].getSettings() : {};
        rec.info = { device: rec.stream.getAudioTracks()[0].label, rate: ctx.sampleRate, st };
        $('#rec-start').disabled = true; $('#rec-stop').disabled = false;
        const warn = [];
        if (ctx.sampleRate !== rate) warn.push(`el navegador graba a ${ctx.sampleRate} Hz (no a ${rate})`);
        if (st.echoCancellation || st.noiseSuppression || st.autoGainControl) warn.push('la entrada tiene procesamiento activo (eco/ruido/ganancia)');
        if (st.channelCount && st.channelCount < chN) warn.push('la entrada es mono: el canal 2 queda en silencio');
        rec.timer = setInterval(() => {
            const pk = rec.peak; rec.peakHold = Math.max(rec.peakHold, pk); rec.peak = 0;
            const d = pk > 0 ? 20 * Math.log10(pk) : -Infinity;
            $('#rec-meter').style.width = `${Math.max(0, Math.min(100, (d + 60) / 60 * 100))}%`;
            $('#rec-meter').classList.toggle('hot', d > -1);
            $('#rec-status').innerHTML = `<strong>Grabando</strong> · ${esc(rec.info.device)} · ${fmt(rec.info.rate, 0)} Hz · ${fmt(rec.n / ctx.sampleRate, 1)} s ·
                pico ${isFinite(d) ? fmt(d, 1) : '−∞'} dBFS (máx. ${rec.peakHold > 0 ? fmt(20 * Math.log10(rec.peakHold), 1) : '−∞'})${warn.length ? `<br><span class="badge warn">Atención</span> ${esc(warn.join('; '))}` : ''}`;
        }, 200);
    }

    function stopRec() {
        clearInterval(rec.timer);
        if (rec.stream) rec.stream.getTracks().forEach(t => t.stop());
        try { rec.node.disconnect(); } catch (e) { /* ya desconectado */ }
        const fs = rec.ctx ? rec.ctx.sampleRate : 48000;
        if (rec.ctx) rec.ctx.close();
        $('#rec-start').disabled = false; $('#rec-stop').disabled = true;
        $('#rec-meter').style.width = '0';
        if (!rec.n) { $('#rec-status').textContent = 'No se recibió audio.'; return; }
        const channels = rec.chunks.map(list => {
            const out = new Float32Array(list.reduce((a, c) => a + c.length, 0));
            let o = 0;
            list.forEach(c => { out.set(c, o); o += c.length; });
            return out;
        });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        $('#rec-status').textContent = `Grabación de ${fmt(channels[0].length / fs, 1)} s lista (${rec.info.device}).`;
        setSource({ name: `grabacion_${stamp}.wav`, origin: 'grabación', fs, channels, bits: 32, format: 'float', n: channels[0].length,
            note: rec.peakHold >= 0.999 ? 'La grabación llegó a escala completa: hay recorte. Baje el volumen y repita.' : '' });
    }

    // ---------------- Eventos ----------------
    function loadExample() {
        const ex = AU.synthExample();
        setSource({ ...ex, name: 'ejemplo_simulado.wav', origin: 'ejemplo', note: 'Pista simulada: 6 ítems de 3 tonos (880/1122 Hz, 150 ms, rampas coseno² de 10 ms, ISI 200 ms) y ruido con gaps de 2, 5 y 10 ms.' });
    }

    function bindCommon(ctx) {
        $$('[data-goto]', ctx).forEach(a => a.addEventListener('click', e => { e.preventDefault(); showTab(a.dataset.goto); }));
        $$('[data-action=example]', ctx).forEach(b => b.addEventListener('click', loadExample));
    }

    function bindResults(el) {
        const setView = (t0, t1) => {
            const T = res.duration;
            t0 = Math.max(0, t0); t1 = Math.min(T, t1);
            if (!(t1 - t0 > 1 / src.fs * 32)) { toast('Tramo demasiado corto', 'error'); return; }
            view = { t0, t1 }; renderView();
        };
        const zoomTo = s => { const pad = Math.max(0.25 * (s.off10 - s.on10), 0.005); setView(s.on10 - pad, s.off10 + pad); };
        $('#v-apply').addEventListener('click', () => {
            cfg.winMs = +$('#v-win').value; cfg.dynDb = +$('#v-dyn').value;
            const f = num($('#v-fmax').value); if (f > 0) cfg.fmax = f;
            Store.write(CFG_KEY, cfg);
            setView(num($('#v-t0').value), num($('#v-t1').value));
            renderDetail();
        });
        ['#v-win', '#v-dyn'].forEach(id => $(id).addEventListener('change', () => { cfg.winMs = +$('#v-win').value; cfg.dynDb = +$('#v-dyn').value; Store.write(CFG_KEY, cfg); drawSpectrogramInto($('#spec')); }));
        $('#v-all').addEventListener('click', () => setView(0, res.duration));
        $('#v-sel').addEventListener('click', () => sel && zoomTo(sel));
        const move = d => {
            if (!res.stimuli.length) return;
            const i = sel ? Math.min(res.stimuli.length - 1, Math.max(0, sel.i - 1 + d)) : 0;
            sel = res.stimuli[i]; zoomTo(sel); renderDetail();
        };
        $('#v-prev').addEventListener('click', () => move(-1));
        $('#v-next').addEventListener('click', () => move(1));
        $('#spec-png').addEventListener('click', exportSpectrogram);
        $$('[data-sel]', el).forEach(b => b.addEventListener('click', () => {
            sel = res.stimuli[+b.dataset.sel - 1];
            zoomTo(sel); renderDetail();
            $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }));
        $('#cmp-run') && $('#cmp-run').addEventListener('click', runCompare);
        $$('[data-copy]', el).forEach(b => b.addEventListener('click', async () => {
            const text = [...$(`#${b.dataset.copy}`).querySelectorAll('p')].map(p => p.textContent).join('\n\n');
            try { await navigator.clipboard.writeText(text); toast('Texto copiado', 'ok'); }
            catch (e) { download('metodos.txt', text); }
        }));
    }

    function init() {
        $$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
        bindCommon(document);
        fillCfg(); bindCfg();
        $('#file').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
        const drop = $('#drop');
        ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
        ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
        drop.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
        $('#btn-analyze').addEventListener('click', () => runAnalysis(true));
        $('#btn-defaults').addEventListener('click', () => {
            ANALYSIS_KEYS.forEach(k => { if (k !== 'channel') cfg[k] = DEF[k]; });
            Store.write(CFG_KEY, cfg); fillCfg(); dirty = true; updateStatus();
        });
        $('#btn-wav').addEventListener('click', () => {
            if (!src) return;
            const blob = new Blob([AU.encodeWav(src.channels, src.fs)], { type: 'audio/wav' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = src.name.replace(/\.[^.]+$/, '') + '.wav';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        });
        $$('[data-export]').forEach(b => b.addEventListener('click', () => exportData(b.dataset.export)));
        $$('[data-action=print]').forEach(b => b.addEventListener('click', () => { showTab('resultados'); setTimeout(() => window.print(), 150); }));
        $('#rec-start').addEventListener('click', startRec);
        $('#rec-stop').addEventListener('click', stopRec);
        $('#rec-refresh').addEventListener('click', refreshDevices);
        refreshDevices().catch(() => {});
        $$('[data-check]').forEach((cb, i) => {
            const k = `check:audio:${i}`;
            cb.checked = !!Store.read(k, false);
            cb.addEventListener('change', () => Store.write(k, cb.checked));
        });
        updateStatus();
        if (/[?&]ejemplo\b/.test(location.search)) { loadExample(); return; }
        const tab = (location.hash || '#guia').slice(1);
        showTab($(`#tab-${tab}`) ? tab : 'guia');
    }

    init();
})(typeof self !== 'undefined' ? self : this);
