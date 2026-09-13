/**
 * DIVERGENCIAS DE RSI con entrada en temporalidad menor.
 *
 * LA ESTRATEGIA, tal como se cuenta
 * ---------------------------------
 *   1. En 15m, el RSI sale del canal 70/30: hay sobrecompra (o sobreventa).
 *   2. El precio hace un maximo MAS ALTO, pero el RSI hace un maximo MAS BAJO —y ni se asoma al
 *      canal. Eso es la divergencia.
 *   3. Se baja a 5m y se busca un hueco (FVG) o un order block donde entrar.
 *   4. Entrada limitada en esa zona, stop por encima, objetivo en la liquidez anterior.
 *
 * POR QUE MERECE MEDIRSE, si el RSI 70/30 a secas ya se descarto aqui
 * -------------------------------------------------------------------
 * Porque no es lo mismo. Este proyecto midio la reversion cruda en 70/30 y encontro un borde de
 * +0,005-0,010R contra un peaje de 0,018-0,025R: existe y no paga. El video dice exactamente eso
 * —que entrar en 70/30 a secas pierde— y propone la divergencia como filtro. Es una hipotesis
 * distinta y hay que medirla aparte.
 *
 * EL CRUCE DE TEMPORALIDADES ES DONDE SE COLARIA EL FUTURO
 * -------------------------------------------------------
 * Una vela de 15m no se conoce hasta que CIERRA. La divergencia que se ve en la vela de 15m que
 * empieza a las 10:00 no existe hasta las 10:15, y buscar la entrada en las velas de 5m de las
 * 10:00 o 10:05 seria operar con informacion que aun no se tenia. Aqui la busqueda arranca
 * estrictamente despues del cierre de la vela que confirma.
 *
 * Todo puro y sin mirar el futuro.
 */
import type { Vela } from "./datos";
import { huecos, bloques, type AjustesSMC } from "./smc";

export interface Pico {
  /** Vela donde esta el extremo. */
  i: number;
  /** El precio del extremo. */
  valor: number;
  /** Antes de esta vela el pico no esta confirmado y no se puede usar. */
  confirmadoEn: number;
}

/**
 * Extremos locales CONFIRMADOS de una serie de velas.
 *
 * Un maximo de la vela i solo se sabe que lo es cuando han cerrado `confirmacion` velas a su
 * derecha sin superarlo. Ese es el precio de usar picos: siempre se enteran tarde. Fingir que se
 * conocen en el momento es la forma mas comun de meter futuro en una estrategia de estructura.
 *
 * Se exige extremo ESTRICTO: con empates, un tramo lateral produce un pico en cada vela.
 */
export function picos(velas: Vela[], confirmacion: number, alza: boolean): Pico[] {
  const out: Pico[] = [];
  for (let i = confirmacion; i < velas.length - confirmacion; i += 1) {
    const v = velas[i]!;
    const valor = alza ? v.h : v.l;
    let es = true;
    for (let k = i - confirmacion; k <= i + confirmacion && es; k += 1) {
      if (k === i) continue;
      const o = velas[k]!;
      if (alza ? o.h >= valor : o.l <= valor) es = false;
    }
    if (es) out.push({ i, valor, confirmadoEn: i + confirmacion });
  }
  return out;
}

export interface AjustesDivergencia {
  /** Periodo del RSI. */
  periodoRsi: number;
  /** Velas a cada lado que confirman un pico. */
  confirmacion: number;
  /** Umbral de sobrecompra. El de sobreventa es su espejo (100 - este). */
  umbralAlto: number;
  /** Separacion minima entre los dos picos, en velas. Pegados serian el mismo movimiento. */
  minSeparacion: number;
  /** Separacion maxima. Mas alla, emparejar dos picos es arbitrario. */
  maxSeparacion: number;
  /**
   * Si true, el segundo pico del RSI ademas NO puede haber entrado en el canal.
   *
   * Es lo que el video subraya: "ni siquiera se asoma". Sin esto basta con que el RSI sea menor,
   * que es mucho mas facil de cumplir.
   */
  exigirFueraDelCanal: boolean;
}

export interface Divergencia {
  /** Vela de 15m donde queda confirmada. NO se conoce hasta que esa vela CIERRA. */
  i: number;
  direccion: "BAJISTA" | "ALCISTA";
  /** Indices de los dos picos de precio. */
  pico1: number;
  pico2: number;
  /** El extremo de precio del segundo pico: sirve de referencia para el stop. */
  extremo: number;
  /** El extremo OPUESTO mas reciente antes de la divergencia: la liquidez a la que se apunta. */
  objetivoLiquidez: number | null;
  rsi1: number;
  rsi2: number;
}

