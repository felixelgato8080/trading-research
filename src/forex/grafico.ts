/**
 * Dibujar una operacion TAL COMO LA VIO EL SIMULADOR.
 *
 * POR QUE EXISTE
 * --------------
 * Todo en este proyecto se ha medido con numeros y no se ha mirado ni una operacion dibujada.
 * Eso deja pasar una clase de fallo que ninguna prueba atrapa: un stop en un sitio absurdo, una
 * señal que a ojo no tiene sentido, una salida que no cuadra con las velas.
 *
 * LA REGLA: SE DIBUJA EL RASTRO, NO UN RECALCULO
 * ----------------------------------------------
 * El dibujo sale de la `TrazaOp` que devuelve el simulador. Si el grafico recalculara la
 * operacion por su cuenta podria diferir del backtest, y entonces tranquilizaria mientras el
 * numero esta mal: justo el fallo que se pretende cazar mirando.
 *
 * Y se dibujan las velas del backtest, no las de ninguna plataforma de terceros. Un grafico de
 * EURUSD en cualquier plataforma se ve perfecto, y no habria enseñado nunca que el diario de
 * divisas de Yahoo tiene el cuerpo roto. Ver lo que midio el simulador es el punto entero.
 */
import type { Vela } from "./datos";
import type { TrazaOp } from "./rupturas";

export interface Lienzo {
  ancho: number;
  alto: number;
  margen: number;
}

export const LIENZO: Lienzo = { ancho: 760, alto: 300, margen: 44 };

export interface Ventana {
  desde: number;
  hasta: number;
}

/**
 * Que velas se enseñan: la operacion mas un margen a cada lado para ver de donde venia.
 *
 * Se recorta a los limites del array. Pedir contexto que no existe no es un error: simplemente
 * no hay nada antes del principio de la serie.
 */
export function ventana(velas: Vela[], t: TrazaOp, margen: number): Ventana {
  return {
    desde: Math.max(0, t.iEntrada - margen),
    hasta: Math.min(velas.length - 1, t.iSalida + margen),
  };
}

export interface Geometria {
  min: number;
  max: number;
  /** Centro de la vela `i`, en pixeles. */
  x(i: number): number;
  y(precio: number): number;
  anchoVela: number;
}

/**
 * La escala.
 *
 * El rango de precios incluye los NIVELES DE STOP ademas de las velas: un stop que se sale del
 * dibujo es peor que no dibujarlo, porque parece que estaba en otro sitio.
 */
export function geometria(
  velas: Vela[],
  t: TrazaOp,
  v: Ventana,
  l: Lienzo = LIENZO,
): Geometria {
  let min = Infinity;
  let max = -Infinity;
  for (let i = v.desde; i <= v.hasta; i += 1) {
    const c = velas[i];
    if (!c) continue;
    min = Math.min(min, c.l);
    max = Math.max(max, c.h);
  }
  for (const p of t.pasos) {
    min = Math.min(min, p.nivel);
    max = Math.max(max, p.nivel);
  }
  min = Math.min(min, t.entrada, t.salida);
  max = Math.max(max, t.entrada, t.salida);

  // Una serie plana no puede dividir entre cero. Se le da un rango simbolico y se centra.
  if (!(max > min)) {
    const centro = Number.isFinite(min) ? min : 0;
    min = centro - 1;
    max = centro + 1;
  }

  const n = v.hasta - v.desde + 1;
  const util = l.ancho - l.margen * 2;
  const paso = n > 0 ? util / n : util;
  return {
    min,
    max,
    anchoVela: Math.max(1, paso * 0.62),
    x: (i) => l.margen + (i - v.desde + 0.5) * paso,
    y: (p) => l.alto - l.margen - ((p - min) / (max - min)) * (l.alto - l.margen * 2),
  };
}

