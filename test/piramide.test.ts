import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import { simular, type AjustesPiramide } from "../src/forex/piramide";
import type { SeñalRuptura } from "../src/forex/rupturas";

const H = 3600;
const v = (i: number, o: number, h: number, l: number, c: number): Vela =>
  ({ t: i * H, o, h, l, c });

const AJ: AjustesPiramide = {
  stopAtr: 2, trailing: 0, maxUnidades: 3, minBeneficioR: 1,
  moverABreakeven: false, costeFraccion: 0,
};
const atrPlano = (n: number) => Array.from({ length: n }, () => 5);
const señal = (i: number): SeñalRuptura => ({ i, direccion: "LARGO", nivel: 0 });

// ---------------------------------------------------------------------------------------
// LO QUE SEPARA ESTO DE LA MARTINGALA
// ---------------------------------------------------------------------------------------

test("NO SE AÑADE UNIDAD SI LA ANTERIOR NO VA EN BENEFICIO", () => {
  // Entra en 100 con stop en 90 (riesgo 10). La segunda señal llega con el precio en 95:
  // va PERDIENDO, asi que no se añade. Esa es la regla que impide la martingala.
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 95, 96, 94, 95),
    v(3, 95, 96, 89, 90),
  ];
  const r = simular(velas, [señal(0), señal(1)], atrPlano(4), "LARGO", AJ);
  assert.equal(r.maxSimultaneas, 1, "solo la original");
  assert.equal(r.unidades.length, 1);
});

test("SI VA EN BENEFICIO SUFICIENTE, se añade", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 115, 116, 114, 115),
    v(3, 115, 130, 114, 129), v(4, 129, 130, 100, 101),
  ];
  const r = simular(velas, [señal(0), señal(1)], atrPlano(5), "LARGO", AJ);
  assert.equal(r.maxSimultaneas, 2, "la segunda entra a 115, con la primera a +1,5R");
});

test("EL BENEFICIO SE MIDE EN R, no en precio", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 105, 106, 104, 105),
    v(3, 105, 130, 104, 129),
  ];
  // +5 de precio con riesgo 10 son 0,5R: no llega al minimo de 1R.
  assert.equal(simular(velas, [señal(0), señal(1)], atrPlano(4), "LARGO", AJ).maxSimultaneas, 1);
  const flojo = { ...AJ, minBeneficioR: 0.5 };
  assert.equal(simular(velas, [señal(0), señal(1)], atrPlano(4), "LARGO", flojo).maxSimultaneas, 2);
});

test("EL TOPE DE UNIDADES se respeta", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 120, 121, 119, 120),
    v(3, 140, 141, 139, 140), v(4, 160, 161, 159, 160), v(5, 180, 181, 179, 180),
    v(6, 180, 181, 100, 101),
  ];
  const señales = [señal(0), señal(1), señal(2), señal(3), señal(4)];
  const dos = simular(velas, señales, atrPlano(7), "LARGO", { ...AJ, maxUnidades: 2 });
  assert.equal(dos.maxSimultaneas, 2);
  const cinco = simular(velas, señales, atrPlano(7), "LARGO", { ...AJ, maxUnidades: 5 });
  assert.ok(cinco.maxSimultaneas > 2, `con tope 5 caben mas, hubo ${cinco.maxSimultaneas}`);
});

// ---------------------------------------------------------------------------------------
// CADA UNIDAD CON SU PROPIO STOP
// ---------------------------------------------------------------------------------------

test("cada unidad lleva su stop, calculado desde SU entrada", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 120, 121, 119, 120),
    v(3, 120, 121, 80, 81),
  ];
  const r = simular(velas, [señal(0), señal(1)], atrPlano(4), "LARGO", AJ);
  assert.equal(r.unidades.length, 2);
  const [a, b] = [...r.unidades].sort((x, y) => x.orden - y.orden);
  assert.equal(a!.stopInicial, 90, "la primera entro en 100");
  assert.equal(b!.stopInicial, 110, "la segunda en 120");
});

test("MOVER A BREAKEVEN cambia el resultado de las unidades anteriores", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 120, 121, 119, 120),
    v(3, 120, 121, 80, 81),
  ];
  const sin = simular(velas, [señal(0), señal(1)], atrPlano(4), "LARGO", AJ);
  const con = simular(
    velas, [señal(0), señal(1)], atrPlano(4), "LARGO", { ...AJ, moverABreakeven: true },
  );
  const primera = (r: typeof sin) => r.unidades.find((u) => u.orden === 1)!;
  assert.equal(primera(sin).r, -1, "sin mover, la primera pierde su R entero");
  assert.equal(primera(con).r, 0, "moviendo a la entrada, sale a cero");
});

// ---------------------------------------------------------------------------------------
// EL RIESGO QUE PIRAMIDAR CONCENTRA
// ---------------------------------------------------------------------------------------

test("PERDIDAS SIMULTANEAS: dos unidades muertas en la misma vela cuentan una vez", () => {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 120, 121, 119, 120),
    v(3, 120, 121, 60, 61),   // se lleva las dos por delante
  ];
  const r = simular(velas, [señal(0), señal(1)], atrPlano(4), "LARGO", AJ);
  assert.equal(r.perdidasSimultaneas, 1, "es el riesgo real de piramidar: caen juntas");
  assert.equal(r.unidades.filter((u) => u.r < 0).length, 2);
});

test("una sola unidad perdiendo NO es una perdida simultanea", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 101, 102, 85, 86)];
  const r = simular(velas, [señal(0)], atrPlano(3), "LARGO", AJ);
  assert.equal(r.perdidasSimultaneas, 0);
});

// ---------------------------------------------------------------------------------------
// CONVENCIONES DE SIEMPRE
// ---------------------------------------------------------------------------------------

test("SI LA VELA ABRE PASADA DEL STOP, se llena en la apertura", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 80, 82, 70, 75)];
  const r = simular(velas, [señal(0)], atrPlano(3), "LARGO", AJ);
  assert.equal(r.unidades[0]!.salida, 80, "a 90 no te llena nadie si abrio en 80");
  assert.ok(r.unidades[0]!.r < -1, "por eso se pierde mas de 1R");
});

test("lo que queda abierto al final se cierra al ultimo precio", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 101, 130, 100, 129)];
  const r = simular(velas, [señal(0)], atrPlano(3), "LARGO", AJ);
  assert.equal(r.unidades.length, 1);
  assert.equal(r.unidades[0]!.motivo, "FIN");
  assert.ok(r.unidades[0]!.r > 0, "quedarse solo con las cerradas dejaria fuera las buenas");
});

test("el coste resta en cada unidad", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 101, 102, 85, 86)];
  const sin = simular(velas, [señal(0)], atrPlano(3), "LARGO", AJ);
  const con = simular(velas, [señal(0)], atrPlano(3), "LARGO", { ...AJ, costeFraccion: 0.001 });
  assert.ok(con.unidades[0]!.r < sin.unidades[0]!.r);
});

test("una señal en direccion contraria se ignora en esta piramide", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 101), v(2, 101, 102, 85, 86)];
  const corta: SeñalRuptura = { i: 0, direccion: "CORTO", nivel: 0 };
  assert.equal(simular(velas, [corta], atrPlano(3), "LARGO", AJ).unidades.length, 0);
});
