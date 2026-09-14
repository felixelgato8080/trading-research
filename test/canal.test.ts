/**
 * EL PRECIO COMO CANAL. Las velas son bid; el broker no ejecuta todo contra el bid.
 *
 * Lo que se prueba aqui no es que el resultado sea distinto —eso es obvio— sino que la
 * diferencia esta EXACTAMENTE donde tiene que estar: en los niveles de disparo, y solo en la
 * direccion que corresponde a cada uno.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simular, type SeñalZona } from "../src/forex/estructuraValida";
import type { Vela } from "../src/forex/datos";

const v = (i: number, o: number, h: number, l: number, c: number): Vela =>
  ({ t: i * 300, o, h, l, c });

/** Entrada 100, stop 90, objetivo 115. Riesgo 10. */
const corto: SeñalZona = { i: 0, direccion: "CORTO", entrada: 100, stop: 110, objetivo: 85, rr: 1.5 };
const largo: SeñalZona = { i: 0, direccion: "LARGO", entrada: 100, stop: 90, objetivo: 115, rr: 1.5 };

test("CON SPREAD CERO da exactamente lo mismo que antes", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 101, 88, 89), v(2, 89, 90, 88, 89)];
  const a = simular(velas, largo, 0, 50);
  const b = simular(velas, largo, 0, 50, undefined, 0);
  assert.deepEqual(a, b);
});

test("EL STOP DE UN CORTO SALTA ANTES: el ask va por encima de la vela", () => {
  // Stop en 110. Con spread 3 salta cuando el bid llega a 107, y la vela solo sube a 108.
  const velas = [v(0, 100, 100, 99, 100), v(1, 100, 108, 99, 107), v(2, 107, 108, 106, 107)];
  assert.equal(simular(velas, corto, 0, 50, undefined, 0)?.motivo, undefined,
    "sin spread la vela no llega al stop");
  assert.equal(simular(velas, corto, 0, 50, undefined, 3)?.motivo, "STOP",
    "con 3 de spread, si");
});

test("EL OBJETIVO DE UN CORTO SE ALEJA: el ask tiene que bajar mas", () => {
  // Objetivo en 85. Con spread 3 hace falta que el bid llegue a 82, y la vela solo baja a 84.
  const velas = [v(0, 100, 100, 99, 100), v(1, 100, 100, 84, 85), v(2, 85, 86, 84, 85)];
  assert.equal(simular(velas, corto, 0, 50, undefined, 0)?.motivo, "OBJETIVO");
  assert.notEqual(simular(velas, corto, 0, 50, undefined, 3)?.motivo, "OBJETIVO");
});

test("EL STOP DE UN LARGO NO SE MUEVE: tambien se comprueba contra el bid", () => {
  const velas = [v(0, 100, 101, 100, 100), v(1, 100, 101, 90, 91), v(2, 91, 92, 90, 91)];
  for (const sp of [0, 3, 7]) {
    assert.equal(simular(velas, largo, 0, 50, undefined, sp)?.motivo, "STOP",
      `con spread ${sp} el stop del largo tiene que saltar igual`);
  }
});

test("EL DINERO NO SE COBRA DOS VECES: la R de un stop sigue siendo -1 mas el coste", () => {
  const velas = [v(0, 100, 100, 99, 100), v(1, 100, 113, 99, 112), v(2, 112, 113, 111, 112)];
  const r = simular(velas, corto, 0, 50, undefined, 3);
  assert.equal(r?.motivo, "STOP");
  // Entra en 100 (bid), sale donde el bid marca 107 = stop 110 menos el spread. La perdida en
  // terminos de vela son 7, y los 3 que faltan hasta la R completa son el spread, que lo lleva
  // `coste`. Con coste 0, la R sale -0,7 y esa es la aritmetica correcta, no un error.
  assert.ok(Math.abs(r!.r + 0.7) < 1e-9, `salio ${r!.r}`);
});

test("un corto cuyo stop ya estaba roto al llenarse no existe", () => {
  // Con spread 8, el stop en terminos de vela queda en 102, por debajo de la entrada de 100.
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 101, 99, 100)];
  assert.equal(simular(velas, { ...corto, stop: 105 }, 0, 50, undefined, 8), null);
});
