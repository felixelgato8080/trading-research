import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, retrocesoEnTendencia, huecoBajista, simularReversion } from "../src/forex/reversion";
import type { Vela } from "../src/forex/datos";

const D = 86400;
const v = (t: number, o: number, h: number, l: number, c: number): Vela => ({ t, o, h, l, c });

test("la media simple no usa velas futuras", () => {
  const m = sma([1, 2, 3, 4, 5], 3);
  assert.equal(m[0], null);
  assert.equal(m[1], null);
  assert.equal(m[2], 2, "media de 1,2,3");
  assert.equal(m[3], 3, "media de 2,3,4");
});

/** Serie que sube y luego hace un retroceso corto: tendencia alcista con caida puntual. */
function subeYRetrocede(): Vela[] {
  const out: Vela[] = [];
  let p = 100;
  for (let i = 0; i < 220; i += 1) {
    p += 0.4;
    out.push(v(i * D, p, p + 0.5, p - 0.5, p));
  }
  for (let i = 0; i < 5; i += 1) {
    p -= 3;
    out.push(v((220 + i) * D, p, p + 0.5, p - 0.5, p));
  }
  return out;
}

test("EL FILTRO DE TENDENCIA ES LO QUE DISTINGUE ESTO DEL RSI QUE FALLO", () => {
  // En forex probamos RSI contra-tendencia y el filtro lo empeoraba: son premisas opuestas.
  // Aqui la premisa es comprar el retroceso DENTRO de una subida, y el filtro la completa.
  const velas = subeYRetrocede();
  const conFiltro = retrocesoEnTendencia(velas, 2, 10, 200, true);
  const sinFiltro = retrocesoEnTendencia(velas, 2, 10, 200, false);
  assert.ok(conFiltro.length > 0, "el retroceso en tendencia se detecta");
  assert.ok(sinFiltro.length >= conFiltro.length, "sin filtro entran mas casos");
});

test("una caida sostenida NO produce señal con filtro de tendencia", () => {
  // Es justo lo que el filtro debe evitar: comprar mientras algo se hunde.
  const baja: Vela[] = [];
  let p = 300;
  for (let i = 0; i < 260; i += 1) {
    p -= 0.8;
    baja.push(v(i * D, p, p + 0.5, p - 0.5, p));
  }
  assert.deepEqual(retrocesoEnTendencia(baja, 2, 10, 200, true), []);
});

test("el hueco se mide en ATR y exige tendencia previa", () => {
  const base = Array.from({ length: 10 }, (_, i) => v(i * D, 100, 101, 99, 100));
  const conHueco = [...base, v(10 * D, 96, 97, 95, 96)];
  const atr = new Array(12).fill(1);
  // Hueco de 4 con ATR 1: supera el umbral de 2.
  assert.equal(huecoBajista(conHueco, atr, 2, null).length, 1);
  // Con umbral 5 ya no.
  assert.equal(huecoBajista(conHueco, atr, 5, null).length, 0);
});

test("un hueco DENTRO de una tendencia bajista no cuenta", () => {
  // No es un hueco que se rellena: es la tendencia continuando.
  const base = Array.from({ length: 10 }, (_, i) => v(i * D, 100, 101, 99, 100));
  const conHueco = [...base, v(10 * D, 96, 97, 95, 96)];
  const atr = new Array(12).fill(1);
  const mediaAlta = new Array(12).fill(200); // precio muy por debajo de su media
  assert.equal(huecoBajista(conHueco, atr, 2, mediaAlta).length, 0);
});

// ---------- simulacion ----------

const s = { i: 0, direccion: "LARGO" as const };

test("SALE CUANDO LA REVERSION SE CUMPLE, no en un objetivo fijo de R", () => {
  // La premisa es "el precio ya volvio", asi que el objetivo natural es cerrar por encima
  // del maximo de ayer. Un objetivo en R fijo no corresponde a esta premisa.
  const velas = [
    v(0, 100, 100, 100, 100), v(D, 100, 101, 99, 100), v(2 * D, 100, 103, 100, 102),
  ];
  const r = simularReversion(velas, s, 5, 0, 0, null, 0);
  assert.equal(r?.motivo, "OBJETIVO");
  assert.ok(r!.r > 0);
});

test("el stop existe porque una reversion que no revierte hay que cortarla", () => {
  const velas = [v(0, 100, 100, 100, 100), v(D, 100, 100, 94, 94), v(2 * D, 94, 94, 94, 94)];
  const r = simularReversion(velas, s, 5, 0, 0, null, 0);
  assert.equal(r?.motivo, "STOP");
  assert.ok(Math.abs(r!.r + 1) < 1e-9);
});

test("el stop manda si en la misma vela se tocan las dos cosas", () => {
  const velas = [v(0, 100, 100, 100, 100), v(D, 100, 110, 94, 108)];
  assert.equal(simularReversion(velas, s, 5, 0, 0, null, 0)?.motivo, "STOP");
});

test("el coste resta por los dos lados", () => {
  const velas = [v(0, 100, 100, 100, 100), v(D, 100, 101, 99, 100), v(2 * D, 100, 103, 100, 102)];
  const sin = simularReversion(velas, s, 5, 0, 0, null, 0)!;
  const con = simularReversion(velas, s, 5, 0.5, 0, null, 0)!;
  assert.ok(con.r < sin.r);
});

test("sin velas posteriores no hay operacion", () => {
  assert.equal(simularReversion([v(0, 100, 100, 100, 100)], s, 5, 0, 0, null, 0), null);
});
