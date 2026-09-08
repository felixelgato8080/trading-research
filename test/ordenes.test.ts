import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidir, exposicion,
  type Estado, type Posicion, type SeñalEntrada, type Mercado, type Ajustes,
} from "../src/forex/ordenes";

const AJ: Ajustes = {
  capital: 10_000,
  riesgoPct: 0.01,
  maxPosiciones: 8,
  trailing: 2,
  maxExposicion: 1,
  maxPerdidaDiaria: 0.05,
  parado: false,
};

const vacio = (): Estado => ({ posiciones: [], resultadoDia: 0 });

const pos = (simbolo: string, over: Partial<Posicion> = {}): Posicion => ({
  simbolo, direccion: "LARGO", entrada: 100, unidades: 10,
  riesgo: 10, nivelStop: 90, extremo: 100, ...over,
});

const señal = (simbolo: string, over: Partial<SeñalEntrada> = {}): SeñalEntrada => ({
  simbolo, direccion: "LARGO", riesgo: 10, precio: 100, fuerza: 2.5, ...over,
});

const mercado = (simbolo: string, ultimo: number, maximo: number, minimo: number): Mercado =>
  ({ simbolo, ultimo, maximo, minimo });

// ---------------------------------------------------------------------------------------
// APERTURA Y TAMAÑO
// ---------------------------------------------------------------------------------------

test("EL TAMAÑO SALE DEL RIESGO, no de un porcentaje del capital", () => {
  // 1% de 10.000 = 100 de riesgo. Con el stop a 10 de distancia son 10 unidades.
  const d = decidir(vacio(), [señal("BTC")], new Map(), AJ);
  const abrir = d.ordenes.find((o) => o.tipo === "ABRIR");
  assert.ok(abrir && abrir.tipo === "ABRIR");
  assert.equal(abrir.unidades, 10);
  assert.equal(abrir.nivelStop, 90);
});

test("un stop mas estrecho da una posicion MAS GRANDE, no mas pequeña", () => {
  const d = decidir(vacio(), [señal("BTC", { riesgo: 5 })], new Map(), AJ);
  const abrir = d.ordenes.find((o) => o.tipo === "ABRIR");
  assert.ok(abrir && abrir.tipo === "ABRIR");
  assert.equal(abrir.unidades, 20, "mismo riesgo en dinero, mitad de distancia, doble tamaño");
});

test("en corto el stop va POR ENCIMA de la entrada", () => {
  const d = decidir(vacio(), [señal("BTC", { direccion: "CORTO" })], new Map(), AJ);
  const abrir = d.ordenes.find((o) => o.tipo === "ABRIR");
  assert.ok(abrir && abrir.tipo === "ABRIR");
  assert.equal(abrir.nivelStop, 110);
});

// ---------------------------------------------------------------------------------------
// LAS BARRERAS
// ---------------------------------------------------------------------------------------

test("EL TOPE DE POSICIONES corta, y dice por que", () => {
  const estado: Estado = {
    posiciones: Array.from({ length: 8 }, (_, i) => pos(`M${i}`)),
    resultadoDia: 0,
  };
  const d = decidir(estado, [señal("NUEVA")], new Map(), AJ);
  assert.equal(d.ordenes.filter((o) => o.tipo === "ABRIR").length, 0);
  assert.equal(d.descartadas[0]!.motivo, "tope de posiciones");
});

test("EL TOPE DE EXPOSICION impide apalancarse sin darse cuenta", () => {
  // Stop del 1% del precio: 100 de riesgo exigen 10.000 de nocional, justo 1x. Dos no caben.
  const s = señal("BTC", { riesgo: 1, precio: 100 });
  const d = decidir(vacio(), [s, señal("ETH", { riesgo: 1, precio: 100, fuerza: 2 })], new Map(), AJ);
  assert.equal(d.ordenes.filter((o) => o.tipo === "ABRIR").length, 1);
  assert.equal(d.descartadas[0]!.motivo, "no cabe en la exposicion permitida");
});

test("EL FRENO POR PERDIDA DIARIA bloquea aperturas", () => {
  const estado: Estado = { posiciones: [], resultadoDia: -0.05 };
  const d = decidir(estado, [señal("BTC")], new Map(), AJ);
  assert.equal(d.ordenes.length, 0);
  assert.equal(d.descartadas[0]!.motivo, "tope de perdida diaria alcanzado");
});

test("PERO EL FRENO NO IMPIDE CERRAR: seria dejar el riesgo suelto", () => {
  const estado: Estado = { posiciones: [pos("BTC")], resultadoDia: -0.20 };
  const m = new Map([["BTC", mercado("BTC", 85, 101, 85)]]);
  const d = decidir(estado, [], m, AJ);
  const cierre = d.ordenes.find((o) => o.tipo === "CERRAR");
  assert.ok(cierre, "con el bot frenado las salidas siguen ejecutandose");
});

test("EL INTERRUPTOR MANUAL para las aperturas y deja gestionar lo abierto", () => {
  const estado: Estado = { posiciones: [pos("BTC")], resultadoDia: 0 };
  const m = new Map([["BTC", mercado("BTC", 150, 150, 120)]]);
  const d = decidir(estado, [señal("ETH")], m, { ...AJ, parado: true });
  assert.equal(d.ordenes.filter((o) => o.tipo === "ABRIR").length, 0);
  assert.equal(d.descartadas[0]!.motivo, "bot parado");
  assert.ok(d.ordenes.some((o) => o.tipo === "MOVER_STOP"), "el trailing sigue funcionando");
});

