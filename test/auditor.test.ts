/**
 * LAS INVARIANTES, probadas al reves: cada una tiene una operacion rota que la OBLIGA a saltar.
 *
 * Una invariante que nunca se ha visto fallar no esta probada, esta esperando. La mitad de estas
 * pruebas fabrican a proposito la operacion imposible que la regla existe para cazar; si alguien
 * afloja la regla manana, aqui se entera.
 *
 * Al final hay dos pruebas sobre los grabadores de verdad, con una serie que ABRE PASADA DEL
 * STOP. Es el fallo que valia el 13,4% del resultado en cripto y que seguia vivo en los dos
 * grabadores hasta hoy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import {
  auditarUna, auditar, informeAuditoria, type OperacionAuditable, type Regla,
} from "../src/forex/auditor";
import { deForex, deCripto, deBot, epochDelDia } from "../src/forex/auditables";
import { registroNuevo, pasada, type Proveedor } from "../src/forex/grabador";

const H = 3600;
const v = (i: number, o: number, h: number, l: number, c: number): Vela =>
  ({ t: i * H, o, h, l, c });

/**
 * Serie sana y una operacion sana sobre ella: largo a 100, stop 90, objetivo 120, sale en el
 * objetivo. Todo lo demas de este fichero es esta operacion con UNA cosa rota.
 */
const VELAS: Vela[] = [
  v(0, 100, 101, 99, 100),
  v(1, 100, 105, 98, 104),   // entrada
  v(2, 104, 112, 103, 111),
  v(3, 111, 121, 110, 120),  // salida en el objetivo
];

const SANA: OperacionAuditable = {
  par: "X", direccion: "LARGO",
  entrada: 100, stop: 90, objetivo: 120, salida: 120, adversa: false,
  r: 1.98, tSeñal: 0, tEntrada: 1 * H, tSalida: 3 * H,
};

const reglas = (op: Partial<OperacionAuditable>, velas = VELAS): Regla[] =>
  auditarUna({ ...SANA, ...op }, velas).map((a) => a.regla);

// ------------------------------------------------------------------------------------------
// EL CASO SANO. Si esto grita, todo lo demas es ruido.
// ------------------------------------------------------------------------------------------

test("UNA OPERACION POSIBLE NO PRODUCE NADA", () => {
  assert.deepEqual(auditarUna(SANA, VELAS), []);
});

test("un corto simetrico tampoco produce nada", () => {
  const bajista: Vela[] = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 95, 96), v(2, 96, 97, 90, 91), v(3, 91, 92, 79, 80),
  ];
  const op: OperacionAuditable = {
    par: "X", direccion: "CORTO",
    entrada: 100, stop: 110, objetivo: 80, salida: 80, adversa: false,
    r: 1.98, tSeñal: 0, tEntrada: 1 * H, tSalida: 3 * H,
  };
  assert.deepEqual(auditarUna(op, bajista), []);
});

// ------------------------------------------------------------------------------------------
// PRECIOS QUE NUNCA EXISTIERON
// ------------------------------------------------------------------------------------------

test("SALIDA A UN PRECIO QUE NO ESTUVO EN LA VELA", () => {
  // 200 no lo toco nadie: el maximo de esa vela fue 121.
  assert.ok(reglas({ salida: 200, objetivo: 200, r: 9 }).includes("SALIDA_IMPOSIBLE"));
});

test("ENTRADA A UN PRECIO QUE NO ESTUVO EN LA VELA", () => {
  // La vela de entrada fue [98, 105]. A 97 no llenaron.
  assert.ok(reglas({ entrada: 97, stop: 87 }).includes("ENTRADA_IMPOSIBLE"));
});

test("una vela que no existe se dice, no se rellena", () => {
  assert.ok(reglas({ tSalida: 99 * H }).includes("SALIDA_IMPOSIBLE"));
  assert.ok(reglas({ tEntrada: 98 * H, tSalida: 99 * H }).includes("ENTRADA_IMPOSIBLE"));
});

test("SIN VELAS NO SE CALLA: no poder comprobar no es lo mismo que estar bien", () => {
  const r = auditarUna(SANA, []);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.regla, "SIN_VELAS");
});

