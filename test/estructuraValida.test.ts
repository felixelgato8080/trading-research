import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import {
  estructura, zonas, señales, simular, type AjustesZona,
} from "../src/forex/estructuraValida";

const DIA = 86400;
const v = (i: number, o: number, h: number, l: number, c: number): Vela =>
  ({ t: i * DIA, o, h, l, c });

const AJ: AjustesZona = { impulso: 1.5, colchon: 0.1, rrMinimo: 2.5, vigencia: 30 };

// ---------------------------------------------------------------------------------------
// LA REGLA DEL MINIMO VALIDO
// ---------------------------------------------------------------------------------------

test("ROMPER EL MAXIMO valida el minimo del tramo y pone la tendencia ALCISTA", () => {
  const velas = [
    v(0, 100, 105, 95, 100),
    v(1, 100, 102, 90, 92),   // baja: el candidato a minimo es 90
    v(2, 92, 110, 91, 108),   // rompe el maximo 105 -> minimo 90 queda VALIDADO
  ];
  const e = estructura(velas);
  assert.equal(e[2]!.tendencia, "ALCISTA");
  assert.equal(e[2]!.minimoValido, 90);
});

test("UN MINIMO MAS BAJO NO CAMBIA LA TENDENCIA si no rompe el minimo VALIDO", () => {
  // Es el nucleo del video: casi todo el mundo diria bajista aqui, y no lo es.
  const velas = [
    v(0, 100, 105, 95, 100),
    v(1, 100, 102, 90, 92),
    v(2, 92, 110, 91, 108),   // minimo valido = 90, alcista
    v(3, 108, 109, 95, 96),   // baja pero NO pierde 90
    v(4, 96, 98, 93, 94),     // sigue bajando, sigue por encima de 90
  ];
  const e = estructura(velas);
  assert.equal(e[4]!.tendencia, "ALCISTA", "no se pierde el minimo valido, sigue alcista");
  assert.equal(e[4]!.minimoValido, 90);
});

test("PERDER EL MINIMO VALIDO si cambia la tendencia a BAJISTA", () => {
  const velas = [
    v(0, 100, 105, 95, 100),
    v(1, 100, 102, 90, 92),
    v(2, 92, 110, 91, 108),   // alcista, minimo valido 90
    v(3, 108, 109, 95, 96),
    v(4, 96, 97, 85, 86),     // cierra por debajo de 90
  ];
  const e = estructura(velas);
  assert.equal(e[4]!.tendencia, "BAJISTA");
});

test("hace falta CERRAR mas alla, no solo pinchar con la mecha", () => {
  const velas = [
    v(0, 100, 105, 95, 100),
    v(1, 100, 102, 90, 92),
    v(2, 92, 110, 91, 108),
    v(3, 108, 109, 85, 95),   // la mecha baja de 90 pero el cierre queda encima
  ];
  assert.equal(estructura(velas)[3]!.tendencia, "ALCISTA");
});

test("la estructura de la vela i solo usa informacion hasta i", () => {
  const base = [v(0, 100, 105, 95, 100), v(1, 100, 102, 90, 92), v(2, 92, 110, 91, 108)];
  const conFuturo = [...base, v(3, 108, 200, 50, 60)];
  const a = estructura(base);
  const b = estructura(conFuturo);
  for (let i = 0; i < base.length; i += 1) {
    assert.deepEqual(a[i], b[i], `el estado ${i} cambio al añadir velas futuras`);
  }
});

// ---------------------------------------------------------------------------------------
// ZONAS
// ---------------------------------------------------------------------------------------

test("LA ZONA ES LA VELA ANTERIOR al impulso, de minimo a maximo", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 100), v(2, 100, 130, 100, 128)];
  const atr = velas.map(() => 5);
  const z = zonas(velas, atr, 1.5);
  assert.equal(z.length, 1);
  assert.equal(z[0]!.i, 1, "la zona es la vela previa, no la del impulso");
  assert.equal(z[0]!.alto, 102);
  assert.equal(z[0]!.bajo, 98);
  assert.equal(z[0]!.tipo, "DEMANDA");
  assert.equal(z[0]!.objetivo, 130, "el objetivo es el extremo del impulso");
});

