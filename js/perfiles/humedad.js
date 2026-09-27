/* Perfiles: humedad relativa y presión barométrica */
(function (root) {
    'use strict';
    const req = n => (typeof require === 'function') ? require(n) : null;
    const R = req('./registry.js') || root.LabProfiles;
    const P = req('../core/physics.js') || root.LabPhys;

    // Nivel nominal de HR → sal saturada que lo produce
    const SALT_BY_LEVEL = [[11, 'LiCl'], [33, 'MgCl2'], [43, 'K2CO3'], [53, 'MgNO3'], [75, 'NaCl'], [85, 'KCl'], [97, 'K2SO4']];
    const saltFor = lv => SALT_BY_LEVEL.reduce((b, s) => Math.abs(s[0] - lv) < Math.abs(b[0] - lv) ? s : b)[1];

    R.register({
        id: 'hr', family: 'humedad', name: 'Humedad relativa', examples: 'DHT22, DHT11, SHT31, SHT4x, BME280, AHT20',
        quantity: 'Humedad relativa', unit: '%HR', symbol: 'HR', sameUnits: true,
        reading: { label: 'HR indicada', unit: '%HR' },
        references: [
            { id: 'sales', label: 'Soluciones salinas saturadas (Greenspan 1977)', u: 0, help: 'La HR se calcula desde la sal y la temperatura medida en la cámara.' },
            { id: 'higrometro', label: 'Higrómetro de referencia (misma cámara)', u: 1.0, help: 'u = incertidumbre del certificado / 2.' }
        ],
        computedRef: cfg => cfg.refType === 'sales',
        refFromRow: (row, cfg) => {
            if (cfg.refType !== 'sales') return { value: row.ref, u: 0 };
            const r = P.saltRH(saltFor(row.level), isFinite(row.temp) ? row.temp : cfg.env.temp);
            return { value: r.rh, u: r.u };
        },
        extraFields: [{ key: 'temp', label: 'Temperatura en la cámara', unit: '°C', optional: true, hint: 'si falta, usa la del ambiente' }],
        levelLabel: lv => `${P.SALTS[saltFor(lv)].name} (≈ ${lv} %HR)`,
        stepAction: (st, cfg) => cfg.refType === 'sales'
            ? `${P.SALTS[saltFor(st.level)].name}: sensor dentro del frasco hermético con la sal saturada (pasta húmeda con cristales). Espere ≥ 12 h a temperatura estable. Lectura ${st.rep} de ${cfg.reps} (cada 10 min). Anote la temperatura.`
            : `Cámara a ≈ ${st.level} %HR: espere el equilibrio (≥ 30 min) y registre sensor y higrómetro. Lectura ${st.rep} de ${cfg.reps}.`,
        refRes: 0, levels: [11, 33, 75, 97], cycles: 1, reps: 3, bidirectional: false,
        models: ['lineal', 'poly2'], defaultModel: 'lineal', tolerance: 3, range: [10, 95], timeResponse: true,
        guide: {
            objetivo: 'Medir el error del sensor de humedad con puntos de HR conocidos y, si hace falta, corregirlo. Es la calibración de humedad más exacta que se puede hacer sin equipos caros.',
            principio: `<div class="math">Sobre una solución salina SATURADA, en un recipiente cerrado, el aire llega a una HR fija
que depende solo de la sal y (poco) de la temperatura:

  LiCl ≈ 11 %   MgCl₂ ≈ 33 %   K₂CO₃ ≈ 43 %   NaCl ≈ 75 %   KCl ≈ 85 %   K₂SO₄ ≈ 97 %</div>
                <p>El sistema interpola la tabla de Greenspan (1977) con la temperatura que usted mida en la cámara. La sal de mesa (NaCl, 75 %) es la más fácil y estable.</p>`,
            materiales: [
                'Frascos herméticos (tipo mermelada) — uno por sal.',
                'Sales: NaCl (sal de mesa sin yodo), MgCl₂, LiCl, K₂SO₄ (tiendas de químicos o agrícolas).',
                'Agua destilada. Termómetro dentro del frasco o sensor con canal de temperatura.',
                'Soporte para que el sensor no toque la solución.'
            ],
            procedimiento: [
                'Prepare cada sal como una PASTA húmeda: cristales visibles sin disolver + un poco de agua. Debe quedar sal sin disolver siempre.',
                'Ponga el sensor dentro del frasco, sin tocar la pasta, y cierre (pase el cable por la tapa y selle con silicona o masilla).',
                'Espere al menos 12 h a temperatura estable (lejos de ventanas y del sol).',
                'Registre 3 lecturas separadas 10 min y la temperatura dentro del frasco.',
                'Repita con cada sal. Empiece por las HR bajas para evitar condensación en el sensor.'
            ],
            checklist: ['Frasco hermético (sin fugas en el paso del cable)', 'Sal sin disolver visible', 'Temperatura estable ±0,5 °C', 'Sensor sin contacto con la solución', 'Tolerancia definida (datasheet)'],
            errores: [
                '<strong>No esperar el equilibrio</strong>: la HR tarda horas en estabilizarse en el frasco.',
                '<strong>Solución no saturada</strong>: si toda la sal se disolvió la HR será mayor que la de la tabla.',
                '<strong>Gradientes de temperatura</strong>: 1 °C de diferencia entre sensor y sal cambia la HR ~6 %.',
                '<strong>Exposición a HR &gt; 95 %</strong>: algunos sensores quedan con desvío temporal tras saturarse (reacondicionar según datasheet).'
            ]
        },
        example: {
            extra: (st, g) => ({ temp: +(21 + g(0.3)).toFixed(1) }),
            forward: (h, cfg, row, g) => 1.025 * h - 1.8 + g(0.3), decimals: 1, tau: 8, stepFrom: 40, stepTo: 75, noise: 0.3
        }
    });

    R.register({
        id: 'baro', family: 'presion', name: 'Presión barométrica', examples: 'BMP280, BME280, BMP388, MS5611', mode: 'comparacion',
        quantity: 'Presión absoluta', unit: 'hPa', symbol: 'p', sameUnits: true,
        reading: { label: 'Presión indicada', unit: 'hPa' },
        references: [
            { id: 'estacion', label: 'Barómetro de referencia al lado del sensor (presión de estación)', u: 0.3 },
            { id: 'qnh', label: 'Presión a nivel del mar (QNH) de la DMC / aeropuerto cercano', u: 0.5, help: 'Se convierte a la altitud del sensor. Ingrese la altitud con precisión (1 m ≈ 0,12 hPa).' }
        ],
        refFromRow: (row, cfg) => cfg.refType === 'qnh'
            ? { value: row.ref * (1 - 2.25577e-5 * cfg.env.alt) ** 5.25588, u: 0.12 * (cfg.params.uAlt || 0) }
            : { value: row.ref, u: 0 },
        params: [{ key: 'uAlt', label: 'Incertidumbre de la altitud del sensor', unit: 'm', default: 3 }],
        levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], cycles: 1, reps: 1, refRes: 0.1,
        levelLabel: lv => `registro ${lv}`,
        stepAction: (st, cfg) => `Registro ${st.level}: anote la presión del sensor y, en el mismo minuto, la de referencia${cfg.refType === 'qnh' ? ' (QNH publicado)' : ''}. Separe los registros por horas o días para cubrir distintas presiones.`,
        models: ['lineal'], tolerance: 1, range: [980, 1030], criterion: 'loa',
        guide: {
            objetivo: 'Estimar el sesgo del barómetro (casi todo su error) comparándolo con una referencia en distintos días.',
            principio: `<div class="math">Presión de estación (a la altitud h del sensor) a partir del QNH (nivel del mar):
  p = QNH · (1 − 2,25577×10⁻⁵ · h)^5,25588          1 m de altura ≈ 0,12 hPa</div>
                <p>La presión no se puede fijar a voluntad, así que se compara sensor y referencia en distintos momentos (análisis de Bland–Altman).
                   El QNH de la DMC está reducido al nivel del mar: sin la conversión, el "error" sería la altitud.</p>`,
            materiales: ['Sensor en interior, lejos de corrientes de aire y del sol.', 'Referencia: barómetro calibrado o QNH de la estación meteorológica más cercana (DMC).', 'Altitud del sensor (GPS/mapa topográfico + piso del edificio).'],
            procedimiento: ['Ingrese la altitud del sensor en la Preparación.', 'Registre pares sensor–referencia en al menos 10 momentos distintos (días con buen y mal tiempo).', 'Revise el sesgo: normalmente basta un offset constante como corrección.'],
            checklist: ['Altitud del sensor conocida (±3 m)', 'Sensor protegido de viento y sol', 'Hora de la referencia coincide con la del sensor'],
            errores: ['<strong>Comparar con QNH sin convertir</strong>: en Valdivia (~15 m) introduce ~2 hPa de "error".', '<strong>Autocalentamiento</strong> del BME280 por lecturas muy frecuentes: use modo forzado.']
        },
        example: { refField: true, levelToRef: lv => 1005 + 12 * Math.sin(lv), refJitter: 0, bias: 0.9, sdDiff: 0.25, forward: v => v, decimals: 2 }
    });
})(typeof self !== 'undefined' ? self : this);
