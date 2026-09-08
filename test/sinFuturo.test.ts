import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import { violaciones, violacionesEstrictas, serieDePrueba } from "../src/forex/sinFuturo";
import { atr } from "../src/forex/multiTf";
import { rsi } from "../src/forex/rsi";
import { canal, volatilidad, rangoApertura } from "../src/forex/rupturas";
import { retrocesoEnTendencia, huecoBajista, sma } from "../src/forex/reversion";
import { fvgs, barridos } from "../src/forex/ict";
import { picoVolumen, huecos as huecosVolumen } from "../src/forex/volumen";
import { tdfi, estados, atrStopSeguidor, señales as señalesTdfi } from "../src/forex/tdfi";
import { señales as señalesSmc, type AjustesSMC } from "../src/forex/smc";
import { señales as señalesZona, type AjustesZona } from "../src/forex/estructuraValida";
import {
  señales as señalesDiv, type AjustesDivergencia, type AjustesEntrada,
} from "../src/forex/divergencia";

const VELAS = serieDePrueba(600);

// Los parametros de cada estrategia estan elegidos para que PRODUZCAN señales en esta serie, y
// se midieron uno a uno. No son los de produccion: aqui no se busca rentabilidad, se busca
// ejercitar el codigo. Una estrategia sin señales aprueba sin probar nada, y eso ya paso.

/**
 * El catalogo. Cada entrada es una estrategia y como se le piden las señales.
 *
 * Añadir un modulo de señales sin meterlo aqui es dejarlo sin la unica prueba que caza la clase
 * de fallo mas cara del proyecto. Si mañana aparece uno nuevo, va en esta lista.
 */
const ZONA: AjustesSMC = {
  minHueco: 0.2, minEmpuje: 1, vigencia: 60, esperaBloque: 20, colchon: 0.1,
  objetivoR: 2, radioLiquidez: 0.5, toquesLiquidez: 3, memoriaHuecos: 50,
};
const AJ_ZONA: AjustesZona = { impulso: 1.5, colchon: 0.1, rrMinimo: 0, vigencia: 30 };
const AJ_DIV: AjustesDivergencia = {
  periodoRsi: 14, confirmacion: 2, umbralAlto: 70,
  minSeparacion: 3, maxSeparacion: 60, exigirFueraDelCanal: false,
};
const AJ_ENT: AjustesEntrada = {
  zona: ZONA, esperaZona: 40, esperaEntrada: 60, colchon: 0.1,
  stop: "ZONA", objetivo: "FIJO", objetivoR: 2, rrMinimo: 0, minRiesgoAtr: 0,
};

const CATALOGO: Array<[string, (v: Vela[]) => Array<{ i: number }>]> = [
  ["rupturas.canal(20)", (v) => canal(v, 20)],
  ["rupturas.canal(50)", (v) => canal(v, 50)],
  // La que corre en produccion. No tenia esta prueba.
  ["rupturas.volatilidad(2)", (v) => volatilidad(v, atr(v, 14), 2)],
  ["rupturas.rangoApertura", (v) => rangoApertura(v, 0, 4)],
  ["reversion.retrocesoEnTendencia", (v) => retrocesoEnTendencia(v, 14, 50, 50)],
  ["reversion.huecoBajista", (v) =>
    huecoBajista(v, atr(v, 14), 1, sma(v.map((x) => x.c), 50))],
  ["ict.fvgs", (v) => fvgs(v, 0).map((x) => ({ ...x }))],
  ["ict.barridos", (v) => barridos(v, 20).map((x) => ({ ...x }))],
  ["volumen.picoVolumen", (v) =>
    // Devuelve boolean[] con una entrada por vela, no indices. La primera version hacia
    // `.map((i) => ({ i }))` sobre los booleanos y la prueba no comprobaba nada.
    picoVolumen(v, 20, 2).flatMap((es, i) => (es ? [{ i }] : []))],
  ["volumen.huecos", (v) => huecosVolumen(v, 0.01, false)],
  ["tdfi.señales", (v) => {
    const t = tdfi(v.map((x) => x.c), 13);
    const est = estados(t, 0.05);
    return señalesTdfi(v, est, atrStopSeguidor(v, atr(v, 14), 2));
  }],
  ["smc.señales", (v) => señalesSmc(v, atr(v, 14), ZONA)],
  ["estructuraValida.señales", (v) => señalesZona(v, atr(v, 14), AJ_ZONA)],
  ["divergencia.señales (misma temporalidad)", (v) =>
    señalesDiv(v, rsi(v.map((x) => x.c), 14), v, atr(v, 14), AJ_DIV, AJ_ENT)],
];

for (const [nombre, señales] of CATALOGO) {
  test(`NO MIRA AL FUTURO: ${nombre}`, () => {
    // SIN ESTO, UNA ESTRATEGIA QUE NO PRODUCE SEÑALES APRUEBA SIN PROBAR NADA.
    //
    // Paso: tres estrategias de hueco daban cero señales porque la serie de prueba abria
    // siempre en el cierre anterior, y sus pruebas salian verdes sin ejercitar una linea.
    assert.ok(
      señales(VELAS).length >= 3,
      `${nombre} no produce señales en la serie de prueba: la prueba no probaria nada`,
    );
    const vs = violaciones(VELAS, señales);
    if (vs.length) {
      const m = vs.slice(0, 3).map(
        (x) => `  corte ${x.corte}, señal ${x.senal}: ${x.motivo}\n` +
          `    con prefijo: ${x.conPrefijo}\n    con todo:    ${x.conTodo}`,
      ).join("\n");
      assert.fail(`${vs.length} violacion(es) en ${nombre}:\n${m}`);
    }
  });
}

