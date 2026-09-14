import { test } from "node:test";
import assert from "node:assert/strict";
import { señalesPullback, V1, V2, type AjustesPullback } from "../src/forex/pullback";
import { rsi } from "../src/forex/rsi";
import { atr } from "../src/forex/multiTf";
import type { Vela } from "../src/forex/datos";

/**
 * Velas de 5m con tendencia y retrocesos: una deriva, dos ondas encajadas y algo de ruido.
 *
 * Hace falta que la serie TENGA retrocesos de verdad. Con un camino aleatorio puro la estrategia
 * casi no dispara, y una prueba que no produce ninguna señal no prueba nada: pasaria igual si la
 * funcion devolviera siempre la lista vacia.
 */
function serie(n: number, semilla: number, deriva: number, amp = 0.12, periodo = 9): Vela[] {
  let s = semilla >>> 0;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out: Vela[] = [];
  let precio = 100;
  for (let i = 0; i < n; i += 1) {
    const onda = Math.sin(i / periodo) * amp + Math.sin(i / (periodo * 5)) * amp * 2.5;
    const o = precio;
    const c = Math.max(1, 100 + i * deriva + onda + (rnd() - 0.5) * amp);
    const mecha = rnd() * amp * 0.5;
    out.push({ t: i * 300, o, h: Math.max(o, c) + mecha, l: Math.min(o, c) - mecha, c, v: 1000 });
    precio = c;
  }
  return out;
}

/**
 * Agrupa velas de 5m en velas mayores. El grupo incompleto del final se descarta a proposito:
 * una vela en curso todavia no ha cerrado, y usarla es exactamente el look-ahead que se persigue.
 */
function agrupar(v: Vela[], k: number): Vela[] {
  const out: Vela[] = [];
  for (let i = 0; i + k <= v.length; i += k) {
    const g = v.slice(i, i + k);
    out.push({
      t: g[0]!.t, o: g[0]!.o,
      h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)),
      c: g[k - 1]!.c, v: 0,
    });
  }
  return out;
}

/** Las tres temporalidades, todas construidas desde las mismas velas de 5m. */
function marcos(m5: Vela[]): { m5: Vela[]; m15: Vela[]; h1: Vela[] } {
  return { m5, m15: agrupar(m5, 3), h1: agrupar(m5, 12) };
}

// Una subida con retrocesos: es donde la estrategia esta pensada para operar.
const SUBE = marcos(serie(5000, 424242, 0.002));
// Y una bajada, para comprobar que el lado corto no es una copia mal pegada del largo.
const BAJA = marcos(serie(5000, 424242, -0.002));

test("EN UNA SUBIDA SOLO ABRE LARGOS, Y EN UNA BAJADA SOLO CORTOS", () => {
  const arriba = señalesPullback(SUBE.m15, SUBE.m5, SUBE.h1, V1);
  const abajo = señalesPullback(BAJA.m15, BAJA.m5, BAJA.h1, V1);
  assert.ok(arriba.length > 5, `solo ${arriba.length} señales al alza; la prueba no probaria nada`);
  assert.ok(abajo.length > 5, `solo ${abajo.length} señales a la baja`);
  assert.equal(arriba.every((s) => s.direccion === "LARGO"), true);
  assert.equal(abajo.every((s) => s.direccion === "CORTO"), true);
});

test("NO MIRA AL FUTURO: cortar la serie no cambia ni borra una señal ya emitida", () => {
  // La prueba que caza cinco de los nueve fallos de medicion de este proyecto. Se corta por
  // multiplos de 12 para que las velas de 15m y de 1h caigan completas y la serie recortada sea
  // de verdad un prefijo de la entera, no otra serie distinta.
  for (const aj of [V1, V2]) {
    const todo = señalesPullback(SUBE.m15, SUBE.m5, SUBE.h1, aj);
    for (const corte of [1200, 2400, 3600, 4800]) {
      const p = marcos(SUBE.m5.slice(0, corte));
      const prefijo = señalesPullback(p.m15, p.m5, p.h1, aj);
      for (const s of prefijo) {
        const igual = todo.find((x) => x.i === s.i);
        assert.ok(igual, `${aj.version} corte ${corte}: la señal de la vela ${s.i} desaparece`);
        assert.deepEqual(igual, s, `${aj.version} corte ${corte}: la señal ${s.i} cambia`);
      }
    }
  }
});

