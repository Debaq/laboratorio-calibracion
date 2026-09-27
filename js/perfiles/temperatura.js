/* Perfiles: temperatura */
(function (root) {
    'use strict';
    const req = n => (typeof require === 'function') ? require(n) : null;
    const R = req('./registry.js') || root.LabProfiles;
    const P = req('../core/physics.js') || root.LabPhys;

    // Referencias comunes a todos los termómetros
    const REFS = [
        { id: 'bano', label: 'Baño de agua agitado + termómetro de referencia', u: 0.1, help: 'u = incertidumbre del termómetro de referencia (certificado / 2) combinada con la uniformidad del baño.' },
        { id: 'hielo', label: 'Punto de hielo (hielo picado + agua)', u: 0.02, help: 'Bien hecho, el punto de hielo es 0,00 °C con u ≈ 0,02 °C. Es la mejor referencia barata.' },
        { id: 'fijos', label: 'Puntos fijos: hielo y ebullición', u: 0.1, help: 'La ebullición depende de la presión: ingrese el valor calculado en la guía.' }
    ];

    const TEMP_GUIDE_COMMON = {
        materiales: [
            'Termómetro de referencia calibrado (digital de sonda, resolución 0,1 °C o mejor) — o solo punto de hielo si no hay.',
            'Recipiente aislado (termo) con agua; hielo picado de agua destilada para el punto de hielo.',
            'Hervidor o placa calefactora; agitador (cuchara / agitador magnético).',
            'Funda o bolsa delgada si el sensor no es sumergible (protege la electrónica, agrega retardo).'
        ],
        checklist: [
            'Sensor y referencia amarrados juntos (a menos de 1 cm), a la misma profundidad',
            'Agua agitada durante toda la lectura',
            'Electrónica fuera del agua; cables sin tensión',
            'Presión atmosférica anotada (si usa el punto de ebullición)',
            'Tolerancia definida (datasheet o requisito del uso)'
        ],
        errores: [
            '<strong>No esperar el equilibrio</strong>: el sensor y la referencia tienen distinto tiempo de respuesta. Espere a que ambos cambien menos de 0,1 °C en 30 s.',
            '<strong>Punto de hielo mal hecho</strong>: con cubos grandes y poca agua, el hielo puede estar bajo 0 °C. Use hielo picado, agua hasta el borde y agite.',
            '<strong>Ebullición = 100 °C</strong>: solo a 1013 hPa. En Valdivia (~1000 hPa) hierve a ≈ 99,6 °C.',
            '<strong>Autocalentamiento</strong>: NTC y PT100 se calientan con la corriente de medición. Use divisores de alta resistencia o corriente baja.'
        ]
    };

    const boilingNote = cfg => `En la ebullición use T = ${P.boilingPoint(cfg.env.p_hPa).toFixed(2)} °C (presión ${cfg.env.p_hPa} hPa), no 100 °C.`;
    const tempStep = unit => (st, cfg) => {
        const lv = st.level;
        const how = lv <= 0.5 ? 'Prepare el PUNTO DE HIELO (hielo picado + agua, agite 2 min)'
            : lv >= 95 ? `Lleve el agua a EBULLICIÓN. ${boilingNote(cfg)}`
                : `Lleve el baño a ≈ ${lv} °C (mezcle agua fría/caliente) y agite`;
        return `Ciclo ${st.cycle} ${st.dir === 'baja' ? '↓' : '↑'}: ${how}. Espere el equilibrio (< 0,1 °C en 30 s). Registre la referencia y la lectura en ${unit}.${cfg.reps > 1 ? ` Lectura ${st.rep} de ${cfg.reps}.` : ''}`;
    };

    // Termistor NTC 10 k típico (coeficientes Steinhart–Hart) para el ejemplo
    const SH = { a: 1.009249522e-3, b: 2.378405444e-4, c: 2.019202697e-7 };
    const ntcR = T => Math.exp(R.invert(L => 1 / (SH.a + SH.b * L + SH.c * L ** 3) - 273.15, T, 3, 15));

    R.register({
        id: 'ntc', family: 'temperatura', name: 'Termistor NTC', examples: 'NTC 10 kΩ (B 3950), sondas de acero con NTC',
        quantity: 'Temperatura', unit: '°C', symbol: 'T',
        reading: { label: 'Resistencia', unit: 'Ω' },
        readingModes: [{ id: 'ohm', label: 'Resistencia medida (Ω)', unit: 'Ω' }, R.modes.adcDivider(10, 10000)],
        references: REFS, refRes: 0.1,
        levels: [0, 20, 40, 60, 80], cycles: 2, reps: 1, bidirectional: true,
        models: ['steinhart', 'beta', 'poly3'], defaultModel: 'steinhart',
        tolerance: 0.5, range: [0, 80], timeResponse: true,
        settle: 'Espere el equilibrio.', stepAction: tempStep('Ω'),
        extraMetrics: (fit) => {
            if (fit.id !== 'beta' && fit.id !== 'steinhart') return [];
            const T25 = 298.15, c = fit.coef;
            const R25 = fit.id === 'beta' ? Math.exp((1 / T25 - c[0]) / c[1]) : Math.exp(R.invert(L => c[0] + c[1] * L + c[2] * L ** 3, 1 / T25, 3, 15));
            const out = [{ label: 'R a 25 °C', value: `${(R25 / 1000).toFixed(3)} kΩ`, sub: 'resistencia nominal real' }];
            if (fit.id === 'beta') out.push({ label: 'Coeficiente B', value: `${(1 / c[1]).toFixed(0)} K`, sub: 'datasheet típico 3435–3950 K' });
            return out;
        },
        guide: {
            objetivo: 'Obtener la curva R → T del termistor. Un NTC es muy sensible (≈ −4 %/°C) pero NO lineal: la ecuación correcta es la de Steinhart–Hart.',
            principio: `<div class="math">\\[ \\text{Steinhart–Hart:}\\quad \\frac{1}{T} = A + B\\ln R + C\\,(\\ln R)^{3} \\qquad (T\\ \\text{en kelvin}) \\]\\[ \\text{Beta:}\\quad \\frac{1}{T} = \\frac{1}{T_0} + \\frac{1}{\\beta}\\ln\\frac{R}{R_0} \\qquad \\text{(2 parámetros, menos exacto)} \\]\\[ \\text{Divisor (sensor abajo):}\\quad R = R_\\text{fija}\\,\\frac{N}{N_\\text{máx} - N} \\]</div>
                <p>Con 3 temperaturas bien distribuidas Steinhart–Hart da ±0,02 °C en 0–80 °C; el modelo Beta suele desviarse 0,3–1 °C en los extremos.
                   El sistema ajusta ambos y los compara por AICc.</p>`,
            procedimiento: [
                'Mida la resistencia fija del divisor con multímetro y anote la resolución y Vref del ADC (si lee por ADC).',
                'Amarre el NTC a la sonda de referencia. Sumerja ambos a la misma profundidad.',
                'Siga el plan: punto de hielo → baño tibio → baño caliente → ebullición y de vuelta (histéresis).',
                'En cada punto agite, espere el equilibrio y registre referencia y lectura.',
                'Opcional: mida la constante de tiempo pasando el sensor del aire al punto de hielo (pestaña Tiempo de respuesta).'
            ],
            ...TEMP_GUIDE_COMMON
        },
        example: { forward: (T, cfg, row, g) => ntcR(T) * (1 + g(0.0008)), refJitter: 0.4, decimals: 0, tau: 6, stepFrom: 20, stepTo: 0, noise: 20 }
    });

    R.register({
        id: 'lm35', family: 'temperatura', name: 'LM35 / TMP36 (salida analógica)', examples: 'LM35 (10 mV/°C), TMP36 (10 mV/°C + 500 mV), LM335',
        quantity: 'Temperatura', unit: '°C', symbol: 'T',
        reading: { label: 'Tensión de salida', unit: 'mV' },
        readingModes: [{ id: 'mv', label: 'Tensión medida con multímetro (mV)', unit: 'mV' },
            { ...R.modes.adcVolt(10, 5), xUnit: 'mV', toX: (c, p) => 1000 * c * p.vref / (2 ** p.bits - 1) }],
        references: REFS, refRes: 0.1,
        levels: [0, 20, 40, 60, 80], cycles: 2, reps: 1, bidirectional: true,
        models: ['lineal', 'poly2'], defaultModel: 'lineal', tolerance: 1, range: [0, 80], timeResponse: true,
        stepAction: tempStep('mV'),
        extraMetrics: fit => fit.id === 'lineal' ? [
            { label: 'Sensibilidad', value: `${(1 / fit.coef[1]).toFixed(3)} mV/°C`, sub: 'LM35/TMP36 nominal: 10,000' },
            { label: 'Salida a 0 °C', value: `${(-fit.coef[0] / fit.coef[1]).toFixed(1)} mV`, sub: 'LM35: 0 · TMP36: 500' }] : [],
        guide: {
            objetivo: 'Verificar la sensibilidad (mV/°C) y el offset del sensor, incluyendo el error que agrega el ADC de la placa.',
            principio: `<div class="math">\\[ \\text{LM35: } V = 10\\ \\tfrac{\\mathrm{mV}}{^\\circ\\mathrm{C}}\\;T \\qquad \\text{TMP36: } V = 500\\ \\mathrm{mV} + 10\\ \\tfrac{\\mathrm{mV}}{^\\circ\\mathrm{C}}\\;T \\]\\[ \\text{Con ADC: } V = N\\,\\frac{V_\\text{ref}}{2^{n} - 1} \\]<p>El error de \\(V_\\text{ref}\\) es un error de ganancia.</p></div>
                <p>El ADC de 10 bits a 5 V tiene un paso de 4,9 mV = 0,49 °C: la resolución de la placa suele ser peor que el sensor.
                   Use la referencia interna de 1,1 V (<code>analogReference(INTERNAL)</code>) para bajar el paso a 0,1 °C.</p>`,
            procedimiento: [
                'Proteja el sensor del agua (termocontraíble o funda) y amárrelo a la sonda de referencia.',
                'Si lee por ADC, mida Vref con multímetro e ingrésela en la Preparación.',
                'Siga el plan de temperaturas subiendo y bajando.',
                'Compare la sensibilidad obtenida con la del datasheet.'
            ],
            ...TEMP_GUIDE_COMMON
        },
        example: { forward: (T, cfg, row, g) => 10.08 * T + 3 + g(0.4), refJitter: 0.4, decimals: 1, tau: 12, stepFrom: 20, stepTo: 0, noise: 1 }
    });

    const digitalTemp = (id, name, examples, tol, bias, gain, q, tau) => R.register({
        id, family: 'temperatura', name, examples,
        quantity: 'Temperatura', unit: '°C', symbol: 'T', sameUnits: true,
        reading: { label: 'Temperatura indicada', unit: '°C' },
        references: REFS, refRes: 0.1,
        levels: id === 'termocupla' ? [0, 25, 50, 75, 99] : [0, 20, 40, 60, 80], cycles: 2, reps: 1, bidirectional: true,
        models: ['lineal', 'poly2'], defaultModel: 'lineal', tolerance: tol, range: [0, 80], timeResponse: true,
        stepAction: tempStep('°C'),
        guide: {
            objetivo: `Medir el error del sensor (sesgo y máximo) contra la referencia y compararlo con la exactitud del fabricante (±${tol} °C). Si no cumple, obtener una corrección lineal.`,
            principio: `<div class="math">\\[ \\text{error} = T_\\text{sensor} - T_\\text{ref} \\qquad \\text{corrección: } T = c_0 + c_1\\,T_\\text{sensor} \\]</div>
                <p>Los sensores digitales ya entregan °C: lo que se calibra es su error. La mayoría tiene un sesgo casi constante que una corrección de offset elimina.</p>`,
            procedimiento: [
                'Amarre el sensor a la sonda de referencia (a menos de 1 cm).',
                'Configure la máxima resolución del sensor (p. ej. DS18B20 a 12 bits = 0,0625 °C).',
                'Siga el plan de temperaturas subiendo y bajando.',
                'Revise el error sin corregir: si cumple la especificación, no necesita ecuación.'
            ],
            ...TEMP_GUIDE_COMMON
        },
        example: { forward: (T, cfg, row, g) => Math.round((bias + gain * T + g(q)) / q) * q, refJitter: 0.4, decimals: 4, tau, stepFrom: 20, stepTo: 0, noise: q }
    });
    digitalTemp('ds18b20', 'DS18B20 (digital 1-Wire)', 'DS18B20, sondas sumergibles DS18B20', 0.5, 0.15, 1.002, 0.0625, 8);
    digitalTemp('termocupla', 'Termocupla K + MAX31855 / MAX6675', 'Termocupla tipo K con MAX31855 o MAX6675', 2, 0.9, 1.006, 0.25, 2);
    digitalTemp('temp-ambiental', 'Temperatura de sensores ambientales', 'DHT22, SHT31, BME280, AHT20 (canal de temperatura)', 0.5, 0.35, 1, 0.1, 25);

    R.register({
        id: 'pt100', family: 'temperatura', name: 'PT100 / PT1000 (RTD)', examples: 'PT100 o PT1000 con MAX31865',
        quantity: 'Temperatura', unit: '°C', symbol: 'T',
        reading: { label: 'Resistencia', unit: 'Ω' },
        readingModes: [{ id: 'ohm', label: 'Resistencia (Ω) — MAX31865 o multímetro 4 hilos', unit: 'Ω' }],
        references: REFS, refRes: 0.1,
        levels: [0, 25, 50, 75, 99], cycles: 2, reps: 1, bidirectional: true,
        models: ['poly2', 'lineal'], defaultModel: 'poly2', tolerance: 0.3, range: [0, 100], timeResponse: true,
        stepAction: tempStep('Ω'),
        extraMetrics: fit => {
            const f = T => { let lo = 0, hi = 1e5; for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (fit.predict(m) < T) lo = m; else hi = m; } return lo; };
            const R0 = f(0), R100 = f(100), alpha = (R100 - R0) / (100 * R0);
            return [{ label: 'R₀ (0 °C)', value: `${R0.toFixed(3)} Ω`, sub: 'PT100: 100,000 · PT1000: 1000,00' },
                { label: 'α', value: `${(alpha * 1000).toFixed(4)} ×10⁻³/°C`, sub: 'IEC 60751: 3,8500' }];
        },
        guide: {
            objetivo: 'Obtener la curva R → T del RTD y verificar R₀ y α contra la norma IEC 60751.',
            principio: `<div class="math">\\[ R = R_0\\,(1 + A\\,T + B\\,T^{2}) \\qquad (T \\ge 0\\ ^\\circ\\mathrm{C},\\ \\text{Callendar–Van Dusen}) \\]\\[ A = 3{,}9083\\times10^{-3}\\ ^\\circ\\mathrm{C}^{-1} \\quad B = -5{,}775\\times10^{-7}\\ ^\\circ\\mathrm{C}^{-2} \\quad \\alpha = \\frac{R_{100} - R_0}{100\\,R_0} = 0{,}00385 \\]</div>
                <p>En el sentido de uso se ajusta T = c₀ + c₁·R + c₂·R². Clase B admite ±(0,3 + 0,005·|T|) °C.</p>`,
            procedimiento: [
                'Use conexión de 3 o 4 hilos: con 2 hilos la resistencia de los cables (~0,4 Ω = 1 °C) se suma como error.',
                'Configure el MAX31865 con la resistencia de referencia real de su módulo (430 Ω para PT100).',
                'Siga el plan hasta la ebullición.'
            ],
            ...TEMP_GUIDE_COMMON
        },
        example: { forward: (T, cfg, row, g) => 100.05 * (1 + 3.9083e-3 * T - 5.775e-7 * T * T) + g(0.008), refJitter: 0.4, decimals: 3, tau: 4, stepFrom: 20, stepTo: 0, noise: 0.01 }
    });
})(typeof self !== 'undefined' ? self : this);
