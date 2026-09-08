import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import {
  registroNuevo, pasada, balance, mismosAjustes, muestraNecesaria,
  type Registro, type Proveedor, type Cerrada,
} from "../src/forex/grabador";
import { señales, type AjustesSMC } from "../src/forex/smc";

const H = 3600;
const v = (i: number, o: number, h: number, l: number, c: number): Vela =>
  ({ t: i * H, o, h, l, c });

const AJ: AjustesSMC = {
  minHueco: 0.2, minEmpuje: 1.5, vigencia: 60, esperaBloque: 20, colchon: 0.1,
  objetivoR: 2, radioLiquidez: 0.5, toquesLiquidez: 3, memoriaHuecos: 50,
};
const atrPlano = (n: number) => Array.from({ length: n }, () => 5);

/** El grabador es generico: la estrategia entra como funcion. Aqui, la de SMC. */
const proveedor: Proveedor = (_par, velas) =>
  señales(velas, atrPlano(velas.length), AJ).map((x) => ({ ...x, rr: AJ.objetivoR }));

/** Relleno para llegar a las 30 velas que el grabador exige antes de mirar nada. */
const relleno = (desde: number, n: number): Vela[] =>
  Array.from({ length: n }, (_, k) => v(desde + k, 100, 101, 99, 100));

/**
 * Bloque alcista, rotura bajista, bloque bajista nuevo, y VUELTA a el.
 *
 * La vuelta es imprescindible: la entrada es una orden limitada, asi que sin retorno al bloque
 * no hay operacion que grabar.
 */
function serie(): Vela[] {
  return [
    ...relleno(0, 32),
    v(32, 100, 102, 98, 101), v(33, 101, 118, 100, 117), v(34, 117, 125, 110, 124),
    v(35, 124, 125, 115, 116), v(36, 116, 117, 95, 96),
    v(37, 96, 97, 80, 81), v(38, 81, 82, 70, 71),
    v(39, 71, 90, 70, 89), v(40, 89, 95, 88, 94),
    v(41, 94, 100, 93, 99), v(42, 99, 108, 98, 107),
    v(43, 107, 118, 106, 116),
    v(44, 116, 117, 100, 101), v(45, 101, 102, 90, 91),
  ];
}

const nuevo = () => registroNuevo("prueba", "d0", AJ, 0, AJ.vigencia);
const uno = (reg: Registro<AjustesSMC>, velas: Vela[], ahora = "d1") =>
  pasada(reg, new Map([["X", velas]]), proveedor, ahora);

/** Enciende el registro con un prefijo: la primera pasada nunca apunta nada. */
const arrancado = (velas: Vela[], corte = 34) => uno(nuevo(), velas.slice(0, corte), "d0").registro;

// ---------------------------------------------------------------------------------------
// LAS CUATRO REGLAS QUE HACEN CREIBLE EL REGISTRO
// ---------------------------------------------------------------------------------------

test("LA PRIMERA PASADA NO APUNTA NADA: solo marca por donde va", () => {
  // Si apuntara, el registro naceria lleno de señales cuya ventana caduco hace meses, y no
  // seria una prueba hacia adelante sino otro backtest disfrazado.
  const velas = serie();
  const { registro, resumen } = uno(nuevo(), velas, "d0");
  assert.equal(resumen.nuevas, 0);
  assert.equal(registro.pendientes.length, 0);
  assert.equal(registro.vistoHasta["X"], velas[velas.length - 2]!.t);
});

test("UNA SEÑAL SE APUNTA CON SUS TRES PRECIOS YA FIJADOS", () => {
  const velas = serie();
  const { registro, resumen } = uno(arrancado(velas), velas);
  const total = resumen.nuevas + registro.abiertas.length + registro.cerradas.length;
  assert.ok(total > 0 || registro.pendientes.length > 0, "la serie tiene que dar alguna señal");
  for (const p of [...registro.pendientes, ...registro.abiertas]) {
    assert.ok(p.entrada > 0 && p.stop > 0 && p.objetivo > 0);
    assert.notEqual(p.entrada, p.stop);
    assert.ok(p.rr > 0, "el R:R se guarda por señal, no se supone fijo");
  }
});

test("LA ULTIMA VELA NO SE USA: esta en curso", () => {
  const velas = serie();
  const { registro } = uno(arrancado(velas), velas);
  const ultima = velas[velas.length - 1]!.t;
  for (const p of [...registro.pendientes, ...registro.abiertas]) {
    assert.ok(p.tSeñal < ultima, "ninguna señal puede salir de la vela en curso");
  }
});

