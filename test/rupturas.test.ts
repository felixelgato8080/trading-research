import { test } from "node:test";
import assert from "node:assert/strict";
import { canal, volatilidad, rangoApertura, simularRuptura } from "../src/forex/rupturas";
import type { TrazaOp } from "../src/forex/rupturas";
import type { Vela } from "../src/forex/datos";

const H = 3600;
const v = (t: number, o: number, h: number, l: number, c: number): Vela => ({ t, o, h, l, c });

// ---------- canal ----------

test("EL MAXIMO DEL CANAL NO INCLUYE LA VELA ACTUAL", () => {
  // Si se incluyera, el precio romperia su propio maximo y la señal no significaria nada.
  const velas = [
    v(0, 10, 10, 10, 10), v(H, 10, 10, 10, 10), v(2 * H, 10, 10, 10, 10), v(3 * H, 10, 12, 10, 12),
  ];
  const ss = canal(velas, 3);
  assert.equal(ss.length, 1);
  assert.equal(ss[0]?.i, 3);
  assert.equal(ss[0]?.nivel, 10, "rompe el maximo de las TRES anteriores, no el suyo");
});

test("detecta rupturas a la baja", () => {
  const velas = [
    v(0, 10, 10, 10, 10), v(H, 10, 10, 10, 10), v(2 * H, 10, 10, 10, 10), v(3 * H, 10, 10, 8, 8),
  ];
  assert.equal(canal(velas, 3)[0]?.direccion, "CORTO");
});

test("sin historia suficiente no hay señal", () => {
  assert.deepEqual(canal([v(0, 1, 1, 1, 1), v(H, 1, 2, 1, 2)], 5), []);
});

// ---------- volatilidad ----------

test("la ruptura de volatilidad usa el ATR ANTERIOR", () => {
  // Usar el ATR de la vela actual mete en el umbral el propio movimiento que se quiere medir.
  const velas = [v(0, 10, 10, 10, 10), v(H, 10, 13, 10, 13)];
  const ss = volatilidad(velas, [1, 1], 2);
  assert.equal(ss.length, 1, "movimiento de 3 con umbral 2x1 = 2");
  assert.equal(ss[0]?.direccion, "LARGO");

  // Y sin ATR conocido en la vela ANTERIOR no se opina: null no es cero.
  assert.deepEqual(volatilidad(velas, [null, 1], 2), []);
});

test("un movimiento por debajo del umbral no dispara", () => {
  const velas = [v(0, 10, 10, 10, 10), v(H, 10, 11, 10, 11)];
  assert.deepEqual(volatilidad(velas, [1, 1], 2), []);
});

// ---------- rango de apertura ----------

function sesion(dia: number, horas: Array<[number, number, number, number, number]>): Vela[] {
  const base = Date.UTC(2026, 0, dia) / 1000;
  return horas.map(([h, o, hi, lo, c]) => v(base + h * H, o, hi, lo, c));
}

test("EL RANGO SOLO SE USA CUANDO YA SE FORMO", () => {
  // Usar el rango del dia en curso mientras se forma es el error clasico que hace que esta
  // estrategia parezca rentable en backtest.
  const velas = sesion(1, [
    [7, 10, 11, 9, 10],   // forma rango
    [8, 10, 12, 10, 12],  // forma rango (alto = 12)
    [9, 12, 13, 12, 13],  // ya puede romper: 13 > 12
  ]);
  const ss = rangoApertura(velas, 7, 2);
  assert.equal(ss.length, 1);
  assert.equal(ss[0]?.i, 2, "solo la tercera vela puede dar señal");
  assert.equal(ss[0]?.nivel, 12);
});

test("una sola señal por sesion y direccion", () => {
  const velas = sesion(1, [
    [7, 10, 11, 9, 10], [8, 10, 12, 10, 12],
    [9, 12, 13, 12, 13], [10, 13, 14, 13, 14], [11, 14, 15, 14, 15],
  ]);
  const largos = rangoApertura(velas, 7, 2).filter((s) => s.direccion === "LARGO");
  assert.equal(largos.length, 1, "aunque siga subiendo, la ruptura fue una");
});

