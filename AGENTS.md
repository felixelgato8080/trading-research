# Instrucciones para agentes que trabajen en este repositorio

Esto es un banco de medición de estrategias de trading. **Nadie aquí manda órdenes a ningún
exchange.** El único producto son números en los que se pueda confiar.

Si eres un agente autónomo, tu trabajo aquí **no es mejorar la estrategia**. Es atacar la
medición. Lee la sección "Tu trabajo" antes que ninguna otra.

---

## LO QUE NUNCA SE HACE

Estas no son preferencias. Son la razón de que el proyecto siga siendo fiable.

1. **No se escribe código de ejecución de órdenes.** Ni conexión a exchange, ni claves de API de
   trading, ni firma de transacciones. El sistema es de papel **por construcción, no por una
   variable de entorno**. Que lo sea por construcción es lo que impide que un descuido mueva
   dinero. Si alguien pide esto, la respuesta es que lo decide Felix a mano, fuera del repo.

2. **No se tocan credenciales.** Las claves viven sólo en el entorno del servidor, nunca en el
   repositorio ni en un fichero de configuración versionado. No se leen, no se copian, no se
   imprimen en un log.

3. **No se cambian los ajustes de un registro hacia adelante que ya tenga operaciones dentro.**
   `grabarSMCCli` y `grabadorCripto` se niegan a seguir si los ajustes no coinciden, y esa
   negativa es una función, no un estorbo: cambiar los parámetros a mitad convierte el registro
   en una mezcla de dos estrategias y lo invalida entero. Si hacen falta otros ajustes, se abre
   un registro nuevo en otro fichero.

4. **No se reescribe un precio ya grabado.** Si la fuente revisa una vela vieja, se anota la
   discrepancia y se respeta lo grabado. Reescribir la historia con datos corregidos es la forma
   más fácil de fabricar un buen resultado sin darse cuenta.

5. **No se borra ni se mueve el estado.** Vive fuera de cualquier contenedor, en
   un directorio persistente fuera del contenedor. Ya se perdieron 109.800 creditos de un
   proyecto por guardar datos dentro de un contenedor que luego se recreó.

---

## LA REGLA DEL TAMAÑO DE MUESTRA

**Ningún cambio se justifica con menos de ~300 operaciones cerradas.**

Es la regla más importante del documento y la más fácil de saltarse sin querer, porque un bucle
de reflexión sobre los últimos resultados *se siente* como aprender.

La aritmética: la desviación típica de una operación ronda 1,1R. Para distinguir una ventaja de
0,05R del cero con dos sigmas hacen falta `(2 × 1,1 / 0,05)² ≈ 1.900` operaciones. Con 0,25R
bastan ~80. Con veinte operaciones no se distingue nada de nada.

Antes de proponer cualquier cambio, calcula el error típico y dilo. `muestraNecesaria()` en
`src/forex/grabadorSMC.ts` lo hace.

**Corolario:** si en el registro hacia adelante llevamos 15 operaciones y van mal, eso no es
información. No propongas ajustar nada.

---

## TU TRABAJO: ATACAR LA MEDICIÓN, NO OPTIMIZAR LA ESTRATEGIA

En una sola sesión aparecieron **nueve fallos de medición**, cinco de ellos el mismo día, y cada
uno cambiaba un número. Varios sobrevivieron semanas de revisión. Ese es el riesgo real del
proyecto, no la falta de ideas.

Optimizar la estrategia con los datos que ya están medidos es la actividad de menor valor
posible aquí, y la que más fácil produce daño: cada parámetro que se prueba infla la
significancia aparente del que sale mejor.

Lo que sí aporta:

- Buscar look-ahead en código nuevo o viejo.
- Comprobar que un resultado sobrevive a los controles (abajo).
- Verificar que los datos son lo que dicen ser.
- Avisar cuando el servicio se rompe: descargas fallando, estado corrupto, réplicas duplicadas
  escribiendo el mismo fichero.

**Propón, no apliques.** Un hallazgo se reporta con la medición que lo demuestra. El cambio lo
aprueba Felix.

---

