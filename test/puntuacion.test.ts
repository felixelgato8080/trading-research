import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import { factores, puntuar, PESOS, AJUSTES, type Factores } from "../src/forex/puntuacion";
import type { Divergencia } from "../src/forex/divergencia";

const H = 3600;
const v = (i: number, o: number, h: number, l: number, c: number): Vela =>
  ({ t: i * H, o, h, l, c });
const atrPlano = (n: number) => Array.from({ length: n }, () => 5);

/** Divergencia bajista de juguete: pico1 en 2, pico2 en 7, confirmada en 9. */
const div = (extra: Partial<Divergencia> = {}): Divergencia => ({
  i: 9, direccion: "BAJISTA", pico1: 2, pico2: 7, extremo: 115,
  objetivoLiquidez: 100, rsi1: 78, rsi2: 62, ...extra,
});

const nada: Factores = {
  barrido: false, divergenciaLimpia: false, cambioEstructura: false,
  rechazo: false, zonaMayor: false, sesion: false, rrAlto: false,
};

// ---------------------------------------------------------------------------------------
// PUNTUAR
// ---------------------------------------------------------------------------------------

test("sin ningun factor, cero puntos", () => {
  assert.equal(puntuar(nada), 0);
});

test("con todos los factores, diez puntos", () => {
  const todo = Object.fromEntries(Object.keys(nada).map((k) => [k, true])) as Factores;
  assert.equal(puntuar(todo), 10);
  assert.equal(
    Object.values(PESOS).reduce((a, b) => a + b, 0), 10,
    "los pesos tienen que sumar diez o la escala no es la que se dice",
  );
});

test("cada factor suma exactamente su peso", () => {
  for (const k of Object.keys(PESOS) as Array<keyof typeof PESOS>) {
    assert.equal(puntuar({ ...nada, [k]: true }), PESOS[k], `el peso de ${k}`);
  }
});

// ---------------------------------------------------------------------------------------
// LOS FACTORES, uno a uno
// ---------------------------------------------------------------------------------------

/** Serie base: sube a 110 en la vela 2, y a 115 en la 7. */
function base(): Vela[] {
  return [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 99, 101), v(2, 101, 110, 100, 109),
    v(3, 109, 106, 104, 105), v(4, 105, 106, 100, 101), v(5, 101, 104, 100, 103),
    v(6, 103, 108, 102, 107), v(7, 107, 115, 106, 114), v(8, 114, 112, 108, 109),
    v(9, 109, 110, 105, 106),
  ];
}

test("DIVERGENCIA LIMPIA: el segundo pico del RSI no llego al canal", () => {
  const b = base();
  const a = atrPlano(b.length);
  assert.ok(factores(b, a, div({ rsi2: 62 }), 2, 0).divergenciaLimpia);
  assert.ok(!factores(b, a, div({ rsi2: 74 }), 2, 0).divergenciaLimpia, "74 sigue dentro");
});

test("R:R ALTO es tres o mas, no una preferencia", () => {
  const b = base();
  const a = atrPlano(b.length);
  assert.ok(!factores(b, a, div(), 2.9, 0).rrAlto);
  assert.ok(factores(b, a, div(), 3, 0).rrAlto);
});

test("SESION: solo cuenta la hora de la ENTRADA, en UTC", () => {
  const b = base();
  const a = atrPlano(b.length);
  const aHora = (h: number) => Date.UTC(2026, 0, 5, h) / 1000;
  assert.ok(!factores(b, a, div(), 2, aHora(3)).sesion, "madrugada no");
  assert.ok(factores(b, a, div(), 2, aHora(10)).sesion, "Londres si");
  assert.ok(factores(b, a, div(), 2, aHora(15)).sesion, "Nueva York si");
  assert.ok(!factores(b, a, div(), 2, aHora(20)).sesion, "despues no");
});

test("RECHAZO: mecha larga por encima del cuerpo en un maximo", () => {
  const conMecha = base();
  conMecha[7] = v(7, 107, 115, 106, 108);   // cuerpo pequeño, mecha superior larga
  assert.ok(factores(conMecha, atrPlano(10), div(), 2, 0).rechazo);

  const sinMecha = base();
  sinMecha[7] = v(7, 107, 115, 106, 114.5); // cierra pegado al maximo
  assert.ok(!factores(sinMecha, atrPlano(10), div(), 2, 0).rechazo);
});

test("BARRIDO: hacen falta extremos previos APILADOS en el nivel del primer pico", () => {
  // Sin nada apilado en 110, no hay bolsa que barrer.
  assert.ok(!factores(base(), atrPlano(10), div(), 2, 0).barrido);

  // Con dos maximos previos confirmados en 110, si.
  const conBolsa = [
    v(0, 100, 101, 99, 100), v(1, 100, 105, 99, 104), v(2, 104, 110, 103, 105),
    v(3, 105, 106, 100, 101), v(4, 101, 104, 100, 103), v(5, 103, 110, 102, 104),
    v(6, 104, 106, 100, 101), v(7, 101, 104, 100, 103), v(8, 103, 105, 101, 104),
    v(9, 104, 115, 103, 114), v(10, 114, 112, 108, 109), v(11, 109, 110, 105, 106),
  ];
  const f = factores(conBolsa, atrPlano(12), div({ pico1: 2, pico2: 9, i: 11 }), 2, 0);
  assert.ok(f.barrido, "dos maximos en 110 antes de superarlos");
});

