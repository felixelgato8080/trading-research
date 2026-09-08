import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import {
  registroVacio,
  avanzar,
  resumir,
  atrWilder,
  dia,
  type AjustesGrabador,
  type Registro,
} from "../src/forex/grabadorCripto";

const DIA = 86400;
const AJ: AjustesGrabador = { k: 2, atrStop: 2, trailing: 2, periodoAtr: 3, costeR: 0.05 };

/** Vela por dia, empezando el 2026-01-01 (t=1767225600). */
const T0 = Date.parse("2026-01-01T00:00:00Z") / 1000;
function v(n: number, o: number, h: number, l: number, c: number, vol?: number): Vela {
  return { t: T0 + n * DIA, o, h, l, c, ...(vol === undefined ? {} : { v: vol }) };
}
const INICIO = "2026-01-01T00:00:00.000Z";

/** Base plana para que el ATR salga estable y predecible. */
function base(n: number): Vela[] {
  return Array.from({ length: n }, (_, i) => v(i, 100, 101, 99, 100));
}

function nuevoRegistro(): Registro {
  return registroVacio(AJ, INICIO);
}

test("el ATR de Wilder no existe antes de tener el periodo completo", () => {
  const a = atrWilder(base(6), 3);
  assert.equal(a[0], null);
  assert.equal(a[2], null);
  assert.ok(a[3] != null);
});

test("sin movimiento no hay señales", () => {
  const r = avanzar(nuevoRegistro(), new Map([["A", base(10)]]), INICIO);
  assert.equal(r.nuevasPendientes.length, 0);
  assert.equal(r.registro.abiertas.length, 0);
});

test("LA SEÑAL SE APUNTA COMO PENDIENTE cuando la entrada aun no existe", () => {
  // Dia 6 rompe al alza; no hay vela del dia 7, asi que la apertura de entrada se desconoce.
  const velas = [...base(6), v(6, 100, 112, 100, 110)];
  const r = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  assert.equal(r.nuevasPendientes.length, 1, "deberia haber una pendiente");
  assert.equal(r.registro.abiertas.length, 0, "no puede abrirse sin conocer la apertura");
  assert.equal(r.nuevasPendientes[0]!.direccion, "LARGO");
  assert.equal(r.nuevasPendientes[0]!.apuntadoEn, INICIO);
});

test("la pendiente se convierte en posicion CON LA APERTURA DEL DIA SIGUIENTE", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110)];
  const paso1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);

  const conSiguiente = [...velas, v(7, 111, 113, 110, 112)];
  const paso2 = avanzar(paso1.registro, new Map([["A", conSiguiente]]), "2026-01-08T00:00:00.000Z");

  assert.equal(paso2.registro.pendientes.length, 0);
  assert.equal(paso2.registro.abiertas.length, 1);
  const p = paso2.registro.abiertas[0]!;
  assert.equal(p.precioEntrada, 111, "entra en la apertura del dia siguiente, no en el cierre");
  assert.equal(p.diaEntrada, dia(conSiguiente[7]!.t));
});

test("EL STOP INICIAL ESTA A atrStop x ATR de la entrada", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const r = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  const p = r.registro.abiertas[0]!;
  assert.ok(Math.abs(p.nivelStop - (111 - p.riesgo)) < 1e-9);
  assert.ok(p.riesgo > 0);
});

test("una perdedora cierra en el stop y da aproximadamente -1R menos el coste", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  const p = r1.registro.abiertas[0]!;

  const desplome = [...velas, v(8, 111, 111, p.nivelStop - 5, p.nivelStop - 5)];
  const r2 = avanzar(r1.registro, new Map([["A", desplome]]), "2026-01-09T00:00:00.000Z");

  assert.equal(r2.nuevasCerradas.length, 1);
  const c = r2.nuevasCerradas[0]!;
  assert.equal(c.motivo, "STOP");
  assert.ok(Math.abs(c.rBruto + 1) < 1e-9, `rBruto fue ${c.rBruto}`);
  assert.ok(Math.abs(c.r + 1.05) < 1e-9, "el coste se resta al cerrar");
});

test("EL TRAILING SUBE EL STOP y no lo baja nunca", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  const stopInicial = r1.registro.abiertas[0]!.nivelStop;

  const sube = [...velas, v(8, 112, 200, 112, 199)];
  const r2 = avanzar(r1.registro, new Map([["A", sube]]), "2026-01-09T00:00:00.000Z");
  const subido = r2.registro.abiertas[0]!.nivelStop;
  assert.ok(subido > stopInicial, "el trailing deberia haber subido el stop");

  const lateral = [...sube, v(9, 199, 199, 198, 198)];
  const r3 = avanzar(r2.registro, new Map([["A", lateral]]), "2026-01-10T00:00:00.000Z");
  assert.equal(r3.registro.abiertas[0]!.nivelStop, subido, "el stop no puede bajar");
});

