/**
 * SMART MONEY CONCEPTS: barrido de liquidez + FVG invalidado (IFVG).
 *
 * LAS REGLAS, TAL COMO SE DESCRIBEN
 * ---------------------------------
 *   1. BARRIDO DE LIQUIDEZ: la mecha pasa un maximo o minimo previo pero el CIERRE vuelve
 *      dentro. Es un "fallo de desplazamiento", no una ruptura.
 *   2. FVG (fair value gap): hueco de tres velas donde la mecha de la primera y la de la
 *      tercera no se solapan. Es el desequilibrio.
 *   3. IFVG: ese FVG, en vez de respetarse, se INVALIDA — el precio cierra al otro lado. Ese es
 *      el disparador de entrada.
 *   4. Stop mas alla del barrido, objetivo en el siguiente punto de interes sin alcanzar.
 *
 * OJO CON UNA DIFERENCIA QUE IMPORTA
 * ----------------------------------
 * `barridoLiquidez` en `estructura.ts` exige CIERRE mas alla del nivel: es una ruptura. Aqui es
 * justo lo contrario, el cierre tiene que volver dentro. Son dos cosas distintas y mezclarlas
 * mediria otra estrategia.
 *
 * Todo puro y sin mirar el futuro: un swing solo se puede usar cuando queda confirmado, y el
 * FVG solo cuando se cierra su tercera vela.
 */
import type { Vela } from "./datos";

export type Direccion = "LARGO" | "CORTO";

export interface Fvg {
  /** Indice de la TERCERA vela: antes de que cierre, el hueco no se conoce. */
  i: number;
  /** ALCISTA = hueco dejado subiendo (soporte); BAJISTA = bajando (resistencia). */
  direccion: "ALCISTA" | "BAJISTA";
  alto: number;
  bajo: number;
}

/**
 * Huecos de valor razonable. Un FVG alcista existe cuando el minimo de la tercera vela queda
 * por encima del maximo de la primera: hay un tramo de precio que no se negocio.
 */
export function fvgs(velas: Vela[], minTamaño = 0): Fvg[] {
  const out: Fvg[] = [];
  for (let i = 2; i < velas.length; i += 1) {
    const a = velas[i - 2]!;
    const c = velas[i]!;
    if (c.l > a.h) {
      const t = (c.l - a.h) / a.h;
      if (t >= minTamaño) out.push({ i, direccion: "ALCISTA", alto: c.l, bajo: a.h });
    } else if (c.h < a.l) {
      const t = (a.l - c.h) / c.h;
      if (t >= minTamaño) out.push({ i, direccion: "BAJISTA", alto: a.l, bajo: c.h });
    }
  }
  return out;
}

export interface Barrido {
  i: number;
  /** LARGO cuando se barre un MINIMO (se espera subida). */
  direccion: Direccion;
  /** Nivel barrido: el extremo del swing. */
  nivel: number;
  /** Extremo alcanzado por la mecha, donde ira el stop. */
  extremo: number;
}

/**
 * Barrido con RECHAZO: la mecha supera el extremo de las `n` velas anteriores pero el cierre
 * vuelve dentro.
 *
 * Que el cierre vuelva dentro es la condicion entera. Si cierra fuera es una ruptura, que es la
 * estrategia contraria.
 */
export function barridos(velas: Vela[], n: number): Barrido[] {
  const out: Barrido[] = [];
  for (let i = n; i < velas.length; i += 1) {
    let alto = -Infinity;
    let bajo = Infinity;
    for (let k = i - n; k < i; k += 1) {
      alto = Math.max(alto, velas[k]!.h);
      bajo = Math.min(bajo, velas[k]!.l);
    }
    const v = velas[i]!;
    // Minimo barrido y recuperado -> se espera subida.
    if (v.l < bajo && v.c > bajo) out.push({ i, direccion: "LARGO", nivel: bajo, extremo: v.l });
    else if (v.h > alto && v.c < alto) {
      out.push({ i, direccion: "CORTO", nivel: alto, extremo: v.h });
    }
  }
  return out;
}

export interface SeñalIct {
  i: number;
  direccion: Direccion;
  /** Precio del stop: mas alla del extremo del barrido. */
  stop: number;
  /** Objetivo: el siguiente punto de interes sin alcanzar. */
  objetivo: number;
  /** Vela del barrido que originó la señal. */
  iBarrido: number;
}

/** ¿Cae `t` dentro de la ventana [desdeH, hastaH) en horas UTC? Admite ventanas que cruzan medianoche. */
export function enVentana(t: number, desdeH: number, hastaH: number): boolean {
  const d = new Date(t * 1000);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return desdeH <= hastaH ? h >= desdeH && h < hastaH : h >= desdeH || h < hastaH;
}

export interface AjustesIct {
  /** Velas hacia atras para definir el extremo que se barre. */
  swing: number;
  /** Velas maximas entre el barrido y el IFVG. Pasadas, la señal caduca. */
  ventanaIfvg: number;
  /** Tamaño minimo del FVG en fraccion del precio. Filtra huecos de ruido. */
  minFvg: number;
  /** Ventana horaria en UTC. */
  desdeH: number;
  hastaH: number;
  /** Colchon del stop mas alla del extremo, en fraccion del riesgo. */
  colchon: number;
}

