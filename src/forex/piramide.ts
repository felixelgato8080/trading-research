/**
 * PIRAMIDAR: añadir unidades solo cuando la operacion original YA va bien.
 *
 * LO QUE NO ES
 * ------------
 * Esto no es martingala y la diferencia no es de grado. La martingala aumenta despues de PERDER,
 * apostando a que el siguiente compensa. Aqui solo se añade despues de GANAR, y cada unidad trae
 * su propio stop tecnico. Una serie de perdidas reduce la exposicion en vez de aumentarla.
 *
 * LA TRAMPA DE MEDIRLO
 * --------------------
 * Tres unidades al 1% son el TRIPLE de riesgo que una. Comparar el retorno sin mas siempre dara
 * que piramidar es mejor, porque subir el riesgo siempre sube el retorno. La comparacion honesta
 * es a riesgo igualado: si con tres unidades se arriesga 1% cada una, hay que compararla contra
 * una sola unidad al 3%, no al 1%.
 *
 * Por eso `simular` devuelve tanto el resultado por unidad como el riesgo total comprometido, y
 * el CLI normaliza antes de comparar.
 *
 * LO QUE DE VERDAD HAY QUE MIRAR
 * ------------------------------
 * No el retorno, sino si las unidades caen JUNTAS. Piramidar concentra: las tres unidades estan
 * en el mismo instrumento y en la misma direccion, asi que un giro las mata a la vez. Eso es lo
 * que `perdidasSimultaneas` cuenta.
 */
import type { Vela } from "./datos";
import type { SeñalRuptura, Direccion } from "./rupturas";

export interface AjustesPiramide {
  /** Distancia del stop inicial, en ATR. */
  stopAtr: number;
  /** Multiplo del stop para el trailing. 0 lo desactiva. */
  trailing: number;
  /** Maximo de unidades abiertas a la vez en el mismo instrumento y direccion. */
  maxUnidades: number;
  /**
   * Beneficio minimo de las unidades ya abiertas, en R, para permitir añadir otra.
   *
   * Es la regla que separa esto de la martingala: sin beneficio, no se añade.
   */
  minBeneficioR: number;
  /** Al añadir una unidad, mover el stop de las anteriores a su entrada. */
  moverABreakeven: boolean;
  /** Coste por unidad, en fraccion del precio. */
  costeFraccion: number;
}

export interface Unidad {
  /** Vela de entrada. */
  iEntrada: number;
  iSalida: number;
  entrada: number;
  stopInicial: number;
  salida: number;
  r: number;
  /** 1 = la original, 2 = la primera añadida, etc. */
  orden: number;
  motivo: "STOP" | "TRAILING" | "FIN";
}

export interface ResultadoPiramide {
  unidades: Unidad[];
  /** Cuantas veces se cerraron dos o mas unidades a la vez EN PERDIDA. */
  perdidasSimultaneas: number;
  /** Maximo de unidades abiertas simultaneamente. */
  maxSimultaneas: number;
  /** Suma de riesgo comprometido a la vez, en unidades de riesgo. Es el pico de exposicion. */
  maxRiesgoSimultaneo: number;
}

interface Viva {
  iEntrada: number;
  entrada: number;
  stopInicial: number;
  nivel: number;
  extremo: number;
  orden: number;
}

/**
 * Simula una piramide sobre las señales de UN instrumento y una direccion.
 *
 * Las señales tienen que venir ordenadas. Una señal nueva mientras hay unidades vivas añade otra
 * unidad si se cumplen las condiciones; si no, se descarta (no se abre una operacion aparte, que
 * seria otra estrategia).
 */
