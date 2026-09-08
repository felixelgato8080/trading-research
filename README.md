# trading-research

Banco de medición de estrategias de trading. **No hay código de ejecución de órdenes**: no se
conecta a ningún exchange ni bróker, y para que lo hiciera habría que escribirlo, no cambiar una
variable de entorno.

## Qué es esto

Casi todo lo que se prueba aquí no funciona, y el valor del repositorio está justamente en cómo
se demuestra que no funciona. Nueve fallos de medición aparecieron durante el desarrollo —varios
sobrevivieron semanas de revisión— y cada uno cambiaba un número. Están documentados en
[`AGENTS.md`](AGENTS.md), que también sirve de instrucciones para cualquier agente que trabaje
aquí.

Los que más caros salieron:

- **La vela de entrada sólo vale por un lado.** Una orden limitada se llena *dentro* de su vela,
  así que uno de sus dos extremos ya había ocurrido. Contar los dos regalaba objetivos.
- **Un stop estrecho es apalancamiento encubierto.** Un resultado del 5,9% anual exigía 12x de
  exposición; con tope de 1x da 0,2%.
- **El diario de divisas de Yahoo tiene el cuerpo roto**: apertura ≈ cierre, con el 24,7% de las
  velas con cuerpo exactamente cero. Pasa todas las comprobaciones de barra imposible.

## Los controles

Un resultado sin estos no significa nada:

| control | qué contesta |
|---|---|
| azar con el mismo perfil | ¿la ventaja es de las reglas o de la forma del pago? |
| misma señal al revés | ¿aporta acertar el lado? |
| lo que el filtro rechaza | ¿el filtro separa, o sólo recorta la muestra? |
| las dos mitades del calendario | ¿es estable en el tiempo? |
| tope de exposición 1x | ¿el resultado es apalancamiento disfrazado? |

El tercero es el más subestimado: que una versión filtrada salga mejor **no basta**, porque con
menos operaciones cualquier cosa lo parece.

## Los grabadores hacia adelante

`.github/workflows/grabadores.yml` corre cada tres horas y **commitea el estado al repositorio**.
Eso convierte el registro en algo que no se puede retocar sin que se note: cada precio grabado
queda en el historial con su fecha y su hash.

Es la propiedad que hace que estas pruebas valgan más que otro backtest. Las reglas que las
sostienen están en `src/forex/grabador.ts`.

## Uso

```bash
npm install
npm test                                              # 429 pruebas
npm run descargar -- --lista L.json --tf=1h --salida=v.json
npm run sanidad   -- --lista L.json --cache=v.json    # antes de medir nada
npm run divergencia -- --lista L.json --mayor=4h.json --menor=1h.json
```

TypeScript, sin framework de pruebas: `node:test`. El núcleo es puro — toda la lógica de
decisión se prueba sin red y sin dinero.

## Licencia

MIT. Esto es investigación, no consejo financiero, y la mayoría de lo que hay dentro está aquí
porque **no** funcionó.