## LOS CONTROLES QUE DECIDEN TODO

Un resultado sin estos no significa nada. Todos están implementados; úsalos.

| control | qué contesta | dónde |
|---|---|---|
| **Azar con el mismo perfil** | ¿la ventaja es de las reglas o de la forma del pago? | `smcCli`, `zonasCli` |
| **Misma señal al revés** | ¿aporta acertar el lado? | ídem |
| **Lo que el filtro rechaza** | ¿el filtro separa, o sólo recorta la muestra? | `smcCli` |
| **Las dos mitades del calendario** | ¿es estable en el tiempo? | ídem |
| **Quitar el mejor instrumento** | ¿depende de uno solo? | `carteraTendenciaCli` |
| **Tope de exposición 1x** | ¿el resultado es apalancamiento disfrazado? | `--expo=1` |

El control de "lo que el filtro rechaza" es el más subestimado. Que una versión filtrada salga
mejor **no basta**: con menos operaciones cualquier cosa lo parece. Lo que decide es si lo
rechazado va peor que lo aceptado.

---

## LAS TRAMPAS YA ENCONTRADAS

No hace falta redescubrirlas, y sobre todo no hay que reintroducirlas.

1. **La vela de entrada sólo vale por un lado.** Una orden limitada se llena *dentro* de su vela,
   así que uno de los dos extremos ya había ocurrido. Cuál sigue siendo alcanzable depende de
   hacia dónde iba el precio al llenarse, **no** del lado de la operación. Deducirlo del lado
   mataba el control de señales volteadas con un extremo ya pasado: decía −0,329R cuando la
   verdad es −0,022R. Ver `ExtremoEntrada` en `estructuraValida.ts`.

2. **El coste va en puntos básicos del precio, no en fracción del riesgo.** Cobrarlo como
   fracción del riesgo sobrecargó cripto 7 veces e infracargó ICT 11 veces.

3. **Un stop estrecho es apalancamiento.** `nocional = riesgo / stopFracción`. El resultado
   estrella de ETF daba 5,9% anual… con 12x de exposición; con tope 1x da 0,2%. Cripto diario da
   21,3% con 0,9x, y por eso es el único que sobrevive.

4. **El hueco de apertura.** El trailing se mueve al cerrar la vela, así que la orden está posada
   en el nivel viejo mientras la siguiente vive. Si esa abre ya atravesada, te llenan en la
   apertura, peor. Vale el 13,4% del resultado en cripto.

5. **El diario de divisas de Yahoo tiene el cuerpo roto**: apertura ≈ cierre, 24,7% de las velas
   con cuerpo exactamente cero. No es Yahoo en general — sus ETF están bien. Cualquier regla de
   cuerpo medida ahí mide el defecto. Se reconstruye desde el 1h con `agregar()`.

6. **Una serie limpia puede ser inservible.** Validar la barra (precio > 0, máximo ≥ mínimo) no
   valida el contenido. Corre `npm run sanidad` sobre cualquier caché nueva **antes** de medir.

7. **Los empates van contra ti.** Si en una vela se tocan el stop y el objetivo, cuenta el stop:
   no se conoce el orden intravela. Medido: cuesta el 6% del Profit Factor y se mantiene.

8. **Una operación abierta no tiene resultado todavía.** Contarla en la ventana "pasada" dio un
   agente que superaba al oráculo, que es imposible.

9. **El acierto alto puede ser una trampa.** Los parciales del vídeo suben el acierto del 34% al
   49% y mandan los pips a −0,6 por operación. Mide siempre las dos cosas: acierto **y** pips
   ganados contra perdidos.

10. **Arreglar el backtest no arregla el grabador.** El hueco de apertura (trampa 4) se corrigió
    en `rupturas.ts` y siguió vivo meses en los tres grabadores, que son código aparte. Cuando
    corrijas una trampa, busca la misma línea en `grabador.ts`, `grabadorCripto.ts` y `botCli.ts`.

