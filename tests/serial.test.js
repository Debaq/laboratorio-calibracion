// Pruebas de la lectura por Web Serial (intérprete de líneas, estadísticas, asignación de columnas) y de los sketches de Arduino.
const test = require('node:test');
const assert = require('node:assert/strict');
const LS = require('../js/core/serial.js');
const SK = require('../js/core/sketches.js');
const R = require('../js/perfiles/registry.js');
for (const f of ['temperatura', 'humedad', 'distancia', 'fuerza-electricos', 'varios', 'biomedicos']) require(`../js/perfiles/${f}.js`);

test('serial: encabezado, datos, avisos y coma decimal', () => {
    const p = LS.createParser();
    assert.deepEqual(p.push('t_ms,lectura,temp'), { type: 'header', headers: ['t_ms', 'lectura', 'temp'] });
    assert.deepEqual(p.push('1200,512.25,21.5\r'), { type: 'data', values: [1200, 512.25, 21.5] });
    assert.deepEqual(p.push('# no se encontró el SHT31'), { type: 'msg', text: 'no se encontró el SHT31' });
    assert.equal(p.push('   '), null);
    assert.deepEqual(p.push('1300;512,5;21,4'), { type: 'data', values: [1300, 512.5, 21.4] });
    // Texto libre de otros sketches: aviso, no encabezado
    assert.equal(p.push('Temperatura: 21.5 C').type, 'msg');
    assert.deepEqual(p.headers, ['t_ms', 'lectura', 'temp']);
});

test('serial: sin encabezado las columnas se llaman col1…; al cambiar el ancho se renombran', () => {
    const p = LS.createParser();
    p.push('1,2');
    assert.deepEqual(p.headers, ['col1', 'col2']);
    p.push('1,2,3');
    assert.deepEqual(p.headers, ['col1', 'col2', 'col3']);
    assert.deepEqual(p.push('lectura').headers, ['lectura']);
    assert.deepEqual(p.push('42'), { type: 'data', values: [42] });
});

test('serial: media, desviación estándar (n−1) y último valor', () => {
    const r = LS.summarize([[0, 1], [10, 2], [20, 3], [30, 6]], 2);
    assert.equal(r.n, 4);
    assert.equal(r.mean[1], 3);
    assert.ok(Math.abs(r.sd[1] - Math.sqrt(14 / 3)) < 1e-12);
    assert.deepEqual([r.min[1], r.max[1]], [1, 6]);
    assert.deepEqual(r.last, [30, 6]);
});

test('serial: asignación automática de columnas a campos', () => {
    const fields = [{ key: 'ref' }, { key: 'reading', serial: ['lectura'], serialAuto: true }, { key: 'temp' }];
    assert.deepEqual(LS.autoMap(fields, ['t_ms', 'lectura', 'temp']), { reading: 'lectura', temp: 'temp' });
    // Sin nombres reconocibles: la lectura toma la única columna libre que no es tiempo
    assert.deepEqual(LS.autoMap(fields, ['millis', 'col2']), { reading: 'col2' });
    assert.deepEqual(LS.autoMap([{ key: 'ax' }, { key: 'ay' }, { key: 'az' }], ['t_ms', 'ax', 'ay', 'az', 'gx', 'gy', 'gz']), { ax: 'ax', ay: 'ay', az: 'az' });
    assert.ok(LS.isTime('t_ms') && LS.isTime('millis') && !LS.isTime('temp'));
});

test('sketches: todos los perfiles del catálogo tienen código', () => {
    const faltan = R.list().filter(p => !SK.forModule(`sensor-${p.id}`).length).map(p => p.id);
    assert.deepEqual(faltan, []);
});

test('sketches: estructura válida y salida acorde al encabezado', () => {
    for (const id of SK.ids()) {
        const vs = SK.forModule(id);
        assert.equal(new Set(vs.map(v => v.id)).size, vs.length, `${id}: ids de variante repetidos`);
        for (const v of vs) {
            const name = `${id}/${v.id}`;
            const c = v.code;
            const count = ch => c.split(ch).length - 1;
            assert.equal(count('{'), count('}'), `${name}: llaves desbalanceadas`);
            assert.equal(count('('), count(')'), `${name}: paréntesis desbalanceados`);
            assert.match(c, /void setup\(\)/, name);
            assert.match(c, /void loop\(\)/, name);
            assert.ok(c.includes(`Serial.begin(${SK.BAUD})`), `${name}: baudios`);
            assert.ok(c.includes(`Serial.println(F("${v.columns.join(',')}"))`), `${name}: encabezado`);
            assert.equal(v.columns[0], 't_ms', `${name}: la primera columna es el tiempo`);
            // Cada línea de datos: millis() + una coma por columna restante
            const commas = (c.match(/Serial\.print\(','\)/g) || []).length;
            if (!/for \(int i = 0; i < 4; i\+\+\) \{ Serial\.print\(','\)/.test(c))
                assert.equal(commas, v.columns.length - 1, `${name}: ${commas} comas para ${v.columns.length} columnas`);
            assert.ok(['mean', 'last'].includes(v.capture.stat) && v.capture.seconds > 0, `${name}: captura`);
        }
    }
});

test('sketches: las columnas coinciden con los campos de cada módulo', () => {
    const cols = id => new Set(SK.forModule(id).flatMap(v => v.columns));
    for (const k of ['ax', 'ay', 'az', 'gx', 'gy', 'gz', 'mx', 'my', 'mz']) assert.ok(cols('imucrudo').has(k), `imucrudo: ${k}`);
    for (const k of ['c1', 'c2', 'c3', 'c4']) assert.ok(cols('balanza').has(k), `balanza: ${k}`);
    for (const k of ['pitch', 'roll', 'yaw']) assert.ok(cols('imu').has(k), `imu: ${k}`);
    assert.ok(cols('presion').has('V'));
    for (const k of ['V', 'V1', 'V2']) assert.ok(cols('venturi').has(k), `venturi: ${k}`);
    // Los campos extra de los perfiles con nombre de columna
    assert.ok(cols('sensor-hr').has('temp'));
    assert.ok(cols('sensor-yfs201').has('time_s'));
    for (const id of SK.ids().filter(i => i.startsWith('sensor-')))
        assert.ok(SK.forModule(id).every(v => v.columns[1] === 'lectura'), `${id}: la lectura va en la columna "lectura"`);
});

test('sketches: advierten si el modo de lectura no coincide', () => {
    const ntc = SK.forModule('sensor-ntc')[0];
    assert.equal(ntc.check({ readingMode: 'divisor' }), null);
    assert.match(ntc.check({ readingMode: 'ohm' }), /divisor/);
    const [volt] = SK.forModule('presion');
    assert.equal(volt.check({ sensor: { outputUnit: 'V' } }), null);
    assert.match(volt.check({ sensor: { outputUnit: 'cuentas' } }), /voltios/);
    const dos = SK.forModule('venturi').find(v => v.columns.includes('V1'));
    assert.match(dos.check({ pressureMode: 'diferencial', calA: { outputUnit: 'V' } }), /dos sensores/);
    assert.equal(dos.check({ pressureMode: 'dos', calA: { outputUnit: 'V' } }), null);
});
