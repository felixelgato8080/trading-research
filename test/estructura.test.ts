import { test } from "node:test";
import assert from "node:assert/strict";
import {
  swings,
  swingsDisponibles,
  barridoLiquidez,
  rupturaEstructura,
  zonasPorVela,
  cercaDeZona,
} from "../src/forex/estructura";
import type { Vela } from "../src/forex/datos";

const H = 3600;
const v = (t: number, o: number, h: number, l: number, c: number): Vela => ({ t, o, h, l, c });

// ---------- swings ----------

test("UN SWING SOLO SE PUEDE USAR CUANDO SE CONFIRMA", () => {
  // Un swing high necesita n velas MAS BAJAS a cada lado, asi que no se conoce hasta n velas
  // despues. Usarlo en el momento en que ocurre es mirar el futuro, y convierte cualquier
  // estrategia en ganadora dentro del backtest.
  const velas = [
    v(0, 1, 1, 1, 1), v(H, 1, 2, 1, 2), v(2 * H, 1, 5, 1, 5), v(3 * H, 1, 2, 1, 2), v(4 * H, 1, 1, 1, 1),
  ];
  const ss = swings(velas, 2);
  const alto = ss.find((s) => s.tipo === "ALTO")!;
  assert.equal(alto.i, 2, "el extremo esta en la vela 2");
  assert.equal(alto.iConfirmado, 4, "pero no se sabe hasta la 4");
  assert.equal(swingsDisponibles(ss, 3).length, 0, "en la vela 3 aun no existe");
  assert.equal(swingsDisponibles(ss, 4).length > 0, true);
});

test("detecta maximos y minimos", () => {
  const velas = [
    v(0, 5, 5, 5, 5), v(H, 4, 4, 3, 3), v(2 * H, 2, 2, 1, 1), v(3 * H, 3, 3, 3, 3), v(4 * H, 4, 4, 4, 4),
  ];
  const bajos = swings(velas, 2).filter((s) => s.tipo === "BAJO");
  assert.equal(bajos.length, 1);
  assert.equal(bajos[0]?.precio, 1);
});

// ---------- barrido de liquidez ----------

test("UN BARRIDO EXIGE CIERRE POR ENCIMA, no solo la mecha", () => {
  // Una mecha que perfora y cierra debajo no es un barrido: es una ruptura que sigue. Contar
  // las dos igual mete como setup justo los casos en que el nivel cedio de verdad.
  const base = [
    v(0, 10, 10, 10, 10), v(H, 9, 9, 9, 9), v(2 * H, 8, 8, 5, 8), v(3 * H, 9, 9, 9, 9), v(4 * H, 10, 10, 10, 10),
  ];
  const ss = swings(base, 2);

  const recupera = [...base, v(5 * H, 8, 9, 4.5, 8.5)];
  assert.equal(barridoLiquidez(recupera, 5, ss, 10, "LARGO").hubo, true);

  const noRecupera = [...base, v(5 * H, 8, 8, 4.5, 4.6)];
  assert.equal(barridoLiquidez(noRecupera, 5, ss, 10, "LARGO").hubo, false);
});

test("sin swings previos no hay barrido", () => {
  const velas = [v(0, 1, 1, 1, 1), v(H, 1, 1, 1, 1)];
  assert.equal(barridoLiquidez(velas, 1, [], 10, "LARGO").hubo, false);
});

// ---------- ruptura de estructura ----------

test("la ruptura usa el ultimo swing CONFIRMADO", () => {
  const base = [
    v(0, 1, 1, 1, 1), v(H, 1, 2, 1, 2), v(2 * H, 1, 5, 1, 5), v(3 * H, 1, 2, 1, 2), v(4 * H, 1, 1, 1, 1),
  ];
  const ss = swings(base, 2);
  const rompe = [...base, v(5 * H, 5, 6, 5, 6)];
  assert.equal(rupturaEstructura(rompe, 5, ss, "LARGO"), true, "cierra por encima de 5");
  const noRompe = [...base, v(5 * H, 4, 4.9, 4, 4.5)];
  assert.equal(rupturaEstructura(noRompe, 5, ss, "LARGO"), false);
});

// ---------- zonas ----------

function diaDe(dia: number, horas: number[]): Vela[] {
  const base = Date.UTC(2026, 0, dia) / 1000;
  return horas.map((h) => v(base + h * H, 100 + h, 100 + h + 1, 100 + h - 1, 100 + h));
}

test("LAS ZONAS DEL DIA ACTUAL NO SE PUEDEN USAR HOY", () => {
  // El maximo de hoy no se conoce hasta que el dia acaba. Usarlo es el error clasico que hace
  // que "romper el maximo del dia" parezca rentable.
  const velas = [...diaDe(1, [0, 4, 8, 12]), ...diaDe(2, [0, 4, 8, 12])];
  const z = zonasPorVela(velas);
  assert.equal(z[0]?.diaPrevioAlto, null, "el primer dia no tiene dia previo");
  assert.ok(z[4]?.diaPrevioAlto != null, "el segundo dia si");
  // El maximo del dia 1 fue la vela de las 12h: 100+12+1 = 113.
  assert.equal(z[4]?.diaPrevioAlto, 113);
});

test("la sesion asiatica solo se usa cuando ha terminado", () => {
  const velas = diaDe(1, [0, 2, 4, 6, 8, 10]);
  const z = zonasPorVela(velas);
  assert.equal(z[0]?.asiaAlto, null, "durante Asia todavia no");
  assert.equal(z[3]?.asiaAlto, null, "a las 6h sigue en Asia");
  assert.ok(z[4]?.asiaAlto != null, "a las 8h ya cerro");
});

// ---------- confluencia ----------

test("cuenta cuantas zonas hay cerca, en multiplos de ATR", () => {
  // Con ATR = 1 y umbral 0,5, solo cuenta lo que este a menos de 0,5 de distancia.
  const z = { diaPrevioAlto: 101, diaPrevioBajo: 99, asiaAlto: null, asiaBajo: null };
  const r = cercaDeZona(100.2, z, [100.3], 1, 0.5);
  assert.equal(r.cerca, true);
  assert.equal(r.cuantas, 1, "solo el swing a 0,1; el alto previo esta a 0,8 y el bajo a 1,2");

  // Medir en ATR y no en pips es lo que hace comparable EURUSD con GBPJPY: con un ATR cuatro
  // veces mayor, los mismos niveles dejan de estar "cerca".
  assert.equal(cercaDeZona(100.2, z, [100.3], 4, 0.5).cuantas, 3, "con ATR grande, todo cerca");
});

test("sin ATR valido no se opina", () => {
  const z = { diaPrevioAlto: 101, diaPrevioBajo: 99, asiaAlto: null, asiaBajo: null };
  assert.equal(cercaDeZona(100, z, [], 0, 0.5).cerca, false);
});