test("UN PRECIO YA APUNTADO NO SE REESCRIBE aunque la fuente lo cambie", () => {
  const velas = serie();
  const a = uno(arrancado(velas), velas).registro;
  const antes = [...a.pendientes, ...a.abiertas].map((p) => ({ ...p }));

  // La fuente "revisa" una vela vieja con otros precios.
  const revisadas = velas.map((c, i) => (i === 33 ? v(33, 101, 140, 100, 139) : c));
  const b = uno(a, revisadas, "d2").registro;

  for (const x of antes) {
    const ahora = [...b.pendientes, ...b.abiertas, ...b.cerradas].find((p) => p.tSeñal === x.tSeñal);
    if (!ahora) continue;
    assert.equal(ahora.entrada, x.entrada, "la entrada grabada es intocable");
    assert.equal(ahora.stop, x.stop);
    assert.equal(ahora.objetivo, x.objetivo);
  }
});

test("CAMBIAR CUALQUIER AJUSTE se detecta", () => {
  assert.ok(mismosAjustes(AJ, { ...AJ }));
  assert.ok(mismosAjustes(AJ, Object.fromEntries(Object.entries(AJ).reverse())), "el orden no importa");
  assert.ok(!mismosAjustes(AJ, { ...AJ, objetivoR: 3 }));
  assert.ok(
    !mismosAjustes(AJ, { ...AJ, aplicarVetos: false }),
    "cualquier diferencia cuenta: comparar solo unas claves invita a olvidarse de una",
  );
});

// ---------------------------------------------------------------------------------------
// EL ORDEN, Y ESTAR APAGADO
// ---------------------------------------------------------------------------------------

test("una señal NO se abre con su propia vela ni antes", () => {
  const velas = serie();
  const { registro } = uno(arrancado(velas), velas);
  for (const c of [...registro.cerradas, ...registro.abiertas]) {
    assert.ok(c.tEntrada > c.tSeñal);
  }
});

test("SE PONE AL DIA tras estar apagado, dando lo mismo que vela a vela", () => {
  const velas = serie();
  const base = arrancado(velas);
  const deGolpe = uno(base, velas).registro;

  let poco = base;
  for (let n = 35; n <= velas.length; n += 1) {
    poco = uno(poco, velas.slice(0, n), `d${n}`).registro;
  }

  const clave = (r: Registro<AjustesSMC>) =>
    [...r.pendientes, ...r.abiertas, ...r.cerradas]
      .map((x) => `${x.tSeñal}:${x.entrada}:${x.stop}:${x.objetivo}`)
      .sort()
      .join("|");
  assert.equal(clave(deGolpe), clave(poco), "un fin de semana apagado no cambia nada");
});

test("volver a pasar sobre las mismas velas NO duplica ni reabre", () => {
  const velas = serie();
  const a = uno(arrancado(velas), velas).registro;
  const b = uno(a, velas, "d2").registro;
  const cuenta = (r: Registro<AjustesSMC>) =>
    r.pendientes.length + r.abiertas.length + r.cerradas.length;
  assert.equal(cuenta(b), cuenta(a));
  assert.equal(b.cerradas.length, a.cerradas.length);
});

test("una pendiente que nunca se toca CADUCA", () => {
  const velas = [...serie(), ...Array.from({ length: 90 }, (_, k) => v(46 + k, 50, 51, 49, 50))];
  const { registro } = uno(arrancado(velas), velas);
  for (const p of registro.pendientes) {
    assert.ok(velas[velas.length - 2]!.t <= p.caducaEn, "no quedan pendientes vencidas");
  }
});

// ---------------------------------------------------------------------------------------
// BALANCE
// ---------------------------------------------------------------------------------------

const cerrada = (r: number, rr = 2): Cerrada => ({
  par: "X", direccion: "LARGO", entrada: 1, stop: 0.5, objetivo: 2, rr,
  apuntada: "d", tSeñal: 0, caducaEn: 0, abierta: "d", tEntrada: 1,
  cerrada: "d", salida: 1, r, motivo: r > 0 ? "OBJETIVO" : "STOP",
});

test("el balance de un registro vacio no divide entre cero", () => {
  const b = balance([]);
  assert.equal(b.n, 0);
  assert.equal(b.pf, 0);
  assert.equal(b.esperanza, 0);
});

test("EL R:R MEDIO sale de las señales, no de un ajuste fijo", () => {
  const b = balance([cerrada(2, 2), cerrada(-1, 9)]);
  assert.equal(b.rrMedio, 5.5, "con objetivo en un nivel, cada señal trae el suyo");
});

