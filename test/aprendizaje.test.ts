import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esperanza, desviacion, muestraNecesaria, riesgoDeConfundirse, normal,
  operacionesPorRevision, type Distribucion,
} from "../src/forex/aprendizaje";

/** La distribucion real de la estrategia que sobrevivio: 36% de acierto, 2,35R y -0,86R. */
const REAL: Distribucion = { acierto: 0.36, rGana: 2.35, rPierde: 0.86 };

test("la esperanza sale de acierto y tamaños, no del acierto solo", () => {
  const e = esperanza(REAL);
  assert.ok(Math.abs(e - (0.36 * 2.35 - 0.64 * 0.86)) < 1e-12);
  assert.ok(e > 0.29 && e < 0.30, `esperanza ${e}`);
});

test("UN ACIERTO ALTO PUEDE SER PEOR que uno bajo", () => {
  const bajo: Distribucion = { acierto: 0.36, rGana: 2.35, rPierde: 0.86 };
  const alto: Distribucion = { acierto: 0.70, rGana: 0.4, rPierde: 1.0 };
  assert.ok(esperanza(bajo) > 0);
  assert.ok(esperanza(alto) < 0, "70% de acierto con ganadoras chicas pierde dinero");
});

test("la desviacion por operacion es GRANDE comparada con la esperanza", () => {
  const sd = desviacion(REAL);
  assert.ok(sd > 1.4 && sd < 1.6, `sd ${sd}`);
  // Esto es lo que hace tan lento aprender: el ruido es cinco veces la señal.
  assert.ok(sd / esperanza(REAL) > 4);
});

test("SIN VARIACION no hace falta muestra, pero tampoco hay nada que medir", () => {
  const constante: Distribucion = { acierto: 1, rGana: 1, rPierde: 0 };
  assert.equal(desviacion(constante), 0);
  assert.equal(muestraNecesaria(0, 0.1), Infinity);
});

test("LA MUESTRA NECESARIA CRECE CON EL CUADRADO de la precision pedida", () => {
  const sd = 1.5;
  const n1 = muestraNecesaria(sd, 0.30);
  const n2 = muestraNecesaria(sd, 0.15);
  assert.ok(Math.abs(n2 / n1 - 4) < 0.1, "la mitad de diferencia cuesta cuatro veces mas datos");
});

test("PARA DISTINGUIR MEDIA VENTAJA hacen falta cientos de operaciones", () => {
  const sd = desviacion(REAL);
  const n = muestraNecesaria(sd, esperanza(REAL) / 2);
  assert.ok(n > 350 && n < 600, `hacen falta ${n} operaciones`);
});

test("con pocas operaciones el riesgo de confundirse ronda la moneda al aire", () => {
  const sd = desviacion(REAL);
  const r3 = riesgoDeConfundirse(sd, 0.15, 3);
  const r400 = riesgoDeConfundirse(sd, 0.15, 400);
  assert.ok(r3 > 0.4, `con 3 operaciones el riesgo es ${r3.toFixed(2)}`);
  assert.ok(r400 < 0.05, `con 400 baja a ${r400.toFixed(3)}`);
});

test("la normal acumulada esta bien calibrada", () => {
  assert.ok(Math.abs(normal(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normal(1.645) - 0.95) < 0.001);
  assert.ok(Math.abs(normal(-1.645) - 0.05) < 0.001);
  assert.ok(Math.abs(normal(1.96) - 0.975) < 0.001);
});

test("UNA REVISION SEMANAL DE ESTA ESTRATEGIA VE MUY POCAS OPERACIONES", () => {
  // 143 operaciones al año en las 30 monedas.
  const semanal = operacionesPorRevision(143, 7);
  assert.ok(semanal > 2 && semanal < 3.5, `${semanal.toFixed(1)} operaciones por semana`);

  // Y para aprender algo harian falta cientos.
  const sd = desviacion(REAL);
  const n = muestraNecesaria(sd, esperanza(REAL) / 2);
  assert.ok(n / semanal > 100, "harian falta mas de cien semanas por cada decision");
});

test("con mas frecuencia la revision ve mas, pero sigue sin bastar", () => {
  const mensual = operacionesPorRevision(143, 30);
  assert.ok(mensual > 10 && mensual < 13);
  const anual = operacionesPorRevision(143, 365);
  assert.ok(Math.abs(anual - 143) < 1);
});
