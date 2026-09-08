import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastar, veredicto, type Predicha } from "../src/forex/contraste";
import type { Cerrada } from "../src/forex/grabador";

const H = 3600;
const DESDE = 0;
const HASTA = 100 * H;

const cerrada = (par: string, t: number, r: number, extra: Partial<Cerrada> = {}): Cerrada => ({
  par, direccion: "LARGO", entrada: 100, stop: 95, objetivo: 110, rr: 2,
  apuntada: "d", tSeñal: t * H, caducaEn: (t + 60) * H,
  abierta: "d", tEntrada: (t + 1) * H,
  cerrada: "d", salida: 110, r, motivo: r > 0 ? "OBJETIVO" : "STOP",
  ...extra,
});

const predicha = (par: string, t: number, r: number, extra: Partial<Predicha> = {}): Predicha => ({
  par, tSeñal: t * H, entrada: 100, stop: 95, objetivo: 110, r, ...extra,
});

// ---------------------------------------------------------------------------------------
// EL CASO BUENO
// ---------------------------------------------------------------------------------------

test("si todo coincide, no hay discrepancias", () => {
  const c = contrastar(
    [cerrada("A", 10, 2), cerrada("B", 20, -1)],
    [predicha("A", 10, 2), predicha("B", 20, -1)],
    DESDE, HASTA,
  );
  assert.equal(c.emparejadas, 2);
  assert.equal(c.resultadosDistintos.length, 0);
  assert.equal(c.preciosDistintos.length, 0);
  assert.equal(c.soloEnRegistro.length, 0);
  assert.equal(c.diferencia, 0);
  assert.ok(veredicto(c).includes("Sin discrepancias graves"));
});

// ---------------------------------------------------------------------------------------
// LAS TRES DISCREPANCIAS, cada una con su significado
// ---------------------------------------------------------------------------------------

test("MISMOS PRECIOS Y DISTINTO RESULTADO: el simulador esta mal", () => {
  const c = contrastar([cerrada("A", 10, -1)], [predicha("A", 10, 2)], DESDE, HASTA);
  assert.equal(c.resultadosDistintos.length, 1);
  assert.equal(c.emparejadas, 1, "se empareja igual: los precios coinciden");
  assert.ok(veredicto(c).includes("El simulador esta mal"));
});

test("MISMA SEÑAL Y OTROS PRECIOS: algo mira al futuro", () => {
  const c = contrastar(
    [cerrada("A", 10, 2)],
    [predicha("A", 10, 2, { stop: 90 })],
    DESDE, HASTA,
  );
  assert.equal(c.preciosDistintos.length, 1);
  assert.equal(c.emparejadas, 0, "con otros precios no es la misma operacion, no se empareja");
  assert.ok(veredicto(c).includes("algo mira al futuro"));
});

test("UNA SEÑAL GRABADA QUE EL BACKTEST YA NO PRODUCE: los datos han cambiado", () => {
  const c = contrastar([cerrada("A", 10, 2)], [], DESDE, HASTA);
  assert.equal(c.soloEnRegistro.length, 1);
  assert.ok(veredicto(c).includes("reviso velas viejas"));
});

test("que el backtest vea señales que el grabador no vio es NORMAL", () => {
  // El grabador estuvo apagado ratos y su primera pasada por instrumento no apunta nada.
  const c = contrastar([], [predicha("A", 10, 2)], DESDE, HASTA);
  assert.equal(c.soloEnBacktest.length, 1);
  const v = veredicto(c);
  assert.ok(v.includes("NORMAL"));
  assert.ok(v.includes("Sin discrepancias graves"), "esto solo no invalida el backtest");
});

// ---------------------------------------------------------------------------------------
// LA VENTANA
// ---------------------------------------------------------------------------------------

test("LO DE FUERA DE LA VENTANA NO CUENTA como fallo del grabador", () => {
  // El grabador solo vio lo que paso mientras estuvo encendido. Reprocharle señales de antes de
  // arrancar seria inventarse un problema.
  const c = contrastar(
    [cerrada("A", 50, 2)],
    [predicha("A", 50, 2), predicha("A", 5, 1), predicha("A", 95, 1)],
    40 * H, 60 * H,
  );
  assert.equal(c.emparejadas, 1);
  assert.equal(c.soloEnBacktest.length, 0, "las de fuera de la ventana ni se miran");
});

// ---------------------------------------------------------------------------------------
// LOS PROMEDIOS NO BASTAN
// ---------------------------------------------------------------------------------------

