import { test } from "node:test";
import assert from "node:assert/strict";
import { simularCartera, porDia, type Operacion } from "../src/forex/cartera";

const DIA = 86400;
const op = (instrumento: string, d0: number, d1: number, r: number): Operacion => ({
  instrumento,
  tEntrada: d0 * DIA,
  tSalida: d1 * DIA,
  r,
});

const base = { capital: 10_000, riesgoPct: 0.01, maxPosiciones: 0, compuesto: false };

test("una ganadora de 1R con riesgo del 1% suma exactamente el 1%", () => {
  const res = simularCartera([op("A", 1, 3, 1)], base);
  assert.equal(res.capitalFinal, 10_100);
  assert.equal(res.aceptadas, 1);
  assert.equal(res.maxCaida, 0);
});

test("una perdedora de -1R resta el 1% y esa es la caida maxima", () => {
  const res = simularCartera([op("A", 1, 3, -1)], base);
  assert.equal(res.capitalFinal, 9_900);
  assert.ok(Math.abs(res.maxCaida - 0.01) < 1e-9);
  assert.ok(Math.abs(res.peorDia + 0.01) < 1e-9);
});

test("EL TOPE DE POSICIONES rechaza las que no caben", () => {
  const ops = [op("A", 1, 9, 1), op("B", 1, 9, 1), op("C", 1, 9, 1)];
  const res = simularCartera(ops, { ...base, maxPosiciones: 2 });
  assert.equal(res.aceptadas, 2);
  assert.equal(res.rechazadas, 1);
  assert.equal(res.maxSimultaneas, 2);
  // Solo cobra las dos que entraron.
  assert.equal(res.capitalFinal, 10_200);
});

test("sin tope se abren todas a la vez", () => {
  const ops = [op("A", 1, 9, 1), op("B", 1, 9, 1), op("C", 1, 9, 1)];
  const res = simularCartera(ops, base);
  assert.equal(res.aceptadas, 3);
  assert.equal(res.rechazadas, 0);
  assert.equal(res.maxSimultaneas, 3);
});

test("una posicion que cierra libera el hueco para la siguiente", () => {
  const ops = [op("A", 1, 2, 1), op("B", 3, 4, 1)];
  const res = simularCartera(ops, { ...base, maxPosiciones: 1 });
  assert.equal(res.aceptadas, 2);
  assert.equal(res.rechazadas, 0);
  assert.equal(res.maxSimultaneas, 1);
});

test("cuando una cierra y otra abre EL MISMO DIA, el cierre va primero", () => {
  // Si el orden fuera al reves, B seria rechazada por falta de hueco.
  const ops = [op("A", 1, 5, 1), op("B", 5, 7, 1)];
  const res = simularCartera(ops, { ...base, maxPosiciones: 1 });
  assert.equal(res.aceptadas, 2);
  assert.equal(res.rechazadas, 0);
});

test("EL RIESGO SE CONGELA EN LA ENTRADA, no se recalcula al cerrar", () => {
  // Compuesto: A abre con 10.000 (riesgo 100) y cierra a 10.100. B abre con 10.100
  // (riesgo 101) y gana 1R -> 10.201. Si el riesgo de A se recalculara al cierre saldria otra
  // cifra.
  const ops = [op("A", 1, 2, 1), op("B", 3, 4, 1)];
  const res = simularCartera(ops, { ...base, compuesto: true });
  assert.ok(Math.abs(res.capitalFinal - 10_201) < 1e-6);
});

test("SIN COMPONER el riesgo es siempre el mismo, gane o pierda", () => {
  const ops = [op("A", 1, 2, 1), op("B", 3, 4, 1)];
  const res = simularCartera(ops, base);
  assert.equal(res.capitalFinal, 10_200);
});

test("VEINTE SEÑALES EL MISMO DIA no son veinte apuestas: caen juntas", () => {
  // Todas pierden -1R a la vez. Con riesgo del 1% eso es un -20% en un solo dia, que es
  // exactamente el peligro que el promedio en R esconde.
  const ops = Array.from({ length: 20 }, (_, k) => op(`E${k}`, 1, 3, -1));
  const res = simularCartera(ops, base);
  assert.equal(res.aceptadas, 20);
  assert.ok(Math.abs(res.capitalFinal - 8_000) < 1e-6);
  assert.ok(Math.abs(res.peorDia + 0.2) < 1e-9, `peorDia fue ${res.peorDia}`);
  assert.ok(Math.abs(res.maxCaida - 0.2) < 1e-9);
});

