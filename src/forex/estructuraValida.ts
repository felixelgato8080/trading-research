/**
 * ESTRUCTURA DE MERCADO con la regla del MINIMO VALIDO, mas oferta y demanda.
 *
 * LA REGLA QUE LA DISTINGUE
 * -------------------------
 * Casi todo el mundo dice "tendencia bajista" en cuanto el precio rompe un minimo cualquiera.
 * Aqui no: un minimo solo es VALIDO si el movimiento que vino despues rompio el maximo anterior.
 * Un minimo que no rompio nada no cuenta, y romperlo no cambia la tendencia.
 *
 * En la practica eso significa llevar un solo nivel: el ultimo minimo validado. Mientras el
 * precio no lo pierda, se sigue en tendencia alcista aunque haga mínimos mas bajos por el camino.
 *
 * LO QUE HAY QUE CONCRETAR, porque el video lo deja a ojo
 * ------------------------------------------------------
 *   - "Movimiento impulsivo": aqui, una vela que se mueve mas de `impulso` ATR.
 *   - "Zona": el rango completo (minimo a maximo) de la vela ANTERIOR al impulso.
 *   - "Maximos recientes" como objetivo: el extremo del swing vigente.
 *
 * Sin fijar esos tres numeros la estrategia no es comprobable, y elegirlos despues de ver el
 * resultado seria hacer trampa.
 *
 * Todo puro y sin mirar el futuro.
 */
import type { Vela } from "./datos";

export type Tendencia = "ALCISTA" | "BAJISTA" | "INDEFINIDA";

export interface EstadoEstructura {
  tendencia: Tendencia;
  /** Ultimo minimo validado. Perderlo pasa a bajista. */
  minimoValido: number | null;
  /** Ultimo maximo validado. Superarlo pasa a alcista. */
  maximoValido: number | null;
  /** Extremo del swing en curso, candidato a validarse. */
  candidatoMin: number | null;
  candidatoMax: number | null;
}

/**
 * Recorre las velas llevando la estructura vela a vela.
 *
 * Devuelve el estado DESPUES de cada vela, asi que el estado del indice i solo usa informacion
 * hasta i inclusive. Es lo que permite decidir en i sin mirar i+1.
 */
export function estructura(velas: Vela[]): EstadoEstructura[] {
  const out: EstadoEstructura[] = [];
  let tendencia: Tendencia = "INDEFINIDA";
  let minimoValido: number | null = null;
  let maximoValido: number | null = null;
  let candidatoMin: number | null = null;
  let candidatoMax: number | null = null;

  for (let i = 0; i < velas.length; i += 1) {
    const v = velas[i]!;

    if (i === 0) {
      candidatoMin = v.l;
      candidatoMax = v.h;
      out.push({ tendencia, minimoValido, maximoValido, candidatoMin, candidatoMax });
      continue;
    }

    // LOS NIVELES DE REFERENCIA SE LEEN ANTES DE ACTUALIZAR NADA.
    //
    // Actualizar el candidato con la vela actual y luego compararla contra el se garantiza que
    // ninguna vela pueda romper su propio maximo, y nunca se validaria nada. Es el mismo fallo
    // que ya hubo que corregir en `canal()`.
    const referenciaAlta = maximoValido ?? candidatoMax;
    const referenciaBaja = minimoValido ?? candidatoMin;

    // VALIDACION AL ALZA: el cierre supera el maximo de referencia. El minimo del tramo
    // recorrido hasta aqui pasa a ser el minimo VALIDO, y arranca un swing nuevo.
    if (referenciaAlta != null && v.c > referenciaAlta) {
      minimoValido = candidatoMin;
      maximoValido = null;
      candidatoMax = v.h;
      candidatoMin = v.l;
      tendencia = "ALCISTA";
    } else if (referenciaBaja != null && v.c < referenciaBaja) {
      // VALIDACION A LA BAJA, el espejo. En `else if` porque una vela no puede romper por
      // arriba y por abajo a la vez: si el cierre esta por encima del maximo, no esta por
      // debajo del minimo.
      maximoValido = candidatoMax;
      minimoValido = null;
      candidatoMin = v.l;
      candidatoMax = v.h;
      tendencia = "BAJISTA";
    } else {
      // Sin ruptura, el swing en curso simplemente se ensancha.
      candidatoMin = candidatoMin == null ? v.l : Math.min(candidatoMin, v.l);
      candidatoMax = candidatoMax == null ? v.h : Math.max(candidatoMax, v.h);
    }

    out.push({ tendencia, minimoValido, maximoValido, candidatoMin, candidatoMax });
  }
  return out;
}