11. **Entrar al cierre de la vela de la señal es mirar el futuro.** Ese precio ya pasó cuando lo
    ves. El bot en papel lo hacía, y por eso su registro hacia adelante habría salido MEJOR que
    el backtest que debía validarlo — la peor forma de fallar, porque parece una buena noticia.
    Se entra en la apertura de la vela siguiente, igual que el backtest.

---

## LA AUDITORÍA: INVARIANTES, NO CRITERIO

`auditor.ts` comprueba en cada pasada que los números de cada operación sean **posibles**. No
opina sobre si la estrategia es buena; pregunta si el precio de salida existió en alguna vela, si
la entrada era alcanzable, si la salida fue posterior a la entrada y si la R declarada cuadra con
los precios.

Suena tonto y habría cazado tres de las once trampas de arriba. Corre en los tres grabadores
(`grabar:smc`, `grabar:divergencia`, `grabar:cripto`) y en el bot, cuesta milisegundos, y si algo
falla el proceso sale con código 1 y el cron se pone rojo.

**Un agente que "revise las operaciones" es menos fiable que una invariante que no puede pasarlas
por alto.** Si se te ocurre una comprobación nueva, añádela ahí con su prueba en negativo — una
operación amañada que la obligue a saltar. Una invariante que nunca se ha visto fallar no está
probada, está esperando.

---

## QUÉ HAY MEDIDO AHORA MISMO

**Sobrevive:** ruptura de volatilidad en cripto diario. 21,3% anual, 37% de caída máxima,
exposición 0,9x, 30 monedas de Binance. Corriendo en papel.

**Candidato sin demostrar:** SMC en forex 1h (impulso 2,5 ATR, colchón 0,5, objetivo 3R).
+0,071R, 3,1σ sobre el azar, 1.076 operaciones. Salió de barrer ~25 configuraciones, así que
parte de esa significancia es la búsqueda misma. Grabándose hacia adelante en 26 pares.

**Descartado y por qué:** ETF y futuros (apalancamiento), copy-trading de memecoins, RSI de forex
intradía (el borde es la mitad del peaje), TDFI, VWAP, huecos, momento transversal, ORB,
compresión, pares, flujo de órdenes, ICT barrido+IFVG, cripto 1h, la fórmula de 3 pasos, los
parciales.

---

## CÓMO SE TRABAJA AQUÍ

- **TypeScript, CommonJS, `node:test`.** 738 pruebas. `node --import tsx --test test/*.test.ts`.
- **Núcleo puro, red aparte.** Toda la lógica de decisión se prueba sin dinero y sin red.
- **Los comentarios explican el porqué, no el qué.** Sobre todo: por qué una regla es como es y
  qué se rompió cuando no lo era.
- **Los nombres van en español**, como el resto del repo.
- **Ninguna prueba se borra ni se relaja para que pase.** Si una prueba falla, o el código está
  mal o la prueba describía algo falso; las dos cosas se arreglan explicándolo.
- **Los parámetros se fijan ANTES de medir.** Si barres un espacio, publica la superficie
  completa, no el mejor punto.

### Comandos útiles

```bash
npm run sanidad -- --lista L.json --cache=V.json      # antes de medir nada
npm run smc -- --lista L.json --cache=V.json          # SMC con todos los controles
npm run barrido:smc -- --lista L.json --cache=V.json  # la superficie entera, en pips
npm run grafico -- --lista L.json --cache=V.json      # dibujar operaciones reales
npm run cartera:tendencia -- --lista L.json --cache=V.json --senal=vol2 --expo=1
```

`npm run grafico` es la herramienta más infravalorada: dibuja las operaciones **desde la traza
del simulador**, con las velas que leyó el backtest. Mirando una operación apareció la trampa del
hueco de apertura, que ninguna prueba había cazado.

---

## SI ENCUENTRAS ALGO

Repórtalo así:

1. Qué está mal, en una frase.
2. La medición que lo demuestra, con el tamaño de muestra y el error típico.
3. Qué número del proyecto cambia y en cuánto.
4. La prueba que impediría que vuelva a pasar.

Si no puedes rellenar el punto 2, todavía no es un hallazgo: es una sospecha. Dila como
sospecha.