test("el objetivo esta exactamente a 2R del riesgo, en los dos sentidos", () => {
  for (const { m5, m15, h1 } of [SUBE, BAJA]) {
    for (const s of señalesPullback(m15, m5, h1, V1)) {
      const riesgo = s.direccion === "LARGO" ? s.entrada - s.stop : s.stop - s.entrada;
      const premio = s.direccion === "LARGO" ? s.objetivo - s.entrada : s.entrada - s.objetivo;
      assert.ok(riesgo > 0, "el stop tiene que estar al otro lado de la entrada");
      assert.ok(Math.abs(premio / riesgo - 2) < 1e-9, `RR ${premio / riesgo}`);
    }
  }
});

test("EL STOP VA DETRAS DEL EXTREMO REAL, no a una distancia fija", () => {
  // Es lo que hace que el riesgo lo defina la estructura del precio. Si alguien lo cambiara por
  // "entrada menos X pips", esta prueba cae.
  const { m5, m15, h1 } = SUBE;
  const a = atr(m5, 14);
  const señales = señalesPullback(m15, m5, h1, V1);
  assert.ok(señales.length > 5);
  for (const s of señales) {
    let minimo = Infinity;
    for (let k = Math.max(0, s.i - V1.velasSwing); k <= s.i; k += 1) minimo = Math.min(minimo, m5[k]!.l);
    const esperado = minimo - a[s.i]! * V1.colchonAtr;
    assert.ok(Math.abs(s.stop - esperado) < 1e-9, `stop ${s.stop} vs ${esperado}`);
    assert.ok(s.stop < minimo, "el stop tiene que quedar POR DEBAJO del minimo, no encima");
  }
});

test("rechaza la operacion si el stop sale mas ancho que maxStopAtr", () => {
  // Sin este limite, un retroceso profundo genera una operacion cuyo riesgo no tiene nada que
  // ver con el de las demas, y la media en R deja de significar nada.
  const { m5, m15, h1 } = SUBE;
  const a = atr(m5, 14);
  for (const s of señalesPullback(m15, m5, h1, V1)) {
    const riesgo = s.entrada - s.stop;
    assert.ok(riesgo <= a[s.i]! * V1.maxStopAtr + 1e-9, `riesgo ${riesgo} > ${a[s.i]! * 1.8}`);
  }
  // Y apretando el limite salen menos señales, no las mismas.
  const apretado = señalesPullback(m15, m5, h1, { ...V1, maxStopAtr: 0.3 });
  const normal = señalesPullback(m15, m5, h1, V1);
  assert.ok(apretado.length < normal.length, "bajar maxStopAtr tiene que quitar señales");
});

test("LA MAQUINA DE ESTADOS EXIGE EL ORDEN: primero la zona, DESPUES el cruce", () => {
  // El corazon de la estrategia. Si se comprobara solo "RSI > 45" sin exigir que antes hubiera
  // bajado a la zona, entraria en cualquier vela de una tendencia sana.
  //
  // Se comprueba sobre la salida: toda señal tiene que tener, dentro de su ventana de vigencia y
  // ANTES de ella, al menos una vela con el RSI dentro de la zona de armado.
  const { m5, m15, h1 } = SUBE;
  const r = rsi(m5.map((v) => v.c), V1.periodoRsi);
  const señales = señalesPullback(m15, m5, h1, V1);
  assert.ok(señales.length > 5);
  for (const s of señales) {
    let armada = false;
    for (let k = Math.max(1, s.i - V1.vigencia); k < s.i; k += 1) {
      const x = r[k];
      if (x != null && x >= V1.zonaBaja && x <= V1.zonaAlta) { armada = true; break; }
    }
    assert.ok(armada, `la señal de la vela ${s.i} disparo sin que el RSI pasara por la zona antes`);
    // Y el cruce de verdad: la vela anterior por debajo del gatillo, esta por encima.
    assert.ok(r[s.i - 1]! <= V1.gatillo && r[s.i]! > V1.gatillo, `no hay cruce en la vela ${s.i}`);
  }
});

