import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import { indexar, calendario, fuerza, retornoEntre, simular, control } from "../src/forex/momento";

const DIA = 86400;
/** Serie con un precio por dia; apertura = cierre para que las cuentas sean comprobables a mano. */
function serie(precios: number[], desde = 1): Vela[] {
  return precios.map((p, i) => ({ t: (desde + i) * DIA, o: p, h: p, l: p, c: p, v: 0 }));
}

test("fuerza mide el tramo correcto y salta los dias del hueco", () => {
  //           0    1    2    3    4    5
  const v = serie([10, 11, 12, 13, 14, 99]);
  const i = indexar(new Map([["A", v]])).get("A")!;
  // En t=indice 5, lookback 2 y hueco 1: va del indice 2 al 4 -> 14/12 - 1.
  const f = fuerza(i, 6 * DIA, 2, 1);
  assert.ok(f != null && Math.abs(f - (14 / 12 - 1)) < 1e-12);
  // El 99 del ultimo dia NO entra: ese es justo el trabajo del hueco.
});

test("fuerza sin hueco llega hasta el ultimo cierre", () => {
  const v = serie([10, 11, 12, 13, 14, 99]);
  const i = indexar(new Map([["A", v]])).get("A")!;
  const f = fuerza(i, 6 * DIA, 2, 0);
  assert.ok(f != null && Math.abs(f - (99 / 13 - 1)) < 1e-12);
});

test("fuerza devuelve null si no hay historia suficiente", () => {
  const v = serie([10, 11, 12]);
  const i = indexar(new Map([["A", v]])).get("A")!;
  assert.equal(fuerza(i, 3 * DIA, 10, 0), null);
  assert.equal(fuerza(i, 999 * DIA, 1, 0), null);
});

test("EL RETORNO SE MIDE DE APERTURA A APERTURA DEL DIA SIGUIENTE, no del cierre de hoy", () => {
  const v: Vela[] = [
    { t: 1 * DIA, o: 10, h: 10, l: 10, c: 10, v: 0 },
    { t: 2 * DIA, o: 20, h: 20, l: 20, c: 20, v: 0 },
    { t: 3 * DIA, o: 30, h: 30, l: 30, c: 30, v: 0 },
  ];
  const i = indexar(new Map([["A", v]])).get("A")!;
  // De t=dia1 a t=dia2 se entra en la apertura del dia 2 (20) y se sale en la del dia 3 (30).
  const r = retornoEntre(i, 1 * DIA, 2 * DIA);
  assert.ok(r != null && Math.abs(r - 0.5) < 1e-12);
});

test("retornoEntre es null si falta la barra siguiente", () => {
  const v = serie([10, 20]);
  const i = indexar(new Map([["A", v]])).get("A")!;
  assert.equal(retornoEntre(i, 1 * DIA, 2 * DIA), null);
});

test("el calendario es el del instrumento con mas historia", () => {
  const idx = indexar(new Map([["corto", serie([1, 2, 3])], ["largo", serie([1, 2, 3, 4, 5])]]));
  assert.equal(calendario(idx).length, 5);
});

test("ELIGE AL MAS FUERTE, no al mas caro", () => {
  // B vale menos pero sube mas: el ranking es por retorno, no por precio.
  const sube = serie([10, 20, 30, 40, 50, 60]);
  const plano = serie([100, 100, 100, 100, 100, 100]);
  const idx = indexar(new Map([["fuerte", sube], ["plano", plano]]));
  const r = simular(idx, calendario(idx), {
    lookback: 2, hueco: 0, cartera: 1, rebalanceo: 1, absoluto: false, coste: 0,
  });
  const conEleccion = r.periodos.filter((p) => p.seleccion.length > 0);
  assert.ok(conEleccion.length > 0, "no hubo ningun periodo con eleccion");
  for (const p of conEleccion) assert.deepEqual(p.seleccion, ["fuerte"]);
});

test("EL MOMENTO ABSOLUTO deja el dinero quieto cuando todo cae", () => {
  const baja = serie([100, 90, 80, 70, 60, 50, 40]);
  const idx = indexar(new Map([["A", baja], ["B", baja]]));
  const cal = calendario(idx);
  const aj = { lookback: 2, hueco: 0, cartera: 1, rebalanceo: 1, coste: 0 };
  const con = simular(idx, cal, { ...aj, absoluto: true });
  const sin = simular(idx, cal, { ...aj, absoluto: false });
  assert.equal(con.capitalFinal, 1, "con filtro absoluto no deberia perder nada");
  assert.ok(sin.capitalFinal < 1, "sin filtro absoluto sigue comprando lo que cae");
  for (const p of con.periodos) assert.equal(p.seleccion.length, 0);
});