test("una ganadora sale por TRAILING, no por STOP", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  const sube = [...velas, v(8, 112, 200, 112, 199)];
  const r2 = avanzar(r1.registro, new Map([["A", sube]]), "2026-01-09T00:00:00.000Z");
  const nivel = r2.registro.abiertas[0]!.nivelStop;
  const cae = [...sube, v(9, 199, 199, nivel - 1, nivel - 1)];
  const r3 = avanzar(r2.registro, new Map([["A", cae]]), "2026-01-10T00:00:00.000Z");

  assert.equal(r3.nuevasCerradas.length, 1);
  assert.equal(r3.nuevasCerradas[0]!.motivo, "TRAILING");
  assert.ok(r3.nuevasCerradas[0]!.r > 0, "deberia cerrar en ganancia");
});

test("ES IDEMPOTENTE: correrlo dos veces con los mismos datos no duplica nada", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  const r2 = avanzar(r1.registro, new Map([["A", velas]]), "2026-01-08T12:00:00.000Z");

  assert.equal(r2.registro.abiertas.length, 1);
  assert.equal(r2.registro.pendientes.length, 0);
  assert.equal(r2.nuevasCerradas.length, 0);
  assert.deepEqual(r2.registro.abiertas[0]!.nivelStop, r1.registro.abiertas[0]!.nivelStop);
  assert.equal(r2.registro.ejecuciones, 2, "si cuenta las ejecuciones");
});

test("NO SE APILAN DOS POSICIONES en la misma moneda", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  assert.equal(r1.registro.abiertas.length, 1);

  // Otra ruptura estando ya dentro.
  const otra = [...velas, v(8, 112, 150, 112, 148), v(9, 149, 150, 148, 149)];
  const r2 = avanzar(r1.registro, new Map([["A", otra]]), "2026-01-09T00:00:00.000Z");
  assert.ok(r2.registro.abiertas.length <= 1, "no puede haber dos posiciones en A");
});

test("NO SE INVENTA UNA SALIDA si faltan los datos de esa moneda", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  const r2 = avanzar(r1.registro, new Map(), "2026-01-09T00:00:00.000Z");

  assert.equal(r2.registro.abiertas.length, 1, "la posicion sigue viva");
  assert.equal(r2.nuevasCerradas.length, 0);
});

test("NO SE GRABAN SEÑALES ANTERIORES AL ARRANQUE: eso seria backtest", () => {
  // Registro que arranca tarde, con velas que rompen mucho antes.
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const tarde = registroVacio(AJ, "2030-01-01T00:00:00.000Z");
  const r = avanzar(tarde, new Map([["A", velas]]), "2030-01-01T00:00:00.000Z");
  assert.equal(r.nuevasPendientes.length, 0);
  assert.equal(r.registro.abiertas.length, 0);
});

test("UN PRECIO YA GRABADO NO SE REESCRIBE, se anota la discrepancia", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  assert.equal(r1.registro.abiertas[0]!.precioEntrada, 111);

  // Yahoo "revisa" la apertura del dia de entrada.
  const revisadas = [...velas];
  revisadas[7] = v(7, 105, 113, 104, 112);
  const r2 = avanzar(r1.registro, new Map([["A", revisadas]]), "2026-01-09T00:00:00.000Z");

  assert.equal(r2.registro.abiertas[0]!.precioEntrada, 111, "el precio grabado manda");
  assert.equal(r2.registro.discrepancias.length, 1);
  assert.equal(r2.registro.discrepancias[0]!.grabado, 111);
  assert.equal(r2.registro.discrepancias[0]!.ahora, 105);
});

test("la discrepancia no se apunta dos veces", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  const revisadas = [...velas];
  revisadas[7] = v(7, 105, 113, 104, 112);
  const r2 = avanzar(r1.registro, new Map([["A", revisadas]]), "2026-01-09T00:00:00.000Z");
  const r3 = avanzar(r2.registro, new Map([["A", revisadas]]), "2026-01-10T00:00:00.000Z");
  assert.equal(r3.registro.discrepancias.length, 1);
});

test("tambien detecta rupturas a la BAJA", () => {
  const velas = [...base(6), v(6, 100, 100, 88, 90)];
  const r = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  assert.equal(r.nuevasPendientes.length, 1);
  assert.equal(r.nuevasPendientes[0]!.direccion, "CORTO");
});

test("en un corto el stop va POR ENCIMA de la entrada", () => {
  const velas = [...base(6), v(6, 100, 100, 88, 90), v(7, 89, 90, 88, 89)];
  const r = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  const p = r.registro.abiertas[0]!;
  assert.equal(p.direccion, "CORTO");
  assert.ok(p.nivelStop > p.precioEntrada);
});

test("resumir mide el peaje que se lleva el coste", () => {
  const r = resumir([
    { rBruto: 2, r: 1.95 } as never,
    { rBruto: -1, r: -1.05 } as never,
  ]);
  assert.equal(r.n, 2);
  assert.equal(r.wr, 0.5);
  // Bruto suma 1, neto 0,9: el peaje se lleva el 10% de la ganancia bruta.
  assert.ok(Math.abs(r.peaje - 0.1) < 1e-9, `peaje fue ${r.peaje}`);
});

test("resumir con el registro vacio no divide por cero", () => {
  const r = resumir([]);
  assert.equal(r.n, 0);
  assert.equal(r.pf, 0);
  assert.equal(r.peaje, 0);
});