test("con vigencia 0 no puede disparar nunca", () => {
  // El armado de una vela caduca en la siguiente, y el disparo se comprueba en una vela
  // POSTERIOR al armado. Si esto diera señales, seria que arma y dispara en la misma vela.
  const { m5, m15, h1 } = SUBE;
  assert.equal(señalesPullback(m15, m5, h1, { ...V1, vigencia: 0 }).length, 0);
});

test("EN V1 LA VIGENCIA NO HACE NADA, y es por como estan puestos los numeros", () => {
  // `zonaAlta` y `gatillo` valen los dos 45, asi que la vela anterior al cruce esta siempre
  // dentro de la zona: arma y dispara en velas consecutivas, pase lo que pase.
  //
  // No es un fallo, es una consecuencia de la configuracion. Se fija aqui para que nadie
  // "afine" la vigencia en V1, no vea ningun cambio y saque la conclusion equivocada.
  const { m5, m15, h1 } = SUBE;
  const base = señalesPullback(m15, m5, h1, V1).length;
  assert.ok(base > 5);
  for (const vigencia of [1, 3, 6, 24, 48]) {
    assert.equal(señalesPullback(m15, m5, h1, { ...V1, vigencia }).length, base,
      `la vigencia ${vigencia} cambio el numero de señales; revisa si zonaAlta sigue igual a gatillo`);
  }
  // Y separando la zona del gatillo, la vigencia empieza a contar.
  const conHueco = { ...V1, zonaAlta: 42, gatillo: 48 };
  assert.notEqual(
    señalesPullback(m15, m5, h1, { ...conHueco, vigencia: 1 }).length,
    señalesPullback(m15, m5, h1, { ...conHueco, vigencia: 12 }).length,
  );
});

test("en V2 la vigencia SI cuenta, porque entre la zona y el gatillo hay hueco", () => {
  const d = marcos(serie(8000, 7, 0.0005, 0.15, 14));
  const corta = señalesPullback(d.m15, d.m5, d.h1, { ...V2, vigencia: 1 }).length;
  const larga = señalesPullback(d.m15, d.m5, d.h1, { ...V2, vigencia: 12 }).length;
  assert.ok(larga > corta, `vigencia 1 dio ${corta} y vigencia 12 dio ${larga}`);
});

test("ninguna señal dispara mas tarde de lo que dura la vigencia", () => {
  // El limite de verdad, el que si se puede afirmar: entre la ultima vela con el RSI en zona y
  // la del disparo no puede haber mas de `vigencia` velas.
  const { m5, m15, h1 } = SUBE;
  const r = rsi(m5.map((v) => v.c), V1.periodoRsi);
  for (const vigencia of [1, 4, 12]) {
    for (const s of señalesPullback(m15, m5, h1, { ...V1, vigencia })) {
      let separacion = -1;
      for (let k = s.i - 1; k >= 1 && s.i - k <= vigencia; k -= 1) {
        const x = r[k];
        if (x != null && x >= V1.zonaBaja && x <= V1.zonaAlta) { separacion = s.i - k; break; }
      }
      assert.ok(separacion >= 1 && separacion <= vigencia,
        `la señal ${s.i} disparo ${separacion} velas despues del armado, con vigencia ${vigencia}`);
    }
  }
});

test("la vela de confirmacion cierra al alza Y por encima del maximo anterior", () => {
  const { m5, m15, h1 } = SUBE;
  for (const s of señalesPullback(m15, m5, h1, V1)) {
    const v = m5[s.i]!;
    assert.ok(v.c > v.o, `la vela ${s.i} no es alcista`);
    assert.ok(v.c > m5[s.i - 1]!.h, `la vela ${s.i} no supera el maximo anterior`);
    assert.equal(s.entrada, v.c, "se entra al cierre de la vela que confirma");
    assert.equal(s.t, v.t);
  }
});

test("V1 NO MIRA EL MARCO DE 1h: darle velas de 1h absurdas no cambia nada", () => {
  // Deja claro cual es la diferencia entre las dos versiones. Si V1 empezara a mirar la hora,
  // la comparacion V1 contra V2 dejaria de medir lo que dice medir.
  const { m5, m15, h1 } = SUBE;
  const alReves = h1.map((v) => ({ ...v, o: 200 - v.o, h: 200 - v.l, l: 200 - v.h, c: 200 - v.c }));
  assert.deepEqual(
    señalesPullback(m15, m5, alReves, V1),
    señalesPullback(m15, m5, h1, V1),
  );
  assert.deepEqual(señalesPullback(m15, m5, [], V1), señalesPullback(m15, m5, h1, V1));
});

