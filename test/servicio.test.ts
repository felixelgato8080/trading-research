import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// ------------------------------------------------------------------------------------------
// LOS AJUSTES DEL MODO `afinado`, fijados para que no se muevan sin que nadie se entere
// ------------------------------------------------------------------------------------------
//
// Salieron de medir 440 operaciones y cada uno tiene su motivo mecanico. Si alguien los cambia
// —yo el mes que viene, sin acordarme— el registro pasa a ser de otra estrategia y las 440 no
// respaldan nada. El grabador ya se niega a continuar si los ajustes cambian a mitad, pero eso
// solo protege un registro EMPEZADO: esto protege el que se empiece mañana.

test("EL MODO `afinado` GRABA LO QUE SE MIDIO, no otra cosa", () => {
  const fuente = readFileSync("src/tools/grabarDivergenciaCli.ts", "utf-8");

  // Los cuatro pares que se mueven. GBPUSD, NZDUSD y AUDUSD tienen ATR de 5m de 1,5 a 2,8 pips
  // y ahi el spread se come el 20-40% del riesgo; CADJPY se mueve pero su señal da -0,063R.
  const lista = fuente.match(/const AFINADO = \[([^\]]+)\]/);
  assert.ok(lista, "no se encuentra la lista de pares del modo afinado");
  const pares = lista![1]!.match(/"[^"]+"/g)!.map((x) => x.replace(/"/g, ""));
  assert.deepEqual(pares, ["USDJPY=X", "GBPJPY=X", "EURJPY=X", "AUDJPY=X"]);

  // Colchon 1: sube el stop de 5,3 a 9,4 pips y baja el peaje del 22% al 13% del riesgo.
  assert.match(fuente, /const colchon = modo === "afinado" \? 1 : 0\.1/);

  // Objetivo fijo 1,5R. La esperanza es plana entre 0,75R y 3R, asi que se elige por la forma
  // de la curva: 50% de acierto hace que las rachas malas sean cortas.
  assert.match(fuente, /objetivo: "FIJO", objetivoR: 1\.5/);
});
