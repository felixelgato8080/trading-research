import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import {
  fvgs, barridos, enVentana, señales, simular, unaPorSesion, type AjustesIct,
} from "../src/forex/ict";

const H = 3600;
const T0 = Date.parse("2026-01-01T00:00:00Z") / 1000;
const v = (i: number, o: number, h: number, l: number, c: number): Vela =>
  ({ t: T0 + i * H, o, h, l, c });

const AJ: AjustesIct = {
  swing: 5, ventanaIfvg: 10, minFvg: 0, desdeH: 0, hastaH: 24, colchon: 0.1,
};

// ---------------------------------------------------------------------------------------
// FVG
// ---------------------------------------------------------------------------------------

test("UN FVG ALCISTA ES UN HUECO: el minimo de la 3a por encima del maximo de la 1a", () => {
  const velas = [v(0, 100, 102, 99, 101), v(1, 101, 108, 100, 107), v(2, 107, 110, 105, 109)];
  const f = fvgs(velas);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.direccion, "ALCISTA");
  assert.equal(f[0]!.bajo, 102, "el suelo del hueco es el maximo de la primera");
  assert.equal(f[0]!.alto, 105, "el techo es el minimo de la tercera");
});

test("un FVG bajista es el espejo", () => {
  const velas = [v(0, 100, 102, 98, 99), v(1, 99, 100, 92, 93), v(2, 93, 96, 90, 91)];
  const f = fvgs(velas);
  assert.equal(f.length, 1);
  assert.equal(f[0]!.direccion, "BAJISTA");
  assert.equal(f[0]!.bajo, 96);
  assert.equal(f[0]!.alto, 98);
});

test("SI LAS MECHAS SE SOLAPAN NO HAY HUECO", () => {
  const velas = [v(0, 100, 105, 99, 104), v(1, 104, 108, 103, 107), v(2, 107, 110, 104, 109)];
  assert.equal(fvgs(velas).length, 0, "el minimo de la 3a (104) no supera al maximo de la 1a");
});

test("EL FVG SE CONOCE EN LA TERCERA VELA, no antes", () => {
  const velas = [v(0, 100, 102, 99, 101), v(1, 101, 108, 100, 107), v(2, 107, 110, 105, 109)];
  assert.equal(fvgs(velas)[0]!.i, 2, "usar el indice de la primera seria mirar el futuro");
});

test("el tamaño minimo descarta huecos de ruido", () => {
  const velas = [v(0, 100, 100.01, 99, 100), v(1, 100, 101, 100, 100.5), v(2, 100.5, 101, 100.02, 100.8)];
  assert.equal(fvgs(velas, 0).length, 1);
  assert.equal(fvgs(velas, 0.01).length, 0, "un hueco del 0,01% no llega al 1% exigido");
});

// ---------------------------------------------------------------------------------------
// BARRIDO CON RECHAZO
// ---------------------------------------------------------------------------------------

/** Cinco velas planas entre 99 y 101 para tener un extremo claro. */
const base = (): Vela[] => Array.from({ length: 5 }, (_, i) => v(i, 100, 101, 99, 100));

test("BARRIDO DE MINIMO: la mecha pasa abajo pero el cierre VUELVE DENTRO", () => {
  const velas = [...base(), v(5, 100, 100.5, 95, 100)];
  const b = barridos(velas, 5);
  assert.equal(b.length, 1);
  assert.equal(b[0]!.direccion, "LARGO");
  assert.equal(b[0]!.nivel, 99);
  assert.equal(b[0]!.extremo, 95, "el stop va en la punta de la mecha");
});

test("SI EL CIERRE SE QUEDA FUERA NO ES BARRIDO: es una ruptura", () => {
  const velas = [...base(), v(5, 100, 100.5, 95, 96)];
  assert.equal(barridos(velas, 5).length, 0, "cerrar fuera es la estrategia contraria");
});

test("barrido de maximo da direccion CORTO", () => {
  const velas = [...base(), v(5, 100, 105, 99.5, 100)];
  const b = barridos(velas, 5);
  assert.equal(b[0]!.direccion, "CORTO");
  assert.equal(b[0]!.extremo, 105);
});

test("sin superar el extremo no hay barrido", () => {
  const velas = [...base(), v(5, 100, 100.5, 99.5, 100)];
  assert.equal(barridos(velas, 5).length, 0);
});

// ---------------------------------------------------------------------------------------
// VENTANA HORARIA
// ---------------------------------------------------------------------------------------

test("la ventana horaria filtra por hora UTC", () => {
  const t = (h: number): number => T0 + h * H;
  assert.equal(enVentana(t(15), 14, 16), true);
  assert.equal(enVentana(t(13), 14, 16), false);
  assert.equal(enVentana(t(16), 14, 16), false, "el limite superior no entra");
});

test("UNA VENTANA QUE CRUZA MEDIANOCHE funciona igual", () => {
  const t = (h: number): number => T0 + h * H;
  assert.equal(enVentana(t(23), 22, 2), true);
  assert.equal(enVentana(t(1), 22, 2), true);
  assert.equal(enVentana(t(12), 22, 2), false);
});

