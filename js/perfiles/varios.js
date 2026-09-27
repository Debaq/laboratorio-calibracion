/* Perfiles: luz, ángulo, química, suelo y caudal */
(function (root) {
    'use strict';
    const req = n => (typeof require === 'function') ? require(n) : null;
    const R = req('./registry.js') || root.LabProfiles;
    const P = req('../core/physics.js') || root.LabPhys;

    // ---------------- Luz ----------------
    const LUX = [{ id: 'luxometro', label: 'Luxómetro de referencia', u: 5, help: 'Los luxómetros comunes tienen ±(3–5 %) : use u ≈ 3 % del valor típico.' }];
    const LUX_COMMON = {
        materiales: ['Luxómetro de referencia con el sensor lo más cerca posible (misma posición y orientación).', 'Lámpara regulable o distintas distancias a una lámpara fija, en una sala oscura.'],
        checklist: ['Sensor y luxómetro en el mismo plano, a la misma altura', 'Sin sombras ni reflejos distintos sobre cada uno', 'Fuente de luz estable (sin parpadeo)'],
        errores: ['<strong>Distinto tipo de luz</strong>: la respuesta espectral del sensor no es la del ojo; calibre con la misma luz (LED, sol) que usará.', '<strong>Ángulos distintos</strong>: 10 cm de separación con luz lateral cambian mucho la lectura.']
    };
    R.register({
        id: 'ldr', family: 'luz', name: 'Fotorresistencia (LDR)', examples: 'GL5528, GL5539',
        quantity: 'Iluminancia', unit: 'lx', symbol: 'E',
        reading: { label: 'Resistencia', unit: 'Ω' },
        readingModes: [{ id: 'ohm', label: 'Resistencia (Ω)', unit: 'Ω' }, R.modes.adcDivider(10, 10000)],
        references: LUX, refRes: 1,
        levels: [10, 30, 100, 300, 1000], cycles: 2, reps: 1, bidirectional: true,
        models: ['potencia', 'log', 'poly2'], defaultModel: 'potencia', tolerance: 30, range: [10, 1000],
        settle: 'Espere 10 s (el LDR es lento, sobre todo al pasar de luz a oscuridad).',
        guide: {
            objetivo: 'Obtener la curva R → iluminancia del LDR, que sigue una ley de potencia, y ver su histéresis (memoria de la luz previa).',
            principio: '<div class="math">R ≈ R₁₀ · (E/10 lx)^(−γ)      (γ ≈ 0,6–0,9)      →   E = e^c₀ · R^c₁</div><p>En escala log–log es una recta. El LDR es sensible a la temperatura y responde en decenas de ms a segundos.</p>',
            procedimiento: ['Oscurezca la sala; ubique LDR y luxómetro juntos frente a la lámpara.', 'Recorra los niveles del plan subiendo y bajando la luz.', 'Registre lux de referencia y resistencia/cuentas.'],
            ...LUX_COMMON
        },
        example: { refJitter: 0, decimals: 0, levelToRef: lv => lv, forward: (e, cfg, row, g) => 62000 * Math.pow(e, -0.72) * (1 + g(0.02)) }
    });
    R.register({
        id: 'bh1750', family: 'luz', name: 'Sensor de luz digital', examples: 'BH1750, TSL2561, VEML7700',
        quantity: 'Iluminancia', unit: 'lx', symbol: 'E', sameUnits: true,
        reading: { label: 'Iluminancia indicada', unit: 'lx' },
        references: LUX, refRes: 1,
        levels: [10, 50, 100, 300, 1000], cycles: 2, reps: 1, bidirectional: false,
        models: ['lineal', 'proporcional'], defaultModel: 'lineal', tolerance: 30, range: [10, 1000],
        guide: {
            objetivo: 'Medir el error de escala del sensor digital. El BH1750 declara una “exactitud de medición” de 1,2 ±20 %: la corrección de ganancia es casi siempre necesaria.',
            principio: '<div class="math">E_real = c₀ + c₁ · E_sensor       (c₁ ≈ 1 si el factor 1,2 del BH1750 es correcto para su luz)</div>',
            procedimiento: ['Ubique sensor y luxómetro juntos.', 'Recorra los niveles del plan.', 'Use c₁ como factor de corrección en el firmware.'],
            ...LUX_COMMON
        },
        example: { refJitter: 0, decimals: 1, levelToRef: lv => lv, forward: (e, cfg, row, g) => 1.09 * e + 1.5 + g(0.5 + 0.01 * e) }
    });

    // ---------------- Ángulo ----------------
    const GONIO = [{ id: 'goniometro', label: 'Goniómetro / transportador fijo', u: 0.3, help: 'Transportador de 1°: u ≈ 0,3°. Para más exactitud use el módulo IMU (referencia por seno).' }];
    R.register({
        id: 'potenciometro', family: 'movimiento', name: 'Potenciómetro / encoder angular', examples: 'Potenciómetro rotatorio 10 k, AS5600 (magnético), encoder absoluto',
        quantity: 'Ángulo', unit: '°', symbol: 'θ',
        reading: { label: 'Cuentas del ADC', unit: 'cuentas' },
        references: GONIO, refRes: 1,
        levels: [-120, -90, -45, 0, 45, 90, 120], cycles: 2, reps: 1, bidirectional: true,
        models: ['lineal', 'poly2', 'poly3'], defaultModel: 'lineal', tolerance: 1.5, range: [-135, 135],
        settle: 'Promedie 16 lecturas.',
        guide: {
            objetivo: 'Obtener la relación cuentas → ángulo de un potenciómetro usado como goniómetro electrónico (articulaciones, pedales, palancas).',
            principio: '<div class="math">θ = c₀ + c₁ · N       (pistas lineales; los potenciómetros "de audio" son logarítmicos)</div><p>La no linealidad de la pista (±1–3 %) y el juego mecánico del eje se ven en los residuos y la histéresis.</p>',
            materiales: ['Transportador o goniómetro fijo al eje.', 'Indicador (aguja) solidario al eje.', 'Firmware que promedie lecturas ADC.'],
            procedimiento: ['Alinee el cero del transportador con la posición neutra.', 'Lleve el eje a cada ángulo del plan sin pasarse; registre.', 'Suba y baje (el juego mecánico aparece como histéresis).'],
            checklist: ['Eje sin juego respecto del transportador', 'Tensión de alimentación del potenciómetro = Vref del ADC'],
            errores: ['<strong>Potenciómetro logarítmico</strong>: curva fuertemente no lineal.', '<strong>Alimentar con 5 V y leer con Vref distinta</strong>: error de ganancia.']
        },
        example: { refJitter: 0, decimals: 0, levelToRef: lv => lv, forward: (a, cfg, row, g) => 511.5 + 3.79 * a + 0.0015 * a * a + g(0.8), hyst: 0.6 }
    });
    R.register({
        id: 'flex', family: 'movimiento', name: 'Sensor de flexión', examples: 'Flex sensor 2,2" y 4,5" (Spectra Symbol), sensores de guante',
        quantity: 'Ángulo de flexión', unit: '°', symbol: 'θ',
        reading: { label: 'Resistencia', unit: 'Ω' },
        readingModes: [{ id: 'ohm', label: 'Resistencia (Ω)', unit: 'Ω' }, R.modes.adcDivider(10, 47000)],
        references: GONIO, refRes: 1,
        levels: [0, 15, 30, 45, 60, 90], cycles: 3, reps: 1, bidirectional: true,
        models: ['poly2', 'lineal', 'poly3'], defaultModel: 'poly2', tolerance: 5, range: [0, 90],
        extraWarnings: () => ['El sensor de flexión mide curvatura, no ángulo: la lectura depende del radio de curvatura y de dónde se dobla. Calibre montado igual que en el uso (dedo, articulación).'],
        guide: {
            objetivo: 'Obtener la curva resistencia → ángulo del sensor de flexión montado como en su uso, y cuantificar su gran histéresis.',
            principio: '<div class="math">R = R₀ + a·θ + b·θ²      (aproximadamente; depende del radio de curvatura)</div>',
            materiales: ['Bisagra o articulación de prueba con transportador.', 'Sensor fijado en un solo extremo y guiado (debe poder deslizar).'],
            procedimiento: ['Monte el sensor sobre la bisagra como irá en el uso final.', 'Recorra los ángulos subiendo y bajando; registre a los 3 s.', 'Repita 3 ciclos.'],
            checklist: ['Sensor fijo en un extremo, libre en el otro', 'Mismo radio de curvatura que en el uso'],
            errores: ['<strong>Sensor fijo en ambos extremos</strong>: se estira y cambia la curva.', '<strong>Doblar en el conector</strong>: daña el sensor.']
        },
        example: { refJitter: 0, decimals: 0, levelToRef: lv => lv, forward: (a, cfg, row, g) => 25000 + 170 * a + 0.5 * a * a + g(120), hyst: 3 }
    });

    // ---------------- Química ----------------
    R.register({
        id: 'ph', family: 'humedad', name: 'Electrodo de pH', examples: 'Electrodo de vidrio con módulo PH-4502C, Atlas Scientific, ADS1115',
        quantity: 'pH', unit: 'pH', symbol: 'pH',
        reading: { label: 'Potencial del electrodo', unit: 'mV' },
        readingModes: [{ id: 'mv', label: 'Potencial del electrodo (mV) — medidor de alta impedancia', unit: 'mV' },
            { ...R.modes.adcVolt(10, 5), label: 'Salida del módulo amplificador (cuentas ADC)' }],
        references: [{ id: 'buffer', label: 'Soluciones tampón (buffer) certificadas', u: 0.01, help: 'Ingrese el pH del buffer A SU TEMPERATURA (tabla de la etiqueta).' }],
        refRes: 0.01,
        levels: [4, 7, 10], cycles: 2, reps: 3, bidirectional: false,
        extraFields: [{ key: 'temp', label: 'Temperatura del buffer', unit: '°C' }],
        levelLabel: lv => `buffer pH ${lv}`,
        stepAction: (st, cfg) => `Ciclo ${st.cycle}: enjuague el electrodo con agua destilada, séquelo con papel SIN frotar y sumérjalo en el buffer pH ${st.level}. Agite suave, espere 1–2 min a que se estabilice. Lectura ${st.rep} de ${cfg.reps}. Registre el pH del buffer a su temperatura.`,
        models: ['lineal'], defaultModel: 'lineal', tolerance: 0.1, range: [4, 10],
        extraMetrics: (fit, pts, cfg) => {
            if (cfg.readingMode !== 'mv') return [{ label: 'Pendiente', value: `${(1 / fit.coef[1]).toFixed(4)} V/pH`, sub: 'salida amplificada: no comparable con Nernst' }];
            const T = pts.map(p => p.temp).filter(isFinite);
            const Tm = T.length ? T.reduce((a, b) => a + b) / T.length : cfg.env.temp;
            const slope = 1 / fit.coef[1], nernst = P.nernstSlope(Tm);
            return [
                { label: 'Pendiente', value: `${slope.toFixed(2)} mV/pH`, sub: `Nernst a ${Tm.toFixed(1)} °C: ${nernst.toFixed(2)}` },
                { label: 'Eficiencia', value: `${(100 * slope / nernst).toFixed(1)} %`, sub: 'aceptable 95–102 %' },
                { label: 'Offset (E a pH 7)', value: `${((7 - fit.coef[0]) / fit.coef[1]).toFixed(1)} mV`, sub: 'aceptable ±30 mV' }
            ];
        },
        extraWarnings: (fit, pts, cfg) => {
            if (cfg.readingMode !== 'mv') return [];
            const T = pts.map(p => p.temp).filter(isFinite);
            const eff = 100 * (1 / fit.coef[1]) / P.nernstSlope(T.length ? T.reduce((a, b) => a + b) / T.length : cfg.env.temp);
            const off = (7 - fit.coef[0]) / fit.coef[1];
            const w = [];
            if (eff < 95 || eff > 102) w.push(`Eficiencia de ${eff.toFixed(1)} %: electrodo sucio, gastado o buffers contaminados. Limpie o reemplace.`);
            if (Math.abs(off) > 30) w.push(`Offset de ${off.toFixed(0)} mV: unión de referencia contaminada o electrodo deshidratado.`);
            return w;
        },
        guide: {
            objetivo: 'Calibrar el electrodo de pH con buffers y evaluar su estado mediante la pendiente (eficiencia de Nernst) y el offset.',
            principio: `<div class="math">Ecuación de Nernst:  E = E₀ + S·(pH − 7)      S = −0,19842·(T + 273,15) mV/pH
25 °C → −59,16 mV/pH       Eficiencia = S_medida / S_Nernst  (95–102 % = electrodo sano)</div>
                <p>El electrodo tiene impedancia de ~100 MΩ: un multímetro común (10 MΩ) NO sirve para medir su potencial; use un módulo con amplificador o un ADS1115 con buffer.</p>`,
            materiales: ['Buffers pH 4, 7 y 10 frescos (no reutilice el buffer).', 'Agua destilada, vasos limpios, papel absorbente.', 'Termómetro.'],
            procedimiento: ['Hidrate el electrodo según el fabricante (solución de KCl).', 'Siga el plan: enjuague entre buffers, lecturas estables, 3 por buffer.', 'Anote la temperatura y el pH del buffer a esa temperatura (etiqueta).', 'Revise pendiente y offset: indican si el electrodo está sano.'],
            checklist: ['Buffers vigentes y sin contaminar', 'Electrodo hidratado', 'Enjuague entre soluciones', 'Temperatura anotada'],
            errores: ['<strong>No enjuagar</strong>: arrastra buffer de un vaso a otro.', '<strong>Frotar el bulbo</strong>: carga estática, lecturas inestables.', '<strong>Ignorar la temperatura</strong>: la pendiente cambia 0,2 mV/pH por °C.']
        },
        example: { extra: (st, g) => ({ temp: +(20 + g(0.3)).toFixed(1) }), refField: true, levelToRef: lv => ({ 4: 4.00, 7: 7.02, 10: 10.06 })[lv] ?? lv, decimals: 1, forward: (ph, cfg, row, g) => 6 + P.nernstSlope(row.temp) * 0.975 * (ph - 7) + g(0.8) }
    });

    // ---------------- Suelo ----------------
    R.register({
        id: 'suelo', family: 'humedad', name: 'Humedad de suelo capacitivo', examples: 'Sensor capacitivo v1.2/v2.0, EC-5, Teros',
        quantity: 'Contenido volumétrico de agua', unit: '%', symbol: 'θv',
        reading: { label: 'Cuentas del ADC', unit: 'cuentas' },
        references: [{ id: 'gravimetrico', label: 'Método gravimétrico (secado en horno)', u: 1, help: 'u incluye la variabilidad del suelo entre la zona del sensor y la muestra.' }],
        computedRef: () => true,
        refFromRow: (row, cfg) => {
            const w = (row.mh - row.ms) / row.ms;
            return { value: 100 * w * cfg.params.rhoB, u: 0 };
        },
        extraFields: [{ key: 'mh', label: 'Masa húmeda de la muestra', unit: 'g' }, { key: 'ms', label: 'Masa seca (tras horno)', unit: 'g' }],
        params: [{ key: 'rhoB', label: 'Densidad aparente del suelo', unit: 'g/cm³', default: 1.3, help: 'Masa seca / volumen del cilindro de muestreo. Arena ~1,6, franco ~1,3, orgánico ~0,9.' }],
        refRes: 0,
        levels: [5, 10, 20, 30, 40], cycles: 1, reps: 3, bidirectional: false,
        levelLabel: lv => `≈ ${lv} % de agua`,
        stepAction: (st, cfg) => `Muestra ≈ ${st.level} %: mezcle el suelo con agua pesada, compacte como en terreno, inserte el sensor hasta la marca y registre (inserción ${st.rep} de ${cfg.reps}). Luego tome una muestra con cilindro junto al sensor, pésela húmeda y, tras 24 h a 105 °C, seca.`,
        models: ['poly2', 'lineal', 'poly3'], defaultModel: 'poly2', tolerance: 3, range: [5, 45],
        guide: {
            objetivo: 'Obtener la curva cuentas → contenido de agua para SU suelo. La curva de fábrica (si existe) solo vale para un suelo estándar.',
            principio: `<div class="math">Contenido gravimétrico:  w  = (m_húmeda − m_seca) / m_seca
Contenido volumétrico:   θv = w · ρ_aparente / ρ_agua      (en %)</div>
                <p>El sensor capacitivo mide la permitividad del suelo, que depende del agua, pero también de la textura, la sal y la compactación.</p>`,
            materiales: ['Suelo del sitio de uso, tamizado y secado al aire.', 'Balanza (0,1 g), cilindro de volumen conocido, horno a 105 °C (o microondas con cuidado).', 'Recipientes rotulados.'],
            procedimiento: ['Prepare 5 porciones con cantidades crecientes de agua; mezcle y deje reposar 1 h tapadas.', 'Compacte cada porción en un recipiente de forma parecida al terreno.', 'Inserte el sensor 3 veces en distintos lugares (repeticiones).', 'Tome muestras con el cilindro, pese húmedas, seque y pese secas.'],
            checklist: ['Sensor con la electrónica sellada (barniz o termocontraíble)', 'Inserción siempre hasta la misma marca', 'Muestras rotuladas y pesadas antes de secar'],
            errores: ['<strong>Aire alrededor del sensor</strong>: lecturas de suelo más seco.', '<strong>Suelo salino</strong>: cambia la curva.', '<strong>Usar la fórmula de mapeo 0–100 % de los ejemplos de internet</strong>: no es contenido de agua.']
        },
        example: {
            extra: (st, g) => { const th = st.level + g(1); const ms = 150 + g(5); return { ms: +ms.toFixed(1), mh: +(ms * (1 + th / 100 / 1.3)).toFixed(1) }; },
            decimals: 0, forward: (th, cfg, row, g) => 3100 - 42 * th + 0.35 * th * th + g(12)
        }
    });

    // ---------------- Caudal ----------------
    R.register({
        id: 'yfs201', family: 'presion', name: 'Caudalímetro de turbina (pulsos)', examples: 'YF-S201, YF-S401, FS300A',
        quantity: 'Volumen', unit: 'L', symbol: 'V',
        reading: { label: 'Pulsos contados', unit: 'pulsos' },
        references: [{ id: 'probeta', label: 'Volumen medido en probeta / balanza (1 g ≈ 1 mL)', u: 0.005, help: 'Con balanza: V = masa/ρ_agua. Es más exacto que la probeta.' }],
        refRes: 0.01,
        extraFields: [{ key: 'time_s', label: 'Tiempo de recolección', unit: 's' }],
        levels: [1, 2, 3, 4, 5], cycles: 1, reps: 3, bidirectional: false,
        levelLabel: lv => `válvula en posición ${lv}`,
        stepAction: (st, cfg) => `Válvula en posición ${st.level}: ponga el contador de pulsos en cero, recolecte ≈ 1 L en un recipiente tarado y cronometre. Registre pulsos, volumen y tiempo (repetición ${st.rep} de ${cfg.reps}).`,
        models: ['proporcional'], defaultModel: 'proporcional', tolerance: 0.03,
        extraMetrics: (fit, pts) => {
            const K = pts.map(p => p.x / p.y), Q = pts.map(p => 60 * p.y / p.time_s).filter(isFinite);
            const out = [];
            if (fit.id === 'proporcional') out.push({ label: 'Factor K', value: `${(1 / fit.coef[0]).toFixed(1)} pulsos/L`, sub: 'YF-S201 nominal ≈ 450 (F = 7,5·Q)' });
            out.push({ label: 'K por punto', value: `${Math.min(...K).toFixed(0)}–${Math.max(...K).toFixed(0)}`, sub: 'pulsos/L' });
            if (Q.length) out.push({ label: 'Caudales probados', value: `${Math.min(...Q).toFixed(1)}–${Math.max(...Q).toFixed(1)} L/min`, sub: '' });
            return out;
        },
        extraWarnings: (fit, pts) => {
            const K = pts.map(p => p.x / p.y);
            const spread = (Math.max(...K) - Math.min(...K)) / (K.reduce((a, b) => a + b) / K.length);
            return spread > 0.05 ? [`K varía ${(100 * spread).toFixed(0)} % entre caudales: a caudal bajo la turbina resbala. Use K(Q) o limite el rango de caudal.`] : [];
        },
        guide: {
            objetivo: 'Obtener el factor K (pulsos por litro) del caudalímetro y verificar si cambia con el caudal.',
            principio: '<div class="math">V = N / K        Q = f / K   (f = frecuencia de pulsos)\nYF-S201: f [Hz] ≈ 7,5 · Q [L/min]   →   K ≈ 450 pulsos/L</div><p>A caudales bajos la turbina resbala y K baja: por eso se prueban varios caudales.</p>',
            materiales: ['Sensor en una línea con válvula, sin aire atrapado.', 'Recipiente y balanza (o probeta de 1 L).', 'Cronómetro; firmware que cuente pulsos por interrupción.'],
            procedimiento: ['Purgue el aire de la línea.', 'Para cada posición de válvula: contador en cero, recolecte ~1 L, registre pulsos, volumen y tiempo.', 'Repita 3 veces por caudal.'],
            checklist: ['Sensor en posición indicada por la flecha', 'Sin burbujas', 'Conteo por interrupción (no en loop con delays)'],
            errores: ['<strong>Contar con digitalRead en loop</strong>: pierde pulsos.', '<strong>Aire en la línea</strong>: la turbina gira distinto.']
        },
        example: {
            extra: (st, g) => ({ time_s: +(60 / (2 * st.level) * (1 + g(0.03))).toFixed(1) }),
            refField: true, levelToRef: () => 1, refJitter: 0.05, refDecimals: 3, decimals: 0,
            forward: (v, cfg, row) => Math.round(v * (470 - 50 / (60 * v / row.time_s)))
        }
    });

    // ---------------- Sensor genérico (unidades libres) ----------------
    R.register({
        id: 'generico', family: 'otros', name: 'Sensor genérico', examples: 'Cualquier sensor que no esté en el catálogo',
        quantity: 'Magnitud', unit: 'u', symbol: 'y',
        labels: cfg => ({ quantity: cfg.params.qty || 'Magnitud', unit: cfg.params.unit || 'u', reading: cfg.params.rlabel || 'Lectura', readingUnit: cfg.params.runit || '' }),
        reading: { label: 'Lectura del sensor', unit: '' },
        params: [
            { key: 'qty', label: 'Magnitud medida', type: 'text', default: 'Magnitud', help: 'Ej.: concentración de CO₂, nivel de agua, velocidad del viento' },
            { key: 'unit', label: 'Unidad de la magnitud', type: 'text', default: 'u' },
            { key: 'rlabel', label: 'Qué entrega el sensor', type: 'text', default: 'Lectura' },
            { key: 'runit', label: 'Unidad de la lectura', type: 'text', default: 'cuentas' }
        ],
        references: [{ id: 'patron', label: 'Instrumento o patrón de referencia', u: 0, help: 'Ingrese u = (incertidumbre expandida del certificado)/2, o exactitud/√3.' }],
        refRes: 0.01, levels: [0, 25, 50, 75, 100], cycles: 2, reps: 1, bidirectional: true,
        models: ['lineal', 'poly2', 'poly3', 'log', 'potencia', 'inverso', 'proporcional'], defaultModel: 'lineal', tolerance: 1,
        timeResponse: true,
        guide: {
            objetivo: 'Calibrar cualquier sensor comparando su lectura con una referencia conocida en varios puntos del rango de uso.',
            principio: `<div class="math">1. Elegir una referencia al menos 4 veces más exacta que la tolerancia buscada.
2. Medir en 5 o más puntos que cubran TODO el rango de uso, subiendo y bajando, en 2–3 ciclos.
3. Ajustar la curva (el sistema compara modelos por AICc) y revisar los residuos.
4. Declarar el error, la incertidumbre (k = 2) y el rango válido de la ecuación.</div>`,
            materiales: ['Sensor montado como en su uso final.', 'Referencia (instrumento calibrado o patrón físico).', 'Forma de fijar la magnitud en valores estables (baño, fuente, masas, etc.).'],
            procedimiento: ['Escriba en la Preparación qué magnitud mide y en qué unidades.', 'Defina los niveles para cubrir el rango de uso.', 'Siga el plan registrando referencia y lectura.', 'Revise la comparación de modelos y los residuos antes de elegir la ecuación.'],
            checklist: ['Referencia con incertidumbre conocida', 'Rango de uso cubierto', 'Condiciones ambientales anotadas'],
            errores: ['<strong>Calibrar en un rango y usar en otro</strong>.', '<strong>Elegir el modelo con más parámetros</strong> sin mirar el AICc: sobreajusta el ruido.']
        },
        example: { refJitter: 0.3, levelToRef: lv => lv, decimals: 1, forward: (y, cfg, row, g) => 200 + 7.5 * y + 0.01 * y * y + g(1.5), tau: 3, stepFrom: 0, stepTo: 100, noise: 2 }
    });
})(typeof self !== 'undefined' ? self : this);