/**
 * Señales completas: barrido, luego IFVG en la misma direccion, dentro de la ventana horaria.
 *
 * El IFVG se detecta asi: tras el barrido se busca un FVG CONTRARIO a la direccion de la
 * operacion (el que representa el desequilibrio que hay que invalidar) y se entra cuando una
 * vela CIERRA al otro lado de ese hueco. Eso es "invalidarlo" y es el disparador.
 *
 * El objetivo es el extremo opuesto de las `swing` velas previas al barrido: el punto de interes
 * que el mercado dejo sin alcanzar. Se calcula con velas ANTERIORES a la entrada.
 */
export function señales(velas: Vela[], aj: AjustesIct): SeñalIct[] {
  const huecos = fvgs(velas, aj.minFvg);
  const porVela = new Map<number, Fvg[]>();
  for (const f of huecos) {
    const l = porVela.get(f.i);
    if (l) l.push(f);
    else porVela.set(f.i, [f]);
  }

  const out: SeñalIct[] = [];
  for (const b of barridos(velas, aj.swing)) {
    const largo = b.direccion === "LARGO";
    // FVG a invalidar: el contrario a la operacion, formado ANTES o EN el barrido.
    const contrario = largo ? "BAJISTA" : "ALCISTA";
    let candidato: Fvg | null = null;
    for (let k = Math.max(2, b.i - aj.swing); k <= b.i; k += 1) {
      for (const f of porVela.get(k) ?? []) if (f.direccion === contrario) candidato = f;
    }
    if (!candidato) continue;

    // Entrada: primera vela posterior al barrido que CIERRA al otro lado del hueco.
    for (let j = b.i + 1; j <= Math.min(velas.length - 1, b.i + aj.ventanaIfvg); j += 1) {
      const v = velas[j]!;
      const invalidado = largo ? v.c > candidato.alto : v.c < candidato.bajo;
      if (!invalidado) continue;
      if (!enVentana(v.t, aj.desdeH, aj.hastaH)) break;

      const riesgo = Math.abs(v.c - b.extremo);
      if (!(riesgo > 0)) break;
      const stop = largo
        ? b.extremo - riesgo * aj.colchon
        : b.extremo + riesgo * aj.colchon;

      // Objetivo: el extremo opuesto del tramo previo al barrido, sin mirar velas futuras.
      let objetivo = largo ? -Infinity : Infinity;
      for (let k = Math.max(0, b.i - aj.swing); k < b.i; k += 1) {
        objetivo = largo
          ? Math.max(objetivo, velas[k]!.h)
          : Math.min(objetivo, velas[k]!.l);
      }
      if (!Number.isFinite(objetivo)) break;
      // El objetivo tiene que estar a favor: si ya se paso, no hay operacion.
      if (largo ? objetivo <= v.c : objetivo >= v.c) break;

      out.push({ i: j, direccion: b.direccion, stop, objetivo, iBarrido: b.i });
      break;
    }
  }
  return out;
}

export interface ResultadoIct {
  r: number;
  velas: number;
  motivo: "OBJETIVO" | "STOP" | "TIEMPO";
  /** Relacion riesgo-beneficio que ofrecia la señal. */
  rr: number;
}

/**
 * Simula la operacion: entrada en la apertura siguiente, stop y objetivo fijos.
 *
 * Si en una vela se tocan los dos, cuenta el STOP: no se conoce el orden intravela.
 */
export function simular(
  velas: Vela[],
  s: SeñalIct,
  coste: number,
  maxVelas: number,
): ResultadoIct | null {
  const i0 = s.i + 1;
  if (i0 >= velas.length) return null;
  const largo = s.direccion === "LARGO";
  const entrada = velas[i0]!.o + (largo ? coste : -coste);
  const riesgo = Math.abs(entrada - s.stop);
  if (!(riesgo > 0)) return null;
  const rr = Math.abs(s.objetivo - entrada) / riesgo;

  for (let j = i0; j < velas.length; j += 1) {
    const v = velas[j]!;
    if (largo ? v.l <= s.stop : v.h >= s.stop) {
      return { r: (largo ? s.stop - coste - entrada : entrada - s.stop - coste) / riesgo, velas: j - i0, motivo: "STOP", rr };
    }
    if (largo ? v.h >= s.objetivo : v.l <= s.objetivo) {
      return { r: (largo ? s.objetivo - coste - entrada : entrada - s.objetivo - coste) / riesgo, velas: j - i0, motivo: "OBJETIVO", rr };
    }
    if (maxVelas > 0 && j - i0 >= maxVelas) {
      const bruto = largo ? v.c - entrada : entrada - v.c;
      return { r: (bruto - coste) / riesgo, velas: j - i0, motivo: "TIEMPO", rr };
    }
  }
  return null;
}

/**
 * Deja como mucho UNA señal por dia y sesion, que es la regla del plan: un TP o un SL y fuera.
 *
 * Sin esto la muestra se llena de operaciones que en la practica nunca se habrian tomado, y el
 * resultado no corresponde al plan que se esta probando.
 */
export function unaPorSesion(velas: Vela[], ss: SeñalIct[]): SeñalIct[] {
  const vistos = new Set<string>();
  const out: SeñalIct[] = [];
  for (const s of ss) {
    const clave = new Date(velas[s.i]!.t * 1000).toISOString().slice(0, 13);
    const dia = clave.slice(0, 10);
    if (vistos.has(dia)) continue;
    vistos.add(dia);
    out.push(s);
  }
  return out;
}
