/**
 * Velas de forex desde Yahoo Finance. Gratis, sin clave.
 *
 * Alcance real, medido el 7 sep 2026:
 *   1d   ~3.900 velas desde 2011   (los 7 pares probados)
 *   1h   ~17.100 velas desde 2023
 *   15m  60 dias
 *   5m   30 dias
 *
 * O sea: para comparar epocas solo sirve el diario; para intradia hay 2,8 años en 1h y poco
 * mas de un mes en 5m. Conviene tenerlo presente antes de sacar conclusiones de 5m.
 */
import axios from "axios";

export interface Vela {
  /** Epoch en segundos. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /**
   * Volumen. Opcional porque no todas las fuentes lo dan: en forex al contado no existe un
   * volumen central, y Yahoo devuelve 0 o null en los pares. En cripto, acciones y ETFs es real.
   *
   * Quien lo use TIENE que comprobar que existe y que no es cero, o medira sobre ceros y
   * concluira que el volumen no aporta nada.
   */
  v?: number;
}

export type Temporalidad = "5m" | "15m" | "1h" | "1d";

/**
 * ¿Es una vela posible? Filtra basura que ninguna fuente deberia dar pero da.
 *
 * Medido el 7 sep sobre las caches: Yahoo servia 261 velas de cripto con algun precio en CERO
 * (SHIB tenia 259, el 12% de su historia, de cuando aun no cotizaba de verdad) y 2.417 velas de
 * forex con el cierre o la apertura FUERA del rango maximo-minimo. Las dos cosas son imposibles
 * en un mercado real y las dos envenenan un backtest con stops: un minimo en cero dispara
 * cualquier stop, y un cierre fuera del rango descuadra el trailing.
 *
 * La tolerancia de 1e-4 existe porque las fuentes redondean cada campo por separado y el cierre
 * puede quedar un pelo fuera del maximo sin que eso sea un error de verdad.
 */
export function esVelaValida(v: Vela): boolean {
  if (![v.o, v.h, v.l, v.c].every((x) => Number.isFinite(x) && x > 0)) return false;
  if (v.h < v.l) return false;
  const tol = 1e-4;
  if (v.o > v.h * (1 + tol) || v.o < v.l * (1 - tol)) return false;
  if (v.c > v.h * (1 + tol) || v.c < v.l * (1 - tol)) return false;
  return true;
}

/** Deja solo las velas posibles. Para limpiar caches ya descargadas. */
export function limpiarVelas(velas: Vela[]): Vela[] {
  return velas.filter(esVelaValida);
}

/** Rango maximo que Yahoo sirve para cada temporalidad. Pedir mas devuelve menos, no error. */
const RANGO: Record<Temporalidad, string> = {
  "5m": "60d",
  "15m": "60d",
  "1h": "730d",
  "1d": "15y",
};

/**
 * Velas de un par. `par` en formato Yahoo: USDJPY=X, EURUSD=X…
 *
 * Se descartan las velas incompletas (algun campo null). Yahoo las devuelve en fines de semana
 * y festivos, y colarlas produce huecos con precio inventado.
 */
export async function velas(par: string, tf: Temporalidad): Promise<Vela[]> {
  const { data } = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${par}`,
    {
      params: { range: RANGO[tf], interval: tf },
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 30_000,
    },
  );

  const res = data?.chart?.result?.[0];
  if (!res) return [];
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};

  const out: Vela[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const vol = q.volume?.[i];
    // Una vela a medias no es una vela. Rellenarla con el cierre anterior inventa precio.
    if (o == null || h == null || l == null || c == null) continue;
    const vela: Vela = { t: ts[i]!, o, h, l, c, ...(vol == null ? {} : { v: vol }) };
    // Y una vela imposible tampoco es una vela.
    if (!esVelaValida(vela)) continue;
    out.push(vela);
  }
  return out;
}

/**
 * Tamaño de un pip para el par. En los pares con JPY el pip es 0,01; en el resto, 0,0001.
 *
 * Importa para los costes: el spread se cotiza en pips y si se aplica el tamaño equivocado el
 * coste sale 100 veces mayor o menor de lo que es.
 */
export function pip(par: string): number | null {
  const s = par.toUpperCase();
  // EL PIP ES UNA UNIDAD DE DIVISAS Y NO SIGNIFICA NADA FUERA DE AHI.
  //
  // Devolvia 0,0001 para cualquier simbolo, incluidos los de cripto, y eso imprimia columnas de
  // "pips" con valores absurdos —decenas de miles— al lado de unos R que si eran correctos. Un
  // numero sin sentido junto a uno bueno es peor que no imprimir nada: invita a leerlo.
  //
  // Ahora devuelve null y quien llama decide si la columna tiene sentido o se calla.
  if (!/^[A-Z]{6}(=X)?$/.test(s.replace("=X", "") + "=X")) return null;
  if (s.includes("USDT") || s.includes("BUSD") || s.includes("USDC")) return null;
  return s.includes("JPY") ? 0.01 : 0.0001;
}
