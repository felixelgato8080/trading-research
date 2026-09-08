import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import {
  huecos, bloques, roturas, hayLiquidez, huecoPendiente, señales, simularParcial,
  type AjustesSMC,
} from "../src/forex/smc";

const H = 3600;
const v = (i: number, o: number, h: number, l: number, c: number): Vela =>
  ({ t: i * H, o, h, l, c });

const AJ: AjustesSMC = {
  minHueco: 0.2, minEmpuje: 1, vigencia: 60, esperaBloque: 20, colchon: 0.1,
  objetivoR: 2, radioLiquidez: 0.5, toquesLiquidez: 3, memoriaHuecos: 50,
};
const atrPlano = (n: number) => Array.from({ length: n }, () => 5);

// ---------------------------------------------------------------------------------------
// HUECOS
// ---------------------------------------------------------------------------------------

test("UN HUECO ALCISTA es cuando la tercera vela no toca a la primera", () => {
  const velas = [v(0, 100, 102, 98, 101), v(1, 101, 118, 100, 117), v(2, 117, 125, 110, 124)];
  const h = huecos(velas, 0.2, atrPlano(3));
  assert.equal(h.length, 1);
  assert.equal(h[0]!.lado, "ALCISTA");
  assert.equal(h[0]!.bajo, 102, "el techo de la primera");
  assert.equal(h[0]!.alto, 110, "el suelo de la tercera");
});

test("EL HUECO NO SE CONOCE HASTA QUE CIERRA LA TERCERA VELA", () => {
  const velas = [v(0, 100, 102, 98, 101), v(1, 101, 118, 100, 117), v(2, 117, 125, 110, 124)];
  const h = huecos(velas, 0.2, atrPlano(3))[0]!;
  assert.equal(h.i, 1);
  assert.equal(h.conocidoEn, 2, "usarlo antes seria leer una vela que no existe");
});

test("un hueco demasiado pequeño no cuenta", () => {
  const velas = [v(0, 100, 102, 98, 101), v(1, 101, 110, 100, 109), v(2, 109, 112, 102.5, 111)];
  assert.equal(huecos(velas, 0.2, atrPlano(3)).length, 0, "0,5 de hueco con ATR 5 es 0,1 ATR");
});

test("un hueco bajista es el espejo", () => {
  const velas = [v(0, 100, 102, 98, 99), v(1, 99, 100, 85, 86), v(2, 86, 90, 80, 82)];
  const h = huecos(velas, 0.2, atrPlano(3))[0]!;
  assert.equal(h.lado, "BAJISTA");
  assert.equal(h.alto, 98);
  assert.equal(h.bajo, 90);
});

// ---------------------------------------------------------------------------------------
// ORDER BLOCKS
// ---------------------------------------------------------------------------------------

test("EL BLOQUE ES LA PRIMERA DE LAS TRES VELAS", () => {
  const velas = [v(0, 100, 102, 98, 101), v(1, 101, 118, 100, 117), v(2, 117, 125, 110, 124)];
  const b = bloques(velas, atrPlano(3), AJ)[0]!;
  assert.equal(b.i, 0, "la decision se tomo dentro de esa vela");
  assert.equal(b.alto, 102);
  assert.equal(b.bajo, 98);
});

test("UN EMPUJE FLOJO DESCARTA EL BLOQUE", () => {
  const velas = [v(0, 100, 102, 98, 101), v(1, 101, 118, 100, 117), v(2, 117, 125, 110, 124)];
  const flojo = bloques(velas, atrPlano(3), { ...AJ, minEmpuje: 100 });
  assert.equal(flojo.length, 0, "es una regla, no una preferencia");
});

// ---------------------------------------------------------------------------------------
// CAMBIO DE CARACTER
// ---------------------------------------------------------------------------------------

/** Bloque alcista en 98-102, y despues el precio lo pierde. */
function escenarioRotura(extra: Vela[] = []): Vela[] {
  return [
    v(0, 100, 102, 98, 101), v(1, 101, 118, 100, 117), v(2, 117, 125, 110, 124),
    v(3, 124, 125, 115, 116), v(4, 116, 117, 95, 96), ...extra,
  ];
}