// ------------------------------------------------------------------------------------------
// EL TIEMPO
// ------------------------------------------------------------------------------------------

test("CERRAR EN LA MISMA VELA DE LA ENTRADA no vale: no se sabe el orden intravela", () => {
  assert.ok(reglas({ tSalida: 1 * H }).includes("SALIDA_ANTES_DE_ENTRAR"));
});

test("cerrar ANTES de entrar", () => {
  assert.ok(reglas({ tSalida: 0 }).includes("SALIDA_ANTES_DE_ENTRAR"));
});

test("LA SEÑAL TIENE QUE SER ANTERIOR A LA ENTRADA, o es la vela la que la vio", () => {
  assert.ok(reglas({ tSeñal: 1 * H }).includes("SEÑAL_DESPUES_DE_ENTRAR"));
  assert.ok(reglas({ tSeñal: 2 * H }).includes("SEÑAL_DESPUES_DE_ENTRAR"));
});

// ------------------------------------------------------------------------------------------
// GEOMETRIA DE LA OPERACION
// ------------------------------------------------------------------------------------------

test("UN LARGO CON EL STOP POR ENCIMA DE LA ENTRADA", () => {
  assert.ok(reglas({ stop: 110 }).includes("STOP_DEL_LADO_MALO"));
});

test("un largo con el objetivo por debajo de la entrada", () => {
  assert.ok(reglas({ objetivo: 95 }).includes("OBJETIVO_DEL_LADO_MALO"));
});

test("una estrategia con trailing no declara objetivo y eso no es una anomalia", () => {
  const sinObjetivo = { ...SANA, objetivo: undefined };
  assert.deepEqual(auditarUna(sinObjetivo, VELAS), []);
});

test("RIESGO CERO: entrada y stop en el mismo sitio darian una R infinita", () => {
  const r = reglas({ stop: 100, r: 0 });
  assert.ok(r.includes("RIESGO_CERO"));
  assert.ok(!r.includes("R_NO_CUADRA"), "no se puede exigir aritmetica sin denominador");
});

// ------------------------------------------------------------------------------------------
// LA ARITMETICA DE LA R
// ------------------------------------------------------------------------------------------

test("EL COSTE NO PUEDE MEJORAR EL RESULTADO", () => {
  // Los precios dan 2R exactos. Declarar 2,05 es haber sumado el coste en vez de restarlo.
  assert.ok(reglas({ r: 2.05 }).includes("COSTE_NEGATIVO"));
});

test("una R neta un poco peor que la bruta es lo normal y no salta", () => {
  assert.deepEqual(reglas({ r: 1.9 }), []);
});

test("un coste de mas de 1R no es un coste, es un error de contabilidad", () => {
  assert.ok(reglas({ r: 0.5 }).includes("R_NO_CUADRA"));
});

test("EL rBruto DECLARADO TIENE QUE CUADRAR CON LOS PRECIOS, exacto", () => {
  // (120 - 100) / 10 = 2. Declarar 3 es que alguien calculo la R con otro riesgo.
  assert.ok(reglas({ rBruto: 3, r: 2.9 }).includes("R_NO_CUADRA"));
  assert.deepEqual(reglas({ rBruto: 2, r: 1.98 }), []);
});

// ------------------------------------------------------------------------------------------
// EL HUECO DE APERTURA. La razon de ser de todo esto.
// ------------------------------------------------------------------------------------------

test("SI LA VELA ABRIO PASADA DEL STOP, COBRARSE EL STOP ES IMPOSIBLE", () => {
  // Largo con stop en 90. La vela de salida abre en 85: el hueco se lo salto. A 90 no vendio
  // nadie, y decir que si regala 5 puntos, medio riesgo entero.
  const conHueco: Vela[] = [...VELAS.slice(0, 3), v(3, 85, 86, 80, 84)];
  const op = { ...SANA, salida: 90, r: -1.02, objetivo: 120, adversa: true };
  assert.ok(auditarUna(op, conHueco).map((a) => a.regla).includes("HUECO_NO_COBRADO"));
});

