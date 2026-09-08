import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import { serieRatio, bandas, zScore, señales, simularPar } from "../src/forex/pares";

const DIA = 86400;
const v = (i: number, c: number): Vela => ({ t: i * DIA, o: c, h: c, l: c, c, v: 100 });

test("el ratio es A dividido por B, solo en las fechas comunes", () => {
  const a = [v(0, 100), v(1, 200), v(2, 300)];
  const b = [v(0, 50), v(2, 100)];
  const r = serieRatio(a, b);
  assert.equal(r.length, 2, "el dia 1 no lo tiene B, asi que no existe");
  assert.equal(r[0]!.ratio, 2);
  assert.equal(r[1]!.ratio, 3);
});

test("NO SE RELLENAN HUECOS: un dia que solo cotiza uno no genera par", () => {
  const a = Array.from({ length: 10 }, (_, i) => v(i, 100));
  const b = [v(0, 50), v(9, 50)];
  assert.equal(serieRatio(a, b).length, 2);
});

test("LA BANDA NO INCLUYE LA VELA ACTUAL", () => {
  // Base que oscila 8/12 (media 10, sd 2) y luego un 1000. La banda del 1000 sale de la base.
  const valores = [...Array.from({ length: 10 }, (_, i) => (i % 2 ? 12 : 8)), 1000];
  const b = bandas(valores, 10);
  assert.equal(b[10]!.media, 10, "si incluyera el 1000, la media no seria 10");
  assert.equal(b[10]!.sd, 2, "si incluyera el 1000, la desviacion se dispararia");
});

test("la z mide desviaciones tipicas respecto a la banda", () => {
  const valores = [...[8, 12, 8, 12, 8, 12, 8, 12, 8, 12], 14];
  const z = zScore(valores, 10);
  // media 10, sd 2 -> el 14 esta a 2 desviaciones.
  assert.ok(z[10] != null && Math.abs(z[10]! - 2) < 1e-9, `z fue ${z[10]}`);
});

test("sin variacion no hay z: no se divide por cero", () => {
  const z = zScore([...new Array(10).fill(10), 10], 10);
  assert.equal(z[10], null);
});

test("LA SEÑAL ES EL CRUCE, no el estado", () => {
  // z que sube por encima de 2 y se queda: una sola señal, no una por vela.
  const z = [0, 0, 2.5, 2.6, 2.7, 2.8];
  const s = señales(z, 2);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.i, 2);
  assert.equal(s[0]!.direccion, "CORTO", "ratio alto se vende, se espera que baje");
});

test("una z muy baja da señal LARGO del ratio", () => {
  const s = señales([0, 0, -2.5], 2);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.direccion, "LARGO");
});

/**
 * Base de 50 velas oscilando 8/12 (media 10, sd 2) y luego lo que se le pase.
 *
 * Tiene que ser MAS LARGA que la ventana (40) para que exista z en la vela anterior a la señal:
 * sin z previa no hay cruce, y sin cruce no hay señal. Es lo que fallaba en la primera version
 * de estas pruebas.
 */
function base(...cola: number[]): number[] {
  return [...Array.from({ length: 50 }, (_, i) => (i % 2 ? 12 : 8)), ...cola];
}
const VENTANA = 40;

test("EL PAR GANA CUANDO EL RATIO VUELVE A SU SITIO", () => {
  // Se dispara a 16 y AGUANTA una vela (la de entrada), luego vuelve a 10: el corto gana.
  const valores = base(16, 16, 10, 10);
  const puntos = valores.map((r, i) => ({ t: i * DIA, ratio: r }));
  const s = señales(zScore(valores, VENTANA), 2)[0];
  assert.ok(s, "deberia haber señal en el extremo");
  assert.equal(s!.direccion, "CORTO");
  const r = simularPar(puntos, VENTANA, s!, 4, 0.5, 0, 0);
  assert.ok(r != null);
  assert.ok(r!.r > 0, `deberia ganar al volver el ratio, dio ${r!.r}`);
});

