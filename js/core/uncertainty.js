/*
 * LabUnc — incertidumbre según la GUM (JCGM 100:2008), versión docente.
 *  - Tipo A: estadística de repeticiones (s/√n).
 *  - Tipo B: resolución, especificaciones, certificados.
 *  - Combinada: raíz de la suma de cuadrados (entradas no correlacionadas).
 *  - Expandida: U = k · u_c  (k = 2 → ~95 %).
 */
(function (root, factory) {
    const m = factory();
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.LabUnc = m;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /** Resolución de un instrumento (división mínima δ) → distribución rectangular de ancho δ: u = δ/√12. */
    const fromResolution = res => res / Math.sqrt(12);

    /** Tolerancia ±a (especificación del fabricante) → rectangular: u = a/√3. */
    const fromTolerance = a => a / Math.sqrt(3);

    /** Incertidumbre expandida declarada en un certificado (U, k) → u = U/k. */
    const fromExpanded = (U, k = 2) => U / k;

    /** Tipo A de la media de n lecturas. */
    const typeA = (s, n) => s / Math.sqrt(n);

    /** Combina incertidumbres independientes (ya multiplicadas por su coeficiente de sensibilidad). */
    const combine = (...us) => Math.sqrt(us.flat().reduce((s, u) => s + (isFinite(u) ? u * u : 0), 0));

    const expanded = (uc, k = 2) => k * uc;

    return { fromResolution, fromTolerance, fromExpanded, typeA, combine, expanded };
});