test("EL BARRIDO SOLO MIRA HACIA ATRAS", () => {
  // Los maximos en 110 aparecen DESPUES del pico2: no estaban ahi para barrerse.
  const despues = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 99, 101), v(2, 101, 110, 100, 109),
    v(3, 109, 106, 104, 105), v(4, 105, 106, 100, 101), v(5, 101, 104, 100, 103),
    v(6, 103, 108, 102, 107), v(7, 107, 115, 106, 114),
    v(8, 114, 110, 108, 109), v(9, 109, 110, 105, 106), v(10, 106, 110, 104, 105),
  ];
  assert.ok(!factores(despues, atrPlano(11), div(), 2, 0).barrido);
});

/** Como `base` pero con un minimo CONFIRMADO en 95 (vela 4), para poder romperlo. */
function conMinimo(ultima: Vela): Vela[] {
  return [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 101, 110, 100, 109),
    v(3, 109, 109, 104, 105), v(4, 105, 106, 95, 96), v(5, 96, 104, 100, 103),
    v(6, 103, 108, 102, 107), v(7, 107, 115, 106, 114), ultima,
    v(9, 109, 110, 105, 106),
  ];
}

test("CAMBIO DE ESTRUCTURA: el precio cierra bajo el ultimo minimo confirmado", () => {
  const rompe = conMinimo(v(8, 114, 115, 89, 90));   // cierra en 90, bajo el minimo de 95
  assert.ok(factores(rompe, atrPlano(10), div(), 2, 0).cambioEstructura);

  const noRompe = conMinimo(v(8, 114, 112, 108, 109));
  assert.ok(!factores(noRompe, atrPlano(10), div(), 2, 0).cambioEstructura);
});

test("EL CAMBIO DE ESTRUCTURA SE MIRA HASTA LA CONFIRMACION, no despues", () => {
  const tarde = [...conMinimo(v(8, 114, 112, 108, 109)), v(10, 106, 107, 80, 81)];
  assert.ok(
    !factores(tarde, atrPlano(11), div(), 2, 0).cambioEstructura,
    "lo que pasa despues de decidir no es un filtro, es una explicacion",
  );
});

test("ZONA MAYOR: el pico cae sobre un extremo importante y ANTIGUO", () => {
  // Maximo en 115 en la vela 3 —ya confirmado y lejos— y el pico2 vuelve exactamente ahi.
  const conZona = [
    v(0, 100, 101, 99, 100), v(1, 101, 103, 100, 102), v(2, 102, 104, 99, 100),
    v(3, 100, 115, 98, 99), v(4, 99, 100, 97, 98), v(5, 98, 102, 97, 101),
    v(6, 101, 108, 100, 107), v(7, 107, 115, 106, 114), v(8, 114, 112, 108, 109),
    v(9, 109, 110, 105, 106),
  ];
  assert.ok(factores(conZona, atrPlano(10), div({ pico1: 6 }), 2, 0).zonaMayor);
  assert.ok(!factores(base(), atrPlano(10), div(), 2, 0).zonaMayor, "110 no esta cerca de 115");
});

test("UN EXTREMO DE LAS PRIMERAS VELAS no puede contar como zona", () => {
  // No hay vecinos suficientes a su izquierda para confirmarlo. Es correcto que no cuente.
  const alPrincipio = [
    v(0, 100, 101, 99, 100), v(1, 101, 115, 100, 102), v(2, 102, 103, 99, 100),
    v(3, 100, 101, 98, 99), v(4, 99, 100, 97, 98), v(5, 98, 102, 97, 101),
    v(6, 101, 108, 100, 107), v(7, 107, 115, 106, 114), v(8, 114, 112, 108, 109),
    v(9, 109, 110, 105, 106),
  ];
  assert.ok(!factores(alPrincipio, atrPlano(10), div({ pico1: 6 }), 2, 0).zonaMayor);
});

test("los factores de una divergencia NO cambian al añadir velas futuras", () => {
  const b = base();
  const conFuturo = [...b, v(10, 106, 200, 50, 199), v(11, 199, 250, 190, 240)];
  const a = factores(b, atrPlano(b.length), div(), 2, 0);
  const c = factores(conFuturo, atrPlano(conFuturo.length), div(), 2, 0);
  assert.deepEqual(a, c, "un factor que cambia con el futuro no es un filtro");
});

test("los pesos se pueden cambiar sin tocar los factores", () => {
  const soloBarrido = { ...nada, barrido: true };
  assert.equal(puntuar(soloBarrido, { ...PESOS, barrido: 5 }), 5);
});

test("AJUSTES trae la sesion de Londres a Nueva York", () => {
  assert.equal(AJUSTES.desdeHora, 7);
  assert.equal(AJUSTES.hastaHora, 16);
});
