import { test } from "node:test";
import assert from "node:assert/strict";
import { simular, resumir, type ReglasSalidaFx, type Costes } from "../src/forex/backtest";
import type { Vela } from "../src/forex/datos";
import { pip } from "../src/forex/datos";
import type { Señal } from "../src/forex/rsi";

const PIP = 0.01; // par con JPY
const REGLAS: ReglasSalidaFx = { objetivoR: 1, stopPips: 20, maxVelas: 0 };
const SIN_COSTE: Costes = { spreadPips: 0 };

const v = (o: number, h: number, l: number, c: number, t = 0): Vela => ({ t, o, h, l, c });
const sig = (i: number, direccion: "LARGO" | "CORTO"): Señal => ({ i, direccion, rsi: 25 });

test("SE ENTRA EN LA APERTURA DE LA VELA SIGUIENTE, no al cierre de la señal", () => {
  // Entrar al cierre de la misma vela que genera la señal es mirar el futuro. Aqui la vela 1
  // abre en 150 y la señal es de la vela 0: la entrada tiene que ser 150.
  const velas = [v(100, 100, 100, 100), v(150, 154, 150, 154), v(154, 154, 154, 154)];
  const [op] = simular(velas, [sig(0, "LARGO")], REGLAS, SIN_COSTE, PIP);
  assert.equal(op?.iEntrada, 1);
  // Objetivo = 150 + 20 pips = 150.20, que la vela 1 alcanza (max 154).
  assert.equal(op?.motivo, "OBJETIVO");
  assert.ok(Math.abs(op!.r - 1) < 1e-9);
});

test("SI EN LA MISMA VELA SE TOCAN STOP Y OBJETIVO, GANA EL STOP", () => {
  // No sabemos el orden de los precios dentro de una vela. Suponer que fue el objetivo regala
  // operaciones ganadoras, y es de los sesgos que mas infla un backtest de intradia.
  const velas = [v(100, 100, 100, 100), v(100, 101, 99, 100)];
  const [op] = simular(velas, [sig(0, "LARGO")], REGLAS, SIN_COSTE, PIP);
  assert.equal(op?.motivo, "STOP");
  assert.ok(Math.abs(op!.r + 1) < 1e-9, "una perdida completa es -1R");
});

test("un stop tocado da exactamente -1R", () => {
  const velas = [v(100, 100, 100, 100), v(100, 100, 99.7, 99.7)];
  const [op] = simular(velas, [sig(0, "LARGO")], REGLAS, SIN_COSTE, PIP);
  assert.equal(op?.motivo, "STOP");
  assert.ok(Math.abs(op!.r + 1) < 1e-9);
});

test("EL SPREAD SE PAGA DOS VECES: al entrar y al salir", () => {
  // En temporalidades pequeñas hay muchas operaciones y este coste manda sobre todo lo demas.
  const velas = [v(100, 100, 100, 100), v(100, 100.2, 100, 100.2), v(100.2, 100.2, 100.2, 100.2)];
  const sin = simular(velas, [sig(0, "LARGO")], REGLAS, { spreadPips: 0 }, PIP)[0]!;
  const con = simular(velas, [sig(0, "LARGO")], REGLAS, { spreadPips: 2 }, PIP)[0]!;
  // 2 pips de spread sobre un stop de 20 pips = 0,2R de coste (0,1R por lado).
  assert.ok(Math.abs((sin.r - con.r) - 0.2) < 0.01, `diferencia ${(sin.r - con.r).toFixed(3)}`);
});

test("el corto gana cuando el precio baja", () => {
  const velas = [v(100, 100, 100, 100), v(100, 100, 99.7, 99.7)];
  const [op] = simular(velas, [sig(0, "CORTO")], REGLAS, SIN_COSTE, PIP);
  assert.equal(op?.motivo, "OBJETIVO");
  assert.ok(op!.r > 0.9);
});

test("el corte por tiempo cierra al precio que haya", () => {
  const plana = [v(100, 100, 100, 100), ...Array.from({ length: 10 }, () => v(100, 100.05, 99.95, 100))];
  const [op] = simular(plana, [sig(0, "LARGO")], { ...REGLAS, maxVelas: 3 }, SIN_COSTE, PIP);
  assert.equal(op?.motivo, "TIEMPO");
  assert.equal(op?.velas, 3);
});

test("una señal en la ultima vela no produce operacion", () => {
  const velas = [v(100, 100, 100, 100), v(100, 100, 100, 100)];
  assert.deepEqual(simular(velas, [sig(1, "LARGO")], REGLAS, SIN_COSTE, PIP), []);
});

test("EL PIP DE LOS PARES CON JPY ES 100 VECES MAYOR", () => {
  // Aplicar el tamaño equivocado multiplica o divide los costes por 100, y con spreads de
  // 1-2 pips eso es la diferencia entre rentable y ruinoso.
  assert.equal(pip("USDJPY=X"), 0.01);
  assert.equal(pip("EURJPY=X"), 0.01);
  assert.equal(pip("EURUSD=X"), 0.0001);
  assert.equal(pip("GBPUSD=X"), 0.0001);
});

test("el resumen cuenta lo que dice contar", () => {
  const ops = [
    { iEntrada: 0, iSalida: 1, direccion: "LARGO" as const, r: 1, motivo: "OBJETIVO" as const, velas: 1 },
    { iEntrada: 0, iSalida: 1, direccion: "LARGO" as const, r: -1, motivo: "STOP" as const, velas: 3 },
    { iEntrada: 0, iSalida: 1, direccion: "CORTO" as const, r: 1, motivo: "OBJETIVO" as const, velas: 2 },
  ];
  const r = resumir(ops);
  assert.equal(r.operaciones, 3);
  assert.equal(r.totalR, 1);
  assert.ok(Math.abs(r.tasaAcierto - 2 / 3) < 1e-9);
  assert.equal(r.velasMedianas, 2);
  assert.equal(r.porMotivo.OBJETIVO, 2);
});

test("sin operaciones el resumen no revienta", () => {
  const r = resumir([]);
  assert.equal(r.operaciones, 0);
  assert.equal(r.mediaR, 0);
  assert.equal(r.tasaAcierto, 0);
});
