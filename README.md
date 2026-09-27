# Laboratorio de Calibración

Guías y herramientas web para que estudiantes calibren los sensores de un posturógrafo (IMU y plataforma de fuerza) y de sistemas de presión y caudal (Venturi, Pitot). Cada módulo explica el principio físico, genera un **plan de mediciones paso a paso**, calcula error, repetibilidad, histéresis e **incertidumbre (GUM)** y decide si el sensor cumple una tolerancia.

Cada módulo genera además un **protocolo de ensayo en PDF** (botón “Descargar protocolo”): datos del grupo, configuración, instrucciones y hoja de registro con el plan paso a paso para anotar a mano en el laboratorio.

Funciona sin servidor ni internet: abrir `index.html` con doble clic. Los datos se guardan en el navegador (localStorage), con exportación JSON/CSV y respaldo completo.

## Módulos

**Módulos especializados**

| Página | Qué calibra | Modelo |
|---|---|---|
| `imu.html` | Ángulo de una IMU 3/6/9 DOF o inclinómetro en la barra del posturógrafo | θ_ref = asin(d/L) con propagación de incertidumbre; Δ = lectura − cero; Δ = a + b·θ; crosstalk como pendiente; flexión de voladizo; matriz 3×3 A y su inversa |
| `imu-crudo.html` | Acelerómetro, giroscopio y magnetómetro crudos | Acelerómetro: 6 posiciones → S (escala + desalineación) y b; giroscopio: sesgo, desviación de Allan (ARW, inestabilidad), escala por giro conocido; magnetómetro: ajuste de elipsoide (hierro duro y blando) |
| `balanza.html` | Plataforma de 4 celdas + HX711, en 3 ensayos | **Estático**: k_i por equilibrio de fuerzas y momentos; CoP; fluencia. **Ruido de fondo** (CSV): métricas de estabilometría de una carga inmóvil. **Dinámico** (CSV): masa giratoria, R(ω) = (m·r/M)(1 + ω²h/g) |
| `presion.html` | Sensor ΔP con manómetro en U | ΔP = (ρ_agua(T) − ρ_aire)·g(φ,h)·Δh; ajuste V→ΔP con prueba F |
| `venturi.html` / `pitot.html` | Coeficiente de descarga / de Pitot | Q = C_d·A₂·√(2ΔP/(ρ(1−β⁴))); v = C·√(2ΔP/ρ) |

**Catálogo de sensores** (`sensor.html?p=<id>`): un motor genérico + un perfil por sensor. 26 perfiles en 12 familias:
temperatura (NTC, LM35/TMP36, DS18B20, termocupla, PT100, ambientales), humedad (sales saturadas de Greenspan), presión barométrica,
distancia (HC-SR04 con corrección de la velocidad del sonido, ToF, Sharp IR), fuerza (celda + HX711, FSR), eléctricos (ADC, ACS712, INA219),
luz (LDR, BH1750), ángulo (potenciómetro, flex), pH (eficiencia de Nernst), humedad de suelo (gravimétrico), caudal (turbina),
biomédicos (SpO₂ y FC por Bland–Altman) y un sensor genérico de unidades libres.

El motor ofrece: modelos lineal, polinomios, logarítmico, potencia, inverso, Beta y Steinhart–Hart, comparados por AICc;
incertidumbre de predicción; histéresis y repetibilidad; error sin corregir para sensores que ya entregan la magnitud;
modo comparación (Bland–Altman, ARMS, sesgo proporcional); tiempo de respuesta τ desde un escalón (CSV), calculado sobre el
valor calibrado; código C/Arduino de la ecuación. **Agregar un sensor = agregar un perfil** en `js/perfiles/`.

`fundamentos.html` explica los conceptos comunes (error, sesgo, repetibilidad, histéresis, GUM, TUR, conformidad).

## Estructura

```
index.html, fundamentos.html, imu.html, balanza.html, presion.html, venturi.html, pitot.html
css/lab.css                 estilos compartidos (claro/oscuro, impresión)
js/core/
  linalg.js                 mínimos cuadrados QR, inversa
  stats.js                  descriptiva (n−1), t y F, polyfit con covarianza, prueba F
  physics.js                g local, ρ agua (Tanaka 2001), ρ y μ del aire, vigas
  uncertainty.js            tipo A/B, combinada, expandida
  signal.js                 Butterworth de fase cero, círculo, elipsoide, Allan, escalón de 1er orden, estabilometría
  csv.js                    lectura tolerante de CSV (monitor serie, Excel)
  store.js                  persistencia local y respaldo
  ui.js                     formato es-CL, tablas, gráficos SVG sin dependencias
  app.js                    estructura común: Guía → Preparación → Medición guiada → Resultados → Guardados
js/modules/
  *-model.js                matemática pura de cada módulo (testeable en Node)
  *-ui.js                   interfaz de cada módulo
  balanza-series.js         lectura de CSV del Arduino y ensayos de ruido / masa giratoria
  generico-model.js/-ui.js  motor genérico de calibración y comparación (página sensor.html)
  imucrudo-model.js/-ui.js  acelerómetro, giroscopio, magnetómetro
js/perfiles/                registro y perfiles de sensores (datos + guía de cada sensor)
tests/                      pruebas con node:test (núcleo, señales y recuperación de parámetros con datos sintéticos)
```

Principios: se guardan solo **datos crudos** (configuración + mediciones), los resultados se recalculan siempre; SI internamente; scripts clásicos (no módulos ES) para que funcione desde `file://`.

## Pruebas

```bash
npm test        # o: node --test tests/*.test.js
```

Para ver cualquier módulo con datos simulados: abrir `imu.html?ejemplo` (igual para los demás).
