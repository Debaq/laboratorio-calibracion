/* Perfiles: distancia */
(function (root) {
    'use strict';
    const req = n => (typeof require === 'function') ? require(n) : null;
    const R = req('./registry.js') || root.LabProfiles;
    const P = req('../core/physics.js') || root.LabPhys;

    const TAPE = [{ id: 'huincha', label: 'Huincha / regla metálica', u: 0.05, help: 'Mida desde la cara frontal del sensor hasta el blanco.' }];
    const COMMON_CHECK = ['Blanco plano, rígido y perpendicular al eje del sensor', 'Sensor fijo (soporte), no en la mano', 'Referencia de distancia medida desde el mismo punto del sensor siempre', 'Sin objetos laterales dentro del cono de detección'];

    R.register({
        id: 'hcsr04', family: 'distancia', name: 'Ultrasonido HC-SR04', examples: 'HC-SR04, JSN-SR04T, US-100',
        quantity: 'Distancia', unit: 'cm', symbol: 'd', sameUnits: true,
        reading: { label: 'Lectura', unit: 'µs' },
        readingModes: [
            { id: 'us', label: 'Tiempo de eco (µs) — recomendado', unit: 'µs', xLabel: 'Distancia acústica c(T)·t/2', xUnit: 'cm',
                toX: (t, p, row, cfg) => P.speedOfSound(isFinite(row.temp) ? row.temp : cfg.env.temp) * t * 5e-5 },
            { id: 'cm', label: 'Distancia calculada por la librería (cm)', unit: 'cm' }
        ],
        extraFields: [{ key: 'temp', label: 'Temperatura del aire', unit: '°C', optional: true, hint: 'si falta, usa la del ambiente' }],
        references: TAPE, refRes: 0.1,
        levels: [10, 25, 50, 100, 150, 200], cycles: 3, reps: 1, bidirectional: false,
        models: ['lineal', 'poly2'], defaultModel: 'lineal', tolerance: 1, range: [5, 250],
        settle: 'Promedie 10 lecturas.',
        guide: {
            objetivo: 'Calibrar la distancia del sensor ultrasónico corrigiendo la velocidad del sonido por temperatura y el retardo propio del sensor.',
            principio: `<div class="math">d = c(T) · t / 2          c(T) = 331,3 · √(1 + T/273,15)  m/s
0 °C → 331 m/s    20 °C → 343 m/s    30 °C → 349 m/s   (≈ 0,17 %/°C)</div>
                <p>Las librerías suelen usar c fija (340 o 343 m/s): con 10 °C de diferencia el error es 1,8 cm a 1 m.
                   Registrando el tiempo de eco en µs y la temperatura, el sistema calcula la distancia acústica y la ecuación corrige lo que queda
                   (retardo del circuito y posición real del transductor).</p>`,
            materiales: ['Huincha metálica fija al piso o mesa.', 'Blanco: tabla o cartón duro de al menos 30×30 cm.', 'Termómetro de aire.', 'Firmware que imprima el tiempo de eco: <code>pulseIn(ECHO, HIGH)</code>.'],
            procedimiento: ['Fije el sensor y la huincha; defina el cero en la cara frontal de los transductores.', 'Ubique el blanco a cada distancia del plan, perpendicular.', 'Registre la distancia de referencia, el promedio de 10 tiempos de eco y la temperatura.', 'Haga 3 ciclos moviendo el blanco.'],
            checklist: [...COMMON_CHECK, 'Temperatura del aire anotada'],
            errores: ['<strong>Blanco inclinado o pequeño</strong>: el eco rebota lejos y el sensor ve otro objeto (lecturas mayores).', '<strong>Menos de 3 cm</strong>: zona ciega del sensor.', '<strong>Superficies blandas</strong> (tela, espuma) absorben el sonido.']
        },
        example: { extra: (st, g) => ({ temp: +(18 + g(0.5)).toFixed(1) }), refJitter: 0.2, decimals: 0, forward: (d, cfg, row, g) => (d + 0.4) / (P.speedOfSound(row.temp) * 5e-5) + 12 + g(6) }
    });

    R.register({
        id: 'tof', family: 'distancia', name: 'Tiempo de vuelo láser (ToF)', examples: 'VL53L0X, VL53L1X, TF-Luna, TFmini',
        quantity: 'Distancia', unit: 'mm', symbol: 'd', sameUnits: true,
        reading: { label: 'Distancia indicada', unit: 'mm' },
        references: TAPE.map(r => ({ ...r, u: 0.5 })), refRes: 1,
        levels: [50, 100, 200, 400, 800, 1200], cycles: 3, reps: 1, bidirectional: false,
        models: ['lineal', 'poly2'], defaultModel: 'lineal', tolerance: 25, range: [30, 1200],
        settle: 'Promedie 20 lecturas.',
        guide: {
            objetivo: 'Medir el offset y el error de escala del sensor ToF; ambos dependen del color del blanco y de la luz ambiente.',
            principio: `<div class="math">d = c · t / 2   (c = velocidad de la luz: no depende de la temperatura)
error típico: offset de 10–30 mm (vidrio de la tapa, calibración de fábrica) + % de la distancia</div>
                <p>El VL53L0X tiene funciones de calibración de offset y crosstalk: esta prueba entrega los valores para ingresarlas o corregir en su código.</p>`,
            materiales: ['Huincha metálica.', 'Blanco blanco mate (≈ 88 % reflectancia) y, opcional, uno gris o negro para comparar.', 'Ambiente con luz controlada (sin sol directo).'],
            procedimiento: ['Fije el sensor y defina el cero en la cara del sensor (o del vidrio protector si lo usa).', 'Mida en cada distancia del plan promediando 20 lecturas.', 'Opcional: repita con blanco oscuro y compare la ecuación.'],
            checklist: [...COMMON_CHECK, 'Blanco mate (no brillante)', 'Sin luz solar directa'],
            errores: ['<strong>Vidrio o acrílico delante</strong> sin calibrar crosstalk: lecturas cortas.', '<strong>Blancos brillantes u oscuros</strong>: cambian el error.', '<strong>Modo de largo alcance</strong> en interiores: más ruido.']
        },
        example: { refJitter: 1, decimals: 0, forward: (d, cfg, row, g) => 1.018 * d + 14 + g(2 + 0.004 * d) }
    });

    R.register({
        id: 'sharp', family: 'distancia', name: 'Infrarrojo Sharp (analógico)', examples: 'GP2Y0A21YK0F (10–80 cm), GP2Y0A02 (20–150 cm)',
        quantity: 'Distancia', unit: 'cm', symbol: 'd',
        reading: { label: 'Tensión de salida', unit: 'V' },
        readingModes: [{ id: 'v', label: 'Tensión medida (V)', unit: 'V' }, R.modes.adcVolt(10, 5)],
        references: TAPE, refRes: 0.1,
        levels: [10, 15, 20, 30, 40, 50, 60, 80], cycles: 3, reps: 1, bidirectional: false,
        models: ['inverso', 'potencia', 'poly3'], defaultModel: 'inverso', tolerance: 2, range: [10, 80],
        settle: 'Promedie 20 lecturas (la salida tiene picos de ruido).',
        guide: {
            objetivo: 'Obtener la curva tensión → distancia, que es fuertemente NO lineal, y el rango donde es confiable.',
            principio: `<div class="math">Triangulación: V ∝ 1/d aproximadamente     →   d = c₀ + c₁ / V
Bajo 10 cm la curva se DOBLA: la misma tensión corresponde a dos distancias.</div>
                <p>El sistema compara el modelo inverso, la ley de potencia y un polinomio. La resolución empeora con la distancia: a 80 cm, 10 mV ≈ 2 cm.</p>`,
            materiales: ['Huincha metálica.', 'Blanco blanco mate de 20×20 cm.', 'Condensador de 10 µF entre Vcc y GND del sensor (reduce picos).'],
            procedimiento: ['Monte el sensor fijo; defina el cero en su cara frontal.', 'Recorra el plan desde 10 cm hacia afuera promediando 20 lecturas.', 'No use distancias menores a 10 cm.'],
            checklist: [...COMMON_CHECK, 'Condensador de desacople instalado'],
            errores: ['<strong>Distancias menores al mínimo</strong>: ambigüedad de la curva.', '<strong>Luz solar o IR ambiental</strong>: desplaza la curva.', '<strong>Ajuste lineal</strong>: error de varios cm en los extremos.']
        },
        example: { refJitter: 0.2, decimals: 3, forward: (d, cfg, row, g) => 26.5 / (d + 0.9) + 0.06 + g(0.008) }
    });
})(typeof self !== 'undefined' ? self : this);
