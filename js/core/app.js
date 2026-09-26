/*
 * LabApp — estructura común de cada módulo de calibración:
 *   Guía → Preparación → Medición (plan guiado paso a paso) → Resultados → Guardados
 * El borrador (configuración + mediciones) se guarda solo en cada cambio: recargar la página no pierde datos.
 */
(function (root) {
    'use strict';
    const { $, $$, esc, num, numList, fmt, toast, download, toCSV, slug, readFile } = root.LabUI;
    const Store = root.LabStore;

    const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
    const setPath = (o, p, v) => {
        const ks = p.split('.');
        let cur = o;
        ks.slice(0, -1).forEach(k => { if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {}; cur = cur[k]; });
        cur[ks[ks.length - 1]] = v;
    };
    /** Mezcla profunda: completa campos que falten en configuraciones antiguas. */
    const deepMerge = (base, over) => {
        if (Array.isArray(base) || typeof base !== 'object' || base == null) return over === undefined ? base : over;
        const out = { ...base };
        for (const k of Object.keys(over || {})) out[k] = deepMerge(base[k], over[k]);
        return out;
    };

    const DIR_LABEL = { cero: 'Cero', sube: '↑ Sube', baja: '↓ Baja', tara: 'Tara', carga: '↑ Carga', descarga: '↓ Descarga' };

    function create(spec) {
        const draftKey = `draft:${spec.id}`;
        const app = {
            spec,
            state: null,
            get cfg() { return app.state.cfg; },
            get rows() { return app.state.rows; },
            saveDraft, renderMeasure, renderResults, renderSaved, fillConfig, showTab, newExperiment, loadExperiment
        };

        const measureFields = () => typeof spec.measureFields === 'function' ? spec.measureFields(app.cfg) : spec.measureFields;

        function freshState() {
            return { cfg: spec.model.defaultConfig(), rows: [], plan: [], step: 0, savedId: null };
        }

        function loadDraft() {
            const d = Store.read(draftKey, null);
            const st = freshState();
            if (d) {
                st.cfg = deepMerge(st.cfg, d.cfg);
                st.rows = d.rows || []; st.plan = d.plan || []; st.step = d.step || 0; st.savedId = d.savedId || null;
            }
            app.state = st;
        }

        function saveDraft() {
            Store.write(draftKey, app.state);
            updateStatus();
        }

        function updateStatus() {
            const el = $('#status');
            if (!el) return;
            const n = app.rows.length, total = app.state.plan.length;
            el.innerHTML = `<strong>${esc(app.cfg.name || 'Experimento sin nombre')}</strong>
                <span>${n} mediciones${total ? ` · plan ${Math.min(app.state.step, total)}/${total}` : ''}</span>
                ${app.state.savedId ? '<span class="badge ok">guardado</span>' : n ? '<span class="badge warn">sin guardar</span>' : ''}`;
        }

        // ---------------- Pestañas ----------------
        function showTab(name) {
            $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
            $$('.panel').forEach(p => p.hidden = p.id !== `tab-${name}`);
            if (name === 'medir') renderMeasure();
            if (name === 'resultados') renderResults();
            if (name === 'guardados') renderSaved();
            spec.onTab && spec.onTab(name, app);
            try { history.replaceState(null, '', `#${name}`); } catch (e) { /* file:// en algunos navegadores */ }
            window.scrollTo({ top: 0 });
        }

        // ---------------- Configuración ----------------
        function fillConfig() {
            $$('[data-bind]').forEach(el => {
                const v = getPath(app.cfg, el.dataset.bind);
                const t = el.dataset.type || (el.type === 'checkbox' ? 'bool' : 'text');
                if (t === 'bool') el.checked = !!v;
                else if (t === 'list') el.value = (v || []).map(x => String(x).replace('.', ',')).join('; ');
                else if (t === 'number') el.value = v == null || !isFinite(v) ? '' : String(v).replace('.', ',');
                else el.value = v ?? '';
            });
            spec.fillConfig && spec.fillConfig(app);
            refreshVisibility();
        }

        function readBinding(el) {
            const t = el.dataset.type || (el.type === 'checkbox' ? 'bool' : 'text');
            let v;
            if (t === 'bool') v = el.checked;
            else if (t === 'list') v = numList(el.value);
            else if (t === 'number') v = num(el.value);
            else if (t === 'auto') v = el.value === 'auto' ? 'auto' : num(el.value);
            else v = el.value;
            setPath(app.cfg, el.dataset.bind, v);
            if (t === 'number') el.classList.toggle('invalid', el.value.trim() !== '' && !isFinite(v));
        }

        /** Muestra u oculta bloques según otra opción: data-show-if="refMethod=seno,cuerda". */
        function refreshVisibility() {
            $$('[data-show-if]').forEach(el => {
                const [path, vals] = el.dataset.showIf.split('=');
                const v = String(getPath(app.cfg, path));
                el.hidden = !vals.split(',').includes(v);
            });
        }

        function startPlan() {
            const err = spec.validateConfig ? spec.validateConfig(app.cfg) : null;
            if (err) { toast(err, 'error'); return; }
            const plan = spec.model.buildPlan(app.cfg);
            if (app.rows.length && !confirm(`Ya hay ${app.rows.length} mediciones registradas.\n\nSe regenerará el plan y se conservarán las mediciones. ¿Continuar?`)) return;
            app.state.plan = plan;
            app.state.step = Math.min(app.rows.length, plan.length);
            saveDraft();
            showTab('medir');
        }

        // ---------------- Medición guiada ----------------
        function stepValues(step) {
            const out = {};
            spec.stepFields.forEach(f => { out[f.key] = step ? step[f.key] : (f.type === 'select' ? f.options[0][0] : ''); });
            return out;
        }

        function fieldInput(f, value, prefix) {
            const id = `${prefix}-${f.key}`;
            const label = `<label for="${id}">${esc(f.label)}${f.unit ? ` <small>(${esc(f.unit)})</small>` : ''}</label>`;
            if (f.type === 'select')
                return `<div class="field">${label}<select id="${id}" data-key="${f.key}">${f.options.map(([v, t]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
            const val = value == null || value === '' || (typeof value === 'number' && !isFinite(value)) ? '' : String(value).replace('.', ',');
            return `<div class="field">${label}<input id="${id}" data-key="${f.key}" type="text" inputmode="decimal" autocomplete="off" value="${esc(val)}" ${f.hint ? `placeholder="${esc(f.hint)}"` : ''}></div>`;
        }

        function renderMeasure() {
            const el = $('#measure');
            const { plan, step, rows } = app.state;
            if (!plan.length) {
                el.innerHTML = `<div class="callout">Primero complete la <a href="#config" data-goto="config">Preparación</a> y presione <strong>Generar plan y comenzar</strong>.
                    ${rows.length ? `<br>Hay ${rows.length} mediciones cargadas: puede verlas en <a href="#resultados" data-goto="resultados">Resultados</a>.` : ''}</div>`;
                bindGoto(el);
                return;
            }
            const done = step >= plan.length;
            const cur = plan[Math.min(step, plan.length - 1)];
            const pct = Math.round(100 * Math.min(step, plan.length) / plan.length);
            const last = rows[rows.length - 1];
            const sv = !done ? stepValues(cur) : last ? Object.fromEntries(spec.stepFields.map(f => [f.key, last[f.key]])) : stepValues(null);

            el.innerHTML = `
                <div class="progress" aria-label="Avance del plan"><div style="width:${pct}%"></div></div>
                <p class="muted">Paso ${Math.min(step + 1, plan.length)} de ${plan.length} · ${pct} %</p>
                ${done
                    ? `<div class="action done"><div class="kicker">Plan completo</div><p>Se registraron todas las mediciones del plan. Revise los <a href="#resultados" data-goto="resultados">Resultados</a>, o agregue mediciones extra abajo.</p></div>`
                    : `<div class="action"><div class="kicker">Acción ${step + 1}</div><p>${esc(cur.action)}</p></div>`}
                <form id="measure-form" class="card" autocomplete="off">
                    <div class="grid auto">${spec.stepFields.map(f => fieldInput(f, sv[f.key], 'st')).join('')}</div>
                    <div class="grid auto emph">${measureFields().map(f => fieldInput(f, '', 'm')).join('')}</div>
                    ${spec.measureNote ? `<p class="muted small">${spec.measureNote}</p>` : ''}
                    <div class="actions">
                        <button type="submit" class="primary">Registrar medición <kbd>Enter</kbd></button>
                        ${!done ? '<button type="button" id="btn-skip">Omitir paso</button>' : ''}
                        ${step > 0 ? '<button type="button" id="btn-back">← Paso anterior</button>' : ''}
                    </div>
                </form>
                <h3>Mediciones registradas (${rows.length})</h3>
                ${rowsTable()}`;

            const form = $('#measure-form');
            const first = $('#measure-form .emph input');
            first && first.focus();
            form.addEventListener('submit', e => { e.preventDefault(); register(); });
            $('#btn-skip') && $('#btn-skip').addEventListener('click', () => { app.state.step++; saveDraft(); renderMeasure(); });
            $('#btn-back') && $('#btn-back').addEventListener('click', () => { app.state.step = Math.max(0, app.state.step - 1); saveDraft(); renderMeasure(); });
            $$('[data-del]', el).forEach(b => b.addEventListener('click', () => {
                const i = +b.dataset.del;
                if (!confirm(`¿Eliminar la medición ${i + 1}?`)) return;
                app.rows.splice(i, 1);
                app.state.savedId = null;
                saveDraft(); renderMeasure();
            }));
            bindGoto(el);
        }

        function register() {
            const row = {};
            for (const f of spec.stepFields) {
                const inp = $(`#st-${f.key}`);
                row[f.key] = f.type === 'select' ? (isFinite(num(inp.value)) && f.numeric ? num(inp.value) : inp.value) : num(inp.value);
                if (f.type !== 'select' && !isFinite(row[f.key])) { inp.classList.add('invalid'); inp.focus(); toast(`Revise "${f.label}"`, 'error'); return; }
            }
            for (const f of measureFields()) {
                const inp = $(`#m-${f.key}`);
                const v = num(inp.value);
                if (!isFinite(v) && !f.optional) { inp.classList.add('invalid'); inp.focus(); toast(`Falta un número válido en "${f.label}"`, 'error'); return; }
                row[f.key] = v;
            }
            const check = spec.checkRow ? spec.checkRow(app.cfg, row) : null;
            if (check && !confirm(`${check}\n\n¿Registrar de todas formas?`)) return;
            row.step = app.state.step;
            row.time = new Date().toISOString();
            app.rows.push(row);
            app.state.step = Math.min(app.state.step + 1, Math.max(app.state.plan.length, app.state.step + 1));
            app.state.savedId = null;
            saveDraft();
            renderMeasure();
            toast(`Medición ${app.rows.length} registrada`, 'ok');
        }

        function rowsTable(readonly = false) {
            const rows = app.rows;
            if (!rows.length) return '<p class="muted">Aún no hay mediciones.</p>';
            const cols = [...spec.stepFields, ...measureFields()];
            const cell = (f, r) => {
                const v = r[f.key];
                if (f.type === 'select') return esc(DIR_LABEL[v] || (f.options.find(o => String(o[0]) === String(v)) || [0, v])[1]);
                return typeof v === 'number' ? fmt(v, f.decimals ?? 2) : esc(v);
            };
            const body = rows.map((r, i) => [i + 1, ...cols.map(f => cell(f, r)), readonly ? '' : `<button class="icon" data-del="${i}" title="Eliminar">✕</button>`]);
            return root.LabUI.table(['#', ...cols.map(f => esc(f.short || f.label)), ''], body.reverse(), { className: 'compact' });
        }

        // ---------------- Resultados ----------------
        function renderResults() {
            const el = $('#results');
            if (!app.rows.length) {
                el.innerHTML = '<div class="callout">No hay mediciones todavía. Puede <button type="button" class="link" id="btn-example2">cargar datos de ejemplo</button> para ver cómo se ven los resultados.</div>';
                $('#btn-example2').addEventListener('click', loadExample);
                return;
            }
            let res;
            try { res = spec.model.analyze(app.cfg, app.rows); }
            catch (e) { el.innerHTML = `<div class="callout error">Error al analizar: ${esc(e.message)}</div>`; console.error(e); return; }
            const head = `<div class="print-only print-head"><h2>${esc(document.title)}</h2><p>${esc(app.cfg.name || '')} · ${new Date().toLocaleString('es-CL')}</p></div>`;
            if (!res.ok) { el.innerHTML = head + warningsHtml(res.warnings, true); return; }
            el.innerHTML = head + `<div id="res-body"></div>
                <details class="card"><summary>Datos crudos (${app.rows.length})</summary>${rowsTable(true)}</details>`;
            spec.renderResults($('#res-body'), app.cfg, app.rows, res, app);
        }

        function warningsHtml(ws, blocking = false) {
            if (!ws || !ws.length) return '<div class="callout ok">Sin advertencias.</div>';
            return `<div class="callout ${blocking ? 'error' : 'warn'}"><strong>${blocking ? 'No se puede analizar' : 'Advertencias'}</strong><ul>${ws.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
        }
        app.warningsHtml = warningsHtml;

        // ---------------- Guardados ----------------
        function renderSaved() {
            const el = $('#saved');
            const list = Store.listExperiments(spec.id).slice().reverse();
            el.innerHTML = `
                <div class="actions">
                    <button type="button" class="primary" id="btn-save">Guardar experimento actual</button>
                    <button type="button" id="btn-new">Nuevo experimento</button>
                    <label class="button">Importar JSON<input type="file" id="imp" accept=".json,application/json" hidden></label>
                    <button type="button" id="btn-backup">Respaldo completo (todos los módulos)</button>
                </div>
                ${list.length ? root.LabUI.table(['Nombre', 'Fecha', 'Mediciones', ''], list.map(e => [
                    `<strong>${esc(e.name || e.cfg.name || 'sin nombre')}</strong>`,
                    new Date(e.updated || e.created).toLocaleString('es-CL'),
                    e.rows.length,
                    `<div class="row-actions">
                        <button data-open="${e.id}">Abrir</button>
                        <button data-json="${e.id}">JSON</button>
                        <button data-csv="${e.id}">CSV</button>
                        ${spec.extraSavedAction ? spec.extraSavedAction(e) : ''}
                        <button class="danger" data-rm="${e.id}">Eliminar</button>
                    </div>`
                ])) : '<p class="muted">No hay experimentos guardados en este navegador.</p>'}
                <p class="muted small">Los datos se guardan en este navegador y computador. Use JSON o el respaldo completo para moverlos o entregarlos.</p>`;

            $('#btn-save').addEventListener('click', saveCurrent);
            $('#btn-new').addEventListener('click', newExperiment);
            $('#btn-backup').addEventListener('click', () => download(`respaldo_laboratorio_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(Store.exportAll(), null, 2), 'application/json'));
            $('#imp').addEventListener('change', async ev => {
                const f = ev.target.files[0];
                if (!f) return;
                try {
                    const obj = JSON.parse(await readFile(f));
                    if (obj.app === 'laboratorio-calibracion') { Store.importAll(obj); toast('Respaldo importado', 'ok'); }
                    else if (obj.module === spec.id && obj.cfg && obj.rows) { delete obj.id; Store.saveExperiment(spec.id, obj); toast('Experimento importado', 'ok'); }
                    else throw new Error(`El archivo no es un experimento de este módulo (${spec.id})`);
                    renderSaved();
                } catch (e) { toast(e.message, 'error'); }
            });
            $$('[data-open]', el).forEach(b => b.addEventListener('click', () => loadExperiment(b.dataset.open)));
            $$('[data-json]', el).forEach(b => b.addEventListener('click', () => {
                const e = Store.getExperiment(spec.id, b.dataset.json);
                download(`${slug(e.name)}.json`, JSON.stringify(e, null, 2), 'application/json');
            }));
            $$('[data-csv]', el).forEach(b => b.addEventListener('click', () => {
                const e = Store.getExperiment(spec.id, b.dataset.csv);
                const cols = [...spec.stepFields, ...(typeof spec.measureFields === 'function' ? spec.measureFields(e.cfg) : spec.measureFields)];
                download(`${slug(e.name)}.csv`, toCSV(['#', ...cols.map(f => f.label + (f.unit ? ` [${f.unit}]` : ''))], e.rows.map((r, i) => [i + 1, ...cols.map(f => r[f.key])])), 'text/csv');
            }));
            $$('[data-rm]', el).forEach(b => b.addEventListener('click', () => {
                const e = Store.getExperiment(spec.id, b.dataset.rm);
                if (!confirm(`¿Eliminar definitivamente "${e.name}"? No se puede deshacer.`)) return;
                Store.deleteExperiment(spec.id, e.id);
                if (app.state.savedId === e.id) app.state.savedId = null;
                saveDraft(); renderSaved();
            }));
            spec.bindSavedActions && spec.bindSavedActions(el, app);
        }

        function saveCurrent() {
            if (!app.rows.length) { toast('No hay mediciones para guardar', 'error'); return; }
            if (!app.cfg.name) {
                const n = prompt('Nombre del experimento:', '');
                if (!n) return;
                app.cfg.name = n; fillConfig();
            }
            const { exp, ok } = Store.saveExperiment(spec.id, { id: app.state.savedId, module: spec.id, name: app.cfg.name, cfg: app.cfg, rows: app.rows, plan: app.state.plan });
            app.state.savedId = exp.id;
            saveDraft(); renderSaved();
            toast(ok ? 'Experimento guardado' : 'Guardado solo en memoria: exporte el JSON antes de cerrar', ok ? 'ok' : 'error');
        }

        function newExperiment() {
            if (app.rows.length && !app.state.savedId && !confirm('Hay mediciones sin guardar. ¿Descartarlas y empezar de nuevo?')) return;
            const keep = spec.model.defaultConfig();
            // Conserva datos del equipo (geometría, sensor) para no reescribirlos en cada experimento
            const prev = app.cfg;
            app.state = freshState();
            app.state.cfg = deepMerge(keep, { ...prev, name: '' });
            saveDraft(); fillConfig(); showTab('config');
        }

        function loadExperiment(id) {
            const e = Store.getExperiment(spec.id, id);
            if (!e) return;
            if (app.rows.length && !app.state.savedId && !confirm('Hay mediciones sin guardar en el borrador actual. ¿Reemplazarlas?')) return;
            app.state = { cfg: deepMerge(spec.model.defaultConfig(), e.cfg), rows: e.rows.slice(), plan: e.plan || [], step: e.rows.length, savedId: e.id };
            saveDraft(); fillConfig(); showTab('resultados');
            toast(`Abierto: ${e.name}`, 'ok');
        }

        function loadExample() {
            if (app.rows.length && !confirm('Se reemplazarán las mediciones actuales por datos de ejemplo. ¿Continuar?')) return;
            const cfg = spec.model.defaultConfig();
            cfg.name = 'EJEMPLO (datos simulados)';
            app.state = { cfg, rows: [], plan: spec.model.buildPlan(cfg), step: 0, savedId: null };
            const ex = spec.model.exampleData(cfg);
            spec.onExample && spec.onExample(app, ex);
            app.state.rows = ex.rows;
            app.state.step = ex.rows.length;
            saveDraft(); fillConfig(); showTab('resultados');
            toast('Datos de ejemplo cargados', 'ok');
        }
        app.loadExample = loadExample;

        function bindGoto(ctx) {
            $$('[data-goto]', ctx).forEach(a => a.addEventListener('click', e => { e.preventDefault(); showTab(a.dataset.goto); }));
        }

        // ---------------- Inicio ----------------
        function init() {
            loadDraft();
            $$('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
            $$('[data-bind]').forEach(el => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
                readBinding(el); refreshVisibility(); spec.onConfigChange && spec.onConfigChange(app, el.dataset.bind); saveDraft();
            }));
            $('#btn-plan') && $('#btn-plan').addEventListener('click', startPlan);
            $$('[data-action=example]').forEach(b => b.addEventListener('click', loadExample));
            $$('[data-action=print]').forEach(b => b.addEventListener('click', () => { showTab('resultados'); setTimeout(() => window.print(), 100); }));
            $$('[data-check]').forEach((cb, i) => {
                const k = `check:${spec.id}:${i}`;
                cb.checked = !!Store.read(k, false);
                cb.addEventListener('change', () => Store.write(k, cb.checked));
            });
            bindGoto(document);
            spec.setupConfig && spec.setupConfig(app);
            fillConfig();
            updateStatus();
            if (/[?&]ejemplo\b/.test(location.search)) { app.state.rows = []; loadExample(); return; }
            const tab = (location.hash || '#guia').slice(1);
            showTab($(`#tab-${tab}`) ? tab : 'guia');
        }

        app.init = init;
        return app;
    }

    root.LabApp = { create, getPath, setPath, DIR_LABEL };
})(typeof self !== 'undefined' ? self : this);
