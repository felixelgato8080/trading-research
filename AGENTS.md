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

## LO QUE HACE QUE ESTO PUEDA GANAR: elegir, no ensanchar (14 sep)

Con los spreads reales de XM, **ninguna** combinacion de colchon, objetivo y minRiesgoAtr sale
positiva: 0 de 18. Y la forma dice por que —**ensanchar el stop baja el peaje pero no mejora el
resultado**, porque destruye la señal al mismo ritmo que ahorra coste:

| colchon | peaje | esperanza |
|---|---|---|
| 2 | 35% | −0,175R |
| 4 | 21% | −0,206R |
| 6 | 15% | −0,191R |

**Lo que si funciona es DESCARTAR las señales que nacen con el stop demasiado estrecho.** Misma
aritmetica por fuera, lo contrario por dentro: no se toca ninguna operacion, se dejan de tomar
las que el spread mata.

| tope de peaje | ops | ops/dia | acierto | esperanza | sigma |
|---|---|---|---|---|---|
| sin tope | 163 | 5,3 | 34% | −0,175R | −2,0σ |
| **30% del riesgo** | 64 | 2,1 | 53% | **+0,285R** | 2,1σ |
| 25% | 52 | 1,7 | 52% | +0,319R | 2,1σ |
| 20% | 36 | 1,2 | 56% | +0,396R | 2,3σ |
| 15% | 25 | 0,8 | 52% | +0,363R | 1,9σ |
| 10% | 12 | 0,4 | 58% | +0,438R | 1,6σ |

**Puesto en produccion al 30%** (`--tope-peaje=0.30` en `grabar5.cmd`). Se elige 30 y no 20
porque deja el triple de operaciones y con 31 dias no conviene afinar mas: **lo que hace creible
el efecto es que las seis filas sean positivas**, no cual es la mejor — eso es ruido.

Sigue siendo en muestra y 31 dias. Lo que lo hace defendible es el mecanismo: el peaje ES
spread/stop, y esto quita exactamente las operaciones donde ese cociente es insostenible.

### PERO NO PASA EL CONTROL DE "QUITAR EL MEJOR INSTRUMENTO"

| par | ops | esperanza | suma | % del total |
|---|---|---|---|---|
| **GBPJPY** | 19 | +0,787R | +15,0R | **84%** |
| USDJPY | 22 | +0,145R | +3,2R | 18% |
| AUDJPY | 7 | −0,002R | −0,0R | 0% |
| EURJPY | 15 | −0,025R | −0,4R | −2% |
| TODOS | 63 | +0,282R | +17,8R | |

**Sin GBPJPY: 44 ops, +0,064R, 0,4σ.** O sea, nada.

El +0,285R es un par, diecinueve operaciones, treinta y un dias, y un 79% de acierto que en una
muestra asi es exactamente lo que sale por azar de vez en cuando.

**Que se salva y que no:** el MECANISMO del filtro se sostiene —la direccion es la misma en los
seis umbrales de 10% a 30%, y el peaje es spread/stop por definicion— asi que quitar las
operaciones donde el spread se lleva un tercio del riesgo sigue siendo correcto. Lo que NO se
sostiene es la MAGNITUD: lo honesto es esperar algo entre 0 y +0,06R, no +0,285R.

### Y NINGUN PAR NUEVO AYUDA

Se midieron los 28 pares de forex de XM con spread por debajo de ~6 pips, con el mismo filtro.
De los 14 candidatos nuevos, **ninguno aporta**: o no pasan ni ocho operaciones el filtro, o son
negativos (NZDJPY −0,324R, GBPUSD −0,400R, CHFJPY −0,467R, USDCNH −0,238R). El unico nuevo que
no pierde es EURUSD, con +0,020R sobre 15 operaciones, que es cero.

Y fijarse en el motivo: **no fallan por spread, fallan por señal.** CHFJPY tiene stop de 12,6
pips y peaje del 38% —mejor ratio que USDJPY— y da −0,467R. El spread bajo no crea borde donde
no lo hay.

## LA FOTO COMPLETA SOBRE PRECIOS DE XM (14 sep)

Con el simulador arreglado, las velas del broker y el spread real medido. 12 pares, 31 dias.

**La señal existe, y solo en los cuatro del yen.** Sobre la MISMA ventana y sin coste:

| | ops | acierto | esperanza | sigma |
|---|---|---|---|---|
| Yahoo, 81 dias, 4 pares | 440 | 51% | +0,233R | 3,9σ |
| Yahoo, misma ventana | 147 | 50% | +0,210R | 2,0σ |
| **XM, misma ventana** | 184 | 47% | **+0,170R** | 1,8σ |

Los precios de XM NO eran el problema: la señal vale casi lo mismo que en Yahoo. Lo que da cero
es mezclar los 12 pares (−0,011R): los ocho lentos no tienen señal y arrastran la media.

**El colchon 2 duplica la tolerancia al spread sin costar bruto:**

| colchon | bruto | equilibrio | con el real (2,7-3,8) |
|---|---|---|---|
| 1 (lo que corre) | +0,170R | **~0,9 pips** | −0,423R |
| **2** | +0,175R | **~2,0 pips** | −0,175R |
| 3 | +0,155R | ~2,0 pips | −0,200R |

El mecanismo es claro y no es ajuste a los datos: stop mas ancho, el mismo spread pesa menos.
Y el bruto no baja, que es lo que habria que temer.

**El spread se normalizo en cuanto paso la apertura**, y la mediana de la apertura engañaba:

| hora UTC | USDJPY | GBPJPY | EURJPY | AUDJPY |
|---|---|---|---|---|
| 21h (apertura) | 21,60 | 27,90 | 23,40 | 19,70 |
| 22h | 5,20 | 8,80 | 7,80 | 6,30 |
| 23h | **2,70** | **4,00** | **3,80** | **3,90** |
| 00h | **2,70** | **3,60** | **3,80** | **3,80** |

**Donde queda:** hace falta ≤2,0 pips y hay 2,7-3,8 en sesion asiatica. La distancia es corta,
no un abismo, y **solo tenemos una noche**: falta ver Londres, que es cuando el libro esta lleno.

## EL FALLO MAS GRANDE DEL PROYECTO (13 sep): el precio es un CANAL, no una linea

El simulador trata el precio como una linea y cobra el spread como un descuento al RESULTADO.
La realidad es que el spread cambia **el camino**: que operaciones llegan al objetivo y cuales
no. Las velas de MT5 son BID, y el terminal no ejecuta todo contra el bid:

| | se ejecuta cuando | en velas bid |
|---|---|---|
| compra limitada | ask ≤ nivel | bid ≤ nivel − spread |
| venta limitada | bid ≥ nivel | igual que la vela |
| stop de un largo | bid ≤ stop | igual que la vela |
| **stop de un corto** | **ask ≥ stop** | **bid ≥ stop − spread** |
| objetivo de un corto | ask ≤ objetivo | bid ≤ objetivo − spread |

Para un corto con stop de 7 pips y spread de 5, el stop real esta a **2 pips** de la entrada.

Medido sobre las 440 de `afinado`, aplicando el spread al camino:

| spread | llenadas | acierto | esperanza | total |
|---|---|---|---|---|
| 0 (lo que simula hoy) | 440 | 47% | +0,243R | +107R |
| 1 pip | 433 | 42% | +0,090R | +39R |
| 2 pips | 432 | 34% | −0,113R | −49R |
| 3 pips | 427 | 30% | −0,212R | −90R |
| **5 pips** | 420 | 22% | **−0,407R** | **−171R** |

(Los niveles absolutos son de un simulador simplificado —da +0,243R donde el de produccion da
+0,099R— pero **a spread 0 reproduce exactamente las 440 llenadas**, asi que la degradacion
relativa es la medida buena.)

**Y la mediana medida en XM Standard la primera noche: USDJPY 5,20p · AUDJPY 6,30p · EURJPY
8,00p · GBPJPY 9,30p.** Son la franja mala del domingo, no la semana; pero ni de lejos estan en
el rango donde esto paga.

### ARREGLADO EL 13 SEP, y esta es la medida buena

`simular()` y `señales()` aceptan `spread` (por defecto **0**, para no mover en silencio ningun
numero ya medido). Corrigen los tres niveles a lo que la vela BID tiene que tocar. Con el
simulador de produccion sobre las mismas 440:

| spread | ops | acierto | esperanza | sigma |
|---|---|---|---|---|
| 0 (bruto) | 440 | 51% | +0,233R | 3,9σ |
| 1 pip | 429 | 45% | +0,095R | 1,6σ |
| **1,5 pips** | 429 | 41% | **+0,031R** | 0,5σ |
| 2 pips | 428 | 36% | −0,120R | −2,1σ |
| 3 pips | 419 | 31% | −0,234R | −4,2σ |
| **el medido en XM (5,2-9,3)** | 235 | 22% | **−0,470R** | **−7,2σ** |

**El punto de equilibrio esta en ~1,6 pips.** Por debajo paga; por encima no, y deprisa.

Detalle que importa para no exagerar el hallazgo: a 1 pip la correccion del camino apenas mueve
nada (+0,095R contra el +0,099R que daba el coste plano). **El daño no lo hace la correccion:
lo hace el spread de verdad.** La correccion solo impide seguir creyendo que 5 pips cuestan lo
mismo que 1.

Y con los spreads medidos solo llegan a llenarse **235 de 440**: con el ask 5-9 pips por encima,
la mitad de las compras limitadas no se ejecutan nunca.

**Lo que se sigue:** `afinado` necesita **~1,5 pips o menos**. Una cuenta Standard de XM en
cruces del yen da 5-9. Lo daria una Zero/Raw —~0,2 pips mas comision, que sobre nuestros lotes
son ~1 pip efectivo— y esa es literalmente la diferencia entre que esto funcione o no.

**Esto invalida el numero de todas las medidas anteriores del proyecto**, no solo la de
`afinado`: el simulador es el mismo en todas. No invalida las COMPARACIONES entre variantes,
que se hicieron todas con el mismo sesgo.

---

## QUÉ HAY MEDIDO AHORA MISMO

**EL BACKTEST DE `div-video` PUEDE ESTAR EQUIVOCADO, y hay que mirarlo.** Se grabó como prueba
de falsación —el histórico daba −0,279R sobre 783 operaciones— con la promesa escrita de que si
salía positivo, el roto era el backtest. **Está saliendo positivo.** A 13 sep, 39 cerradas:

| | n | suman | media |
|---|---|---|---|
| ganadoras | 10 | +50,55R | +5,06R |
| perdedoras | 29 | −34,58R | −1,19R |
| **neto** | 39 | **+15,98R** | PF **1,46** |

El 26% de acierto no es un defecto: con la ganadora media 4,25 veces la perdedora, el equilibrio
está en el **19%**. Y el **objetivo de liquidez** —descartado en su día por ser "la peor de las
cuatro variantes"— es justo lo que produce ganadoras de 5R y 10R; un objetivo fijo de 1,5R habría
cortado las ocho mejores. Las pérdidas se concentran en los pares lentos que `afinado` quita
(GBPUSD −8,33R, NZDUSD −4,70, CADJPY −4,40); los cuatro rápidos suman +31,39R.

**Lo que NO es todavía:** 39 operaciones con error ±0,48 no distinguen +0,41R del cero, y el
subconjunto **estricto** —las apuntadas sin retraso, la prueba limpia hacia adelante— va 0 de 8.
Hace falta muestra. Pero la dirección contradice al backtest, que es exactamente lo que este
registro existía para detectar, así que **dejar de mirarlo por estar convencido de lo contrario
sería el error que el registro estaba diseñado para evitar.**


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

El medidor (`src/mt5/spread.py`) se cambió el 12 sep por esto mismo: tomaba **una** foto cada
15 minutos, y un pico de noticia que dura medio minuto tiene un 3% de probabilidad de caer
dentro de esa foto — o sea, no se veía nunca. Ahora toma **8 lecturas de 30 en 30 segundos**
(`--veces`, `--intervalo`), descarta la cotización repetida cuando el tick no se ha movido, y
el informe da un **veredicto** comparando la mediana y el p90 nocturnos contra `--tope` (2,4
pips por defecto). Las tres ramas del veredicto están probadas con registros sintéticos.

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

**Medido y descartado (13 sep) — el TRAILING y el "efecto sierra".** De una guía de MQL5 para
scalping que pasó Felix. Sobre las mismas 440 operaciones, con un simulador propio (su nivel
absoluto no es idéntico al de `simular` —da +0,077R donde el de producción da +0,099R— pero la
comparación entre variantes es interna y sí vale):