test("con el hueco cobrado bien —salida en la apertura— no salta", () => {
  const conHueco: Vela[] = [...VELAS.slice(0, 3), v(3, 85, 86, 80, 84)];
  const op = { ...SANA, salida: 85, stop: 90, r: -1.52, objetivo: 120, adversa: true };
  assert.deepEqual(auditarUna(op, conHueco), []);
});

test("EN UN CORTO EL HUECO ES AL REVES y tambien se caza", () => {
  const velas: Vela[] = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 95, 96), v(2, 96, 97, 90, 91), v(3, 120, 125, 118, 124),
  ];
  const op: OperacionAuditable = {
    par: "X", direccion: "CORTO",
    entrada: 100, stop: 110, salida: 110, adversa: true, r: -1.02,
    tSeñal: 0, tEntrada: 1 * H, tSalida: 3 * H,
  };
  assert.ok(auditarUna(op, velas).map((a) => a.regla).includes("HUECO_NO_COBRADO"));
});

test("UN HUECO A FAVOR LLENA MEJOR, y apuntar el nivel sigue siendo un precio que no existio", () => {
  // Largo con objetivo 120 y la vela abre en 130: la orden limitada se ejecuta en 130. Apuntar
  // 120 es conservador y ademas es mentira, y una auditoria no puede distinguir una mentira
  // prudente de un fallo. Se apunta 130.
  const aFavor: Vela[] = [...VELAS.slice(0, 3), v(3, 130, 140, 128, 138)];
  assert.ok(auditarUna({ ...SANA, salida: 120 }, aFavor).map((a) => a.regla).includes("SALIDA_IMPOSIBLE"));
  assert.deepEqual(auditarUna({ ...SANA, salida: 130, r: 2.98 }, aFavor), []);
});

// ------------------------------------------------------------------------------------------
// EL CONJUNTO Y EL INFORME
// ------------------------------------------------------------------------------------------

test("una operacion puede violar varias reglas a la vez y se cuentan todas", () => {
  const r = reglas({ stop: 110, tSeñal: 2 * H, salida: 500, objetivo: 500, r: 40 });
  assert.ok(r.includes("STOP_DEL_LADO_MALO"));
  assert.ok(r.includes("SEÑAL_DESPUES_DE_ENTRAR"));
  assert.ok(r.includes("SALIDA_IMPOSIBLE"));
});

test("`auditar` agrupa por regla para distinguir un caso suelto de un patron", () => {
  const rota = { ...SANA, tSeñal: 2 * H };
  const a = auditar([SANA, rota, rota], () => VELAS);
  assert.equal(a.operaciones, 3);
  assert.equal(a.porRegla["SEÑAL_DESPUES_DE_ENTRAR"], 2);
});

test("EL INFORME LIMPIO OCUPA UNA LINEA: un aviso largo cada dia deja de leerse", () => {
  const texto = informeAuditoria(auditar([SANA], () => VELAS));
  assert.equal(texto.split("\n").length, 1);
  assert.ok(texto.includes("posibles"));
});

test("el informe sucio nombra la regla y el par", () => {
  const texto = informeAuditoria(auditar([{ ...SANA, stop: 110 }], () => VELAS));
  assert.ok(texto.includes("ANOMALIAS"));
  assert.ok(texto.includes("STOP_DEL_LADO_MALO"));
  assert.ok(texto.includes("X"));
});

test("un instrumento sin velas se audita igual, avisando", () => {
  const a = auditar([SANA], () => undefined);
  assert.equal(a.porRegla["SIN_VELAS"], 1);
});

// ------------------------------------------------------------------------------------------
// LOS ADAPTADORES
// ------------------------------------------------------------------------------------------

test("el dia se convierte al epoch de su vela diaria, que abre a las 00:00 UTC", () => {
  assert.equal(epochDelDia("1970-01-02"), 86_400);
  assert.equal(new Date(epochDelDia("2026-09-07") * 1000).toISOString(), "2026-09-07T00:00:00.000Z");
});

