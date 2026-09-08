/**
 * Estrategias de RUPTURA. La familia opuesta a la reversion a la media.
 *
 * POR QUE ESTA FAMILIA
 * --------------------
 * Felix pide: acierto bajo, ganadores mucho mayores que perdedores, varias operaciones al dia.
 * Eso describe exactamente el perfil de una ruptura seguida de tendencia: fallas la mayoria de
 * las veces por poco y aciertas pocas por mucho.
 *
 * El RSI, medido durante toda esta investigacion, es lo contrario: acierto ~50% y ganadores
 * del tamaño de los perdedores. Por eso nunca podia dar el perfil que busca.
 *
 * Todo PURO y sin mirar el futuro: cada señal usa solo velas anteriores a la actual.
 */
import type { Vela } from "./datos";

export type Direccion = "LARGO" | "CORTO";

export interface SeñalRuptura {
  i: number;
  direccion: Direccion;
  /** Nivel roto, para poder apoyar el stop en el. */
  nivel: number;
}

/**
 * Ruptura de canal (Donchian): el precio cierra por encima del maximo de las ultimas N velas.
 *
 * El maximo se calcula SIN incluir la vela actual. Incluirla haria que el precio rompiera su
 * propio maximo y la señal no significaria nada.
 */
export function canal(velas: Vela[], n: number): SeñalRuptura[] {
  const out: SeñalRuptura[] = [];
  for (let i = n; i < velas.length; i += 1) {
    let alto = -Infinity;
    let bajo = Infinity;
    for (let k = i - n; k < i; k += 1) {
      alto = Math.max(alto, velas[k]!.h);
      bajo = Math.min(bajo, velas[k]!.l);
    }
    const c = velas[i]!.c;
    if (c > alto) out.push({ i, direccion: "LARGO", nivel: alto });
    else if (c < bajo) out.push({ i, direccion: "CORTO", nivel: bajo });
  }
  return out;
}

/**
 * Ruptura de volatilidad: el precio se mueve mas de `k` ATR desde la apertura de la vela.
 *
 * Capta impulsos que arrancan de golpe, que es donde una ruptura tiene mas continuidad. No
 * necesita historia de niveles, solo de volatilidad.
 */
export function volatilidad(
  velas: Vela[],
  atrValores: (number | null)[],
  k: number,
): SeñalRuptura[] {
  const out: SeñalRuptura[] = [];
  for (let i = 1; i < velas.length; i += 1) {
    const a = atrValores[i - 1];
    if (a == null || !(a > 0)) continue;
    const v = velas[i]!;
    const umbral = a * k;
    if (v.c - v.o > umbral) out.push({ i, direccion: "LARGO", nivel: v.o });
    else if (v.o - v.c > umbral) out.push({ i, direccion: "CORTO", nivel: v.o });
  }
  return out;
}

/**
 * Ruptura del rango de apertura de sesion.
 *
 * El rango se forma en las primeras `velasRango` velas desde `horaInicio` (UTC) y solo se
 * puede usar DESPUES de que se cierre: usar el rango del dia en curso mientras se forma es el
 * error clasico que hace que esta estrategia parezca rentable.
 *
 * Una señal por sesion y direccion: si el rango se rompe varias veces, solo cuenta la primera.
 */
export function rangoApertura(
  velas: Vela[],
  horaInicio: number,
  velasRango: number,
): SeñalRuptura[] {
  const out: SeñalRuptura[] = [];
  let alto = -Infinity;
  let bajo = Infinity;
  let formadas = 0;
  let listo = false;
  let usadaLargo = false;
  let usadaCorto = false;
  let diaActual = "";

  for (let i = 0; i < velas.length; i += 1) {
    const v = velas[i]!;
    const d = new Date(v.t * 1000);
    const dia = d.toISOString().slice(0, 10);
    const hora = d.getUTCHours();

    if (dia !== diaActual) {
      diaActual = dia;
      alto = -Infinity;
      bajo = Infinity;
      formadas = 0;
      listo = false;
      usadaLargo = false;
      usadaCorto = false;
    }

    if (hora < horaInicio) continue;

    if (!listo) {
      // Se acumula el rango. La vela que lo forma no puede romperlo.
      alto = Math.max(alto, v.h);
      bajo = Math.min(bajo, v.l);
      formadas += 1;
      if (formadas >= velasRango) listo = true;
      continue;
    }

    if (!usadaLargo && v.c > alto) {
      out.push({ i, direccion: "LARGO", nivel: alto });
      usadaLargo = true;
    } else if (!usadaCorto && v.c < bajo) {
      out.push({ i, direccion: "CORTO", nivel: bajo });
      usadaCorto = true;
    }
  }
  return out;
}

export interface ResultadoOp {
  r: number;
  direccion: Direccion;
  velas: number;
  motivo: "STOP" | "TRAILING" | "TIEMPO" | "FIN";
}

/** Donde estaba el stop mientras corria una vela concreta. */
export interface PasoTraza {
  i: number;
  /** Nivel VIGENTE durante esa vela, antes de que la propia vela lo mueva. */
  nivel: number;
}

/**
 * El rastro de una operacion: lo que el simulador vio, para poder dibujarlo.
 *
 * Existe para que el dibujo salga del SIMULADOR y no de una reimplementacion. Un dibujo que
 * recalcula la operacion por su cuenta puede divergir del backtest, y entonces el grafico
 * tranquiliza mientras el numero esta mal: exactamente el fallo que se pretende cazar mirando.
 */