test("V2 SI mira el marco de 1h: invertirlo le quita las señales", () => {
  const { m5, m15, h1 } = SUBE;
  const alReves = h1.map((v) => ({ ...v, o: 200 - v.o, h: 200 - v.l, l: 200 - v.h, c: 200 - v.c }));
  const conBuena = señalesPullback(m15, m5, h1, V2);
  const conMala = señalesPullback(m15, m5, alReves, V2);
  assert.ok(conBuena.length > conMala.length,
    `con 1h a favor ${conBuena.length}, en contra ${conMala.length}`);
  // Sin velas de 1h, V2 no puede decidir y no opera. Callarse es lo correcto: inventarse que la
  // tendencia macro acompaña seria convertir "no lo se" en "si".
  assert.equal(señalesPullback(m15, m5, [], V2).length, 0);
});

test("EL FILTRO DE ADX MATA EL LATERAL, que es lo que tiene que hacer", () => {
  // Se aisla: V1 con el ADX de V2 encendido y nada mas. En una serie sin tendencia el ADX no
  // pasa de 20 y no queda ni una señal, mientras que V1 a secas si dispara.
  const plano = marcos(serie(5000, 31337, 0));
  const soloAdx: AjustesPullback = { ...V1, version: "V2", adxMinimo: 20, adxSubiendoDesde: 2 };
  const sinFiltro = señalesPullback(plano.m15, plano.m5, plano.h1, V1);
  const conAdx = señalesPullback(plano.m15, plano.m5, plano.h1, soloAdx);
  assert.ok(conAdx.length <= sinFiltro.length);
  assert.ok(conAdx.length * 3 < sinFiltro.length,
    `el ADX apenas filtro: ${sinFiltro.length} -> ${conAdx.length}`);
});

test("el filtro de cuerpo descarta las velas de confirmacion flojas", () => {
  // EL UMBRAL AQUI ES 0,7 Y NO EL 0,30 DE V2, y el motivo es interesante: en esta serie la regla
  // de precio —cerrar por encima del maximo anterior— ya obliga a un cuerpo de 0,43 ATR como
  // minimo, asi que 0,30 no descarta absolutamente nada y la prueba pasaria sin probar.
  //
  // Sobre velas de XM si muerde (117 señales -> 55), porque ahi hay huecos y mechas que este
  // generador no produce. Se prueba con un umbral que muerda en los datos que se usan.
  const { m5, m15, h1 } = SUBE;
  const a = atr(m5, 14);
  const señales = señalesPullback(m15, m5, h1, { ...V1, cuerpoMinimoAtr: 0.7 });
  assert.ok(señales.length > 0);
  for (const s of señales) {
    const v = m5[s.i]!;
    assert.ok(Math.abs(v.c - v.o) >= a[s.i]! * 0.7 - 1e-12, `la vela ${s.i} tiene el cuerpo corto`);
  }
  assert.ok(señales.length < señalesPullback(m15, m5, h1, V1).length);
  // Y con un umbral imposible no queda ninguna, que es la otra mitad de la propiedad.
  assert.equal(señalesPullback(m15, m5, h1, { ...V1, cuerpoMinimoAtr: 5 }).length, 0);
});

test("V2 entera llega a disparar, y lo que devuelve trae el ADX y el ATR relativo", () => {
  // Un regimen donde los cuatro filtros de V2 coinciden. Sin esto, todas las pruebas de V2
  // pasarian aunque V2 no disparara jamas.
  const d = marcos(serie(8000, 7, 0.0005, 0.15, 14));
  const señales = señalesPullback(d.m15, d.m5, d.h1, V2);
  assert.ok(señales.length >= 5, `V2 solo dio ${señales.length} señales`);
  for (const s of señales) {
    assert.ok(s.adx != null && s.adx > V2.adxMinimo, `ADX ${s.adx} por debajo del minimo`);
    assert.ok(s.atrRelativo != null
      && s.atrRelativo >= V2.atrRelativoMin && s.atrRelativo <= V2.atrRelativoMax);
  }
});

