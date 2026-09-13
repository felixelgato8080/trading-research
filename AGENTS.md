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

### La batería vive en `controles.ts`, no en cada herramienta

Dos entradas, según cómo hable la estrategia:

- `evaluar(...)` — la estrategia da **precios**: entrada, stop y objetivo son niveles. La entrada
  es una orden limitada y puede llenarse dentro de su vela, así que importa qué extremo de esa
  vela sigue siendo alcanzable. La usan `smc`, `divergencia` y `zonas`.
- `evaluarPorRiesgo(...)` — la estrategia habla de **riesgo y múltiplos de R**, entrando al
  cierre. La usan `tdfi`, `volumen` y `flujo`. Traduce a la ida y destraduce en el simulador; hay
  una prueba que fija que la traducción no cambia ni un número.

**No escribas una batería nueva.** Estaban copiadas en nueve herramientas y divergieron: una
copia deducía el extremo válido de la vela de entrada del lado **volteado**, y eso daba −0,329R
donde la verdad era −0,022R. Un control roto hace parecer excelente a una estrategia mediocre.

La excepción legítima es un control **más exigente** que el genérico. `ictCli` sortea sus
entradas al azar dentro de la MISMA ventana horaria que la estrategia; cambiarlo por el genérico
sería comparar contra otra cosa. Si tienes uno así, déjalo y di por qué.

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

11. **El hueco también existe en la ENTRADA.** Una orden limitada nunca se llena peor que su
    precio: si la vela abre pasada del nivel, te llenan en la apertura. Cobrarse el nivel pedido
    daba entradas fuera del rango de su propia vela (21 de 790). Y si el hueco se pasó también
    del stop, la operación **no existe**: quedarías largo con el stop por encima de tu llenado.
    Contarlas costaba caro — 14 de 790, varias declarando más de 25R inventados.

12. **El lado del llenado lo fija el VIAJE del precio, no la dirección de la operación.** Misma
    trampa que el extremo de la vela de entrada (trampa 1). Si se deduce de `largo`, una señal
    volteada para usarla de control se llena a otro precio que la original y el control deja de
    comparar las mismas barras.

13. **Entrar al cierre de la vela de la señal es mirar el futuro.** Ese precio ya pasó cuando lo
    ves. El bot en papel lo hacía, y por eso su registro hacia adelante habría salido MEJOR que
    el backtest que debía validarlo — la peor forma de fallar, porque parece una buena noticia.
    Se entra en la apertura de la vela siguiente, igual que el backtest.

---

## LA AUDITORÍA: INVARIANTES, NO CRITERIO

`auditor.ts` comprueba en cada pasada que los números de cada operación sean **posibles**. No
opina sobre si la estrategia es buena; pregunta si el precio de salida existió en alguna vela, si
la entrada era alcanzable, si la salida fue posterior a la entrada y si la R declarada cuadra con
los precios.

Suena tonto y habría cazado cinco de las trece trampas de arriba. De hecho las cazó: pasarle
las 790 operaciones del backtest de divergencias devolvió **107 anomalías** —precios que ninguna
vela llegó a tocar— en un simulador que llevaba meses dando por buenos sus números. Corre en los tres grabadores
(`grabar:smc`, `grabar:divergencia`, `grabar:cripto`) y en el bot, cuesta milisegundos, y si algo
falla el proceso sale con código 1 y el cron se pone rojo.

**Un agente que "revise las operaciones" es menos fiable que una invariante que no puede pasarlas
por alto.** Si se te ocurre una comprobación nueva, añádela ahí con su prueba en negativo — una
operación amañada que la obligue a saltar. Una invariante que nunca se ha visto fallar no está
probada, está esperando.

---

## QUÉ HAY MEDIDO AHORA MISMO

**Sobrevive:** ruptura de volatilidad en cripto diario. 18,9% anual con el coste medido, 38% de
caída máxima, exposición 0,9x. Corriendo en papel.

El 8 sep el universo pasó de **30 a 74 monedas** de Binance. Los filtros, sobre las 150 de más
volumen: ≥730 velas diarias, coste medido en el libro ≤60 pb, y fuera estables, acciones
tokenizadas (`NVDAB`, `TSLAB`…, que siguen a un subyacente con horario de bolsa) y envueltas
duplicadas (`WBTC` es `BTC`). Sube el ritmo de **12 a 26 operaciones al mes**.

**La razón de ampliar es el ritmo del registro hacia adelante, NO el número del backtest.** Sobre
las 45 nuevas el backtest da +0,295R contra +0,135R de las 30 viejas, y **eso no hay que
creérselo**: la lista de hoy son las monedas que sobrevivieron, y las nuevas dan +0,111R en la
primera mitad del calendario y +0,480R en la segunda, que es justo la ventana de la que solo
quedan los supervivientes. El registro hacia adelante no tiene ese sesgo, y por eso lo que
importa es que acumule al doble de velocidad.