test("NO SE DOBLA la apuesta en el mismo simbolo", () => {
  const estado: Estado = { posiciones: [pos("BTC")], resultadoDia: 0 };
  const d = decidir(estado, [señal("BTC")], new Map(), AJ);
  assert.equal(d.ordenes.filter((o) => o.tipo === "ABRIR").length, 0);
  assert.equal(d.descartadas[0]!.motivo, "ya hay posicion abierta");
});

test("una señal con riesgo cero se descarta en vez de reventar", () => {
  const d = decidir(vacio(), [señal("BTC", { riesgo: 0 })], new Map(), AJ);
  assert.equal(d.ordenes.length, 0);
  assert.equal(d.descartadas[0]!.motivo, "riesgo o precio invalidos");
});

// ---------------------------------------------------------------------------------------
// CIERRE Y TRAILING
// ---------------------------------------------------------------------------------------

test("SE CIERRA cuando el minimo toca el stop", () => {
  const estado: Estado = { posiciones: [pos("BTC")], resultadoDia: 0 };
  const m = new Map([["BTC", mercado("BTC", 95, 101, 89)]]);
  const d = decidir(estado, [], m, AJ);
  assert.equal(d.ordenes[0]!.tipo, "CERRAR");
  assert.equal(d.estadoFinal.posiciones.length, 0);
});

test("EL TRAILING SUBE el stop pero NUNCA lo baja", () => {
  const estado: Estado = { posiciones: [pos("BTC")], resultadoDia: 0 };
  const sube = decidir(estado, [], new Map([["BTC", mercado("BTC", 140, 140, 99)]]), AJ);
  const movida = sube.ordenes.find((o) => o.tipo === "MOVER_STOP");
  assert.ok(movida && movida.tipo === "MOVER_STOP");
  assert.equal(movida.nuevoNivel, 120, "extremo 140 menos 2 x 10 de riesgo");

  // Ahora una vela contraria: el stop tiene que quedarse donde estaba.
  const despues = decidir(sube.estadoFinal, [], new Map([["BTC", mercado("BTC", 125, 130, 121)]]), AJ);
  assert.equal(
    despues.ordenes.filter((o) => o.tipo === "MOVER_STOP").length, 0,
    "el stop no puede aflojarse",
  );
});

test("en corto el trailing BAJA el stop, nunca lo sube", () => {
  const estado: Estado = {
    posiciones: [pos("BTC", { direccion: "CORTO", nivelStop: 110 })],
    resultadoDia: 0,
  };
  const d = decidir(estado, [], new Map([["BTC", mercado("BTC", 60, 101, 60)]]), AJ);
  const movida = d.ordenes.find((o) => o.tipo === "MOVER_STOP");
  assert.ok(movida && movida.tipo === "MOVER_STOP");
  assert.equal(movida.nuevoNivel, 80);
});

test("SIN DATOS DE MERCADO no se toca la posicion", () => {
  const estado: Estado = { posiciones: [pos("BTC")], resultadoDia: 0 };
  const d = decidir(estado, [], new Map(), AJ);
  assert.equal(d.ordenes.length, 0, "sin saber si el stop salto, no se decide a ciegas");
  assert.equal(d.estadoFinal.posiciones.length, 1);
});

// ---------------------------------------------------------------------------------------
// ORDEN DE LAS OPERACIONES Y PRIORIDAD
// ---------------------------------------------------------------------------------------

test("PRIMERO SE CIERRA Y LUEGO SE ABRE: si no, el tope se calcula sobre un estado falso", () => {
  const estado: Estado = {
    posiciones: Array.from({ length: 8 }, (_, i) => pos(`M${i}`)),
    resultadoDia: 0,
  };
  // Una de las ocho toca su stop, asi que queda un hueco para la nueva.
  const m = new Map([["M0", mercado("M0", 85, 101, 85)]]);
  const d = decidir(estado, [señal("NUEVA")], m, AJ);
  assert.equal(d.ordenes[0]!.tipo, "CERRAR");
  assert.ok(d.ordenes.some((o) => o.tipo === "ABRIR"), "el hueco liberado se aprovecha");
});

test("CON MAS SEÑALES QUE HUECOS entran las de RUPTURA MAS FUERTE", () => {
  const estado: Estado = {
    posiciones: Array.from({ length: 7 }, (_, i) => pos(`M${i}`, { entrada: 1, unidades: 1 })),
    resultadoDia: 0,
  };
  const d = decidir(
    estado,
    [señal("floja", { fuerza: 2.1 }), señal("fuerte", { fuerza: 4.8 })],
    new Map(),
    AJ,
  );
  const abrir = d.ordenes.filter((o) => o.tipo === "ABRIR");
  assert.equal(abrir.length, 1);
  assert.equal(abrir[0]!.simbolo, "fuerte", "la prioridad es una regla, no el orden de llegada");
});

test("la exposicion se calcula sobre el nocional, no sobre el riesgo", () => {
  const p = [pos("BTC", { entrada: 100, unidades: 50 })];
  assert.equal(exposicion(p, 10_000), 0.5);
  assert.equal(exposicion([], 10_000), 0);
  assert.equal(exposicion(p, 0), 0, "sin capital no se divide por cero");
});

test("sin señales ni posiciones no se emite nada", () => {
  const d = decidir(vacio(), [], new Map(), AJ);
  assert.equal(d.ordenes.length, 0);
  assert.equal(d.descartadas.length, 0);
});
