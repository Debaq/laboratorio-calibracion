/* Interfaz del motor genérico: arma la página completa a partir del perfil (?p=id) */
(function () {
    'use strict';
    const G = window.GenericoModel, R = window.LabProfiles;
    const { $, $$, esc, fmt, sig, table, plot, toast, readFile } = window.LabUI;

    const pid = new URLSearchParams(location.search).get('p');
    const profile = R.get(pid);
    if (!profile) {
        $('#app').innerHTML = `<main><div class="callout error">No existe el sensor “${esc(pid || '')}”. <a href="index.html#catalogo">Volver al catálogo</a></div></main>`;
        return;
    }
    const M = G.create(profile);
    const isCmp = M.mode === 'comparacion';
    const family = (R.FAMILIES.find(f => f.id === profile.family) || {}).name || '';
    const labels = cfg => profile.labels ? profile.labels(cfg) : { quantity: profile.quantity, unit: profile.unit };
    const modeOf = cfg => M.modes.find(m => m.id === cfg.readingMode) || M.modes[0];
    const computedRef = cfg => profile.computedRef ? profile.computedRef(cfg) : false;
    const refOf = cfg => M.refs.find(r => r.id === cfg.refType) || M.refs[0];
    document.title = profile.name;

    // ---------------- Esqueleto de la página ----------------
    const num = (bind, label, unit, help, attrs = '') => `<div class="field"><label>${label}${unit ? ` <small>(${esc(unit)})</small>` : ''}</label>
        <input type="text" inputmode="decimal" data-bind="${bind}" data-type="number" ${attrs}>${help ? `<div class="help">${help}</div>` : ''}</div>`;
    const txt = (bind, label, help, ph = '') => `<div class="field"><label>${label}</label><input type="text" data-bind="${bind}" placeholder="${esc(ph)}">${help ? `<div class="help">${help}</div>` : ''}</div>`;
    const sel = (bind, label, options, help, type = '') => `<div class="field"><label>${label}</label><select data-bind="${bind}" ${type ? `data-type="${type}"` : ''}>${options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select>${help ? `<div class="help">${help}</div>` : ''}</div>`;
    const g = profile.guide || {};
    const u0 = profile.unit;

    const modeFields = M.modes.map(m => (m.fields || []).map(f => `<div data-show-if="readingMode=${m.id}">${f.type === 'select'
        ? sel(`modeParams.${f.key}`, f.label, f.options, f.help)
        : num(`modeParams.${f.key}`, f.label, f.unit, f.help)}</div>`).join('')).join('');
    const paramFields = (profile.params || []).map(f => f.type === 'text' ? txt(`params.${f.key}`, f.label, f.help) : num(`params.${f.key}`, f.label, f.unit, f.help)).join('');

    $('#app').innerHTML = `
    <header class="top"><div class="inner">
        <a class="back" href="index.html#catalogo">← Catálogo de sensores</a>
        <h1>${esc(profile.name)}</h1>
        <p class="sub">${esc(family)} · ${esc(profile.examples || '')}</p>
        <div id="status"></div>
    </div>
    <nav class="tabs" role="tablist">
        <button data-tab="guia"><span class="num">1</span>Guía</button>
        <button data-tab="config"><span class="num">2</span>Preparación</button>
        <button data-tab="medir"><span class="num">3</span>Medición</button>
        <button data-tab="resultados"><span class="num">4</span>Resultados</button>
        ${profile.timeResponse ? '<button data-tab="respuesta"><span class="num">5</span>Tiempo de respuesta</button>' : ''}
        <button data-tab="guardados"><span class="num">${profile.timeResponse ? 6 : 5}</span>Guardados</button>
    </nav></header>
    <main>
        <section class="panel" id="tab-guia">
            <div class="callout"><strong>Objetivo:</strong> ${g.objetivo || ''}</div>
            <h2>Principio</h2>${g.principio || ''}
            ${isCmp ? `<div class="card"><h3>Tipo de ensayo: comparación (Bland–Altman)</h3><p>La magnitud no se puede fijar a voluntad, así que se registran pares sensor–referencia en distintas condiciones
                y se analiza su concordancia: sesgo, límites de acuerdo del 95 % y sesgo proporcional.</p></div>` : ''}
            ${g.materiales ? `<h2>Materiales</h2><ul>${g.materiales.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
            ${g.procedimiento ? `<h2>Procedimiento</h2><ol class="steps">${g.procedimiento.map(x => `<li>${x}</li>`).join('')}</ol>` : ''}
            ${g.checklist ? `<h2>Lista de verificación</h2><div class="card">${g.checklist.map(x => `<label class="check"><input type="checkbox" data-check> ${x}</label>`).join('')}</div>` : ''}
            ${g.errores ? `<h2>Errores comunes</h2><ul>${g.errores.map(x => `<li>${x}</li>`).join('')}</ul>` : ''}
            <p class="muted small">Conceptos generales (sesgo, repetibilidad, incertidumbre, conformidad): <a href="fundamentos.html">Fundamentos de calibración</a>.</p>
            <div class="actions"><button type="button" class="primary" data-goto="config">Ir a Preparación →</button>
                <button type="button" data-action="example">Ver un ejemplo con datos simulados</button>
                <button type="button" data-action="protocol">Descargar protocolo (PDF)</button></div>
        </section>

        <section class="panel" id="tab-config" hidden>
            <div class="card"><h3>Experimento y sensor</h3>
                <div class="grid two">
                    ${txt('name', 'Nombre del experimento', '', `Ej: ${profile.name} #1 — grupo 2`)}
                    ${txt('sensor.model', 'Modelo del sensor', '', profile.examples || '')}
                    ${txt('sensor.maker', 'Fabricante / proveedor')}
                    ${txt('sensor.notes', 'Notas (placa, firmware, montaje)')}
                </div>
                ${paramFields ? `<div class="grid three" style="margin-top:12px">${paramFields}</div>` : ''}
            </div>
            <div class="card"><h3>Lectura del sensor</h3>
                <div class="grid three">
                    ${M.modes.length > 1 ? sel('readingMode', 'Qué se registra', M.modes.map(m => [m.id, m.label])) : ''}
                    ${modeFields}
                </div>
            </div>
            <div class="card"><h3>Referencia</h3>
                <div class="grid three">
                    ${sel('refType', 'Tipo de referencia', M.refs.map(r => [r.id, r.label]))}
                    ${num('uRef', 'Incertidumbre estándar de la referencia', u0, 'Se completa según el tipo; ajústela con el certificado de su equipo.')}
                    ${num('refRes', 'Resolución de la referencia', u0, 'División mínima del instrumento de referencia.')}
                </div>
                <p class="muted small" id="ref-help"></p>
            </div>
            <div class="card"><h3>Plan y criterio</h3>
                <div class="grid three">
                    <div class="field"><label>${isCmp ? 'Condiciones (códigos)' : 'Niveles de referencia'} <small id="lv-unit">(${esc(u0)})</small></label><input type="text" data-bind="levels" data-type="list">
                        <div class="help">Separe con punto y coma.</div></div>
                    ${isCmp ? '' : num('cycles', 'Ciclos completos', '', '2–3 ciclos muestran la repetibilidad.')}
                    ${num('reps', isCmp ? 'Repeticiones por condición' : 'Lecturas por nivel', '', isCmp ? 'Use ≥ 30 pares en total.' : '')}
                    ${isCmp ? '' : '<div class="field"><label class="inline-check"><input type="checkbox" data-bind="bidirectional"> Subir y bajar (mide histéresis)</label></div>'}
                    ${isCmp ? '' : sel('model', 'Modelo de la curva', (profile.models || ['lineal']).map(id => [id, G.MODELS[id].label + ' — ' + G.MODELS[id].eq]), 'En Resultados se comparan todos por AICc.')}
                    ${num('tolerance', isCmp ? (profile.criterion === 'arms' ? 'Tolerancia (ARMS máximo)' : 'Tolerancia (límites de acuerdo)') : 'Tolerancia de aceptación', u0, 'Del datasheet o del requisito de uso.')}
                </div>
                <div id="levels-preview"></div>
            </div>
            <div class="card"><h3>Condiciones del lugar</h3>
                <div class="grid three">
                    ${num('env.temp', 'Temperatura ambiente', '°C')}
                    ${num('env.p_hPa', 'Presión atmosférica', 'hPa', 'Estación DMC o barómetro (para ebullición, densidades).')}
                    ${num('env.alt', 'Altitud', 'm')}
                    ${num('env.lat', 'Latitud', '°')}
                </div>
            </div>
            <div class="actions">
                <button type="button" class="primary" id="btn-plan">Generar plan y comenzar →</button>
                <button type="button" data-action="example">Cargar datos de ejemplo</button>
                <button type="button" data-action="protocol">Descargar protocolo (PDF)</button>
            </div>
        </section>

        <section class="panel" id="tab-medir" hidden><div id="measure"></div></section>
        <section class="panel" id="tab-resultados" hidden>
            <div class="actions no-print"><button type="button" data-action="print">Imprimir / guardar PDF</button></div>
            <div id="results"></div>
        </section>
        ${profile.timeResponse ? `<section class="panel" id="tab-respuesta" hidden>
            <div class="callout">Constante de tiempo τ: tiempo en llegar al 63,2 % de un cambio brusco (escalón). t₉₀ ≈ 2,3·τ. Espere al menos 5·τ antes de leer en la calibración.</div>
            <div class="card"><h3>Cómo registrar el escalón</h3><ol class="steps">
                <li>Deje el sensor estable en la condición inicial (p. ej. aire a temperatura ambiente) y comience a registrar con marca de tiempo (<code>t_ms,lectura</code>).</li>
                <li>Pasados 3–5 s, cámbielo de golpe a la condición final (p. ej. punto de hielo) y no lo mueva.</li>
                <li>Siga registrando al menos 5·τ (hasta que la lectura deje de cambiar).</li>
                <li>Pegue el texto del monitor serie o abra el archivo.</li></ol></div>
            <div class="card">
                <div class="field"><label>Datos (CSV con tiempo y lectura)</label><textarea id="tr-text" rows="4" placeholder="t_ms,lectura&#10;0,21.50&#10;100,21.49 …"></textarea></div>
                <div class="actions">
                    <button type="button" class="primary" id="tr-run">Analizar</button>
                    <label class="button">Abrir archivo<input type="file" id="tr-file" accept=".csv,.txt,text/plain" hidden></label>
                    <button type="button" id="tr-example">Ejemplo simulado</button>
                </div>
            </div>
            <div id="tr-out"></div>
        </section>` : ''}
        <section class="panel" id="tab-guardados" hidden><div id="saved"></div></section>
    </main>`;

    // ---------------- Módulo ----------------
    const app = window.LabApp.create({
        id: `sensor-${profile.id}`,
        model: M,
        stepFields: isCmp
            ? [{ key: 'level', label: 'Condición', decimals: 0 }, { key: 'rep', label: 'N°', decimals: 0 }]
            : [{ key: 'cycle', label: 'Ciclo', decimals: 0 }, { key: 'dir', label: 'Sentido', type: 'select', options: [['sube', '↑ Sube'], ['baja', '↓ Baja']] }, { key: 'level', label: 'Nivel', unit: u0, decimals: 2 }],
        measureFields: cfg => {
            const L = labels(cfg), m = modeOf(cfg);
            return [
                ...(computedRef(cfg) ? [] : [{ key: 'ref', label: `${L.quantity} de referencia`, short: 'Referencia', unit: L.unit, decimals: 3 }]),
                { key: 'reading', label: profile.labels ? L.reading : (M.modes.length > 1 ? m.label.replace(/\s*\(.*$/, '') : profile.reading.label), short: 'Lectura', unit: profile.labels ? L.readingUnit : (m.unit || profile.reading.unit), decimals: 4 },
                ...(profile.extraFields || []).map(f => ({ ...f, decimals: 2 }))
            ];
        },
        measureNote: isCmp ? 'Registre sensor y referencia en el mismo instante.' : 'Registre el valor REAL de la referencia (no el nivel objetivo) y la lectura del sensor.',
        validateConfig(cfg) {
            if (!cfg.name) return 'Escriba un nombre para el experimento.';
            if (cfg.levels.length < (isCmp ? 1 : 3)) return isCmp ? 'Defina al menos una condición.' : 'Defina al menos 3 niveles.';
            if (!(cfg.reps >= 1)) return 'Al menos 1 lectura por nivel.';
            return null;
        },
        setupConfig: () => { },
        fillConfig: a => { updateRefHelp(a); updatePreview(a); },
        onConfigChange(a, path) {
            if (path === 'refType') { a.cfg.uRef = refOf(a.cfg).u; a.fillConfig(); }
            if (path.startsWith('params.')) updatePreview(a);
            updateRefHelp(a); updatePreview(a);
        },
        onTab(name) { if (name === 'respuesta') renderTR(); },
        onExample(a) { if (profile.timeResponse) a.state.extra = { step: M.exampleStep(a.state.cfg) }; },
        protocolSummary(cfg) {
            const L = labels(cfg), m = modeOf(cfg), r = refOf(cfg);
            return [
                ['Sensor', esc(`${cfg.sensor.model || '—'} ${cfg.sensor.maker ? '· ' + cfg.sensor.maker : ''}`)],
                ['Mensurando', esc(`${L.quantity} [${L.unit}]`)],
                ['Se registra', esc(`${m.label || profile.reading.label}${m.unit ? ` [${m.unit}]` : ''}`)],
                ...(m.fields || []).map(f => [esc(f.label), esc(`${f.type === 'select' ? (f.options.find(o => o[0] === cfg.modeParams[f.key]) || [0, ''])[1] : cfg.modeParams[f.key]} ${f.unit || ''}`)]),
                ['Referencia', esc(`${r.label} · u = ${cfg.uRef} ${L.unit} · resolución ${cfg.refRes} ${L.unit}`)],
                [isCmp ? 'Condiciones' : 'Niveles', cfg.levels.map(v => esc(M.levelLabel(v, cfg))).join(' · ')],
                ['Plan', isCmp ? `${cfg.reps} pares por condición` : `${cfg.cycles} ciclos · ${cfg.reps} lectura(s) por nivel${cfg.bidirectional ? ' · subiendo y bajando' : ''}`],
                ...(isCmp ? [] : [['Modelo', esc(`${G.MODELS[cfg.model].label}: ${G.MODELS[cfg.model].eq}`)]]),
                ['Tolerancia', `${isCmp && profile.criterion === 'arms' ? 'ARMS ≤ ' : '±'}${cfg.tolerance} ${esc(L.unit)}`],
                ...(profile.params || []).map(f => [esc(f.label), esc(`${cfg.params[f.key]} ${f.unit || ''}`)])
            ];
        },
        protocolExtra() {
            return profile.timeResponse ? `<h3>Tiempo de respuesta (opcional)</h3><table class="kv"><tr><th>Condición inicial → final</th><td></td></tr>
                <tr><th>Archivo del registro</th><td></td></tr><tr><th>Observaciones</th><td style="height:40px"></td></tr></table>` : '';
        },
        renderResults
    });

    function updateRefHelp(a) {
        const r = refOf(a.cfg);
        $('#ref-help').innerHTML = r.help ? esc(r.help) : '';
        if ($('#lv-unit')) $('#lv-unit').textContent = `(${labels(a.cfg).unit})`;
    }

    function updatePreview(a) {
        const el = $('#levels-preview');
        if (!el) return;
        const plan = M.buildPlan(a.cfg);
        el.innerHTML = `<p class="muted small">${plan.length} mediciones: ${a.cfg.levels.map(v => esc(M.levelLabel(v, a.cfg))).join(' · ')}</p>`;
    }

    // ---------------- Resultados ----------------
    const kpi = (l, v, s = '', c = '') => `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
    const dig = v => Math.max(0, Math.min(6, 3 - Math.floor(Math.log10(Math.abs(v) || 1))));

    function renderResults(el, cfg, rows, res, a) {
        if (res.mode === 'comparacion') return renderComparison(el, cfg, res, a);
        const L = labels(cfg), m = res.metrics, f = res.fit, un = L.unit, xm = modeOf(cfg);
        const xUnit = profile.labels ? L.readingUnit : (xm.xUnit || xm.unit || profile.reading.unit);
        const d = dig(m.see || 1);
        el.innerHTML = `
            <h2>Resultado: ${esc(cfg.sensor.model || profile.name)}</h2>
            <div class="kpis">
                ${kpi('Veredicto (con ecuación)', m.conform ? 'Cumple' : 'No cumple', `tolerancia ±${fmt(cfg.tolerance, 3)} ${esc(un)}`, m.conform ? 'good' : 'bad')}
                ${res.raw ? kpi('Sin corregir', res.raw.conform ? 'Cumple' : 'No cumple', `error máx. ${fmt(res.raw.maxErr, d)} ${esc(un)}`, res.raw.conform ? 'good' : 'bad') : ''}
                ${res.raw ? kpi('Sesgo sin corregir', `${fmt(res.raw.bias, d)} ${esc(un)}`, `RMSE ${fmt(res.raw.rmse, d)}`) : ''}
                ${kpi('Error típico (SEE)', `${fmt(m.see, d)} ${esc(un)}`, `modelo ${esc(f.label)}`)}
                ${kpi('Residuo máximo', `${fmt(m.maxRes, d)} ${esc(un)}`, '')}
                ${kpi('U de la ecuación', `${fmt(m.U, d)} ${esc(un)}`, 'k = 2, peor punto del rango')}
                ${kpi('Repetibilidad', `${fmt(m.repeat, d)} ${esc(un)}`, 'desv. est. combinada')}
                ${kpi('Histéresis', isFinite(m.hyst) ? `${fmt(m.hyst, d)} ${esc(un)}` : '—', 'máx. |sube − baja|')}
                ${kpi('Rango calibrado', `${sig(m.ymin, 4)} – ${sig(m.ymax, 4)}`, esc(un))}
                ${res.extra.map(e => kpi(esc(e.label), esc(e.value), esc(e.sub || ''))).join('')}
            </div>
            ${a.warningsHtml(res.warnings)}
            <div class="card"><h3>Ecuación de calibración — ${esc(f.label)}</h3>
                <div class="math">${esc(f.eq)}
x = ${esc(xm.xLabel || (profile.labels ? L.reading : profile.reading.label))} [${esc(xUnit)}]   →   y = ${esc(L.quantity)} [${esc(un)}]
válida para ${sig(m.xmin, 5)} ≤ x ≤ ${sig(m.xmax, 5)} ${esc(xUnit)}</div>
                ${table(['Coeficiente', 'Valor', 'Error estándar'], f.coef.map((c, i) => [f.names[i], sig(c, 7), sig(f.se[i], 3)]))}
                <details><summary>Código para Arduino / C</summary><pre>${esc(G.codeFor(f, profile, cfg, m.xmin, m.xmax))}</pre></details>
            </div>
            <div class="card"><h3>Comparación de modelos</h3>
                ${table(['Modelo', 'Parámetros', 'SEE', 'Residuo máx.', 'AICc', 'ΔAICc', ''], res.candidates.map(c => c.error
                    ? [esc(c.label), '', '', '', '', esc(c.error), '']
                    : [`${c.id === f.id ? '<strong>' : ''}${esc(c.label)}${c.id === f.id ? '</strong>' : ''}`, c.p, fmt(c.see, d), fmt(c.maxRes, d), fmt(c.aicc, 1),
                        res.best ? fmt(c.aicc - res.best.aicc, 1) : '', c.id === f.id ? '<span class="badge ok">en uso</span>' : `<button data-model="${c.id}">Usar</button>`]))}
                <p class="muted small">El AICc premia el buen ajuste pero castiga los parámetros extra. ΔAICc &lt; 2: modelos equivalentes (use el más simple); &gt; 4: el de menor AICc es claramente mejor.</p>
            </div>
            <div class="plots"><div id="g1"></div><div id="g2"></div>${res.raw ? '<div id="g3"></div>' : ''}<div id="g4"></div></div>
            <div class="card"><h3>Por nivel</h3>
                ${table(['Nivel', 'n', `Ref. media (${esc(un)})`, `Lectura media (${esc(xUnit)})`, `Residuo medio (${esc(un)})`, `s (${esc(un)})`],
                    [...S_groupLevels(res.pts)].map(([lv, ps]) => [esc(M.levelLabel(lv, cfg)), ps.length, fmt(mean(ps.map(p => p.y)), d), sig(mean(ps.map(p => p.x)), 5), fmt(mean(ps.map(p => p.res)), d), ps.length > 1 ? fmt(sd(ps.map(p => p.res)), d) : '—']))}
            </div>`;
        $$('[data-model]', el).forEach(b => b.addEventListener('click', () => { a.cfg.model = b.dataset.model; a.saveDraft(); a.fillConfig(); a.renderResults(); }));

        const pts = res.pts, up = pts.filter(p => p.dir !== 'baja'), dn = pts.filter(p => p.dir === 'baja');
        const xs = Array.from({ length: 60 }, (_, i) => m.xmin + (m.xmax - m.xmin) * i / 59);
        plot($('#g1'), {
            title: `${L.quantity} vs lectura`, xLabel: `x (${xUnit})`, yLabel: `${L.quantity} (${un})`,
            series: [{ label: 'subiendo', points: up.map(p => [p.x, p.y]) }, { label: 'bajando', color: 2, points: dn.map(p => [p.x, p.y]) },
                { label: f.label, kind: 'line', color: 3, points: xs.map(x => [x, f.predict(x)]) }]
        });
        plot($('#g2'), {
            title: 'Residuos (con U de la referencia)', xLabel: `${L.quantity} (${un})`, yLabel: `residuo (${un})`,
            series: [{ label: 'subiendo', points: up.map(p => [p.y, p.res]), err: up.map(p => 2 * p.uRef) }, { label: 'bajando', color: 2, points: dn.map(p => [p.y, p.res]), err: dn.map(p => 2 * p.uRef) }],
            hlines: [{ y: cfg.tolerance, label: '+tol' }, { y: -cfg.tolerance, label: '−tol' }]
        });
        if (res.raw) plot($('#g3'), {
            title: 'Error del sensor sin corregir', xLabel: `${L.quantity} (${un})`, yLabel: `lectura − referencia (${un})`,
            series: [{ label: 'error', color: 4, points: pts.map(p => [p.y, p.x - p.y]) }],
            hlines: [{ y: cfg.tolerance, label: '+tol' }, { y: -cfg.tolerance, label: '−tol' }]
        });
        plot($('#g4'), {
            title: 'Incertidumbre expandida de la ecuación (k = 2)', xLabel: `x (${xUnit})`, yLabel: `U (${un})`,
            series: [{ label: 'U', kind: 'line', color: 5, points: xs.map(x => [x, res.Uat(x)]) }]
        });
    }

    function renderComparison(el, cfg, res, a) {
        const L = labels(cfg), m = res.metrics, un = L.unit, d = dig(m.sd || 1);
        const crit = res.criterion === 'arms' ? `ARMS ≤ ${fmt(cfg.tolerance, 2)} ${esc(un)}` : `límites dentro de ±${fmt(cfg.tolerance, 2)} ${esc(un)}`;
        el.innerHTML = `
            <h2>Concordancia: ${esc(cfg.sensor.model || profile.name)}</h2>
            <div class="kpis">
                ${kpi('Veredicto', m.conform ? 'Cumple' : 'No cumple', crit, m.conform ? 'good' : 'bad')}
                ${kpi('Con corrección de offset', m.conformOffset ? 'Cumpliría' : 'No cumple', `restando el sesgo (${fmt(m.bias, d)} ${esc(un)})`, m.conformOffset ? 'good' : 'bad')}
                ${kpi('Sesgo', `${fmt(m.bias, d)} ${esc(un)}`, `IC 95 %: ${fmt(m.ciBias[0], d)} a ${fmt(m.ciBias[1], d)}`)}
                ${kpi('Límites de acuerdo 95 %', `${fmt(m.loa[0], d)} a ${fmt(m.loa[1], d)}`, `${esc(un)} · IC ± ${fmt(m.ciLoa, d)}`)}
                ${kpi('ARMS', `${fmt(m.arms, d)} ${esc(un)}`, '√ media(d²)')}
                ${kpi('Sesgo proporcional', m.pProp < 0.05 ? 'Sí' : 'No', `pendiente ${fmt(m.propSlope, 3)} · p = ${sig(m.pProp, 2)}`)}
                ${kpi('Pares', m.n, `r = ${fmt(m.r, 3)} (no mide acuerdo)`)}
            </div>
            ${a.warningsHtml(res.warnings)}
            <div class="plots"><div id="b1"></div><div id="b2"></div></div>
            <div class="card"><h3>¿Cómo interpretar?</h3><ul>
                <li><strong>Sesgo</strong>: diferencia promedio. Si su IC no incluye 0, el sensor sobre- o subestima sistemáticamente (se corrige restándolo).</li>
                <li><strong>Límites de acuerdo</strong>: el 95 % de las diferencias individuales cae entre ellos. Es lo que importa para usar el sensor en lugar de la referencia.</li>
                <li><strong>Sesgo proporcional</strong>: si las diferencias crecen con el valor medido, el error no es constante.</li>
                <li><strong>Correlación</strong>: dos equipos pueden correlacionar 0,99 y aun así diferir mucho; no la use para concluir acuerdo.</li>
            </ul></div>`;
        const pts = res.pts;
        const mm = res.mm, lo = Math.min(...mm), hi = Math.max(...mm);
        plot($('#b1'), {
            title: 'Bland–Altman', xLabel: `promedio sensor–referencia (${un})`, yLabel: `sensor − referencia (${un})`,
            series: [{ label: 'par', points: mm.map((v, i) => [v, res.d[i]]) }],
            hlines: [{ y: m.bias, label: 'sesgo' }, { y: m.loa[0], label: '−1,96 s' }, { y: m.loa[1], label: '+1,96 s' }, { y: 0 }]
        });
        const all = pts.flatMap(p => [p.x, p.y]), a0 = Math.min(...all), a1 = Math.max(...all);
        plot($('#b2'), {
            title: 'Sensor vs referencia', xLabel: `referencia (${un})`, yLabel: `sensor (${un})`,
            series: [{ label: 'par', color: 4, points: pts.map(p => [p.y, p.x]) }, { label: 'identidad', kind: 'line', color: 3, points: [[a0, a0], [a1, a1]] }]
        });
    }

    const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
    const sd = a => Math.sqrt(a.reduce((s, v) => s + (v - mean(a)) ** 2, 0) / (a.length - 1));
    function S_groupLevels(pts) {
        const m = new Map();
        pts.forEach(p => { if (!m.has(p.level)) m.set(p.level, []); m.get(p.level).push(p); });
        return [...m.entries()].sort((a, b) => a[0] - b[0]);
    }

    // ---------------- Tiempo de respuesta ----------------
    function renderTR() {
        const out = $('#tr-out');
        const text = (app.state.extra || {}).step;
        if (!text) { out.innerHTML = '<p class="muted">Aún no hay registro.</p>'; return; }
        let fit = null;
        if (app.rows.length && !profile.sameUnits) {
            try { const r = M.analyze(app.cfg, app.rows); if (r.ok) fit = r.fit; } catch (e) { /* sin calibración */ }
        }
        let r;
        try { r = M.timeResponse(text, app.cfg, fit); }
        catch (e) { out.innerHTML = `<div class="callout error">${esc(e.message)}</div>`; return; }
        const d = dig(r.tau);
        out.innerHTML = `
            <div class="kpis">
                ${kpi('Constante de tiempo τ', `${fmt(r.tau, d)} s`, '63,2 % del cambio')}
                ${kpi('t₉₀', `${fmt(r.t90, d)} s`, 'tiempo al 90 %')}
                ${kpi('Espera recomendada', `${fmt(5 * r.tau, 0)} s`, '5·τ → error < 1 % del cambio')}
                ${kpi('Escalón', `${sig(r.y0, 4)} → ${sig(r.yInf, 4)}`, esc(r.unit || ''))}
                ${kpi('Ajuste', `R² ${fmt(r.r2, 4)}`, r.basis === 'calibrada' ? 'sobre valores calibrados' : r.basis === 'directa' ? 'lectura directa' : 'sobre lectura cruda')}
            </div>
            ${app.warningsHtml(r.warnings)}
            <div class="plots"><div id="tr1"></div></div>`;
        plot($('#tr1'), {
            title: 'Respuesta al escalón', xLabel: 't (s)', yLabel: r.unit || '',
            series: [{ label: 'medido', kind: 'line', width: 1, points: r.t.map((t, i) => [t, r.y[i]]) },
                { label: 'primer orden', kind: 'line', color: 2, points: r.t.map(t => [t, r.model(t)]) }],
            hlines: [{ y: r.y0 + 0.632 * r.span, label: '63,2 %' }]
        });
    }

    if (profile.timeResponse) {
        const setStep = text => { app.state.extra = { ...(app.state.extra || {}), step: text }; app.saveDraft(); renderTR(); };
        $('#tr-run').addEventListener('click', () => { const t = $('#tr-text').value.trim(); if (!t) { toast('Pegue los datos primero', 'error'); return; } setStep(t); $('#tr-text').value = ''; });
        $('#tr-file').addEventListener('change', async ev => { const f = ev.target.files[0]; if (f) setStep(await readFile(f)); ev.target.value = ''; });
        $('#tr-example').addEventListener('click', () => setStep(M.exampleStep(app.cfg)));
    }

    app.init();
})();
