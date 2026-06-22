# Artificial Analysis Pareto Overlay

Extension/userscript para dibujar una frontera Pareto sobre los graficos scatter de
`https://artificialanalysis.ai/`.

## Opcion 1: extension Chrome/Edge

1. Abre `chrome://extensions` o `edge://extensions`.
2. Activa `Developer mode`.
3. Pulsa `Load unpacked`.
4. Selecciona esta carpeta:

```text
C:\Users\admin\Documents\ParetoAA
```

Tambien funciona seleccionando `C:\Users\admin\Documents\ParetoAA\extension`;
ambas carpetas tienen un manifiesto valido.

## Opcion 2: userscript

Instala Tampermonkey o Violentmonkey y carga:

```text
C:\Users\admin\Documents\ParetoAA\userscript\artificial-analysis-pareto.user.js
```

## Como funciona

- Detecta los puntos SVG de Recharts (`recharts-scatter-symbol`).
- Calcula los puntos no dominados por posicion en el grafico.
- Dibuja una linea escalonada, halos en los puntos Pareto y una etiqueta por grafico.
- Atenua los puntos dominados para que la frontera se vea clara.
- Muestra debajo de cada grafico una tabla ordenada por el mejor `Y` segun el modo configurado, con los puntos Pareto, el nombre del modelo y sus posiciones `X`/`Y`.
- Resalta en verde suave las filas Pareto que caen dentro del cuadrante atractivo cuando el grafico lo marca en verde.
- El panel flotante permite activar/desactivar y cambiar si `X` o `Y` es mejor en valores bajos o altos.
- La tabla intenta convertir posiciones a valores del eje usando los ticks visibles.

Para el ejemplo pegado, el modo automatico deberia elegir `X low` para
`Active Parameters` y `Y high` para `Artificial Analysis Intelligence Index`.