export interface TrazaOp {
  iEntrada: number;
  entrada: number;
  stopInicial: number;
  /** Un paso por vela vivida, con el stop vigente en cada una. */
  pasos: PasoTraza[];
  iSalida: number;
  salida: number;
}

/**
 * Simula con stop inicial y trailing, SIN objetivo fijo.
 *
 * Sin techo a proposito: la premisa de esta familia es que el resultado vive en la cola, y un
 * objetivo fijo la corta. Medido antes en este proyecto: pasar de objetivo fijo a trailing sube
 * el PF de 0,67 a 1,09.
 *
 * Si en una vela se tocan stop y maximo, se cuenta el STOP: no sabemos el orden intravela.
 */
export function simularRuptura(
  velas: Vela[],
  s: SeñalRuptura,
  stop: number,
  trailing: number,
  spread: number,
  maxVelas: number,
  deslizamiento = 0,
  /**
   * Si en la vela de ENTRADA el precio ya toca el stop, se cuenta como perdida. Es la regla mas
   * dura del proyecto y siempre va en contra: no se sabe el orden intravela, asi que se supone
   * lo peor.
   *
   * Ponerlo en false salta la vela de entrada, que es la suposicion OPTIMISTA. No es realista,
   * pero medir la diferencia dice cuanto pesa la regla en el resultado.
   */
  stopEnVelaEntrada = true,
  /**
   * Si la vela ABRE ya pasada del stop, se llena en la apertura y no en el nivel.
   *
   * El trailing se mueve una vez por vela, al cerrarla, que es como corre el bot de verdad: la
   * orden esta posada en el nivel VIEJO mientras la vela vive. Si la siguiente abre atravesada,
   * a ese nivel no te llena nadie; te llenan en la apertura, peor.
   *
   * Medido en cripto diario: pasa en el 4,3% de las operaciones y vale el 13,4% del resultado
   * (0,297R -> 0,257R). Ponerlo en false da la version optimista, util solo para comparar.
   */
  llenarEnApertura = true,
  /** Si se pasa, se rellena con lo que el simulador fue viendo. No cambia ninguna decision. */
  traza?: TrazaOp,
): ResultadoOp | null {
  const i0 = s.i + 1;
  if (i0 >= velas.length || !(stop > 0)) return null;

  const largo = s.direccion === "LARGO";
  // DESLIZAMIENTO ADVERSO, solo en la ENTRADA. Comprar una ruptura es comprar dentro de un
  // movimiento rapido: el llenado real es peor que la apertura, y siempre en tu contra. El
  // spread es simetrico; esto no lo es, y por eso va aparte. Es el unico riesgo del backtest
  // que no se puede medir sin operar de verdad, asi que al menos se puede acotar variandolo.
  const entrada = velas[i0]!.o + (largo ? spread + deslizamiento : -spread - deslizamiento);
  let nivel = largo ? entrada - stop : entrada + stop;
  let extremo = entrada;
  let motivo: ResultadoOp["motivo"] = "FIN";
  let salida: number | null = null;
  let j = i0;
  if (traza) {
    traza.iEntrada = i0;
    traza.entrada = entrada;
    traza.stopInicial = nivel;
    traza.pasos = [];
  }

  for (; j < velas.length; j += 1) {
    const c = velas[j]!;
    // El nivel se apunta ANTES de que esta vela lo mueva: es el que estuvo vigente durante ella.
    if (traza) traza.pasos.push({ i: j, nivel });
    if (j === i0 && !stopEnVelaEntrada) {
      if (largo) {
        if (c.h > extremo) extremo = c.h;
        if (trailing > 0) nivel = Math.max(nivel, extremo - stop * trailing);
      } else {
        if (c.l < extremo) extremo = c.l;
        if (trailing > 0) nivel = Math.min(nivel, extremo + stop * trailing);
      }
      continue;
    }
    if (largo ? c.l <= nivel : c.h >= nivel) {
      // Si la vela ya abrio pasada del nivel, ese nivel no era alcanzable: se llena en la
      // apertura. Siempre es peor o igual, nunca mejor.
      salida = llenarEnApertura && (largo ? c.o < nivel : c.o > nivel) ? c.o : nivel;
      // Distinguir el stop inicial del trailing dice si la estrategia muere pronto o recorta
      // ganancias: son dos problemas distintos con soluciones distintas.
      motivo = nivel === (largo ? entrada - stop : entrada + stop) ? "STOP" : "TRAILING";
      break;
    }
    if (maxVelas > 0 && j - i0 >= maxVelas) {
      salida = c.c;
      motivo = "TIEMPO";
      break;
    }
    if (largo) {
      if (c.h > extremo) extremo = c.h;
      if (trailing > 0) nivel = Math.max(nivel, extremo - stop * trailing);
    } else {
      if (c.l < extremo) extremo = c.l;
      if (trailing > 0) nivel = Math.min(nivel, extremo + stop * trailing);
    }
  }
  if (salida === null) salida = velas[velas.length - 1]!.c;
  if (traza) {
    traza.iSalida = Math.min(j, velas.length - 1);
    traza.salida = salida;
  }

  const neta = salida - (largo ? spread : -spread);
  return {
    r: (largo ? neta - entrada : entrada - neta) / stop,
    direccion: s.direccion,
    velas: Math.min(j, velas.length - 1) - i0,
    motivo,
  };
}
