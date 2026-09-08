import { test } from "node:test";
import assert from "node:assert/strict";
import type { Vela } from "../src/forex/datos";
import type { TrazaOp } from "../src/forex/rupturas";
import { simularRuptura } from "../src/forex/rupturas";
import { ventana, geometria, grafico, pagina, LIENZO } from "../src/forex/grafico";

const DIA = 86400;
const v = (i: number, o: number, h: number, l: number, c: number): Vela =>
  ({ t: i * DIA, o, h, l, c });

/** Una operacion real, sacada del simulador y no inventada a mano. */
function operacion(): { velas: Vela[]; traza: TrazaOp; r: number } {
  const velas = [
    v(0, 100, 101, 99, 100), v(1, 100, 102, 98, 100), v(2, 100, 103, 99, 102),
    v(3, 102, 112, 101, 111), v(4, 111, 125, 110, 124), v(5, 124, 140, 123, 139),
    v(6, 139, 141, 120, 122), v(7, 122, 124, 100, 101),
  ];
  const traza = {} as TrazaOp;
  const r = simularRuptura(
    velas, { i: 2, direccion: "LARGO", nivel: 103 }, 5, 2, 0, 0, 0, true, true, traza,
  );
  return { velas, traza, r: r!.r };
}

// ---------------------------------------------------------------------------------------
// VENTANA
// ---------------------------------------------------------------------------------------

test("la ventana rodea la operacion con contexto a los dos lados", () => {
  const { velas, traza } = operacion();
  const w = ventana(velas, traza, 2);
  assert.equal(w.desde, traza.iEntrada - 2);
  assert.equal(w.hasta, Math.min(velas.length - 1, traza.iSalida + 2));
});

test("PEDIR MAS CONTEXTO DEL QUE HAY no se sale del array", () => {
  const { velas, traza } = operacion();
  const w = ventana(velas, traza, 500);
  assert.equal(w.desde, 0);
  assert.equal(w.hasta, velas.length - 1);
});

// ---------------------------------------------------------------------------------------
// GEOMETRIA
// ---------------------------------------------------------------------------------------

test("EL RANGO INCLUYE LOS NIVELES DE STOP, no solo las velas", () => {
  // Un stop fuera del dibujo parece que estaba en otro sitio, que es peor que no dibujarlo.
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 101, 99, 100), v(2, 100, 101, 99, 100)];
  const traza: TrazaOp = {
    iEntrada: 1, entrada: 100, stopInicial: 50,
    pasos: [{ i: 1, nivel: 50 }, { i: 2, nivel: 50 }],
    iSalida: 2, salida: 50,
  };
  const g = geometria(velas, traza, ventana(velas, traza, 0));
  assert.ok(g.min <= 50, `el minimo ${g.min} tiene que llegar al stop`);
});

test("el precio maximo va arriba y el minimo abajo, dentro del margen", () => {
  const { velas, traza } = operacion();
  const w = ventana(velas, traza, 1);
  const g = geometria(velas, traza, w);
  assert.ok(Math.abs(g.y(g.max) - LIENZO.margen) < 1e-9);
  assert.ok(Math.abs(g.y(g.min) - (LIENZO.alto - LIENZO.margen)) < 1e-9);
  assert.ok(g.y(g.max) < g.y(g.min), "en SVG la y crece hacia abajo");
});

test("las velas van en orden de izquierda a derecha y ninguna se sale", () => {
  const { velas, traza } = operacion();
  const w = ventana(velas, traza, 1);
  const g = geometria(velas, traza, w);
  for (let i = w.desde; i < w.hasta; i += 1) {
    assert.ok(g.x(i) < g.x(i + 1), `la vela ${i + 1} no va despues de la ${i}`);
  }
  assert.ok(g.x(w.desde) - g.anchoVela / 2 >= 0);
  assert.ok(g.x(w.hasta) + g.anchoVela / 2 <= LIENZO.ancho);
});

test("UNA SERIE PLANA no divide entre cero", () => {
  const velas = [v(0, 5, 5, 5, 5), v(1, 5, 5, 5, 5)];
  const traza: TrazaOp = {
    iEntrada: 0, entrada: 5, stopInicial: 5, pasos: [{ i: 0, nivel: 5 }], iSalida: 1, salida: 5,
  };
  const g = geometria(velas, traza, ventana(velas, traza, 0));
  assert.ok(Number.isFinite(g.y(5)), "la y tiene que salir un numero");
  assert.ok(g.max > g.min);
});

// ---------------------------------------------------------------------------------------
// EL DIBUJO
// ---------------------------------------------------------------------------------------

test("EL STOP DIBUJADO ES EL DEL SIMULADOR, no uno recalculado", () => {
  // Es la razon de ser del modulo: si el dibujo recalculara, tranquilizaria mientras el
  // numero esta mal.
  const { velas, traza } = operacion();
  const g = geometria(velas, traza, ventana(velas, traza, 1));
  const svg = grafico(velas, {
    simbolo: "X", direccion: "LARGO", r: 1, motivo: "TRAILING", traza,
  }, 1);
  for (const paso of traza.pasos) {
    assert.ok(
      svg.includes(g.y(paso.nivel).toFixed(1)),
      `falta el nivel de la vela ${paso.i} (${paso.nivel})`,
    );
  }
});

test("el trailing sube: el stop de la ultima vela esta por encima del inicial", () => {
  const { traza } = operacion();
  const ultimo = traza.pasos[traza.pasos.length - 1]!;
  assert.ok(ultimo.nivel > traza.stopInicial, "esta operacion tiene que mover el stop");
});

test("una operacion de una sola vela tambien se dibuja", () => {
  const velas = [v(0, 100, 101, 99, 100), v(1, 100, 101, 80, 85), v(2, 85, 86, 84, 85)];
  const traza = {} as TrazaOp;
  const r = simularRuptura(
    velas, { i: 0, direccion: "LARGO", nivel: 101 }, 5, 2, 0, 0, 0, true, true, traza,
  );
  assert.equal(r!.motivo, "STOP");
  const svg = grafico(velas, {
    simbolo: "X", direccion: "LARGO", r: r!.r, motivo: r!.motivo, traza,
  });
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.endsWith("</svg>"));
});

test("el texto se escapa: un simbolo raro no rompe el SVG", () => {
  const { velas, traza } = operacion();
  const svg = grafico(velas, {
    simbolo: '<script>&"', direccion: "LARGO", r: 1, motivo: "FIN", traza,
  });
  assert.ok(!svg.includes("<script>"), "no puede quedar una etiqueta cruda");
  assert.ok(svg.includes("&lt;script&gt;"));
});

test("la R negativa se pinta en rojo y la positiva en verde", () => {
  const { velas, traza } = operacion();
  const base = { simbolo: "X", direccion: "LARGO" as const, motivo: "STOP", traza };
  assert.ok(grafico(velas, { ...base, r: -1 }).includes("#f85149"));
  assert.ok(grafico(velas, { ...base, r: 2 }).includes("#3fb950"));
});

test("la pagina mete cada grafico en su sitio y escapa el titulo", () => {
  const html = pagina("Peores <10>", "nota", ["<svg>a</svg>", "<svg>b</svg>"]);
  assert.equal(html.match(/<figure>/g)?.length, 2);
  assert.ok(html.includes("Peores &lt;10&gt;"));
  assert.ok(html.startsWith("<!doctype html>"));
});
