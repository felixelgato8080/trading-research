/**
 * AUDITORIA: ¿está mal el código o está mal el mercado?
 *
 * Felix pregunta lo correcto: si casi todo sale negativo, ¿no estaremos confundiendo valores?
 * Toda la investigación se ha apoyado en controles NEGATIVOS (entradas al azar) y en ninguno
 * POSITIVO. Eso es una laguna real: un simulador roto que devolviera siempre pérdidas pasaría
 * todos los controles negativos sin problema.
 *
 * Aquí van las dos mitades que faltaban:
 *
 *   1. INDICADORES contra referencias publicadas, no contra mí mismo.
 *   2. CONTROLES POSITIVOS: series de precios amañadas donde la estrategia está OBLIGADA a
 *      ganar. Si el simulador no encuentra beneficio ahí, está roto y todo lo demás sobra.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { esVelaValida, limpiarVelas, type Vela } from "../src/forex/datos";
import { rsi } from "../src/forex/rsi";
import { atr } from "../src/forex/multiTf";
import { canal, volatilidad, simularRuptura } from "../src/forex/rupturas";
import { retrocesoEnTendencia, simularReversion } from "../src/forex/reversion";
import { simularObjetivo, type SeñalTdfi } from "../src/forex/tdfi";

const DIA = 86400;
const vela = (i: number, o: number, h: number, l: number, c: number): Vela =>
  ({ t: i * DIA, o, h, l, c });

// ---------------------------------------------------------------------------------------
// 1. INDICADORES CONTRA REFERENCIAS PUBLICADAS
// ---------------------------------------------------------------------------------------

/** Serie canónica de Wilder, la que reproducen StockCharts y los libros de referencia. */
const WILDER = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433,
  46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028, 46.0328, 46.4116,
  46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288,
  44.1783, 44.2181, 44.5714, 43.4204, 42.6628, 43.1314,
];

/** Valores publicados del RSI(14) para esa serie. */
const RSI_PUBLICADO: Array<[number, number]> = [
  [14, 70.53], [15, 66.32], [16, 66.55], [17, 69.41], [18, 66.36], [19, 57.97],
  [20, 62.93], [21, 63.26], [22, 56.06], [23, 62.38], [24, 54.71], [25, 50.42],
  [26, 39.99], [27, 41.46], [28, 41.87], [29, 45.46], [30, 37.30], [31, 33.08],
  [32, 37.77],
];

test("EL RSI COINCIDE CON LA TABLA PUBLICADA DE WILDER, los 19 valores", () => {
  // Tolerancia 0,05 sobre una escala de 0 a 100, o sea 0,05%. Las tablas publicadas parten de
  // precios redondeados a 2 decimales y los valores a 2 decimales, asi que un desvio de ese
  // orden es del REDONDEO DE LA REFERENCIA, no del calculo.
  const v = rsi(WILDER, 14);
  let exactos = 0;
  for (const [i, esperado] of RSI_PUBLICADO) {
    assert.ok(v[i] != null, `el valor ${i} salió null`);
    const d = Math.abs(v[i]! - esperado);
    if (d < 0.005) exactos += 1;
    assert.ok(d < 0.05, `posición ${i}: calculado ${v[i]!.toFixed(3)}, publicado ${esperado}`);
  }
  // Lo que de verdad prueba que el algoritmo es el correcto: la mayoria clava el valor.
  assert.ok(exactos >= 15, `solo ${exactos} de 19 coinciden a la milésima`);
});

test("EL DESVIO DEL RSI NO SE ACUMULA, que es como se detecta un fallo real", () => {
  // El suavizado de Wilder es recursivo: un error de calculo se arrastra y CRECE. Si el desvio
  // aparece en un punto y luego encoge, viene del redondeo de la referencia, no del codigo.
  const v = rsi(WILDER, 14);
  const desvios = RSI_PUBLICADO.map(([i, e]) => Math.abs(v[i]! - e));
  const ultimos = desvios.slice(-4);
  const maximo = Math.max(...desvios);
  assert.ok(
    Math.max(...ultimos.slice(1)) < maximo,
    "el desvio deberia encoger tras su pico, no arrastrarse",
  );
  assert.ok(maximo < 0.05, `el desvio maximo fue ${maximo.toFixed(3)}`);
});