test("un impulso bajista crea una zona de OFERTA", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 100), v(2, 100, 100, 70, 72)];
  const z = zonas(velas, velas.map(() => 5), 1.5);
  assert.equal(z[0]!.tipo, "OFERTA");
  assert.equal(z[0]!.objetivo, 70);
});

test("UNA VELA NORMAL NO ES IMPULSO", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 100), v(2, 100, 103, 99, 102)];
  assert.equal(zonas(velas, velas.map(() => 5), 1.5).length, 0);
});

// ---------------------------------------------------------------------------------------
// SEÑALES
// ---------------------------------------------------------------------------------------

/** Alcista establecido, impulso, y vuelta a la zona. */
function escenario(): Vela[] {
  return [
    v(0, 100, 105, 95, 100),
    v(1, 100, 102, 90, 92),
    v(2, 92, 110, 91, 108),    // alcista, minimo valido 90
    v(3, 108, 112, 106, 110),  // zona: 106-112
    v(4, 110, 160, 110, 158),  // impulso: objetivo 160
    v(5, 158, 159, 140, 142),
    v(6, 142, 143, 111, 112),  // vuelve a la zona (toca 112)
    v(7, 112, 170, 111, 168),
  ];
}

test("SEÑAL COMPLETA: tendencia a favor, vuelta a la zona y R:R suficiente", () => {
  const velas = escenario();
  const s = señales(velas, velas.map(() => 5), AJ);
  assert.equal(s.length, 1, `esperaba una señal, hubo ${s.length}`);
  assert.equal(s[0]!.direccion, "LARGO");
  assert.ok(s[0]!.rr >= 2.5, `R:R fue ${s[0]!.rr}`);
});

test("EL FILTRO DE R:R DESCARTA la operacion aunque todo lo demas encaje", () => {
  const velas = escenario();
  const conFiltroAlto = señales(velas, velas.map(() => 5), { ...AJ, rrMinimo: 50 });
  assert.equal(conFiltroAlto.length, 0, "es una regla, no una preferencia");
});

test("NO SE OPERA CONTRA LA TENDENCIA: una zona de oferta en alcista se ignora", () => {
  const velas = [
    ...escenario(),
    v(8, 168, 169, 166, 167),
    v(9, 167, 168, 120, 122),  // impulso bajista -> zona de OFERTA
    v(10, 122, 168, 121, 166), // vuelve arriba
  ];
  const s = señales(velas, velas.map(() => 5), AJ);
  // Sigue siendo alcista (no perdio el minimo valido), asi que la oferta no se opera.
  assert.ok(s.every((x) => x.direccion === "LARGO"), "no puede haber cortos en tendencia alcista");
});

test("CADA ZONA SE USA UNA SOLA VEZ", () => {
  const velas = [
    ...escenario(),
    v(8, 168, 169, 111, 112),  // vuelve a la zona otra vez
    v(9, 112, 170, 111, 168),
  ];
  const s = señales(velas, velas.map(() => 5), AJ);
  assert.equal(s.length, 1, "reentrar diez veces en la misma zona infla la muestra");
});

// ---------------------------------------------------------------------------------------
// SIMULACION
// ---------------------------------------------------------------------------------------

test("una ganadora da su R:R declarado", () => {
  const velas = escenario();
  const s = señales(velas, velas.map(() => 5), AJ)[0]!;
  const r = simular(velas, s, 0, 0);
  assert.ok(r != null);
  assert.equal(r!.motivo, "OBJETIVO");
  assert.ok(Math.abs(r!.r - s.rr) < 1e-9);
});

test("SI SE TOCAN STOP Y OBJETIVO EN LA MISMA VELA, cuenta el STOP", () => {
  const velas = [...escenario()];
  const s = señales(velas, velas.map(() => 5), AJ)[0]!;
  velas[7] = v(7, 112, 200, 50, 150);
  const r = simular(velas, s, 0, 0);
  assert.equal(r!.motivo, "STOP");
  assert.equal(r!.r, -1);
});

test("el coste resta en las dos direcciones", () => {
  const velas = escenario();
  const s = señales(velas, velas.map(() => 5), AJ)[0]!;
  assert.ok(simular(velas, s, 1, 0)!.r < simular(velas, s, 0, 0)!.r);
});

test("sin datos suficientes devuelve null, no una operacion inventada", () => {
  const s = { i: 0, direccion: "LARGO" as const, entrada: 100, stop: 100, objetivo: 110, rr: 3 };
  assert.equal(simular([v(0, 100, 101, 99, 100)], s, 0, 0), null);
});

