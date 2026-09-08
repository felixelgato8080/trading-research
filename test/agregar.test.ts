import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import { agregar, saludCuerpo, porDia } from "../src/forex/agregar";

const H = 3600;
const v = (t: number, o: number, h: number, l: number, c: number, vol = 0): Vela =>
  ({ t, o, h, l, c, v: vol });

test("LA APERTURA ES LA DE LA PRIMERA Y EL CIERRE EL DE LA ULTIMA", () => {
  const dia = Date.UTC(2026, 0, 5) / 1000;
  const r = agregar([
    v(dia, 100, 105, 99, 104, 10),
    v(dia + H, 104, 110, 103, 108, 20),
    v(dia + 2 * H, 108, 109, 95, 96, 30),
  ]);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { t: dia, o: 100, h: 110, l: 95, c: 96, v: 60 });
});

test("cada dia va por su lado", () => {
  const d1 = Date.UTC(2026, 0, 5) / 1000;
  const d2 = Date.UTC(2026, 0, 6) / 1000;
  const r = agregar([v(d1, 100, 101, 99, 100), v(d1 + H, 100, 102, 98, 101), v(d2, 101, 103, 100, 102)]);
  assert.equal(r.length, 2);
  assert.equal(r[1]!.o, 101);
});

test("un grupo que REAPARECE mas tarde no se fusiona a distancia", () => {
  // Fusionarlo mezclaria la apertura de un momento con el cierre de otro que no lo toca.
  const d1 = Date.UTC(2026, 0, 5) / 1000;
  const d2 = Date.UTC(2026, 0, 6) / 1000;
  const r = agregar([v(d1, 100, 101, 99, 100), v(d2, 200, 201, 199, 200), v(d1, 50, 51, 49, 50)]);
  assert.equal(r.length, 3, "cada tramo consecutivo es su propia vela");
});

test("agrupar por semana tambien funciona", () => {
  const lunes = Date.UTC(2026, 0, 5) / 1000;
  const semana = (t: number) => String(Math.floor(t / (7 * 86400)));
  const r = agregar([v(lunes, 100, 101, 99, 100), v(lunes + 86400, 100, 105, 98, 104)], semana);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.c, 104);
});

test("SALUD DEL CUERPO: detecta la serie con apertura y cierre pegados", () => {
  const rota = [v(0, 1.4, 1.41, 1.39, 1.4), v(H, 1.4, 1.42, 1.38, 1.4)];
  const s = saludCuerpo(rota);
  assert.equal(s.cuerpoCero, 1, "las dos tienen apertura igual al cierre");
  assert.equal(s.cuerpoMedio, 0);
});

test("una serie sana da un cuerpo medio alto", () => {
  const sana = [v(0, 100, 110, 100, 110), v(H, 100, 110, 100, 100.5)];
  const s = saludCuerpo(sana);
  assert.equal(s.velas, 2);
  assert.ok(s.cuerpoMedio > 0.5, `cuerpo medio ${s.cuerpoMedio}`);
  assert.equal(s.cuerpoCero, 0);
});

test("las velas sin rango no cuentan, no dividen entre cero", () => {
  assert.deepEqual(saludCuerpo([v(0, 5, 5, 5, 5)]), { velas: 0, cuerpoMedio: 0, cuerpoCero: 0 });
});

test("porDia agrupa en UTC", () => {
  assert.equal(porDia(Date.UTC(2026, 0, 5, 23) / 1000), "2026-01-05");
  assert.equal(porDia(Date.UTC(2026, 0, 6, 0) / 1000), "2026-01-06");
});