test("la caida maxima se mide desde el pico, no desde el capital inicial", () => {
  const ops = [op("A", 1, 2, 10), op("B", 3, 4, -5)];
  const res = simularCartera(ops, base);
  // 10.000 -> 11.000 (pico) -> 10.500. La caida es 500/11.000, no 500/10.000.
  assert.ok(Math.abs(res.capitalFinal - 10_500) < 1e-6);
  assert.ok(Math.abs(res.maxCaida - 500 / 11_000) < 1e-9);
});

test("porDia junta las señales del mismo dia en una sola observacion", () => {
  const ops = [op("A", 1, 3, 1), op("B", 1, 3, -1), op("C", 2, 4, 0.5)];
  const d = porDia(ops);
  assert.equal(d.length, 2);
  assert.equal(d[0]!.n, 2);
  assert.equal(d[0]!.r, 0);
  assert.equal(d[1]!.n, 1);
  assert.equal(d[1]!.r, 0.5);
});

test("porDia devuelve los dias en orden", () => {
  const ops = [op("A", 9, 10, 1), op("B", 2, 3, 1)];
  const d = porDia(ops);
  assert.ok(d[0]!.dia < d[1]!.dia);
});

test("sin operaciones no se inventa nada", () => {
  const res = simularCartera([], base);
  assert.equal(res.capitalFinal, 10_000);
  assert.equal(res.aceptadas, 0);
  assert.equal(res.curva.length, 0);
  assert.equal(porDia([]).length, 0);
});

test("LA RUINA ES ABSORBENTE: sin capital no se sigue operando", () => {
  // 200 posiciones a la vez con 1% de riesgo cada una: mas riesgo abierto que capital.
  const ops = Array.from({ length: 200 }, (_, k) => op(`E${k}`, 1, 3, -1));
  const res = simularCartera(ops, { ...base, compuesto: true });
  assert.equal(res.capitalFinal, 0, "el capital no puede quedar negativo");
  assert.ok(res.maxCaida <= 1, `la caida no puede pasar del 100%, fue ${res.maxCaida}`);
  assert.ok(res.peorDia >= -1, `el peor dia no puede pasar del -100%, fue ${res.peorDia}`);
});

test("tras la ruina las señales posteriores se rechazan, no se operan", () => {
  const ops = [
    ...Array.from({ length: 200 }, (_, k) => op(`E${k}`, 1, 3, -1)),
    op("despues", 10, 12, 5),
  ];
  const res = simularCartera(ops, { ...base, compuesto: true });
  assert.equal(res.capitalFinal, 0, "una ganadora posterior no resucita una cuenta a cero");
  assert.ok(res.rechazadas >= 1);
});

test("EL TOPE POR DIRECCION impide que 8 posiciones sean la misma apuesta", () => {
  const largos: Operacion[] = Array.from({ length: 8 }, (_, k) => ({
    ...op(`L${k}`, 1, 5, -1), direccion: "LARGO" as const,
  }));
  const sin = simularCartera(largos, { ...base, maxPosiciones: 8 });
  const con = simularCartera(largos, { ...base, maxPosiciones: 8, maxPorDireccion: 3 });

  assert.equal(sin.aceptadas, 8);
  assert.equal(con.aceptadas, 3, "solo deberian entrar 3 largos");
  assert.equal(con.rechazadas, 5);
  // El daño se divide: 8 perdedoras al 1% son -8%; 3 son -3%.
  assert.ok(Math.abs(sin.capitalFinal - 9_200) < 1e-6);
  assert.ok(Math.abs(con.capitalFinal - 9_700) < 1e-6);
});