test("el RSI NO se calcula con media simple, que es el error clásico", () => {
  // Con media simple en vez de Wilder el valor 32 sale claramente distinto. Esta prueba
  // detectaría que alguien "simplifique" el suavizado.
  const v = rsi(WILDER, 14);
  assert.ok(Math.abs(v[32]! - 37.77) < 0.02);
  assert.ok(Math.abs(v[32]! - 43.0) > 1, "una media simple daría un número muy diferente");
});

test("el RSI se mueve entre 0 y 100 y respeta los extremos", () => {
  const solosube = Array.from({ length: 40 }, (_, i) => 100 + i);
  const solobaja = Array.from({ length: 40 }, (_, i) => 100 - i);
  assert.equal(rsi(solosube, 14)[39], 100, "sin pérdidas el RSI es 100");
  assert.equal(rsi(solobaja, 14)[39], 0, "sin ganancias el RSI es 0");
  for (const x of rsi(WILDER, 14)) {
    if (x != null) assert.ok(x >= 0 && x <= 100);
  }
});

test("EL ATR ES EL RANGO VERDADERO, no el rango de la vela", () => {
  // Vela que abre con hueco: rango propio 2, pero rango verdadero 12 porque incluye el hueco
  // respecto al cierre anterior. Confundirlos hace que todos los stops salgan pequeños.
  const velas = [vela(0, 100, 100, 100, 100), vela(1, 110, 112, 110, 111)];
  const a = atr(velas, 1);
  assert.equal(a[1], 12, "112 - 100 = 12, no 112 - 110 = 2");
});

test("el ATR de una serie de rango constante ES ese rango", () => {
  const velas = Array.from({ length: 40 }, (_, i) => vela(i, 100, 102, 98, 100));
  const a = atr(velas, 14);
  assert.ok(Math.abs(a[39]! - 4) < 1e-6, `esperaba 4, fue ${a[39]}`);
});

// ---------------------------------------------------------------------------------------
// 2. CONTROLES POSITIVOS: si aquí no gana, el simulador está roto
// ---------------------------------------------------------------------------------------

/** Tendencia alcista perfecta y sin ruido. Una ruptura seguida de tendencia TIENE que ganar. */
function tendenciaAlcista(n: number): Vela[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + i * 2;
    return vela(i, base, base + 1.5, base - 0.5, base + 1);
  });
}

test("CONTROL POSITIVO · la ruptura de canal GANA en una tendencia perfecta", () => {
  const velas = tendenciaAlcista(200);
  const a = atr(velas, 14);
  const rs: number[] = [];
  for (const s of canal(velas, 20)) {
    const av = a[s.i];
    if (av == null || !(av > 0)) continue;
    const r = simularRuptura(velas, s, av * 2, 2, 0, 0);
    if (r) rs.push(r.r);
  }
  assert.ok(rs.length > 0, "no encontró ni una señal en una tendencia perfecta");
  const total = rs.reduce((s, x) => s + x, 0);
  assert.ok(total > 0, `la suma dio ${total.toFixed(2)}R en una subida limpia`);
});

test("LA RUPTURA DE VOLATILIDAD NO DISPARA EN UNA TENDENCIA UNIFORME, y es correcto", () => {
  // Descubierto montando esta auditoria: en una subida donde TODAS las velas son iguales, el
  // cuerpo nunca supera al ATR, porque el ATR es la media de rangos que INCLUYEN ese cuerpo.
  // Matematicamente el rango verdadero siempre es >= el cuerpo, asi que una tendencia uniforme
  // no puede dar señal. No es un fallo: la estrategia busca ACELERACION, no tendencia.
  const velas = Array.from({ length: 200 }, (_, i) => {
    const base = 100 + i * 5;
    return vela(i, base, base + 6, base - 0.2, base + 5);
  });
  const a = atr(velas, 14);
  assert.equal(volatilidad(velas, a, 1).length, 0, "una subida uniforme no es una ruptura");
});