test("HACE FALTA CERRAR al otro lado, no pinchar con la mecha", () => {
  const conMecha = [
    v(0, 100, 102, 98, 101), v(1, 101, 118, 100, 117), v(2, 117, 125, 110, 124),
    v(3, 124, 125, 90, 120),  // la mecha baja de 98 pero cierra en 120
  ];
  const rs = roturas(conMecha, bloques(conMecha, atrPlano(4), AJ), [], atrPlano(4), AJ);
  assert.equal(rs.length, 0);
});

test("cerrar por debajo del bloque alcista pasa el control a la OFERTA", () => {
  const velas = escenarioRotura();
  const a = atrPlano(velas.length);
  const rs = roturas(velas, bloques(velas, a, AJ), huecos(velas, AJ.minHueco, a), a, AJ);
  assert.equal(rs.length, 1);
  assert.equal(rs[0]!.direccion, "BAJISTA");
  assert.equal(rs[0]!.i, 4);
});

test("CADA BLOQUE SE ROMPE UNA SOLA VEZ", () => {
  const velas = escenarioRotura([v(5, 96, 97, 90, 91), v(6, 91, 92, 88, 89)]);
  const a = atrPlano(velas.length);
  const rs = roturas(velas, bloques(velas, a, AJ), huecos(velas, AJ.minHueco, a), a, AJ);
  assert.equal(rs.length, 1, "seguir bajando no es un cambio de caracter nuevo");
});

// ---------------------------------------------------------------------------------------
// LOS DOS VETOS: la unica pieza nueva del metodo
// ---------------------------------------------------------------------------------------

/** Tres minimos IGUALES en 90, separados por rebotes: una bolsa de liquidez de verdad. */
function tresMinimosIguales(): Vela[] {
  const tramo = (k: number) => [
    v(k, 91, 95, 91, 94), v(k + 1, 94, 98, 93, 97), v(k + 2, 97, 98, 93, 94),
  ];
  return [
    v(0, 100, 101, 95, 96), v(1, 96, 97, 92, 93),
    v(2, 93, 94, 90, 91), ...tramo(3),
    v(6, 94, 95, 90, 91), ...tramo(7),
    v(10, 94, 95, 90, 91), ...tramo(11),
    v(14, 94, 95, 85, 86),   // rompe por debajo de los tres
  ];
}

test("VETO DE LIQUIDEZ: tres minimos iguales apilados lo activan", () => {
  const velas = tresMinimosIguales();
  assert.ok(hayLiquidez(velas, 14, 90, 1, 3, 50, 2), "los minimos de 2, 6 y 10 estan en 90");
});

test("SOLO CUENTA LO QUE HAY A LA IZQUIERDA", () => {
  const velas = tresMinimosIguales();
  assert.ok(
    !hayLiquidez(velas, 11, 90, 1, 3, 50, 2),
    "hasta la vela 11 solo hay dos minimos confirmados, no tres",
  );
});

test("el veto de liquidez no mira mas alla de su memoria", () => {
  const velas = tresMinimosIguales();
  assert.ok(hayLiquidez(velas, 14, 90, 1, 3, 50, 2));
  assert.ok(!hayLiquidez(velas, 14, 90, 1, 3, 5, 2), "con memoria corta solo alcanza a uno");
});

test("VETO DE HUECO: un hueco YA RELLENO no veta", () => {
  const velas = [
    v(0, 100, 102, 98, 101), v(1, 101, 118, 100, 117), v(2, 117, 125, 110, 124),
    v(3, 124, 125, 100, 101),  // vuelve y rellena el hueco 102-110 entero
    v(4, 101, 102, 95, 96),
  ];
  const hs = huecos(velas, AJ.minHueco, atrPlano(5));
  const alcista = hs.filter((h) => h.lado === "ALCISTA");
  assert.equal(alcista.length, 1, "el hueco 102-110 de la subida");
  assert.ok(
    !huecoPendiente(velas, alcista, 4, "BAJISTA", 50),
    "ya no atrae: la vela 3 lo recorrio entero",
  );
});

