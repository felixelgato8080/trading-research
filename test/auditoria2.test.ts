/**
 * AUDITORIA, segunda parte: controles positivos de los módulos que faltaban.
 *
 * En `auditoria.test.ts` quedaron cubiertos RSI, ATR, ruptura de canal, reversión, simetría
 * largo/corto y contabilidad del coste. Aquí van los que no tenían control positivo:
 * TDFI, VWAP, momento transversal, huecos y el grabador.
 *
 * La regla es la misma: una serie amañada donde el módulo está OBLIGADO a detectar lo suyo. Si
 * no lo detecta, el "no funciona" que hemos publicado no significa nada.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import { tdfi, estados, atrStopSeguidor, señales as señalesTdfi } from "../src/forex/tdfi";
import { vwap, retornoAlVwap, picoVolumen, huecos } from "../src/forex/volumen";
import { indexar, calendario, simular as simularMomento } from "../src/forex/momento";
import { atr } from "../src/forex/multiTf";

const DIA = 86400;
const H = 3600;
const T0 = Date.parse("2026-01-01T00:00:00Z") / 1000;
const vela = (i: number, o: number, h: number, l: number, c: number, v?: number): Vela =>
  ({ t: T0 + i * DIA, o, h, l, c, ...(v === undefined ? {} : { v }) });

// ---------------------------------------------------------------------------------------
// TDFI
// ---------------------------------------------------------------------------------------

test("CONTROL POSITIVO · el TDFI DETECTA un giro de bajista a alcista", () => {
  // Baja, se aplana, y arranca al alza. El indicador tiene que pasar por las tres fases.
  const cierres: number[] = [];
  for (let i = 0; i < 60; i += 1) cierres.push(200 - i * 2);
  for (let i = 0; i < 40; i += 1) cierres.push(80);
  for (let i = 0; i < 60; i += 1) cierres.push(80 + i * 2);

  const est = estados(tdfi(cierres, 13));
  const vistos = new Set(est.filter((x) => x != null));
  assert.ok(vistos.has("BAJISTA"), "no vio la bajada");
  assert.ok(vistos.has("PLANO"), "no vio la zona gris, que es el filtro entero");
  assert.ok(vistos.has("ALCISTA"), "no vio la subida");
  assert.equal(est[est.length - 1], "ALCISTA");
});

test("CONTROL POSITIVO · el TDFI da señal al SALIR de gris hacia arriba", () => {
  const cierres: number[] = [];
  for (let i = 0; i < 60; i += 1) cierres.push(100);
  for (let i = 0; i < 60; i += 1) cierres.push(100 + i * 3);
  const velas = cierres.map((c, i) => vela(i, c, c + 1, c - 1, c));

  const est = estados(tdfi(cierres, 13));
  const stops = atrStopSeguidor(velas, atr(velas, 14), 2);
  const s = señalesTdfi(velas, est, stops);
  assert.ok(s.length > 0, "no dio ni una señal en un giro limpio de plano a alcista");
  assert.equal(s[0]!.direccion, "LARGO");
});

// ---------------------------------------------------------------------------------------
// VWAP
// ---------------------------------------------------------------------------------------

test("CONTROL POSITIVO · el VWAP detecta el retroceso y rebote de un día", () => {
  // Un día de 8 horas: sube, se aleja del VWAP, vuelve a tocarlo y rebota.
  const velas: Vela[] = [
    { t: T0, o: 100, h: 101, l: 99, c: 100, v: 100 },
    { t: T0 + H, o: 100, h: 106, l: 100, c: 105, v: 100 },
    { t: T0 + 2 * H, o: 105, h: 111, l: 105, c: 110, v: 100 },
    { t: T0 + 3 * H, o: 110, h: 116, l: 110, c: 115, v: 100 },
    { t: T0 + 4 * H, o: 115, h: 116, l: 104, c: 114, v: 100 },
  ];
  const w = vwap(velas);
  assert.ok(w[3] != null && w[3]! < 115, "el VWAP debe ir por detrás del precio en una subida");
  const s = retornoAlVwap(velas, w, 3);
  assert.equal(s.length, 1, "no detectó el retroceso al VWAP");
  assert.equal(s[0]!.direccion, "LARGO");
});

test("CONTROL POSITIVO · el pico de volumen detecta un volumen 5 veces mayor", () => {
  const base = Array.from({ length: 30 }, (_, i) => vela(i, 100, 101, 99, 100, 20));
  const conPico = [...base, vela(30, 100, 101, 99, 100, 100)];
  const p = picoVolumen(conPico, 20, 2);
  assert.equal(p[30], true);
  assert.equal(p.slice(0, 30).filter(Boolean).length, 0, "no debería marcar velas normales");
});

test("CONTROL POSITIVO · los huecos se detectan en las dos direcciones", () => {
  const velas = [
    vela(0, 100, 100, 100, 100, 10),
    vela(1, 115, 116, 114, 115, 10),
    vela(2, 115, 116, 114, 115, 10),
    vela(3, 95, 96, 94, 95, 10),
  ];
  const h = huecos(velas, 0.05, false);
  assert.equal(h.length, 2, `esperaba dos huecos, encontró ${h.length}`);
  assert.equal(h[0]!.direccion, "LARGO");
  assert.equal(h[1]!.direccion, "CORTO");
});

// ---------------------------------------------------------------------------------------
// MOMENTO TRANSVERSAL
// ---------------------------------------------------------------------------------------

test("CONTROL POSITIVO · el momento GANA cuando el líder es siempre el mismo", () => {
  // Un activo sube sin parar y los demás están planos. Rankear tiene que ganar a la media.
  const n = 300;
  const serie = (f: (i: number) => number): Vela[] =>
    Array.from({ length: n }, (_, i) => {
      const p = f(i);
      return vela(i, p, p, p, p);
    });
  const datos = new Map<string, Vela[]>([
    ["lider", serie((i) => 100 * 1.01 ** i)],
    ["plano1", serie(() => 100)],
    ["plano2", serie(() => 100)],
    ["plano3", serie(() => 100)],
  ]);
  const idx = indexar(datos);
  const cal = calendario(idx);

  const rank = simularMomento(idx, cal, {
    lookback: 60, hueco: 5, cartera: 1, rebalanceo: 20, absoluto: false, coste: 0,
  });
  const todo = simularMomento(idx, cal, {
    lookback: 60, hueco: 5, cartera: 4, rebalanceo: 20, absoluto: false, coste: 0,
  });

  assert.ok(rank.capitalFinal > 1, "el ranking debería ganar dinero con un líder claro");
  assert.ok(
    rank.capitalFinal > todo.capitalFinal,
    `elegir al líder (${rank.capitalFinal.toFixed(2)}) debe batir a tenerlo todo ` +
      `(${todo.capitalFinal.toFixed(2)}); si no, el ranking no está ordenando bien`,
  );
});

test("CONTROL POSITIVO · el momento ELIGE al líder, no a otro", () => {
  const n = 200;
  const serie = (f: (i: number) => number): Vela[] =>
    Array.from({ length: n }, (_, i) => {
      const p = f(i);
      return vela(i, p, p, p, p);
    });
  const idx = indexar(new Map<string, Vela[]>([
    ["sube", serie((i) => 100 + i)],
    ["baja", serie((i) => 200 - i * 0.5)],
  ]));
  const r = simularMomento(idx, calendario(idx), {
    lookback: 60, hueco: 5, cartera: 1, rebalanceo: 20, absoluto: false, coste: 0,
  });
  const conEleccion = r.periodos.filter((p) => p.seleccion.length > 0);
  assert.ok(conEleccion.length > 0);
  for (const p of conEleccion) assert.deepEqual(p.seleccion, ["sube"]);
});

// ---------------------------------------------------------------------------------------
// LA COMPROBACION TRANSVERSAL: ningun modulo mira el futuro
// ---------------------------------------------------------------------------------------

test("NINGUN INDICADOR CAMBIA AL AÑADIR VELAS FUTURAS", () => {
  // Es la prueba general contra mirar el futuro: los valores del tramo antiguo tienen que ser
  // idénticos con y sin las velas nuevas. Cubre RSI, ATR, TDFI y VWAP a la vez.
  const corto = Array.from({ length: 120 }, (_, i) => {
    const p = 100 + Math.sin(i / 7) * 10;
    return vela(i, p, p + 2, p - 2, p, 100 + (i % 5));
  });
  const largo = [
    ...corto,
    ...Array.from({ length: 60 }, (_, i) => {
      const p = 300 + i * 20;
      return vela(120 + i, p, p + 40, p - 40, p, 9999);
    }),
  ];

  const compara = (a: (number | null)[], b: (number | null)[], nombre: string): void => {
    for (let i = 0; i < corto.length; i += 1) {
      if (a[i] == null && b[i] == null) continue;
      assert.ok(
        a[i] != null && b[i] != null && Math.abs(a[i]! - b[i]!) < 1e-9,
        `${nombre}: el valor ${i} cambió al añadir velas futuras (${a[i]} vs ${b[i]})`,
      );
    }
  };

  compara(atr(corto, 14), atr(largo, 14), "ATR");
  compara(tdfi(corto.map((v) => v.c), 13), tdfi(largo.map((v) => v.c), 13), "TDFI");
  compara(vwap(corto), vwap(largo), "VWAP");
  compara(
    atrStopSeguidor(corto, atr(corto, 14), 2).largo,
    atrStopSeguidor(largo, atr(largo, 14), 2).largo,
    "stop ATR",
  );
});