/**
 * Las divergencias.
 *
 * Bajista: el precio hace un maximo mas alto y el RSI uno mas bajo, habiendo salido del canal en
 * el primero. Alcista es el espejo exacto.
 *
 * Cada pico solo se usa como SEGUNDO pico de una divergencia. Encadenar el mismo pico en varias
 * parejas infla la muestra con la misma decision repetida.
 */
export function divergencias(
  velas: Vela[],
  rsiValores: (number | null)[],
  aj: AjustesDivergencia,
): Divergencia[] {
  const out: Divergencia[] = [];
  const umbralBajo = 100 - aj.umbralAlto;

  for (const alza of [true, false]) {
    const ps = picos(velas, aj.confirmacion, alza);
    for (let b = 1; b < ps.length; b += 1) {
      const p2 = ps[b]!;
      const r2 = rsiValores[p2.i];
      if (r2 == null) continue;

      for (let a = b - 1; a >= 0; a -= 1) {
        const p1 = ps[a]!;
        const sep = p2.i - p1.i;
        if (sep < aj.minSeparacion) continue;
        if (sep > aj.maxSeparacion) break;
        const r1 = rsiValores[p1.i];
        if (r1 == null) continue;

        if (alza) {
          if (!(p2.valor > p1.valor)) continue;      // el precio tiene que hacer maximo mas alto
          if (!(r1 >= aj.umbralAlto)) continue;      // el primero salio del canal
          if (!(r2 < r1)) continue;                  // el RSI hace maximo mas bajo
          if (aj.exigirFueraDelCanal && r2 >= aj.umbralAlto) continue;
        } else {
          if (!(p2.valor < p1.valor)) continue;
          if (!(r1 <= umbralBajo)) continue;
          if (!(r2 > r1)) continue;
          if (aj.exigirFueraDelCanal && r2 <= umbralBajo) continue;
        }

        // La liquidez a la que se apunta: el extremo opuesto mas reciente ENTRE los dos picos.
        // Es lo que el video llama "la zona de liquidez anterior".
        let objetivoLiquidez: number | null = null;
        for (let k = p1.i; k <= p2.i; k += 1) {
          const v = velas[k]!;
          if (alza) {
            objetivoLiquidez = objetivoLiquidez == null ? v.l : Math.min(objetivoLiquidez, v.l);
          } else {
            objetivoLiquidez = objetivoLiquidez == null ? v.h : Math.max(objetivoLiquidez, v.h);
          }
        }

        out.push({
          i: p2.confirmadoEn,
          direccion: alza ? "BAJISTA" : "ALCISTA",
          pico1: p1.i, pico2: p2.i, extremo: p2.valor,
          objetivoLiquidez, rsi1: r1, rsi2: r2,
        });
        break;   // cada pico se usa una sola vez como segundo
      }
    }
  }
  return out.sort((x, y) => x.i - y.i);
}

export type Objetivo = "LIQUIDEZ" | "FIJO";
export type Stop = "ZONA" | "EXTREMO";

export interface AjustesEntrada {
  /** Ajustes de huecos y bloques en la temporalidad menor. */
  zona: AjustesSMC;
  /** Cuantas velas de la temporalidad menor se espera a que aparezca una zona. */
  esperaZona: number;
  /** Y cuantas mas a que el precio vuelva a ella. */
  esperaEntrada: number;
  /** Colchon del stop, en fraccion de la altura de la zona. */
  colchon: number;
  /** Donde va el stop: justo tras la zona, o tras el extremo de la divergencia. */
  stop: Stop;
  objetivo: Objetivo;
  /** R:R fijo, cuando `objetivo` es FIJO. */
  objetivoR: number;
  /** R:R minimo para aceptar la operacion. */
  rrMinimo: number;
  /**
   * Riesgo minimo, en ATR de la temporalidad MENOR.
   *
   * Sin esto, una zona de entrada que cae pegada al extremo de la divergencia da un riesgo
   * casi cero, y entonces cualquier recorrido sale un R:R enorme. Ya paso en la estrategia de
   * pares: PF 2,90 que al poner la guarda se quedo en 1,06. Un stop de medio pip no existe:
   * no te lo ejecutan y no es una operacion, es una division entre casi cero.
   */
  minRiesgoAtr: number;
}

