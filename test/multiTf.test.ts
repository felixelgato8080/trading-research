import { test } from "node:test";
import assert from "node:assert/strict";
import { ema, alinear, señalesMulti, REGLAS_MULTI } from "../src/forex/multiTf";
import type { Vela } from "../src/forex/datos";

const v = (t: number, c: number): Vela => ({ t, o: c, h: c, l: c, c });

test("la EMA arranca con una media simple y luego suaviza", () => {
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[0], null);
  assert.equal(e[1], null);
  assert.equal(e[2], 2, "media simple de 1,2,3");
  // k = 2/4 = 0.5 → 4*0.5 + 2*0.5 = 3
  assert.equal(e[3], 3);
});

test("una serie mas corta que el periodo no da EMA", () => {
  assert.deepEqual(ema([1, 2], 5), [null, null]);
});

// ---------- alineacion ----------

test("ALINEAR NO PUEDE USAR LA VELA EN CURSO", () => {
  // A las 10:03 no se conoce el cierre de la vela horaria de las 10:00. Usarla es mirar el
  // futuro, y es el fallo que hace ganar a cualquier estrategia multi-temporal en backtest.
  const h1 = [v(0, 1), v(3600, 2), v(7200, 3)];
  const m5 = [v(3900, 0), v(7500, 0)]; // 01:05 y 02:05
  const a = alinear(m5, h1);
  // A las 01:05 la ultima vela H1 CERRADA es la de las 00:00 (indice 0), no la de las 01:00.
  assert.equal(a[0], 0);
  assert.equal(a[1], 1);
});

test("antes de que cierre la primera vela grande no hay referencia", () => {
  const h1 = [v(0, 1), v(3600, 2)];
  const m5 = [v(600, 0)]; // 00:10, la vela H1 de las 00:00 aun no cerro
  assert.equal(alinear(m5, h1)[0], null);
});

test("con menos de dos velas grandes no se puede deducir la duracion", () => {
  assert.deepEqual(alinear([v(0, 1)], [v(0, 1)]), [null]);
});

// ---------- señales ----------

/** M5 que cae a sobreventa y cruza de vuelta. */
function m5BajaYCruza(): Vela[] {
  const s: Vela[] = [];
  let p = 100;
  for (let i = 0; i < 30; i += 1) {
    p -= 1;
    s.push(v(i * 300, p));
  }
  for (let i = 0; i < 10; i += 1) {
    p += 2;
    s.push(v((30 + i) * 300, p));
  }
  return s;
}

test("sin filtros, el cruce de M5 genera señal", () => {
  const m5 = m5BajaYCruza();
  const ss = señalesMulti(m5, [], [], {
    ...REGLAS_MULTI,
    emaH1: 0,
    exigirM15: false,
  });
  assert.ok(ss.length > 0);
  assert.equal(ss[0]?.direccion, "LARGO");
});

test("EL FILTRO DE TENDENCIA DESCARTA LO QUE VA CONTRA H1", () => {
  // Es lo unico que aporta la estructura de tres marcos: no operar contra la tendencia mayor.
  const m5 = m5BajaYCruza();
  // H1 bajista: precio muy por debajo de su EMA.
  const h1: Vela[] = Array.from({ length: 250 }, (_, i) => v(i * 3600, 1000 - i * 3));
  const conFiltro = señalesMulti(m5, [], h1, { ...REGLAS_MULTI, exigirM15: false });
  const sinFiltro = señalesMulti(m5, [], [], { ...REGLAS_MULTI, emaH1: 0, exigirM15: false });
  assert.ok(sinFiltro.length > 0);
  assert.equal(conFiltro.length, 0, "un largo contra tendencia bajista se descarta");
});

test("sin datos de H1 suficientes para la EMA no se opera a ciegas", () => {
  const m5 = m5BajaYCruza();
  const h1 = [v(0, 100), v(3600, 101)]; // insuficiente para EMA200
  assert.deepEqual(señalesMulti(m5, [], h1, { ...REGLAS_MULTI, exigirM15: false }), []);
});

test("exigir M15 sin datos de M15 no inventa confirmacion", () => {
  const m5 = m5BajaYCruza();
  assert.deepEqual(
    señalesMulti(m5, [], [], { ...REGLAS_MULTI, emaH1: 0, exigirM15: true }),
    [],
  );
});