export interface OpDibujable {
  simbolo: string;
  direccion: "LARGO" | "CORTO";
  r: number;
  motivo: string;
  traza: TrazaOp;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n2 = (x: number): string => (Math.abs(x) >= 1 ? x.toFixed(4) : x.toExponential(3));
const dia = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

/** Una operacion como SVG independiente. Sin dependencias: se abre en cualquier navegador. */
export function grafico(
  velas: Vela[],
  op: OpDibujable,
  margenVelas = 12,
  l: Lienzo = LIENZO,
): string {
  const t = op.traza;
  const v = ventana(velas, t, margenVelas);
  const g = geometria(velas, t, v, l);
  const partes: string[] = [];

  for (let i = v.desde; i <= v.hasta; i += 1) {
    const c = velas[i];
    if (!c) continue;
    const x = g.x(i);
    const color = c.c >= c.o ? "#3fb950" : "#f85149";
    const yA = g.y(Math.max(c.o, c.c));
    const yB = g.y(Math.min(c.o, c.c));
    // Las velas de fuera de la operacion van apagadas: son contexto, no la decision.
    const opacidad = i >= t.iEntrada && i <= t.iSalida ? "1" : "0.35";
    partes.push(
      `<line x1="${x.toFixed(1)}" y1="${g.y(c.h).toFixed(1)}" x2="${x.toFixed(1)}" y2="${g.y(c.l).toFixed(1)}" stroke="${color}" stroke-width="1" opacity="${opacidad}"/>`,
      `<rect x="${(x - g.anchoVela / 2).toFixed(1)}" y="${yA.toFixed(1)}" width="${g.anchoVela.toFixed(1)}" height="${Math.max(1, yB - yA).toFixed(1)}" fill="${color}" opacity="${opacidad}"/>`,
    );
  }

  // El camino del stop, en escalones. Es lo que enseña el trailing moviendose.
  if (t.pasos.length) {
    const d: string[] = [];
    for (let k = 0; k < t.pasos.length; k += 1) {
      const p = t.pasos[k]!;
      const x0 = g.x(p.i) - g.anchoVela / 2;
      const x1 = g.x(p.i) + g.anchoVela / 2;
      const y = g.y(p.nivel).toFixed(1);
      d.push(`${k === 0 ? "M" : "L"} ${x0.toFixed(1)} ${y} L ${x1.toFixed(1)} ${y}`);
    }
    partes.push(
      `<path d="${d.join(" ")}" fill="none" stroke="#f0883e" stroke-width="1.6" stroke-dasharray="4 3"/>`,
    );
  }

  const xe = g.x(t.iEntrada);
  const xs = g.x(t.iSalida);
  partes.push(
    `<line x1="${(xe - g.anchoVela).toFixed(1)}" y1="${g.y(t.entrada).toFixed(1)}" x2="${(xs + g.anchoVela).toFixed(1)}" y2="${g.y(t.entrada).toFixed(1)}" stroke="#58a6ff" stroke-width="1.2"/>`,
    `<circle cx="${xe.toFixed(1)}" cy="${g.y(t.entrada).toFixed(1)}" r="3.5" fill="#58a6ff"/>`,
    `<circle cx="${xs.toFixed(1)}" cy="${g.y(t.salida).toFixed(1)}" r="3.5" fill="#f0883e"/>`,
  );

  const gana = op.r >= 0;
  const cab = `${op.simbolo} · ${op.direccion} · ${gana ? "+" : ""}${op.r.toFixed(2)}R · ${op.motivo}`;
  const pie =
    `entrada ${n2(t.entrada)} · stop ${n2(t.stopInicial)} · salida ${n2(t.salida)} · ` +
    `${t.pasos.length} velas · ${dia(velas[t.iEntrada]?.t ?? 0)} → ${dia(velas[t.iSalida]?.t ?? 0)}`;

  return (
    `<svg viewBox="0 0 ${l.ancho} ${l.alto}" xmlns="http://www.w3.org/2000/svg" width="100%" role="img" aria-label="${esc(cab)}">` +
    `<rect width="${l.ancho}" height="${l.alto}" fill="#0d1117"/>` +
    `<text x="${l.margen}" y="24" fill="${gana ? "#3fb950" : "#f85149"}" font-family="ui-monospace,monospace" font-size="13" font-weight="600">${esc(cab)}</text>` +
    `<text x="${l.margen}" y="${l.alto - 14}" fill="#8b949e" font-family="ui-monospace,monospace" font-size="10">${esc(pie)}</text>` +
    `<text x="${l.ancho - l.margen}" y="24" fill="#8b949e" text-anchor="end" font-family="ui-monospace,monospace" font-size="10">${n2(g.max)}</text>` +
    `<text x="${l.ancho - l.margen}" y="${l.alto - l.margen}" fill="#8b949e" text-anchor="end" font-family="ui-monospace,monospace" font-size="10">${n2(g.min)}</text>` +
    partes.join("") +
    `</svg>`
  );
}

/** Varias operaciones en una pagina que se abre en cualquier navegador. */
export function pagina(titulo: string, nota: string, svgs: string[]): string {
  const estilo =
    "body{background:#010409;color:#c9d1d9;font:14px ui-monospace,monospace;margin:0;padding:24px}" +
    "h1{font-size:16px;margin:0 0 4px}" +
    "p{color:#8b949e;font-size:12px;margin:0 0 20px;max-width:74ch;line-height:1.6}" +
    "figure{margin:0 0 18px;border:1px solid #21262d;border-radius:6px;overflow:hidden}";
  const leyenda =
    "Velas verdes suben, rojas bajan; las apagadas son contexto, fuera de la operacion. " +
    "Linea azul: precio de entrada. Linea naranja a trazos: donde estaba el stop durante cada " +
    "vela, asi que si sube en escalones eso es el trailing. Circulo naranja: la salida.";
  return (
    `<!doctype html><meta charset="utf-8"><title>${esc(titulo)}</title>` +
    `<style>${estilo}</style>` +
    `<h1>${esc(titulo)}</h1><p>${esc(nota)}</p>` +
    svgs.map((s) => `<figure>${s}</figure>`).join("") +
    `<p>${esc(leyenda)}</p>`
  );
}
