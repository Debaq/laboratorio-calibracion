/*
 * LabSketches — código Arduino de cada sensor y módulo, listo para leer con Web Serial (pestaña Medición)
 * o con el Monitor serie del IDE.
 *
 * Todos los sketches siguen el mismo formato, que entiende LabSerial:
 *   - 115200 baudios; una línea de encabezado con los nombres de columna ("t_ms,lectura")
 *     y luego una línea de datos separada por comas.
 *   - Las columnas se llaman como los campos de la medición (lectura, temp, ax, c1, V…): la página las asigna solas.
 *   - Comando 'h': repite el encabezado (la página lo pide si se conectó sin reiniciar la placa).
 *   - Líneas que empiezan con '#': avisos (se muestran, no son datos).
 *
 * Cada variante: { id, label, libs, wiring, notes, columns, commands, capture: { seconds, stat }, check(cfg), code }
 */
(function (root, factory) {
    const m = factory();
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.LabSketches = m;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const BAUD = 115200;
    const indent = (s, n = 2) => String(s || '').split('\n').map(l => l ? ' '.repeat(n) + l : l).join('\n');

    /** Serial.print de la marca de tiempo y cada valor: [['expr', decimales], …]. */
    function printRow(vals) {
        return ['Serial.print(millis());',
            ...vals.map(([e, d], i) => `Serial.print(',');${' '}Serial.print${i === vals.length - 1 ? 'ln' : ''}(${e}${d != null ? `, ${d}` : ''});`)].join('\n');
    }

    /**
     * Arma un sketch con la estructura común.
     * o: { title, libs, wiring, comments, includes, globals, setup, loop | rawLoop, columns, period, commands }
     */
    function ino(o) {
        const cols = o.columns.join(',');
        const cmds = o.commands || [];
        const head = [
            `// ${o.title}`,
            '// Laboratorio de Calibración: sketch para Web Serial (pestaña Medición) o el Monitor serie del IDE.',
            `// Envía a ${BAUD} baudios el encabezado "${cols}" y luego una línea de datos${o.rawLoop ? '' : ` cada ${o.period} ms`}.`,
            ...(o.libs && o.libs.length ? [`// Bibliotecas (Herramientas → Administrar bibliotecas): ${o.libs.join(', ')}.`] : []),
            ...(o.wiring ? [`// Conexión: ${o.wiring}`] : []),
            ...(o.comments || []).map(c => `// ${c}`)
        ];
        const commandLines = cmds.map(c => `    if (c == '${c.cmd}') {\n${indent(c.code, 6)}\n    }`).join('\n');
        const loopBody = o.rawLoop
            ? o.rawLoop
            : `static unsigned long ultimo = 0;\nif (millis() - ultimo < PERIODO_MS) return;\nultimo = millis();\n\n${o.loop}`;
        return [
            ...head,
            '',
            ...(o.includes || []).map(i => `#include ${i}`),
            ...(o.includes && o.includes.length ? [''] : []),
            ...(o.rawLoop ? [] : [`const unsigned long PERIODO_MS = ${o.period};   // una línea cada ${o.period} ms (${+(1000 / o.period).toFixed(1)} por segundo)`]),
            ...(o.globals ? [o.globals] : []),
            '',
            'void encabezado() {',
            `  Serial.println("${cols}");`,
            '}',
            '',
            'void setup() {',
            `  Serial.begin(${BAUD});`,
            ...(o.setup ? [indent(o.setup)] : []),
            '  encabezado();',
            '}',
            '',
            'void loop() {',
            `  // Comandos desde la página: 'h' repite el encabezado${cmds.map(c => `, '${c.cmd}' ${c.label.toLowerCase()}`).join('')}`,
            '  while (Serial.available()) {',
            '    char c = Serial.read();',
            "    if (c == 'h') encabezado();",
            ...(commandLines ? [commandLines] : []),
            '  }',
            '',
            indent(loopBody),
            '}',
            ''
        ].join('\n')
            // Textos fijos en la memoria de programa (F): en el UNO la RAM es de solo 2 KB
            .replace(/Serial\.(print|println)\("((?:[^"\\]|\\.)*)"\)/g, 'Serial.$1(F("$2"))');
    }

    /** Variante: agrega metadatos por defecto y genera el código. */
    function variant(o) {
        return {
            id: o.id, label: o.label, libs: o.libs || [], wiring: o.wiring || '', notes: o.notes || [],
            columns: o.columns, commands: (o.commands || []).map(({ cmd, label }) => ({ cmd, label })),
            capture: { seconds: 2, stat: 'mean', ...(o.capture || {}) },
            check: o.check || (() => null),
            code: ino(o)
        };
    }

    // ---------------- Bloques reutilizables ----------------
    const ADC_GLOBALS = (pins, n = 16) => `${pins}
const int MUESTRAS = ${n};   // promedia ${n} lecturas del ADC en cada línea: baja el ruido

float leerADC(int pin) {
  long suma = 0;
  for (int i = 0; i < MUESTRAS; i++) suma += analogRead(pin);
  return (float)suma / MUESTRAS;
}`;
    const ESP32_RES = '#if defined(ESP32)\nanalogReadResolution(12);   // ESP32: 12 bits (0–4095). Indíquelo en la Preparación.\n#endif';
    const ADC_NOTE = 'En ESP32 use un pin del ADC1 (32–39) y ponga 12 bits en la Preparación.';

    /** Exige un modo de lectura concreto del perfil (cuentas ADC, divisor, µs…). */
    const needMode = (modeId, label) => cfg => cfg && cfg.readingMode && cfg.readingMode !== modeId
        ? `Este sketch entrega ${label}. En Preparación → Lectura del sensor elija ese modo en “Qué se registra”.` : null;

    /** Sensor analógico: cuentas promediadas en A0. */
    const analog = ({ id = 'adc', label, title, wiring, mode, modeLabel = 'cuentas del ADC', notes = [], n = 16, period = 100, comments = [] }) => variant({
        id, label, title, wiring, notes: [...notes, ADC_NOTE], columns: ['t_ms', 'lectura'], period,
        check: mode ? needMode(mode, modeLabel) : null,
        comments: [...comments, ADC_NOTE],
        globals: ADC_GLOBALS('const int PIN_SENSOR = A0;', n),
        setup: ESP32_RES,
        loop: printRow([['leerADC(PIN_SENSOR)', 2]])
    });

    const divider = (title, sensor, fixed, sensorOnTop) => analog({
        id: 'divisor', label: `Divisor resistivo en A0 (${sensorOnTop ? 'sensor arriba' : 'sensor abajo'})`, title,
        mode: 'divisor', modeLabel: 'cuentas del ADC de un divisor resistivo (“Cuentas ADC (divisor resistivo)”)',
        wiring: sensorOnTop
            ? `${sensor} entre 5 V (o 3,3 V) y A0; resistencia fija de ${fixed} entre A0 y GND.`
            : `resistencia fija de ${fixed} entre 5 V (o 3,3 V) y A0; ${sensor} entre A0 y GND.`,
        notes: [`En la Preparación elija la posición del sensor “${sensorOnTop ? 'entre Vcc y la entrada ADC' : 'entre la entrada ADC y GND'}” e ingrese la resistencia fija medida con multímetro.`]
    });

    // Sensores ambientales I²C / 1 hilo: temperatura, humedad y presión
    const ENV = {
        dht22: { label: 'DHT22 / DHT11', libs: ['DHT sensor library (Adafruit)', 'Adafruit Unified Sensor'], includes: ['"DHT.h"'],
            wiring: 'DATA a D2 con resistencia de 10 kΩ a VCC (los módulos ya la traen).', period: 2000,
            globals: 'DHT dht(2, DHT22);   // DHT11: cambie DHT22 por DHT11', setup: 'dht.begin();',
            read: 'float t = dht.readTemperature();\nfloat h = dht.readHumidity();\nif (isnan(t) || isnan(h)) { Serial.println("# error de lectura del DHT"); return; }',
            notes: ['El DHT22 se lee como máximo cada 2 s.'] },
        sht31: { label: 'SHT31 / SHT3x', libs: ['Adafruit SHT31 Library'], includes: ['<Wire.h>', '"Adafruit_SHT31.h"'],
            wiring: 'I²C: SDA y SCL (UNO: A4/A5 · ESP32: 21/22), VIN a 3,3–5 V.', period: 1000,
            globals: 'Adafruit_SHT31 sht;', setup: 'if (!sht.begin(0x44)) Serial.println("# no se encontró el SHT31 (dirección 0x44 o 0x45)");',
            read: 'float t = sht.readTemperature();\nfloat h = sht.readHumidity();' },
        bme280: { label: 'BME280', libs: ['Adafruit BME280 Library', 'Adafruit Unified Sensor'], includes: ['<Wire.h>', '<Adafruit_BME280.h>'],
            wiring: 'I²C: SDA y SCL (UNO: A4/A5 · ESP32: 21/22).', period: 1000,
            globals: 'Adafruit_BME280 bme;', setup: 'if (!bme.begin(0x76)) Serial.println("# no se encontró el BME280 (pruebe begin(0x77))");',
            read: 'float t = bme.readTemperature();\nfloat h = bme.readHumidity();\nfloat p = bme.readPressure() / 100.0;   // hPa' },
        aht20: { label: 'AHT20 / AHT10', libs: ['Adafruit AHTX0'], includes: ['<Wire.h>', '<Adafruit_AHTX0.h>'],
            wiring: 'I²C: SDA y SCL (UNO: A4/A5 · ESP32: 21/22).', period: 1000,
            globals: 'Adafruit_AHTX0 aht;', setup: 'if (!aht.begin()) Serial.println("# no se encontró el AHT20");',
            read: 'sensors_event_t hum, temp;\naht.getEvent(&hum, &temp);\nfloat t = temp.temperature;\nfloat h = hum.relative_humidity;' }
    };
    const envVariant = (key, title, columns, vals, extraNotes = []) => {
        const e = ENV[key];
        return variant({
            id: key, label: e.label, title: `${title} con ${e.label}`, libs: e.libs, includes: e.includes, wiring: e.wiring,
            notes: [...(e.notes || []), ...extraNotes], columns, period: e.period,
            capture: { seconds: Math.max(3, 3 * e.period / 1000) },
            globals: e.globals, setup: e.setup, loop: `${e.read}\n${printRow(vals)}`
        });
    };

    // ---------------- Perfiles del catálogo (sensor.html?p=…) ----------------
    const S = {};

    S.ntc = [divider('Termistor NTC: cuentas del ADC en un divisor', 'el NTC', '10 kΩ', false)];

    S.lm35 = [
        analog({ id: 'adc5', label: 'Referencia de 5 V (por defecto)', title: 'LM35 / TMP36: cuentas del ADC', mode: 'adc', modeLabel: 'cuentas del ADC (“Cuentas del ADC”)',
            wiring: '+Vs a 5 V, GND a GND, Vout a A0.', notes: ['Mida el pin 5V (o AREF) con multímetro e ingréselo como tensión de referencia.'] }),
        variant({
            id: 'adc11', label: 'Referencia interna de 1,1 V (UNO/Nano, 5× más resolución)', title: 'LM35 con referencia interna de 1,1 V',
            wiring: '+Vs a 5 V, GND a GND, Vout a A0. Solo hasta ≈ 110 °C (LM35) o 60 °C (TMP36).',
            notes: ['Ponga 1,1 V como tensión de referencia (mejor: mida AREF con multímetro, suele ser 1,05–1,15 V).', 'Solo placas AVR (UNO, Nano, Mega: INTERNAL1V1).'],
            check: needMode('adc', 'cuentas del ADC (“Cuentas del ADC”)'),
            columns: ['t_ms', 'lectura'], period: 100,
            globals: ADC_GLOBALS('const int PIN_SENSOR = A0;', 16),
            setup: 'analogReference(INTERNAL);   // 1,1 V en UNO/Nano (Mega: INTERNAL1V1)\nanalogRead(PIN_SENSOR);      // descarta la primera lectura tras cambiar la referencia\ndelay(10);',
            loop: printRow([['leerADC(PIN_SENSOR)', 2]])
        })
    ];

    S.ds18b20 = [variant({
        id: 'ds18b20', label: 'DS18B20 (1-Wire, 12 bits)', title: 'DS18B20: temperatura en °C',
        libs: ['OneWire', 'DallasTemperature'], includes: ['<OneWire.h>', '<DallasTemperature.h>'],
        wiring: 'DQ a D2 con resistencia de 4,7 kΩ entre DQ y VCC; VDD a 3,3–5 V.', notes: ['A 12 bits cada conversión tarda 750 ms.'],
        columns: ['t_ms', 'lectura'], period: 800, capture: { seconds: 4 },
        globals: 'OneWire bus(2);\nDallasTemperature ds(&bus);',
        setup: 'ds.begin();\nds.setResolution(12);   // 0,0625 °C',
        loop: `ds.requestTemperatures();\nfloat t = ds.getTempCByIndex(0);\nif (t == DEVICE_DISCONNECTED_C) { Serial.println("# DS18B20 no responde"); return; }\n${printRow([['t', 4]])}`
    })];

    S.termocupla = [
        variant({
            id: 'max31855', label: 'MAX31855', title: 'Termocupla K con MAX31855', libs: ['Adafruit MAX31855 library'], includes: ['<SPI.h>', '"Adafruit_MAX31855.h"'],
            wiring: 'CLK a D3, CS a D4, DO a D5; VIN a 3,3–5 V.', columns: ['t_ms', 'lectura'], period: 250,
            globals: 'Adafruit_MAX31855 tc(3, 4, 5);   // CLK, CS, DO', setup: 'delay(500);   // el MAX31855 necesita tiempo para estabilizarse\ntc.begin();',
            loop: `double t = tc.readCelsius();\nif (isnan(t)) { Serial.println("# termocupla desconectada o en corto"); return; }\n${printRow([['t', 2]])}`
        }),
        variant({
            id: 'max6675', label: 'MAX6675', title: 'Termocupla K con MAX6675', libs: ['MAX6675 library (Adafruit)'], includes: ['"max6675.h"'],
            wiring: 'SCK a D3, CS a D4, SO a D5; VCC a 5 V.', notes: ['El MAX6675 entrega pasos de 0,25 °C y convierte cada 220 ms.'],
            columns: ['t_ms', 'lectura'], period: 300,
            globals: 'MAX6675 tc(3, 4, 5);   // SCK, CS, SO', setup: 'delay(500);',
            loop: `float t = tc.readCelsius();\nif (isnan(t)) { Serial.println("# termocupla desconectada"); return; }\n${printRow([['t', 2]])}`
        })
    ];

    S['temp-ambiental'] = ['sht31', 'bme280', 'aht20', 'dht22'].map(k => envVariant(k, 'Temperatura ambiental', ['t_ms', 'lectura'], [['t', 2]]));

    S.hr = ['sht31', 'bme280', 'aht20', 'dht22'].map(k => envVariant(k, 'Humedad relativa', ['t_ms', 'lectura', 'temp'], [['h', 2], ['t', 2]],
        ['La columna temp es la temperatura del propio sensor: sirve como temperatura de la cámara si está dentro de ella.']));

    S.baro = ['bme280', 'bmp280'].map(k => k === 'bme280'
        ? envVariant('bme280', 'Presión barométrica', ['t_ms', 'lectura'], [['p', 2]])
        : variant({
            id: 'bmp280', label: 'BMP280', title: 'Presión barométrica con BMP280', libs: ['Adafruit BMP280 Library', 'Adafruit Unified Sensor'],
            includes: ['<Wire.h>', '<Adafruit_BMP280.h>'], wiring: 'I²C: SDA y SCL (UNO: A4/A5 · ESP32: 21/22).',
            columns: ['t_ms', 'lectura'], period: 500, capture: { seconds: 4 },
            globals: 'Adafruit_BMP280 bmp;',
            setup: 'if (!bmp.begin(0x76)) Serial.println("# no se encontró el BMP280 (pruebe begin(0x77))");\n// Máximo sobremuestreo y filtro: menos ruido\nbmp.setSampling(Adafruit_BMP280::MODE_NORMAL, Adafruit_BMP280::SAMPLING_X2, Adafruit_BMP280::SAMPLING_X16,\n                Adafruit_BMP280::FILTER_X16, Adafruit_BMP280::STANDBY_MS_63);',
            loop: printRow([['bmp.readPressure() / 100.0', 2]])
        }));
    S.baro.forEach(v => v.notes.push('La columna lectura es la presión de estación en hPa (sin corregir a nivel del mar).'));

    S.pt100 = [variant({
        id: 'max31865', label: 'MAX31865 (resistencia en Ω)', title: 'PT100 / PT1000 con MAX31865: resistencia',
        libs: ['Adafruit MAX31865 library'], includes: ['<Adafruit_MAX31865.h>'],
        wiring: 'CS a D10, SDI a D11, SDO a D12, CLK a D13. Puentes del módulo según 2, 3 o 4 hilos.',
        notes: ['RREF es la resistencia de referencia del módulo: 430 Ω para PT100, 4300 Ω para PT1000. Mídala si puede: su error es un error de ganancia.'],
        columns: ['t_ms', 'lectura'], period: 200,
        globals: 'Adafruit_MAX31865 rtd(10, 11, 12, 13);   // CS, SDI, SDO, CLK\nconst float RREF = 430.0;                 // PT1000: 4300.0',
        setup: 'rtd.begin(MAX31865_3WIRE);   // o MAX31865_2WIRE / MAX31865_4WIRE',
        loop: `uint16_t n = rtd.readRTD();\nuint8_t falla = rtd.readFault();\nif (falla) { Serial.print("# falla del MAX31865: 0x"); Serial.println(falla, HEX); rtd.clearFault(); return; }\nfloat r = RREF * n / 32768.0;   // Ω\n${printRow([['r', 3]])}`
    })];

    S.celda = [variant({
        id: 'hx711', label: 'HX711 (cuentas crudas)', title: 'Celda de carga con HX711: cuentas crudas',
        libs: ['HX711 (bogde)'], includes: ['"HX711.h"'], wiring: 'DT a D3, SCK a D2; E+/E−/A+/A− a la celda.',
        notes: ['Entrega la lectura cruda, sin tare() ni set_scale(): la calibración la hace la página.', 'Con el pin RATE en VCC el HX711 entrega 80 lecturas/s (por defecto 10).'],
        columns: ['t_ms', 'lectura'], period: 100,
        globals: 'HX711 hx;', setup: 'hx.begin(3, 2);   // DT, SCK',
        loop: `if (!hx.wait_ready_timeout(500)) { Serial.println("# HX711 no responde"); return; }\n${printRow([['hx.read()']])}`
    })];

    S.fsr = [divider('FSR: cuentas del ADC en un divisor', 'el FSR', '10 kΩ', true)];

    S.adc = [
        analog({ id: 'uno', label: 'Arduino UNO / Nano (10 bits)', title: 'ADC de la placa: cuentas promediadas', n: 64, period: 200,
            wiring: 'cursor de un potenciómetro de 10 kΩ (entre 5 V y GND) a A0 y al multímetro; 100 nF de A0 a GND.' }),
        variant({
            id: 'esp32', label: 'ESP32 (12 bits)', title: 'ADC del ESP32: cuentas promediadas',
            wiring: 'cursor de un potenciómetro de 10 kΩ (entre 3,3 V y GND) a GPIO34 y al multímetro; 100 nF de GPIO34 a GND.',
            notes: ['Ponga 12 bits en la Preparación. La atenuación de 11 dB mide hasta ≈ 3,1 V.', 'analogRead() entrega cuentas crudas (no lineales); no use analogReadMilliVolts(): ya trae la corrección de fábrica.'],
            columns: ['t_ms', 'lectura'], period: 200,
            globals: ADC_GLOBALS('const int PIN_SENSOR = 34;   // ADC1: funciona aunque el WiFi esté activo', 64),
            setup: 'analogReadResolution(12);\nanalogSetAttenuation(ADC_11db);   // igual que en su aplicación',
            loop: printRow([['leerADC(PIN_SENSOR)', 2]])
        }),
        variant({
            id: 'ads1115', label: 'ADS1115 (16 bits, I²C)', title: 'ADS1115: cuentas del canal A0',
            libs: ['Adafruit ADS1X15'], includes: ['<Adafruit_ADS1X15.h>'], wiring: 'I²C (SDA/SCL); señal a A0 del ADS1115; ADDR a GND.',
            notes: ['Con GAIN_ONE cada cuenta vale 0,125 mV (±4,096 V). Ponga 15 bits y 4,096 V en la Preparación si usa el modo de tensión.'],
            columns: ['t_ms', 'lectura'], period: 200,
            globals: 'Adafruit_ADS1115 ads;\nconst int MUESTRAS = 8;',
            setup: 'if (!ads.begin()) Serial.println("# no se encontró el ADS1115");\nads.setGain(GAIN_ONE);   // ±4,096 V',
            loop: `long suma = 0;\nfor (int i = 0; i < MUESTRAS; i++) suma += ads.readADC_SingleEnded(0);\n${printRow([['(float)suma / MUESTRAS', 2]])}`
        })
    ];

    S.acs712 = [analog({ title: 'ACS712: cuentas del ADC', mode: 'adc', modeLabel: 'cuentas del ADC (“Cuentas del ADC”)', n: 64,
        wiring: 'VCC a 5 V, GND a GND, OUT a A0. La corriente pasa por los bornes IP+ / IP−.',
        notes: ['Mida el pin 5V con multímetro: la salida del ACS712 y la referencia del ADC dependen de él.'] })];

    S.ina219 = [
        variant({
            id: 'ina219', label: 'INA219', title: 'INA219: corriente en mA', libs: ['Adafruit INA219'], includes: ['<Wire.h>', '<Adafruit_INA219.h>'],
            wiring: 'I²C (SDA/SCL); VIN+ y VIN− en serie con la carga.', columns: ['t_ms', 'lectura'], period: 100,
            globals: 'Adafruit_INA219 ina;',
            setup: 'if (!ina.begin()) Serial.println("# no se encontró el INA219");\n// ina.setCalibration_32V_1A();   // más resolución si la corriente es menor que 1 A',
            loop: printRow([['ina.getCurrent_mA()', 2]])
        }),
        variant({
            id: 'ina226', label: 'INA226', title: 'INA226: corriente en mA', libs: ['INA226 (Rob Tillaart)'], includes: ['<Wire.h>', '<INA226.h>'],
            wiring: 'I²C (SDA/SCL); IN+ e IN− en serie con la carga.', notes: ['setMaxCurrentShunt(corriente máxima A, R_shunt Ω): use el R_shunt nominal; la calibración corrige su error.'],
            columns: ['t_ms', 'lectura'], period: 100,
            globals: 'INA226 ina(0x40);',
            setup: 'Wire.begin();\nif (!ina.begin()) Serial.println("# no se encontró el INA226");\nina.setMaxCurrentShunt(1, 0.1);   // 1 A, 0,1 Ω',
            loop: printRow([['ina.getCurrent_mA()', 2]])
        })
    ];

    const HCSR04_SETUP = 'pinMode(TRIG, OUTPUT);\npinMode(ECHO, INPUT);';
    const HCSR04_READ = 'digitalWrite(TRIG, LOW);\ndelayMicroseconds(2);\ndigitalWrite(TRIG, HIGH);\ndelayMicroseconds(10);\ndigitalWrite(TRIG, LOW);\nunsigned long us = pulseIn(ECHO, HIGH, 30000);   // máx. 30 ms ≈ 5 m\nif (us == 0) { Serial.println("# sin eco"); return; }';
    S.hcsr04 = [
        variant({
            id: 'us', label: 'Tiempo de eco en µs (recomendado)', title: 'HC-SR04: tiempo de eco', wiring: 'TRIG a D9, ECHO a D10, VCC a 5 V.',
            notes: ['La página corrige la velocidad del sonido con la temperatura del aire.'], check: needMode('us', 'el tiempo de eco (“Tiempo de eco (µs)”)'),
            columns: ['t_ms', 'lectura'], period: 60, globals: 'const int TRIG = 9, ECHO = 10;', setup: HCSR04_SETUP,
            loop: `${HCSR04_READ}\n${printRow([['us']])}`
        }),
        variant({
            id: 'cm', label: 'Distancia en cm (como las librerías)', title: 'HC-SR04: distancia con c fija (343 m/s)', wiring: 'TRIG a D9, ECHO a D10, VCC a 5 V.',
            check: needMode('cm', 'la distancia en cm (“Distancia calculada por la librería”)'),
            columns: ['t_ms', 'lectura'], period: 60, globals: 'const int TRIG = 9, ECHO = 10;', setup: HCSR04_SETUP,
            loop: `${HCSR04_READ}\n${printRow([['us / 58.3', 2]])}   // c = 343 m/s (20 °C)`
        })
    ];

    S.tof = [
        variant({
            id: 'vl53l0x', label: 'VL53L0X', title: 'VL53L0X: distancia en mm', libs: ['Adafruit_VL53L0X'], includes: ['<Adafruit_VL53L0X.h>'],
            wiring: 'I²C (SDA/SCL), VIN a 3,3–5 V.', columns: ['t_ms', 'lectura'], period: 50,
            globals: 'Adafruit_VL53L0X lox;', setup: 'if (!lox.begin()) Serial.println("# no se encontró el VL53L0X");',
            loop: `VL53L0X_RangingMeasurementData_t m;\nlox.rangingTest(&m, false);\nif (m.RangeStatus == 4) { Serial.println("# fuera de rango"); return; }\n${printRow([['m.RangeMilliMeter']])}`
        }),
        variant({
            id: 'vl53l1x', label: 'VL53L1X', title: 'VL53L1X: distancia en mm', libs: ['VL53L1X (Pololu)'], includes: ['<Wire.h>', '<VL53L1X.h>'],
            wiring: 'I²C (SDA/SCL), VIN a 3,3–5 V.', columns: ['t_ms', 'lectura'], period: 50,
            globals: 'VL53L1X tof;',
            setup: 'Wire.begin();\nWire.setClock(400000);\ntof.setTimeout(500);\nif (!tof.init()) Serial.println("# no se encontró el VL53L1X");\ntof.setDistanceMode(VL53L1X::Long);\ntof.setMeasurementTimingBudget(50000);\ntof.startContinuous(50);',
            loop: `uint16_t mm = tof.read();\nif (tof.timeoutOccurred() || tof.ranging_data.range_status != VL53L1X::RangeValid) { Serial.println("# lectura no válida"); return; }\n${printRow([['mm']])}`
        })
    ];

    S.sharp = [analog({ title: 'Sharp GP2Y0A: cuentas del ADC', mode: 'adc', modeLabel: 'cuentas del ADC (“Cuentas del ADC”)', n: 32,
        wiring: 'rojo a 5 V, negro a GND, amarillo (Vo) a A0. Condensador de 10 µF entre 5 V y GND cerca del sensor.' })];

    S.ldr = [divider('LDR: cuentas del ADC en un divisor', 'la LDR', '10 kΩ', false)];

    S.bh1750 = [
        variant({
            id: 'bh1750', label: 'BH1750', title: 'BH1750: iluminancia en lx', libs: ['BH1750 (Christopher Laws)'], includes: ['<Wire.h>', '<BH1750.h>'],
            wiring: 'I²C (SDA/SCL), ADDR a GND (dirección 0x23).', columns: ['t_ms', 'lectura'], period: 200,
            globals: 'BH1750 luz;', setup: 'Wire.begin();\nif (!luz.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) Serial.println("# no se encontró el BH1750");',
            loop: printRow([['luz.readLightLevel()', 1]])
        }),
        variant({
            id: 'veml7700', label: 'VEML7700', title: 'VEML7700: iluminancia en lx', libs: ['Adafruit VEML7700'], includes: ['<Adafruit_VEML7700.h>'],
            wiring: 'I²C (SDA/SCL).', columns: ['t_ms', 'lectura'], period: 200,
            globals: 'Adafruit_VEML7700 veml;', setup: 'if (!veml.begin()) Serial.println("# no se encontró el VEML7700");',
            loop: printRow([['veml.readLux()', 1]])
        })
    ];

    S.potenciometro = [
        analog({ id: 'pot', label: 'Potenciómetro en A0', title: 'Potenciómetro angular: cuentas del ADC', wiring: 'extremos a 5 V y GND, cursor a A0.' }),
        variant({
            id: 'as5600', label: 'AS5600 (magnético, 12 bits)', title: 'AS5600: ángulo crudo en cuentas (0–4095)', includes: ['<Wire.h>'],
            wiring: 'I²C (SDA/SCL), DIR a GND; imán diametral centrado a 0,5–3 mm.', notes: ['4096 cuentas por vuelta. Si el eje cruza 0/4095 dentro del rango, reubique el imán.'],
            columns: ['t_ms', 'lectura'], period: 50,
            globals: 'const uint8_t AS5600 = 0x36;\n\nint leerAngulo() {\n  Wire.beginTransmission(AS5600);\n  Wire.write(0x0C);            // RAW ANGLE (12 bits)\n  Wire.endTransmission(false);\n  Wire.requestFrom(AS5600, (uint8_t)2);\n  int alto = Wire.read(), bajo = Wire.read();\n  return ((alto & 0x0F) << 8) | bajo;\n}',
            setup: 'Wire.begin();',
            loop: printRow([['leerAngulo()']])
        })
    ];

    S.flex = [divider('Sensor de flexión: cuentas del ADC en un divisor', 'el sensor de flexión', '47 kΩ', false)];

    S.ph = [analog({ title: 'Electrodo de pH con módulo amplificador: cuentas del ADC', mode: 'adc', modeLabel: 'la salida del módulo en cuentas ADC', n: 64, period: 200,
        wiring: 'Po del módulo (PH-4502C u otro) a A0, V+ a 5 V, G a GND.',
        notes: ['No mueva el potenciómetro de offset del módulo durante la calibración.'] })];

    S.suelo = [analog({ title: 'Humedad de suelo capacitiva: cuentas del ADC', n: 32, period: 200,
        wiring: 'VCC a 3,3–5 V (el mismo que usará en terreno), GND a GND, AOUT a A0.' })];

    S.yfs201 = [variant({
        id: 'yfs201', label: 'Conteo por interrupción', title: 'Caudalímetro de turbina: pulsos por interrupción',
        wiring: 'cable amarillo (señal) a D2, rojo a 5 V, negro a GND. D2 usa la resistencia pull-up interna.',
        notes: ['Antes de recolectar presione “Poner conteo en cero”. Cierre la válvula y capture: pulsos y tiempo quedan fijos.',
            'time_s es el tiempo entre el primer y el último pulso: si no cronometra aparte, sirve como tiempo de recolección.'],
        columns: ['t_ms', 'lectura', 'time_s'], period: 200, capture: { seconds: 1, stat: 'last' },
        commands: [{ cmd: 'z', label: 'Poner conteo en cero', code: 'noInterrupts();\npulsos = 0;\nprimero = ultimoPulso = 0;\ninterrupts();' }],
        globals: 'const int PIN_PULSOS = 2;   // UNO: D2 o D3 (pines con interrupción)\nvolatile unsigned long pulsos = 0, primero = 0, ultimoPulso = 0;\n\nvoid contarPulso() {\n  unsigned long t = millis();\n  if (pulsos == 0) primero = t;\n  ultimoPulso = t;\n  pulsos++;\n}',
        setup: 'pinMode(PIN_PULSOS, INPUT_PULLUP);\nattachInterrupt(digitalPinToInterrupt(PIN_PULSOS), contarPulso, FALLING);',
        loop: `noInterrupts();\nunsigned long n = pulsos, t1 = primero, t2 = ultimoPulso;\ninterrupts();\n${printRow([['n'], ['(t2 - t1) / 1000.0', 2]])}`
    })];

    S.generico = [analog({ label: 'Sensor analógico en A0 (plantilla)', title: 'Sensor genérico: plantilla analógica',
        wiring: 'salida del sensor a A0.',
        notes: ['Si su sensor es digital, reemplace leerADC(PIN_SENSOR) por la función de su biblioteca y deje el mismo formato de salida.'],
        comments: ['Para un sensor digital cambie solo la línea que imprime el valor (deje el formato "t_ms,lectura").'] })];

    // MAX30102: SpO₂ con el algoritmo de Maxim y FC por detección de latidos (ejemplos de SparkFun)
    const MAX_LIBS = ['SparkFun MAX3010x Pulse and Proximity Sensor Library'];
    const spo2Code = cols => variant({
        id: 'max30102', label: 'MAX30102 (algoritmo de Maxim)', title: 'MAX30102: SpO₂ y frecuencia cardiaca', libs: MAX_LIBS,
        includes: ['<Wire.h>', '"MAX30105.h"', '"spo2_algorithm.h"'], wiring: 'I²C (SDA/SCL), VIN a 3,3–5 V. Dedo quieto y con presión suave.',
        notes: ['Entrega un valor por segundo, solo cuando el algoritmo lo considera válido.', 'En el UNO la RAM queda justa (búferes de 100 muestras): si se reinicia o se cuelga, use un ESP32 o un Mega.', 'Uso docente: no es un equipo clínico.'],
        columns: cols, capture: { seconds: 5 },
        globals: `MAX30105 sensor;
#if defined(__AVR_ATmega328P__) || defined(__AVR_ATmega168__)
uint16_t ir[100], rojo[100];   // UNO: poca RAM, muestras de 16 bits
#else
uint32_t ir[100], rojo[100];
#endif
int32_t spo2, fc;
int8_t spo2Valida, fcValida;

void leerMuestra(int i) {
  while (!sensor.available()) sensor.check();
  rojo[i] = sensor.getRed();
  ir[i] = sensor.getIR();
  sensor.nextSample();
}`,
        setup: 'if (!sensor.begin(Wire, I2C_SPEED_FAST)) Serial.println("# no se encontró el MAX30102");\nsensor.setup(60, 4, 2, 100, 411, 4096);   // brillo, promedio, modo rojo+IR, 100 Hz, 411 µs, rango\nfor (int i = 0; i < 100; i++) leerMuestra(i);',
        rawLoop: `// Desplaza la ventana: descarta las 25 muestras más antiguas y lee 25 nuevas (≈ 1 s)
for (int i = 25; i < 100; i++) { rojo[i - 25] = rojo[i]; ir[i - 25] = ir[i]; }
for (int i = 75; i < 100; i++) leerMuestra(i);
maxim_heart_rate_and_oxygen_saturation(ir, 100, rojo, &spo2, &spo2Valida, &fc, &fcValida);
if (!spo2Valida || !fcValida) { Serial.println("# señal no válida: acomode el dedo"); return; }
${cols[1] === 'lectura' && cols[2] === 'fc' ? printRow([['spo2'], ['fc']]) : printRow([['fc'], ['spo2']])}`
    });
    S.spo2 = [spo2Code(['t_ms', 'lectura', 'fc'])];
    S.fc = [
        variant({
            id: 'latidos', label: 'MAX30102 (detección de latidos)', title: 'MAX30102: frecuencia cardiaca por detección de latidos', libs: MAX_LIBS,
            includes: ['<Wire.h>', '"MAX30105.h"', '"heartRate.h"'], wiring: 'I²C (SDA/SCL), VIN a 3,3–5 V. Dedo quieto y con presión suave.',
            notes: ['Imprime una línea por latido: el promedio de los últimos 4 latidos en lpm.'], columns: ['t_ms', 'lectura'], capture: { seconds: 8 },
            globals: 'MAX30105 sensor;\nconst byte N = 4;   // latidos promediados\nbyte latidos[N];\nbyte k = 0, validos = 0;\nunsigned long ultimoLatido = 0;',
            setup: 'if (!sensor.begin(Wire, I2C_SPEED_FAST)) Serial.println("# no se encontró el MAX30102");\nsensor.setup();\nsensor.setPulseAmplitudeRed(0x0A);\nsensor.setPulseAmplitudeGreen(0);',
            rawLoop: `long valorIR = sensor.getIR();
if (valorIR < 50000) return;   // sin dedo
if (!checkForBeat(valorIR)) return;
unsigned long ahora = millis();
float lpm = 60000.0 / (ahora - ultimoLatido);
ultimoLatido = ahora;
if (lpm < 20 || lpm > 250) return;
latidos[k] = (byte)lpm;
k = (k + 1) % N;
if (validos < N) { validos++; return; }
int suma = 0;
for (byte i = 0; i < N; i++) suma += latidos[i];
${printRow([['suma / (float)N', 1]])}`
        }),
        spo2Code(['t_ms', 'lectura', 'spo2'])
    ];

    // ---------------- Módulos especializados ----------------
    const M = {};

    M.imu = [
        variant({
            id: 'mpu6050', label: 'MPU6050: pitch y roll por gravedad', title: 'MPU6050: inclinación (pitch y roll) desde el acelerómetro',
            libs: ['Adafruit MPU6050', 'Adafruit Unified Sensor'], includes: ['<Adafruit_MPU6050.h>'], wiring: 'I²C (SDA/SCL), VCC a 3,3–5 V.',
            notes: ['Ángulos estáticos por gravedad: sirven con la barra quieta (así se calibra). No miden yaw.',
                'Verifique ejes y signos: incline la barra hacia adelante y compare con el eje elegido en la Preparación.',
                'Si su firmware usa fusión (Madgwick, DMP), imprima sus ángulos con las mismas columnas.'],
            columns: ['t_ms', 'pitch', 'roll'], period: 20,
            globals: 'Adafruit_MPU6050 mpu;',
            setup: 'if (!mpu.begin()) Serial.println("# no se encontró el MPU6050");\nmpu.setAccelerometerRange(MPU6050_RANGE_2_G);\nmpu.setFilterBandwidth(MPU6050_BAND_21_HZ);',
            loop: `sensors_event_t a, g, temp;\nmpu.getEvent(&a, &g, &temp);\nfloat ax = a.acceleration.x, ay = a.acceleration.y, az = a.acceleration.z;\nfloat pitch = atan2(-ax, sqrt(ay * ay + az * az)) * 180.0 / PI;\nfloat roll = atan2(ay, az) * 180.0 / PI;\n${printRow([['pitch', 3], ['roll', 3]])}`
        }),
        variant({
            id: 'bno055', label: 'BNO055: yaw, pitch y roll (fusión interna)', title: 'BNO055: ángulos de Euler', libs: ['Adafruit BNO055', 'Adafruit Unified Sensor'],
            includes: ['<Wire.h>', '<Adafruit_BNO055.h>'], wiring: 'I²C (SDA/SCL), VIN a 3,3–5 V.',
            notes: ['Espere a que la calibración interna del sistema llegue a 3 (línea “# calibración”).', 'Verifique ejes y signos con la barra inclinada.'],
            columns: ['t_ms', 'yaw', 'pitch', 'roll'], period: 20,
            globals: 'Adafruit_BNO055 bno(55, 0x28);',
            setup: 'if (!bno.begin()) Serial.println("# no se encontró el BNO055");\nbno.setExtCrystalUse(true);',
            loop: `imu::Vector<3> e = bno.getVector(Adafruit_BNO055::VECTOR_EULER);   // x = heading, y = roll, z = pitch
static unsigned long aviso = 0;
if (millis() - aviso > 5000) {
  aviso = millis();
  uint8_t sis, gir, acc, mag;
  bno.getCalibration(&sis, &gir, &acc, &mag);
  Serial.print("# calibración sistema/giro/acel/mag: ");
  Serial.print(sis); Serial.print('/'); Serial.print(gir); Serial.print('/'); Serial.print(acc); Serial.print('/'); Serial.println(mag);
}
${printRow([['e.x()', 3], ['e.z()', 3], ['e.y()', 3]])}`
        })
    ];

    M.imucrudo = [
        variant({
            id: 'mpu6050', label: 'MPU6050: acelerómetro y giroscopio', title: 'MPU6050: aceleración (m/s²) y giro (rad/s) crudos',
            libs: ['Adafruit MPU6050', 'Adafruit Unified Sensor'], includes: ['<Adafruit_MPU6050.h>'], wiring: 'I²C (SDA/SCL), VCC a 3,3–5 V.',
            notes: ['En la Preparación ponga la unidad del acelerómetro en m/s². El giroscopio sale en rad/s.',
                'Sirve para las 6 posiciones (captura el promedio de ax, ay, az) y para grabar los ensayos del giroscopio.'],
            columns: ['t_ms', 'ax', 'ay', 'az', 'gx', 'gy', 'gz'], period: 10,
            globals: 'Adafruit_MPU6050 mpu;',
            setup: 'if (!mpu.begin()) Serial.println("# no se encontró el MPU6050");\nmpu.setAccelerometerRange(MPU6050_RANGE_2_G);\nmpu.setGyroRange(MPU6050_RANGE_250_DEG);',
            loop: `sensors_event_t a, g, temp;\nmpu.getEvent(&a, &g, &temp);\n${printRow([['a.acceleration.x', 4], ['a.acceleration.y', 4], ['a.acceleration.z', 4], ['g.gyro.x', 5], ['g.gyro.y', 5], ['g.gyro.z', 5]])}`
        }),
        variant({
            id: 'hmc5883l', label: 'HMC5883L: magnetómetro', title: 'HMC5883L: campo magnético (µT)', libs: ['Adafruit HMC5883 Unified', 'Adafruit Unified Sensor'],
            includes: ['<Wire.h>', '<Adafruit_HMC5883_U.h>'], wiring: 'I²C (SDA/SCL). Móntelo en su lugar final, lejos de imanes.',
            notes: ['Muchos módulos “GY-271” traen el clon QMC5883L (dirección 0x0D): use la biblioteca QMC5883LCompass con las mismas columnas.'],
            columns: ['t_ms', 'mx', 'my', 'mz'], period: 20,
            globals: 'Adafruit_HMC5883_Unified mag(12345);', setup: 'if (!mag.begin()) Serial.println("# no se encontró el HMC5883L");',
            loop: `sensors_event_t e;\nmag.getEvent(&e);\n${printRow([['e.magnetic.x', 3], ['e.magnetic.y', 3], ['e.magnetic.z', 3]])}`
        })
    ];

    M.balanza = [variant({
        id: 'hx711x4', label: '4 × HX711 (cuentas crudas)', title: 'Plataforma de fuerza: 4 HX711 sincronizados', libs: ['HX711 (bogde)'], includes: ['"HX711.h"'],
        wiring: 'DOUT de las celdas 1–4 a D2, D4, D6, D8; SCK a D3, D5, D7, D9.',
        notes: ['Ponga el pin RATE de cada HX711 en VCC para 80 Hz (en muchos módulos es un puente a soldar).',
            'Sirve para el ensayo estático (captura el promedio de c1…c4) y para grabar el ruido de fondo y el ensayo dinámico.'],
        columns: ['t_ms', 'c1', 'c2', 'c3', 'c4'], capture: { seconds: 2 },
        globals: 'const int DOUT[4] = {2, 4, 6, 8};\nconst int SCK_[4] = {3, 5, 7, 9};\nHX711 hx[4];',
        setup: 'for (int i = 0; i < 4; i++) hx[i].begin(DOUT[i], SCK_[i]);',
        rawLoop: `// Espera a que los 4 tengan dato nuevo: así las muestras quedan lo más juntas posible
if (!(hx[0].is_ready() && hx[1].is_ready() && hx[2].is_ready() && hx[3].is_ready())) return;
unsigned long t = millis();
long c[4];
for (int i = 0; i < 4; i++) c[i] = hx[i].read();
Serial.print(t);
for (int i = 0; i < 4; i++) { Serial.print(','); Serial.print(c[i]); }
Serial.println();`
    })];

    /** Sensor de presión analógico: tensión (V) o cuentas en una o dos entradas. */
    const pressure = (cols, unitOf) => {
        const pins = cols.length === 1 ? 'const int PIN[1] = {A0};' : 'const int PIN[2] = {A0, A1};   // P₁ en A0, P₂ en A1';
        const unitCheck = want => cfg => {
            const u = unitOf(cfg);
            return u && u !== want ? `Este sketch entrega ${want === 'V' ? 'voltios' : 'cuentas del ADC'}, pero la salida configurada está en ${u}.` : null;
        };
        return [
            variant({
                id: 'volt', label: `Tensión en V (${cols.length === 1 ? 'A0' : 'A0 y A1'})`, title: 'Sensor de presión diferencial: tensión de salida',
                wiring: cols.length === 1 ? 'Vout del sensor a A0 (MPX5010DP: pin 1), 5 V y GND.' : 'Vout de P₁ a A0 y de P₂ a A1, 5 V y GND.',
                notes: ['VREF: mida el pin 5V con multímetro y escríbalo en el sketch (el sensor es ratiométrico: su salida también depende de él).', ADC_NOTE],
                check: unitCheck('V'), columns: ['t_ms', ...cols], period: 100,
                globals: `${ADC_GLOBALS(pins, 64)}\nconst float VREF = 5.00;     // mida el pin 5V con multímetro\nconst float CUENTAS = 1023.0; // ESP32: 4095.0`,
                setup: ESP32_RES,
                loop: printRow(cols.map((c, i) => [`leerADC(PIN[${i}]) * VREF / CUENTAS`, 4]))
            }),
            variant({
                id: 'cuentas', label: 'Cuentas del ADC', title: 'Sensor de presión diferencial: cuentas del ADC',
                wiring: cols.length === 1 ? 'Vout del sensor a A0, 5 V y GND.' : 'Vout de P₁ a A0 y de P₂ a A1, 5 V y GND.',
                notes: [ADC_NOTE], check: unitCheck('cuentas'), columns: ['t_ms', ...cols], period: 100,
                globals: ADC_GLOBALS(pins, 64), setup: ESP32_RES,
                loop: printRow(cols.map((c, i) => [`leerADC(PIN[${i}])`, 2]))
            })
        ];
    };
    M.presion = pressure(['V'], cfg => cfg && cfg.sensor && cfg.sensor.outputUnit);
    const calUnit = cfg => cfg && cfg.calA && (cfg.calA.outputUnit || 'V');
    /** Venturi: un sensor diferencial o dos sensores (P₁ y P₂), según la Preparación. */
    const withPressureMode = (v, dos) => ({
        ...v,
        check: cfg => (cfg && cfg.pressureMode && (cfg.pressureMode === 'dos') !== dos
            ? `Este sketch es para ${dos ? 'dos sensores (P₁ y P₂)' : 'un sensor diferencial'}; en la Preparación eligió ${dos ? 'uno diferencial' : 'dos sensores'}.`
            : null) || v.check(cfg)
    });
    M.venturi = [
        ...pressure(['V'], calUnit).map(v => withPressureMode(v, false)),
        ...pressure(['V1', 'V2'], calUnit).map(v => withPressureMode({ ...v, id: v.id + '2', label: v.label.replace(/\(.*\)|$/, '').trim() + ' — dos sensores (P₁ y P₂)' }, true))
    ];
    M.pitot = pressure(['V'], calUnit);

    /** Variantes para el id de un módulo (imu, balanza…) o de un perfil ('sensor-ntc' o 'ntc'). */
    function forModule(id) {
        if (M[id]) return M[id];
        const p = String(id || '').replace(/^sensor-/, '');
        return S[p] || [];
    }

    /** Todos los ids con sketch (para pruebas). */
    const ids = () => [...Object.keys(M), ...Object.keys(S).map(k => `sensor-${k}`)];

    // ---------------- Interfaz ----------------
    /** Tarjeta con selector de variante, notas, código, copiar y descargar .ino. Solo en navegador. */
    function render(el, id, getCfg) {
        const vs = forModule(id);
        const doc = el.ownerDocument;
        const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        if (!vs.length) { el.innerHTML = ''; return; }
        const key = `sketch:${id}`;
        let cur = 0;
        try { cur = Math.max(0, vs.findIndex(v => v.id === localStorage.getItem(key))); } catch (e) { /* sin almacenamiento */ }
        el.classList.add('sketch', 'no-print');
        el.innerHTML = `
            ${vs.length > 1 ? `<div class="field"><label>Sensor / conexión</label><select data-sk-sel>${vs.map((v, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></div>` : ''}
            <div data-sk-body></div>`;
        const body = el.querySelector('[data-sk-body]');
        const show = () => {
            const v = vs[cur];
            const warn = v.check(getCfg ? getCfg() : null);
            body.innerHTML = `
                ${warn ? `<div class="callout warn">${esc(warn)}</div>` : ''}
                <ul class="sk-meta">
                    ${v.wiring ? `<li><strong>Conexión:</strong> ${esc(v.wiring)}</li>` : ''}
                    ${v.libs.length ? `<li><strong>Bibliotecas</strong> (Herramientas → Administrar bibliotecas): ${v.libs.map(esc).join(', ')}</li>` : ''}
                    <li><strong>Salida:</strong> <code>${esc(v.columns.join(','))}</code> a ${BAUD} baudios${v.commands.length ? ` · comandos: ${v.commands.map(c => `<code>${esc(c.cmd)}</code> ${esc(c.label.toLowerCase())}`).join(', ')}` : ''}</li>
                    ${v.notes.map(n => `<li>${esc(n)}</li>`).join('')}
                </ul>
                <div class="actions"><button type="button" data-sk-copy>Copiar código</button><button type="button" data-sk-dl>Descargar .ino</button></div>
                <pre class="sk-code">${esc(v.code)}</pre>`;
            body.querySelector('[data-sk-copy]').addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(v.code); toast('Código copiado', 'ok'); }
                catch (e) { const r = doc.createRange(); r.selectNodeContents(body.querySelector('pre')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); toast('Seleccionado: copie con Ctrl+C', 'info'); }
            });
            body.querySelector('[data-sk-dl]').addEventListener('click', () => {
                // El IDE exige que el .ino esté en una carpeta con su mismo nombre
                const name = `lab_${String(id).replace(/^sensor-/, '')}_${v.id}`.replace(/[^\w]/g, '_');
                root.LabUI.download(`${name}.ino`, v.code, 'text/plain');
                toast(`Guárdelo dentro de una carpeta llamada ${name}`, 'info');
            });
        };
        const sel = el.querySelector('[data-sk-sel]');
        sel && sel.addEventListener('change', () => { cur = +sel.value; try { localStorage.setItem(key, vs[cur].id); } catch (e) { /* */ } show(); });
        show();
    }
    const toast = (m, k) => root.LabUI && root.LabUI.toast(m, k);
    const root = typeof self !== 'undefined' ? self : {};

    /** Variante elegida por el usuario (la misma que muestra la tarjeta). */
    function current(id) {
        const vs = forModule(id);
        if (!vs.length) return null;
        let i = 0;
        try { i = Math.max(0, vs.findIndex(v => v.id === localStorage.getItem(`sketch:${id}`))); } catch (e) { /* */ }
        return vs[i];
    }

    return { BAUD, forModule, ids, render, current, ino };
});