test("el tope por direccion NO bloquea el lado contrario", () => {
  const ops: Operacion[] = [
    { ...op("L1", 1, 5, 1), direccion: "LARGO" },
    { ...op("L2", 1, 5, 1), direccion: "LARGO" },
    { ...op("C1", 1, 5, 1), direccion: "CORTO" },
    { ...op("C2", 1, 5, 1), direccion: "CORTO" },
  ];
  const r = simularCartera(ops, { ...base, maxPosiciones: 8, maxPorDireccion: 2 });
  assert.equal(r.aceptadas, 4, "2 largos y 2 cortos caben de sobra");
});

test("una posicion que cierra libera hueco TAMBIEN en su direccion", () => {
  const ops: Operacion[] = [
    { ...op("A", 1, 2, 1), direccion: "LARGO" },
    { ...op("B", 3, 4, 1), direccion: "LARGO" },
  ];
  const r = simularCartera(ops, { ...base, maxPosiciones: 8, maxPorDireccion: 1 });
  assert.equal(r.aceptadas, 2);
  assert.equal(r.rechazadas, 0);
});

test("sin direccion en las operaciones, el tope por direccion no hace nada", () => {
  const ops = Array.from({ length: 5 }, (_, k) => op(`E${k}`, 1, 5, 1));
  const r = simularCartera(ops, { ...base, maxPosiciones: 8, maxPorDireccion: 1 });
  assert.equal(r.aceptadas, 5, "no puede filtrar lo que no sabe");
});

test("SIN objetivoVol el tamaño es fijo: nada cambia", () => {
  const ops = Array.from({ length: 60 }, (_, k) => op(`E${k}`, k * 2 + 1, k * 2 + 2, 1));
  const a = simularCartera(ops, { ...base, compuesto: true });
  const b = simularCartera(ops, { ...base, compuesto: true, objetivoVol: 0 });
  assert.equal(a.capitalFinal, b.capitalFinal);
});

test("EL OBJETIVO DE VOLATILIDAD ENCOGE el tamaño cuando la volatilidad sube", () => {
  // 40 operaciones tranquilas (+-0,1R) y luego 40 violentas (+-3R). Con objetivo de volatilidad
  // las violentas deben entrar con tamaño mucho menor.
  const ops: Operacion[] = [];
  for (let k = 0; k < 40; k += 1) ops.push(op(`T${k}`, k * 2 + 1, k * 2 + 2, k % 2 ? 0.1 : -0.1));
  for (let k = 0; k < 40; k += 1) ops.push(op(`V${k}`, 100 + k * 2, 101 + k * 2, k % 2 ? 3 : -3));

  const fijo = simularCartera(ops, { ...base, compuesto: true });
  const objetivo = simularCartera(ops, {
    ...base, compuesto: true, objetivoVol: 0.1, ventanaVol: 30, maxEscala: 3,
  });
  // Las violentas se alternan +3/-3: con tamaño fijo el capital sufre mucho mas.
  assert.ok(
    objetivo.maxCaida < fijo.maxCaida,
    `con objetivo de volatilidad la caida deberia ser menor: ${objetivo.maxCaida} vs ${fijo.maxCaida}`,
  );
});

test("EL TOPE DE ESCALA impide que un tramo tranquilo dispare el tamaño", () => {
  // Todas las operaciones casi iguales: la volatilidad reciente es minuscula y sin tope el
  // multiplicador se iria al infinito.
  const ops = Array.from({ length: 80 }, (_, k) =>
    op(`E${k}`, k * 2 + 1, k * 2 + 2, k % 2 ? 0.001 : -0.001));

  const conTope = simularCartera(ops, {
    ...base, compuesto: true, objetivoVol: 1, ventanaVol: 30, maxEscala: 2,
  });
  const sinTope = simularCartera(ops, {
    ...base, compuesto: true, objetivoVol: 1, ventanaVol: 30, maxEscala: 1000,
  });
  assert.ok(Number.isFinite(conTope.capitalFinal));
  assert.ok(
    Math.abs(conTope.capitalFinal - 10_000) < Math.abs(sinTope.capitalFinal - 10_000),
    "el tope tiene que limitar el efecto del multiplicador",
  );
});