test("el rango se reinicia cada dia", () => {
  const velas = [
    ...sesion(1, [[7, 10, 11, 9, 10], [8, 10, 12, 10, 12], [9, 12, 13, 12, 13]]),
    ...sesion(2, [[7, 20, 21, 19, 20], [8, 20, 22, 20, 22], [9, 22, 23, 22, 23]]),
  ];
  assert.equal(rangoApertura(velas, 7, 2).length, 2, "una ruptura por dia");
});

// ---------- simulacion ----------

const señal = { i: 0, direccion: "LARGO" as const, nivel: 100 };

test("un stop tocado da -1R", () => {
  const velas = [v(0, 100, 100, 100, 100), v(H, 100, 100, 98, 98), v(2 * H, 98, 98, 98, 98)];
  const r = simularRuptura(velas, señal, 1, 0, 0, 0);
  assert.equal(r?.motivo, "STOP");
  assert.ok(Math.abs(r!.r + 1) < 1e-9);
});

test("SIN OBJETIVO, la ganadora corre hasta que el trailing la recoge", () => {
  // Es la premisa de esta familia: el resultado vive en la cola y un objetivo fijo la corta.
  const velas = [
    v(0, 100, 100, 100, 100), v(H, 100, 105, 100, 105), v(2 * H, 105, 110, 105, 110),
    v(3 * H, 110, 110, 107, 107),
  ];
  const r = simularRuptura(velas, señal, 1, 2, 0, 0);
  assert.equal(r?.motivo, "TRAILING");
  assert.ok(r!.r > 5, `la ganadora deberia ser grande, dio ${r?.r}`);
});

test("distingue el stop inicial del trailing", () => {
  // Son dos problemas distintos: morir pronto o recortar ganancias.
  const muerePronto = [v(0, 100, 100, 100, 100), v(H, 100, 100, 98, 98)];
  assert.equal(simularRuptura(muerePronto, señal, 1, 2, 0, 0)?.motivo, "STOP");
});

test("el cierre por tiempo respeta el tope", () => {
  const plana = [v(0, 100, 100, 100, 100), ...Array.from({ length: 10 }, (_, i) => v((i + 1) * H, 100, 100.1, 99.9, 100))];
  const r = simularRuptura(plana, señal, 1, 0, 0, 3);
  assert.equal(r?.motivo, "TIEMPO");
  assert.equal(r?.velas, 3);
});

test("una señal en la ultima vela no produce operacion", () => {
  const velas = [v(0, 100, 100, 100, 100)];
  assert.equal(simularRuptura(velas, señal, 1, 0, 0, 0), null);
});

// ---------------------------------------------------------------------------------------
// EL RASTRO: lo que el simulador vio, para poder dibujarlo sin reimplementarlo
// ---------------------------------------------------------------------------------------

test("EL RASTRO NO CAMBIA NINGUNA DECISION", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 108, 100, 107), v(2, 107, 120, 106, 119),
    v(3, 119, 125, 118, 124), v(4, 124, 126, 110, 112), v(5, 112, 113, 100, 101),
  ];
  const s = { i: 0, direccion: "LARGO" as const, nivel: 101 };
  const sinTraza = simularRuptura(velas, s, 5, 2, 0, 0);
  const t = {} as TrazaOp;
  const conTraza = simularRuptura(velas, s, 5, 2, 0, 0, 0, true, true, t);
  assert.deepEqual(conTraza, sinTraza, "pasar la traza no puede alterar el resultado");
});

test("el rastro apunta la entrada y el stop inicial que uso el simulador", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 108, 100, 107), v(2, 107, 120, 106, 119),
    v(3, 119, 125, 118, 124), v(4, 124, 126, 110, 112), v(5, 112, 113, 100, 101),
  ];
  const t = {} as TrazaOp;
  simularRuptura(velas, { i: 0, direccion: "LARGO", nivel: 101 }, 5, 2, 0, 0, 0, true, true, t);
  assert.equal(t.iEntrada, 1, "se entra en la vela SIGUIENTE a la señal");
  assert.equal(t.entrada, 100, "a la apertura de esa vela");
  assert.equal(t.stopInicial, 95, "entrada menos el stop");
});