test("CONTROL POSITIVO · la ruptura de volatilidad GANA cuando hay ACELERACION", () => {
  // Calma y luego arranque: eso si es lo que la estrategia esta diseñada para cazar.
  const velas: Vela[] = [];
  for (let i = 0; i < 40; i += 1) velas.push(vela(i, 100, 100.5, 99.5, 100));
  for (let i = 40; i < 140; i += 1) {
    const base = 100 + (i - 40) * 8;
    velas.push(vela(i, base, base + 8.3, base - 0.3, base + 8));
  }
  const a = atr(velas, 14);
  const rs: number[] = [];
  for (const s of volatilidad(velas, a, 1)) {
    const av = a[s.i];
    if (av == null || !(av > 0)) continue;
    const r = simularRuptura(velas, s, av * 2, 2, 0, 0);
    if (r) rs.push(r.r);
  }
  assert.ok(rs.length > 0, "no cazó el arranque");
  const total = rs.reduce((s, x) => s + x, 0);
  assert.ok(total > 0, `sumó ${total.toFixed(2)}R en un arranque limpio`);
});

test("CONTROL POSITIVO · LOS CORTOS GANAN en una tendencia bajista perfecta", () => {
  // Si hubiera un error de signo en los cortos, la mitad de toda la investigación estaría mal.
  const velas = Array.from({ length: 200 }, (_, i) => {
    const base = 500 - i * 2;
    return vela(i, base, base + 0.5, base - 1.5, base - 1);
  });
  const a = atr(velas, 14);
  const cortos: number[] = [];
  for (const s of canal(velas, 20)) {
    if (s.direccion !== "CORTO") continue;
    const av = a[s.i];
    if (av == null || !(av > 0)) continue;
    const r = simularRuptura(velas, s, av * 2, 2, 0, 0);
    if (r) cortos.push(r.r);
  }
  assert.ok(cortos.length > 0, "no detectó ninguna ruptura bajista");
  const total = cortos.reduce((s, x) => s + x, 0);
  assert.ok(total > 0, `los cortos sumaron ${total.toFixed(2)}R en una caída limpia`);
});

test("CONTROL POSITIVO · la reversión GANA en un diente de sierra dentro de tendencia", () => {
  // Sube en escalera con retrocesos regulares: es exactamente lo que compra la estrategia.
  const velas: Vela[] = [];
  for (let i = 0; i < 400; i += 1) {
    const tendencia = 100 + i * 0.5;
    const ciclo = i % 10 < 7 ? 0 : -6;
    const c = tendencia + ciclo;
    velas.push(vela(i, c, c + 1, c - 1, c));
  }
  const a = atr(velas, 14);
  const rs: number[] = [];
  for (const s of retrocesoEnTendencia(velas, 2, 20, 50, true)) {
    const av = a[s.i];
    if (av == null || !(av > 0)) continue;
    const r = simularReversion(velas, s, av * 3, 0, 10, null, 0);
    if (r) rs.push(r.r);
  }
  assert.ok(rs.length > 5, `solo ${rs.length} señales en un diente de sierra`);
  assert.ok(rs.reduce((s, x) => s + x, 0) > 0);
});

// ---------------------------------------------------------------------------------------
// 3. LA CONTABILIDAD DEL COSTE: ni se cobra dos veces ni se olvida
// ---------------------------------------------------------------------------------------

test("EL COSTE SE COBRA UNA VEZ, no dos: la diferencia es exactamente la esperada", () => {
  const velas = tendenciaAlcista(200);
  const a = atr(velas, 14);
  const señales = canal(velas, 20);

  const suma = (spread: number): { total: number; n: number } => {
    let total = 0;
    let n = 0;
    for (const s of señales) {
      const av = a[s.i];
      if (av == null || !(av > 0)) continue;
      const stop = av * 2;
      const r = simularRuptura(velas, s, stop, 2, spread, 0);
      if (r) { total += r.r; n += 1; }
    }
    return { total, n };
  };

  const gratis = suma(0);
  const stopTipico = a[50]! * 2;
  // Se pasa medio coste por lado, que es como lo llaman todos los CLIs.
  const conCoste = suma((0.1 * stopTipico) / 2);

  assert.equal(gratis.n, conCoste.n, "el coste no debería cambiar cuántas operaciones hay");
  const diferencia = (gratis.total - conCoste.total) / gratis.n;
  // Con ATR casi constante en esta serie, el coste por operación debe rondar 0,1R.
  assert.ok(
    diferencia > 0.05 && diferencia < 0.16,
    `el coste por operación salió ${diferencia.toFixed(3)}R; esperaba ~0,10R. ` +
      `Muy por encima significaría cobrarlo dos veces; cerca de cero, no cobrarlo.`,
  );
});