test("EL ADAPTADOR DE CRIPTO RECONSTRUYE EL STOP INICIAL, no el del trailing", () => {
  // Con trailing, `nivelStop` acaba POR ENCIMA de la entrada en toda ganadora. Si el auditor
  // recibiera ese nivel, cada operacion buena pareceria tener el stop del lado malo.
  const op = deCripto({
    instrumento: "BTCUSDT", direccion: "LARGO", diaSenal: "2026-01-01",
    apuntadoEn: "x", riesgo: 10, volumenRelativo: null,
    diaEntrada: "2026-01-02", precioEntrada: 100, nivelStop: 130, extremo: 150,
    ultimoDia: "2026-01-05", entradaConocidaAlApuntar: false,
    diaSalida: "2026-01-05", precioSalida: 130, r: 2.95, rBruto: 3, motivo: "TRAILING",
  });
  assert.equal(op.stop, 90, "el stop inicial es entrada menos riesgo");
  assert.equal(op.objetivo, undefined, "con trailing no hay objetivo fijo");
  assert.equal(op.adversa, true, "stop y trailing son las dos salidas adversas");
  assert.equal(op.rBruto, 3);
});

test("el adaptador de forex conserva el objetivo y la vela de salida", () => {
  const op = deForex({
    par: "EURUSD", direccion: "CORTO", entrada: 1.1, stop: 1.11, objetivo: 1.08, rr: 2,
    apuntada: "x", tSeñal: 0, caducaEn: 99, abierta: "y", tEntrada: H,
    cerrada: "z", salida: 1.08, r: 1.9, motivo: "OBJETIVO", tSalida: 3 * H,
  });
  assert.equal(op.objetivo, 1.08);
  assert.equal(op.tSalida, 3 * H);
  assert.equal(op.adversa, false, "salio en el objetivo");
});

// ------------------------------------------------------------------------------------------
// LOS GRABADORES DE VERDAD, contra una serie que abre pasada del stop
// ------------------------------------------------------------------------------------------

/**
 * Estrategia de mentira: una señal fija en la vela 34, para poder fabricar el hueco a mano.
 *
 * El indice esta atado a la forma de la serie de abajo. La primera pasada llega solo hasta la 34
 * y no ve nada, que es justo lo que hace falta: el grabador solo marca por donde va la primera
 * vez que ve un instrumento, y una señal apuntada en esa pasada no se grabaria nunca.
 */
const unaSeñal: Proveedor = (_par, velas) =>
  velas.length > 35
    ? [{ i: 34, direccion: "LARGO", entrada: 100, stop: 90, objetivo: 130, rr: 3 }]
    : [];

/** 34 velas planas, la de la señal, la de la entrada, y luego lo que se le ponga. */
const conCola = (...cola: Vela[]): Vela[] => [
  ...Array.from({ length: 34 }, (_, k) => v(k, 100, 101, 99, 100)),
  v(34, 100, 101, 99, 100),   // la señal
  v(35, 100, 101, 99, 100),   // la entrada limitada en 100 se llena aqui
  ...cola,
];

/**
 * Tres pasadas: la primera solo marca por donde va, la segunda apunta y abre, y la tercera
 * resuelve. Es el orden real del grabador —resolver, apuntar, abrir— y no un rodeo de la prueba.
 */
function tresPasadas(velas: Vela[]) {
  const reg = registroNuevo("h", "d0", {}, 0, 50);
  const a = pasada(reg, new Map([["X", velas.slice(0, 35)]]), unaSeñal, "d1");
  const b = pasada(a.registro, new Map([["X", velas]]), unaSeñal, "d2");
  return pasada(b.registro, new Map([["X", velas]]), unaSeñal, "d3").registro;
}

test("EL GRABADOR DE FOREX NO SE COBRA UN STOP QUE EL HUECO SE SALTO", () => {
  // La vela 36 ABRE EN 80, muy por debajo del stop 90. A 90 no vendio nadie.
  const velas = conCola(v(36, 80, 81, 78, 79), v(37, 79, 80, 78, 79), v(38, 79, 80, 78, 79));
  const reg = tresPasadas(velas);

  assert.equal(reg.cerradas.length, 1);
  const c = reg.cerradas[0]!;
  assert.equal(c.salida, 80, `se cobra la apertura, no el stop: salio en ${c.salida}`);
  assert.equal(c.r, -2, "el hueco duele el doble que el stop");
  assert.equal(c.tSalida, 36 * H);

  // Y la invariante confirma que lo que quedo grabado es posible.
  const audit = auditar(reg.cerradas.map(deForex), () => velas);
  assert.deepEqual(audit.anomalias, [], informeAuditoria(audit));
});

