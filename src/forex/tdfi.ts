/**
 * TDFI (Trend Direction Force Index) + stop por ATR + objetivo en 0,5R.
 *
 * LA ARITMETICA QUE DEFINE ESTA ESTRATEGIA
 * ----------------------------------------
 * Con objetivo 0,5R y stop 1R, el punto de equilibrio esta en 66,7% de acierto:
 *
 *     p x 0,5 = (1 - p) x 1   ->   p = 1 / 1,5 = 0,667
 *
 * Y 66,7% es EXACTAMENTE lo que da entrar al azar con esa misma relacion: en un paseo
 * aleatorio, la probabilidad de tocar +0,5 antes que -1 es 1 / (1 + 0,5) = 2/3. Los dos numeros
 * coinciden porque salen de la misma proporcion, no por casualidad.
 *
 * Consecuencia: un acierto alto NO es señal de que la estrategia funcione. Lo produce la forma
 * del objetivo, no la entrada. Toda la ventaja tiene que venir de cuanto supere el TDFI al azar,
 * y encima tiene que cubrir el coste. Por eso el control de entradas aleatorias no es un extra
 * aqui: es la unica referencia que significa algo.
 *
 * Todo puro y sin mirar el futuro.
 */
import type { Vela } from "./datos";

export type Estado = "ALCISTA" | "BAJISTA" | "PLANO";

