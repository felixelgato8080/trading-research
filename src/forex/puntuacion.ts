/**
 * PUNTUAR LAS CONFLUENCIAS, y comprobar si puntuar sirve para algo.
 *
 * LA PREGUNTA
 * -----------
 * Todos los metodos de esta familia dicen lo mismo: no operes una señal suelta, espera a que se
 * junten varias cosas. Barrido de liquidez, divergencia, cambio de estructura, rechazo, zona de
 * temporalidad mayor, sesion, R:R. Cada una suma puntos y solo se opera por encima de un umbral.
 *
 * Suena razonable y puede ser falso. La unica forma de saberlo es medir si la esperanza CRECE
 * con el score. Si un setup de 9 puntos rinde igual que uno de 6, las confluencias son adorno
 * caro: recortan la muestra sin mejorar nada.
 *
 * POR QUE NO BASTA CON QUE "LOS DE 9 GANEN DINERO"
 * -----------------------------------------------
 * Con menos operaciones cualquier subconjunto puede parecer mejor por azar. Lo que decide es la
 * PENDIENTE: que la esperanza suba de forma ordenada al subir el score, y que cada factor por
 * separado separe a los que lo tienen de los que no. Las dos cosas se miden aqui.
 *
 * Todo se evalua en el instante de la señal y solo con lo que habia a la izquierda. Un factor
 * que solo se sabe despues no es un filtro, es una explicacion.
 */
import type { Vela } from "./datos";
import { hayLiquidez } from "./smc";
import { picos, type Divergencia } from "./divergencia";

export interface Factores {
  /** El nivel roto tenia varios extremos previos apilados: habia stops que barrer. */
  barrido: boolean;
  /** El segundo pico del RSI ni se asomo al canal. */
  divergenciaLimpia: boolean;
  /** Tras la divergencia el precio cerro al otro lado del ultimo extremo opuesto. */
  cambioEstructura: boolean;
  /** La vela del segundo pico dejo una mecha larga en contra. */
  rechazo: boolean;
  /** El pico cayo cerca de un extremo importante de mucho antes. */
  zonaMayor: boolean;
  /** La entrada cae en Londres o Nueva York. */
  sesion: boolean;
  /** El objetivo paga tres veces el riesgo o mas. */
  rrAlto: boolean;
}

export interface PesosFactores {
  barrido: number;
  divergenciaLimpia: number;
  cambioEstructura: number;
  rechazo: number;
  zonaMayor: number;
  sesion: number;
  rrAlto: number;
}

/** Los pesos que proponen los metodos de esta familia. Se miden, no se dan por buenos. */
export const PESOS: PesosFactores = {
  barrido: 2,
  divergenciaLimpia: 2,
  cambioEstructura: 2,
  rechazo: 1,
  zonaMayor: 1,
  sesion: 1,
  rrAlto: 1,
};

export function puntuar(f: Factores, pesos: PesosFactores = PESOS): number {
  return (Object.keys(pesos) as Array<keyof PesosFactores>)
    .reduce((s, k) => s + (f[k] ? pesos[k] : 0), 0);
}

export interface AjustesPuntuacion {
  umbralAlto: number;
  /** Radio para considerar que varios extremos son el mismo nivel, en ATR. */
  radioLiquidez: number;
  /** Extremos previos apilados que hacen del nivel una bolsa de liquidez. */
  toquesLiquidez: number;
  /** Cuantas velas atras se mira para el barrido. */
  memoriaBarrido: number;
  /** Cuantas velas atras se mira para las zonas de temporalidad mayor. */
  memoriaZona: number;
  /** Velas a cada lado que confirman un extremo. */
  confirmacion: number;
  /** Mecha minima en contra, como fraccion del rango de la vela. */
  minRechazo: number;
  /** Horas UTC de sesion. */
  desdeHora: number;
  hastaHora: number;
}

export const AJUSTES: AjustesPuntuacion = {
  umbralAlto: 70, radioLiquidez: 0.5, toquesLiquidez: 2, memoriaBarrido: 100,
  memoriaZona: 500, confirmacion: 2, minRechazo: 0.4, desdeHora: 7, hastaHora: 16,
};

/**
 * Los factores de una divergencia concreta.
 *
 * `tEntrada` es el momento de la entrada en la temporalidad menor, y solo se usa para la sesion:
 * todo lo demas se decide en la temporalidad mayor y en el instante del segundo pico.
 */
export function factores(
  velas: Vela[],
  atrValores: (number | null)[],
  d: Divergencia,
  rr: number,
  tEntrada: number,
  aj: AjustesPuntuacion = AJUSTES,
): Factores {
  const alza = d.direccion === "BAJISTA";   // el segundo pico es un MAXIMO
  const escala = atrValores[d.pico2] ?? null;
  const vPico = velas[d.pico2]!;

  // BARRIDO: extremos previos apilados en el nivel del PRIMER pico, que el segundo supero.
  const barrido = escala != null && escala > 0
    ? hayLiquidez(
        velas, d.pico2, velas[d.pico1]![alza ? "h" : "l"],
        escala * aj.radioLiquidez, aj.toquesLiquidez, aj.memoriaBarrido, aj.confirmacion,
      )
    : false;

  // RECHAZO: mecha larga en contra del pico. Un maximo con mecha superior larga es un rechazo.
  const rango = vPico.h - vPico.l;
  const mecha = alza
    ? vPico.h - Math.max(vPico.o, vPico.c)
    : Math.min(vPico.o, vPico.c) - vPico.l;
  const rechazo = rango > 0 && mecha / rango >= aj.minRechazo;

  // ZONA MAYOR: el pico cae cerca de un extremo importante y antiguo, ya confirmado.
  //
  // Solo cuentan extremos confirmados ANTES del pico: un nivel que se forma despues no estaba
  // ahi para reaccionar contra el.
  let zonaMayor = false;
  if (escala != null && escala > 0) {
    const desde = Math.max(0, d.pico2 - aj.memoriaZona);
    const previas = velas.slice(desde, d.pico2 + 1);
    for (const p of picos(previas, aj.confirmacion, alza)) {
      if (p.confirmadoEn >= previas.length - aj.confirmacion) continue;
      if (Math.abs(p.valor - vPico[alza ? "h" : "l"]) <= escala * aj.radioLiquidez) {
        zonaMayor = true;
        break;
      }
    }
  }

  // CAMBIO DE ESTRUCTURA: entre el segundo pico y la confirmacion, el precio cierra al otro lado
  // del ultimo extremo OPUESTO conocido. Es el CHoCH de estos metodos.
  let cambioEstructura = false;
  {
    const opuestos = picos(velas.slice(0, d.pico2 + 1), aj.confirmacion, !alza);
    const ultimo = opuestos[opuestos.length - 1];
    if (ultimo) {
      for (let j = d.pico2 + 1; j <= d.i && j < velas.length; j += 1) {
        const c = velas[j]!;
        if (alza ? c.c < ultimo.valor : c.c > ultimo.valor) { cambioEstructura = true; break; }
      }
    }
  }

  const h = new Date(tEntrada * 1000).getUTCHours();

  return {
    barrido,
    divergenciaLimpia: alza
      ? d.rsi2 < aj.umbralAlto
      : d.rsi2 > 100 - aj.umbralAlto,
    cambioEstructura,
    rechazo,
    zonaMayor,
    sesion: h >= aj.desdeHora && h < aj.hastaHora,
    rrAlto: rr >= 3,
  };
}
