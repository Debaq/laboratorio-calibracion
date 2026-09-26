/*
 * LabPhys — constantes y propiedades físicas usadas por los módulos.
 * Unidades SI en todas las funciones (salvo que el nombre indique otra cosa).
 */
(function (root, factory) {
    const m = factory();
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.LabPhys = m;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DEG = Math.PI / 180;
    const R_DRY_AIR = 287.058;     // J/(kg·K)
    const G_STANDARD = 9.80665;    // m/s²

    /**
     * Gravedad local (fórmula internacional GRS80 + corrección de aire libre).
     * latDeg: latitud en grados (Valdivia ≈ −39,81), altM: altitud en metros.
     */
    function gLocal(latDeg, altM = 0) {
        const s = Math.sin(latDeg * DEG), s2 = Math.sin(2 * latDeg * DEG);
        return 9.780327 * (1 + 0.0053024 * s * s - 0.0000058 * s2 * s2) - 3.086e-6 * altM;
    }

    /**
     * Densidad del agua pura sin aire disuelto, kg/m³ (Tanaka et al., Metrologia 2001).
     * Válida 0–40 °C, incertidumbre ~0,001 kg/m³.
     */
    function waterDensity(tC) {
        const a1 = -3.983035, a2 = 301.797, a3 = 522528.9, a4 = 69.34881, a5 = 999.974950;
        return a5 * (1 - ((tC + a1) ** 2 * (tC + a2)) / (a3 * (tC + a4)));
    }

    /** Presión de vapor de saturación (Magnus), Pa. */
    function saturationVaporPressure(tC) {
        return 610.94 * Math.exp(17.625 * tC / (tC + 243.04));
    }

    /**
     * Densidad del aire húmedo, kg/m³ (gas ideal con corrección de vapor).
     * pHpa: presión absoluta en hPa, rh: humedad relativa en %.
     */
    function airDensity(tC, pHpa = 1013.25, rh = 50) {
        const p = pHpa * 100;
        const e = (rh / 100) * saturationVaporPressure(tC);
        return (p - 0.378 * e) / (R_DRY_AIR * (tC + 273.15));
    }

    /** Viscosidad dinámica del aire (Sutherland), Pa·s. */
    function airViscosity(tC) {
        const T = tC + 273.15;
        return 1.716e-5 * (T / 273.15) ** 1.5 * (273.15 + 110.4) / (T + 110.4);
    }

    /** Viscosidad dinámica del agua (Vogel), Pa·s. */
    function waterViscosity(tC) {
        return 2.414e-5 * 10 ** (247.8 / (tC + 273.15 - 140));
    }

    /**
     * Viga biapoyada, carga puntual F a distancia a del apoyo izquierdo, luz Ls.
     * Flecha bajo la carga: δ = F a² b² / (3 E I Ls). Devuelve la "compliancia" δ/F en m/N por unidad de 1/EI.
     */
    function simplySupportedCompliance(a, Ls) {
        const b = Ls - a;
        return (a * a * b * b) / (3 * Ls);
    }

    /** Voladizo de largo L con carga F en la punta: flecha en x (m). */
    function cantileverDeflection(F, L, x, EI) {
        return F * x * x * (3 * L - x) / (6 * EI);
    }

    /** Voladizo de largo L con carga F en la punta: giro de la sección en x (rad). */
    function cantileverSlope(F, L, x, EI) {
        return F * x * (2 * L - x) / (2 * EI);
    }

    /** Derivada numérica centrada (útil para propagar incertidumbres). */
    function derivative(f, x, h = 1e-4) {
        return (f(x + h) - f(x - h)) / (2 * h);
    }

    return {
        DEG, R_DRY_AIR, G_STANDARD,
        gLocal, waterDensity, saturationVaporPressure, airDensity,
        airViscosity, waterViscosity,
        simplySupportedCompliance, cantileverDeflection, cantileverSlope,
        derivative
    };
});
