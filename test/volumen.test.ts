import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import {
  coberturaVolumen, vwap, volumenMedio, picoVolumen, retornoAlVwap, huecos,
} from "../src/forex/volumen";

const H = 3600;
const DIA = 86400;
const T0 = Date.parse("2026-01-01T00:00:00Z") / 1000;

function v(hora: number, o: number, h: number, l: number, c: number, vol?: number): Vela {
  return { t: T0 + hora * H, o, h, l, c, ...(vol === undefined ? {} : { v: vol }) };
}

test("la cobertura detecta series SIN volumen, que es el caso del forex", () => {
  const sinVol = [v(0, 100, 101, 99, 100), v(1, 100, 101, 99, 100)];
  assert.equal(coberturaVolumen(sinVol), 0);
  const conCeros = [v(0, 100, 101, 99, 100, 0), v(1, 100, 101, 99, 100, 0)];
  assert.equal(coberturaVolumen(conCeros), 0, "el volumen cero no cuenta como volumen");
  const buena = [v(0, 100, 101, 99, 100, 5), v(1, 100, 101, 99, 100, 5)];
  assert.equal(coberturaVolumen(buena), 1);
  assert.equal(coberturaVolumen([]), 0);
});

test("el VWAP pondera por volumen, no es una media de precios", () => {
  // Dos velas: una en 100 con volumen 1 y otra en 200 con volumen 9.
  const velas = [v(0, 100, 100, 100, 100, 1), v(1, 200, 200, 200, 200, 9)];
  const w = vwap(velas);
  assert.equal(w[0], 100);
  assert.equal(w[1], (100 * 1 + 200 * 9) / 10, "la media simple daria 150; el VWAP da 190");
});

test("EL VWAP SE REINICIA CADA DIA", () => {
  const velas = [
    v(0, 100, 100, 100, 100, 10),
    v(1, 100, 100, 100, 100, 10),
    { t: T0 + DIA, o: 200, h: 200, l: 200, c: 200, v: 10 },
  ];
  const w = vwap(velas);
  assert.equal(w[1], 100);
  assert.equal(w[2], 200, "el dia nuevo no arrastra el VWAP del anterior");
});

test("el VWAP ignora las velas sin volumen en vez de romperse", () => {
  const velas = [v(0, 100, 100, 100, 100), v(1, 200, 200, 200, 200, 5)];
  const w = vwap(velas);
  assert.equal(w[0], null);
  assert.equal(w[1], 200);
});

test("EL VOLUMEN MEDIO NO INCLUYE LA VELA ACTUAL", () => {
  // Si la incluyera, un pico se compararia consigo mismo.
  const velas = [
    v(0, 1, 1, 1, 1, 10), v(1, 1, 1, 1, 1, 10), v(2, 1, 1, 1, 1, 10),
    v(3, 1, 1, 1, 1, 10), v(4, 1, 1, 1, 1, 1000),
  ];
  const m = volumenMedio(velas, 4);
  assert.equal(m[4], 10, "la media en la vela del pico debe ser la de las anteriores");
});

test("un pico de volumen se detecta y una vela normal no", () => {
  const base = Array.from({ length: 25 }, (_, i) => v(i, 1, 1, 1, 1, 10));
  const conPico = [...base, v(25, 1, 1, 1, 1, 30)];
  const p = picoVolumen(conPico, 20, 2);
  assert.equal(p[25], true, "30 es 3 veces la media de 10");
  assert.equal(p[24], false);
});

test("SIN VOLUMEN no hay picos: no se inventa nada", () => {
  const sinVol = Array.from({ length: 30 }, (_, i) => v(i, 1, 1, 1, 1));
  assert.equal(picoVolumen(sinVol, 20, 2).filter(Boolean).length, 0);
});

test("el retorno al VWAP exige TOCARLO y cerrar por encima", () => {
  // Tres velas claramente por encima del VWAP y luego una que lo pincha y cierra arriba.
  const velas = [
    v(0, 100, 100, 100, 100, 10),
    v(1, 110, 112, 108, 111, 10),
    v(2, 111, 113, 110, 112, 10),
    v(3, 112, 114, 111, 113, 10),
    v(4, 113, 114, 100, 112, 10),
  ];
  const w = vwap(velas);
  const s = retornoAlVwap(velas, w, 3);
  assert.equal(s.length, 1, `esperaba una señal, hubo ${s.length}`);
  assert.equal(s[0]!.i, 4);
  assert.equal(s[0]!.direccion, "LARGO");
});

test("si NO toca el VWAP no hay señal", () => {
  const velas = [
    v(0, 100, 100, 100, 100, 10),
    v(1, 110, 112, 108, 111, 10),
    v(2, 111, 113, 110, 112, 10),
    v(3, 112, 114, 111, 113, 10),
    v(4, 113, 114, 112, 113, 10),
  ];
  assert.equal(retornoAlVwap(velas, vwap(velas), 3).length, 0);
});

test("NO HAY RETROCESO AL VWAP ENTRE DIAS DISTINTOS", () => {
  const velas = [
    v(0, 100, 100, 100, 100, 10),
    v(1, 110, 112, 108, 111, 10),
    { t: T0 + DIA, o: 112, h: 114, l: 100, c: 113, v: 10 },
  ];
  assert.equal(retornoAlVwap(velas, vwap(velas), 2).length, 0);
});

test("un hueco al alza da señal LARGO y uno a la baja CORTO", () => {
  const velas = [v(0, 100, 100, 100, 100, 10), v(1, 110, 111, 109, 110, 10)];
  const h = huecos(velas, 0.05, false);
  assert.equal(h.length, 1);
  assert.equal(h[0]!.direccion, "LARGO");
  assert.ok(Math.abs(h[0]!.tamaño - 0.1) < 1e-9);

  const baja = [v(0, 100, 100, 100, 100, 10), v(1, 90, 91, 89, 90, 10)];
  assert.equal(huecos(baja, 0.05, false)[0]!.direccion, "CORTO");
});

test("un hueco menor que el minimo se descarta", () => {
  const velas = [v(0, 100, 100, 100, 100, 10), v(1, 101, 101, 101, 101, 10)];
  assert.equal(huecos(velas, 0.05, false).length, 0);
});

test("EXIGIR VOLUMEN filtra el hueco flojo, que es lo que hay que poder medir", () => {
  const base = Array.from({ length: 25 }, (_, i) => v(i, 100, 100, 100, 100, 10));
  const flojo = [...base, v(25, 110, 111, 109, 110, 10)];
  const fuerte = [...base, v(25, 110, 111, 109, 110, 50)];

  assert.equal(huecos(flojo, 0.05, false).length, 1, "sin exigir volumen entra");
  assert.equal(huecos(flojo, 0.05, true).length, 0, "exigiendo volumen se cae");
  assert.equal(huecos(fuerte, 0.05, true).length, 1, "con volumen de verdad entra");
});