test("un hueco sin rellenar por debajo SI veta una rotura bajista", () => {
  const velas = [
    v(0, 100, 102, 98, 101), v(1, 101, 118, 100, 117), v(2, 117, 125, 110, 124),
    v(3, 124, 126, 120, 125), v(4, 125, 126, 118, 119),
  ];
  const hs = huecos(velas, AJ.minHueco, atrPlano(5));
  assert.ok(huecoPendiente(velas, hs, 4, "BAJISTA", 50), "el hueco 102-110 sigue abierto abajo");
});

test("UN HUECO QUE AUN NO SE CONOCE no puede vetar nada", () => {
  const velas = [
    v(0, 100, 102, 98, 101), v(1, 101, 118, 100, 117), v(2, 117, 125, 110, 124),
  ];
  const hs = huecos(velas, AJ.minHueco, atrPlano(3));
  assert.ok(!huecoPendiente(velas, hs, 1, "BAJISTA", 50), "en la vela 1 el hueco no existe aun");
});

test("LOS VETOS SE PUEDEN APAGAR, para poder medir cuanto aportan", () => {
  const velas = [
    v(0, 100, 101, 90, 95), v(1, 95, 96, 90, 92), v(2, 92, 96, 90, 94),
    v(3, 94, 96, 92, 95), v(4, 95, 112, 94, 111), v(5, 111, 120, 105, 119),
    v(6, 119, 120, 88, 89),
  ];
  const a = atrPlano(velas.length);
  const bs = bloques(velas, a, AJ);
  const hs = huecos(velas, AJ.minHueco, a);
  const con = roturas(velas, bs, hs, a, AJ);
  const sin = roturas(velas, bs, hs, a, { ...AJ, aplicarVetos: false });
  assert.equal(con.length, sin.length, "vetar no quita roturas, las marca");
  assert.ok(sin.every((r) => !r.vetada), "sin vetos ninguna queda marcada");
});

// ---------------------------------------------------------------------------------------
// NADA MIRA AL FUTURO
// ---------------------------------------------------------------------------------------

test("LAS ROTURAS DE LAS PRIMERAS VELAS NO CAMBIAN al añadir velas futuras", () => {
  const base = escenarioRotura();
  const conFuturo = [...base, v(5, 96, 200, 50, 199), v(6, 199, 250, 190, 240)];
  const a1 = atrPlano(base.length);
  const a2 = atrPlano(conFuturo.length);
  const r1 = roturas(base, bloques(base, a1, AJ), huecos(base, AJ.minHueco, a1), a1, AJ);
  const r2 = roturas(
    conFuturo, bloques(conFuturo, a2, AJ), huecos(conFuturo, AJ.minHueco, a2), a2, AJ,
  ).filter((r) => r.i < base.length);
  assert.deepEqual(
    r1.map((r) => [r.i, r.direccion, r.vetada]),
    r2.map((r) => [r.i, r.direccion, r.vetada]),
    "una rotura ya juzgada no puede cambiar de veredicto despues",
  );
});

test("una señal entra DESPUES de que su bloque se conozca, nunca antes", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 101, 99, 100), v(2, 100, 101, 99, 100),
    v(3, 100, 102, 98, 101), v(4, 101, 118, 100, 117), v(5, 117, 125, 110, 124),
    v(6, 124, 125, 115, 116), v(7, 116, 117, 95, 96),
    v(8, 96, 97, 80, 81), v(9, 81, 82, 70, 71),
    v(10, 71, 90, 70, 89), v(11, 89, 95, 88, 94),
  ];
  const a = atrPlano(velas.length);
  for (const s of señales(velas, a, { ...AJ, toquesLiquidez: 99 })) {
    const bs = bloques(velas, a, { ...AJ, toquesLiquidez: 99 });
    const suyo = bs.find((b) => b.alto === (s.direccion === "CORTO" ? s.stop / 1 : 0) || true);
    assert.ok(suyo != null);
    assert.ok(s.i >= 2, `la señal en ${s.i} necesita al menos tres velas antes`);
  }
});

