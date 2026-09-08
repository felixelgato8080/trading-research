/**
 * Juntar velas pequeñas en velas grandes, y detectar cuerpos degenerados.
 *
 * POR QUE EXISTE ESTO
 * -------------------
 * Las velas DIARIAS de forex de Yahoo tienen la apertura y el cierre practicamente iguales: el
 * cuerpo mide de media el 2,3% del rango, la mediana el 1,3%, y el 24,7% de las velas tienen la
 * apertura EXACTAMENTE igual al cierre. Los maximos y minimos si son buenos.
 *
 * No es un problema de Yahoo en general: sus ETF diarios dan 47,2% de cuerpo/rango, y Binance da
 * 42,9%. Es la serie de divisas.
 *
 * Cualquier regla que mire el CUERPO (ruptura de volatilidad, "vela impulsiva", envolventes)
 * medida sobre esa serie no mide la regla, mide el defecto: la ruptura de volatilidad daba 3
 * operaciones en 1,8 años sobre 28 pares, y 217 en 2,5 años sobre los mismos pares con el cuerpo
 * arreglado. Un rechazo sacado de ahi no es un rechazo.
 *
 * El arreglo es juntar las velas de 1 hora, donde la apertura y el cierre si son de instantes
 * distintos (39,0% de cuerpo/rango).
 */
import type { Vela } from "./datos";

/** Clave de agrupacion. Devuelve el mismo texto para las velas que van juntas. */
export type Agrupador = (t: number) => string;

/** Por dia natural en UTC. */
export const porDia: Agrupador = (t) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * Junta velas en grupos consecutivos.
 *
 * La apertura es la de la PRIMERA vela del grupo y el cierre el de la ULTIMA, que es justo lo
 * que la serie diaria de divisas de Yahoo no respeta. El volumen se suma.
 *
 * Espera las velas ordenadas por tiempo. Un grupo que reaparece mas tarde (datos desordenados)
 * se trata como grupo nuevo en vez de fusionarse a distancia, porque fusionarlo mezclaria
 * aperturas y cierres de momentos que no se tocan.
 */
export function agregar(velas: Vela[], clave: Agrupador = porDia): Vela[] {
  const out: Vela[] = [];
  let actual = "";
  for (const v of velas) {
    const k = clave(v.t);
    const ultima = out[out.length - 1];
    if (k !== actual || !ultima) {
      out.push({ t: v.t, o: v.o, h: v.h, l: v.l, c: v.c, v: v.v ?? 0 });
      actual = k;
      continue;
    }
    ultima.h = Math.max(ultima.h, v.h);
    ultima.l = Math.min(ultima.l, v.l);
    ultima.c = v.c;
    ultima.v = (ultima.v ?? 0) + (v.v ?? 0);
  }
  return out;
}

export interface SaludCuerpo {
  velas: number;
  /** Media de |cierre - apertura| / (maximo - minimo). Sano ronda 0,40. */
  cuerpoMedio: number;
  /** Fraccion de velas con apertura EXACTAMENTE igual al cierre. */
  cuerpoCero: number;
}

/**
 * Mide si los cuerpos de una serie sirven para algo.
 *
 * Referencias medidas: Binance diario 0,429 · ETF de Yahoo 0,472 · forex 1h de Yahoo 0,390 ·
 * forex DIARIO de Yahoo 0,023 con un 24,7% de cuerpos exactamente cero.
 */
export function saludCuerpo(velas: Vela[]): SaludCuerpo {
  let n = 0, suma = 0, cero = 0;
  for (const v of velas) {
    const rango = v.h - v.l;
    if (!(rango > 0)) continue;
    n += 1;
    const cuerpo = Math.abs(v.c - v.o);
    suma += cuerpo / rango;
    if (cuerpo === 0) cero += 1;
  }
  return {
    velas: n,
    cuerpoMedio: n ? suma / n : 0,
    cuerpoCero: n ? cero / n : 0,
  };
}