test("EL PAR PIERDE SI EL RATIO SIGUE ALEJANDOSE", () => {
  // Stop en 6 para que quede sitio: la z de ENTRADA (3,58) no es la de la señal (3,00), porque
  // la banda se recalcula en cada vela. Con stop 4 la distancia seria 0,42 y la operacion se
  // descartaria por estar pegada al stop.
  const valores = base(16, 18, 22, 30, 40);
  const puntos = valores.map((r, i) => ({ t: i * DIA, ratio: r }));
  const s = señales(zScore(valores, VENTANA), 2)[0];
  assert.ok(s);
  const r = simularPar(puntos, VENTANA, s!, 6, 0.5, 0, 0);
  assert.ok(r != null);
  assert.ok(r!.r < 0, `si el ratio se aleja tiene que perder, dio ${r!.r}`);
});

test("EL COSTE DE LAS DOS PATAS SE RESTA ENTERO", () => {
  const valores = base(16, 16, 10, 10);
  const puntos = valores.map((r, i) => ({ t: i * DIA, ratio: r }));
  const s = señales(zScore(valores, VENTANA), 2)[0]!;
  const gratis = simularPar(puntos, VENTANA, s, 4, 0.5, 0, 0);
  const conCoste = simularPar(puntos, VENTANA, s, 4, 0.5, 0.2, 0);
  assert.ok(Math.abs((gratis!.r - conCoste!.r) - 0.2) < 1e-9, "debe restar exactamente 0,2R");
});

test("devuelve stopFraccion, que es lo que permite calcular la exposicion", () => {
  const valores = base(16, 16, 10, 10);
  const puntos = valores.map((r, i) => ({ t: i * DIA, ratio: r }));
  const s = señales(zScore(valores, VENTANA), 2)[0]!;
  const r = simularPar(puntos, VENTANA, s, 4, 0.5, 0, 0);
  assert.ok(r!.stopFraccion > 0 && r!.stopFraccion < 1, `fue ${r!.stopFraccion}`);
});

test("si la z de entrada ya pasa del stop, no se opera", () => {
  const valores = base(100, 100, 10);
  const puntos = valores.map((r, i) => ({ t: i * DIA, ratio: r }));
  const s = señales(zScore(valores, VENTANA), 2)[0];
  assert.ok(s, "con un extremo asi tiene que haber señal");
  // Stop en 1 z cuando la entrada esta mucho mas alla: riesgo negativo, no hay operacion.
  assert.equal(simularPar(puntos, VENTANA, s!, 1, 0.5, 0, 0), null);
});

test("sin datos suficientes devuelve null en vez de inventarse una operacion", () => {
  const puntos = [{ t: 0, ratio: 1 }];
  assert.equal(simularPar(puntos, VENTANA, { i: 0, direccion: "LARGO", z: -3 }, 4, 0.5, 0, 0), null);
});

test("SE DESCARTA LA ENTRADA PEGADA AL STOP: si no, la R se dispara", () => {
  // La z de entrada aqui es 3,17. Con el stop en 3,5 la distancia es 0,33: el riesgo del
  // denominador seria casi cero y cualquier movimiento daria una R enorme. Son operaciones que
  // nadie tomaria, y bastan unas pocas para inflar la esperanza de un barrido entero.
  const valores = base(17.5, 17.5, 10);
  const puntos = valores.map((r, i) => ({ t: i * DIA, ratio: r }));
  const z = zScore(valores, VENTANA);
  const s = señales(z, 2)[0]!;
  const zEntrada = Math.abs(z[s.i + 1]!);
  assert.ok(zEntrada > 3 && zEntrada < 3.3, `z de entrada fue ${zEntrada}`);

  assert.equal(simularPar(puntos, VENTANA, s, 3.5, 0.5, 0, 0), null, "0,33 de distancia: fuera");
  assert.ok(simularPar(puntos, VENTANA, s, 6, 0.5, 0, 0) != null, "2,83 de distancia: dentro");
});

test("la distancia minima se puede aflojar, y entonces si opera", () => {
  const valores = base(17.5, 17.5, 10);
  const puntos = valores.map((r, i) => ({ t: i * DIA, ratio: r }));
  const s = señales(zScore(valores, VENTANA), 2)[0]!;
  assert.equal(simularPar(puntos, VENTANA, s, 3.5, 0.5, 0, 0), null);
  assert.ok(simularPar(puntos, VENTANA, s, 3.5, 0.5, 0, 0, 0.01) != null);
});