export interface Zona {
  /** Vela que forma la zona: la ANTERIOR al impulso. */
  i: number;
  tipo: "DEMANDA" | "OFERTA";
  alto: number;
  bajo: number;
  /** Objetivo: el extremo alcanzado por el impulso. */
  objetivo: number;
  /** Si ya fue visitada. Una zona solo se opera la primera vez. */
  usada: boolean;
}

/**
 * Zonas de oferta y demanda: la vela anterior a un movimiento impulsivo.
 *
 * "Impulsivo" se concreta como una vela cuyo cuerpo supera `impulso` veces el ATR. Sin un umbral
 * numerico, "movimiento grande" lo decide quien mira el grafico, y entonces la estrategia no se
 * puede comprobar.
 */
export function zonas(
  velas: Vela[],
  atrValores: (number | null)[],
  impulso: number,
): Zona[] {
  const out: Zona[] = [];
  for (let i = 1; i < velas.length; i += 1) {
    const a = atrValores[i - 1];
    if (a == null || !(a > 0)) continue;
    const v = velas[i]!;
    const cuerpo = v.c - v.o;
    if (Math.abs(cuerpo) < a * impulso) continue;
    const base = velas[i - 1]!;
    out.push({
      i: i - 1,
      tipo: cuerpo > 0 ? "DEMANDA" : "OFERTA",
      alto: base.h,
      bajo: base.l,
      objetivo: cuerpo > 0 ? v.h : v.l,
      usada: false,
    });
  }
  return out;
}

export interface SeñalZona {
  i: number;
  direccion: "LARGO" | "CORTO";
  entrada: number;
  stop: number;
  objetivo: number;
  rr: number;
}

export interface AjustesZona {
  /** Cuerpo minimo en ATR para considerar impulso. */
  impulso: number;
  /** Colchon del stop mas alla de la zona, en fraccion de la altura de la zona. */
  colchon: number;
  /** Relacion riesgo-beneficio minima. El video pide 2,5. */
  rrMinimo: number;
  /** Velas maximas que una zona sigue viva. */
  vigencia: number;
  /**
   * Si false, se opera la zona sin exigir que la tendencia acompañe.
   *
   * Existe SOLO para aislar cuanto aporta el paso 1 del metodo. Medir "con y sin" es la unica
   * forma de saber si el filtro de tendencia hace algo o es adorno.
   */
  exigirTendencia?: boolean;
}

/**
 * Señales completas: tendencia a favor, precio vuelve a la zona, y R:R suficiente.
 *
 * Se opera SOLO a favor de la tendencia validada, que es la regla central del metodo. Y cada
 * zona se usa una sola vez: reentrar en la misma zona diez veces inflaria la muestra con la
 * misma decision repetida.
 */
export function señales(
  velas: Vela[],
  atrValores: (number | null)[],
  aj: AjustesZona,
): SeñalZona[] {
  const est = estructura(velas);
  const zs = zonas(velas, atrValores, aj.impulso);
  const out: SeñalZona[] = [];

  for (const z of zs) {
    const altura = z.alto - z.bajo;
    if (!(altura > 0)) continue;

    for (let j = z.i + 2; j < Math.min(velas.length, z.i + 2 + aj.vigencia); j += 1) {
      const e = est[j - 1]!;
      const v = velas[j]!;

      // La tendencia tiene que acompañar, mirada con la vela ANTERIOR.
      if (aj.exigirTendencia !== false) {
        if (z.tipo === "DEMANDA" && e.tendencia !== "ALCISTA") continue;
        if (z.tipo === "OFERTA" && e.tendencia !== "BAJISTA") continue;
      }

      const largo = z.tipo === "DEMANDA";
      // Entrada al tocar la zona.
      const toca = largo ? v.l <= z.alto : v.h >= z.bajo;
      if (!toca) continue;

      const entrada = largo ? z.alto : z.bajo;
      const stop = largo
        ? z.bajo - altura * aj.colchon
        : z.alto + altura * aj.colchon;
      const riesgo = Math.abs(entrada - stop);
      if (!(riesgo > 0)) break;

      const rr = Math.abs(z.objetivo - entrada) / riesgo;
      // El filtro de R:R del paso 3. Si no llega, NO se opera: es una regla, no una preferencia.
      if (rr < aj.rrMinimo) break;
      // Un objetivo que ya quedo detras no es un objetivo.
      if (largo ? z.objetivo <= entrada : z.objetivo >= entrada) break;

      out.push({
        i: j, direccion: largo ? "LARGO" : "CORTO",
        entrada, stop, objetivo: z.objetivo, rr,
      });
      break;
    }
  }
  return out;
}