/** Media exponencial. `null` hasta tener `n` valores. */
export function ema(xs: number[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  const k = 2 / (n + 1);
  let previo: number | null = null;
  let suma = 0;
  for (let i = 0; i < xs.length; i += 1) {
    suma += xs[i]!;
    if (i === n - 1) {
      previo = suma / n;
      out[i] = previo;
    } else if (previo != null) {
      previo = xs[i]! * k + previo * (1 - k);
      out[i] = previo;
    }
  }
  return out;
}

/**
 * TDFI normalizado, en el rango [-1, 1] aproximadamente.
 *
 * Formula publicada de Dean Malone. El x1000 del precio esta en el original para que el cubo no
 * se hunda en el redondeo de coma flotante; se cancela al normalizar, asi que no cambia nada.
 *
 * La normalizacion divide por el maximo de |tdf| de las ultimas `periodo * 3` velas, SIN incluir
 * velas futuras: mirar el maximo de toda la serie seria mirar el futuro y es el error clasico
 * de este indicador.
 */
export function tdfi(cierres: number[], periodo = 13): (number | null)[] {
  const escalado = cierres.map((c) => c * 1000);
  const mma = ema(escalado, periodo);
  const mmaLimpio = mma.map((x) => x ?? 0);
  const smma = ema(mmaLimpio, periodo);

  const crudo: (number | null)[] = new Array(cierres.length).fill(null);
  for (let i = 1; i < cierres.length; i += 1) {
    const m = mma[i], m1 = mma[i - 1], s = smma[i], s1 = smma[i - 1];
    if (m == null || m1 == null || s == null || s1 == null) continue;
    const impulso = ((m - m1) + (s - s1)) / 2;
    crudo[i] = Math.abs(m - s) * impulso ** 3;
  }

  const ventana = periodo * 3;
  const out: (number | null)[] = new Array(cierres.length).fill(null);
  for (let i = 0; i < cierres.length; i += 1) {
    if (crudo[i] == null) continue;
    let max = 0;
    for (let k = Math.max(0, i - ventana + 1); k <= i; k += 1) {
      const v = crudo[k];
      if (v != null) max = Math.max(max, Math.abs(v));
    }
    out[i] = max > 0 ? crudo[i]! / max : 0;
  }
  return out;
}

/** Las tres fases: verde, rojo y la zona gris que sirve de filtro. */
export function estados(valores: (number | null)[], umbral = 0.05): (Estado | null)[] {
  return valores.map((v) => {
    if (v == null) return null;
    if (v > umbral) return "ALCISTA";
    if (v < -umbral) return "BAJISTA";
    return "PLANO";
  });
}

/**
 * Linea de stop por ATR que solo se mueve a favor (estilo Captain Coinflip / SuperTrend).
 *
 * Se reinicia cuando el precio cierra al otro lado. Solo se usa para saber la DISTANCIA del stop
 * en el momento de entrar, que es lo que fija el tamaño de la R.
 */
export function atrStopSeguidor(
  velas: Vela[],
  atrValores: (number | null)[],
  multiplicador: number,
): { largo: (number | null)[]; corto: (number | null)[] } {
  const largo: (number | null)[] = new Array(velas.length).fill(null);
  const corto: (number | null)[] = new Array(velas.length).fill(null);
  for (let i = 0; i < velas.length; i += 1) {
    const a = atrValores[i];
    if (a == null || !(a > 0)) continue;
    const c = velas[i]!.c;
    const baseL = c - a * multiplicador;
    const baseC = c + a * multiplicador;
    const prevL = largo[i - 1];
    const prevC = corto[i - 1];
    // Solo sube mientras el precio siga por encima; si lo pierde, se reinicia.
    largo[i] = prevL != null && velas[i - 1]!.c > prevL ? Math.max(prevL, baseL) : baseL;
    corto[i] = prevC != null && velas[i - 1]!.c < prevC ? Math.min(prevC, baseC) : baseC;
  }
  return { largo, corto };
}

export interface SeñalTdfi {
  i: number;
  direccion: "LARGO" | "CORTO";
  /** Distancia al stop en precio, tomada de la linea de ATR en la vela de la señal. */
  riesgo: number;
}

/**
 * Entra cuando el TDFI SALE de la zona gris hacia un color.
 *
 * Que la señal sea la transicion y no el estado es lo que implementa la regla del video de
 * "esperar a que vuelva a gris antes de volver a entrar": mientras siga verde no hay señal nueva.
 */
export function señales(
  velas: Vela[],
  est: (Estado | null)[],
  stops: { largo: (number | null)[]; corto: (number | null)[] },
): SeñalTdfi[] {
  const out: SeñalTdfi[] = [];
  for (let i = 1; i < velas.length; i += 1) {
    const previo = est[i - 1];
    const actual = est[i];
    if (previo !== "PLANO" || actual == null || actual === "PLANO") continue;

    const c = velas[i]!.c;
    if (actual === "ALCISTA") {
      const s = stops.largo[i];
      if (s != null && c > s) out.push({ i, direccion: "LARGO", riesgo: c - s });
    } else {
      const s = stops.corto[i];
      if (s != null && s > c) out.push({ i, direccion: "CORTO", riesgo: s - c });
    }
  }
  return out;
}

export interface ResultadoObjetivo {
  r: number;
  velas: number;
  motivo: "OBJETIVO" | "STOP" | "TIEMPO";
}

/**
 * Simula un bracket fijo: stop a 1R y objetivo a `objetivoR`.
 *
 * `entrarEnCierre` decide si se entra al cierre de la vela de la señal (lo que enseña el video)
 * o en la apertura de la siguiente (mas conservador). Se puede medir la diferencia, que en
 * temporalidades bajas no es pequeña.
 *
 * Si en una vela se tocan stop y objetivo, cuenta el STOP: no se conoce el orden intravela y
 * suponer lo contrario es justo lo que infla estas estrategias.
 */
export function simularObjetivo(
  velas: Vela[],
  s: SeñalTdfi,
  objetivoR: number,
  coste: number,
  maxVelas: number,
  entrarEnCierre: boolean,
): ResultadoObjetivo | null {
  const largo = s.direccion === "LARGO";
  const i0 = entrarEnCierre ? s.i : s.i + 1;
  if (i0 >= velas.length || !(s.riesgo > 0)) return null;

  const base = entrarEnCierre ? velas[s.i]!.c : velas[i0]!.o;
  const entrada = base + (largo ? coste : -coste);
  const stop = largo ? entrada - s.riesgo : entrada + s.riesgo;
  const objetivo = largo ? entrada + s.riesgo * objetivoR : entrada - s.riesgo * objetivoR;

  const desde = entrarEnCierre ? i0 + 1 : i0;
  for (let j = desde; j < velas.length; j += 1) {
    const v = velas[j]!;
    if (largo ? v.l <= stop : v.h >= stop) {
      return { r: -1 - coste / s.riesgo, velas: j - desde, motivo: "STOP" };
    }
    if (largo ? v.h >= objetivo : v.l <= objetivo) {
      return { r: objetivoR - coste / s.riesgo, velas: j - desde, motivo: "OBJETIVO" };
    }
    if (maxVelas > 0 && j - desde >= maxVelas) {
      const salida = v.c;
      const bruto = (largo ? salida - entrada : entrada - salida) / s.riesgo;
      return { r: bruto - coste / s.riesgo, velas: j - desde, motivo: "TIEMPO" };
    }
  }
  return null;
}