test("SIN COSTE una operación que toca el objetivo da EXACTAMENTE el objetivo en R", () => {
  const velas = [
    vela(0, 100, 100, 100, 100),
    vela(1, 100, 100, 100, 100),
    vela(2, 100, 106, 99.5, 105),
  ];
  const s: SeñalTdfi = { i: 0, direccion: "LARGO", riesgo: 2 };
  const r = simularObjetivo(velas, s, 2, 0, 0, true);
  assert.equal(r!.motivo, "OBJETIVO");
  assert.equal(r!.r, 2, "sin coste tiene que ser el objetivo exacto, sin recortes");
});

test("EL COSTE EN simularObjetivo se cobra una vez y en R", () => {
  const velas = [
    vela(0, 100, 100, 100, 100),
    vela(1, 100, 100, 100, 100),
    vela(2, 100, 106, 99.5, 105),
  ];
  const s: SeñalTdfi = { i: 0, direccion: "LARGO", riesgo: 2 };
  // coste = 0,05 x riesgo -> debe restar exactamente 0,05R.
  const r = simularObjetivo(velas, s, 2, 0.05 * 2, 0, true);
  assert.ok(Math.abs(r!.r - (2 - 0.05)) < 1e-9, `dio ${r!.r}, esperaba 1,95`);
});

// ---------------------------------------------------------------------------------------
// 4. QUE LA SIMETRIA LARGO/CORTO SEA REAL
// ---------------------------------------------------------------------------------------

test("UN LARGO Y UN CORTO ESPEJO DAN EL MISMO RESULTADO", () => {
  // Si hay un error de signo, esto lo caza: la serie espejada tiene que dar la misma R.
  const sube = [
    vela(0, 100, 100, 100, 100),
    vela(1, 100, 104, 99, 103),
    vela(2, 103, 108, 102, 107),
  ];
  const baja = sube.map((v) => vela(v.t / DIA, 200 - v.o, 200 - v.l, 200 - v.h, 200 - v.c));

  const rl = simularRuptura(sube, { i: 0, direccion: "LARGO", nivel: 100 }, 2, 2, 0, 0);
  const rc = simularRuptura(baja, { i: 0, direccion: "CORTO", nivel: 100 }, 2, 2, 0, 0);

  assert.ok(rl != null && rc != null);
  assert.ok(
    Math.abs(rl!.r - rc!.r) < 1e-9,
    `largo dio ${rl!.r} y su espejo corto dio ${rc!.r}: hay un error de signo`,
  );
});

test("EL STOP GANA LOS EMPATES, y eso resta: es deliberado", () => {
  // Vela que toca stop y objetivo. Contar el objetivo daría +2R en vez de -1R. Esta asimetría
  // es la que impide que un backtest se infle solo, y va SIEMPRE en contra del resultado.
  const velas = [
    vela(0, 100, 100, 100, 100),
    vela(1, 100, 100, 100, 100),
    vela(2, 100, 110, 90, 100),
  ];
  const s: SeñalTdfi = { i: 0, direccion: "LARGO", riesgo: 2 };
  const r = simularObjetivo(velas, s, 2, 0, 0, true);
  assert.equal(r!.motivo, "STOP");
  assert.equal(r!.r, -1);
});

test("EL DESLIZAMIENTO ADVERSO SOLO PENALIZA LA ENTRADA, y siempre en contra", () => {
  const velas = [
    vela(0, 100, 100, 100, 100),
    vela(1, 100, 100, 100, 100),
    vela(2, 100, 120, 99, 119),
    vela(3, 119, 120, 90, 95),
  ];
  const sinDes = simularRuptura(velas, { i: 0, direccion: "LARGO", nivel: 100 }, 10, 2, 0, 0, 0);
  const conDes = simularRuptura(velas, { i: 0, direccion: "LARGO", nivel: 100 }, 10, 2, 0, 0, 1);
  assert.ok(sinDes != null && conDes != null);
  assert.ok(conDes!.r < sinDes!.r, "el deslizamiento tiene que restar, nunca sumar");
});