test("V1 MIDE la volatilidad relativa aunque no filtre por ella", () => {
  // Con la banda 0-99 no descarta nada, pero el numero se guarda igual. Es la misma idea que el
  // ADX marcado en el registro: cuando haya muestra se podra partir por ahi sin haber gastado
  // una muestra nueva ni haber tocado los ajustes a mitad.
  const señales = señalesPullback(SUBE.m15, SUBE.m5, SUBE.h1, V1);
  assert.ok(señales.length > 5);
  assert.ok(señales.every((x) => x.atrRelativo != null && x.atrRelativo > 0));
  // Y medir no es filtrar: apretar la banda TIENE que quitar señales.
  const conBanda = señalesPullback(SUBE.m15, SUBE.m5, SUBE.h1,
    { ...V1, atrRelativoMin: 0.95, atrRelativoMax: 1.05 });
  assert.ok(conBanda.length < señales.length);
});

test("CADA FILTRO SE APAGA POR SU CUENTA, no por la etiqueta de version", () => {
  // Antes `version` encendia cuatro filtros a la vez y no habia forma de medir cual costaba
  // que: cualquier ablacion movia los cuatro. Esta prueba fija que eso no vuelva.
  const { m5, m15, h1 } = SUBE;
  const base = señalesPullback(m15, m5, h1, V1).length;
  // La etiqueta sola no cambia nada.
  assert.equal(señalesPullback(m15, m5, h1, { ...V1, version: "loquesea" }).length, base);
  // Y cada filtro, encendido solo sobre V1, quita algo.
  const solo: [string, Partial<AjustesPullback>][] = [
    ["macro 1h", { usarMacro: true }],
    ["ADX", { adxMinimo: 20 }],
    ["ADX subiendo", { adxSubiendoDesde: 2 }],
    // 0,7 y no 0,30: ver la prueba del cuerpo, aqui la regla de precio ya obliga a 0,43.
    ["cuerpo", { cuerpoMinimoAtr: 0.7 }],
    // Banda estrecha por el mismo motivo que el cuerpo: el ATR de esta serie es tan estable
    // que la banda 0,75-2 de V2 no descarta nada. Sobre velas de XM si (117 -> 42).
    ["volatilidad", { atrRelativoMin: 0.95, atrRelativoMax: 1.05 }],
  ];
  for (const [nombre, cambio] of solo) {
    const n = señalesPullback(m15, m5, h1, { ...V1, ...cambio }).length;
    assert.ok(n < base, `el filtro de ${nombre} no quito ninguna señal (${n} de ${base})`);
  }
});

test("sin bastantes velas no devuelve nada en vez de fallar", () => {
  assert.deepEqual(señalesPullback([], [], [], V1), []);
  const corta = marcos(serie(300, 1, 0.002));
  assert.deepEqual(señalesPullback(corta.m15, corta.m5, corta.h1, V1), []);
  assert.deepEqual(señalesPullback(corta.m15, corta.m5, corta.h1, V2), []);
});

test("no emite dos señales en la misma vela", () => {
  for (const aj of [V1, V2]) {
    const s = señalesPullback(SUBE.m15, SUBE.m5, SUBE.h1, aj);
    assert.equal(new Set(s.map((x) => x.i)).size, s.length);
  }
});

test("adxSubiendoDesde EN CERO NO PIDE QUE SUBA, que es lo que parece que dice", () => {
  // La lectura ingenua compara `adx[m]` contra `adx[m - 0]`, o sea contra si mismo: `a > a`,
  // falso siempre. El parametro que parece apagar el filtro lo convertiria en un muro.
  //
  // Se noto midiendo V1 contra V2: cuatro ablaciones distintas daban CERO señales y parecian
  // un resultado del que sacar conclusiones. No lo eran.
  const { m5, m15, h1 } = SUBE;
  const sinPedirSubir: AjustesPullback = { ...V2, adxMinimo: 0, adxSubiendoDesde: 0 };
  const n = señalesPullback(m15, m5, h1, sinPedirSubir).length;
  assert.ok(n > 0, "con el ADX sin exigencias tiene que salir algo");
  // Y encenderlo tiene que quitar señales, no dejarlo igual.
  assert.ok(señalesPullback(m15, m5, h1, { ...sinPedirSubir, adxSubiendoDesde: 2 }).length < n);
});
