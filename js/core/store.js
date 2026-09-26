/*
 * LabStore — persistencia local (localStorage). Funciona abriendo los HTML con doble clic.
 * Se guardan SOLO datos crudos (configuración + mediciones); los resultados se recalculan siempre.
 */
(function (root) {
    'use strict';
    const PREFIX = 'labcal:';
    let memory = {}; // respaldo si localStorage no está disponible (modo privado, etc.)

    function read(key, fallback) {
        try {
            const v = localStorage.getItem(PREFIX + key);
            return v == null ? fallback : JSON.parse(v);
        } catch (e) {
            return key in memory ? memory[key] : fallback;
        }
    }

    function write(key, value) {
        try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
        catch (e) { memory[key] = value; return false; }
    }

    function remove(key) {
        try { localStorage.removeItem(PREFIX + key); } catch (e) { delete memory[key]; }
    }

    const listExperiments = module => read('exp:' + module, []);

    function saveExperiment(module, exp) {
        const list = listExperiments(module);
        const now = new Date().toISOString();
        if (exp.id) {
            const i = list.findIndex(e => e.id === exp.id);
            if (i >= 0) list[i] = { ...exp, updated: now };
            else list.push({ ...exp, updated: now });
        } else {
            exp = { ...exp, id: `${module}-${Date.now().toString(36)}`, created: now, updated: now };
            list.push(exp);
        }
        const ok = write('exp:' + module, list);
        return { exp, ok };
    }

    function deleteExperiment(module, id) {
        write('exp:' + module, listExperiments(module).filter(e => e.id !== id));
    }

    const getExperiment = (module, id) => listExperiments(module).find(e => e.id === id) || null;

    /** Respaldo completo de todos los módulos (para cambiar de computador). */
    function exportAll() {
        const out = { app: 'laboratorio-calibracion', version: 1, date: new Date().toISOString(), data: {} };
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k.startsWith(PREFIX)) out.data[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k));
            }
        } catch (e) { Object.assign(out.data, memory); }
        return out;
    }

    function importAll(obj) {
        if (!obj || obj.app !== 'laboratorio-calibracion') throw new Error('Archivo no reconocido');
        for (const [k, v] of Object.entries(obj.data)) {
            if (k.startsWith('exp:') && Array.isArray(v)) {
                const cur = read(k, []);
                const ids = new Set(cur.map(e => e.id));
                write(k, [...cur, ...v.filter(e => !ids.has(e.id))]);
            } else if (read(k) === undefined) write(k, v);
        }
    }

    root.LabStore = { read, write, remove, listExperiments, saveExperiment, deleteExperiment, getExperiment, exportAll, importAll };
})(typeof self !== 'undefined' ? self : this);
