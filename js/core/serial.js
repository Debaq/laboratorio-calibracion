/*
 * LabSerial — lectura directa de la placa por Web Serial (Chrome / Edge en computador).
 *
 *   - Una sola conexión por página, compartida por el panel de Medición y los botones de grabación.
 *   - Formato esperado (el de LabSketches): encabezado "t_ms,lectura" y líneas numéricas separadas por coma;
 *     las líneas que empiezan con '#' son avisos.
 *   - Captura: promedia cada columna durante unos segundos y completa los campos de la medición.
 *   - Grabación: guarda las líneas crudas como texto CSV en un <textarea data-serial="id-del-botón-analizar">.
 *
 * El intérprete de líneas (createParser) y las estadísticas (summarize) no usan el navegador: se prueban en Node.
 */
(function (root, factory) {
    const m = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.LabSerial = m;
})(typeof self !== 'undefined' ? self : this, function (root) {
    'use strict';

    // ---------------- Intérprete de líneas ----------------
    const delimOf = l => l.includes('\t') ? '\t' : l.includes(';') ? ';' : ',';
    const toNum = (s, d) => {
        const t = s.trim();
        return t === '' ? NaN : Number(d === ',' ? t : t.replace(',', '.'));
    };
    const TIME_RE = /^(t|t_?ms|t_?us|t_?s|ms|us|millis|micros|tiempo|time)$/i;
    const isTime = h => TIME_RE.test(String(h).trim());

    /**
     * Convierte cada línea en { type: 'header' | 'data' | 'msg', … }.
     * Sin encabezado, las columnas se llaman col1, col2…; si cambia la cantidad de columnas, se renombran igual.
     */
    function createParser() {
        let headers = null;
        return {
            get headers() { return headers; },
            reset() { headers = null; },
            push(raw) {
                const line = String(raw).replace(/\r$/, '').trim();
                if (!line) return null;
                if (line[0] === '#') return { type: 'msg', text: line.slice(1).trim() };
                const d = delimOf(line);
                const parts = line.split(d);
                const vals = parts.map(p => toNum(p, d));
                if (vals.every(isFinite)) {
                    if (!headers || headers.length !== vals.length) headers = vals.map((_, i) => `col${i + 1}`);
                    return { type: 'data', values: vals };
                }
                // Encabezado: todos los campos son nombres (letras, dígitos, _ y unidades entre corchetes)
                if (parts.length > 1 && parts.every(p => /^[\p{L}_][\p{L}\p{N}_ .\-[\]()/%°µ²³]*$/u.test(p.trim()))) {
                    headers = parts.map(p => p.trim());
                    return { type: 'header', headers };
                }
                if (parts.length === 1 && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(line)) {
                    headers = [line];
                    return { type: 'header', headers };
                }
                return { type: 'msg', text: line };
            }
        };
    }

    /** Media, desviación estándar (n−1), mínimo, máximo y último valor de cada columna. */
    function summarize(rows, width) {
        const n = rows.length;
        const out = { n, mean: [], sd: [], min: [], max: [], last: n ? rows[n - 1].slice() : [] };
        for (let j = 0; j < width; j++) {
            const col = rows.map(r => r[j]).filter(isFinite);
            const m = col.reduce((s, v) => s + v, 0) / (col.length || NaN);
            out.mean.push(m);
            out.sd.push(col.length > 1 ? Math.sqrt(col.reduce((s, v) => s + (v - m) ** 2, 0) / (col.length - 1)) : NaN);
            out.min.push(col.length ? Math.min(...col) : NaN);
            out.max.push(col.length ? Math.max(...col) : NaN);
        }
        return out;
    }

    /** Nombre normalizado para asignar columnas a campos (sin tildes, espacios ni unidades). */
    const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\[.*?\]|\(.*?\)/g, '').replace(/[\s"'_-]/g, '');

    /**
     * Asignación automática campo → columna: por la clave del campo, sus alias (f.serial) o su etiqueta corta.
     * Si solo queda un campo sin asignar y una columna libre (sin contar el tiempo), se unen.
     */
    function autoMap(fields, headers) {
        const map = {};
        const cols = (headers || []).filter(h => !isTime(h));
        const used = new Set();
        fields.forEach(f => {
            const names = [f.key, ...(f.serial || []), f.short].filter(Boolean).map(norm);
            const h = cols.find(c => !used.has(c) && names.includes(norm(c)));
            if (h) { map[f.key] = h; used.add(h); }
        });
        const freeCols = cols.filter(c => !used.has(c));
        const wanting = fields.filter(f => !map[f.key] && f.serialAuto);
        if (wanting.length === 1 && freeCols.length) map[wanting[0].key] = freeCols[0];
        return map;
    }

    const api = { createParser, summarize, autoMap, isTime, norm };
    if (typeof document === 'undefined') return api;

    // ======================= Navegador =======================
    const { $, $$, esc, fmt, sig, toast } = root.LabUI;
    const Store = root.LabStore;
    const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 250000, 500000, 1000000];
    const MAX_SAMPLES = 20000;

    const conn = {
        port: null, reader: null, connected: false, busy: false,
        parser: createParser(),
        samples: [],          // { t: performance.now(), v: [...] }
        messages: [],         // últimos avisos '#'
        recording: null,      // { lines: [], header, start }
        lineCount: 0, rateT0: 0, rateN: 0, rate: 0
    };
    const listeners = new Set();
    const emit = ev => listeners.forEach(fn => { try { fn(ev); } catch (e) { console.error(e); } });

    const supported = () => typeof navigator !== 'undefined' && 'serial' in navigator;
    const getBaud = () => +Store.read('serial:baud', 115200) || 115200;

    function onLine(line) {
        const ev = conn.parser.push(line);
        if (!ev) return;
        if (ev.type === 'msg') {
            conn.messages.push(ev.text);
            if (conn.messages.length > 6) conn.messages.shift();
            emit({ type: 'msg', text: ev.text });
            return;
        }
        if (ev.type === 'header') {
            conn.samples = [];
            if (conn.recording) conn.recording.header = ev.headers.join(',');
            emit({ type: 'header', headers: ev.headers });
            return;
        }
        const now = performance.now();
        conn.samples.push({ t: now, v: ev.values });
        if (conn.samples.length > MAX_SAMPLES) conn.samples.splice(0, conn.samples.length - MAX_SAMPLES);
        if (conn.recording) {
            if (!conn.recording.header) conn.recording.header = conn.parser.headers.join(',');
            conn.recording.lines.push(ev.values.join(','));
        }
        conn.rateN++;
        if (now - conn.rateT0 >= 1000) { conn.rate = conn.rateN * 1000 / (now - conn.rateT0); conn.rateN = 0; conn.rateT0 = now; }
        conn.lineCount++;
    }

    async function readLoop() {
        const decoder = new TextDecoder();
        let buf = '';
        while (conn.port && conn.port.readable && conn.connected) {
            conn.reader = conn.port.readable.getReader();
            try {
                for (;;) {
                    const { value, done } = await conn.reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    let i;
                    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
                    if (buf.length > 4096) buf = '';   // basura sin saltos de línea (baudios equivocados)
                }
            } catch (e) {
                if (conn.connected) { console.warn(e); emit({ type: 'error', text: `Error de lectura: ${e.message}` }); }
            } finally {
                try { conn.reader.releaseLock(); } catch (e) { /* ya liberado */ }
                conn.reader = null;
            }
            if (!conn.connected) break;
            // Un error de trama (p. ej. baudios equivocados) no cierra el puerto: se vuelve a leer
            if (conn.port && !conn.port.readable) break;
        }
        if (conn.connected) await disconnect(true);
    }

    async function connect(baud = getBaud()) {
        if (!supported()) throw new Error('Este navegador no tiene Web Serial. Use Chrome o Edge en un computador.');
        if (conn.connected || conn.busy) return;
        conn.busy = true;
        try {
            const port = await navigator.serial.requestPort();
            await port.open({ baudRate: baud });
            Store.write('serial:baud', baud);
            Object.assign(conn, { port, connected: true, samples: [], messages: [], lineCount: 0, rate: 0, rateN: 0, rateT0: performance.now() });
            conn.parser.reset();
            emit({ type: 'connect' });
            readLoop();
            // Placas que no se reinician al abrir el puerto (ESP32, Leonardo): se pide el encabezado
            setTimeout(() => { if (conn.connected && !(conn.parser.headers || []).some(h => !/^col\d+$/.test(h))) send('h'); }, 2500);
        } catch (e) {
            if (e.name === 'NotFoundError') return;   // el usuario cerró el diálogo
            throw e.name === 'InvalidStateError' ? new Error('El puerto está ocupado: cierre el Monitor serie del IDE u otra pestaña que lo use.') : e;
        } finally { conn.busy = false; }
    }

    async function disconnect(lost = false) {
        conn.connected = false;
        try { if (conn.reader) await conn.reader.cancel(); } catch (e) { /* */ }
        try { if (conn.port) await conn.port.close(); } catch (e) { /* */ }
        conn.port = null;
        if (conn.recording) stopRecording();
        emit({ type: 'disconnect', lost });
        if (lost) toast('Se perdió la conexión con la placa', 'error');
    }

    async function send(text) {
        if (!conn.port || !conn.port.writable) throw new Error('No hay placa conectada.');
        const w = conn.port.writable.getWriter();
        try { await w.write(new TextEncoder().encode(text)); } finally { w.releaseLock(); }
    }

    /** Espera `seconds` y resume las muestras recibidas en ese intervalo. */
    function capture(seconds, onTick) {
        return new Promise((resolve, reject) => {
            if (!conn.connected) { reject(new Error('Conecte la placa primero.')); return; }
            const t0 = performance.now();
            const tick = setInterval(() => onTick && onTick((performance.now() - t0) / 1000), 100);
            setTimeout(() => {
                clearInterval(tick);
                const rows = conn.samples.filter(s => s.t >= t0).map(s => s.v);
                if (!rows.length) { reject(new Error('No llegaron datos de la placa en ese intervalo. Revise el sketch y los baudios.')); return; }
                const headers = conn.parser.headers || [];
                resolve({ headers, ...summarize(rows, headers.length) });
            }, seconds * 1000);
        });
    }

    function startRecording() {
        conn.recording = { lines: [], header: conn.parser.headers ? conn.parser.headers.join(',') : '', start: performance.now() };
        emit({ type: 'record', on: true });
    }
    function stopRecording() {
        const r = conn.recording;
        conn.recording = null;
        emit({ type: 'record', on: false });
        return r ? [r.header, ...r.lines].filter(Boolean).join('\n') : '';
    }

    // Aviso si se desenchufa la placa
    if (supported()) navigator.serial.addEventListener('disconnect', ev => { if (conn.port && ev.target === conn.port) disconnect(true); });

    // ---------------- Panel de la pestaña Medición ----------------
    const statusHtml = () => conn.connected
        ? `<span class="dot on"></span> Conectada · ${conn.rate ? `${fmt(conn.rate, conn.rate < 10 ? 1 : 0)} líneas/s` : 'esperando datos…'}${conn.recording ? ' · <strong>grabando</strong>' : ''}`
        : '<span class="dot"></span> Sin conexión';

    /** Valor tal como llega: enteros sin decimales (t_ms, cuentas) y el resto con coma decimal. */
    const liveNum = v => !isFinite(v) ? '—' : Number.isInteger(v) ? String(v) : String(+v.toPrecision(7)).replace('.', ',');

    function liveHtml(map, fields) {
        const h = conn.parser.headers;
        const last = conn.samples[conn.samples.length - 1];
        if (!conn.connected) return '';
        if (!h || !last) return '<p class="muted small">Esperando la primera línea de datos. Si no llega nada, revise que el sketch esté cargado y que los baudios coincidan.</p>';
        const owner = Object.fromEntries(Object.entries(map).map(([k, c]) => [c, fields.find(f => f.key === k)]));
        return `<div class="serial-live">${h.map((name, j) => `<div class="${owner[name] ? 'mapped' : ''}${isTime(name) ? ' time' : ''}">
            <span>${esc(name)}${owner[name] ? ` → ${esc(owner[name].short || owner[name].label)}` : ''}</span><b>${esc(liveNum(last.v[j]))}</b></div>`).join('')}</div>
            ${conn.messages.length ? `<p class="muted small">Placa: ${esc(conn.messages[conn.messages.length - 1])}</p>` : ''}`;
    }

    /**
     * Panel de conexión y captura.
     * opts: { id, fields, fill(key, value), register(), sketchId, getCfg }
     */
    function panel(el, opts) {
        if (!el) return;
        const mapKey = `serial:map:${opts.id}`;
        const saved = Store.read(mapKey, {});
        const sk = root.LabSketches ? root.LabSketches.current(opts.sketchId || opts.id) : null;
        const prefs = Store.read(`serial:prefs:${opts.id}`, {});
        const seconds = prefs.seconds || (sk ? sk.capture.seconds : 2);
        const stat = sk ? sk.capture.stat : 'mean';
        let map = {};
        const computeMap = () => {
            const h = conn.parser.headers || [];
            const auto = autoMap(opts.fields, h);
            map = {};
            opts.fields.forEach(f => {
                const s = saved[f.key];
                if (s === '') map[f.key] = '';
                else if (s && h.includes(s)) map[f.key] = s;
                else if (auto[f.key]) map[f.key] = auto[f.key];
            });
        };
        computeMap();

        const open = Store.read('serial:open', true);
        el.innerHTML = `
            <details class="card serial" ${open ? 'open' : ''}>
                <summary><strong>Leer desde la placa</strong> <span class="muted small">(Web Serial)</span> <span class="serial-status" data-s-status>${statusHtml()}</span></summary>
                ${!supported() ? `<div class="callout warn">Este navegador no permite conectarse a la placa. Use <strong>Chrome</strong> o <strong>Edge</strong> en un computador,
                    o copie los valores del Monitor serie del IDE.</div>` : `
                <div class="serial-bar">
                    <label class="small">Velocidad <select data-s-baud>${BAUDS.map(b => `<option ${b === getBaud() ? 'selected' : ''}>${b}</option>`).join('')}</select></label>
                    <button type="button" data-s-conn class="${conn.connected ? '' : 'primary'}">${conn.connected ? 'Desconectar' : 'Conectar placa'}</button>
                    ${sk && sk.commands.length ? sk.commands.map(c => `<button type="button" data-s-cmd="${esc(c.cmd)}" ${conn.connected ? '' : 'disabled'}>${esc(c.label)}</button>`).join('') : ''}
                </div>
                <div data-s-live>${liveHtml(map, opts.fields)}</div>
                <div class="grid auto serial-map">
                    ${opts.fields.map(f => `<div class="field"><label>${esc(f.short || f.label)}</label>
                        <select data-s-map="${esc(f.key)}"><option value="">a mano</option>${(conn.parser.headers || []).filter(h => !isTime(h)).map(h => `<option ${map[f.key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select></div>`).join('')}
                </div>
                <div class="serial-bar">
                    <label class="small">${stat === 'last' ? 'Esperar' : 'Promediar'} <input type="text" inputmode="decimal" data-s-sec value="${String(seconds).replace('.', ',')}" size="3"> s</label>
                    <button type="button" class="primary" data-s-cap ${conn.connected ? '' : 'disabled'}>${stat === 'last' ? 'Capturar' : 'Capturar promedio'} <kbd>Ctrl+Enter</kbd></button>
                    <label class="inline-check small"><input type="checkbox" data-s-auto ${prefs.auto ? 'checked' : ''}> registrar al capturar</label>
                </div>
                <div data-s-out class="small muted"></div>`}
                ${sk ? `<details class="serial-sketch"><summary>Código Arduino para esta prueba</summary><div data-s-sketch></div></details>` : ''}
            </details>`;

        const det = el.querySelector('details.serial');
        det.addEventListener('toggle', () => { if (det.parentNode === el) Store.write('serial:open', det.open); });
        const skBox = el.querySelector('[data-s-sketch]');
        if (skBox) root.LabSketches.render(skBox, opts.sketchId || opts.id, opts.getCfg);
        if (!supported()) return;

        const q = s => el.querySelector(s);
        q('[data-s-baud]').addEventListener('change', e => Store.write('serial:baud', +e.target.value));
        q('[data-s-conn]').addEventListener('click', async () => {
            try { conn.connected ? await disconnect() : await connect(+q('[data-s-baud]').value); }
            catch (e) { toast(e.message, 'error'); }
        });
        $$('[data-s-cmd]', el).forEach(b => b.addEventListener('click', () => send(b.dataset.sCmd).then(() => toast(`Enviado: ${b.textContent}`, 'ok')).catch(e => toast(e.message, 'error'))));
        $$('[data-s-map]', el).forEach(s => s.addEventListener('change', () => {
            saved[s.dataset.sMap] = s.value;
            Store.write(mapKey, saved);
            computeMap();
        }));
        const savePrefs = () => Store.write(`serial:prefs:${opts.id}`, { seconds: root.LabUI.num(q('[data-s-sec]').value), auto: q('[data-s-auto]').checked });
        q('[data-s-sec]').addEventListener('change', savePrefs);
        q('[data-s-auto]').addEventListener('change', savePrefs);

        const out = q('[data-s-out]');
        const capBtn = q('[data-s-cap]');
        async function doCapture() {
            if (!conn.connected || capBtn.disabled) return;
            const secs = root.LabUI.num(q('[data-s-sec]').value);
            const T = isFinite(secs) && secs > 0 ? Math.min(secs, 120) : 2;
            const targets = opts.fields.filter(f => map[f.key]);
            if (!targets.length) { toast('Asigne al menos un campo a una columna de la placa', 'error'); return; }
            capBtn.disabled = true;
            const label = capBtn.innerHTML;
            try {
                const r = await capture(T, t => { capBtn.textContent = `Capturando… ${fmt(Math.max(0, T - t), 1)} s`; });
                const parts = [];
                for (const f of targets) {
                    const j = r.headers.indexOf(map[f.key]);
                    if (j < 0) continue;
                    const v = stat === 'last' ? r.last[j] : r.mean[j];
                    opts.fill(f.key, v);
                    parts.push(`${esc(f.short || f.label)} = <strong>${esc(sig(v, 6))}</strong>${stat === 'last' ? '' : ` (s = ${esc(sig(r.sd[j], 2))}, rango ${esc(sig(r.min[j], 5))} a ${esc(sig(r.max[j], 5))})`}`);
                }
                out.innerHTML = `${stat === 'last' ? 'Último valor' : `Promedio de ${r.n} líneas en ${fmt(T, 1)} s`}: ${parts.join(' · ')}`;
                if (q('[data-s-auto]').checked) opts.register();
                else toast('Valores capturados: revise y registre', 'ok');
            } catch (e) { toast(e.message, 'error'); }
            finally { if (capBtn.isConnected) { capBtn.disabled = !conn.connected; capBtn.innerHTML = label; } }
        }
        capBtn.addEventListener('click', doCapture);
        el._capture = doCapture;
    }

    // Refresco del panel (valores en vivo, estado) sin reconstruir el formulario
    let activePanel = null;
    function mountPanel(el, opts) {
        activePanel = { el, opts };
        panel(el, opts);
    }
    function refreshPanel(full) {
        if (!activePanel || !activePanel.el.isConnected) return;
        if (full) { panel(activePanel.el, activePanel.opts); return; }
        const st = activePanel.el.querySelector('[data-s-status]');
        if (st) st.innerHTML = statusHtml();
        const live = activePanel.el.querySelector('[data-s-live]');
        if (live && !live.contains(document.activeElement)) {
            const map = {};
            activePanel.el.querySelectorAll('[data-s-map]').forEach(s => { if (s.value) map[s.dataset.sMap] = s.value; });
            live.innerHTML = liveHtml(map, activePanel.opts.fields);
        }
    }
    setInterval(() => { if (conn.connected) refreshPanel(false); refreshRecorders(); }, 250);
    listeners.add(ev => { if (['connect', 'disconnect', 'header'].includes(ev.type)) refreshPanel(true); });
    // Ctrl+Enter captura desde cualquier campo de la medición
    document.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && activePanel && activePanel.el.isConnected && activePanel.el._capture) {
            e.preventDefault(); activePanel.el._capture();
        }
    });

    // ---------------- Grabación de series de tiempo ----------------
    const recorders = new Set();
    /** Agrega "Grabar desde la placa" junto a cada <textarea data-serial>. data-serial = id del botón que analiza el texto. */
    function attachRecorders(ctx = document) {
        $$('textarea[data-serial]', ctx).forEach(ta => {
            if (ta._rec) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'rec';
            const actions = ta.closest('.field') ? ta.closest('.field').nextElementSibling : ta.nextElementSibling;
            (actions && actions.classList.contains('actions') ? actions : (ta.insertAdjacentHTML('afterend', '<div class="actions"></div>'), ta.nextElementSibling)).prepend(btn);
            ta._rec = { btn, on: false };
            recorders.add(ta);
            btn.addEventListener('click', async () => {
                if (!supported()) { toast('Este navegador no tiene Web Serial. Use Chrome o Edge en un computador.', 'error'); return; }
                if (ta._rec.on) {
                    ta._rec.on = false;
                    const text = stopRecording();
                    const n = text.split('\n').length - 1;
                    if (n < 2) { toast('No se grabaron datos', 'error'); refreshRecorders(); return; }
                    ta.value = text;
                    toast(`Grabadas ${n} líneas`, 'ok');
                    const run = ta.dataset.serial && document.getElementById(ta.dataset.serial);
                    if (run) run.click();
                    refreshRecorders();
                    return;
                }
                try {
                    if (!conn.connected) await connect();
                    if (!conn.connected) return;
                    if (conn.recording) { toast('Ya hay una grabación en curso', 'error'); return; }
                    recorders.forEach(r => { r._rec.on = false; });
                    ta._rec.on = true;
                    startRecording();
                    refreshRecorders();
                } catch (e) { toast(e.message, 'error'); }
            });
        });
        refreshRecorders();
    }
    function refreshRecorders() {
        recorders.forEach(ta => {
            if (!ta.isConnected) { recorders.delete(ta); return; }
            const { btn, on } = ta._rec;
            if (on && conn.recording) {
                const s = (performance.now() - conn.recording.start) / 1000;
                btn.innerHTML = `■ Detener grabación (${fmt(s, 0)} s · ${conn.recording.lines.length} líneas)`;
                btn.classList.add('danger');
            } else {
                btn.innerHTML = conn.connected ? '● Grabar desde la placa' : '● Conectar y grabar desde la placa';
                btn.classList.remove('danger');
                btn.disabled = !!conn.recording;
            }
        });
    }

    return Object.assign(api, { supported, connect, disconnect, send, capture, mountPanel, attachRecorders, state: conn, on: fn => listeners.add(fn) });
});
