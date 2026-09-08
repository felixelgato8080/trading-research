import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import {
  picos, divergencias, señales,
  type AjustesDivergencia, type AjustesEntrada,
} from "../src/forex/divergencia";
import type { AjustesSMC } from "../src/forex/smc";

const M15 = 900;
const M5 = 300;
const v = (t: number, o: number, h: number, l: number, c: number): Vela => ({ t, o, h, l, c });
/** Vela de 15m en el minuto `k*15`. */
const q = (k: number, o: number, h: number, l: number, c: number): Vela =>
  v(k * M15, o, h, l, c);

const AJ: AjustesDivergencia = {
  periodoRsi: 14, confirmacion: 2, umbralAlto: 70,
  minSeparacion: 3, maxSeparacion: 60, exigirFueraDelCanal: true,
};

// ---------------------------------------------------------------------------------------
// PICOS
// ---------------------------------------------------------------------------------------

test("UN PICO NO EXISTE hasta que cierran las velas que lo confirman", () => {
  const velas = [
    q(0, 100, 101, 99, 100), q(1, 100, 102, 99, 101), q(2, 101, 110, 100, 109),
    q(3, 109, 105, 103, 104), q(4, 104, 104, 100, 101),
  ];
  const p = picos(velas, 2, true);
  assert.equal(p.length, 1);
  assert.equal(p[0]!.i, 2, "el maximo esta en la vela 2");
  assert.equal(p[0]!.confirmadoEn, 4, "pero no se sabe hasta la 4");
});

test("LOS EMPATES NO SON PICO: si no, un lateral da un pico por vela", () => {
  const plano = Array.from({ length: 9 }, (_, k) => q(k, 100, 101, 99, 100));
  assert.equal(picos(plano, 2, true).length, 0);
});

test("los minimos son el espejo", () => {
  const velas = [
    q(0, 100, 101, 99, 100), q(1, 100, 100, 98, 99), q(2, 99, 99, 90, 91),
    q(3, 91, 95, 92, 94), q(4, 94, 97, 93, 96),
  ];
  const p = picos(velas, 2, false);
  assert.equal(p[0]!.i, 2);
  assert.equal(p[0]!.valor, 90);
});

// ---------------------------------------------------------------------------------------
// DIVERGENCIAS
// ---------------------------------------------------------------------------------------

/** Dos maximos: el segundo mas alto en precio. El RSI se pasa por parametro. */
function dosMaximos(): Vela[] {
  return [
    q(0, 100, 101, 99, 100),
    q(1, 100, 102, 99, 101),
    q(2, 101, 110, 100, 109),   // pico 1 en 110
    q(3, 109, 106, 104, 105),
    q(4, 105, 106, 100, 101),
    q(5, 101, 104, 100, 103),
    q(6, 103, 108, 102, 107),
    q(7, 107, 115, 106, 114),   // pico 2 en 115, MAS ALTO
    q(8, 114, 112, 108, 109),
    q(9, 109, 110, 105, 106),
  ];
}
/** RSI alto en el pico 1 y bajo en el pico 2: la divergencia del video. */
const rsiDivergente = (): (number | null)[] => {
  const r: (number | null)[] = new Array(10).fill(50);
  r[2] = 78;   // salio del canal
  r[7] = 62;   // ni se asoma
  return r;
};

test("DIVERGENCIA BAJISTA: precio hace maximo mas alto y el RSI mas bajo", () => {
  const d = divergencias(dosMaximos(), rsiDivergente(), AJ);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.direccion, "BAJISTA");
  assert.equal(d[0]!.pico1, 2);
  assert.equal(d[0]!.pico2, 7);
  assert.equal(d[0]!.extremo, 115);
  assert.equal(d[0]!.i, 9, "se confirma cuando se confirma el segundo pico");
});

test("SIN SALIR DEL CANAL en el primer pico no hay señal", () => {
  const r = rsiDivergente();
  r[2] = 65;   // nunca hubo sobrecompra
  assert.equal(divergencias(dosMaximos(), r, AJ).length, 0);
});

