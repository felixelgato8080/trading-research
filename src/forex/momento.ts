/**
 * MOMENTO TRANSVERSAL: en vez de cronometrar cada activo, se ordenan todos y se tienen los
 * mejores.
 *
 * POR QUE ESTA FAMILIA ES DISTINTA A TODO LO ANTERIOR
 * ---------------------------------------------------
 * Todo lo probado hasta ahora decide instrumento por instrumento: ¿compro SPY hoy? Aqui la
 * pregunta es otra: de estos 32, ¿cuales son los 5 mejores AHORA? Es una decision relativa, y
 * eso cambia dos cosas:
 *
 *   - El dinero esta siempre invertido en algo, asi que no depende de acertar el momento.
 *   - Se rebalancea una vez al mes, asi que el coste por operacion es ridiculo frente al
 *     movimiento: 12 cambios al año, no 250.
 *
 * Es el efecto mejor documentado que existe (Jegadeesh-Titman 1993) y no lo habia medido.
 *
 * DOS DEFENSAS CONTRA MIRAR EL FUTURO, que es donde esta familia engaña con mas facilidad:
 *   1. El orden se calcula con cierres HASTA el dia de rebalanceo; se entra en la APERTURA del
 *      dia siguiente. Rankear y comprar al mismo cierre es imposible en la practica.
 *   2. El `hueco` salta los dias mas recientes. Sin el, el ranking premia al que acaba de
 *      subir, y a una semana eso REVIERTE. Son dos efectos distintos y mezclarlos los anula.
 */
import type { Vela } from "./datos";

export interface Ajustes {
  /** Dias de calendario propio usados para medir la fuerza. */
  lookback: number;
  /** Dias recientes que se ignoran al medir (reversion a corto plazo). */
  hueco: number;
  /** Cuantos instrumentos se mantienen. */
  cartera: number;
  /** Cada cuantos dias se revisa. */
  rebalanceo: number;
  /** Exigir ademas que el rendimiento propio sea positivo (momento "dual"). */
  absoluto: boolean;
  /** Coste por cambio de posicion, en fraccion del valor. 0.001 = 0,1%. */
  coste: number;
}

export interface Periodo {
  tInicio: number;
  tFin: number;
  seleccion: string[];
  /** Retorno del periodo en fraccion, ya con costes. */
  retorno: number;
  /** Cuantas posiciones cambiaron respecto al periodo anterior. */
  cambios: number;
}

export interface Resultado {
  periodos: Periodo[];
  curva: Array<{ t: number; capital: number }>;
  capitalFinal: number;
  maxCaida: number;
  /** Fraccion de periodos en positivo. */
  aciertoPeriodos: number;
  rotacionMedia: number;
}

interface Indice {
  velas: Vela[];
  /** De timestamp a posicion dentro de `velas`. */
  pos: Map<number, number>;
}

export function indexar(datos: Map<string, Vela[]>): Map<string, Indice> {
  const out = new Map<string, Indice>();
  for (const [s, velas] of datos) {
    const pos = new Map<number, number>();
    for (let i = 0; i < velas.length; i += 1) pos.set(velas[i]!.t, i);
    out.set(s, { velas, pos });
  }
  return out;
}

/**
 * Calendario comun: las fechas del instrumento con mas historia.
 *
 * Cada instrumento se consulta por SU propio indice, asi que uno que empiece tarde (ETH) o que
 * tenga festivos distintos no descuadra nada: simplemente no es elegible esos dias.
 */
export function calendario(idx: Map<string, Indice>): number[] {
  let mejor: Vela[] = [];
  for (const { velas } of idx.values()) if (velas.length > mejor.length) mejor = velas;
  return mejor.map((v) => v.t);
}

/**
 * Fuerza de un instrumento en la fecha `t`: retorno entre `lookback + hueco` dias atras y
 * `hueco` dias atras, medido con SUS propias barras.
 *
 * Devuelve null si no hay historia suficiente o si la fecha no existe para ese instrumento.
 */
export function fuerza(i: Indice, t: number, lookback: number, hueco: number): number | null {
  const p = i.pos.get(t);
  if (p == null) return null;
  const fin = p - hueco;
  const ini = fin - lookback;
  if (ini < 0 || fin < 0) return null;
  const a = i.velas[ini]!.c;
  const b = i.velas[fin]!.c;
  if (!(a > 0) || !(b > 0)) return null;
  return b / a - 1;
}