test("DOS SERIES CON LA MISMA ESPERANZA Y TODAS LAS OPERACIONES DISTINTAS", () => {
  // Es la razon de comparar operacion a operacion. Aqui los promedios coinciden exactamente y
  // el simulador esta roto en las dos.
  const c = contrastar(
    [cerrada("A", 10, 2), cerrada("A", 20, -1)],
    [predicha("A", 10, -1), predicha("A", 20, 2)],
    DESDE, HASTA,
  );
  assert.equal(c.esperanzaRegistro, c.esperanzaBacktest, "el promedio coincide");
  assert.equal(c.diferencia, 0, "y la diferencia media tambien");
  assert.equal(c.resultadosDistintos.length, 2, "pero LAS DOS operaciones discrepan");
  assert.ok(veredicto(c).includes("GRAVE"));
});

test("el error de la diferencia se calcula sobre las emparejadas", () => {
  const c = contrastar(
    [cerrada("A", 10, 2), cerrada("A", 20, 2), cerrada("A", 30, 2)],
    [predicha("A", 10, 1), predicha("A", 20, 2), predicha("A", 30, 3)],
    DESDE, HASTA,
  );
  assert.equal(c.emparejadas, 3);
  assert.equal(c.diferencia, 0, "+1, 0 y -1 se cancelan");
  assert.ok(c.errorDiferencia > 0, "pero la dispersion no es cero, y hay que verlo");
});

// ---------------------------------------------------------------------------------------
// BORDES
// ---------------------------------------------------------------------------------------

test("un registro vacio no divide entre cero", () => {
  const c = contrastar([], [], DESDE, HASTA);
  assert.equal(c.emparejadas, 0);
  assert.equal(c.esperanzaRegistro, 0);
  assert.equal(c.errorDiferencia, 0);
});

test("dos instrumentos con señales en el mismo instante no se confunden", () => {
  const c = contrastar(
    [cerrada("A", 10, 2), cerrada("B", 10, -1)],
    [predicha("A", 10, 2), predicha("B", 10, -1)],
    DESDE, HASTA,
  );
  assert.equal(c.emparejadas, 2);
  assert.equal(c.resultadosDistintos.length, 0);
});

test("una diferencia minuscula de redondeo no cuenta como discrepancia", () => {
  const c = contrastar(
    [cerrada("A", 10, 2)],
    [predicha("A", 10, 2.00000001, { entrada: 100.0000000001 })],
    DESDE, HASTA,
  );
  assert.equal(c.preciosDistintos.length, 0);
  assert.equal(c.resultadosDistintos.length, 0);
});

// ---------------------------------------------------------------------------------------
// SE COMPARA COMO SE MIDIO
// ---------------------------------------------------------------------------------------
//
// El grabador no siempre guardo el precio al que se llenaba de verdad: medía la R contra el
// PEDIDO. El backtest la mide contra el conseguido, y en una entrada con hueco eso basta para
// que discrepen sin que nada este roto. Exigirle a una operacion vieja el numero de hoy seria
// acusarla de un fallo por haber sido grabada antes, y ese ruido taparia los fallos de verdad.

const vieja = (extra: Partial<Cerrada> = {}): Cerrada => ({
  par: "X", direccion: "LARGO", entrada: 100, stop: 90, objetivo: 130, rr: 3,
  apuntada: "d0", tSeñal: 0, caducaEn: 9999, abierta: "d1", tEntrada: 3600,
  cerrada: "d2", salida: 90, r: -1.233, motivo: "STOP", ...extra,
});
const predichaVieja = (r: number, rPlaneado?: number): Predicha => ({
  par: "X", tSeñal: 0, entrada: 100, stop: 90, objetivo: 130, r, rPlaneado,
});

test("SIN llenado real guardado se compara contra la R MEDIDA IGUAL, y cuadra", () => {
  // El backtest da -1,006 midiendo contra el llenado y -1,233 midiendo contra el pedido, que es
  // como se grabo. Contra la suya cuadra, asi que no hay nada que denunciar.
  const c = contrastar([vieja()], [predichaVieja(-1.006, -1.233)], 0, 9999);
  assert.equal(c.resultadosDistintos.length, 0);
  assert.match(veredicto(c), /Sin discrepancias graves/);
});

test("SIN llenado real, pero si ni asi cuadra, SIGUE siendo grave", () => {
  const c = contrastar([vieja()], [predichaVieja(-1.006, 2.5)], 0, 9999);
  assert.equal(c.resultadosDistintos.length, 1, "la excusa no es haber sido grabada antes");
});

test("CON llenado real guardado se compara contra la R de hoy", () => {
  const c = contrastar([vieja({ entradaReal: 100 })], [predichaVieja(-1.006, -1.233)], 0, 9999);
  assert.equal(c.resultadosDistintos.length, 1, "aqui ya no hay excusa");
  assert.match(veredicto(c), /GRAVE/);
});

test("si el backtest no da la cifra planeada, se usa la que tenga", () => {
  // Un backtest viejo que no la calcule no puede tumbar la comparacion entera.
  const c = contrastar([vieja({ r: -1.006 })], [predichaVieja(-1.006)], 0, 9999);
  assert.equal(c.resultadosDistintos.length, 0);
});
