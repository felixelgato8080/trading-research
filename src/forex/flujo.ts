/**
 * FLUJO DE ORDENES: delta, CVD, perfil de volumen y nodos de bajo volumen.
 *
 * DE DONDE SALE ESTO
 * ------------------
 * Es el nucleo de la estrategia que describe Fabio Valentino: no mirar velas sino QUIEN esta
 * pagando por cruzar el spread. Yo daba por hecho que hacia falta dato tick a tick, pero cada
 * vela de Binance trae el volumen que entro comprando a mercado, y con eso sale el delta.
 *
 * LAS CUATRO IDEAS QUE SE PUEDEN MEDIR
 * ------------------------------------
 *   1. DELTA: compra agresiva menos venta agresiva en la vela.
 *   2. CVD: el delta acumulado. Su DIVERGENCIA con el precio es la señal que el usa para
 *      anticipar que un movimiento no tiene soporte.
 *   3. AGRESION SIN CONTINUACION: mucho delta y poco recorrido significa que alguien esta
 *      absorbiendo. Es su disparador principal.
 *   4. NODO DE BAJO VOLUMEN: el precio en el tramo donde menos se negocio. Lo usa como zona de
 *      entrada en el retroceso.
 *
 * Todo puro y sin mirar el futuro.
 */
import type { VelaFlujo } from "./binance";

/**
 * Delta de la vela: volumen agresivo comprador menos vendedor.
 *
 * El total es compra + venta, asi que venta = total - compra y delta = 2*compra - total. Si no
 * hay volumen no hay delta: devolver cero seria decir "estaba equilibrado", que es distinto de
 * "no se sabe".
 */
export function delta(v: VelaFlujo): number | null {
  if (v.v == null || !(v.v > 0)) return null;
  return 2 * v.compraAgresiva - v.v;
}

/** Delta en fraccion del volumen: +1 es todo compra agresiva, -1 todo venta. */
export function deltaRelativo(v: VelaFlujo): number | null {
  const d = delta(v);
  return d == null || v.v == null || !(v.v > 0) ? null : d / v.v;
}

/** Delta acumulado desde el principio de la serie. Es el CVD que usan en las plataformas. */
export function cvd(velas: VelaFlujo[]): (number | null)[] {
  const out: (number | null)[] = [];
  let acum = 0;
  for (const v of velas) {
    const d = delta(v);
    if (d == null) {
      out.push(out.length ? out[out.length - 1]! : null);
      continue;
    }
    acum += d;
    out.push(acum);
  }
  return out;
}

/** Tamaño medio de operacion. Es lo mas cerca que se puede estar de "hay ordenes grandes". */
export function tamañoMedio(v: VelaFlujo): number | null {
  if (v.v == null || !(v.v > 0) || !(v.operaciones > 0)) return null;
  return v.v / v.operaciones;
}

/**
 * AGRESION SIN CONTINUACION: mucho delta y poco recorrido de precio.
 *
 * Es el disparador central del modelo. La idea es que si entran ordenes agresivas y el precio
 * apenas se mueve, alguien esta absorbiendo con ordenes limitadas y el movimiento va a fallar.
 *
 * Se normaliza por el ATR para que "poco recorrido" signifique lo mismo en BTC que en DOGE, y
 * el delta se compara con su propia media reciente para que "mucho delta" signifique lo mismo
 * en una vela tranquila que en una de panico.
 */
export interface Absorcion {
  i: number;
  /** LARGO si absorbieron a los vendedores (se espera subida). */
  direccion: "LARGO" | "CORTO";
  deltaRel: number;
  recorridoAtr: number;
}

export function absorcion(
  velas: VelaFlujo[],
  atrValores: (number | null)[],
  ventana: number,
  minDelta: number,
  maxRecorrido: number,
): Absorcion[] {
  const out: Absorcion[] = [];
  for (let i = ventana; i < velas.length; i += 1) {
    const v = velas[i]!;
    const d = delta(v);
    const a = atrValores[i - 1];
    if (d == null || a == null || !(a > 0)) continue;

    // Media del |delta| de las velas ANTERIORES: incluir la actual suavizaria justo el pico.
    let suma = 0;
    let n = 0;
    for (let k = i - ventana; k < i; k += 1) {
      const dk = delta(velas[k]!);
      if (dk != null) {
        suma += Math.abs(dk);
        n += 1;
      }
    }
    if (n < ventana / 2 || suma === 0) continue;
    const media = suma / n;
    if (Math.abs(d) < media * minDelta) continue;

    // Recorrido del precio de la vela, en ATR.
    const recorrido = Math.abs(v.c - v.o) / a;
    if (recorrido > maxRecorrido) continue;

    // Delta vendedor absorbido -> se espera subida, y al reves.
    out.push({
      i,
      direccion: d < 0 ? "LARGO" : "CORTO",
      deltaRel: d / (v.v ?? 1),
      recorridoAtr: recorrido,
    });
  }
  return out;
}

