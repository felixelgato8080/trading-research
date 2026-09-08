import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import { serieDePrueba } from "../src/forex/sinFuturo";
import { atr } from "../src/forex/multiTf";
import { simular } from "../src/forex/estructuraValida";
import {
  evaluar, medir, sigmas, informe,
  type SeñalEvaluable, type Simulador, type Medida,
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
