import { test } from "node:test";
import assert from "node:assert/strict";
import {
  medio, spreadBps, impacto, medirLibro, costeIdaVuelta, resumir,
  type Libro, type CosteMedido,
} from "../src/forex/libro";

/** Libro simetrico y sencillo: medio 100, spread 1 (100 pb). */
const libro = (extra: Partial<Libro> = {}): Libro => ({
  simbolo: "X", t: 0,
  demandas: [
    { precio: 99.5, cantidad: 10 },
    { precio: 99, cantidad: 10 },
    { precio: 98, cantidad: 100 },
  ],
  ofertas: [
    { precio: 100.5, cantidad: 10 },
    { precio: 101, cantidad: 10 },
    { precio: 102, cantidad: 100 },
  ],
  ...extra,
});

// ---------------------------------------------------------------------------------------
// LO BASICO
// ---------------------------------------------------------------------------------------

test("el punto medio esta entre la mejor demanda y la mejor oferta", () => {
  assert.equal(medio(libro()), 100);
});

test("el spread se da en puntos basicos SOBRE EL MEDIO", () => {
  // 1 de spread sobre 100 son 100 puntos basicos.
  assert.equal(spreadBps(libro()), 100);
});

test("un libro vacio devuelve null en vez de un cero enganoso", () => {
  const v: Libro = { simbolo: "X", t: 0, demandas: [], ofertas: [] };
  assert.equal(medio(v), null);
  assert.equal(spreadBps(v), null);
  assert.equal(medirLibro(v, 1000), null);
});

// ---------------------------------------------------------------------------------------
// IMPACTO
// ---------------------------------------------------------------------------------------

test("UN TAMAÑO QUE CABE EN EL PRIMER NIVEL no tiene impacto", () => {
  // 100 dolares contra 10 unidades a 100,5 = 1.005 disponibles.
  const r = impacto(libro().ofertas, 100);
  assert.equal(r.bps, 0);
  assert.equal(r.cortos, false);
});

test("EL IMPACTO CRECE CON EL TAMAÑO, que es de lo que se trata", () => {
  const pequeño = impacto(libro().ofertas, 500).bps;
  const grande = impacto(libro().ofertas, 3000).bps;
  assert.equal(pequeño, 0);
  assert.ok(grande > 0, "3.000 se comen dos niveles");
});

test("el impacto se mide sobre EL MEJOR PRECIO, no sobre el medio", () => {
  // Si se midiera sobre el medio, el spread se contaria dos veces: aqui y en `spreadBps`.
  const r = impacto(libro().ofertas, 1005);
  assert.equal(r.bps, 0, "llenar justo el primer nivel no empeora el precio");
});

test("SI EL LIBRO SE ACABA se marca `cortos`: es un suelo, no una medida", () => {
  const poco: Libro = {
    simbolo: "X", t: 0,
    demandas: [{ precio: 99, cantidad: 1 }],
    ofertas: [{ precio: 101, cantidad: 1 }],
  };
  const r = impacto(poco.ofertas, 1_000_000);
  assert.equal(r.cortos, true);
  assert.equal(medirLibro(poco, 1_000_000)!.librosCortos, true);
});

test("la profundidad suma todo el libro de ese lado", () => {
  // 99,5x10 + 99x10 + 98x100 = 995 + 990 + 9.800
  assert.equal(impacto(libro().demandas, 1).profundidad, 995 + 990 + 9800);
});

// ---------------------------------------------------------------------------------------
// EL COSTE COMPLETO
// ---------------------------------------------------------------------------------------

test("SE QUEDA CON EL PEOR DE LOS DOS LADOS", () => {
  // Entrar y salir pasan por los dos, y quedarse con el bueno seria elegir el dato que conviene.
  const asimetrico = libro({
    ofertas: [{ precio: 100.5, cantidad: 1000 }],
    demandas: [{ precio: 99.5, cantidad: 0.1 }, { precio: 50, cantidad: 1000 }],
  });
  const m = medirLibro(asimetrico, 5000)!;
  assert.ok(m.impactoBps > 100, `el lado vendedor es horrible y tiene que mandar: ${m.impactoBps}`);
});

test("EL SPREAD SE PAGA UNA VEZ Y EL IMPACTO Y LA COMISION DOS", () => {
  const m: CosteMedido = {
    simbolo: "X", t: 0, medio: 100, spreadBps: 10, impactoBps: 5,
    nocional: 1000, librosCortos: false, profundidad: 1e6,
  };
  // 10 + 2x5 + 2x15 = 50
  assert.equal(costeIdaVuelta(m, 15), 50);
});

// ---------------------------------------------------------------------------------------
// EL RESUMEN
// ---------------------------------------------------------------------------------------

const muestra = (spread: number, imp: number): CosteMedido => ({
  simbolo: "X", t: 0, medio: 100, spreadBps: spread, impactoBps: imp,
  nocional: 1000, librosCortos: false, profundidad: 1e6,
});

test("SE USA LA MEDIANA Y NO LA MEDIA, porque un libro vacio dispara la media", () => {
  const ms = [muestra(1, 0), muestra(1, 0), muestra(1, 0), muestra(1, 0), muestra(500, 0)];
  const r = resumir(ms, 0);
  assert.equal(r.spreadMediano, 1, "la mediana ignora el momento raro");
  const media = ms.reduce((s, m) => s + m.spreadBps, 0) / ms.length;
  assert.ok(media > 100, `la media seria ${media} y haria parecer intratable esta moneda`);
});

test("EL PERCENTIL 90 ENSEÑA LO QUE SE PAGA EN LOS MOMENTOS MALOS", () => {
  // Que es cuando saltan los stops, o sea cuando mas se opera.
  const ms = [...Array(9)].map(() => muestra(1, 0)).concat([muestra(50, 0)]);
  const r = resumir(ms, 0);
  assert.equal(r.costeMediano, 1);
  assert.ok(r.costeP90 > r.costeMediano, "la mediana sola esconde el estres");
});

test("si alguna muestra se quedo corta, el resumen lo dice", () => {
  const r = resumir([{ ...muestra(1, 0), librosCortos: true }], 15);
  assert.equal(r.algunaMuestraCorta, true);
});

test("un resumen sin muestras no divide entre cero", () => {
  const r = resumir([], 15);
  assert.equal(r.muestras, 0);
  assert.equal(r.costeMediano, 0);
});
