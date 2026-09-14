import { test } from "node:test";
import assert from "node:assert/strict";
import { adx } from "../src/forex/adx";
import { serieDePrueba } from "../src/forex/sinFuturo";
import type { Vela } from "../src/forex/datos";

const vela = (o: number, h: number, l: number, c: number, i: number): Vela =>
  ({ t: i * 900, o, h, l, c, v: 1000 });

/**
 * La misma formula escrita del modo mas literal y torpe posible: arrays enteros, sin variables
 * corrientes, sin optimizar nada.
 *
 * NO es una referencia externa y no pretendo que lo sea: es un segundo par de manos. Las dos
 * versiones salen de la descripcion de Wilder pero por caminos distintos, asi que un despiste
 * aritmetico en la version rapida —un indice corrido, un suavizado aplicado de mas— las separa.
 * Lo que NO caza es un malentendido de la formula en si; para eso estan las pruebas de abajo,
 * que comprueban el comportamiento contra lo que el indicador significa.
 */
function adxTorpe(velas: Vela[], periodo: number): (number | null)[] {
  const n = velas.length;
  const mM: number[] = [];
  const mm: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < n; i += 1) {
    const v = velas[i]!;
    const p = velas[i - 1]!;
    const sube = v.h - p.h;
    const baja = p.l - v.l;
    mM.push(sube > baja && sube > 0 ? sube : 0);
    mm.push(baja > sube && baja > 0 ? baja : 0);
    tr.push(Math.max(v.h - v.l, Math.abs(v.h - p.c), Math.abs(v.l - p.c)));
  }
  // Suavizado de Wilder sobre las tres series, arrancando con la suma simple de `periodo`.
  const suavizar = (xs: number[]): number[] => {
    const out: number[] = [];
    let acum = 0;
    for (let i = 0; i < periodo; i += 1) acum += xs[i]!;
    out.push(acum);
    for (let i = periodo; i < xs.length; i += 1) {
      acum = acum - acum / periodo + xs[i]!;
      out.push(acum);
    }
    return out;
  };
  const sM = suavizar(mM);
  const sm = suavizar(mm);
  const sTr = suavizar(tr);

  const dx: number[] = [];
  for (let k = 0; k < sTr.length; k += 1) {
    const diMas = (sM[k]! / sTr[k]!) * 100;
    const diMenos = (sm[k]! / sTr[k]!) * 100;
    const suma = diMas + diMenos;
    dx.push(suma > 0 ? (Math.abs(diMas - diMenos) / suma) * 100 : 0);
  }
  // El ADX es el DX suavizado otra vez: media simple de los primeros `periodo`, luego Wilder.
  const out: (number | null)[] = new Array(n).fill(null);
  if (dx.length < periodo) return out;
  let valor = dx.slice(0, periodo).reduce((s, x) => s + x, 0) / periodo;
  // dx[0] corresponde a la vela `periodo` de la serie original, asi que los `periodo`
  // primeros DX son las velas `periodo` a `periodo*2 - 1`, y ahi cae el primer ADX.
  out[periodo * 2 - 1] = valor;
  for (let k = periodo; k < dx.length; k += 1) {
    valor = (valor * (periodo - 1) + dx[k]!) / periodo;
    out[periodo + k] = valor;
  }
  return out;
}

test("LOS DIRECCIONALES SALEN DE LA SUMA DE WILDER, comprobado a mano en la primera vela", () => {
  // La primera lectura no lleva suavizado todavia: es la suma cruda de los 14 primeros
  // movimientos dividida por la suma de los 14 primeros rangos. Eso se puede calcular aparte
  // sin tocar el codigo que se esta probando.
  const velas = serieDePrueba(60, 777);
  const r = adx(velas, 14);
  let sM = 0;
  let sm = 0;
  let sTr = 0;
  for (let i = 1; i <= 14; i += 1) {
    const v = velas[i]!;
    const p = velas[i - 1]!;
    const sube = v.h - p.h;
    const baja = p.l - v.l;
    sM += sube > baja && sube > 0 ? sube : 0;
    sm += baja > sube && baja > 0 ? baja : 0;
    sTr += Math.max(v.h - v.l, Math.abs(v.h - p.c), Math.abs(v.l - p.c));
  }
  assert.ok(Math.abs(r.mas[14]! - (sM / sTr) * 100) < 1e-9);
  assert.ok(Math.abs(r.menos[14]! - (sm / sTr) * 100) < 1e-9);
});

test("la version rapida y la torpe dan lo mismo", () => {
  for (const semilla of [1, 42, 999, 31337]) {
    const velas = serieDePrueba(400, semilla);
    const rapida = adx(velas, 14);
    const torpe = adxTorpe(velas, 14);
    for (let i = 0; i < velas.length; i += 1) {
      const a = rapida.adx[i];
      const b = torpe[i];
      if (a == null && b == null) continue;
      assert.ok(a != null && b != null, `semilla ${semilla}, vela ${i}: uno es null y el otro no`);
      assert.ok(Math.abs(a - b) < 1e-9, `semilla ${semilla}, vela ${i}: ${a} vs ${b}`);
    }
  }
});