test("el coste se cobra por los dos lados de cada cambio", () => {
  // Dos activos que se turnan como lider fuerzan un cambio en cada rebalanceo.
  const a = serie([10, 20, 10, 20, 10, 20, 10, 20]);
  const b = serie([20, 10, 20, 10, 20, 10, 20, 10]);
  const idx = indexar(new Map([["A", a], ["B", b]]));
  const cal = calendario(idx);
  const aj = { lookback: 1, hueco: 0, cartera: 1, rebalanceo: 1, absoluto: false };
  const gratis = simular(idx, cal, { ...aj, coste: 0 });
  const caro = simular(idx, cal, { ...aj, coste: 0.01 });
  assert.ok(caro.capitalFinal < gratis.capitalFinal);
  assert.ok(caro.rotacionMedia > 0.5, `rotacion fue ${caro.rotacionMedia}`);
});

test("sin cambios de cartera no se paga peaje", () => {
  const sube = serie([10, 11, 12, 13, 14, 15, 16, 17]);
  const plano = serie([100, 100, 100, 100, 100, 100, 100, 100]);
  const idx = indexar(new Map([["fuerte", sube], ["plano", plano]]));
  const cal = calendario(idx);
  const aj = { lookback: 2, hueco: 0, cartera: 1, rebalanceo: 1, absoluto: false };
  const gratis = simular(idx, cal, { ...aj, coste: 0 });
  const caro = simular(idx, cal, { ...aj, coste: 0.05 });
  // Solo el primer periodo tiene un cambio (entrar desde vacio); despues se mantiene.
  assert.ok(Math.abs(caro.capitalFinal - gratis.capitalFinal) < 0.11 * gratis.capitalFinal);
});

test("un instrumento que empieza tarde no descuadra el calendario", () => {
  const largo = serie([10, 11, 12, 13, 14, 15], 1);
  const tarde = serie([50, 60, 70], 4);
  const idx = indexar(new Map([["largo", largo], ["tarde", tarde]]));
  const r = simular(idx, calendario(idx), {
    lookback: 2, hueco: 0, cartera: 1, rebalanceo: 1, absoluto: false, coste: 0,
  });
  // No revienta y en los primeros periodos solo puede elegir al que tiene historia.
  assert.ok(r.periodos.length > 0);
  const primera = r.periodos.find((p) => p.seleccion.length > 0)!;
  assert.deepEqual(primera.seleccion, ["largo"]);
});

test("la caida maxima se mide desde el pico", () => {
  const v = serie([100, 110, 120, 200, 190, 100, 90, 80]);
  const idx = indexar(new Map([["A", v]]));
  const r = simular(idx, calendario(idx), {
    lookback: 1, hueco: 0, cartera: 1, rebalanceo: 1, absoluto: false, coste: 0,
  });
  assert.ok(r.maxCaida > 0);
});

test("EL CONTROL tiene todo el universo, que es contra quien hay que ganar", () => {
  const a = serie([10, 20, 30, 40, 50, 60]);
  const b = serie([10, 10, 10, 10, 10, 10]);
  const idx = indexar(new Map([["A", a], ["B", b]]));
  const c = control(idx, calendario(idx), 1);
  const conEleccion = c.periodos.filter((p) => p.seleccion.length > 0);
  assert.ok(conEleccion.length > 0);
  for (const p of conEleccion) assert.equal(p.seleccion.length, 2);
  // La media de uno que sube y otro plano queda entre los dos.
  assert.ok(c.capitalFinal > 1);
});

test("sin datos no se inventa nada", () => {
  const idx = indexar(new Map<string, Vela[]>());
  const r = simular(idx, [], {
    lookback: 2, hueco: 0, cartera: 1, rebalanceo: 1, absoluto: false, coste: 0,
  });
  assert.equal(r.periodos.length, 0);
  assert.equal(r.capitalFinal, 1);
  assert.equal(r.aciertoPeriodos, 0);
});
