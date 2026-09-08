/**
 * VOLUMEN: VWAP, picos de volumen y huecos. Lo que faltaba en toda la investigacion.
 *
 * POR QUE ESTABA SIN PROBAR
 * -------------------------
 * El descargador tiraba el volumen aunque Yahoo lo devuelve, asi que ninguna de las siete
 * familias medidas hasta ahora lo uso nunca. Es el denominador comun de media docena de
 * estrategias clasicas: pico de volumen en el momentum, confirmacion de la ruptura, el VWAP
 * entero, y la verificacion del hueco.
 *
 * AVISO QUE CONDICIONA TODO LO DE AQUI
 * ------------------------------------
 * En forex al contado NO hay volumen central: Yahoo devuelve 0 o nada. Medir volumen en forex
 * es medir ceros. Estas funciones solo significan algo en cripto, acciones y ETFs, y todas
 * comprueban que el volumen exista de verdad antes de opinar.
 *
 * Todo puro y sin mirar el futuro.
 */
import type { Vela } from "./datos";

/** Precio tipico de la vela, que es el que usa el VWAP estandar. */
const tipico = (v: Vela): number => (v.h + v.l + v.c) / 3;

/** Cuantas velas traen volumen utilizable. Sirve para no medir sobre ceros. */
export function coberturaVolumen(velas: Vela[]): number {
  if (!velas.length) return 0;
  return velas.filter((v) => v.v != null && v.v > 0).length / velas.length;
}

/**
 * VWAP intradia. Se REINICIA cada dia, que es lo que lo distingue de una media movil.
 *
 * Un VWAP acumulado desde el principio de la serie no es el VWAP que miran los institucionales:
 * es una media ponderada de años y no marca ninguna zona de valor del dia.
 */
export function vwap(velas: Vela[]): (number | null)[] {
  const out: (number | null)[] = new Array(velas.length).fill(null);
  let dia = "";
  let sumaPV = 0;
  let sumaV = 0;
  for (let i = 0; i < velas.length; i += 1) {
    const v = velas[i]!;
    const d = new Date(v.t * 1000).toISOString().slice(0, 10);
    if (d !== dia) {
      dia = d;
      sumaPV = 0;
      sumaV = 0;
    }
    if (v.v == null || !(v.v > 0)) continue;
    sumaPV += tipico(v) * v.v;
    sumaV += v.v;
    if (sumaV > 0) out[i] = sumaPV / sumaV;
  }
  return out;
}

/**
 * Media de volumen de las `n` velas ANTERIORES, sin incluir la actual.
 *
 * Incluir la vela actual haria que un pico se comparase consigo mismo y suavizaria justo lo que
 * se quiere detectar.
 */
export function volumenMedio(velas: Vela[], n: number): (number | null)[] {
  const out: (number | null)[] = new Array(velas.length).fill(null);
  let suma = 0;
  let cuenta = 0;
  for (let i = 0; i < velas.length; i += 1) {
    if (i > 0) {
      const prev = velas[i - 1]!.v;
      if (prev != null && prev > 0) {
        suma += prev;
        cuenta += 1;
      }
      if (i > n) {
        const sale = velas[i - n - 1]!.v;
        if (sale != null && sale > 0) {
          suma -= sale;
          cuenta -= 1;
        }
      }
    }
    if (cuenta >= Math.max(3, n / 2)) out[i] = suma / cuenta;
  }
  return out;
}

/** Vela con volumen al menos `k` veces la media reciente. */
export function picoVolumen(velas: Vela[], n: number, k: number): boolean[] {
  const media = volumenMedio(velas, n);
  return velas.map((v, i) => {
    const m = media[i];
    return v.v != null && v.v > 0 && m != null && m > 0 && v.v >= m * k;
  });
}

export interface SeñalVwap {
  i: number;
  direccion: "LARGO" | "CORTO";
}

/**
 * Estrategia VWAP del articulo: el precio se sostiene por encima del VWAP `confirmacion` velas,
 * luego retrocede a tocarlo y rebota cerrando por encima.
 *
 * La señal es el rebote, no el cruce: entrar lejos del VWAP es lo que el propio articulo
 * desaconseja.
 */
export function retornoAlVwap(
  velas: Vela[],
  linea: (number | null)[],
  confirmacion: number,
): SeñalVwap[] {
  const out: SeñalVwap[] = [];
  for (let i = confirmacion + 1; i < velas.length; i += 1) {
    const w = linea[i];
    const v = velas[i]!;
    if (w == null) continue;
    // El dia tiene que ser el mismo: un "retroceso al VWAP" entre dias distintos no existe.
    const hoy = new Date(v.t * 1000).toISOString().slice(0, 10);
    let mismoDia = true;
    for (let k = 1; k <= confirmacion; k += 1) {
      if (new Date(velas[i - k]!.t * 1000).toISOString().slice(0, 10) !== hoy) mismoDia = false;
    }
    if (!mismoDia) continue;

    let arriba = true;
    let abajo = true;
    for (let k = 1; k <= confirmacion; k += 1) {
      const wk = linea[i - k];
      if (wk == null) { arriba = false; abajo = false; break; }
      if (velas[i - k]!.c <= wk) arriba = false;
      if (velas[i - k]!.c >= wk) abajo = false;
    }
    // Retroceso: la vela toca el VWAP pero cierra del lado que venia mandando.
    if (arriba && v.l <= w && v.c > w) out.push({ i, direccion: "LARGO" });
    else if (abajo && v.h >= w && v.c < w) out.push({ i, direccion: "CORTO" });
  }
  return out;
}

export interface SeñalHueco {
  i: number;
  direccion: "LARGO" | "CORTO";
  /** Tamaño del hueco en fraccion del cierre anterior. */
  tamaño: number;
}

/**
 * Huecos de apertura, en la version CONTINUACION que pide el articulo (no el relleno).
 *
 * `exigirVolumen` implementa su consejo: "verifica siempre el volumen, los huecos con poco
 * volumen no son fiables". Poder apagarlo es justo lo que permite medir si ese consejo vale algo.
 */
export function huecos(
  velas: Vela[],
  minimo: number,
  exigirVolumen: boolean,
  n = 20,
  k = 1.5,
): SeñalHueco[] {
  const pico = picoVolumen(velas, n, k);
  const out: SeñalHueco[] = [];
  for (let i = 1; i < velas.length; i += 1) {
    const ayer = velas[i - 1]!.c;
    const hoy = velas[i]!.o;
    if (!(ayer > 0)) continue;
    const g = (hoy - ayer) / ayer;
    if (Math.abs(g) < minimo) continue;
    if (exigirVolumen && !pico[i]) continue;
    out.push({ i, direccion: g > 0 ? "LARGO" : "CORTO", tamaño: g });
  }
  return out;
}