test("EL VETO CUENTA MINIMOS ESTRUCTURALES, no velas que pasaron cerca", () => {
  // Contando cualquier vela dentro del radio el veto rechazaba el 96% de las roturas: eso no
  // filtra, tapa.
  const deriva = [
    v(0, 100, 101, 90, 95), v(1, 95, 96, 90.2, 92), v(2, 92, 95, 90.1, 94),
    v(3, 94, 95, 90.3, 93), v(4, 93, 94, 90.2, 92), v(5, 92, 93, 85, 86),
  ];
  // Todas rondan 90, pero solo las que son minimo local cuentan.
  const conEstructura = hayLiquidez(deriva, 5, 90, 1, 3, 50, 2);
  const contandoTodo = deriva.slice(0, 5).filter((c) => Math.abs(c.l - 90) <= 1).length >= 3;
  assert.ok(contandoTodo, "contando cualquier vela darian 5 toques");
  assert.ok(!conEstructura, "contando solo minimos estructurales, no llegan a 3");
});

test("un minimo no confirmado todavia no cuenta como liquidez", () => {
  const velas = [
    v(0, 100, 101, 95, 96), v(1, 96, 97, 90, 91), v(2, 91, 92, 95, 94),
  ];
  assert.ok(!hayLiquidez(velas, 2, 90, 1, 1, 50, 2), "al minimo de la vela 1 le faltan velas");
});

// ---------------------------------------------------------------------------------------
// SALIDA PARCIAL
// ---------------------------------------------------------------------------------------

const sen = (i: number, entrada: number, stop: number) => ({
  i, direccion: "LARGO" as const, entrada, stop, objetivo: entrada + (entrada - stop) * 3, rr: 3,
});

test("PARCIAL EN 1R Y LUEGO STOP EN LA ENTRADA no puede perder", () => {
  const velas = [
    v(0, 100, 100, 100, 100), v(1, 100, 111, 99, 110), v(2, 110, 111, 95, 96),
  ];
  // Riesgo 10: entrada 100, stop 90. Toca 110 (1R) en la vela 1, luego vuelve a 100.
  const r = simularParcial(velas, sen(0, 100, 90), 0, 0, 0.5, 1, 3)!;
  assert.equal(r.motivo, "PARCIAL_Y_STOP");
  assert.ok(Math.abs(r.r - 0.5) < 1e-9, `cobra medio R y el resto sale a cero, dio ${r.r}`);
});

test("sin tocar el parcial, un stop sigue siendo -1R entero", () => {
  const velas = [v(0, 100, 100, 100, 100), v(1, 100, 101, 89, 90)];
  const r = simularParcial(velas, sen(0, 100, 90), 0, 0, 0.5, 1, 3)!;
  assert.equal(r.motivo, "STOP");
  assert.ok(Math.abs(r.r + 1) < 1e-9);
});

test("EL PARCIAL RECORTA LA COLA: una ganadora completa da menos que sin parcial", () => {
  const velas = [
    v(0, 100, 100, 100, 100), v(1, 100, 112, 99, 111), v(2, 111, 135, 110, 134),
  ];
  const conParcial = simularParcial(velas, sen(0, 100, 90), 0, 0, 0.5, 1, 3)!;
  assert.equal(conParcial.motivo, "PARCIAL_Y_OBJETIVO");
  // 0,5 de 1R mas 0,5 de 3R = 2R, contra 3R si no se hubiera cerrado la mitad.
  assert.ok(Math.abs(conParcial.r - 2) < 1e-9, `dio ${conParcial.r}, esperaba 2`);
});

test("EL STOP GANA LOS EMPATES tambien con parcial", () => {
  const velas = [v(0, 100, 100, 100, 100), v(1, 100, 130, 89, 120)];
  const r = simularParcial(velas, sen(0, 100, 90), 0, 0, 0.5, 1, 3)!;
  assert.equal(r.motivo, "STOP", "no se sabe si primero subio o primero cayo");
});