/**
 * Retorno de mantener un instrumento desde la APERTURA del dia siguiente a `desde` hasta la
 * apertura del dia siguiente a `hasta`.
 *
 * El "dia siguiente" es literal: se busca la barra posterior en el calendario del propio
 * instrumento. Si no la tiene (cotiza otros dias), devuelve null y esa posicion no cuenta.
 */
export function retornoEntre(i: Indice, desde: number, hasta: number): number | null {
  const p0 = i.pos.get(desde);
  const p1 = i.pos.get(hasta);
  if (p0 == null || p1 == null) return null;
  const a = i.velas[p0 + 1];
  const b = i.velas[p1 + 1];
  if (!a || !b || !(a.o > 0) || !(b.o > 0)) return null;
  return b.o / a.o - 1;
}

export function simular(idx: Map<string, Indice>, fechas: number[], aj: Ajustes): Resultado {
  const periodos: Periodo[] = [];
  const curva: Array<{ t: number; capital: number }> = [];
  let capital = 1;
  let pico = 1;
  let maxCaida = 0;
  let anterior: string[] = [];
  let sumaCambios = 0;

  for (let k = 0; k + aj.rebalanceo < fechas.length; k += aj.rebalanceo) {
    const t0 = fechas[k]!;
    const t1 = fechas[k + aj.rebalanceo]!;

    const medibles: Array<[string, number]> = [];
    for (const [s, i] of idx) {
      const f = fuerza(i, t0, aj.lookback, aj.hueco);
      if (f != null) medibles.push([s, f]);
    }
    // Sin historia suficiente no hay decision que tomar. Ese periodo NO existe: contarlo como
    // un periodo plano bajaria la caida maxima y falsearia el acierto por periodo. Es distinto
    // de que el filtro absoluto deje la cartera vacia, que si es una decision de estar fuera.
    if (medibles.length === 0) continue;

    const ranking = aj.absoluto ? medibles.filter(([, f]) => f > 0) : medibles;
    ranking.sort((a, b) => b[1] - a[1]);
    const seleccion = ranking.slice(0, aj.cartera).map(([s]) => s);

    const retornos: number[] = [];
    for (const s of seleccion) {
      const r = retornoEntre(idx.get(s)!, t0, t1);
      if (r != null) retornos.push(r);
    }
    // Sin candidatos (momento absoluto en un mercado bajista) el dinero se queda quieto.
    const bruto = retornos.length ? retornos.reduce((a, b) => a + b, 0) / retornos.length : 0;

    const cambios = seleccion.filter((s) => !anterior.includes(s)).length;
    sumaCambios += seleccion.length ? cambios / seleccion.length : 0;
    // Se paga al vender lo que sale y al comprar lo que entra: dos lados por cada cambio.
    const peaje = seleccion.length ? (2 * cambios * aj.coste) / seleccion.length : 0;
    const neto = bruto - peaje;

    capital *= 1 + neto;
    pico = Math.max(pico, capital);
    maxCaida = Math.max(maxCaida, pico > 0 ? (pico - capital) / pico : 0);
    curva.push({ t: t1, capital });
    periodos.push({ tInicio: t0, tFin: t1, seleccion, retorno: neto, cambios });
    anterior = seleccion;
  }

  return {
    periodos,
    curva,
    capitalFinal: capital,
    maxCaida,
    aciertoPeriodos: periodos.length
      ? periodos.filter((p) => p.retorno > 0).length / periodos.length
      : 0,
    rotacionMedia: periodos.length ? sumaCambios / periodos.length : 0,
  };
}

/**
 * Comprar y mantener todo el universo a partes iguales, rebalanceando igual de a menudo.
 *
 * Es el control obligatorio: si el ranking no supera a "tenerlo todo", el ranking no aporta
 * nada y lo unico medido es que los mercados suben. Es la misma trampa que ya invalido un
 * hallazgo en este proyecto.
 */
export function control(idx: Map<string, Indice>, fechas: number[], rebalanceo: number): Resultado {
  return simular(idx, fechas, {
    lookback: 1,
    hueco: 0,
    cartera: idx.size,
    rebalanceo,
    absoluto: false,
    coste: 0,
  });
}
