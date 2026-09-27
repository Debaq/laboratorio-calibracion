/*
 * Registro de perfiles de sensor. Un perfil describe CÓMO se calibra un sensor
 * (referencia, plan, modelo, guía); el motor genérico hace el resto.
 *
 * Campos principales de un perfil:
 *   id, family, name, examples, quantity, unit, sameUnits (la lectura ya está en unidades del mensurando)
 *   mode: 'calibracion' | 'comparacion'
 *   reading: { label, unit }            readingModes: [{ id, label, unit, xLabel, xUnit, fields, toX }]
 *   references: [{ id, label, u, help }] refRes, levels, cycles, reps, bidirectional, settle
 *   models, defaultModel, tolerance, range, levelLabel(), stepAction(), refFromRow(), extraFields, params
 *   extraMetrics(), extraWarnings(), timeResponse, guide{…}, example{…}
 */
(function (root, factory) {
    const m = factory();
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.LabProfiles = m;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Familias por magnitud física (también agrupan los módulos especializados en el inicio)
    const FAMILIES = [
        { id: 'movimiento', name: 'Movimiento e inclinación' },
        { id: 'fuerza', name: 'Fuerza y peso' },
        { id: 'presion', name: 'Presión y caudal' },
        { id: 'temperatura', name: 'Temperatura' },
        { id: 'humedad', name: 'Humedad, suelo y pH' },
        { id: 'distancia', name: 'Distancia' },
        { id: 'luz', name: 'Luz' },
        { id: 'electricos', name: 'Electricidad' },
        { id: 'biomedicos', name: 'Biomédicos' },
        { id: 'otros', name: 'Otros' }
    ];

    const list = [];
    function register(p) {
        if (list.some(q => q.id === p.id)) return;
        list.push(p);
    }
    const get = id => list.find(p => p.id === id) || null;

    // ---------- Modos de lectura reutilizables ----------
    const modes = {
        direct: (label, unit) => ({ id: 'directo', label, unit }),

        /** Cuentas del ADC → tensión. */
        adcVolt: (bits = 10, vref = 5) => ({
            id: 'adc', label: 'Cuentas del ADC', unit: 'cuentas', xLabel: 'Tensión', xUnit: 'V',
            fields: [
                { key: 'bits', label: 'Resolución del ADC', unit: 'bits', default: bits, help: 'Arduino UNO: 10 · ESP32: 12' },
                { key: 'vref', label: 'Tensión de referencia del ADC', unit: 'V', default: vref, help: 'Mídala con multímetro: no asuma 5,00 V' }
            ],
            toX: (c, p) => c * p.vref / (2 ** p.bits - 1)
        }),

        /** Cuentas del ADC en un divisor resistivo → resistencia del sensor. */
        adcDivider: (bits = 10, rFixed = 10000) => ({
            id: 'divisor', label: 'Cuentas ADC (divisor resistivo)', unit: 'cuentas', xLabel: 'Resistencia del sensor', xUnit: 'Ω',
            fields: [
                { key: 'bits', label: 'Resolución del ADC', unit: 'bits', default: bits },
                { key: 'rFixed', label: 'Resistencia fija del divisor', unit: 'Ω', default: rFixed, help: 'Mídala con multímetro (tolerancia 1–5 %)' },
                { key: 'topo', label: 'Posición del sensor', type: 'select', default: 'abajo', options: [['abajo', 'Sensor entre la entrada ADC y GND'], ['arriba', 'Sensor entre Vcc y la entrada ADC']] }
            ],
            toX: (c, p) => {
                const max = 2 ** p.bits - 1;
                return p.topo === 'arriba' ? p.rFixed * (max - c) / c : p.rFixed * c / (max - c);
            }
        })
    };

    /** Inversa numérica monótona (bisección), útil para simular lecturas en los ejemplos. */
    function invert(f, y, lo, hi) {
        const up = f(hi) > f(lo);
        for (let i = 0; i < 200; i++) {
            const mid = (lo + hi) / 2;
            if ((f(mid) < y) === up) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    return { FAMILIES, register, get, list: () => list.slice(), modes, invert };
});