test("EN MARCHA DIARIA NORMAL la entrada NO se conocia al apuntar", () => {
  // Dia 6 da señal y el dia 7 todavia no existe: es la situacion real de cada tarde.
  const velas = [...base(6), v(6, 100, 112, 100, 110)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  assert.equal(r1.registro.pendientes.length, 1);

  const conSiguiente = [...velas, v(7, 111, 113, 110, 112)];
  const r2 = avanzar(r1.registro, new Map([["A", conSiguiente]]), "2026-01-08T00:00:00.000Z");
  assert.equal(r2.registro.abiertas[0]!.entradaConocidaAlApuntar, false);
});

test("PONIENDOSE AL DIA se marca que la entrada ya se conocia", () => {
  // Una sola pasada con las dos velas: el grabador se salto un dia y recupera.
  const velas = [...base(6), v(6, 100, 112, 100, 110), v(7, 111, 113, 110, 112)];
  const r = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  assert.equal(r.registro.abiertas.length, 1, "deberia ponerse al dia en una pasada");
  assert.equal(
    r.registro.abiertas[0]!.entradaConocidaAlApuntar,
    true,
    "hay que poder distinguir estas para excluirlas del analisis estricto",
  );
});

test("SE COMPRUEBA LA PROPIA VELA DE ENTRADA: si abre y ese dia toca el stop, se ve", () => {
  // Señal el dia 6. El dia 7 abre en 111 y en esa MISMA vela se desploma por debajo del stop.
  const velas = [...base(6), v(6, 100, 112, 100, 110)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  assert.equal(r1.registro.pendientes.length, 1);
  const riesgo = r1.registro.pendientes[0]!.riesgo;

  const desplome = [...velas, v(7, 111, 111, 111 - riesgo - 5, 111 - riesgo - 4)];
  const r2 = avanzar(r1.registro, new Map([["A", desplome]]), "2026-01-08T00:00:00.000Z");

  assert.equal(r2.registro.abiertas.length, 0, "no puede quedarse abierta: el stop se toco");
  assert.equal(r2.nuevasCerradas.length, 1);
  assert.equal(r2.nuevasCerradas[0]!.motivo, "STOP");
});

test("una posicion abierta hoy YA refleja el recorrido de su vela de entrada", () => {
  const velas = [...base(6), v(6, 100, 112, 100, 110)];
  const r1 = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  // El dia de entrada sube fuerte sin tocar el stop: el extremo tiene que haberse movido.
  const conSiguiente = [...velas, v(7, 111, 150, 110, 149)];
  const r2 = avanzar(r1.registro, new Map([["A", conSiguiente]]), "2026-01-08T00:00:00.000Z");

  const p = r2.registro.abiertas[0]!;
  assert.equal(p.extremo, 150, `el extremo deberia ser el maximo del dia de entrada, fue ${p.extremo}`);
  assert.ok(p.nivelStop > p.precioEntrada - p.riesgo, "el trailing ya deberia haber actuado");
});

test("SE OBSERVA EL VOLUMEN RELATIVO pero NO se filtra por el", () => {
  // Base con volumen normal y la vela de señal con volumen 5 veces mayor.
  const base = Array.from({ length: 30 }, (_, i) => v(i, 100, 101, 99, 100, 10));
  const velas = [...base, v(30, 100, 112, 100, 110, 50)];
  const r = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);

  assert.equal(r.nuevasPendientes.length, 1, "la señal se apunta igual, el volumen no filtra");
  const rel = r.nuevasPendientes[0]!.volumenRelativo;
  assert.ok(rel != null && Math.abs(rel - 5) < 1e-9, `esperaba 5, fue ${rel}`);
});

test("una señal con volumen FLOJO se apunta igual, marcada como floja", () => {
  const base = Array.from({ length: 30 }, (_, i) => v(i, 100, 101, 99, 100, 10));
  const velas = [...base, v(30, 100, 112, 100, 110, 10)];
  const r = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);

  assert.equal(r.nuevasPendientes.length, 1, "no se descarta: el filtro se aplica AL ANALIZAR");
  assert.ok(Math.abs(r.nuevasPendientes[0]!.volumenRelativo! - 1) < 1e-9);
});

test("sin volumen en la fuente el campo queda null, no cero", () => {
  // Cero significaria "volumen nulo"; null significa "no lo sabemos". Son cosas distintas.
  const base = Array.from({ length: 30 }, (_, i) => v(i, 100, 101, 99, 100));
  const velas = [...base, v(30, 100, 112, 100, 110)];
  const r = avanzar(nuevoRegistro(), new Map([["A", velas]]), INICIO);
  assert.equal(r.nuevasPendientes[0]!.volumenRelativo, null);
});

test("LA FUENTE SE GUARDA EN EL REGISTRO, como los ajustes", () => {
  const r = registroVacio(AJ, INICIO);
  assert.equal(r.fuente, "binance", "por defecto el exchange real, no el agregador");
  assert.equal(registroVacio(AJ, INICIO, "yahoo").fuente, "yahoo");
});