| variante | acierto | esperanza |
|---|---|---|
| sin trailing, objetivo 1,5R (lo de hoy) | 50% | **+0,077R** |
| sin trailing, **sin objetivo** | 30% | −0,192R |
| trail desde 0,5R a 0,5R | 45% | −0,075R |
| trail desde 1R a 0,5R | 59% | +0,015R |
| trail desde 1,5R a 0,5R | 49% | +0,038R |
| trail desde 2R a 1R | 41% | −0,028R |

**Ninguna variante de trailing llega al objetivo fijo**, y quitar el objetivo es lo peor de todo
(−0,192R, −2,2σ). Va en la misma dirección que el stop a breakeven, que ya se había medido y era
catastrófico (+35,16R → +7,53R, acierto 40% → 16%): esta señal necesita que la salida esté fija
de antemano. El trailing sube el acierto (59%) y baja la esperanza, que es la firma de cortar
ganadoras para comprar tranquilidad.

**El "efecto sierra"** —exigir que el RSI haya vuelto dentro del canal antes de entrar— también
sale al revés: 434 ops a +0,081R exigiéndolo contra 45 ops a +0,437R (2,4σ) en las que el RSI
seguía fuera de 60/40. Es casi el mismo corte que [la línea 50](#) con otro umbral, así que **no
es evidencia independiente**, pero apunta igual: esta señal es de vuelta y entrar después de que
el momento se normalice es llegar tarde.

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

## DECIDIMOS CON PRECIOS DE YAHOO Y OPERAMOS EN XM (13 sep)

Y no son los mismos precios. Medido sobre ~2.940 velas de 5m por par:

| par | dif media | dif mediana | peor | sobre su stop |
|---|---|---|---|---|
| USDJPY | +0,82p | +0,70p | 9,80p | 9% |
| GBPJPY | +0,93p | +1,10p | **40,00p** | 13% |
| EURJPY | +0,91p | +1,00p | 12,70p | 13% |
| AUDJPY | +1,35p | +1,30p | 9,40p | 19% |

**Las velas SÍ están alineadas**: comparar Yahoo(T) contra XM(T) da 0,84-1,43 pips, y contra
XM(T±5min) da 2,87-4,68. No es un problema de husos ni de etiquetado.

**Es un SESGO CONSTANTE, no ruido**: media y mediana casi idénticas, y siempre en el mismo
sentido — Yahoo por encima de XM. La sospecha razonable es que Yahoo da el MEDIO y MT5 construye
sus velas con el BID, en cuyo caso el sesgo sería medio spread. Cuadra bien en USDJPY (0,82 vs
~0,85 esperado) y AUDJPY (1,35 vs ~1,4), y peor en GBPJPY (0,93 vs ~1,75), **así que el mecanismo
no está confirmado** y no se ha corregido nada a partir de esa suposición.

**Lo que sí se sigue de esto, sin necesidad de explicar el porqué:**

- Para `afinado` (stops de 7-9 pips) el desfase es el 9-19% del riesgo. Molesta, no invalida.
- Para **`div-video` es fatal**: sus stops son de **1,8 pips** y el desfase es de ~1. El nivel de
  entrada calculado en Yahoo no significa gran cosa en el libro de XM. Su registro en papel
  seguirá siendo válido como medida de la señal, pero **su ejecución en MT5 medirá otra cosa**.
- La cobertura (papel contra ejecutado) va a salir baja por esto, no solo por el retraso. Al
  interpretarla hay que tener las dos causas en la cabeza.

**La solución limpia es leer las velas de MT5 en vez de Yahoo** —analizar y ejecutar sobre los
mismos precios— pero cambia la fuente de datos de registros vivos, lo que los invalida como
comparación. Decisión pendiente, no tomada.

---

## DOS TAREAS, NO UNA (13 sep)

`grabar5.cmd` cada **5 minutos**: grabador de `afinado` + ejecutor (~20s).
`grabar.cmd` cada **15**: bot de cripto en pausa, grabador de `video`, medidor de spread, git.

**Por qué se partió.** Midiendo cuántas señales se llenan antes de que el grabador se entere:

| mira cada | pilla | acierto | esperanza | |
|---|---|---|---|---|
| sin retraso | 440 (100%) | 50% | +0,099R | 1,7σ |
| **5 min** | 371 (84%) | 52% | +0,151R | **2,3σ** |
| 15 min | 276 (63%) | 52% | +0,150R | 2,0σ |
| 60 min | 114 (26%) | 48% | +0,065R | 0,6σ |

**El retraso no quita ventaja, quita muestra.** Las 164 que se escapan cada 15 minutos suman
2,3R de 43,8R y aciertan el 47%: las que se llenan más rápido son las peores (−0,178R las
inmediatas). De 15 a 5 son un 34% más de operaciones con la misma ventaja, y la sigma sube de
2,0 a 2,3 solo por muestra.

`video` se queda en 15 porque son 12 pares: a 5 minutos triplicaría las peticiones a Yahoo hasta
~9.200 al día, con riesgo de que empiece a limitar y nos quedemos sin datos por querer más.

**Lo que la concurrencia obligó a arreglar:** los registros se guardan **atómicamente**
(`src/forex/guardar.ts` — escribir al lado y renombrar encima), porque `writeFileSync` trunca y
luego escribe, y con tres procesos leyendo (los dos grabadores, el ejecutor y el `git add`) un
JSON a medias acabaría en el historial de git, que es justo lo que este proyecto usa como prueba
de que los precios no se retocaron. Y el ejecutor **se salta** un registro ilegible en vez de
morirse: dentro de un segundo está bien.

---

## EL EJECUTOR (13 sep) — hay órdenes de verdad, y solo en demo

`src/mt5/ejecutor.py` pone en MT5 las órdenes que `grabarDivergenciaCli` ya decidió. Corre en
la tarea programada cada 15 minutos, después del grabador y antes del git.

**No está porque la estrategia esté lista. NO LO ESTÁ** — ver arriba: +0,099R a 1,7σ, elegido en
muestra, y el 78% del resultado en las horas de peor spread. Está porque **es mejor instrumento
de medida que el muestreador**: una orden real mide el coste de ESA operación (a qué precio
llenó contra el que pidió, cuánto deslizó) en vez de muestrear y esperar acertar el momento.

**No hay meta ni umbral.** Se habló de fijar un listón de ~300 operaciones para pasar a real y
**Felix lo quitó el 13 sep**: *"no quiero ningún objetivo, solo quiero data para ver cómo va la
estrategia, practicarlo en vivo con la demo y cómo mejorarla"*. El informe da números —llenados,
desliz, cerradas por estrategia y por par— y ningún veredicto. Si alguien vuelve a meter un
umbral en la salida, está desobedeciendo una instrucción explícita.

**Ejecutan los DOS registros**, `video` y `afinado`, en una sola llamada. En una sola y no una
por estrategia porque las guardas tienen que ver la cuenta entera: dos ejecuciones separadas se
creerían cada una sola en el mundo y la cuenta acabaría con el doble de posiciones y el doble de
riesgo sin que ninguna hiciera nada mal. La identidad de cada señal lleva la etiqueta delante
(`video:USDJPY:1789…`) porque las dos estrategias pueden dar la misma vela y el mismo par, y son
operaciones distintas: el colchón del stop es 0,1 en una y 1 en la otra.

Las señales NO se calculan ahí. Se leen del registro. En cuanto haya dos sitios que calculen la
señal divergen, y el día que lo hagan nadie se entera porque los dos "funcionan".

**Las guardas, por orden de importancia:**

- **Demo o nada.** Se comprueba `trade_mode` y **no hay bandera que lo desactive**. Si algún día
  hace falta operar en real, se cambia la función a mano y se ve en el diff.
- Sin `--enserio` no manda nada. El modo por defecto es decir lo que haría.
- **El tope que manda es el RIESGO EN HUECO, no el nocional.** El nocional asusta pero mientras
  el stop funcione se pierde lo previsto. Lo que arruina es el hueco. **Medido** sobre 66.982
  saltos entre velas de 5m dentro de la sesión: mediana 0,20 pips · p90 0,80 · p99 2,90 ·
  **p99,9 10,10** · peor 36,50. Se supone el p99,9, que con cientos de posiciones pasa varias
  veces. Tope: 15% del saldo si TODO salta a la vez — los cruces del yen van juntos.
- **No se usa el hueco del fin de semana (34 pips)**: solo lo cruzan 2 de cada 440 operaciones,
  porque cierran en menos de cinco horas. Suponerlo en todas rechazaba **todas** las señales de
  `video`, cuyos stops son de 1,8-1,9 pips.
- **Ninguna posición sola pasa del 2% del saldo en un hueco**, y ese tope va aparte del de
  cartera. Cuando se deducía dividiendo el presupuesto entre el número de posiciones, subir el
  tope de posiciones apretaba el de cada una y empezaba a rechazar stops normales de 7 pips.
- **El nocional AVISA, no corta.** Cortando bloqueaba a `video` en su tercera señal: sus stops de
  1,8 pips dan 20-29x de exposición cada uno, y eso es el colchón 0,1 que la estrategia lleva a
  propósito, no un fallo. Bloquearlo escondía justo los datos que se quieren medir.
- **El spread del instante se apunta en CADA orden** (`spread_pips`, `peaje`), y el filtro
  `--tope-peaje` viene **abierto del todo (1,0)** a propósito: ponerlo en 0,3 —lo que tendría
  sentido para operar— dejaría a `video` sin poner casi ninguna orden, y cerrar esa puerta antes
  de haberla medido es decidir sin datos justo en lo que se quiere medir. Al cierre del viernes
  los cuatro pares daban 41%, 87%, 91% y **121%** del riesgo en spread.
- **Correlación por divisa, no por par.** Los cuatro pares son cruces del yen: cuatro largos no
  son cuatro apuestas, son la misma apuesta puesta cuatro veces, y el tope de posiciones no lo
  ve porque cuenta posiciones y no direcciones. `--tope-divisa` limita el riesgo NETO por divisa
  al 2% del saldo.
- **El tope diario RETIRA las pendientes**, no solo deja de abrir: una limitada puesta media hora
  antes sigue viva y puede llenarse cuando ya se había decidido parar. Lo que no hace es cerrar
  las posiciones abiertas — ésas ya tienen su stop en el bróker, y cerrarlas a mercado cambiaría
  su resultado por una razón que no es la estrategia.
- **Reconciliación cada pasada:** apuntadas que el bróker no tiene ni cerró, y posiciones vivas
  con nuestra marca que no tenemos apuntadas. La segunda es la grave: dinero moviéndose sin que
  el registro lo sepa.
- **Guarda de margen:** no se abre si el margen pedido se come más de la mitad del libre. Diez
  posiciones de `video` son ~250x la cuenta; una operación cerrada por margin call no mide la
  estrategia, mide el tamaño de la cuenta.
- El lote redondea **hacia abajo** y se niega a subir al mínimo del broker, diciendo cuánto
  arriesgaría de verdad. Pasarse del riesgo pedido no es un redondeo: es otra apuesta.
- Tope de posiciones, tope de pérdida diaria leído del historial **del broker** (no del nuestro:
  el ejecutor puede estar apagado cuando salta un stop), y un fichero `PARAR`.

**Medido y NO implementado, de una lista de control de riesgo que pasó Felix el 13 sep:** el
*kill switch* por noticias o por ATR anormal (el filtro de noticias sale al revés: lo bloqueado
da +0,348R contra +0,090R de lo operado; y subir el filtro de ATR quita 3 ganadoras que valen
+20,79R), y el R:R mínimo de 1:2 (`rrMinimo` medido: recorta ganadoras sin mejorar la
esperanza). El **cierre de emergencia por desconexión** tampoco: el stop y el objetivo viven en
el bróker, así que perder la conexión no pone nada en peligro — cerrar a mercado porque se cayó
el portátil añadiría riesgo en vez de quitarlo.

35 pruebas de la lógica pura, que corren sin terminal y sin mercado abierto — el import de
MetaTrader5 es tolerante justo para eso.

**Lo único sin probar contra el servidor es una orden ACEPTADA**, que solo se puede el domingo.
Con el mercado cerrado `order_send` sí llega al broker y devuelve códigos reales (10018 mercado
cerrado, 10015 precio inválido). Por eso los rechazos **de formato** —modo de llenado,
caducidad— se reintentan con la variante siguiente en vez de perder la señal, y los de fondo no.

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
