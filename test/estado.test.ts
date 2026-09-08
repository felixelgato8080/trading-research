/**
 * El aviso de muestra corta, que es lo unico de `estadoCli` que decide algo.
 *
 * Todo lo demas de esa herramienta es leer ficheros y darles formato. Esto no: es la regla que
 * impide que un +1,44R sobre ocho operaciones se lea como si significara algo. Si alguien la
 * afloja manana, el panel empieza a mentir por omision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { avisoMuestra } from "../src/tools/estadoCli";

test("CON POCAS OPERACIONES SE DICE, y se dice contra que", () => {
  const a = avisoMuestra(8, -0.32);
  assert.match(a, /8 operaciones/);
  assert.match(a, /ruido/);
  assert.match(a, /-0\.32R/, "el numero del backtest va al lado, o el registro se lee a solas");
});

test("entre 30 y 100 sigue avisando, sin repetir el backtest", () => {
  const a = avisoMuestra(50, -0.32);
  assert.match(a, /50 operaciones/);
  assert.doesNotMatch(a, /-0\.32R/);
});

test("CON MUESTRA SUFICIENTE SE CALLA: un aviso que sale siempre deja de leerse", () => {
  assert.equal(avisoMuestra(150, -0.32), "");
});

test("sin operaciones no hay nada que avisar", () => {
  assert.equal(avisoMuestra(0, -0.32), "");
});