/**
 * DIVERGENCIA entre precio y CVD sobre las ultimas `ventana` velas.
 *
 * Positiva cuando el precio sube y el CVD no acompaña (compra sin fuerza detras), negativa al
 * reves. Es lo que el llama "movimiento sin soporte".
 *
 * Se normaliza cada serie por su propio rango en la ventana para poder compararlas: precio y
 * CVD estan en unidades distintas y restarlas en crudo no significa nada.
 */
export function divergencia(
  velas: VelaFlujo[],
  serieCvd: (number | null)[],
  ventana: number,
): (number | null)[] {
  const out: (number | null)[] = new Array(velas.length).fill(null);
  for (let i = ventana; i < velas.length; i += 1) {
    let pMin = Infinity, pMax = -Infinity, cMin = Infinity, cMax = -Infinity;
    for (let k = i - ventana + 1; k <= i; k += 1) {
      pMin = Math.min(pMin, velas[k]!.c);
      pMax = Math.max(pMax, velas[k]!.c);
      const c = serieCvd[k];
      if (c != null) {
        cMin = Math.min(cMin, c);
        cMax = Math.max(cMax, c);
      }
    }
    const c0 = serieCvd[i - ventana + 1];
    const c1 = serieCvd[i];
    if (c0 == null || c1 == null) continue;
    if (!(pMax > pMin) || !(cMax > cMin)) continue;

    const movPrecio = (velas[i]!.c - velas[i - ventana + 1]!.c) / (pMax - pMin);
    const movCvd = (c1 - c0) / (cMax - cMin);
    out[i] = movPrecio - movCvd;
  }
  return out;
}

export interface NodoVolumen {
  /** Precio del nodo. */
  precio: number;
  /** Volumen acumulado en ese nivel. */
  volumen: number;
}

/**
 * Perfil de volumen de un tramo: reparte el volumen de cada vela entre `niveles` cortes de
 * precio.
 *
 * Reparto uniforme entre maximo y minimo de la vela. No es exacto —el volumen real no se
 * distribuye plano dentro de la vela— pero es lo que se puede saber sin dato tick a tick, y es
 * lo que hacen las plataformas cuando no tienen footprint.
 */
export function perfil(velas: VelaFlujo[], desde: number, hasta: number, niveles = 30): NodoVolumen[] {
  let min = Infinity;
  let max = -Infinity;
  for (let i = desde; i <= hasta && i < velas.length; i += 1) {
    min = Math.min(min, velas[i]!.l);
    max = Math.max(max, velas[i]!.h);
  }
  if (!(max > min)) return [];

  const paso = (max - min) / niveles;
  const cubos = new Array(niveles).fill(0);
  for (let i = desde; i <= hasta && i < velas.length; i += 1) {
    const v = velas[i]!;
    if (v.v == null || !(v.v > 0)) continue;
    const lo = Math.max(0, Math.floor((v.l - min) / paso));
    const hi = Math.min(niveles - 1, Math.floor((v.h - min) / paso));
    const reparto = v.v / (hi - lo + 1);
    for (let k = lo; k <= hi; k += 1) cubos[k] += reparto;
  }
  return cubos.map((volumen, k) => ({ precio: min + paso * (k + 0.5), volumen }));
}

/** Punto de control: el nivel con mas volumen del perfil. Es el objetivo de su modelo. */
export function poc(p: NodoVolumen[]): number | null {
  if (p.length === 0) return null;
  return p.reduce((a, b) => (b.volumen > a.volumen ? b : a)).precio;
}

/**
 * Nodo de BAJO volumen dentro del tramo, excluyendo los extremos del perfil.
 *
 * Los bordes casi siempre tienen poco volumen por construccion (el precio estuvo poco tiempo
 * ahi), asi que cogerlos seria trivial y no significaria nada. Se busca el minimo interior.
 */
export function nodoBajo(p: NodoVolumen[], margen = 0.2): number | null {
  if (p.length < 5) return null;
  const desde = Math.floor(p.length * margen);
  const hasta = Math.ceil(p.length * (1 - margen));
  let mejor: NodoVolumen | null = null;
  for (let i = desde; i < hasta; i += 1) {
    if (!mejor || p[i]!.volumen < mejor.volumen) mejor = p[i]!;
  }
  return mejor ? mejor.precio : null;
}
