/* Perfiles: fuerza/peso y eléctricos */
(function (root) {
    'use strict';
    const req = n => (typeof require === 'function') ? require(n) : null;
    const R = req('./registry.js') || root.LabProfiles;

    // ---------------- Fuerza ----------------
    const MASSES = [
        { id: 'pesas', label: 'Masas pesadas en balanza de referencia', u: 0.001, help: 'u en kg: resolución/√12 de la balanza combinada con su exactitud.' },
        { id: 'm1', label: 'Pesas calibradas clase M1', u: 0.0001 }
    ];

    R.register({
        id: 'celda', family: 'fuerza', name: 'Celda de carga + HX711', examples: 'Celda de barra 1–50 kg, celda de balanza, HX711',
        quantity: 'Masa', unit: 'kg', symbol: 'm',
        reading: { label: 'Cuentas del HX711', unit: 'cuentas' },
        references: MASSES, refRes: 0.001,
        levels: [0, 0.5, 1, 2, 5], cycles: 3, reps: 1, bidirectional: true,
        models: ['lineal', 'poly2'], defaultModel: 'lineal', tolerance: 0.01, range: [0, 5],
        settle: 'Espere 5 s tras apoyar la masa.',
        extraMetrics: fit => fit.id === 'lineal' ? [
            { label: 'Factor de escala', value: `${(1 / fit.coef[1]).toFixed(1)} cuentas/kg`, sub: 'para scale.set_scale() de la librería HX711' },
            { label: 'Cuentas en vacío', value: `${(-fit.coef[0] / fit.coef[1]).toFixed(0)}`, sub: 'cambia en cada encendido: tare() al iniciar' }] : [],
        guide: {
            objetivo: 'Obtener el factor de escala (cuentas/kg), la linealidad, la histéresis y la repetibilidad de una celda de carga con su amplificador.',
            principio: `<div class="math">N = N₀ + k·m      →     m = (N − N₀) / k
N₀ (tara) cambia con la temperatura y en cada encendido: en uso se mide al iniciar (tare).</div>
                <p>Para la plataforma de 4 celdas del posturógrafo use el módulo <a href="balanza.html">Posturógrafo de balanza</a>.</p>`,
            materiales: ['Celda montada como en su uso final (tornillos apretados, apoyo rígido).', 'Masas de valor conocido (pesadas en balanza de referencia).', 'HX711 con alimentación estable; firmware que imprima cuentas crudas promediadas.'],
            procedimiento: ['Caliente la electrónica 15 min.', 'Registre la lectura en vacío y luego cargue las masas en orden creciente, sin retirar.', 'Descargue en orden inverso (histéresis). Repita 3 ciclos.', 'Aplique la carga siempre en el mismo punto de la celda.'],
            checklist: ['Celda firmemente atornillada', 'Masas pesadas y rotuladas', 'Electrónica encendida ≥ 15 min', 'Firmware sin tare ni escala (cuentas crudas)'],
            errores: ['<strong>Carga descentrada</strong>: cambia la lectura en celdas de barra.', '<strong>Fluencia</strong>: la lectura sigue cambiando minutos después de cargar; registre siempre al mismo tiempo (5 s).', '<strong>Cables sueltos</strong>: saltos de miles de cuentas.']
        },
        example: { refJitter: 0, decimals: 0, levelToRef: lv => lv, forward: (m, cfg, row, g) => 84200 + 21350 * m + g(40), hyst: 0.002 }
    });

    R.register({
        id: 'fsr', family: 'fuerza', name: 'Sensor resistivo de fuerza (FSR)', examples: 'FSR 402, FSR 406, Flexiforce A201',
        quantity: 'Masa aplicada', unit: 'kg', symbol: 'm',
        reading: { label: 'Resistencia', unit: 'Ω' },
        readingModes: [{ id: 'ohm', label: 'Resistencia (Ω)', unit: 'Ω' }, R.modes.adcDivider(10, 10000)],
        references: MASSES, refRes: 0.001,
        levels: [0.1, 0.2, 0.5, 1, 2], cycles: 3, reps: 1, bidirectional: true,
        models: ['potencia', 'log', 'poly2'], defaultModel: 'potencia', tolerance: 0.2, range: [0.1, 2],
        settle: 'Espere 5 s (el FSR sigue cambiando: registre siempre al mismo tiempo).',
        extraWarnings: () => ['Los FSR tienen histéresis y fluencia grandes (10–25 %): sirven para detectar contacto o comparar, no para medir fuerza con exactitud.'],
        guide: {
            objetivo: 'Obtener la curva resistencia → carga del FSR y cuantificar su histéresis y fluencia, que suelen ser el error dominante.',
            principio: `<div class="math">La conductancia (1/R) es aproximadamente proporcional a la fuerza:
  R ≈ a · F^(−b)     →     F = e^c₀ · R^c₁   (ley de potencia)</div>
                <p>La fuerza debe repartirse igual en cada medición: use un disco rígido del tamaño del área activa entre la masa y el sensor.</p>`,
            materiales: ['FSR pegado a una superficie rígida y plana.', 'Disco rígido (goma dura o acrílico) del tamaño del área activa.', 'Masas conocidas.'],
            procedimiento: ['Coloque el disco centrado sobre el área activa.', 'Cargue en orden creciente y luego decreciente, registrando a los 5 s.', 'Repita 3 ciclos. Compare subida y bajada en el gráfico de residuos.'],
            checklist: ['Superficie de apoyo rígida', 'Disco de reparto centrado', 'Mismo tiempo de espera en cada punto'],
            errores: ['<strong>Apoyo blando</strong>: la fuerza se reparte distinto cada vez.', '<strong>Tiempos de espera distintos</strong>: la fluencia cambia la lectura.']
        },
        example: { refJitter: 0, decimals: 0, forward: (m, cfg, row, g) => 8000 * Math.pow(m, -0.85) * (1 + g(0.03)), hyst: 0.05 }
    });

    // ---------------- Eléctricos ----------------
    const DMM = [{ id: 'multimetro', label: 'Multímetro de referencia', u: 0.002, help: 'u = (exactitud de la hoja de datos del multímetro)/√3 en la escala usada.' }];

    R.register({
        id: 'adc', family: 'electricos', name: 'ADC de la placa', examples: 'Arduino UNO/Nano (10 bits), ESP32 (12 bits, no lineal), ADS1115',
        quantity: 'Tensión', unit: 'V', symbol: 'V',
        reading: { label: 'Cuentas del ADC', unit: 'cuentas' },
        references: DMM, refRes: 0.001,
        levels: [0.15, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.1], cycles: 2, reps: 1, bidirectional: true,
        models: ['lineal', 'poly2', 'poly3'], defaultModel: 'lineal', tolerance: 0.02, range: [0, 3.3],
        settle: 'Promedie 64 lecturas del ADC.',
        guide: {
            objetivo: 'Obtener la curva cuentas → tensión del conversor analógico-digital de la placa. En el ESP32 es claramente no lineal y tiene zona muerta cerca de 0 V y de 3,3 V.',
            principio: `<div class="math">ADC ideal:  V = N · Vref / (2ⁿ − 1)
Real: offset + error de ganancia + no linealidad (ESP32 hasta ±100 mV sin corregir)</div>
                <p>El sistema compara recta y polinomios; el AICc indica si la curvatura es real.</p>`,
            materiales: ['Fuente de tensión ajustable: potenciómetro de 10 kΩ entre 3,3 V y GND, con el cursor al pin ADC.', 'Multímetro de referencia midiendo el mismo pin.', 'Condensador de 100 nF del pin a GND (estabiliza la lectura).'],
            procedimiento: ['Conecte el cursor del potenciómetro al pin ADC y al multímetro.', 'Ajuste cada tensión del plan; registre la lectura del multímetro y el promedio de 64 lecturas ADC.', 'Suba y baje; repita 2 ciclos.'],
            checklist: ['GND común entre placa y multímetro', 'Atenuación del ADC configurada igual que en el uso (ESP32)', 'Promedio de muchas lecturas'],
            errores: ['<strong>Asumir Vref = 5,00 V</strong> en Arduino alimentado por USB (suele ser 4,7–5,1 V).', '<strong>Impedancia de la fuente alta</strong> (&gt; 10 kΩ): lecturas bajas; use el condensador.']
        },
        example: { refJitter: 0.005, refDecimals: 3, decimals: 0, forward: (v, cfg, row, g) => Math.round(1241 * v - 115 + 28 * v * v - 9 * v * v * v + g(3)) }
    });

    R.register({
        id: 'acs712', family: 'electricos', name: 'Sensor de corriente Hall ACS712', examples: 'ACS712 5 A / 20 A / 30 A, ACS758, WCS1800',
        quantity: 'Corriente', unit: 'A', symbol: 'I',
        reading: { label: 'Tensión de salida', unit: 'V' },
        readingModes: [{ id: 'v', label: 'Tensión de salida (V)', unit: 'V' }, R.modes.adcVolt(10, 5)],
        references: DMM.map(r => ({ ...r, u: 0.005 })), refRes: 0.001,
        levels: [-3, -2, -1, 0, 1, 2, 3], cycles: 2, reps: 1, bidirectional: true,
        models: ['lineal', 'poly2'], defaultModel: 'lineal', tolerance: 0.1, range: [-5, 5],
        extraMetrics: fit => fit.id === 'lineal' ? [
            { label: 'Sensibilidad', value: `${(1000 / fit.coef[1]).toFixed(1)} mV/A`, sub: 'nominal: 185 (5 A) · 100 (20 A) · 66 (30 A)' },
            { label: 'Salida a 0 A', value: `${(-fit.coef[0] / fit.coef[1]).toFixed(4)} V`, sub: 'nominal Vcc/2' }] : [],
        guide: {
            objetivo: 'Medir la sensibilidad (mV/A) y la tensión de cero del sensor, ambas proporcionales a su alimentación.',
            principio: '<div class="math">V = Vcc/2 + S · I      →      I = (V − V₀) / S</div><p>La salida es ratiométrica: si Vcc cambia 2 %, cambian 2 % el cero y la sensibilidad. Mida y registre Vcc.</p>',
            materiales: ['Fuente de corriente continua con carga resistiva (resistencia de potencia o lámparas).', 'Multímetro en serie como amperímetro (escala 10 A).', 'Multímetro midiendo la salida del sensor.'],
            procedimiento: ['Registre el cero con el circuito abierto.', 'Aumente la corriente por pasos; invierta los cables para las corrientes negativas.', 'Espere a que la resistencia de carga se estabilice térmicamente.'],
            checklist: ['Cables de corriente de calibre adecuado', 'Amperímetro en la escala correcta', 'Sin campos magnéticos cercanos (imanes, motores)'],
            errores: ['<strong>Campo magnético externo</strong>: desplaza el cero.', '<strong>No medir Vcc</strong>: el cero no será exactamente 2,5 V.']
        },
        example: { refJitter: 0.02, refDecimals: 3, decimals: 4, forward: (i, cfg, row, g) => 2.512 + 0.1805 * i + g(0.003) }
    });

    R.register({
        id: 'ina219', family: 'electricos', name: 'Monitor de corriente INA219 / INA226', examples: 'INA219, INA226, INA260',
        quantity: 'Corriente', unit: 'mA', symbol: 'I', sameUnits: true,
        reading: { label: 'Corriente indicada', unit: 'mA' },
        references: DMM.map(r => ({ ...r, u: 1 })), refRes: 0.1,
        levels: [0, 100, 250, 500, 750, 1000], cycles: 2, reps: 1, bidirectional: true,
        models: ['lineal', 'poly2'], defaultModel: 'lineal', tolerance: 10, range: [0, 1000],
        guide: {
            objetivo: 'Verificar la exactitud del monitor de corriente y corregir el valor de la resistencia shunt configurada.',
            principio: '<div class="math">I = V_shunt / R_shunt       (R_shunt nominal 0,1 Ω ±1 % → error de ganancia)</div><p>Una ganancia distinta de 1 se corrige ajustando el valor de calibración (registro CAL) o R_shunt en la librería.</p>',
            materiales: ['Fuente y carga ajustable.', 'Multímetro en serie como amperímetro de referencia.'],
            procedimiento: ['Conecte el INA219 y el amperímetro en serie con la carga.', 'Recorra las corrientes del plan subiendo y bajando.', 'Use la ganancia obtenida para corregir R_shunt: R_real = R_nominal / c₁.'],
            checklist: ['Rango del INA configurado para la corriente máxima', 'Conexiones del shunt cortas y firmes'],
            errores: ['<strong>Rango de ganancia (PGA) muy bajo</strong>: satura.', '<strong>Resistencia de contactos</strong> en protoboard: use bornes.']
        },
        example: { refJitter: 3, refDecimals: 1, decimals: 1, forward: (i, cfg, row, g) => 1.012 * i + 0.8 + g(0.5) }
    });
})(typeof self !== 'undefined' ? self : this);