test("SI EL RSI ACOMPAÑA al precio no hay divergencia, hay convergencia", () => {
  const r = rsiDivergente();
  r[7] = 85;   // el RSI tambien hace maximo mas alto
  assert.equal(divergencias(dosMaximos(), r, AJ).length, 0);
});

test("EXIGIR QUE NO SE ASOME AL CANAL es lo que el video subraya, y filtra", () => {
  const r = rsiDivergente();
  r[7] = 74;   // menor que 78, pero sigue dentro del canal de sobrecompra
  assert.equal(divergencias(dosMaximos(), r, AJ).length, 0, "con la regla estricta, fuera");
  const flojo = divergencias(dosMaximos(), r, { ...AJ, exigirFueraDelCanal: false });
  assert.equal(flojo.length, 1, "sin ella, entra");
});

test("dos picos PEGADOS son el mismo movimiento, no una divergencia", () => {
  assert.equal(divergencias(dosMaximos(), rsiDivergente(), { ...AJ, minSeparacion: 20 }).length, 0);
});

test("dos picos DEMASIADO LEJOS no se emparejan", () => {
  assert.equal(divergencias(dosMaximos(), rsiDivergente(), { ...AJ, maxSeparacion: 2 }).length, 0);
});

test("EL OBJETIVO DE LIQUIDEZ es el extremo opuesto entre los dos picos", () => {
  const d = divergencias(dosMaximos(), rsiDivergente(), AJ)[0]!;
  assert.equal(d.objetivoLiquidez, 100, "el minimo mas bajo del tramo");
});

test("la divergencia de la vela i no cambia al añadir velas futuras", () => {
  const base = dosMaximos();
  const r = rsiDivergente();
  const conFuturo = [...base, q(10, 106, 200, 105, 199), q(11, 199, 250, 190, 240)];
  const rFuturo = [...r, 95, 99];
  const a = divergencias(base, r, AJ);
  const b = divergencias(conFuturo, rFuturo, AJ).filter((x) => x.i < base.length);
  assert.deepEqual(
    a.map((x) => [x.i, x.pico1, x.pico2]),
    b.map((x) => [x.i, x.pico1, x.pico2]),
  );
});

// ---------------------------------------------------------------------------------------
// EL CRUCE DE TEMPORALIDADES: donde se colaria el futuro
// ---------------------------------------------------------------------------------------

const ZONA: AjustesSMC = {
  minHueco: 0.1, minEmpuje: 0.5, vigencia: 60, esperaBloque: 20, colchon: 0.1,
  objetivoR: 2, radioLiquidez: 0.5, toquesLiquidez: 3, memoriaHuecos: 50,
};
const ENT: AjustesEntrada = {
  zona: ZONA, esperaZona: 40, esperaEntrada: 60, colchon: 0.1,
  stop: "ZONA", objetivo: "FIJO", objetivoR: 2, rrMinimo: 0, minRiesgoAtr: 0,
};

test("LA ENTRADA NO PUEDE MIRAR VELAS ANTERIORES AL CIERRE DE LA VELA DE 15m", () => {
  // La vela de 15m que confirma empieza en su t y CIERRA 15 minutos despues. Las velas de 5m
  // de ese cuarto de hora todavia no habian pasado cuando se decidio.
  const mayores = dosMaximos();
  const rsiM = rsiDivergente();
  const d = divergencias(mayores, rsiM, AJ)[0]!;
  const tCierre = mayores[d.i]!.t + M15;

  // 5m que cubre todo el rango, con un impulso bajista despues del cierre.
  const menores: Vela[] = [];
  for (let k = 0; k * M5 < tCierre + 60 * M5; k += 1) {
    const t = k * M5;
    menores.push(t < tCierre ? v(t, 110, 112, 108, 111) : v(t, 110, 111, 100, 101));
  }
  const atrM = menores.map(() => 1);
  const ss = señales(mayores, rsiM, menores, atrM, AJ, ENT);
  for (const s of ss) {
    assert.ok(
      menores[s.i]!.t >= tCierre,
      `entrada en ${menores[s.i]!.t} antes del cierre de la vela de 15m (${tCierre})`,
    );
  }
});