test("EL CATALOGO CUBRE TODOS LOS MODULOS DE SEÑALES", () => {
  // Si mañana alguien añade una estrategia y no la mete arriba, se queda sin la prueba y nadie
  // se entera. Esta lista es lo que hace visible ese olvido.
  const cubiertos = new Set(CATALOGO.map(([n]) => n.split(".")[0]));
  for (const m of [
    "rupturas", "reversion", "ict", "volumen", "tdfi", "smc",
    "estructuraValida", "divergencia",
  ]) {
    assert.ok(cubiertos.has(m), `el modulo ${m} no esta en el catalogo`);
  }
});

// ---------------------------------------------------------------------------------------
// EL PROPIO ARNES
// ---------------------------------------------------------------------------------------

/** Mira la vela SIGUIENTE, que es exactamente lo que no se puede hacer. */
const tramposa = (v: Vela[]): Array<{ i: number; precio: number }> => {
  const out: Array<{ i: number; precio: number }> = [];
  for (let i = 10; i < v.length - 1; i += 50) {
    if (v[i + 1]!.c > v[i]!.c) out.push({ i, precio: v[i]!.c });
  }
  return out;
};

test("EL TEST DE PREFIJOS NO CAZA leer una vela por delante", () => {
  // Es el limite real del arnes, y conviene tenerlo escrito: al cortar la serie, la vela que la
  // tramposa espia sigue estando ahi, asi que el resultado sale identico. Descubrirlo aqui es
  // barato; descubrirlo dentro de seis meses en un resultado publicado, no.
  assert.deepEqual(violaciones(VELAS, tramposa), []);
});

test("LA COMPROBACION ESTRICTA SI LA CAZA", () => {
  const vs = violacionesEstrictas(VELAS, tramposa);
  assert.ok(vs.length > 0, "cortar en la propia vela de decision deja sin futuro que espiar");
  assert.equal(vs[0]!.motivo, "DESAPARECE");
});

test("el arnes no se queja de una estrategia honesta", () => {
  const honesta = (v: Vela[]): Array<{ i: number }> => {
    const out: Array<{ i: number }> = [];
    for (let i = 1; i < v.length; i += 1) if (v[i]!.c > v[i - 1]!.c) out.push({ i });
    return out;
  };
  assert.deepEqual(violaciones(VELAS, honesta), []);
});

test("detecta que CAMBIE una señal, no solo que desaparezca", () => {
  // Un stop o una entrada que se recalculan al conocer el futuro son igual de graves.
  const recalcula = (v: Vela[]): Array<{ i: number; stop: number }> => {
    const maximo = Math.max(...v.map((x) => x.h));
    return [{ i: 100, stop: maximo }];
  };
  const vs = violaciones(VELAS, recalcula);
  assert.ok(vs.length > 0);
  assert.equal(vs[0]!.motivo, "CAMBIA");
});

test("LA SERIE DE PRUEBA es deterministica, o el arnes no seria reproducible", () => {
  assert.deepEqual(serieDePrueba(50), serieDePrueba(50));
  assert.notDeepEqual(serieDePrueba(50), serieDePrueba(50, 999));
});

test("la serie de prueba tiene velas grandes, donde se esconde el look-ahead", () => {
  const rangos = VELAS.map((v) => v.h - v.l).sort((a, b) => b - a);
  assert.ok(rangos[0]! > rangos[Math.floor(rangos.length / 2)]! * 4, "hace falta cola gorda");
});

// ---------------------------------------------------------------------------------------
// LA COMPROBACION ESTRICTA, donde el indice de la señal ES la vela de decision
// ---------------------------------------------------------------------------------------

const DECISION: Array<[string, (v: Vela[]) => Array<{ i: number }>]> = [
  ["rupturas.canal(20)", (v) => canal(v, 20)],
  ["rupturas.volatilidad(2)", (v) => volatilidad(v, atr(v, 14), 2)],
  ["reversion.retrocesoEnTendencia", (v) => retrocesoEnTendencia(v, 14, 50, 50)],
  ["smc.señales", (v) => señalesSmc(v, atr(v, 14), ZONA)],
  ["estructuraValida.señales", (v) => señalesZona(v, atr(v, 14), AJ_ZONA)],
];

for (const [nombre, señales] of DECISION) {
  test(`DECIDE CON LO QUE HAY HASTA SU VELA: ${nombre}`, () => {
    const vs = violacionesEstrictas(VELAS, señales);
    if (vs.length) {
      const lineas = [`${vs.length} violacion(es) en ${nombre}:`];
      for (const x of vs.slice(0, 3)) {
        lineas.push(`  señal ${x.senal}: ${x.motivo}`);
        lineas.push(`    cortando en ella:    ${x.conPrefijo}`);
        lineas.push(`    con la serie entera: ${x.conTodo}`);
      }
      assert.fail(lineas.join(String.fromCharCode(10)));
    }
  });
}
