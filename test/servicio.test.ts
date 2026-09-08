import { test } from "node:test";
import assert from "node:assert/strict";
import { esperaTras } from "../src/forex/reintentos";

test("sin fallos se espera lo que queda del intervalo", () => {
  assert.equal(esperaTras(0, 3600, 100), 3500);
});

test("UNA PASADA LENTA NO ENCADENA REINTENTOS sin respiro", () => {
  assert.equal(esperaTras(0, 3600, 4000), 60, "el suelo son 60 segundos");
});

test("EL CASTIGO CRECE CON LOS FALLOS SEGUIDOS, no reintenta al mismo ritmo", () => {
  const a = esperaTras(1, 3600, 0);
  const b = esperaTras(3, 3600, 0);
  assert.ok(b > a, "mas fallos, mas espera");
  assert.equal(a, 3900);
  assert.equal(b, 4500);
});

test("el castigo tiene techo: no se espera para siempre", () => {
  assert.equal(esperaTras(5, 3600, 0), esperaTras(500, 3600, 0));
});