test("EL ESCALADO SOLO MIRA HACIA ATRAS: sin historial el multiplicador es 1", () => {
  // Con pocas operaciones cerradas no hay volatilidad medible, asi que debe comportarse igual
  // que el tamaño fijo. Si mirase el futuro, esto daria distinto.
  const ops = [op("A", 1, 2, 1), op("B", 3, 4, 1), op("C", 5, 6, 1)];
  const fijo = simularCartera(ops, { ...base, compuesto: true });
  const objetivo = simularCartera(ops, { ...base, compuesto: true, objetivoVol: 0.5 });
  assert.ok(Math.abs(fijo.capitalFinal - objetivo.capitalFinal) < 1e-9);
});

test("LA EXPOSICION SE CALCULA: riesgo dividido por la distancia al stop", () => {
  // Riesgo 1% de 10.000 = 100. Con el stop al 10% del precio, la posicion mueve 1.000.
  const ops: Operacion[] = [{ ...op("A", 1, 5, 1), stopFraccion: 0.10 }];
  const r = simularCartera(ops, base);
  assert.ok(Math.abs(r.maxExposicion - 0.10) < 1e-9, `exposicion ${r.maxExposicion}`);
});

test("UN STOP ESTRECHO DISPARA LA EXPOSICION: es la trampa de las temporalidades bajas", () => {
  // Stop del 0,5% (tipico de 1 hora en un ETF): arriesgar el 1% exige mover el 200% del capital.
  const ops: Operacion[] = [{ ...op("A", 1, 5, 1), stopFraccion: 0.005 }];
  const r = simularCartera(ops, base);
  assert.ok(Math.abs(r.maxExposicion - 2) < 1e-9, `una sola posicion ya mueve ${r.maxExposicion}x`);
});

test("OCHO POSICIONES CON STOP ESTRECHO son 16 veces el capital", () => {
  const ops: Operacion[] = Array.from({ length: 8 }, (_, k) => ({
    ...op(`E${k}`, 1, 5, 1), stopFraccion: 0.005,
  }));
  const r = simularCartera(ops, { ...base, maxPosiciones: 8 });
  assert.equal(r.aceptadas, 8);
  assert.ok(r.maxExposicion > 15, `exposicion ${r.maxExposicion}x: ninguna cuenta lo permite`);
});

test("EL TOPE DE EXPOSICION rechaza lo que no cabe en la cuenta", () => {
  const ops: Operacion[] = Array.from({ length: 8 }, (_, k) => ({
    ...op(`E${k}`, 1, 5, 1), stopFraccion: 0.005,
  }));
  const r = simularCartera(ops, { ...base, maxPosiciones: 8, maxExposicion: 1 });
  // Cada posicion mueve 2x el capital, asi que con tope 1x no entra ninguna.
  assert.equal(r.aceptadas, 0);
  assert.equal(r.rechazadasPorExposicion, 8);
});

test("con stops anchos el tope de exposicion no estorba", () => {
  // Stop del 10%: cada posicion mueve el 10% del capital, ocho caben de sobra en 1x.
  const ops: Operacion[] = Array.from({ length: 8 }, (_, k) => ({
    ...op(`E${k}`, 1, 5, 1), stopFraccion: 0.10,
  }));
  const r = simularCartera(ops, { ...base, maxPosiciones: 8, maxExposicion: 1 });
  assert.equal(r.aceptadas, 8);
  assert.equal(r.rechazadasPorExposicion, 0);
  assert.ok(Math.abs(r.maxExposicion - 0.8) < 1e-9);
});

test("una posicion que cierra libera EXPOSICION para la siguiente", () => {
  const ops: Operacion[] = [
    { ...op("A", 1, 2, 1), stopFraccion: 0.5 },
    { ...op("B", 3, 4, 1), stopFraccion: 0.5 },
  ];
  const r = simularCartera(ops, { ...base, maxExposicion: 0.03 });
  assert.equal(r.aceptadas, 2, "no se solapan, asi que las dos caben");
});

test("SIN stopFraccion el tope de exposicion no puede actuar", () => {
  const ops = Array.from({ length: 5 }, (_, k) => op(`E${k}`, 1, 5, 1));
  const r = simularCartera(ops, { ...base, maxExposicion: 0.01 });
  assert.equal(r.aceptadas, 5, "no puede limitar lo que no sabe");
  assert.equal(r.maxExposicion, 0);
});
