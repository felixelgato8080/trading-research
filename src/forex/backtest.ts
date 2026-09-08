/**
 * Backtest de la estrategia RSI sobre velas de forex. Puro.
 *
 * DECISIONES QUE DECIDEN EL RESULTADO
 * -----------------------------------
 * 1. Se entra en la APERTURA de la vela siguiente a la señal. La señal se conoce al cierre de
 *    su vela, asi que entrar a ese mismo cierre es mirar el futuro. Es la forma mas comun de
 *    fabricar un backtest ganador que no existe.
 *
 * 2. Dentro de una vela no se sabe el orden de los precios. Si en la misma vela se tocan el
 *    stop y el objetivo, se cuenta el STOP. No es pesimismo: es lo unico que no inventa
 *    informacion que no tenemos, y suponer lo contrario regala operaciones ganadoras.
 *
 * 3. El spread se paga ENTERO en la entrada y ENTERO en la salida, en pips. En temporalidades
 *    pequeñas hay muchas operaciones y ese coste manda sobre todo lo demas.
 *
 * El resultado se expresa en R —multiplos del riesgo— y no en dinero: el dinero depende del
 * apalancamiento, que es una decision aparte y no dice nada sobre si la estrategia sirve.
 */
import type { Vela } from "./datos";
import type { Señal } from "./rsi";

export interface ReglasSalidaFx {
  /** Objetivo en multiplos del stop. 1 = misma distancia. */
  objetivoR: number;
  /** Distancia del stop, en pips. */
  stopPips: number;
  /** Velas maximas dentro. 0 = sin limite. */
  maxVelas: number;
  /**
   * Salir cuando el RSI vuelva a este nivel (tipicamente 50). 0 = desactivado.
   *
   * Es una salida distinta en naturaleza al objetivo fijo: el objetivo dice "gano X pips";
   * esta dice "la razon por la que entre ya no existe". En una estrategia de reversion a la
   * media la segunda es mas coherente con la premisa, y por eso hay que probarla aparte.
   */
  salirEnRsi?: number;
  /**
   * Si se da, el stop y el objetivo se miden en multiplos del ATR de la vela de la señal en
   * vez de en pips fijos. Un stop fijo es enorme en la sesion asiatica y ridiculo en el solape
   * Londres-NY; el ATR se adapta solo. La investigacion de 2026 lo señala como uno de los
   * pocos elementos que se repiten en los sistemas que aguantan.
   */
  atrStop?: number;
}

export interface Costes {
  /** Spread tipico del par, en pips. Se paga en la entrada y en la salida. */
  spreadPips: number;
}

export interface Operacion {
  iEntrada: number;
  iSalida: number;
  direccion: "LARGO" | "CORTO";
  /** Resultado en multiplos del riesgo, ya con costes. */
  r: number;
  motivo: "OBJETIVO" | "STOP" | "TIEMPO" | "RSI" | "FIN";
  velas: number;
}

export interface Resumen {
  operaciones: number;
  /** Suma de R. Es la medida honesta: independiente del apalancamiento. */
  totalR: number;
  mediaR: number;
  medianaR: number;
  aciertos: number;
  /** Fraccion de operaciones en verde. */
  tasaAcierto: number;
  velasMedianas: number;
  porMotivo: Record<string, number>;
}

/**
 * Simula las señales sobre las velas. Pura.
 *
 * `pipTam` es el tamaño del pip del par (0,01 en JPY; 0,0001 en el resto). Pasarlo mal
 * multiplica o divide los costes por 100.
 */
