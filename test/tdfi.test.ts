import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import {
  ema,
  tdfi,
  estados,
  atrStopSeguidor,
  señales,
  simularObjetivo,
  type Estado,
  type SeñalTdfi,
} from "../src/forex/tdfi";

const H = 3600;
function v(n: number, o: number, h: number, l: number, c: number): Vela {
  return { t: n * H, o, h, l, c };
}

test("la EMA no existe hasta tener el periodo completo", () => {
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[0], null);
  assert.equal(e[1], null);
  assert.equal(e[2], 2, "la primera es la media simple");
  assert.ok(e[3] != null && e[3]! > 2);
});

test("EL TDFI SE NORMALIZA SIN MIRAR EL FUTURO", () => {
  // Una serie tranquila seguida de un tramo violento. Si la normalizacion usara el maximo de
  // toda la serie, los valores del tramo tranquilo cambiarian al añadir el violento.
  const tranquilo = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3));
  const conViolento = [...tranquilo, ...Array.from({ length: 20 }, (_, i) => 100 + i * 10)];

  const a = tdfi(tranquilo, 13);
  const b = tdfi(conViolento, 13);
  for (let i = 0; i < tranquilo.length; i += 1) {
    if (a[i] == null) continue;
    assert.ok(
      Math.abs(a[i]! - b[i]!) < 1e-9,
      `el valor ${i} cambio al añadir velas futuras: ${a[i]} vs ${b[i]}`,
    );
  }
});

test("el TDFI se queda dentro de [-1, 1]", () => {
  const serie = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.1);
  for (const x of tdfi(serie, 13)) {
    if (x == null) continue;
    assert.ok(x >= -1.0000001 && x <= 1.0000001, `fuera de rango: ${x}`);
  }
});

test("una subida sostenida pone el TDFI en ALCISTA", () => {
  const sube = Array.from({ length: 120 }, (_, i) => 100 + i * 2);
  const est = estados(tdfi(sube, 13));
  assert.equal(est[est.length - 1], "ALCISTA");
});

test("una bajada sostenida pone el TDFI en BAJISTA", () => {
  const baja = Array.from({ length: 120 }, (_, i) => 300 - i * 2);
  const est = estados(tdfi(baja, 13));
  assert.equal(est[est.length - 1], "BAJISTA");
});

test("un precio plano deja el TDFI en la ZONA GRIS, que es el filtro", () => {
  const plano = new Array(120).fill(100);
  const est = estados(tdfi(plano, 13));
  assert.equal(est[est.length - 1], "PLANO");
});

test("el stop por ATR de largos SOLO SUBE mientras el precio aguante", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 106, 100, 105), v(2, 105, 111, 104, 110)];
  const atr = [1, 1, 1];
  const { largo } = atrStopSeguidor(velas, atr, 2);
  assert.equal(largo[0], 98);
  assert.ok(largo[1]! > largo[0]!, "deberia subir con el precio");
  assert.ok(largo[2]! > largo[1]!);
});

test("el stop de largos se reinicia si el precio lo pierde, UN COMPAS DESPUES", () => {
  // La formula estandar compara el cierre ANTERIOR con el stop anterior. Ese retraso de una
  // vela es deliberado: en la vela i solo se puede dar por rota una ruptura ya cerrada, y
  // adelantarlo seria mirar el futuro.
  const velas = [
    v(0, 100, 101, 99, 100),
    v(1, 100, 101, 99, 100),
    v(2, 100, 101, 80, 80),
    v(3, 80, 81, 79, 80),
  ];
  const atr = [1, 1, 1, 1];
  const { largo } = atrStopSeguidor(velas, atr, 2);
  assert.equal(largo[2], largo[1], "en la vela de la ruptura el stop aun no se ha enterado");
  assert.ok(largo[3]! < largo[2]!, "en la siguiente ya se recoloca abajo");
});

/** Estados a mano para probar las señales sin depender del indicador. */
function conEstados(lista: (Estado | null)[]): {
  velas: Vela[];
  est: (Estado | null)[];
  stops: { largo: (number | null)[]; corto: (number | null)[] };
} {
  const velas = lista.map((_, i) => v(i, 100, 101, 99, 100));
  return {
    velas,
    est: lista,
    stops: {
      largo: lista.map(() => 98),
      corto: lista.map(() => 102),
    },
  };
}

test("LA SEÑAL ES LA SALIDA DE GRIS, no el estado", () => {
  const { velas, est, stops } = conEstados(["PLANO", "ALCISTA", "ALCISTA", "ALCISTA"]);
  const s = señales(velas, est, stops);
  assert.equal(s.length, 1, "solo la transicion cuenta, no cada vela verde");
  assert.equal(s[0]!.i, 1);
  assert.equal(s[0]!.direccion, "LARGO");
});

test("SIN VOLVER A GRIS no hay señal nueva: es la regla del video", () => {
  const { velas, est, stops } = conEstados(["PLANO", "ALCISTA", "BAJISTA", "ALCISTA"]);
  const s = señales(velas, est, stops);
  assert.equal(s.length, 1, "cambiar de color sin pasar por gris no da entrada");
});

