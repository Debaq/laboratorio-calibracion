/* Perfiles: biomédicos (comparación con equipo de referencia — Bland–Altman) */
(function (root) {
    'use strict';
    const req = n => (typeof require === 'function') ? require(n) : null;
    const R = req('./registry.js') || root.LabProfiles;

    const ETHICS = '<div class="callout warn"><strong>Seguridad y ética:</strong> estas pruebas se hacen solo en voluntarios sanos, con consentimiento, sin inducir hipoxia ni esfuerzos intensos. '
        + 'Un sensor casero NO debe usarse para decisiones clínicas.</div>';

    const SPO2_CONDITIONS = ['reposo sentado', 'reposo, otra mano', 'de pie', 'tras ejercicio suave', 'mano fría (1 min en agua fría)'];
    R.register({
        id: 'spo2', family: 'biomedicos', name: 'Oximetría de pulso (SpO₂)', examples: 'MAX30102, MAX30100', mode: 'comparacion',
        quantity: 'Saturación de oxígeno', unit: '%', symbol: 'SpO₂', sameUnits: true,
        reading: { label: 'SpO₂ del sensor', unit: '%' },
        references: [{ id: 'oximetro', label: 'Oxímetro de pulso comercial (registro sanitario)', u: 1, help: 'Los oxímetros clínicos declaran ±2 % (70–100 %).' }],
        refRes: 1,
        levels: [1, 2, 3, 4, 5], cycles: 1, reps: 6, bidirectional: false,
        levelLabel: lv => SPO2_CONDITIONS[lv - 1] || `condición ${lv}`,
        stepAction: (st, cfg) => `Condición: ${SPO2_CONDITIONS[st.level - 1] || st.level} (voluntario/a ${st.rep}). Sensor y oxímetro en dedos contiguos de la misma mano, quietos 30 s. Registre ambos valores en el mismo instante.`,
        models: ['lineal'], tolerance: 4, criterion: 'arms', range: [70, 100],
        guide: {
            objetivo: 'Evaluar la concordancia del sensor con un oxímetro comercial mediante Bland–Altman y el ARMS, el indicador que usa la norma ISO 80601-2-61 (ARMS ≤ 4 %).',
            principio: `${ETHICS}<div class="math">\\[ d = \\mathrm{SpO_2}^{\\,\\text{sensor}} - \\mathrm{SpO_2}^{\\,\\text{ref}} \\qquad \\text{sesgo} = \\bar d \\qquad \\mathrm{LA}_{95} = \\bar d \\pm 1{,}96\\,s_d \\qquad \\mathrm{ARMS} = \\sqrt{\\tfrac{1}{n}\\textstyle\\sum d_i^{2}} \\]</div>
                <p>La correlación NO mide acuerdo: dos equipos pueden correlacionar 0,99 y diferir 5 %. Bland–Altman muestra el error en función del valor medido.</p>
                <p><strong>Limitación:</strong> en voluntarios sanos la SpO₂ queda entre 94 y 100 %. La validación real (70–100 %) requiere estudios de desaturación controlada en laboratorio clínico.</p>`,
            materiales: ['Oxímetro comercial con registro sanitario.', 'Sensor con firmware que entregue SpO₂ promediada (p. ej. algoritmo de Maxim).', 'Voluntarios sanos con consentimiento.'],
            procedimiento: ['Coloque sensor y oxímetro en dedos contiguos de la misma mano.', 'Pida al voluntario quedarse quieto 30 s; registre ambos valores en el mismo instante.', 'Recorra las condiciones del plan con distintos voluntarios (≥ 30 pares en total).'],
            checklist: ['Consentimiento firmado', 'Dedos limpios, sin esmalte', 'Mano quieta y a la altura del corazón', 'Luz ambiente tapada sobre el sensor'],
            errores: ['<strong>Movimiento</strong>: el principal error de la oximetría.', '<strong>Presión excesiva</strong> del sensor sobre el dedo: altera la perfusión.', '<strong>Solo reportar la correlación</strong>.']
        },
        example: { refField: true, levelToRef: lv => [98, 97, 97, 96, 95][lv - 1] ?? 97, refJitter: 1, refDecimals: 0, bias: 0.8, sdDiff: 1.4, prop: -0.1, center: 97, forward: v => Math.round(v), decimals: 0 }
    });

    const HR_CONDITIONS = ['reposo sentado', 'de pie', 'tras 20 sentadillas', 'recuperación 1 min', 'recuperación 3 min'];
    R.register({
        id: 'fc', family: 'biomedicos', name: 'Frecuencia cardiaca (PPG)', examples: 'MAX30102, sensor Pulse Sensor, bandas y relojes', mode: 'comparacion',
        quantity: 'Frecuencia cardiaca', unit: 'lpm', symbol: 'FC', sameUnits: true,
        reading: { label: 'FC del sensor', unit: 'lpm' },
        references: [
            { id: 'ecg', label: 'Monitor de ECG / banda de pecho', u: 1 },
            { id: 'oximetro', label: 'Oxímetro de pulso comercial', u: 1.5 },
            { id: 'manual', label: 'Conteo manual de pulso 60 s', u: 2 }
        ],
        refRes: 1,
        levels: [1, 2, 3, 4, 5], cycles: 1, reps: 6, bidirectional: false,
        levelLabel: lv => HR_CONDITIONS[lv - 1] || `condición ${lv}`,
        stepAction: st => `Condición: ${HR_CONDITIONS[st.level - 1] || st.level} (voluntario/a ${st.rep}). Registre la FC del sensor y de la referencia en el mismo instante (promedios de los mismos 10–15 s).`,
        models: ['lineal'], tolerance: 5, criterion: 'loa', range: [50, 150],
        guide: {
            objetivo: 'Evaluar la concordancia de la frecuencia cardiaca del sensor con una referencia (Bland–Altman). ANSI/AAMI EC13 admite ±10 % o ±5 lpm, el mayor.',
            principio: `${ETHICS}<div class="math">\\[ d = \\mathrm{FC}_\\text{sensor} - \\mathrm{FC}_\\text{ref} \\qquad \\mathrm{LA}_{95} = \\bar d \\pm 1{,}96\\,s_d \\]<p>Cumple si ambos límites están dentro de ± tolerancia.</p></div>
                <p>Incluya condiciones con FC distintas (reposo, tras ejercicio suave) para ver si el error cambia con la frecuencia (sesgo proporcional).</p>`,
            materiales: ['Referencia: banda de pecho o monitor ECG (ideal), oxímetro o conteo manual.', 'Voluntarios sanos.'],
            procedimiento: ['Sincronice: ambos equipos deben promediar la misma ventana de tiempo.', 'Recorra las condiciones del plan con distintos voluntarios (≥ 30 pares).', 'Tras el ejercicio registre rápido: la FC cambia segundo a segundo.'],
            checklist: ['Consentimiento', 'Ventana de promedio igual en ambos equipos', 'Sensor sin movimiento durante la lectura'],
            errores: ['<strong>Ventanas de tiempo distintas</strong> tras el ejercicio: diferencias que no son error del sensor.', '<strong>Armónicos</strong>: el algoritmo puede duplicar o dividir la FC con ruido.']
        },
        example: { refField: true, levelToRef: lv => [70, 80, 112, 96, 82][lv - 1] ?? 75, refJitter: 8, refDecimals: 0, bias: 0.6, sdDiff: 2.2, prop: 0.03, center: 85, forward: v => Math.round(v), decimals: 0 }
    });
})(typeof self !== 'undefined' ? self : this);
