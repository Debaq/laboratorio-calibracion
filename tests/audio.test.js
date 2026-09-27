// Pruebas del análisis de estímulos auditivos (js/modules/audio-model.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../js/modules/audio-model.js');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} esperado ${b}, obtenido ${a}`);

/** WAV PCM entero (16 o 24 bits) armado a mano, para probar el lector. */
function pcmWav(channels, fs, bits) {
    const ch = channels.length, n = channels[0].length, bps = bits / 8, bytes = n * ch * bps;
    const buf = new ArrayBuffer(44 + bytes), dv = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, fs, true); dv.setUint32(28, fs * ch * bps, true);
    dv.setUint16(32, ch * bps, true); dv.setUint16(34, bits, true); w(36, 'data'); dv.setUint32(40, bytes, true);
    let p = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++, p += bps) {
        const v = Math.round(channels[c][i] * 2 ** (bits - 1));
        if (bits === 16) dv.setInt16(p, v, true);
        else { dv.setUint8(p, v & 255); dv.setUint8(p + 1, (v >> 8) & 255); dv.setInt8(p + 2, v >> 16); }
    }
    return buf;
}

function toneBurst({ fs = 48000, f = 1000, dur = 0.1, ramp = 0.01, shape = 'cos2', amp = 0.5, pre = 0.05, post = 0.05 }) {
    const n = Math.round((pre + dur + post) * fs), x = new Float32Array(n), i0 = Math.round(pre * fs);
    const g = { lineal: p => p, cos2: p => Math.sin(Math.PI * p / 2) ** 2 }[shape];
    for (let i = 0; i < Math.round(dur * fs); i++) {
        const t = i / fs, e = t < ramp ? g(t / ramp) : t > dur - ramp ? g((dur - t) / ramp) : 1;
        x[i0 + i] = amp * e * Math.sin(2 * Math.PI * f * t);
    }
    return x;
}

test('WAV: flotante de 32 bits ida y vuelta, 16 y 24 bits', () => {
    const L = Float32Array.from({ length: 100 }, (_, i) => Math.sin(i / 7) * 0.9), R = L.map(v => -v / 2);
    const f32 = A.parseWav(A.encodeWav([L, R], 44100));
    assert.equal(f32.fs, 44100); assert.equal(f32.channels.length, 2); assert.equal(f32.format, 'float');
    assert.deepEqual([...f32.channels[1]], [...R]);
    for (const bits of [16, 24]) {
        const w = A.parseWav(pcmWav([L], 48000, bits));
        assert.equal(w.bits, bits); assert.equal(w.n, 100);
        w.channels[0].forEach((v, i) => close(v, L[i], 2 ** -(bits - 1)));
    }
    assert.throws(() => A.parseWav(new ArrayBuffer(64)), /No es un archivo WAV/);
});

test('FFT coincide con la DFT directa', () => {
    const n = 16, x = Array.from({ length: n }, (_, i) => Math.cos(i) + i / 5);
    const re = Float64Array.from(x), im = new Float64Array(n);
    A.fft(re, im);
    for (let k = 0; k < n; k++) {
        let r = 0, m = 0;
        x.forEach((v, i) => { r += v * Math.cos(2 * Math.PI * k * i / n); m -= v * Math.sin(2 * Math.PI * k * i / n); });
        close(re[k], r, 1e-9); close(im[k], m, 1e-9);
    }
});

test('Tone burst coseno²: duración, rampas, frecuencia y nivel', () => {
    const r = A.analyze(toneBurst({ f: 1000, dur: 0.1, ramp: 0.01, amp: 0.5 }), 48000);
    assert.equal(r.stimuli.length, 1);
    const s = r.stimuli[0];
    assert.equal(s.type, 'tono');
    close(s.f, 1000, 0.01, 'frecuencia');
    close(s.dur0 * 1e3, 100, 0.05, 'duración nominal');
    close(s.dur50 * 1e3, 90, 0.05, 'duración al 50 %');
    assert.equal(s.rampOn.shape, 'cos2'); assert.equal(s.rampOff.shape, 'cos2');
    close(s.rampOn.T * 1e3, 10, 0.05, 'rampa de subida');
    close(s.rise * 1e3, 5.903, 0.02, 'subida 10–90 % de coseno² = 0,5903·T');
    close(s.on50, 0.05 + 0.005, 2e-5, 'inicio al 50 %');
    close(s.rmsDb, -6.021, 0.02, 'seno de amplitud 0,5 = −6,02 dBFS');
    assert.ok(s.thd < 1e-3);
});

test('Rampa lineal se reconoce como lineal', () => {
    const s = A.analyze(toneBurst({ f: 500, dur: 0.2, ramp: 0.005, shape: 'lineal' }), 48000).stimuli[0];
    assert.equal(s.rampOn.shape, 'lineal');
    close(s.rampOn.T * 1e3, 5, 0.05);
    close(s.rise * 1e3, 4, 0.03, '10–90 % de una rampa lineal = 0,8·T');
});

test('Ejemplo: clases, patrones, ISI y gaps en ruido', () => {
    const ex = A.synthExample();
    const r = A.analyze(ex.channels[0], ex.fs);
    const tones = r.stimuli.filter(s => s.type === 'tono');
    assert.equal(tones.length, 18);
    assert.equal(r.stimuli.filter(s => s.type === 'ruido').length, 4);
    const G = r.classes.find(c => c.label === 'G'), Ag = r.classes.find(c => c.label === 'A');
    close(G.f.mean, 880, 0.01); close(Ag.f.mean, 1122, 0.01);
    close(G.dur0.mean * 1e3, 150, 0.05); assert.equal(G.shapeOn, 'cos2');
    assert.deepEqual(r.sequences.slice(0, 6).map(q => q.pattern), ['G-A-G', 'A-A-G', 'G-G-A', 'A-G-A', 'G-A-A', 'A-G-G']);
    r.intervals.filter(v => v.within && v.gap50 > 0.1).forEach(v => close(v.gap50 * 1e3, 210, 0.05, 'ISI al 50 %'));
    const noise = r.sequences[6];
    assert.equal(noise.pattern, 'R-R-R-R');
    [2.5, 5.5, 10.5].forEach((g, i) => close(noise.gaps[i] * 1e3, g, 0.25, `gap ${i + 1}`));
});

test('Asincronía entre canales', () => {
    const x = toneBurst({ f: 1000, dur: 0.1 });
    const y = new Float32Array(x.length);
    y.set(x.subarray(0, x.length - 48), 48); // derecho 1 ms tarde
    const c = A.compareChannels(A.analyze(x, 48000), A.analyze(y, 48000));
    assert.equal(c.pairs.length, 1);
    close(c.dOn.mean * 1e3, 1, 1e-3);
});

test('Separación automática de ítems: salto de razón ≥ 3 más alto', () => {
    close(A.autoSeqGap([0.2, 0.2, 0.21, 6, 6.1]), Math.sqrt(0.21 * 6), 1e-12);
    assert.ok(isNaN(A.autoSeqGap([0.2, 0.25, 0.3])));
});