export function simular(
  velas: Vela[],
  señales: Señal[],
  reglas: ReglasSalidaFx,
  costes: Costes,
  pipTam: number,
  /** RSI por vela, solo si se usa `salirEnRsi`. */
  rsiValores?: (number | null)[],
  /** ATR por vela, solo si se usa `atrStop`. */
  atrValores?: (number | null)[],
): Operacion[] {
  const ops: Operacion[] = [];
  const spread = costes.spreadPips * pipTam;

  for (const s of señales) {
    // Entrar en la apertura de la SIGUIENTE vela: la señal se conoce al cierre de la suya.
    const iEntrada = s.i + 1;
    if (iEntrada >= velas.length) continue;

    // El stop se fija con el ATR de la vela de la SEÑAL, que es la ultima cerrada al decidir.
    let stop = reglas.stopPips * pipTam;
    if (reglas.atrStop && atrValores) {
      const a = atrValores[s.i];
      if (a == null || !(a > 0)) continue;
      stop = a * reglas.atrStop;
    }
    const objetivo = stop * reglas.objetivoR;

    const largo = s.direccion === "LARGO";
    // Se compra al ask y se vende al bid: el spread se paga al entrar.
    const entrada = velas[iEntrada]!.o + (largo ? spread : -spread);

    const nivelStop = largo ? entrada - stop : entrada + stop;
    const nivelObjetivo = largo ? entrada + objetivo : entrada - objetivo;

    let salida: number | null = null;
    let motivo: Operacion["motivo"] = "FIN";
    let iSalida = velas.length - 1;

    for (let j = iEntrada; j < velas.length; j += 1) {
      const v = velas[j]!;
      const tocaStop = largo ? v.l <= nivelStop : v.h >= nivelStop;
      const tocaObjetivo = largo ? v.h >= nivelObjetivo : v.l <= nivelObjetivo;

      // Si en la misma vela se tocan los dos, se cuenta el STOP. No sabemos el orden dentro
      // de la vela, y suponer que fue el objetivo regala operaciones ganadoras.
      if (tocaStop) {
        salida = nivelStop;
        motivo = "STOP";
        iSalida = j;
        break;
      }
      if (tocaObjetivo) {
        salida = nivelObjetivo;
        motivo = "OBJETIVO";
        iSalida = j;
        break;
      }
      // Salida por RSI: la razon de la entrada ya no existe. Se comprueba DESPUES del stop
      // y del objetivo porque esos se tocan intravela y esta solo al cierre.
      if (reglas.salirEnRsi && rsiValores) {
        const r = rsiValores[j];
        if (r != null && j > iEntrada) {
          const vuelto = largo ? r >= reglas.salirEnRsi : r <= reglas.salirEnRsi;
          if (vuelto) {
            salida = v.c;
            motivo = "RSI";
            iSalida = j;
            break;
          }
        }
      }

      if (reglas.maxVelas > 0 && j - iEntrada >= reglas.maxVelas) {
        salida = v.c;
        motivo = "TIEMPO";
        iSalida = j;
        break;
      }
    }

    if (salida === null) {
      salida = velas[velas.length - 1]!.c;
      motivo = "FIN";
      iSalida = velas.length - 1;
    }

    // El spread se paga tambien al salir.
    const salidaNeta = salida - (largo ? spread : -spread);
    const bruto = largo ? salidaNeta - entrada : entrada - salidaNeta;

    ops.push({
      iEntrada,
      iSalida,
      direccion: s.direccion,
      r: bruto / stop,
      motivo,
      velas: iSalida - iEntrada,
    });
  }
  return ops;
}

function mediana(v: number[]): number {
  if (!v.length) return 0;
  const o = [...v].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m]! : (o[m - 1]! + o[m]!) / 2;
}

export function resumir(ops: Operacion[]): Resumen {
  const rs = ops.map((o) => o.r);
  const total = rs.reduce((s, x) => s + x, 0);
  const aciertos = rs.filter((x) => x > 0).length;
  const porMotivo: Record<string, number> = {};
  for (const o of ops) porMotivo[o.motivo] = (porMotivo[o.motivo] ?? 0) + 1;

  return {
    operaciones: ops.length,
    totalR: total,
    mediaR: ops.length ? total / ops.length : 0,
    medianaR: mediana(rs),
    aciertos,
    tasaAcierto: ops.length ? aciertos / ops.length : 0,
    velasMedianas: mediana(ops.map((o) => o.velas)),
    porMotivo,
  };
}
