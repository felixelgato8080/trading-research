import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import { serieDePrueba } from "../src/forex/sinFuturo";
import { atr } from "../src/forex/multiTf";
import { simular } from "../src/forex/estructuraValida";
import {
  evaluar, medir, sigmas, informe,
  evaluarPorRiesgo,
  type SeñalEvaluable, type SeñalPorRiesgo, type Simulador, type Medida,
} from "../src/forex/controles";

const VELAS = serieDePrueba(600);
const DATOS = new Map([["A", VELAS], ["B", serieDePrueba(600, 777)]]);
const ATR = (v: Vela[]) => atr(v, 14);

/** El simulador real del proyecto, con el coste a cero para que las pruebas sean exactas. */
const SIM: Simulador = (v, s, extremo) => simular(v, s, 0, 200, extremo);

/** Señales sencillas y honestas: cada 40 velas, stop y objetivo fijos. */
const señalesDe = (_par: string, v: Vela[]): SeñalEvaluable[] => {
  const out: SeñalEvaluable[] = [];
  const a = atr(v, 14);
  for (let i = 60; i < v.length - 1; i += 40) {
    const av = a[i];
    if (av == null || !(av > 0)) continue;
    const entrada = v[i]!.c;
    out.push({
      i, direccion: "LARGO", entrada,
      stop: entrada - av, objetivo: entrada + av * 2, rr: 2,
    });
  }
  return out;
};

// ---------------------------------------------------------------------------------------
// MEDIR
// ---------------------------------------------------------------------------------------

test("una lista vacia no divide entre cero", () => {
  const m = medir([]);
  assert.equal(m.n, 0);
  assert.equal(m.pf, 0);
  assert.equal(m.esperanza, 0);
  assert.equal(m.error, 0);
});

test("el acierto y el profit factor salen de las mismas operaciones", () => {
  const m = medir([{ r: 2, rr: 2 }, { r: -1, rr: 2 }, { r: 2, rr: 2 }, { r: -1, rr: 2 }]);
  assert.equal(m.n, 4);
  assert.equal(m.acierto, 0.5);
  assert.equal(m.pf, 2);
  assert.equal(m.esperanza, 0.5);
});

test("EL ERROR TIPICO BAJA CON LA RAIZ DE N, que es lo que hace legible una diferencia", () => {
  const pocas = medir(Array.from({ length: 25 }, (_, k) => ({ r: k % 2 ? 2 : -1, rr: 2 })));
  const muchas = medir(Array.from({ length: 100 }, (_, k) => ({ r: k % 2 ? 2 : -1, rr: 2 })));
  assert.ok(Math.abs(pocas.error / muchas.error - 2) < 0.15, "cuatro veces mas datos, mitad de error");
});

test("SIGMAS combina los dos errores, no solo el de uno", () => {
  const a: Medida = { n: 100, acierto: 0.5, pf: 2, esperanza: 0.3, error: 0.1, rr: 2 };
  const b: Medida = { n: 100, acierto: 0.4, pf: 1, esperanza: 0.1, error: 0.1, rr: 2 };
  // 0,2 de diferencia sobre sqrt(0,1² + 0,1²) = 0,1414
  assert.ok(Math.abs(sigmas(a, b) - 0.2 / Math.sqrt(0.02)) < 1e-9);
});

test("sin error no se inventa una sigma infinita", () => {
  const cero: Medida = { n: 0, acierto: 0, pf: 0, esperanza: 0, error: 0, rr: 0 };
  assert.equal(sigmas(cero, cero), 0);
});

// ---------------------------------------------------------------------------------------
// LA BATERIA
// ---------------------------------------------------------------------------------------

test("la bateria devuelve las cuatro comparaciones y el reparto por instrumento", () => {
  const b = evaluar(DATOS, ATR, señalesDe, SIM);
  assert.ok(b.estrategia.n > 10, `pocas operaciones: ${b.estrategia.n}`);
  assert.ok(b.azar.n > b.estrategia.n, "el azar corre muchas mas veces para apretar su error");
  // Casi iguales, no identicas: una señal cerca del final puede resolverse en un sentido y
  // quedarse abierta en el otro, y las que no se resuelven no cuentan. Una diferencia GRANDE si
  // seria sospechosa, porque significaria que los dos lados no son comparables.
  assert.ok(
    Math.abs(b.alReves.n - b.estrategia.n) <= Math.max(2, b.estrategia.n * 0.05),
    `volteadas ${b.alReves.n} contra ${b.estrategia.n}: demasiada diferencia para compararlas`,
  );
  assert.equal(b.instrumentos, 2);
  assert.equal(b.mitades[0]!.n + b.mitades[1]!.n, b.estrategia.n, "las mitades suman el total");
});