test("una divergencia sin zona de entrada despues NO produce operacion", () => {
  const mayores = dosMaximos();
  const rsiM = rsiDivergente();
  // 5m completamente plano: no hay huecos ni bloques.
  const menores = Array.from({ length: 400 }, (_, k) => v(k * M5, 110, 111, 109, 110));
  const ss = señales(mayores, rsiM, menores, menores.map(() => 1), AJ, ENT);
  assert.equal(ss.length, 0, "sin zona no hay entrada, no se inventa una");
});

test("EL FILTRO DE R:R descarta la operacion aunque todo lo demas encaje", () => {
  const mayores = dosMaximos();
  const rsiM = rsiDivergente();
  const menores: Vela[] = [];
  const tCierre = mayores[divergencias(mayores, rsiM, AJ)[0]!.i]!.t + M15;
  for (let k = 0; k * M5 < tCierre + 200 * M5; k += 1) {
    const t = k * M5;
    menores.push(t < tCierre ? v(t, 110, 112, 108, 111) : v(t, 110, 111, 100, 101));
  }
  const atrM = menores.map(() => 1);
  const alto = señales(mayores, rsiM, menores, atrM, AJ, { ...ENT, rrMinimo: 99 });
  assert.equal(alto.length, 0, "es una regla, no una preferencia");
});

test("EL STOP TRAS EL EXTREMO da un riesgo mayor que el stop tras la zona", () => {
  const mayores = dosMaximos();
  const rsiM = rsiDivergente();
  const menores: Vela[] = [];
  const tCierre = mayores[divergencias(mayores, rsiM, AJ)[0]!.i]!.t + M15;
  for (let k = 0; k * M5 < tCierre + 200 * M5; k += 1) {
    const t = k * M5;
    menores.push(t < tCierre ? v(t, 110, 112, 108, 111) : v(t, 110, 111, 100, 101));
  }
  const atrM = menores.map(() => 1);
  const zona = señales(mayores, rsiM, menores, atrM, AJ, ENT)[0];
  const ext = señales(mayores, rsiM, menores, atrM, AJ, { ...ENT, stop: "EXTREMO" })[0];
  if (zona && ext) {
    const rz = Math.abs(zona.entrada - zona.stop);
    const re = Math.abs(ext.entrada - ext.stop);
    assert.ok(re > rz, `el extremo (115) esta mas lejos que la zona: ${re} vs ${rz}`);
  }
});

test("UN RIESGO CASI CERO NO ES UNA OPERACION, es una division entre casi cero", () => {
  // Ya paso con los pares: PF 2,90 que con la guarda se quedo en 1,06. Un stop de medio pip
  // no te lo ejecutan.
  const mayores = dosMaximos();
  const rsiM = rsiDivergente();
  const menores: Vela[] = [];
  const tCierre = mayores[divergencias(mayores, rsiM, AJ)[0]!.i]!.t + M15;
  for (let k = 0; k * M5 < tCierre + 200 * M5; k += 1) {
    const t = k * M5;
    menores.push(t < tCierre ? v(t, 110, 112, 108, 111) : v(t, 110, 111, 100, 101));
  }
  const atrM = menores.map(() => 1);
  const sinGuarda = señales(mayores, rsiM, menores, atrM, AJ, ENT);
  const conGuarda = señales(mayores, rsiM, menores, atrM, AJ, { ...ENT, minRiesgoAtr: 50 });
  assert.ok(sinGuarda.length >= conGuarda.length, "la guarda solo puede quitar operaciones");
  assert.equal(conGuarda.length, 0, "con un minimo absurdo no queda ninguna");
});