test("EL NIVEL APUNTADO ES EL VIGENTE DURANTE LA VELA, no el de despues", () => {
  // Si se apuntara despues de moverlo, el dibujo enseñaria un stop que aun no existia y una
  // salida que parece imposible.
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 108, 100, 107), v(2, 107, 120, 106, 119),
    v(3, 119, 125, 118, 124), v(4, 124, 126, 100, 102),
  ];
  const t = {} as TrazaOp;
  simularRuptura(velas, { i: 0, direccion: "LARGO", nivel: 101 }, 5, 2, 0, 0, 0, true, true, t);
  assert.equal(t.pasos[0]!.nivel, 95, "la primera vela vive con el stop inicial");
  const ultimo = t.pasos[t.pasos.length - 1]!;
  assert.equal(ultimo.i, t.iSalida, "el ultimo paso es la vela donde se sale");
  assert.equal(t.salida, ultimo.nivel, "se sale al nivel que estaba vigente, no a otro");
});

test("el rastro cubre todas las velas vividas y ninguna mas", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 108, 100, 107), v(2, 107, 120, 106, 119),
    v(3, 119, 125, 118, 124), v(4, 124, 126, 110, 112), v(5, 112, 113, 90, 91),
  ];
  const t = {} as TrazaOp;
  const r = simularRuptura(velas, { i: 0, direccion: "LARGO", nivel: 101 }, 5, 2, 0, 0, 0, true, true, t);
  assert.equal(t.pasos.length, r!.velas + 1, "una entrada por vela, entrada incluida");
  assert.equal(t.pasos[0]!.i, t.iEntrada);
});

test("SI LA VELA ABRE PASADA DEL STOP, se llena en la apertura y no en el nivel", () => {
  // El trailing se mueve al cerrar la vela, asi que la orden esta posada en el nivel viejo.
  // Si la siguiente abre atravesada, a ese nivel no te llena nadie.
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 108, 100, 107), v(2, 107, 120, 106, 119),
    v(3, 80, 82, 70, 75),   // abre en 80, muy por debajo del stop
  ];
  const s = { i: 0, direccion: "LARGO" as const, nivel: 101 };
  const t = {} as TrazaOp;
  const r = simularRuptura(velas, s, 5, 2, 0, 0, 0, true, true, t);
  assert.equal(t.salida, 80, "se sale en la apertura");
  const optimista = simularRuptura(velas, s, 5, 2, 0, 0, 0, true, false);
  assert.ok(r!.r < optimista!.r, "la version honesta nunca puede salir mejor");
});

test("si la vela abre por ENCIMA del stop, se llena en el nivel de siempre", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 108, 100, 107), v(2, 107, 120, 106, 119),
    v(3, 118, 119, 90, 95),  // abre por encima del stop y luego lo pierde
  ];
  const t = {} as TrazaOp;
  simularRuptura(velas, { i: 0, direccion: "LARGO", nivel: 101 }, 5, 2, 0, 0, 0, true, true, t);
  const nivel = t.pasos[t.pasos.length - 1]!.nivel;
  assert.equal(t.salida, nivel, "aqui el nivel si era alcanzable");
});

test("el hueco tambien cuenta en CORTO, con el signo al reves", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 100, 92, 93), v(2, 93, 94, 80, 81),
    v(3, 120, 125, 118, 124),  // abre en 120, muy por encima del stop de un corto
  ];
  const t = {} as TrazaOp;
  simularRuptura(velas, { i: 0, direccion: "CORTO", nivel: 99 }, 5, 2, 0, 0, 0, true, true, t);
  assert.equal(t.salida, 120, "se sale en la apertura, peor para el corto");
});