test("EL CONTROL VOLTEADO USA EL EXTREMO DEL VIAJE ORIGINAL", () => {
  // Es el fallo que costo mas caro: deducir el extremo valido del lado VOLTEADO mata el control
  // con un maximo que ya habia pasado. Decia -0,329R donde la verdad era -0,022R.
  //
  // Una vela de entrada que cae fuerte: para el largo original vale su minimo; para el corto
  // volteado, ese mismo minimo es su objetivo y SI es alcanzable.
  const velas: Vela[] = [
    { t: 0, o: 142, h: 143, l: 100, c: 112 },
    { t: 3600, o: 112, h: 113, l: 111, c: 112 },
  ];
  const señal = (_p: string): SeñalEvaluable[] => [
    { i: 0, direccion: "LARGO", entrada: 112, stop: 105, objetivo: 119, rr: 1 },
  ];
  const b = evaluar(new Map([["X", velas]]), ATR, señal, SIM, { vecesAzar: 0 });
  assert.equal(b.alReves.n, 1);
  assert.ok(
    b.alReves.esperanza > 0,
    `el corto volteado alcanza su objetivo con el minimo de 100, dio ${b.alReves.esperanza}`,
  );
});

test("EL AZAR ENTRA AL CIERRE, asi que de esa vela no cuenta ningun extremo", () => {
  // Contar los extremos de la vela de entrada al azar fabrica stops que ocurrieron ANTES de
  // entrar, y hunde el control artificialmente.
  const vistos: Array<string | undefined> = [];
  const espia: Simulador = (v, s, extremo) => { vistos.push(extremo); return SIM(v, s, extremo); };
  evaluar(DATOS, ATR, señalesDe, espia, { vecesAzar: 5 });
  assert.ok(vistos.includes("NINGUNO"), "el azar tiene que pedir NINGUNO");
  assert.ok(vistos.includes("MINIMO") || vistos.includes("MAXIMO"), "el volteado pide el suyo");
});

test("ES REPRODUCIBLE: la misma semilla da el mismo azar", () => {
  const a = evaluar(DATOS, ATR, señalesDe, SIM, { semilla: 7 });
  const b = evaluar(DATOS, ATR, señalesDe, SIM, { semilla: 7 });
  assert.deepEqual(a.azar, b.azar);
  const c = evaluar(DATOS, ATR, señalesDe, SIM, { semilla: 8 });
  assert.notDeepEqual(a.azar, c.azar);
});

test("LAS MITADES SE PARTEN POR TIEMPO, no por numero de operaciones", () => {
  // Partir por cuenta mete las dos mitades en el mismo tramo cuando un instrumento opera mucho
  // mas que otro, y entonces la prueba de estabilidad no prueba estabilidad.
  const corto = serieDePrueba(200, 5);
  const largo = serieDePrueba(600, 6);
  const b = evaluar(new Map([["corto", corto], ["largo", largo]]), ATR, señalesDe, SIM);
  const mitad = [...corto, ...largo].map((v) => v.t).sort((x, y) => x - y);
  assert.equal(b.corte, mitad[Math.floor(mitad.length / 2)]);
});

test("SIN EL MEJOR INSTRUMENTO se calcula sobre los demas, no sobre todos", () => {
  const b = evaluar(DATOS, ATR, señalesDe, SIM);
  assert.notEqual(b.sinElMejor, b.estrategia.esperanza);
  assert.ok(b.sinElMejor <= b.estrategia.esperanza + 1e-9, "quitar el mejor no puede mejorar");
});

test("una estrategia sin señales devuelve ceros y no revienta", () => {
  const b = evaluar(DATOS, ATR, () => [], SIM);
  assert.equal(b.estrategia.n, 0);
  assert.equal(b.alReves.n, 0);
  assert.equal(b.sinElMejor, 0);
});

test("el informe trae las sigmas, que es lo unico que decide si una diferencia es real", () => {
  const t = informe(evaluar(DATOS, ATR, señalesDe, SIM));
  assert.ok(t.includes("σ"), "sin sigmas, los numeros se leen mal");
  assert.ok(t.includes("azar mismo perfil"));
  assert.ok(t.includes("misma señal al reves"));
  assert.ok(t.includes("1a mitad"));
  assert.ok(t.includes("en verde"));
});