**Y la cola manda:** el 5% mejor de las operaciones aporta el 206% del resultado en las 30 viejas
y el 117% en las nuevas; quitándolo, las dos se vuelven negativas. La mediana está en −0,7R. Eso
no es un defecto, es la definición de seguir tendencias —el resto de la familia corta la cola con
un objetivo fijo y por eso pierde— pero significa que la sigma de siempre subestima la muestra
que hace falta, porque la distribución no se parece en nada a una normal.

**Candidato sin demostrar:** SMC en forex 1h (impulso 2,5 ATR, colchón 0,5, objetivo 3R).
Vuelto a medir el 8 sep con el simulador arreglado, 25 pares, 431.675 velas, coste 1 pb:
**+0,036R ±0,049** sobre 1.025 operaciones. Gana al azar por 2,4σ y a la volteada por 2,4σ,
pero **muere en los otros dos controles**: mitades +0,128 y −0,072, y quitando el instrumento
que más aporta se queda en +0,007R. Grabándose hacia adelante en 26 pares.

**Zonas en cripto diario: apretado y NO PASA.** Daba +0,244R sobre 219 operaciones, pasaba la
volteada (2,7σ), las dos mitades y quitar la mejor moneda, y encima era **ejecutable** —stop del
5,62% del precio, así que 9,7% anual con 17% de caída y exposición 0,98x, y aguanta 80 pb de
coste—. Todo eso y aun así no vale, por dos cosas:

- Solo **1,5σ sobre el azar** con n=219, y el umbral de R:R salió de mirar la curva. Ninguno de
  los nueve umbrales probados llega a 2σ.
- **Fuera de muestra pierde.** El mismo código, sin tocar, sobre 30 ETF y 110.397 velas diarias
  (21 años): **−0,226R ±0,146**, peor que el azar por 1,6σ, negativo en las dos mitades y
  −0,309R sin su mejor instrumento. Cada paso de la tabla sale negativo, no solo el final.

No es sesgo largo en ninguno de los dos: en cripto la cesta hizo −3% en el periodo y las dos
direcciones dan positivo; en ETF la cesta hizo +242% y las dos direcciones dan negativo. Es
simplemente que no transfiere.

Se puede argumentar que el impulso de 1,5 ATR está calibrado para cripto y que en ETF mide otra
cosa. Es verdad. Pero buscar ahora el impulso que funcione en ETF es exactamente ajustar a los
datos, así que no se hace.

**Medido y NO implementado — el filtro de noticias.** Bloquear entradas alrededor de eventos de
alto impacto (147 eventos, calendario de TradingView) empeora el resultado en las cuatro ventanas
probadas: a ±120 min lo BLOQUEADO da +0,348R contra +0,090R de lo operado. La noticia es lo que
crea el desplazamiento que la estrategia necesita.

Pero la prueba está ciega donde importa: el backtest usa un coste PLANO de 0,6 pips, y durante una
noticia el spread se abre cinco o diez veces. Rehacerlo cuando el medidor de MT5 tenga una semana
de spreads reales por hora — con el coste de cada momento, la conclusión puede darse la vuelta.

**LO MÁS URGENTE AHORA MISMO — el resultado de `afinado` vive en las horas de peor spread.**
Medido el 12 sep sobre las 440 operaciones, por franja horaria UTC:

| franja | n | %ops | esperanza | aporta | stop | cobrado | tope |
|---|---|---|---|---|---|---|---|
| vuelco 21-01 | 77 | 18% | +0,214R | **38%** | 7,0p | 1,09p | **2,59p** |
| Asia 01-07 | 96 | 22% | +0,183R | **40%** | 7,2p | 0,98p | **2,30p** |
| Londres 07-13 | 139 | 32% | +0,031R | 10% | 10,0p | 1,07p | 1,38p |
| solape 13-17 | 71 | 16% | −0,106R | −17% | 8,4p | 0,97p | ya en cero |
| NY 17-21 | 57 | 13% | +0,228R | 30% | 5,4p | 1,08p | 2,31p |

`tope` = el spread total de ida y vuelta a partir del cual esa franja deja de ganar.

**El 39% de las operaciones entran entre las 21h y las 7h UTC y aportan el 78% del resultado**, y
son las horas de peor spread del día — y encima las de stop más estrecho (7,0 pips contra 10,0
en Londres), así que el peaje pesa el doble justo donde más caro es.

Cuidado con la unidad, que es fácil leerla mal: el backtest cobra **0,6 puntos básicos del
precio**, que en USDJPY a 150 son 0,9 pips y en GBPJPY a 200 son 1,2. El supuesto ya es más
generoso de lo que su nombre sugiere, y aun así el margen que queda es de ~1,3 pips.

Modelando otros spreads (modelo, NO medida — el número de verdad lo dará MT5):

