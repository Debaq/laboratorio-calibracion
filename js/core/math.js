/*
 * LabMath — fórmulas con KaTeX (vendor/katex, funciona sin internet).
 * En el HTML se escribe LaTeX entre \( … \) (en línea) o \[ … \] (bloque).
 * Si KaTeX no cargó, el texto LaTeX queda visible (degradación aceptable).
 */
(function (root) {
    'use strict';
    const OPTS = {
        delimiters: [{ left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }],
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option', 'input'],
        throwOnError: false,
        strict: 'ignore'
    };

    /** Renderiza todas las fórmulas dentro de un elemento. */
    function render(el) {
        if (!el || !root.renderMathInElement) return;
        try { root.renderMathInElement(el, OPTS); } catch (e) { console.warn('KaTeX:', e.message); }
    }

    /** HTML de una fórmula (para generar desde JS). */
    function tex(src, display = false) {
        if (root.katex) {
            try { return root.katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore' }); } catch (e) { /* cae al texto */ }
        }
        const esc = String(src).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        return display ? `<div class="tex-fallback">${esc}</div>` : `<code>${esc}</code>`;
    }

    /** Número para LaTeX con coma decimal y notación ×10ⁿ. */
    function num(x, digits = 6) {
        if (!isFinite(x)) return '\\text{—}';
        const a = Math.abs(x);
        if (a !== 0 && (a >= 1e5 || a < 1e-3)) {
            const [m, e] = x.toExponential(digits - 1).split('e');
            return `${String(+m).replace('.', '{,}')}\\times10^{${+e}}`;
        }
        return (+x.toPrecision(digits)).toString().replace('.', '{,}');
    }

    root.LabMath = { render, tex, num };
    if (typeof document !== 'undefined') {
        const run = () => render(document.body);
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
    }
})(typeof self !== 'undefined' ? self : this);