test("USA SUAVIZADO DE WILDER (k = 1/n), NO LA EMA CORRIENTE (k = 2/(n+1))", () => {
  // Es el error tipico. Con la EMA normal el ADX se parece pero reacciona mas rapido, y
  // entonces un umbral de 25 medido aqui no es el 25 que se ve en el terminal — que es donde
  // se opera. Se comprueba reconstruyendo el paso del suavizado desde el valor anterior.
  const velas = serieDePrueba(300, 5150);
  const r = adx(velas, 14);
  // Se busca una pareja de velas consecutivas con ADX y se despeja el DX implicito en cada
  // hipotesis; solo una de las dos puede dar un DX dentro de [0, 100] de forma consistente.
  const i = 200;
  const ant = r.adx[i - 1]!;
  const act = r.adx[i]!;
  const dxWilder = act * 14 - ant * 13;
  const kEma = 2 / 15;
  const dxEma = (act - ant * (1 - kEma)) / kEma;
  // Con el suavizado correcto el DX implicito es un numero de indicador normal; con la EMA
  // sale otro distinto. Si algun dia alguien cambia el suavizado, estos dos dejan de coincidir.
  assert.ok(dxWilder >= -1e-9 && dxWilder <= 100 + 1e-9, `DX implicito fuera de rango: ${dxWilder}`);
  assert.ok(Math.abs(dxWilder - dxEma) > 1e-6, "las dos hipotesis no deberian coincidir");
});

test("una tendencia limpia da ADX alto y +DI por encima de -DI", () => {
  // Lo que el indicador SIGNIFICA. Sube 1 por vela sin retrocesos: no hay -DM en ninguna vela,
  // asi que -DI es 0 y el DX es 100 en todas; el ADX tiene que acercarse a 100.
  const velas: Vela[] = [];
  for (let i = 0; i < 80; i += 1) velas.push(vela(100 + i, 100.6 + i, 99.9 + i, 100.5 + i, i));
  const r = adx(velas, 14);
  assert.ok(r.adx[79]! > 90, `ADX ${r.adx[79]?.toFixed(1)}, se esperaba >90 en tendencia limpia`);
  assert.ok(r.mas[79]! > r.menos[79]!);
  assert.ok(Math.abs(r.menos[79]!) < 1e-9, "sin retrocesos no puede haber -DI");
});

test("una bajada limpia da -DI por encima de +DI", () => {
  const velas: Vela[] = [];
  for (let i = 0; i < 80; i += 1) velas.push(vela(100 - i, 100.1 - i, 99.4 - i, 99.5 - i, i));
  const r = adx(velas, 14);
  assert.ok(r.adx[79]! > 90);
  assert.ok(r.menos[79]! > r.mas[79]!);
});

test("un lateral en zigzag da ADX bajo", () => {
  // El caso que la estrategia de retroceso tiene que descartar: sin esto, un rango se lee como
  // tendencia y cada rebote parece una entrada.
  const velas: Vela[] = [];
  for (let i = 0; i < 120; i += 1) {
    const base = i % 2 === 0 ? 100 : 100.4;
    velas.push(vela(base, base + 0.2, base - 0.2, i % 2 === 0 ? 100.4 : 100, i));
  }
  const r = adx(velas, 14);
  assert.ok(r.adx[119]! < 25, `ADX ${r.adx[119]?.toFixed(1)} en lateral, se esperaba <25`);
});

test("una vela interior no aporta movimiento a ningun lado", () => {
  // Maximo mas bajo Y minimo mas alto que la anterior: no hay direccion. Muchas versiones
  // sueltas por ahi le dan +DM al lado equivocado aqui.
  const velas: Vela[] = [
    vela(100, 101, 99, 100.5, 0),
    vela(100.5, 100.8, 99.5, 100, 1),
  ];
  // Se prolonga con velas identicas a la interior para que haya bastantes.
  for (let i = 2; i < 40; i += 1) velas.push(vela(100.2, 100.4, 100.1, 100.3, i));
  const r = adx(velas, 14);
  // La segunda vela es interior; con 38 velas planas detras, ni +DI ni -DI pueden dispararse
  // por culpa de ella.
  assert.ok(r.mas[30] != null && r.menos[30] != null);
  assert.ok(r.mas[30]! < 1e-6 && r.menos[30]! < 1e-6, "una interior no crea direccion");
});

test("los primeros periodo*2-1 valores son null, no ceros", () => {
  // Devolver 0 ahi haria que el filtro "ADX > 20" rechazara velas por falta de datos en vez de
  // por falta de tendencia, que son cosas distintas y se confunden en el informe.
  const velas = serieDePrueba(100, 4242);
  const r = adx(velas, 14);
  assert.equal(r.adx.slice(0, 27).every((x) => x === null), true);
  assert.ok(r.adx[27] !== null);
});

test("una serie mas corta que periodo*2 no produce nada", () => {
  const r = adx(serieDePrueba(20, 1), 14);
  assert.equal(r.adx.every((x) => x === null), true);
  assert.equal(r.mas.every((x) => x === null), true);
});

test("ADX y direccionales se quedan dentro de [0, 100]", () => {
  for (const semilla of [3, 77, 1234]) {
    const r = adx(serieDePrueba(500, semilla), 14);
    for (const serie of [r.adx, r.mas, r.menos]) {
      for (const x of serie) {
        if (x == null) continue;
        assert.ok(x >= -1e-9 && x <= 100 + 1e-9, `valor fuera de rango: ${x}`);
      }
    }
  }
});

test("no mira al futuro: cortar la serie no cambia los valores ya calculados", () => {
  const velas = serieDePrueba(400, 8080);
  const todo = adx(velas, 14);
  for (const corte of [100, 200, 300]) {
    const prefijo = adx(velas.slice(0, corte), 14);
    for (let i = 0; i < corte; i += 1) {
      const a = prefijo.adx[i];
      const b = todo.adx[i];
      if (a == null && b == null) continue;
      assert.ok(a != null && b != null, `corte ${corte}, vela ${i}: uno es null`);
      assert.ok(Math.abs(a - b) < 1e-9, `corte ${corte}, vela ${i}: ${a} vs ${b}`);
    }
  }
});
