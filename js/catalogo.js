/*
 * Catálogo unificado: módulos especializados + perfiles del motor genérico.
 * Un solo lugar para buscar "qué quiero calibrar", con palabras clave de modelos comerciales
 * y lo que hace falta para cada ensayo ("Necesitas: …").
 */
(function (root) {
    'use strict';
    const R = root.LabProfiles;

    /** Módulos con página propia. storeId = clave con que guardan sus datos (LabApp id). */
    const MODULES = [
        {
            id: 'imu', storeId: 'imu', href: 'imu.html', family: 'movimiento',
            name: 'Posturógrafo IMU (ángulo)', examples: 'BNO055, MPU6050, MPU9250, ICM-20948, inclinómetros · 3, 6 y 9 DOF',
            summary: 'Ángulo de la IMU en la barra del posturógrafo: ganancia, offset, acoplamiento entre ejes, flexión de la barra y matriz 3D.',
            needs: 'regla o pie de metro y huincha (referencia geométrica)',
            keywords: 'imu acelerometro giroscopio inclinometro posturografo posturografia pitch roll yaw angulo inclinacion barra'
        },
        {
            id: 'imucrudo', storeId: 'imucrudo', href: 'imu-crudo.html', family: 'movimiento',
            name: 'IMU: acelerómetro, giroscopio y magnetómetro', examples: 'MPU6050, MPU9250, ICM-20948, LSM6DS3, ADXL345, L3GD20, QMC5883L, HMC5883L',
            summary: 'Corrige los sensores crudos antes de calcular ángulos: sesgo y escala del acelerómetro, deriva del giroscopio y distorsión magnética.',
            needs: 'superficie nivelada, una caja escuadrada y registro CSV',
            keywords: 'imu crudo acelerometro giroscopio magnetometro brujula compas allan sesgo bias hierro 6dof 9dof'
        },
        {
            id: 'balanza', storeId: 'balanza', href: 'balanza.html', family: 'fuerza',
            name: 'Posturógrafo de balanza (plataforma de fuerza)', examples: '4 celdas de carga + HX711, plataformas caseras, Wii Balance Board',
            summary: 'Factor de cada celda, exactitud del centro de presión (CoP), ruido de fondo y respuesta dinámica con masa giratoria.',
            needs: 'masas conocidas hasta el peso de una persona; registro CSV para los ensayos dinámicos',
            keywords: 'posturografo posturografia plataforma fuerza cop celdas hx711 balanza equilibrio estabilometria'
        },
        {
            id: 'presion', storeId: 'presion', href: 'presion.html', family: 'presion',
            name: 'Sensor de presión diferencial', examples: 'MPX5010DP, MPXV7002DP, MPX5050DP, sensores de ΔP',
            summary: 'Ecuación V → ΔP con su incertidumbre, reutilizable en los módulos Venturi y Pitot.',
            needs: 'manguera transparente en U, regla y jeringa',
            keywords: 'presion diferencial manometro columna de agua tubo en u mpx'
        },
        {
            id: 'venturi', storeId: 'venturi', href: 'venturi.html', family: 'presion',
            name: 'Medidor Venturi', examples: 'Venturi impreso 3D o mecanizado + sensor de ΔP',
            summary: 'Coeficiente de descarga C_d del caudalímetro y su dependencia del número de Reynolds.',
            needs: 'sensor de presión calibrado y caudal de referencia (volumen + cronómetro)',
            keywords: 'venturi caudal flujo bernoulli coeficiente de descarga aire agua'
        },
        {
            id: 'pitot', storeId: 'pitot', href: 'pitot.html', family: 'presion',
            name: 'Tubo de Pitot', examples: 'Pitot o Pitot-estático + sensor de ΔP',
            summary: 'Coeficiente del Pitot y ecuación de velocidad v = K·√ΔP.',
            needs: 'sensor de presión calibrado y anemómetro de referencia',
            keywords: 'pitot velocidad aire viento tunel flujo'
        },
        {
            id: 'audio', storeId: 'audio', href: 'audio.html', family: 'audio',
            name: 'Estímulos auditivos (tiempos, rampas, espectro)', examples: 'tonos puros, tone bursts, ruido con gaps (GIN), patrones de frecuencia y duración, clicks',
            summary: 'Duración, rampas, intervalos, frecuencia, espectrograma y nivel (dBFS o dB SPL) de los estímulos de una pista de audio, con texto para métodos.',
            needs: 'el archivo WAV de la prueba o una grabación de la salida (cable o monitor del sistema)',
            keywords: 'audio sonido tono estimulo audiometria procesamiento auditivo central temporal espectrograma espectro decibeles db dbfs spl rampa gap gin rgdt patrones frecuencia duracion isi wav grabar'
        }
    ];

    const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

    /** Lista unificada de ítems para el inicio. */
    function items() {
        const mods = MODULES.map(m => ({ ...m, kind: 'modulo' }));
        const sensors = (R ? R.list() : []).map(p => ({
            id: p.id, storeId: `sensor-${p.id}`, href: `sensor.html?p=${p.id}`, family: p.family, kind: 'sensor',
            name: p.name, examples: p.examples, mode: p.mode || 'calibracion',
            needs: ((p.references || [])[0] || {}).label ? ((p.references || [])[0].label).replace(/^./, c => c.toLowerCase()) : '',
            summary: p.quantity, keywords: `${p.quantity} ${p.unit} ${p.id}`
        }));
        return [...mods, ...sensors].map(it => ({ ...it, _text: norm(`${it.name} ${it.examples} ${it.keywords || ''} ${it.summary || ''} ${it.needs || ''} ${famName(it.family)}`) }));
    }

    const famName = id => ((R ? R.FAMILIES : []).find(f => f.id === id) || {}).name || '';

    /**
     * Búsqueda: todas las palabras deben aparecer (en cualquier orden).
     * Relevancia: nombre > modelos (ejemplos) > palabras clave > resumen/familia > lo que se necesita.
     */
    function search(list, q) {
        const words = norm(q).split(/\s+/).filter(Boolean);
        if (!words.length) return list;
        const fields = it => [[norm(it.name), 8], [norm(it.examples), 5], [norm(it.keywords), 3], [norm(`${it.summary} ${famName(it.family)}`), 2], [norm(it.needs), 0.5]];
        return list.filter(it => words.every(w => it._text.includes(w)))
            .map((it, i) => ({ it, i, score: words.reduce((s, w) => s + fields(it).reduce((a, [t, wt]) => a + (t.includes(w) ? wt : 0), 0), 0) }))
            .sort((a, b) => b.score - a.score || a.i - b.i)
            .map(x => x.it);
    }

    /** Trabajo en curso y guardado en este navegador (lee lo que escribe LabStore). */
    function activity() {
        const out = [];
        const all = items();
        const byStore = Object.fromEntries(all.map(it => [it.storeId, it]));
        let keys = [];
        try { keys = Object.keys(localStorage).filter(k => k.startsWith('labcal:')); } catch (e) { return out; }
        const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
        for (const k of keys) {
            const m = k.match(/^labcal:(draft|exp):(.+)$/);
            if (!m || !byStore[m[2]]) continue;
            const it = byStore[m[2]], v = read(k);
            if (m[1] === 'draft' && v && ((v.rows && v.rows.length) || v.extra)) {
                const times = (v.rows || []).map(r => Date.parse(r.time)).filter(isFinite);
                out.push({ type: 'draft', item: it, name: (v.cfg && v.cfg.name) || 'sin nombre', n: (v.rows || []).length, saved: !!v.savedId, time: times.length ? Math.max(...times) : 0 });
            }
            if (m[1] === 'exp' && Array.isArray(v) && v.length) {
                const t = Math.max(...v.map(e => Date.parse(e.updated || e.created) || 0));
                out.push({ type: 'saved', item: it, n: v.length, time: t });
            }
        }
        return out.sort((a, b) => b.time - a.time);
    }

    root.LabCatalog = { MODULES, items, search, activity, famName, norm };
})(typeof self !== 'undefined' ? self : this);
