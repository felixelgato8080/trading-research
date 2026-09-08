import { test } from "node:test";
import assert from "node:assert/strict";
import type { VelaFlujo } from "../src/forex/binance";
import {
  delta, deltaRelativo, cvd, tamañoMedio, absorcion, divergencia,
  perfil, poc, nodoBajo,
} from "../src/forex/flujo";

const H = 3600;
/** `compra` es el volumen que entro comprando a mercado, de un total `vol`. */
function v(
  i: number, o: number, h: number, l: number, c: number,
  vol = 100, compra = 50, ops = 10,
): VelaFlujo {
  return { t: i * H, o, h, l, c, v: vol, compraAgresiva: compra, operaciones: ops };
}

test("EL DELTA ES COMPRA AGRESIVA MENOS VENTA AGRESIVA", () => {
  // 100 de volumen con 80 de compra: 80 compran, 20 venden, delta +60.
  assert.equal(delta(v(0, 1, 1, 1, 1, 100, 80)), 60);
  assert.equal(delta(v(0, 1, 1, 1, 1, 100, 20)), -60);
  assert.equal(delta(v(0, 1, 1, 1, 1, 100, 50)), 0, "mitad y mitad es equilibrio");
});

test("sin volumen el delta es null, no cero", () => {
  const sinVol: VelaFlujo = { t: 0, o: 1, h: 1, l: 1, c: 1, compraAgresiva: 0, operaciones: 0 };
  assert.equal(delta(sinVol), null, "null es 'no se sabe'; cero seria 'estaba equilibrado'");
  assert.equal(deltaRelativo(sinVol), null);
});

test("el delta relativo va de -1 a +1", () => {
  assert.equal(deltaRelativo(v(0, 1, 1, 1, 1, 100, 100)), 1);
  assert.equal(deltaRelativo(v(0, 1, 1, 1, 1, 100, 0)), -1);
});

test("EL CVD ACUMULA el delta vela a vela", () => {
  const serie = [
    v(0, 1, 1, 1, 1, 100, 80),   // +60
    v(1, 1, 1, 1, 1, 100, 80),   // +60 -> 120
    v(2, 1, 1, 1, 1, 100, 20),   // -60 -> 60
  ];
  assert.deepEqual(cvd(serie), [60, 120, 60]);
});

test("el tamaño medio de operacion es volumen entre numero de operaciones", () => {
  assert.equal(tamañoMedio(v(0, 1, 1, 1, 1, 1000, 500, 10)), 100);
  assert.equal(tamañoMedio(v(0, 1, 1, 1, 1, 1000, 500, 0)), null);
});

/** Base tranquila: delta pequeño y alternante, para que la media del |delta| sea baja. */
function base(n: number): VelaFlujo[] {
  return Array.from({ length: n }, (_, i) =>
    v(i, 100, 101, 99, 100, 100, i % 2 ? 52 : 48));
}

test("ABSORCION: mucho delta y poco recorrido de precio", () => {
  // Vela con delta -60 (media del |delta| de la base es 4) y precio que no se mueve.
  const velas = [...base(30), v(30, 100, 101, 99, 100, 100, 20)];
  const atr = velas.map(() => 2);
  const a = absorcion(velas, atr, 20, 3, 0.3);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.i, 30);
  assert.equal(a[0]!.direccion, "LARGO", "vendedores absorbidos -> se espera subida");
});

test("MUCHO DELTA CON MUCHO RECORRIDO NO ES ABSORCION: es continuacion", () => {
  // Mismo delta pero el precio si se movio: nadie lo absorbio.
  const velas = [...base(30), v(30, 100, 101, 90, 91, 100, 20)];
  const atr = velas.map(() => 2);
  assert.equal(absorcion(velas, atr, 20, 3, 0.3).length, 0);
});

test("POCO DELTA no dispara absorcion aunque el precio no se mueva", () => {
  const velas = [...base(30), v(30, 100, 101, 99, 100, 100, 51)];
  const atr = velas.map(() => 2);
  assert.equal(absorcion(velas, atr, 20, 3, 0.3).length, 0);
});

test("compradores absorbidos dan señal CORTO", () => {
  const velas = [...base(30), v(30, 100, 101, 99, 100, 100, 80)];
  const atr = velas.map(() => 2);
  assert.equal(absorcion(velas, atr, 20, 3, 0.3)[0]!.direccion, "CORTO");
});

test("LA DIVERGENCIA ES POSITIVA cuando el precio sube y el CVD no acompaña", () => {
  // Precio subiendo, delta cayendo: compra sin fuerza detras.
  const velas: VelaFlujo[] = [];
  for (let i = 0; i < 10; i += 1) velas.push(v(i, 100 + i, 101 + i, 99 + i, 100 + i, 100, 30));
  const d = divergencia(velas, cvd(velas), 5);
  assert.ok(d[9] != null && d[9]! > 0, `esperaba divergencia positiva, fue ${d[9]}`);
});

test("sin divergencia el valor ronda cero", () => {
  // Precio y CVD subiendo juntos.
  const velas: VelaFlujo[] = [];
  for (let i = 0; i < 10; i += 1) velas.push(v(i, 100 + i, 101 + i, 99 + i, 100 + i, 100, 80));
  const d = divergencia(velas, cvd(velas), 5);
  assert.ok(d[9] != null && Math.abs(d[9]!) < 0.3, `esperaba cerca de cero, fue ${d[9]}`);
});

test("EL PERFIL REPARTE EL VOLUMEN entre los niveles que toca la vela", () => {
  const velas = [v(0, 100, 110, 100, 105, 300)];
  const p = perfil(velas, 0, 0, 10);
  const total = p.reduce((s, x) => s + x.volumen, 0);
  assert.ok(Math.abs(total - 300) < 1e-9, "no se puede crear ni perder volumen");
});

test("EL POC ES EL NIVEL MAS NEGOCIADO", () => {
  // Muchas velas estrechas en 100 y una ancha: el POC tiene que estar en 100.
  const velas: VelaFlujo[] = [];
  for (let i = 0; i < 20; i += 1) velas.push(v(i, 100, 100.5, 99.5, 100, 1000));
  velas.push(v(20, 100, 150, 50, 100, 100));
  const p = perfil(velas, 0, velas.length - 1, 40);
  const punto = poc(p);
  assert.ok(punto != null && Math.abs(punto - 100) < 5, `el POC salio en ${punto}`);
});

test("EL NODO BAJO NO PUEDE SER UN BORDE del perfil", () => {
  // Los bordes tienen poco volumen por construccion; cogerlos no significaria nada.
  const velas: VelaFlujo[] = [];
  for (let i = 0; i < 20; i += 1) velas.push(v(i, 100, 100.5, 99.5, 100, 1000));
  velas.push(v(20, 100, 150, 50, 100, 100));
  const p = perfil(velas, 0, velas.length - 1, 40);
  const nodo = nodoBajo(p, 0.2);
  assert.ok(nodo != null);
  assert.ok(nodo! > p[0]!.precio && nodo! < p[p.length - 1]!.precio, "no puede ser un extremo");
});

test("con un perfil vacio no se inventa nada", () => {
  assert.deepEqual(perfil([], 0, 0), []);
  assert.equal(poc([]), null);
  assert.equal(nodoBajo([]), null);
});