test("LA MUESTRA NECESARIA avisa de que veinte operaciones no dicen nada", () => {
  const pocas = balance(Array.from({ length: 20 }, (_, k) => cerrada(k % 3 === 0 ? 2 : -1)));
  assert.ok(muestraNecesaria(pocas) > 20);
});

test("una esperanza minuscula necesita una muestra enorme", () => {
  const casiCero = { n: 100, aciertos: 0.33, pf: 1.01, esperanza: 0.018, error: 0.11, rrMedio: 2 };
  assert.ok(muestraNecesaria(casiCero) > 10_000, "0,018R es indistinguible sin miles de datos");
});

// ---------------------------------------------------------------------------------------
// ¿SE APUNTO ANTES DE QUE LA ENTRADA EXISTIERA?
// ---------------------------------------------------------------------------------------
//
// Medido el 8 sep sobre el registro de verdad: 6 de 6 señales se apuntaron cuando su entrada
// YA se habia llenado, entre 31 y 256 minutos tarde. Los precios no quedan falseados —la
// entrada es una orden limitada cuyo nivel sale de la vela de la señal— pero se pierde lo unico
// que hacia valioso el registro, que es haberse comprometido antes.
//
// Se apunta por operacion para poder separarlas despues. Una marca que dijera siempre lo mismo
// no serviria de nada, asi que aqui se fijan los DOS sentidos.

/** Estrategia de mentira: señal en la vela `iSeñal`, para controlar el retraso a mano. */
const señalEn = (iSeñal: number, minimo: number): Proveedor => (_par, velas) =>
  velas.length > iSeñal
    ? [{ i: iSeñal, direccion: "LARGO", entrada: minimo, stop: minimo - 10, objetivo: minimo + 20, rr: 2 }]
    : [];

test("AL DIA: la señal es la ultima vela cerrada y la marca dice que no se sabia", () => {
  const base = Array.from({ length: 34 }, (_, k) => v(k, 100, 101, 99, 100));
  const reg = registroNuevo("m", "d0", {}, 0, 50);
  // Primera pasada hasta la 32; segunda con una vela mas, asi que la señal (33) es la ultima
  // CERRADA de la segunda y despues de ella no existe nada todavia.
  const a = pasada(reg, new Map([["X", base.slice(0, 34)]]), señalEn(33, 100), "d1");
  const b = pasada(
    a.registro,
    new Map([["X", [...base, v(34, 100, 101, 99, 100), v(35, 100, 101, 99, 100)]]]),
    señalEn(34, 100), "d2",
  );
  assert.equal(b.registro.pendientes.length + b.registro.abiertas.length, 1);
  const p = [...b.registro.pendientes, ...b.registro.abiertas][0]!;
  assert.equal(p.tSeñal, 34 * H);
  assert.equal(p.velasDeRetraso, 0);
});

test("CON RETRASO: se apunta CUANTAS velas, no un si/no", () => {
  const base = Array.from({ length: 34 }, (_, k) => v(k, 100, 101, 99, 100));
  const cola = Array.from({ length: 12 }, (_, k) => v(34 + k, 100, 101, 99, 100));
  const reg = registroNuevo("m", "d0", {}, 0, 50);
  const a = pasada(reg, new Map([["X", base]]), señalEn(34, 100), "d1");
  // Doce velas de golpe: la señal de la 34 se apunta cuando ya existen hasta la 45.
  const b = pasada(a.registro, new Map([["X", [...base, ...cola]]]), señalEn(34, 100), "d2");
  const todas = [...b.registro.pendientes, ...b.registro.abiertas, ...b.registro.cerradas];
  assert.equal(todas.length, 1);
  // De la vela 34 a la 44: la 45 esta EN CURSO y el grabador no la cuenta.
  assert.equal(todas[0]!.velasDeRetraso, 10);
});

test("la marca viaja con la operacion hasta que se cierra", () => {
  const base = Array.from({ length: 34 }, (_, k) => v(k, 100, 101, 99, 100));
  const cola = [
    ...Array.from({ length: 6 }, (_, k) => v(34 + k, 100, 101, 99, 100)),
    v(40, 100, 101, 79, 80),   // toca el stop en 90
    v(41, 80, 81, 79, 80),
  ];
  const reg = registroNuevo("m", "d0", {}, 0, 50);
  const a = pasada(reg, new Map([["X", base]]), señalEn(34, 100), "d1");
  const b = pasada(a.registro, new Map([["X", [...base, ...cola]]]), señalEn(34, 100), "d2");
  const c = pasada(b.registro, new Map([["X", [...base, ...cola]]]), señalEn(34, 100), "d3");
  assert.equal(c.registro.cerradas.length, 1);
  assert.ok(c.registro.cerradas[0]!.velasDeRetraso! > 0);
});