test("un stop normal, sin hueco, sigue costando exactamente 1R", () => {
  // Abre en 99 y baja hasta 88: toca el stop 90 DENTRO de la vela, que es lo normal.
  const velas = conCola(v(36, 99, 100, 88, 89), v(37, 89, 90, 88, 89), v(38, 89, 90, 88, 89));
  const c = tresPasadas(velas).cerradas[0]!;
  assert.equal(c.salida, 90);
  assert.equal(c.r, -1);
});

test("UN HUECO A FAVOR SE APUNTA AL PRECIO QUE SE CONSIGUIO, no al objetivo", () => {
  // La vela 36 abre en 150 con el objetivo en 130: la orden limitada se ejecuta en 150.
  const velas = conCola(v(36, 150, 155, 148, 154), v(37, 154, 156, 150, 152), v(38, 154, 156, 150, 152));
  const reg = tresPasadas(velas);
  const c = reg.cerradas[0]!;
  assert.equal(c.salida, 150);
  assert.equal(c.r, 5, "(150 - 100) / 10, no el 3 del objetivo");

  const audit = auditar(reg.cerradas.map(deForex), () => velas);
  assert.deepEqual(audit.anomalias, [], informeAuditoria(audit));
});

// ------------------------------------------------------------------------------------------
// EL BOT EN PAPEL, que es el unico que corre con dinero imaginario todos los dias
// ------------------------------------------------------------------------------------------

test("UNA CERRADA DEL BOT SIN LOS DATOS PARA AUDITARLA DEVUELVE null, no una a medias", () => {
  // Las operaciones que el bot cerro antes de guardar riesgo y dias no se pueden comprobar.
  // Rellenar los huecos con supuestos las colaria entre las buenas y diria que todo esta bien.
  const vieja = {
    simbolo: "INJUSDT", direccion: "LARGO" as const, entrada: 6.183, salida: 5.37, r: -1,
  };
  assert.equal(deBot(vieja), null);
  assert.equal(deBot({ ...vieja, riesgo: 0.814 }), null, "faltan los dias");
  assert.equal(
    deBot({ ...vieja, riesgo: 0.814, diaSenal: "2026-09-01", diaEntrada: "2026-09-02" }),
    null,
    "falta el dia de salida",
  );
});

test("una cerrada completa del bot se traduce entera", () => {
  const op = deBot({
    simbolo: "INJUSDT", direccion: "LARGO", entrada: 6.183, salida: 5.3687, r: -1.0004,
    riesgo: 0.8143, diaSenal: "2026-09-01", diaEntrada: "2026-09-02", diaSalida: "2026-09-05",
  })!;
  assert.ok(Math.abs(op.stop - (6.183 - 0.8143)) < 1e-9);
  assert.equal(op.adversa, true);
  assert.ok(op.tSeñal < op.tEntrada && op.tEntrada < op.tSalida!);
});

// ------------------------------------------------------------------------------------------
// EL HUECO A FAVOR EN LA ENTRADA, que hacia saltar la alarma en operaciones sanas
// ------------------------------------------------------------------------------------------
//
// Medido sobre el registro real: 11 falsas alarmas de 39 operaciones. El grabador llena en la
// apertura cuando la vela abre pasada del limite —una limitada nunca da un precio peor que el
// suyo— y dimensiona con el riesgo PLANEADO. El adaptador pasaba el limite en vez del llenado,
// asi que el auditor veia un precio fuera de su vela y un coste con el signo cambiado.

test("EL ADAPTADOR PASA EL LLENADO, no el limite planeado", () => {
  const c = {
    par: "EURJPY=X", direccion: "LARGO" as const,
    entrada: 178.582, stop: 178.4841, objetivo: 178.872, rr: 2.96,
    apuntada: "x", tSeñal: 0, caducaEn: 99, abierta: "y", tEntrada: 3600,
    entradaReal: 178.535,
    cerrada: "z", salida: 178.4841, r: -0.6294, motivo: "STOP" as const, tSalida: 7200,
  };
  const op = deForex(c);
  assert.equal(op.entrada, 178.535, "el precio al que llenaron de verdad");
  assert.ok(Math.abs(op.riesgo! - 0.0979) < 1e-4, "el riesgo es el PLANEADO, |limite - stop|");
});

