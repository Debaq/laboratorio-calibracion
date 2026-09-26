# Laboratorio de Calibración

Guías y herramientas web para que estudiantes calibren los sensores de un posturógrafo (IMU y plataforma de fuerza) y de sistemas de presión y caudal (Venturi, Pitot). Cada módulo explica el principio físico, genera un **plan de mediciones paso a paso**, calcula error, repetibilidad, histéresis e **incertidumbre (GUM)** y decide si el sensor cumple una tolerancia.

Funciona sin servidor ni internet: abrir `index.html` con doble clic. Los datos se guardan en el navegador (localStorage), con exportación JSON/CSV y respaldo completo.

## Módulos

| Página | Qué calibra | Modelo |
|---|---|---|
| `imu.html` | Ángulo de un IMU en la barra del posturógrafo | θ_ref = asin(d/L) con propagación de incertidumbre; Δ = lectura − cero; Δ = a + b·θ; crosstalk como pendiente; flexión de voladizo; matriz 3×3 A y su inversa |
| `balanza.html` | Plataforma de 4 celdas + HX711 | Σk_iΔr_i = Mg, Σk_iΔr_i·x_i = Mg·x, Σk_iΔr_i·y_i = Mg·y → k_i por mínimos cuadrados; CoP = ΣF_i·x_i / ΣF_i |
| `presion.html` | Sensor ΔP con manómetro en U | ΔP = (ρ_agua(T) − ρ_aire)·g(φ,h)·Δh; ajuste ΔP = c₀ + c₁V (+c₂V² si prueba F) con incertidumbre de predicción |
| `venturi.html` | Coeficiente de descarga | Q = C_d·A₂·√(2ΔP/(ρ(1−β⁴))); C_d vs Re con regresión ponderada |
| `pitot.html` | Coeficiente del Pitot | v = C·√(2ΔP/ρ) |
| `fundamentos.html` | Conceptos comunes | error, sesgo, repetibilidad, histéresis, GUM, TUR, conformidad |

Venturi y Pitot usan la ecuación del módulo de presión (se elige de los experimentos guardados o se importa como JSON).

## Estructura

```
index.html, fundamentos.html, imu.html, balanza.html, presion.html, venturi.html, pitot.html
css/lab.css                 estilos compartidos (claro/oscuro, impresión)
js/core/
  linalg.js                 mínimos cuadrados QR, inversa
  stats.js                  descriptiva (n−1), t y F, polyfit con covarianza, prueba F
  physics.js                g local, ρ agua (Tanaka 2001), ρ y μ del aire, vigas
  uncertainty.js            tipo A/B, combinada, expandida
  store.js                  persistencia local y respaldo
  ui.js                     formato es-CL, tablas, gráficos SVG sin dependencias
  app.js                    estructura común: Guía → Preparación → Medición guiada → Resultados → Guardados
js/modules/
  *-model.js                matemática pura de cada módulo (testeable en Node)
  *-ui.js                   interfaz de cada módulo
tests/                      pruebas con node:test (núcleo + recuperación de parámetros con datos sintéticos)
legacy/                     versión anterior (referencia; se puede borrar)
```

Principios: se guardan solo **datos crudos** (configuración + mediciones), los resultados se recalculan siempre; SI internamente; scripts clásicos (no módulos ES) para que funcione desde `file://`.

## Pruebas

```bash
npm test        # o: node --test tests/*.test.js
```

Para ver cualquier módulo con datos simulados: abrir `imu.html?ejemplo` (igual para los demás).