// ---------------------------------------------------------------------------------------
// LA FAMILIA POR RIESGO
// ---------------------------------------------------------------------------------------
//
// TDFI, VWAP y flujo no hablan de entrada, stop y objetivo: hablan de un riesgo y un multiplo
// de R, entrando al cierre. Antes cada uno se implementaba su propio control de azar y no tenia
// ninguno de los otros tres. `evaluarPorRiesgo` traduce a la ida y destraduce en el simulador,
// para que la logica de los controles siga viviendo en un solo sitio.
//
// Lo que hay que probar es que esa traduccion NO CAMBIA NADA. Si cambiara, seria otra vez una
// copia de los controles que divergio en silencio, que es justo lo que este modulo existe para
// impedir.

/** La misma estrategia dicha en las dos lenguas. */
const porRiesgo = (_par: string, v: Vela[]): SeñalPorRiesgo[] => {
  const out: SeñalPorRiesgo[] = [];
  const a = atr(v, 14);
  for (let i = 60; i < v.length - 1; i += 40) {
    const av = a[i];
    if (av == null || !(av > 0)) continue;
    out.push({ i, direccion: "LARGO", riesgo: av });
  }
  return out;
};

test("LA TRADUCCION NO CAMBIA NI UN NUMERO", () => {
  const enPrecios = evaluar(DATOS, ATR, señalesDe, SIM);
  const enRiesgo = evaluarPorRiesgo(
    DATOS, ATR, porRiesgo, 2,
    (v, s, objetivoR, extremo) => {
      const largo = s.direccion === "LARGO";
      const entrada = v[s.i]!.c;
      return simular(v, {
        i: s.i, direccion: s.direccion, entrada,
        stop: largo ? entrada - s.riesgo : entrada + s.riesgo,
        objetivo: largo ? entrada + s.riesgo * objetivoR : entrada - s.riesgo * objetivoR,
        rr: objetivoR,
      }, 0, 200, extremo);
    },
  );
  // Se comparan con tolerancia y no con igualdad exacta: la ida y la vuelta pasan por
  // `entrada - riesgo` y luego por `|entrada - stop|`, y eso deja restos de 1e-14. Lo que tiene
  // que coincidir es el NUMERO DE OPERACIONES y el resultado, no los ultimos bits.
  const igual = (a: Medida, b: Medida, que: string): void => {
    assert.equal(a.n, b.n, `${que}: distinto numero de operaciones`);
    assert.ok(Math.abs(a.esperanza - b.esperanza) < 1e-9, `${que}: ${a.esperanza} vs ${b.esperanza}`);
    assert.ok(Math.abs(a.acierto - b.acierto) < 1e-12, `${que}: acierto`);
  };
  igual(enRiesgo.estrategia, enPrecios.estrategia, "la estrategia");
  igual(enRiesgo.alReves, enPrecios.alReves, "al reves");
  igual(enRiesgo.mitades[0], enPrecios.mitades[0], "1a mitad");
  igual(enRiesgo.mitades[1], enPrecios.mitades[1], "2a mitad");
  assert.ok(Math.abs(enRiesgo.sinElMejor - enPrecios.sinElMejor) < 1e-9);
});

test("el objetivo en R llega al simulador tal cual, no reconstruido a ojo", () => {
  const vistos: number[] = [];
  evaluarPorRiesgo(
    new Map([["A", VELAS]]), ATR, porRiesgo, 2.5,
    (_v, _s, objetivoR) => { vistos.push(objetivoR); return { r: 0 }; },
    { vecesAzar: 1 },
  );
  // Las de la estrategia y las volteadas van a 2,5 exactos. Las del azar tambien, porque el
  // control usa el R:R MEDIO de la estrategia, que aqui es ese mismo.
  assert.ok(vistos.length > 0);
  for (const x of vistos) assert.ok(Math.abs(x - 2.5) < 1e-9, `objetivo ${x}`);
});

test("UNA SEÑAL CON RIESGO CERO SE DESCARTA en vez de dar una R infinita", () => {
  // Un Infinity en la lista destruye la media de todas las demas, y lo hace en silencio.
  let vistas = 0;
  const b = evaluarPorRiesgo(
    new Map([["A", VELAS]]), ATR,
    () => [{ i: 100, direccion: "LARGO", riesgo: 0 }], 2,
    () => { vistas += 1; return { r: 1 }; },
    { vecesAzar: 1 },
  );
  assert.equal(b.estrategia.n, 0, "la señal sin riesgo no llega a contarse");
  assert.ok(Number.isFinite(b.azar.esperanza));
  // Las unicas que llegan al simulador son las del control de azar, que si tienen riesgo.
  assert.equal(vistas, b.azar.n);
});
