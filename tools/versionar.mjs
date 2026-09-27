#!/usr/bin/env node
/*
 * Versionado de recursos (cache busting).
 * Reescribe en todos los HTML las referencias a css/, js/ y vendor/ como  archivo.css?v=<hash del contenido>.
 * Si un archivo cambia, cambia su URL y el navegador lo vuelve a descargar; si no cambia, sigue en caché.
 * También escribe la versión de package.json entre <!--version--> … <!--/version-->.
 *
 *   node tools/versionar.mjs           actualiza los HTML e imprime los que cambiaron
 *   node tools/versionar.mjs --check   no escribe; termina con error si algún HTML está desactualizado
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const hashCache = new Map();

function hashOf(rel) {
    if (!hashCache.has(rel)) {
        const file = path.join(ROOT, rel);
        hashCache.set(rel, fs.existsSync(file) ? crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 8) : null);
    }
    return hashCache.get(rel);
}

export function stamp(html) {
    const missing = [];
    let out = html.replace(/(src|href)="((?:css|js|vendor)\/[^"?#]+)(\?v=[^"]*)?"/g, (m, attr, rel) => {
        const h = hashOf(rel);
        if (!h) { missing.push(rel); return m; }
        return `${attr}="${rel}?v=${h}"`;
    });
    out = out.replace(/<!--version-->[\s\S]*?<!--\/version-->/g, `<!--version-->v${version}<!--/version-->`);
    return { out, missing };
}

const pages = fs.readdirSync(ROOT).filter(f => f.endsWith('.html'));
const changed = [], missingAll = [];
for (const f of pages) {
    const file = path.join(ROOT, f);
    const html = fs.readFileSync(file, 'utf8');
    const { out, missing } = stamp(html);
    missing.forEach(m => missingAll.push(`${f}: ${m}`));
    if (out !== html) {
        changed.push(f);
        if (!check) fs.writeFileSync(file, out);
    }
}
if (missingAll.length) { console.error('Recursos inexistentes:\n  ' + missingAll.join('\n  ')); process.exit(2); }
if (check && changed.length) {
    console.error(`HTML con versiones desactualizadas: ${changed.join(', ')}\nEjecute: npm run versionar`);
    process.exit(1);
}
if (changed.length) console.log(changed.join('\n'));