test("tras volver a gris si hay señal nueva", () => {
  const { velas, est, stops } = conEstados(["PLANO", "ALCISTA", "PLANO", "ALCISTA"]);
  assert.equal(señales(velas, est, stops).length, 2);
});

test("el riesgo es la distancia al stop del ATR en la vela de la señal", () => {
  const { velas, est, stops } = conEstados(["PLANO", "ALCISTA"]);
  const s = señales(velas, est, stops);
  assert.equal(s[0]!.riesgo, 2, "cierre 100 menos stop 98");
});

const sig = (i: number, direccion: "LARGO" | "CORTO", riesgo: number): SeñalTdfi =>
  ({ i, direccion, riesgo });

test("una ganadora da exactamente el objetivo en R", () => {
  // Entrada 100, riesgo 2 -> objetivo 101. La vela siguiente lo toca.
  const velas = [v(0, 100, 100, 100, 100), v(1, 100, 101.5, 99.5, 101)];
  const r = simularObjetivo(velas, sig(0, "LARGO", 2), 0.5, 0, 0, true);
  assert.ok(r != null);
  assert.equal(r!.motivo, "OBJETIVO");
  assert.equal(r!.r, 0.5);
});

test("una perdedora da -1R", () => {
  const velas = [v(0, 100, 100, 100, 100), v(1, 100, 100.2, 97, 97.5)];
  const r = simularObjetivo(velas, sig(0, "LARGO", 2), 0.5, 0, 0, true);
  assert.equal(r!.motivo, "STOP");
  assert.equal(r!.r, -1);
});

test("SI EN LA MISMA VELA SE TOCAN LOS DOS, cuenta el STOP", () => {
  // Vela que barre de 97 a 102: toca stop (98) y objetivo (101). No se sabe el orden.
  const velas = [v(0, 100, 100, 100, 100), v(1, 100, 102, 97, 100)];
  const r = simularObjetivo(velas, sig(0, "LARGO", 2), 0.5, 0, 0, true);
  assert.equal(r!.motivo, "STOP", "suponer lo contrario es lo que infla estas estrategias");
});

test("EL COSTE SE RESTA TAMBIEN A LAS GANADORAS", () => {
  const velas = [v(0, 100, 100, 100, 100), v(1, 100, 102, 99.5, 101)];
  const conCoste = simularObjetivo(velas, sig(0, "LARGO", 2), 0.5, 0.1, 0, true);
  assert.ok(conCoste!.r < 0.5, `deberia bajar de 0,5, fue ${conCoste!.r}`);
  assert.ok(Math.abs(conCoste!.r - (0.5 - 0.05)) < 1e-9);
});

test("ENTRAR AL CIERRE Y ENTRAR EN LA APERTURA SIGUIENTE dan resultados distintos", () => {
  // Hueco al alza entre el cierre de la señal (100) y la apertura siguiente (101).
  const velas = [v(0, 100, 100, 100, 100), v(1, 101, 101.2, 100.9, 101), v(2, 101, 102, 100.8, 101)];
  const cierre = simularObjetivo(velas, sig(0, "LARGO", 2), 0.5, 0, 0, true);
  const apertura = simularObjetivo(velas, sig(0, "LARGO", 2), 0.5, 0, 0, false);
  assert.equal(cierre!.motivo, "OBJETIVO", "entrando en 100 el objetivo 101 se toca");
  // Entrando en 101 el objetivo pasa a 102, que solo se toca en la vela siguiente.
  assert.ok(apertura == null || apertura.velas !== cierre!.velas);
});

test("un corto gana cuando el precio CAE", () => {
  const velas = [v(0, 100, 100, 100, 100), v(1, 100, 100.2, 98.5, 99)];
  const r = simularObjetivo(velas, sig(0, "CORTO", 2), 0.5, 0, 0, true);
  assert.equal(r!.motivo, "OBJETIVO");
  assert.equal(r!.r, 0.5);
});

test("sin datos suficientes devuelve null en vez de inventarse una salida", () => {
  const velas = [v(0, 100, 100, 100, 100)];
  assert.equal(simularObjetivo(velas, sig(0, "LARGO", 2), 0.5, 0, 0, true), null);
  assert.equal(simularObjetivo(velas, sig(0, "LARGO", 0), 0.5, 0, 0, true), null);
});

test("EL PUNTO DE EQUILIBRIO DE 0,5R ES 66,7% DE ACIERTO", () => {
  // Fija la aritmetica que define la estrategia: con este objetivo, ganar 2 de cada 3 es
  // empatar, no ganar. Y 2/3 es tambien lo que da entrar al azar.
  const objetivo = 0.5;
  const p = 1 / (1 + objetivo);
  assert.ok(Math.abs(p - 0.6667) < 0.0001);
  assert.ok(Math.abs(p * objetivo - (1 - p) * 1) < 1e-12, "a ese acierto la esperanza es cero");
});
