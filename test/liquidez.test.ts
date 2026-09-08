import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import {
  volumenDolar, liquidezMedia, indexarPorFecha, universoEn,
  fechasRevision, calendarioUniverso, estabaDentro,
} from "../src/forex/liquidez";

const DIA = 86400;
const v = (i: number, p: number, vol?: number): Vela =>
  ({ t: i * DIA, o: p, h: p, l: p, c: p, ...(vol === undefined ? {} : { v: vol }) });

test("el volumen en dolares es precio por volumen, no volumen a secas", () => {
  assert.equal(volumenDolar(v(0, 100, 5)), 500);
  assert.equal(volumenDolar(v(0, 2, 5)), 10, "una moneda barata con mucho volumen mueve poco");
  assert.equal(volumenDolar(v(0, 100)), null, "sin volumen no se inventa");
  assert.equal(volumenDolar(v(0, 100, 0)), null);
});

test("LA LIQUIDEZ NO INCLUYE LA VELA ACTUAL", () => {
  // La vela 10 tiene un volumen enorme: es justo el de la ruptura. No debe contaminar el filtro.
  const velas = [
    ...Array.from({ length: 10 }, (_, i) => v(i, 100, 10)),
    v(10, 100, 100_000),
  ];
  assert.equal(liquidezMedia(velas, 10, 10), 1000, "10 velas x 100$ = 1000$ de media");
});

test("sin historia suficiente la liquidez es null, no cero", () => {
  const velas = [v(0, 100, 10), v(1, 100, 10)];
  assert.equal(liquidezMedia(velas, 2, 30), null, "null es 'no lo se', cero seria 'no habia'");
});

test("EL UNIVERSO ELIGE POR LIQUIDEZ, no por precio", () => {
  const caro = Array.from({ length: 40 }, (_, i) => v(i, 10_000, 1));       // 10.000$/dia
  const barato = Array.from({ length: 40 }, (_, i) => v(i, 1, 5_000_000));  // 5.000.000$/dia
  const idx = indexarPorFecha(new Map([["caro", caro], ["barato", barato]]));
  const u = universoEn(idx, 39 * DIA, 1, 30);
  assert.deepEqual([...u], ["barato"], "manda el dinero movido, no el precio unitario");
});

test("un instrumento SIN DATOS en esa fecha no entra en el universo", () => {
  const largo = Array.from({ length: 40 }, (_, i) => v(i, 100, 1000));
  const tarde = Array.from({ length: 10 }, (_, i) => v(30 + i, 100, 999_999));
  const idx = indexarPorFecha(new Map([["largo", largo], ["tarde", tarde]]));
  // En el dia 20 el que empieza tarde no existe todavia.
  assert.deepEqual([...universoEn(idx, 20 * DIA, 5, 10)], ["largo"]);
});

test("un instrumento sin volumen NUNCA entra: no se puede saber si era liquido", () => {
  const conVol = Array.from({ length: 40 }, (_, i) => v(i, 100, 1000));
  const sinVol = Array.from({ length: 40 }, (_, i) => v(i, 100));
  const idx = indexarPorFecha(new Map([["conVol", conVol], ["sinVol", sinVol]]));
  assert.deepEqual([...universoEn(idx, 39 * DIA, 5, 30)], ["conVol"]);
});

test("EL UNIVERSO CAMBIA CON EL TIEMPO: eso es todo el sentido de esto", () => {
  // A es el grande al principio; B le adelanta a mitad de serie.
  const a = Array.from({ length: 100 }, (_, i) => v(i, 100, i < 50 ? 10_000 : 100));
  const b = Array.from({ length: 100 }, (_, i) => v(i, 100, i < 50 ? 100 : 10_000));
  const idx = indexarPorFecha(new Map([["A", a], ["B", b]]));

  assert.deepEqual([...universoEn(idx, 40 * DIA, 1, 20)], ["A"]);
  assert.deepEqual([...universoEn(idx, 90 * DIA, 1, 20)], ["B"]);
});

test("las fechas de revision salen del instrumento con mas historia", () => {
  const corto = Array.from({ length: 10 }, (_, i) => v(i, 100, 10));
  const largo = Array.from({ length: 100 }, (_, i) => v(i, 100, 10));
  const idx = indexarPorFecha(new Map([["corto", corto], ["largo", largo]]));
  assert.equal(fechasRevision(idx, 20).length, 5, "100 velas cada 20 son 5 revisiones");
});

test("ESTABA DENTRO usa la revision ANTERIOR, nunca la siguiente", () => {
  const a = Array.from({ length: 100 }, (_, i) => v(i, 100, i < 50 ? 10_000 : 100));
  const b = Array.from({ length: 100 }, (_, i) => v(i, 100, i < 50 ? 100 : 10_000));
  const idx = indexarPorFecha(new Map([["A", a], ["B", b]]));
  const cal = calendarioUniverso(idx, 1, 20, 10);

  // En el dia 45 la ultima revision es la del 40, cuando aun mandaba A.
  assert.equal(estabaDentro(cal, "A", 45 * DIA), true);
  assert.equal(estabaDentro(cal, "B", 45 * DIA), false, "usar la revision futura seria trampa");
});

test("antes de la primera revision nadie esta dentro", () => {
  const a = Array.from({ length: 100 }, (_, i) => v(i, 100, 1000));
  const idx = indexarPorFecha(new Map([["A", a]]));
  const cal = calendarioUniverso(idx, 1, 20, 10);
  assert.equal(estabaDentro(cal, "A", -1), false);
});

test("con el universo vacio no revienta", () => {
  const idx = indexarPorFecha(new Map<string, Vela[]>());
  assert.equal(universoEn(idx, 0, 5, 30).size, 0);
  assert.equal(fechasRevision(idx, 10).length, 0);
  assert.equal(estabaDentro([], "A", 0), false);
});