export interface ResultadoZona {
  r: number;
  velas: number;
  motivo: "OBJETIVO" | "STOP" | "TIEMPO";
  rr: number;
}

/**
 * Que extremo de la vela de entrada se puede creer.
 *
 * "MINIMO" si el precio venia BAJANDO cuando se lleno la orden, "MAXIMO" si venia subiendo,
 * "NINGUNO" si se entro al cierre y de esa vela ya no queda nada.
 */
export type ExtremoEntrada = "MINIMO" | "MAXIMO" | "NINGUNO";

/**
 * Simula el bracket. Stop y objetivo fijos.
 *
 * LA VELA DE ENTRADA SOLO VALE POR UN LADO
 * ----------------------------------------
 * La entrada es una orden limitada que se llena DENTRO de la vela `s.i`. Uno de los dos extremos
 * de esa vela ya habia ocurrido cuando se entro, y darlo por bueno es mirar el futuro al reves.
 * Cual de los dos sigue siendo alcanzable depende de hacia donde iba el precio al llenarse, NO
 * de si la operacion es larga o corta:
 *
 *   - Zona de demanda (el precio CAE hasta el techo de la zona): despues del llenado el precio
 *     todavia puede seguir bajando, asi que el minimo vale. El maximo de esa vela se hizo antes.
 *   - Zona de oferta: lo simetrico.
 *
 * Distinguirlo importa: si se dedujera el extremo valido de la direccion de la operacion, dar la
 * vuelta a una señal para usarla de control la mataria con un extremo que ya habia pasado, y el
 * control diria que acertar el lado aporta muchisimo cuando en realidad no medía nada.
 *
 * Por defecto se deduce del lado de la señal, que para una señal de zona es lo mismo y deja la
 * convencion de siempre: cuando no se sabe el orden dentro de la vela, gana lo malo.
 */
export function simular(
  velas: Vela[],
  s: SeñalZona,
  coste: number,
  maxVelas: number,
  extremoEntrada?: ExtremoEntrada,
): ResultadoZona | null {
  const largo = s.direccion === "LARGO";
  const riesgo = Math.abs(s.entrada - s.stop);
  if (!(riesgo > 0)) return null;
  const extremo: ExtremoEntrada = extremoEntrada ?? (largo ? "MINIMO" : "MAXIMO");

  for (let j = s.i; j < velas.length; j += 1) {
    const v = velas[j]!;
    const primera = j === s.i;
    // En la vela de entrada solo se mira el extremo que el precio aun podia alcanzar.
    const usaMin = !primera || extremo === "MINIMO";
    const usaMax = !primera || extremo === "MAXIMO";

    const tocaStop = largo ? usaMin && v.l <= s.stop : usaMax && v.h >= s.stop;
    if (tocaStop) {
      return { r: -1 - coste / riesgo, velas: j - s.i, motivo: "STOP", rr: s.rr };
    }
    const tocaObj = largo ? usaMax && v.h >= s.objetivo : usaMin && v.l <= s.objetivo;
    if (tocaObj) {
      return { r: s.rr - coste / riesgo, velas: j - s.i, motivo: "OBJETIVO", rr: s.rr };
    }
    if (maxVelas > 0 && j - s.i >= maxVelas) {
      const bruto = largo ? v.c - s.entrada : s.entrada - v.c;
      return { r: (bruto - coste) / riesgo, velas: j - s.i, motivo: "TIEMPO", rr: s.rr };
    }
  }
  return null;
}
