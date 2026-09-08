import { test } from "node:test";
import assert from "node:assert/strict";
import {
  repartir, rejillaPorDefecto, cambiosEntre, validarCambio, type Configuracion,
} from "../src/forex/cartera_multi";

const c = (nombre: string, over: Partial<Configuracion> = {}): Configuracion =>
  ({ nombre, k: 2, atrStop: 2, trailing: 2, peso: 1, ...over });

test("DIVERSIFICAR NO AUMENTA EL RIESGO, lo reparte", () => {
  const r = repartir([c("a"), c("b"), c("c"), c("d")], 0.01);
  const suma = [...r.values()].reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(suma - 0.01) < 1e-12, "la suma tiene que ser el riesgo total, no mas");
  assert.ok(Math.abs(r.get("a")! - 0.0025) < 1e-12);
});

test("los pesos desiguales reparten en proporcion", () => {
  const r = repartir([c("grande", { peso: 3 }), c("chica", { peso: 1 })], 0.04);
  assert.ok(Math.abs(r.get("grande")! - 0.03) < 1e-12);
  assert.ok(Math.abs(r.get("chica")! - 0.01) < 1e-12);
});

test("un peso negativo cuenta como cero, no resta", () => {
  const r = repartir([c("buena"), c("mala", { peso: -5 })], 0.02);
  assert.ok(Math.abs(r.get("buena")! - 0.02) < 1e-12);
  assert.equal(r.get("mala"), 0);
});

test("sin pesos o sin riesgo no se reparte nada, en vez de dividir por cero", () => {
  const sinPeso = repartir([c("a", { peso: 0 })], 0.01);
  assert.equal(sinPeso.get("a"), 0);
  const sinRiesgo = repartir([c("a")], 0);
  assert.equal(sinRiesgo.get("a"), 0);
});

test("la rejilla por defecto EXCLUYE k=1, que era una sola operacion afortunada", () => {
  const r = rejillaPorDefecto();
  assert.equal(r.length, 8);
  assert.ok(!r.some((x) => x.k === 1), "k=1 daba PF 6-8 con el 95% en un instrumento");
  assert.ok(r.every((x) => x.trailing === 2));
});

test("cambiosEntre detecta exactamente que campo se movio", () => {
  const antes = [c("a"), c("b")];
  const despues = [c("a", { k: 2.5 }), c("b")];
  assert.deepEqual(cambiosEntre(antes, despues), ["a.k: 2 → 2.5"]);
});

test("detecta configuraciones añadidas y quitadas", () => {
  assert.deepEqual(cambiosEntre([c("a")], [c("a"), c("b")]), ["b: añadida"]);
  assert.deepEqual(cambiosEntre([c("a"), c("b")], [c("a")]), ["b: quitada"]);
});

test("UNA SOLA VARIABLE POR CICLO, y se comprueba de verdad", () => {
  const antes = [c("a")];
  const dos = [c("a", { k: 2.5, atrStop: 3 })];
  const r = validarCambio(antes, dos, 500, 400);
  assert.equal(r.aceptado, false);
  assert.ok(r.motivo.includes("2 variables"));
});

test("EL CAMBIO CON POCAS OPERACIONES SE RECHAZA: es el guardarrail que falta en casi todos", () => {
  const antes = [c("a")];
  const uno = [c("a", { k: 2.5 })];
  // Cinco operaciones es la cadencia que proponia el prompt del video.
  const pocas = validarCambio(antes, uno, 5, 400);
  assert.equal(pocas.aceptado, false);
  assert.ok(pocas.motivo.includes("5 operaciones"));

  const suficientes = validarCambio(antes, uno, 450, 400);
  assert.equal(suficientes.aceptado, true);
});

test("un cambio que no cambia nada tambien se rechaza", () => {
  const r = validarCambio([c("a")], [c("a")], 500, 400);
  assert.equal(r.aceptado, false);
  assert.equal(r.motivo, "no cambia nada");
});
