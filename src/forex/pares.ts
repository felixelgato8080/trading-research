/**
 * PARES Y DIFERENCIALES: la unica familia estructuralmente descorrelacionada del mercado.
 *
 * POR QUE MERECE PROBARSE
 * -----------------------
 * Todo lo medido en este proyecto es direccional, y por eso arrastra el mismo problema: cuando
 * cripto cae, cae todo a la vez y las "30 apuestas" resultan ser una. Un par es otra cosa:
 * largo en A y corto en B a la vez. Si las dos caen, el resultado apenas se mueve. La ventaja no
 * viene de acertar la direccion del mercado, sino de que la RELACION entre dos cosas vuelva a
 * su sitio.
 *
 * LOS DOS PEAJES QUE LA MATAN SI NO SE CUENTAN
 * --------------------------------------------
 *   1. Se pagan DOS patas: entrar y salir de dos instrumentos, no de uno. El coste se dobla.
 *   2. La exposicion es DOBLE: mover 1.000 en el par significa 1.000 largos y 1.000 cortos.
 *      Con el tope de exposicion que ya existe, esto cuenta como 2x.
 *
 * Todo puro y sin mirar el futuro: la z se calcula con una ventana que termina en la vela
 * anterior.
 */
import type { Vela } from "./datos";

export interface PuntoRatio {
  t: number;
  /** Precio de A dividido por el de B. */
  ratio: number;
}

/**
 * Serie del cociente de dos instrumentos, solo en las fechas que ambos tienen.
 *
 * Rellenar los huecos con el ultimo valor conocido inventaria movimiento del par en dias en que
 * uno de los dos no cotizaba, que es donde salen los falsos beneficios.
 */
export function serieRatio(a: Vela[], b: Vela[]): PuntoRatio[] {
  const porT = new Map<number, number>();
  for (const v of b) if (v.c > 0) porT.set(v.t, v.c);
  const out: PuntoRatio[] = [];
  for (const v of a) {
    const pb = porT.get(v.t);
    if (pb == null || !(pb > 0) || !(v.c > 0)) continue;
    out.push({ t: v.t, ratio: v.c / pb });
  }
  return out;
}

/**
 * Media y desviacion tipica de las `ventana` velas ANTERIORES a cada punto.
 *
 * Que la ventana termine en la vela previa es lo que impide mirar el futuro: incluir la vela
 * actual mete el propio extremo en la media que lo mide y suaviza justo la señal.
 *
 * Se devuelve la desviacion ademas de la z porque el RIESGO de la operacion se mide en precio,
 * no en z, y sin la desviacion no se puede traducir de una a otra.
 */
export function bandas(
  valores: number[],
  ventana: number,
): Array<{ media: number; sd: number } | null> {
  const out: Array<{ media: number; sd: number } | null> = new Array(valores.length).fill(null);
  for (let i = ventana; i < valores.length; i += 1) {
    let suma = 0;
    for (let k = i - ventana; k < i; k += 1) suma += valores[k]!;
    const media = suma / ventana;
    let varianza = 0;
    for (let k = i - ventana; k < i; k += 1) varianza += (valores[k]! - media) ** 2;
    const sd = Math.sqrt(varianza / ventana);
    if (sd > 0) out[i] = { media, sd };
  }
  return out;
}

/** Z de cada punto respecto a su banda. */
export function zScore(valores: number[], ventana: number): (number | null)[] {
  const b = bandas(valores, ventana);
  return valores.map((v, i) => (b[i] ? (v - b[i]!.media) / b[i]!.sd : null));
}

export interface SeñalPar {
  i: number;
  /** LARGO = comprar el ratio (largo A, corto B). CORTO = lo contrario. */
  direccion: "LARGO" | "CORTO";
  z: number;
}

/**
 * Entra cuando la z CRUZA el umbral, no mientras siga pasada.
 *
 * Sin el cruce, un tramo con z alta durante veinte velas daria veinte señales identicas y la
 * muestra quedaria inflada por repeticion.
 */
