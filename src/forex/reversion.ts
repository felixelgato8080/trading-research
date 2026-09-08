/**
 * Familia de ALTO ACIERTO: reversion a la media, huecos y efecto nocturno.
 *
 * POR QUE MERECE PROBARSE APARTE
 * ------------------------------
 * La ruptura da 25% de acierto con ganadoras de 3,6R. Esta familia es la contraria: 60-80% de
 * acierto con ganadoras pequeñas. Las dos pueden dar PF>1; lo que decide es si
 * acierto x ganadora supera a fallo x perdedora.
 *
 * Y hay una diferencia clave con lo que ya fallo. En forex intradia probamos RSI
 * CONTRA-tendencia y el filtro de tendencia lo empeoraba, porque son premisas opuestas. Aqui
 * la premisa es otra: comprar retrocesos DENTRO de una tendencia alcista. Ahi el filtro no
 * contradice la señal, la completa.
 *
 * Todo puro y sin mirar el futuro.
 */
import type { Vela } from "./datos";
import { rsi } from "./rsi";

export interface SeñalReversion {
  i: number;
  direccion: "LARGO" | "CORTO";
}

/** Media simple de los ultimos `n` cierres, sin incluir velas futuras. */
export function sma(cierres: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(cierres.length).fill(null);
  let suma = 0;
  for (let i = 0; i < cierres.length; i += 1) {
    suma += cierres[i]!;
    if (i >= n) suma -= cierres[i - n]!;
    if (i >= n - 1) out[i] = suma / n;
  }
  return out;
}

/**
 * Retroceso en tendencia (estilo Connors): RSI corto muy bajo, con el precio por encima de su
 * media larga.
 *
 * `soloEnTendencia` es el parametro que separa esto del RSI contra-tendencia que ya fallo: sin
 * el, se compran caidas en mercados que se estan hundiendo.
 */
export function retrocesoEnTendencia(
  velas: Vela[],
  periodoRsi: number,
  umbral: number,
  periodoMedia: number,
  soloEnTendencia = true,
): SeñalReversion[] {
  const cierres = velas.map((v) => v.c);
  const r = rsi(cierres, periodoRsi);
  const m = sma(cierres, periodoMedia);
  const out: SeñalReversion[] = [];

  for (let i = 0; i < velas.length; i += 1) {
    const rv = r[i];
    const mv = m[i];
    if (rv == null) continue;
    if (soloEnTendencia && (mv == null || cierres[i]! <= mv)) continue;
    if (rv < umbral) out.push({ i, direccion: "LARGO" });
  }
  return out;
}

/**
 * Hueco a la baja: el precio abre por debajo del cierre anterior mas de `k` ATR.
 *
 * En indices y ETFs los huecos tienden a rellenarse. Se mide en ATR para que el criterio
 * signifique lo mismo en un ETF de bonos que en uno de cripto.
 */
export function huecoBajista(
  velas: Vela[],
  atrValores: (number | null)[],
  k: number,
  mediaLarga: (number | null)[] | null,
): SeñalReversion[] {
  const out: SeñalReversion[] = [];
  for (let i = 1; i < velas.length; i += 1) {
    const a = atrValores[i - 1];
    if (a == null || !(a > 0)) continue;
    const cierreAyer = velas[i - 1]!.c;
    if (cierreAyer - velas[i]!.o < a * k) continue;
    // Un hueco a la baja dentro de una tendencia bajista no es un hueco: es la tendencia.
    if (mediaLarga) {
      const mv = mediaLarga[i - 1];
      if (mv == null || cierreAyer <= mv) continue;
    }
    out.push({ i, direccion: "LARGO" });
  }
  return out;
}

export interface ResultadoRev {
  r: number;
  velas: number;
  motivo: "OBJETIVO" | "STOP" | "TIEMPO" | "FIN";
}

/**
 * Sale cuando la razon de la entrada deja de existir, no en un objetivo fijo de R.
 *
 * En esta familia el objetivo natural es "el precio ya volvio": cerrar por encima del maximo
 * de ayer, o que el RSI recupere. Un objetivo en R fijo no tiene sentido cuando la premisa es
 * la vuelta a la media.
 *
 * `stopATR` sigue existiendo porque una reversion que no revierte hay que cortarla: sin stop,
 * el 20% de fallos se convierte en ruina.
 */
export function simularReversion(
  velas: Vela[],
  s: SeñalReversion,
  stop: number,
  coste: number,
  maxVelas: number,
  salirRsi: (number | null)[] | null,
  umbralSalida: number,
): ResultadoRev | null {
  const i0 = s.i + 1;
  if (i0 >= velas.length || !(stop > 0)) return null;

  const entrada = velas[i0]!.o + coste;
  const nivelStop = entrada - stop;

  for (let j = i0; j < velas.length; j += 1) {
    const v = velas[j]!;
    // El stop primero: si en la vela se tocan las dos cosas, no sabemos el orden.
    if (v.l <= nivelStop) {
      return { r: (nivelStop - coste - entrada) / stop, velas: j - i0, motivo: "STOP" };
    }
    // Salida por reversion cumplida: cierre por encima del maximo de la vela anterior, o RSI
    // recuperado. Se comprueba al CIERRE, que es cuando se conoce.
    const revirtio = j > i0 && v.c > velas[j - 1]!.h;
    const rsiOk = salirRsi ? (salirRsi[j] ?? 0) > umbralSalida : false;
    if (revirtio || rsiOk) {
      return { r: (v.c - coste - entrada) / stop, velas: j - i0, motivo: "OBJETIVO" };
    }
    if (maxVelas > 0 && j - i0 >= maxVelas) {
      return { r: (v.c - coste - entrada) / stop, velas: j - i0, motivo: "TIEMPO" };
    }
  }
  const fin = velas[velas.length - 1]!;
  return { r: (fin.c - coste - entrada) / stop, velas: velas.length - 1 - i0, motivo: "FIN" };
}