test("el deslizamiento tambien va EN CONTRA en un corto", () => {
  const velas = [
    vela(0, 100, 100, 100, 100),
    vela(1, 100, 100, 100, 100),
    vela(2, 100, 101, 80, 81),
    vela(3, 81, 110, 80, 105),
  ];
  const sinDes = simularRuptura(velas, { i: 0, direccion: "CORTO", nivel: 100 }, 10, 2, 0, 0, 0);
  const conDes = simularRuptura(velas, { i: 0, direccion: "CORTO", nivel: 100 }, 10, 2, 0, 0, 1);
  assert.ok(conDes!.r < sinDes!.r, "en un corto entrar mas abajo tambien perjudica");
});

test("sin deslizamiento el resultado es identico al de antes: no rompe nada", () => {
  const velas = tendenciaAlcista(100);
  const a = atr(velas, 14);
  const s = canal(velas, 20)[0]!;
  const av = a[s.i]!;
  const conCero = simularRuptura(velas, s, av * 2, 2, 0, 0, 0);
  const sinArg = simularRuptura(velas, s, av * 2, 2, 0, 0);
  assert.deepEqual(conCero, sinArg);
});

test("SE RECHAZAN LAS VELAS IMPOSIBLES QUE SERVIA LA FUENTE", () => {
  // Los tres casos reales encontrados el 7 sep en las caches.
  assert.equal(esVelaValida(vela(0, 100, 101, 99, 100)), true);
  assert.equal(esVelaValida(vela(0, 0, 101, 99, 100)), false, "apertura en cero: SHIB, 259 velas");
  assert.equal(esVelaValida(vela(0, 100, 101, 0, 100)), false, "minimo en cero dispara cualquier stop");
  assert.equal(esVelaValida(vela(0, 100, 101, 99, 105)), false, "cierre fuera: forex, 2.060 velas");
  assert.equal(esVelaValida(vela(0, 105, 101, 99, 100)), false, "apertura fuera: forex, 357 velas");
  assert.equal(esVelaValida(vela(0, 100, 98, 99, 100)), false, "maximo menor que el minimo");
});

test("la tolerancia deja pasar el redondeo normal de las fuentes", () => {
  // Un cierre un 0,001% por encima del maximo es redondeo, no corrupcion.
  assert.equal(esVelaValida(vela(0, 100, 101, 99, 101.00001)), true);
  assert.equal(esVelaValida(vela(0, 100, 101, 99, 101.5)), false);
});

test("limpiarVelas quita las malas y respeta las buenas", () => {
  const mezcla = [vela(0, 100, 101, 99, 100), vela(1, 0, 0, 0, 0), vela(2, 100, 101, 99, 100)];
  assert.equal(limpiarVelas(mezcla).length, 2);
});

test("LA REGLA DURA: el stop cuenta ya en la vela de entrada", () => {
  // La vela de entrada abre en 100 y se hunde hasta 80 antes de subir a 200.
  const velas = [
    vela(0, 100, 101, 99, 100),
    vela(1, 100, 200, 80, 190),
    vela(2, 190, 200, 185, 195),
  ];
  const s = { i: 0, direccion: "LARGO" as const, nivel: 100 };
  const duro = simularRuptura(velas, s, 10, 2, 0, 0, 0, true);
  const blando = simularRuptura(velas, s, 10, 2, 0, 0, 0, false);
  assert.equal(duro!.motivo, "STOP", "por defecto se supone lo peor");
  assert.ok(blando!.r > duro!.r, "saltando la vela de entrada el resultado mejora");
});

test("con la vela de entrada tranquila las dos reglas dan lo mismo", () => {
  const velas = [
    vela(0, 100, 101, 99, 100),
    vela(1, 100, 102, 99.5, 101),
    vela(2, 101, 103, 100, 102),
  ];
  const s = { i: 0, direccion: "LARGO" as const, nivel: 100 };
  const duro = simularRuptura(velas, s, 10, 2, 0, 0, 0, true);
  const blando = simularRuptura(velas, s, 10, 2, 0, 0, 0, false);
  assert.equal(duro!.r, blando!.r, "si el stop no se toca, la regla no cambia nada");
});