test("EXIGIR TENDENCIA SE PUEDE APAGAR, para poder medir cuanto aporta", () => {
  const velas = [
    ...escenario(),
    v(8, 168, 169, 166, 167),
    v(9, 167, 168, 120, 122),  // impulso bajista -> zona de OFERTA
    v(10, 122, 168, 121, 166),
    v(11, 166, 170, 165, 168),
  ];
  const atr = velas.map(() => 5);
  const est = estructura(velas);
  const conFiltro = señales(velas, atr, { ...AJ, rrMinimo: 0 });
  const sinFiltro = señales(velas, atr, { ...AJ, rrMinimo: 0, exigirTendencia: false });

  // La invariante real: CON filtro, ninguna señal contradice la tendencia de la vela anterior.
  for (const x of conFiltro) {
    const t = est[x.i - 1]!.tendencia;
    assert.equal(t, x.direccion === "LARGO" ? "ALCISTA" : "BAJISTA", `señal en ${x.i} contra ${t}`);
  }
  // Y sin filtro aparecen precisamente las que el filtro estaba tapando.
  assert.ok(sinFiltro.length > conFiltro.length, "el filtro tiene que estar quitando señales");
  const soloSinFiltro = sinFiltro.filter((x) => !conFiltro.some((y) => y.i === x.i));
  assert.ok(
    soloSinFiltro.some((x) => {
      const t = est[x.i - 1]!.tendencia;
      return t !== (x.direccion === "LARGO" ? "ALCISTA" : "BAJISTA");
    }),
    "las señales extra tienen que ser contra tendencia, que es lo que el filtro quitaba",
  );
});

test("LA VELA DE ENTRADA NO PUEDE DAR EL OBJETIVO: su maximo ya ocurrio antes de entrar", () => {
  // Entra en 112 (techo de zona) en una vela cuyo maximo es 143. Un objetivo en 130 NO vale:
  // ese 143 se hizo antes de que el precio bajara a la zona.
  const velas = [
    v(0, 142, 143, 111, 112),
    v(1, 112, 120, 111, 119),
    v(2, 119, 135, 118, 134),
  ];
  const s = { i: 0, direccion: "LARGO" as const, entrada: 112, stop: 105, objetivo: 130, rr: 2.57 };
  const r = simular(velas, s, 0, 0)!;
  assert.equal(r.motivo, "OBJETIVO");
  assert.equal(r.velas, 2, "el objetivo se da en la vela 2, no en la de entrada");
});

test("pero el STOP si cuenta en la vela de entrada: cuando no se sabe el orden, gana lo malo", () => {
  const velas = [v(0, 142, 143, 100, 112), v(1, 112, 200, 111, 199)];
  const s = { i: 0, direccion: "LARGO" as const, entrada: 112, stop: 105, objetivo: 130, rr: 2.57 };
  assert.equal(simular(velas, s, 0, 0)!.motivo, "STOP");
});

test("con entrada al cierre no cuenta NADA de la vela de entrada", () => {
  const velas = [v(0, 142, 143, 100, 112), v(1, 112, 113, 111, 112)];
  const s = { i: 0, direccion: "LARGO" as const, entrada: 112, stop: 105, objetivo: 130, rr: 2.57 };
  assert.equal(simular(velas, s, 0, 0, "NINGUNO"), null, "el minimo 100 es previo a entrar al cierre");
});

test("VOLTEAR LA SEÑAL no la mata con un extremo que ya habia pasado", () => {
  // Vela de entrada: el precio CAE de 143 a 112. Un corto en 112 con stop en 119 no puede
  // saltar por ese 143, que ocurrio antes de entrar; y su objetivo abajo si es alcanzable.
  const velas = [v(0, 142, 143, 100, 112), v(1, 112, 113, 111, 112)];
  const s = { i: 0, direccion: "CORTO" as const, entrada: 112, stop: 119, objetivo: 105, rr: 1 };
  const r = simular(velas, s, 0, 0, "MINIMO")!;
  assert.equal(r.motivo, "OBJETIVO", "el minimo 100 es posterior al llenado, y vale");
  assert.equal(simular(velas, s, 0, 0)!.motivo, "STOP", "deducido del lado, saltaria por el 143");
});
