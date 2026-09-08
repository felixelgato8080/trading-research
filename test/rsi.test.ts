import { test } from "node:test";
import assert from "node:assert/strict";
import { rsi, señales, REGLAS_RSI } from "../src/forex/rsi";

// Serie de referencia de Wilder (la del libro "New Concepts in Technical Trading Systems").
// Se usa para comprobar contra un valor conocido, no contra mi propia implementacion.
const WILDER = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
];

test("EL RSI CUADRA CON EL VALOR DE REFERENCIA DE WILDER", () => {
  // Si esto falla, todo el backtest mide otra cosa. El valor esperado (~70,5 en la vela 14)
  // es el publicado, no uno que haya sacado yo de mi propio codigo.
  const v = rsi(WILDER, 14);
  assert.ok(v[14] !== null);
  assert.ok(Math.abs(v[14]! - 70.53) < 0.15, `dio ${v[14]?.toFixed(2)}, se esperaba ~70.53`);
});

test("USA SUAVIZADO DE WILDER, NO MEDIA SIMPLE", () => {
  // Es el error mas comun al implementarlo. Con media simple los numeros se parecen pero las
  // señales caen en velas distintas, y el backtest deja de corresponder a lo que se veia en
  // la plataforma. Se comprueba en una vela POSTERIOR a la primera, que es donde divergen.
  const v = rsi(WILDER, 14);
  // Media simple sobre las ultimas 14 variaciones daria otro numero en la vela 19.
  const cambios = WILDER.slice(6).map((c, i) => c - WILDER.slice(5)[i]!);
  const g = cambios.filter((c) => c > 0).reduce((s, c) => s + c, 0) / 14;
  const p = -cambios.filter((c) => c < 0).reduce((s, c) => s + c, 0) / 14;
  const simple = 100 - 100 / (1 + g / p);
  assert.ok(Math.abs(v[19]! - simple) > 0.5, "Wilder y media simple deben diferir");
});

test("las primeras velas son null, no 50", () => {
  // Rellenarlas con 50 —lo que hacen muchas librerias— mete señales falsas al principio.
  const v = rsi(WILDER, 14);
  assert.equal(v.slice(0, 14).every((x) => x === null), true);
  assert.ok(v[14] !== null);
});

test("una serie mas corta que el periodo no produce nada", () => {
  assert.deepEqual(rsi([1, 2, 3], 14), [null, null, null]);
});

test("una serie que solo sube da RSI 100", () => {
  const sube = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(sube, 14)[20], 100);
});

test("una serie plana da 50, no NaN", () => {
  const plana = new Array(30).fill(100);
  assert.equal(rsi(plana, 14)[20], 50);
});

// ---------- señales ----------

/** Serie que baja hasta sobreventa y luego rebota. */
function bajaYRebota(): number[] {
  const s: number[] = [];
  for (let i = 0; i < 25; i += 1) s.push(100 - i * 2);
  for (let i = 0; i < 12; i += 1) s.push(s[s.length - 1]! + 3);
  return s;
}

test("el cruce de vuelta desde sobreventa da señal de largo", () => {
  const ss = señales(bajaYRebota(), REGLAS_RSI);
  assert.ok(ss.length > 0, "deberia haber alguna señal");
  assert.equal(ss[0]?.direccion, "LARGO");
});

test("ESPERAR EL CRUCE NO ES LO MISMO QUE ENTRAR MIENTRAS ESTA PASADO", () => {
  // En una tendencia fuerte el RSI se queda bajo 30 durante semanas. "Mientras este" compra
  // toda la caida; "al cruzar" espera a que gire. Da estrategias muy distintas y hay que
  // poder probar las dos.
  const serie = bajaYRebota();
  const alCruzar = señales(serie, { ...REGLAS_RSI, esperarCruce: true });
  const mientras = señales(serie, { ...REGLAS_RSI, esperarCruce: false });
  assert.ok(mientras.length > alCruzar.length, `cruce ${alCruzar.length} vs mientras ${mientras.length}`);
});

test("se pueden aislar los largos de los cortos", () => {
  const serie = [...bajaYRebota(), ...Array.from({ length: 20 }, (_, i) => 200 + i * 5)];
  const soloL = señales(serie, { ...REGLAS_RSI, esperarCruce: false, soloLargos: true });
  const soloC = señales(serie, { ...REGLAS_RSI, esperarCruce: false, soloCortos: true });
  assert.ok(soloL.every((s) => s.direccion === "LARGO"));
  assert.ok(soloC.every((s) => s.direccion === "CORTO"));
});

test("la señal se marca en la vela de su RSI, no en la siguiente", () => {
  // Quien la ejecute debe entrar en i+1. Si la señal ya viniera desplazada, el backtest
  // entraria con dos velas de retraso sin que nadie se diera cuenta.
  const serie = bajaYRebota();
  const ss = señales(serie, REGLAS_RSI);
  const v = rsi(serie, REGLAS_RSI.periodo);
  for (const s of ss) {
    assert.ok(Math.abs(v[s.i]! - s.rsi) < 1e-9, "el rsi de la señal es el de SU vela");
  }
});