export function señales(z: (number | null)[], umbral: number): SeñalPar[] {
  const out: SeñalPar[] = [];
  for (let i = 1; i < z.length; i += 1) {
    const hoy = z[i];
    const ayer = z[i - 1];
    if (hoy == null || ayer == null) continue;
    // Ratio muy alto -> se espera que baje -> corto del ratio.
    if (ayer <= umbral && hoy > umbral) out.push({ i, direccion: "CORTO", z: hoy });
    else if (ayer >= -umbral && hoy < -umbral) out.push({ i, direccion: "LARGO", z: hoy });
  }
  return out;
}

export interface ResultadoPar {
  /** Resultado en multiplos del riesgo, con el coste de las DOS patas ya restado. */
  r: number;
  velas: number;
  motivo: "OBJETIVO" | "STOP" | "TIEMPO" | "FIN";
  /** Distancia del stop en fraccion del ratio, para poder calcular la exposicion. */
  stopFraccion: number;
}

/**
 * Simula el par en R, igual que el resto del proyecto.
 *
 * El riesgo en PRECIO es la distancia desde el ratio de entrada hasta el ratio al que la z
 * llegaria al stop. Traducir de z a precio con la desviacion de la banda es lo que hace este
 * resultado comparable con todo lo demas.
 *
 * `costeR` tiene que venir ya DOBLADO por quien llama: son dos instrumentos, dos entradas y
 * dos salidas.
 */
export function simularPar(
  puntos: PuntoRatio[],
  ventana: number,
  s: SeñalPar,
  stopZ: number,
  salidaZ: number,
  costeR: number,
  maxVelas: number,
  minDistanciaZ = 0.5,
): ResultadoPar | null {
  const valores = puntos.map((p) => p.ratio);
  const b = bandas(valores, ventana);
  const z = zScore(valores, ventana);

  const i0 = s.i + 1;
  if (i0 >= puntos.length) return null;
  const banda = b[i0];
  const zEntrada = z[i0];
  if (!banda || zEntrada == null) return null;

  const entrada = puntos[i0]!.ratio;
  const largo = s.direccion === "LARGO";
  // Riesgo en precio: cuanto tiene que moverse el ratio para que la z llegue al stop.
  const distZ = stopZ - Math.abs(zEntrada);
  // DISTANCIA MINIMA AL STOP. Sin esto, una z que cruza el umbral de golpe y aparece pegada al
  // stop deja un riesgo casi cero en el denominador, y cualquier movimiento da una R enorme.
  // Son operaciones que nadie tomaria —el stop estaria a un suspiro y el deslizamiento solo ya
  // lo saltaria— y bastan unas pocas para inflar la esperanza de todo el barrido.
  if (!(distZ >= minDistanciaZ)) return null;
  const riesgo = distZ * banda.sd;
  if (!(riesgo > 0) || !(entrada > 0)) return null;

  const enR = (salida: number): number =>
    ((largo ? salida - entrada : entrada - salida) / riesgo) - costeR;

  for (let j = i0; j < puntos.length; j += 1) {
    const zj = z[j];
    if (zj == null) continue;
    const ratio = puntos[j]!.ratio;

    // El stop primero: si en la misma vela se cumplen las dos cosas, no sabemos el orden.
    if (largo ? zj <= -stopZ : zj >= stopZ) {
      return { r: enR(ratio), velas: j - i0, motivo: "STOP", stopFraccion: riesgo / entrada };
    }
    if (largo ? zj >= -salidaZ : zj <= salidaZ) {
      return { r: enR(ratio), velas: j - i0, motivo: "OBJETIVO", stopFraccion: riesgo / entrada };
    }
    if (maxVelas > 0 && j - i0 >= maxVelas) {
      return { r: enR(ratio), velas: j - i0, motivo: "TIEMPO", stopFraccion: riesgo / entrada };
    }
  }
  const fin = puntos[puntos.length - 1]!.ratio;
  return {
    r: enR(fin), velas: puntos.length - 1 - i0, motivo: "FIN", stopFraccion: riesgo / entrada,
  };
}
