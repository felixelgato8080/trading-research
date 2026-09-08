/**
 * Velas desde Binance: la fuente REAL del mercado donde se operaria.
 *
 * POR QUE IMPORTA
 * ---------------
 * Yahoo no es un exchange: agrega precios de varias fuentes. Sus maximos y minimos diarios de
 * cripto pueden no ser los que imprimio el libro de ordenes de Binance, y toda la estrategia
 * depende de ellos: el stop salta con el minimo y el trailing se mueve con el maximo.
 *
 *   - Si Yahoo da rangos MAS ANCHOS que el exchange, mis stops saltan de mas y el backtest es
 *     pesimista.
 *   - Si los da MAS ESTRECHOS, saltan de menos y el backtest es optimista, que es el caso grave.
 *
 * No hace falta clave: el endpoint de klines es publico.
 */
import axios from "axios";
import type { Vela } from "./datos";

/**
 * Vela con datos de FLUJO, que las velas normales no traen.
 *
 * Binance devuelve en cada kline el volumen que entro AGREDIENDO por el lado comprador (campo
 * 9). Con eso y el volumen total sale el delta, que es la diferencia entre compra agresiva y
 * venta agresiva: exactamente lo que miran los operadores de order flow, y que yo estaba
 * tirando a la basura.
 *
 * No es lo mismo que un footprint tick a tick, pero captura lo esencial: quien esta pagando
 * por cruzar el spread.
 */
export interface VelaFlujo extends Vela {
  /** Volumen que entro comprando a mercado. */
  compraAgresiva: number;
  /** Numero de operaciones. Sirve para estimar el tamaño medio de orden. */
  operaciones: number;
}

const LIMITE = 1000;

/**
 * Velas de un simbolo de Binance (BTCUSDT, ETHUSDT...).
 *
 * Se pagina hacia atras porque la API devuelve como mucho 1.000 velas por peticion. `maxVelas`
 * limita el total para no encadenar decenas de llamadas sin querer.
 */
export async function velasBinance(
  simbolo: string,
  intervalo: "1d" | "1h" | "5m" | "15m",
  maxVelas = 2000,
): Promise<VelaFlujo[]> {
  const out: VelaFlujo[] = [];
  let hasta: number | undefined;

  while (out.length < maxVelas) {
    const { data } = await axios.get("https://api.binance.com/api/v3/klines", {
      params: {
        symbol: simbolo,
        interval: intervalo,
        limit: Math.min(LIMITE, maxVelas - out.length),
        ...(hasta ? { endTime: hasta } : {}),
      },
      timeout: 30_000,
    });
    if (!Array.isArray(data) || data.length === 0) break;

    const trozo: VelaFlujo[] = [];
    for (const k of data) {
      const t = Math.floor(Number(k[0]) / 1000);
      const o = Number(k[1]);
      const h = Number(k[2]);
      const l = Number(k[3]);
      const c = Number(k[4]);
      const v = Number(k[5]);
      const ops = Number(k[8]);
      const compra = Number(k[9]);
      if (![t, o, h, l, c].every(Number.isFinite)) continue;
      trozo.push({
        t, o, h, l, c,
        ...(Number.isFinite(v) ? { v } : {}),
        compraAgresiva: Number.isFinite(compra) ? compra : 0,
        operaciones: Number.isFinite(ops) ? ops : 0,
      });
    }
    if (trozo.length === 0) break;

    out.unshift(...trozo);
    // Se retrocede un milisegundo antes de la primera vela recibida.
    hasta = trozo[0]!.t * 1000 - 1;
    if (data.length < LIMITE) break;
  }

  // Puede haber solapes al paginar; se dejan unicas y en orden.
  const porT = new Map<number, VelaFlujo>();
  for (const v of out) porT.set(v.t, v);
  return [...porT.values()].sort((a, b) => a.t - b.t);
}

export interface Discrepancia {
  dia: string;
  campo: "o" | "h" | "l" | "c";
  yahoo: number;
  real: number;
  /** Diferencia en fraccion del precio de Binance. */
  relativa: number;
}

export interface Comparacion {
  comunes: number;
  soloYahoo: number;
  soloBinance: number;
  /** Diferencia relativa media por campo. */
  medias: Record<"o" | "h" | "l" | "c", number>;
  /** Cuantas veces el RANGO de Yahoo fue mas ancho que el real, y cuantas mas estrecho. */
  rangoMasAncho: number;
  rangoMasEstrecho: number;
  peores: Discrepancia[];
}

/**
 * Compara dos series por fecha. Solo mira los dias que existen en las dos: un dia que falta en
 * una fuente no es una discrepancia de precio, es otro problema y se cuenta aparte.
 */
export function comparar(yahoo: Vela[], real: Vela[], tolerancia = 0.002): Comparacion {
  const porT = new Map<number, Vela>();
  for (const v of real) porT.set(v.t, v);

  const campos: Array<"o" | "h" | "l" | "c"> = ["o", "h", "l", "c"];
  const sumas: Record<string, number> = { o: 0, h: 0, l: 0, c: 0 };
  const peores: Discrepancia[] = [];
  let comunes = 0;
  let soloYahoo = 0;
  let rangoMasAncho = 0;
  let rangoMasEstrecho = 0;

  for (const y of yahoo) {
    const r = porT.get(y.t);
    if (!r) {
      soloYahoo += 1;
      continue;
    }
    comunes += 1;
    for (const c of campos) {
      if (!(r[c] > 0)) continue;
      const rel = Math.abs(y[c] - r[c]) / r[c];
      sumas[c] = (sumas[c] ?? 0) + rel;
      if (rel > tolerancia) {
        peores.push({
          dia: new Date(y.t * 1000).toISOString().slice(0, 10),
          campo: c,
          yahoo: y[c],
          real: r[c],
          relativa: rel,
        });
      }
    }
    const rangoY = y.h - y.l;
    const rangoR = r.h - r.l;
    if (rangoY > rangoR * 1.001) rangoMasAncho += 1;
    else if (rangoY < rangoR * 0.999) rangoMasEstrecho += 1;
  }

  const vistos = new Set(yahoo.map((v) => v.t));
  const soloBinance = real.filter((v) => !vistos.has(v.t)).length;

  peores.sort((a, b) => b.relativa - a.relativa);
  return {
    comunes,
    soloYahoo,
    soloBinance,
    medias: {
      o: comunes ? sumas.o! / comunes : 0,
      h: comunes ? sumas.h! / comunes : 0,
      l: comunes ? sumas.l! / comunes : 0,
      c: comunes ? sumas.c! / comunes : 0,
    },
    rangoMasAncho,
    rangoMasEstrecho,
    peores: peores.slice(0, 10),
  };
}
