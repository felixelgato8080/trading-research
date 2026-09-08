/**
 * UNIVERSO DINAMICO: operar solo lo que era liquido EN SU MOMENTO.
 *
 * EL PROBLEMA QUE ARREGLA
 * -----------------------
 * Toda la investigacion usa las 31 criptos de hoy para los ultimos 12 años. Eso mete dos
 * mentiras a la vez:
 *
 *   1. Se opera en 2016 una moneda que entonces movia cuatro duros y no se podia comprar sin
 *      mover el precio uno mismo. El backtest da un llenado perfecto que en la realidad no
 *      existia.
 *   2. Se da por hecho que en 2016 ya sabias cuales de las 31 llegarian a 2026. No lo sabias.
 *
 * La rotacion por liquidez arregla lo primero del todo y lo segundo en parte: el ranking se
 * calcula SOLO con volumen pasado, asi que en cada fecha se opera lo que de verdad era grande
 * entonces, sin usar informacion del futuro.
 *
 * Lo que NO arregla: las monedas que murieron y no estan en la lista. Eso no tiene solucion con
 * datos gratis.
 */
import type { Vela } from "./datos";

/** Volumen en dolares de una vela. null si la fuente no da volumen. */
export function volumenDolar(v: Vela): number | null {
  if (v.v == null || !(v.v > 0)) return null;
  const precio = (v.h + v.l + v.c) / 3;
  return precio > 0 ? precio * v.v : null;
}

/**
 * Media del volumen en dolares de las `n` velas ANTERIORES a `hasta` (sin incluirla).
 *
 * Excluir la vela actual no es un detalle: el volumen del dia de la señal es justo el que se
 * dispara con la ruptura, y usarlo para decidir si el instrumento era liquido mezcla la señal
 * con el filtro.
 */
export function liquidezMedia(velas: Vela[], hasta: number, n: number): number | null {
  let suma = 0;
  let cuenta = 0;
  for (let i = Math.max(0, hasta - n); i < hasta; i += 1) {
    const d = volumenDolar(velas[i]!);
    if (d != null) {
      suma += d;
      cuenta += 1;
    }
  }
  return cuenta >= Math.max(3, n / 3) ? suma / cuenta : null;
}

export interface Indexado {
  velas: Vela[];
  pos: Map<number, number>;
}

export function indexarPorFecha(datos: Map<string, Vela[]>): Map<string, Indexado> {
  const out = new Map<string, Indexado>();
  for (const [s, velas] of datos) {
    const pos = new Map<number, number>();
    for (let i = 0; i < velas.length; i += 1) pos.set(velas[i]!.t, i);
    out.set(s, { velas, pos });
  }
  return out;
}

/**
 * Los `topN` instrumentos mas liquidos en la fecha `t`, mirando solo hacia atras.
 *
 * Un instrumento sin datos en esa fecha, o sin historia suficiente para medir su liquidez,
 * simplemente no entra. Es lo correcto: si no se puede saber si era liquido, no se opera.
 */
export function universoEn(
  idx: Map<string, Indexado>,
  t: number,
  topN: number,
  ventana: number,
): Set<string> {
  const ranking: Array<[string, number]> = [];
  for (const [s, ix] of idx) {
    const p = ix.pos.get(t);
    if (p == null) continue;
    const l = liquidezMedia(ix.velas, p, ventana);
    if (l == null || !(l > 0)) continue;
    ranking.push([s, l]);
  }
  ranking.sort((a, b) => b[1] - a[1]);
  return new Set(ranking.slice(0, topN).map(([s]) => s));
}

/**
 * Calendario de revision: una fecha cada `cada` velas del instrumento con mas historia.
 *
 * Revisar el universo en cada vela seria irreal (nadie rota la cartera a diario por liquidez) y
 * ademas caro de calcular.
 */
export function fechasRevision(idx: Map<string, Indexado>, cada: number): number[] {
  let mejor: Vela[] = [];
  for (const { velas } of idx.values()) if (velas.length > mejor.length) mejor = velas;
  const out: number[] = [];
  for (let i = 0; i < mejor.length; i += cada) out.push(mejor[i]!.t);
  return out;
}

/**
 * Para cada fecha de revision, que instrumentos estaban dentro. Se consulta con `estabaDentro`.
 */
export function calendarioUniverso(
  idx: Map<string, Indexado>,
  topN: number,
  ventana: number,
  cada: number,
): Array<{ t: number; dentro: Set<string> }> {
  return fechasRevision(idx, cada).map((t) => ({ t, dentro: universoEn(idx, t, topN, ventana) }));
}

/**
 * ¿Estaba `instrumento` en el universo en el momento `t`?
 *
 * Se usa la ultima revision ANTERIOR o igual a `t`. Usar la siguiente seria saber hoy quien
 * sera liquido mañana.
 */
export function estabaDentro(
  calendario: Array<{ t: number; dentro: Set<string> }>,
  instrumento: string,
  t: number,
): boolean {
  let elegido: Set<string> | null = null;
  for (const c of calendario) {
    if (c.t > t) break;
    elegido = c.dentro;
  }
  return elegido ? elegido.has(instrumento) : false;
}