test("y sin ese arreglo, una operacion correcta daba DOS anomalias falsas", () => {
  // La vela de entrada abrio en 178.535, por debajo del limite de 178.582: el limite nunca
  // estuvo dentro de su rango, y aun asi la operacion es perfectamente legitima.
  const velas: Vela[] = [
    { t: 0, o: 178.60, h: 178.62, l: 178.58, c: 178.60 },
    { t: 3600, o: 178.535, h: 178.574, l: 178.521, c: 178.53 },
    { t: 7200, o: 178.52, h: 178.53, l: 178.48, c: 178.49 },
  ];
  const c = {
    par: "EURJPY=X", direccion: "LARGO" as const,
    entrada: 178.582, stop: 178.4841, objetivo: 178.872, rr: 2.96,
    apuntada: "x", tSeñal: 0, caducaEn: 99, abierta: "y", tEntrada: 3600,
    entradaReal: 178.535,
    cerrada: "z", salida: 178.4841, r: -0.6294, motivo: "STOP" as const, tSalida: 7200,
  };
  assert.deepEqual(auditarUna(deForex(c), velas), [], "con el llenado y el riesgo planeado, limpia");

  // Y lo que hacia antes: pasar el limite y dejar que el riesgo se dedujera de los precios.
  const comoAntes = { ...deForex(c), entrada: c.entrada, riesgo: undefined };
  const reglas = auditarUna(comoAntes, velas).map((a) => a.regla);
  assert.ok(reglas.includes("ENTRADA_IMPOSIBLE"));
  assert.ok(reglas.includes("COSTE_NEGATIVO"));
});

// ------------------------------------------------------------------------------------------
// CERRAR EN LA PROPIA VELA DE ENTRADA: posible o imposible segun COMO se entro
// ------------------------------------------------------------------------------------------
//
// El bot de cripto entra con la apertura del dia, asi que todo el recorrido de esa vela viene
// despues: que salte el stop el mismo dia es normal. El grabador de forex entra con una orden
// limitada a mitad de vela, y ahi cerrar en la misma vela seria suponer un orden intravela que
// no consta. Tratarlas igual marcaba como imposible una operacion correcta del bot (DOTUSDT,
// 9 sep) y ponia el bot a salir con codigo 1 en cada pasada.

test("CON ORDEN LIMITADA, cerrar en la vela de entrada sigue siendo imposible", () => {
  assert.ok(reglas({ tSalida: 1 * H }).includes("SALIDA_ANTES_DE_ENTRAR"));
});

test("ENTRANDO EN LA APERTURA, cerrar en esa misma vela es NORMAL", () => {
  const r = reglas({ tSalida: 1 * H, entradaEnApertura: true });
  assert.ok(!r.includes("SALIDA_ANTES_DE_ENTRAR"), `no deberia quejarse: ${r.join(", ")}`);
});

test("pero salir ANTES de la vela de entrada es imposible de las dos formas", () => {
  assert.ok(reglas({ tSalida: 0 }).includes("SALIDA_ANTES_DE_ENTRAR"));
  assert.ok(reglas({ tSalida: 0, entradaEnApertura: true }).includes("SALIDA_ANTES_DE_ENTRAR"));
});

test("los dos adaptadores de vela diaria declaran que entran en la apertura", () => {
  const bot = deBot({
    simbolo: "DOTUSDT", direccion: "LARGO", entrada: 1.246, salida: 1.1054, r: -1,
    riesgo: 0.1406, diaSenal: "2026-09-08", diaEntrada: "2026-09-09", diaSalida: "2026-09-09",
  })!;
  assert.equal(bot.entradaEnApertura, true);
  assert.deepEqual(auditarUna(bot, []).map((a) => a.regla), ["SIN_VELAS"],
    "sin velas solo puede quejarse de eso, no del mismo dia");
});