| escenario | esperanza | total | acierto |
|---|---|---|---|
| el supuesto de hoy (~1,0p siempre) | +0,098R | +43,3R | 50% |
| día 1,5p · noche 2,5p | −0,026R | −11,3R | 49% |
| día 1,5p · noche 4p | −0,111R | −48,8R | 49% |
| día 2p · noche 6p | −0,263R | −115,8R | 48% |

En una Standard de XM un cruce JPY no baja de ~1,5-2 pips en el solape y se va a varias veces
eso en el vuelco. **Con eso, `afinado` es negativo.** Y el acierto apenas se mueve entre
escenarios (50% → 46%), así que **mirar el % de acierto en vivo no avisaría**: hay que mirar el
spread por hora, que es exactamente lo que mide `src/mt5/spread.py`.

La defensa mecánica es el stop: a x1,5 el coste pasa del 34% al 23% del riesgo, a x2 al 17%.
Pero ensanchar no es gratis —con objetivo fijo en R el objetivo se aleja igual— y eso se mide
aparte, con el spread real, no con el modelo.

**Medido y descartado el mismo día:** que la divergencia mire *a través* del cierre de fin de
semana (los dos picos del RSI a un lado y otro de un hueco que no se operó). Tienta —51 ops a
−0,126R contra 389 a +0,129R— pero **no pasa los controles**: p=0,076 en permutación y dos de
los cuatro pares van al revés (EURJPY +0,450, GBPJPY +0,150). Es ruido de 51 operaciones.
Y esperar tras la reapertura no protege de nada porque **no hay nada que esperar**: 0 de 440
operaciones entran en la primera hora y solo 12 en las ocho primeras — la señal necesita horas
de velas para formarse. Sólo 2 de 440 se quedan abiertas durante el cierre. El hueco de
reapertura, eso sí, es grande contra nuestro stop: mediana 6,8 pips, p90 17,1, peor 34,2.

**Medido y APUNTADO, no aplicado — la línea 50 del RSI mayor.** De un vídeo de RSI, que la
propone al revés: dice que solo operes a favor del momento, con el RSI por encima de 50 para
largos. Sobre las 440 operaciones de `afinado` da lo contrario:

| en el llenado                        |   n |acierto|esperanza|      |
|--------------------------------------|-----|-------|---------|------|
| el RSI mayor AÚN no ha cruzado 50    | 249 |  55%  | +0,228R | 2,9σ |
| el RSI mayor YA cruzó                | 191 |  43%  | −0,068R | −0,8σ|

Va al revés porque la del vídeo es una estrategia de continuación y ésta es de VUELTA: si el
momento ya giró, la vuelta ya ocurrió y se está comprando el retroceso de un movimiento hecho.

Aguanta los controles: las dos mitades del calendario (+0,25 vs +0,01 y +0,19 vs −0,13), las dos
direcciones, tres de los cuatro pares —**en USDJPY no aparece**, 0,191 vs 0,206 sobre 122
operaciones— y p=0,027 en permutación corrigiendo por los tres umbrales probados. Y **no es el
retraso del llenado disfrazado**: la correlación entre ambos es 0,028, la espera media es la
misma (9,1 vs 8,5 velas) y la brecha sigue dentro de cada tramo de espera.

**No se aplica, se apunta.** La medida es en muestra: sale de mirar las mismas 440 operaciones
que eligieron esta configuración, y hoy se probaron tres familias de ideas, así que el p honesto
ronda 0,08. Cambiar los ajustes invalidaría el registro entero. En vez de eso el grabador guarda
`marca` —el RSI mayor en su última vela cerrada antes de la entrada— en cada operación que abre,
y dentro de dos meses la división se hace sobre operaciones que nadie había visto, emparejadas
una a una y sin gastar una muestra nueva. Desde el 12 sep en `div-afinado` y `div-video`.

**Medido y descartado del mismo vídeo:** el sesgo del RSI diario (operar solo a favor de la
tendencia mayor) no separa nada —a favor +0,083R, en contra +0,115R sobre las mismas 440—; y
exigir 80/20 en vez de 70/30 no mejora de forma distinguible y corta la muestra a la cuarta
parte (110 operaciones, +0,117R, 1,0σ). El tercer sistema del vídeo, la confirmación
multitemporal, es literalmente lo que `div-video` y `div-4h1h` ya hacen.

**Descartado y por qué:** ETF y futuros (apalancamiento), copy-trading de memecoins, RSI de forex
intradía (bruto es PLANO, −0,043R ±0,099, y el peaje se lleva el 28% del riesgo: no hay coste lo
bastante bajo para salvarlo), TDFI (pierde contra su propia volteada por 2,3σ), VWAP, huecos,
momento transversal, ORB, compresión, pares, flujo de órdenes, ICT barrido+IFVG, cripto 1h, la
fórmula de 3 pasos, los parciales, y puntuar confluencias (el resultado por score no es monótono:
score 0 da −1,26R y score 1 da +0,81R).

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
npm run estado -- --bot=RUTA.json                     # TODO lo que esta vivo, en una pantalla
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