export interface SeñalDivergencia {
  /** Indice en la temporalidad MENOR. */
  i: number;
  direccion: "LARGO" | "CORTO";
  entrada: number;
  stop: number;
  objetivo: number;
  rr: number;
  /**
   * Primera vela menor en la que la orden YA estaba puesta y podia llenarse.
   *
   * `i - desde` es lo que tardo el precio en volver a la zona. No cambia ninguna operacion:
   * esta para poder preguntarle al registro si un llenado tardio vale lo mismo que uno pronto,
   * que es una pregunta que no se puede contestar reconstruyendo por fuera —la zona y su
   * `conocidoEn` viven aqui dentro— y que sin este campo hay que responder con proxies.
   */
  desde?: number;
}

/**
 * Señales completas: divergencia en la temporalidad mayor, entrada en la menor.
 *
 * `menores` tiene que estar ordenado por tiempo. La busqueda de zona arranca estrictamente
 * despues del CIERRE de la vela mayor que confirma la divergencia, que es `tConfirmacion`.
 */
export function señales(
  mayores: Vela[],
  rsiMayor: (number | null)[],
  menores: Vela[],
  atrMenor: (number | null)[],
  ajDiv: AjustesDivergencia,
  ajEnt: AjustesEntrada,
): SeñalDivergencia[] {
  const pasoMayor = mayores.length > 1 ? mayores[1]!.t - mayores[0]!.t : 900;
  const hs = huecos(menores, ajEnt.zona.minHueco, atrMenor);
  const bs = bloques(menores, atrMenor, ajEnt.zona);
  const out: SeñalDivergencia[] = [];

  for (const d of divergencias(mayores, rsiMayor, ajDiv)) {
    const velaConfirma = mayores[d.i];
    if (!velaConfirma) continue;
    // La vela que confirma cierra al final de su periodo: antes de eso nadie sabia nada.
    const tConfirmacion = velaConfirma.t + pasoMayor;

    // Primera vela menor posterior al cierre de la mayor.
    let j0 = menores.findIndex((v) => v.t >= tConfirmacion);
    if (j0 < 0) continue;

    const largo = d.direccion === "ALCISTA";
    const lado = largo ? "ALCISTA" : "BAJISTA";

    // La zona: el primer hueco o bloque en la direccion correcta que aparezca despues.
    const zona = bs.find(
      (b) => b.lado === lado && b.conocidoEn >= j0 && b.conocidoEn - j0 <= ajEnt.esperaZona,
    ) ?? hs
      .filter((h) => h.lado === lado && h.conocidoEn >= j0 && h.conocidoEn - j0 <= ajEnt.esperaZona)
      .map((h) => ({ conocidoEn: h.conocidoEn, alto: h.alto, bajo: h.bajo }))[0];
    if (!zona) continue;

    const altura = zona.alto - zona.bajo;
    if (!(altura > 0)) continue;
    const entrada = largo ? zona.alto : zona.bajo;
    const stop = ajEnt.stop === "ZONA"
      ? (largo ? zona.bajo - altura * ajEnt.colchon : zona.alto + altura * ajEnt.colchon)
      // El extremo de la divergencia esta en la temporalidad MAYOR, y el colchon se mide sobre
      // la altura de la zona porque es la unica escala disponible en la menor.
      : (largo ? d.extremo - altura * ajEnt.colchon : d.extremo + altura * ajEnt.colchon);
    const riesgo = Math.abs(entrada - stop);
    if (!(riesgo > 0)) continue;
    const escala = atrMenor[Math.max(0, zona.conocidoEn)];
    if (escala != null && escala > 0 && riesgo < escala * ajEnt.minRiesgoAtr) continue;

    let objetivo: number;
    if (ajEnt.objetivo === "FIJO") {
      objetivo = largo ? entrada + riesgo * ajEnt.objetivoR : entrada - riesgo * ajEnt.objetivoR;
    } else {
      if (d.objetivoLiquidez == null) continue;
      objetivo = d.objetivoLiquidez;
    }
    const rr = Math.abs(objetivo - entrada) / riesgo;
    if (!(rr >= ajEnt.rrMinimo)) continue;
    // Un objetivo que ya quedo detras no es un objetivo.
    if (largo ? objetivo <= entrada : objetivo >= entrada) continue;

    // La vuelta a la zona, despues de que la zona se conozca.
    const desde = Math.max(zona.conocidoEn + 1, j0);
    for (let j = desde; j < Math.min(menores.length, desde + ajEnt.esperaEntrada); j += 1) {
      const v = menores[j]!;
      if (largo ? v.l > entrada : v.h < entrada) continue;
      out.push({
        i: j, direccion: largo ? "LARGO" : "CORTO", entrada, stop, objetivo, rr, desde,
      });
      break;
    }
  }
  return out;
}