// ---------------------------------------------------------------------------------------
// SEÑAL COMPLETA
// ---------------------------------------------------------------------------------------

/**
 * Escenario armado a mano: tramo bajista que deja un FVG BAJISTA, luego barre el minimo con
 * rechazo, y despues una vela cierra por encima del hueco invalidandolo.
 */
function escenarioLargo(): Vela[] {
  return [
    v(0, 110, 111, 109, 110),
    v(1, 110, 110, 104, 105),   // impulso bajista
    v(2, 105, 106, 100, 101),   // FVG bajista: [106, 109]
    v(3, 101, 103, 100, 102),
    v(4, 102, 103, 100, 102),
    v(5, 102, 103, 95, 102),    // barre el minimo 100 y cierra dentro -> LARGO
    v(6, 102, 108, 101, 107),   // cierra por encima de 106: invalida el FVG bajista
    v(7, 107, 112, 106, 111),
  ];
}

test("SEÑAL COMPLETA: barrido de minimo, luego FVG bajista invalidado", () => {
  const s = señales(escenarioLargo(), { ...AJ, swing: 4 });
  assert.equal(s.length, 1, `esperaba una señal, hubo ${s.length}`);
  assert.equal(s[0]!.direccion, "LARGO");
  assert.equal(s[0]!.i, 6, "la entrada es la vela que invalida el hueco");
  assert.ok(s[0]!.stop < 95, "el stop va por debajo del extremo del barrido");
});

test("SIN BARRIDO NO HAY SEÑAL aunque se invalide el hueco", () => {
  const velas = escenarioLargo();
  // Se quita el barrido: la vela 5 ya no perfora el minimo.
  velas[5] = v(5, 102, 103, 100.5, 102);
  assert.equal(señales(velas, { ...AJ, swing: 4 }).length, 0);
});

test("SIN INVALIDAR EL HUECO no hay entrada", () => {
  const velas = escenarioLargo();
  // La vela 6 ya no cierra por encima del techo del hueco.
  velas[6] = v(6, 102, 105, 101, 104);
  velas[7] = v(7, 104, 105, 103, 104);
  assert.equal(señales(velas, { ...AJ, swing: 4 }).length, 0);
});

test("FUERA DE LA VENTANA HORARIA no se opera", () => {
  const s = señales(escenarioLargo(), { ...AJ, swing: 4, desdeH: 20, hastaH: 22 });
  assert.equal(s.length, 0, "la señal cae a las 6 UTC, fuera de 20-22");
});

test("LA SEÑAL CADUCA si el hueco tarda demasiado en invalidarse", () => {
  const s = señales(escenarioLargo(), { ...AJ, swing: 4, ventanaIfvg: 0 });
  assert.equal(s.length, 0);
});

// ---------------------------------------------------------------------------------------
// SIMULACION
// ---------------------------------------------------------------------------------------

test("una ganadora llega al objetivo y da su RR", () => {
  const velas = escenarioLargo();
  const s = señales(velas, { ...AJ, swing: 4 })[0]!;
  const r = simular(velas, s, 0, 0);
  assert.ok(r != null);
  assert.equal(r!.motivo, "OBJETIVO");
  assert.ok(r!.r > 0);
  assert.ok(r!.rr > 0, "la señal tiene que declarar su riesgo-beneficio");
});

test("SI SE TOCAN STOP Y OBJETIVO EN LA MISMA VELA, cuenta el STOP", () => {
  const velas = [...escenarioLargo()];
  const s = señales(velas, { ...AJ, swing: 4 })[0]!;
  // Vela de entrada que barre desde muy abajo hasta muy arriba.
  velas[7] = v(7, 107, 130, 80, 120);
  const r = simular(velas, s, 0, 0);
  assert.equal(r!.motivo, "STOP", "suponer lo contrario infla cualquier backtest");
});

test("EL COSTE RESTA en las dos direcciones", () => {
  const velas = escenarioLargo();
  const s = señales(velas, { ...AJ, swing: 4 })[0]!;
  const gratis = simular(velas, s, 0, 0)!;
  const caro = simular(velas, s, 0.5, 0)!;
  assert.ok(caro.r < gratis.r);
});

test("UNA OPERACION POR DIA, que es la regla del plan", () => {
  const velas = escenarioLargo();
  const dos = [
    { i: 6, direccion: "LARGO" as const, stop: 90, objetivo: 120, iBarrido: 5 },
    { i: 7, direccion: "LARGO" as const, stop: 90, objetivo: 120, iBarrido: 5 },
  ];
  assert.equal(unaPorSesion(velas, dos).length, 1);
});

test("dos dias distintos dan dos operaciones", () => {
  const velas = [
    ...escenarioLargo(),
    ...Array.from({ length: 30 }, (_, i) => v(30 + i, 100, 101, 99, 100)),
  ];
  const dos = [
    { i: 6, direccion: "LARGO" as const, stop: 90, objetivo: 120, iBarrido: 5 },
    { i: 35, direccion: "LARGO" as const, stop: 90, objetivo: 120, iBarrido: 34 },
  ];
  assert.equal(unaPorSesion(velas, dos).length, 2);
});