export function simular(
  velas: Vela[],
  señales: SeñalRuptura[],
  atrValores: (number | null)[],
  direccion: Direccion,
  aj: AjustesPiramide,
): ResultadoPiramide {
  const largo = direccion === "LARGO";
  const unidades: Unidad[] = [];
  let vivas: Viva[] = [];
  let perdidasSimultaneas = 0;
  let maxSimultaneas = 0;
  let maxRiesgoSimultaneo = 0;

  const porSeñal = new Map<number, SeñalRuptura>();
  for (const s of señales) if (s.direccion === direccion) porSeñal.set(s.i + 1, s);

  for (let i = 0; i < velas.length; i += 1) {
    const v = velas[i]!;

    // ---- 1. Resolver lo vivo. El stop gana los empates: no se sabe el orden intravela. -----
    const siguen: Viva[] = [];
    let cerradasEnPerdida = 0;
    for (const u of vivas) {
      if (i === u.iEntrada) { siguen.push(u); continue; }
      const toca = largo ? v.l <= u.nivel : v.h >= u.nivel;
      if (toca) {
        // Si la vela ABRE ya pasada del nivel, se llena en la apertura: a ese nivel no te llena
        // nadie. Es la misma correccion que en `simularRuptura`.
        const salida = (largo ? v.o < u.nivel : v.o > u.nivel) ? v.o : u.nivel;
        const riesgo = Math.abs(u.entrada - u.stopInicial);
        const bruto = largo ? salida - u.entrada : u.entrada - salida;
        const r = (bruto - Math.abs(u.entrada) * aj.costeFraccion) / riesgo;
        unidades.push({
          iEntrada: u.iEntrada, iSalida: i, entrada: u.entrada, stopInicial: u.stopInicial,
          salida, r, orden: u.orden,
          motivo: u.nivel === u.stopInicial ? "STOP" : "TRAILING",
        });
        if (r < 0) cerradasEnPerdida += 1;
        continue;
      }
      siguen.push(u);
    }
    if (cerradasEnPerdida >= 2) perdidasSimultaneas += 1;
    vivas = siguen;

    // ---- 2. ¿Se añade una unidad? -----------------------------------------------------------
    const s = porSeñal.get(i);
    if (s && vivas.length < aj.maxUnidades) {
      const av = atrValores[s.i];
      if (av != null && av > 0) {
        const stop = av * aj.stopAtr;
        const entrada = v.o;
        // LA REGLA QUE ESTO NO ES MARTINGALA: solo se añade si TODAS las vivas van en beneficio.
        // Con cero vivas la condicion se cumple sola, que es la entrada original.
        const todasEnBeneficio = vivas.every((u) => {
          const riesgo = Math.abs(u.entrada - u.stopInicial);
          const ganado = largo ? entrada - u.entrada : u.entrada - entrada;
          return riesgo > 0 && ganado / riesgo >= aj.minBeneficioR;
        });
        if (todasEnBeneficio) {
          if (aj.moverABreakeven) {
            for (const u of vivas) {
              u.nivel = largo ? Math.max(u.nivel, u.entrada) : Math.min(u.nivel, u.entrada);
            }
          }
          vivas.push({
            iEntrada: i, entrada,
            stopInicial: largo ? entrada - stop : entrada + stop,
            nivel: largo ? entrada - stop : entrada + stop,
            extremo: entrada,
            orden: vivas.length + 1,
          });
          maxSimultaneas = Math.max(maxSimultaneas, vivas.length);
          maxRiesgoSimultaneo = Math.max(maxRiesgoSimultaneo, vivas.length);
        }
      }
    }

    // ---- 3. Mover trailings, con la vela ya vivida ------------------------------------------
    for (const u of vivas) {
      const riesgo = Math.abs(u.entrada - u.stopInicial);
      if (largo) {
        if (v.h > u.extremo) u.extremo = v.h;
        if (aj.trailing > 0) u.nivel = Math.max(u.nivel, u.extremo - riesgo * aj.trailing);
      } else {
        if (v.l < u.extremo) u.extremo = v.l;
        if (aj.trailing > 0) u.nivel = Math.min(u.nivel, u.extremo + riesgo * aj.trailing);
      }
    }
  }

  // Lo que queda abierto al final se cierra al ultimo cierre: dejarlo fuera seria quedarse solo
  // con las operaciones que ya terminaron, que suelen ser las malas.
  const ultima = velas[velas.length - 1];
  if (ultima) {
    for (const u of vivas) {
      const riesgo = Math.abs(u.entrada - u.stopInicial);
      const bruto = largo ? ultima.c - u.entrada : u.entrada - ultima.c;
      unidades.push({
        iEntrada: u.iEntrada, iSalida: velas.length - 1, entrada: u.entrada,
        stopInicial: u.stopInicial, salida: ultima.c,
        r: (bruto - Math.abs(u.entrada) * aj.costeFraccion) / riesgo,
        orden: u.orden, motivo: "FIN",
      });
    }
  }

  return { unidades, perdidasSimultaneas, maxSimultaneas, maxRiesgoSimultaneo };
}
