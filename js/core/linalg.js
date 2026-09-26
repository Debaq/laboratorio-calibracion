/*
 * LabLinalg — álgebra lineal mínima para los modelos de calibración.
 * Sin dependencias. Funciona en navegador (global LabLinalg) y en Node (require).
 */
(function (root, factory) {
    const m = factory();
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.LabLinalg = m;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function zeros(r, c) {
        return Array.from({ length: r }, () => new Array(c).fill(0));
    }

    function identity(n) {
        const I = zeros(n, n);
        for (let i = 0; i < n; i++) I[i][i] = 1;
        return I;
    }

    function transpose(A) {
        return A[0].map((_, j) => A.map(row => row[j]));
    }

    function matmul(A, B) {
        const r = A.length, n = B.length, c = B[0].length;
        const C = zeros(r, c);
        for (let i = 0; i < r; i++)
            for (let k = 0; k < n; k++) {
                const a = A[i][k];
                if (a === 0) continue;
                for (let j = 0; j < c; j++) C[i][j] += a * B[k][j];
            }
        return C;
    }

    function matvec(A, v) {
        return A.map(row => row.reduce((s, a, j) => s + a * v[j], 0));
    }

    /** Inversa por Gauss-Jordan con pivoteo parcial. Lanza error si es singular. */
    function inv(A) {
        const n = A.length;
        const M = A.map((row, i) => [...row, ...identity(n)[i]]);
        for (let col = 0; col < n; col++) {
            let piv = col;
            for (let r = col + 1; r < n; r++)
                if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
            if (Math.abs(M[piv][col]) < 1e-14) throw new Error('Matriz singular');
            [M[col], M[piv]] = [M[piv], M[col]];
            const p = M[col][col];
            for (let j = 0; j < 2 * n; j++) M[col][j] /= p;
            for (let r = 0; r < n; r++) {
                if (r === col) continue;
                const f = M[r][col];
                if (f === 0) continue;
                for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
            }
        }
        return M.map(row => row.slice(n));
    }

    function solve(A, b) {
        return matvec(inv(A), b);
    }

    /**
     * Mínimos cuadrados min ||A x − b||² por QR (Householder), numéricamente estable.
     * Devuelve x, residuos, RSS, grados de libertad, s² = RSS/df y la covarianza s²(AᵀA)⁻¹.
     */
    function lstsq(A, b) {
        const m = A.length, n = A[0].length;
        if (m < n) throw new Error(`Faltan datos: ${m} ecuaciones para ${n} incógnitas`);
        const R = A.map(row => row.slice());
        const qtb = b.slice();
        let maxDiag = 0;

        for (let k = 0; k < n; k++) {
            let norm = 0;
            for (let i = k; i < m; i++) norm += R[i][k] * R[i][k];
            norm = Math.sqrt(norm);
            if (norm === 0) throw new Error('Sistema singular (columna nula)');
            const alpha = R[k][k] > 0 ? -norm : norm;
            const v = [];
            for (let i = k; i < m; i++) v.push(R[i][k]);
            v[0] -= alpha;
            const vv = v.reduce((s, x) => s + x * x, 0);
            if (vv > 0) {
                for (let j = k; j < n; j++) {
                    let s = 0;
                    for (let i = 0; i < v.length; i++) s += v[i] * R[k + i][j];
                    const f = 2 * s / vv;
                    for (let i = 0; i < v.length; i++) R[k + i][j] -= f * v[i];
                }
                let s = 0;
                for (let i = 0; i < v.length; i++) s += v[i] * qtb[k + i];
                const f = 2 * s / vv;
                for (let i = 0; i < v.length; i++) qtb[k + i] -= f * v[i];
            }
            maxDiag = Math.max(maxDiag, Math.abs(R[k][k]));
        }
        for (let k = 0; k < n; k++)
            if (Math.abs(R[k][k]) < 1e-12 * maxDiag)
                throw new Error('Sistema mal condicionado: los datos no permiten separar todos los parámetros');

        // Retro-sustitución R x = Qᵀb
        const x = new Array(n).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            let s = qtb[i];
            for (let j = i + 1; j < n; j++) s -= R[i][j] * x[j];
            x[i] = s / R[i][i];
        }

        // Inversa de R (triangular superior) → (AᵀA)⁻¹ = R⁻¹ R⁻ᵀ
        const Ri = zeros(n, n);
        for (let i = n - 1; i >= 0; i--) {
            Ri[i][i] = 1 / R[i][i];
            for (let j = i + 1; j < n; j++) {
                let s = 0;
                for (let k = i + 1; k <= j; k++) s += R[i][k] * Ri[k][j];
                Ri[i][j] = -s / R[i][i];
            }
        }
        const AtAinv = matmul(Ri, transpose(Ri));

        const fitted = matvec(A, x);
        const residuals = b.map((bi, i) => bi - fitted[i]);
        const rss = residuals.reduce((s, r) => s + r * r, 0);
        const df = m - n;
        const s2 = df > 0 ? rss / df : NaN;
        const cov = AtAinv.map(row => row.map(v => v * s2));
        return { x, fitted, residuals, rss, df, s2, cov, AtAinv };
    }

    return { zeros, identity, transpose, matmul, matvec, inv, solve, lstsq };
});
