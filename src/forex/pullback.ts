/**
 * RETROCESO DEL RSI EN TENDENCIA — V1 y V2.
 *
 * Es la estrategia OPUESTA a la de divergencias que corre en este repositorio: aquella compra
 * cuando el precio se da la vuelta, esta cuando el precio descansa y sigue. Y por eso merece
 * medirse aparte en vez de mezclarse: medido el 14 sep sobre 244 dias, la de divergencias pierde
 * justo en el solape Londres-NY (13-17h UTC, -0,096R), que es la franja mas tendencial del dia.
 * Si la hipotesis es cierta, esta deberia vivir precisamente ahi.
 *
 * LA MAQUINA DE ESTADOS, que es lo que la distingue de un cruce cualquiera
 * -----------------------------------------------------------------------
 * No basta con que el RSI este bajo. Hacen falta TRES cosas EN ORDEN:
 *
 *   1. ARMADO   el RSI de 5m entra en la zona de retroceso (35-45 en largos)
 *   2. GATILLO  el RSI la cruza de vuelta hacia arriba
 *   3. PRECIO   la vela confirma: alcista y cerrando por encima del maximo anterior
 *
 * Guardar el estado importa: si se comprobara "RSI > 45" sin exigir que ANTES hubiera bajado a
 * la zona, entraria en cualquier vela de una tendencia sana, que es justo lo que no se quiere.
 *
 * V1 contra V2
 * ------------
 * V1 filtra solo con la tendencia de 15m. V2 añade el marco de 1h, el ADX con sus direccionales,
 * el tamaño de la vela de confirmacion y la volatilidad relativa. La comparacion entre las dos
 * es el experimento: si V2 no mejora la esperanza, sus filtros no valen lo que cuestan en
 * operaciones perdidas.
 *
 * TODO PURO Y SIN MIRAR EL FUTURO. El cruce de temporalidades es donde se colaria: la vela de
 * 15m que confirma la tendencia no se conoce hasta que CIERRA. Por eso se alinea con `alinear`,
 * que compara contra el cierre de la vela grande y no contra su apertura.
 */
import type { Vela } from "./datos";
import { ema, atr, alinear } from "./multiTf";
import { rsi } from "./rsi";
import { adx as calcularAdx } from "./adx";

export interface AjustesPullback {
  /**
   * ETIQUETA, no interruptor. Solo sirve para nombrar la configuracion en el registro.
   *
   * Antes esta cadena encendia CUATRO filtros a la vez (1h, ADX, cuerpo, volatilidad) y por eso
   * no se podia medir cual costaba que: cualquier ablacion movia los cuatro. Ahora cada uno se
   * apaga por su propio parametro y `version` no decide nada.
   */
  version: string;
  /** Exigir que la tendencia de 1h acompañe. Es el unico filtro que necesita un si/no. */
  usarMacro: boolean;
  emaRapida: number;
  emaLenta: number;
  periodoRsi: number;
  /** Rango del RSI de 15m que se considera "tendencia sana, no agotada". */
  rsiMayorMin: number;
  rsiMayorMax: number;
  /** Zona de retroceso del RSI de 5m que ARMA el setup. */
  zonaBaja: number;
  zonaAlta: number;
  /** Nivel que el RSI tiene que cruzar de vuelta para disparar. */
  gatillo: number;
  /**
   * Cuantas velas de 5m sigue vivo un setup armado antes de olvidarse.
   *
   * OJO AL TOCAR ESTO EN V1: ahi `zonaAlta` y `gatillo` valen los dos 45, asi que la vela
   * anterior al cruce SIEMPRE esta dentro de la zona y el armado siempre ocurre justo
   * antes del disparo. Medido sobre 5.000 velas: la separacion es 1 en las 22 señales, y
   * subir la vigencia de 1 a 48 no cambia ni una. En V2 si cuenta, porque entre la zona
   * (hasta 46) y el gatillo (48) hay hueco: ahi la separacion va de 1 a 3.
   *
   * Se deja como parametro porque separar zona y gatillo es justo una de las cosas que se
   * van a probar; pero quien mueva la vigencia en V1 sin mover la zona va a medir cero
   * efecto, y conviene que sepa por que.
   */
  vigencia: number;
  /** Cuantas velas atras se mira la pendiente de la EMA rapida. */
  velasPendiente: number;
  /** Stop: ultimo extremo de las ultimas N velas, mas un colchon en ATR. */
  velasSwing: number;
  colchonAtr: number;
  /** Se rechaza la operacion si el stop sale mas ancho que esto en ATR. */
  maxStopAtr: number;
  objetivoR: number;
  // --- Solo V2 ---
  adxMinimo: number;
  /**
   * El ADX tiene que ser mayor que el de N velas atras: tendencia ganando fuerza.
   *
   * CERO SIGNIFICA NO COMPROBARLO. Hay que decirlo porque la lectura ingenua —comparar contra
   * `adx[m - 0]`, o sea contra si mismo— da `a > a`, que es FALSO siempre: el parametro que
   * parece apagar el filtro lo convertiria en un muro. Paso al medir V1 contra V2 el 14 sep y
   * dejaba en cero cuatro ablaciones distintas, con pinta de resultado en vez de pinta de fallo.
   */
  adxSubiendoDesde: number;
  /** Cuerpo minimo de la vela de confirmacion, en ATR. */
  cuerpoMinimoAtr: number;
  /** ATR actual dividido por el ATR medio de las ultimas 100: descarta mercado muerto. */
  atrRelativoMin: number;
  atrRelativoMax: number;
}

export const V1: AjustesPullback = {
  version: "V1",
  usarMacro: false,
  emaRapida: 50, emaLenta: 200, periodoRsi: 14,
  rsiMayorMin: 50, rsiMayorMax: 72,
  zonaBaja: 35, zonaAlta: 45, gatillo: 45,
  vigencia: 12, velasPendiente: 3,
  velasSwing: 20, colchonAtr: 0.15, maxStopAtr: 1.8, objetivoR: 2,
  adxMinimo: 0, adxSubiendoDesde: 0, cuerpoMinimoAtr: 0, atrRelativoMin: 0, atrRelativoMax: 99,
};

export const V2: AjustesPullback = {
  ...V1,
  version: "V2",
  usarMacro: true,
  // En tendencia fuerte el RSI no baja a 35: la zona sube y el gatillo con ella.
  zonaBaja: 38, zonaAlta: 46, gatillo: 48,
  adxMinimo: 20, adxSubiendoDesde: 2,
  cuerpoMinimoAtr: 0.30, atrRelativoMin: 0.75, atrRelativoMax: 2.0,
};

export interface SeñalPullback {
  /** Indice en la temporalidad de ENTRADA (5m). Es la vela de decision. */
  i: number;
  /** Epoch de esa vela, para poder casar con el registro sin depender del indice. */
  t: number;
  direccion: "LARGO" | "CORTO";
  entrada: number;
  stop: number;
  objetivo: number;
  rr: number;
  /** Para poder clasificar despues sin recalcular. */
  adx: number | null;
  atrRelativo: number | null;
}

/** La media de una serie con nulos, ignorandolos. Null si no hay bastantes. */
function mediaUltimas(xs: (number | null)[], hasta: number, cuantas: number): number | null {
  let suma = 0;
  let n = 0;
  for (let k = Math.max(0, hasta - cuantas + 1); k <= hasta; k += 1) {
    const v = xs[k];
    if (v != null) { suma += v; n += 1; }
  }
  return n >= Math.min(20, cuantas) ? suma / n : null;
}

/**
 * Las señales, con la maquina de estados.
 *
 * `mayores` son las velas de 15m y `menores` las de 5m. `macro` son las de 1h y solo V2 las usa;
 * puede venir vacio en V1.
 */
export function señalesPullback(
  mayores: Vela[],
  menores: Vela[],
  macro: Vela[],
  aj: AjustesPullback,
): SeñalPullback[] {
  const out: SeñalPullback[] = [];
  const minimoMayor = Math.max(aj.emaLenta, 28) + aj.velasPendiente;
  if (menores.length < 120 || mayores.length < minimoMayor) return out;

  const cierresMay = mayores.map((v) => v.c);
  const emaRapMay = ema(cierresMay, aj.emaRapida);
  const emaLenMay = ema(cierresMay, aj.emaLenta);
  const rsiMay = rsi(cierresMay, aj.periodoRsi);
  const adxMay = calcularAdx(mayores, 14);
  const indiceMay = alinear(menores, mayores);

  const rsiMen = rsi(menores.map((v) => v.c), aj.periodoRsi);
  const atrMen = atr(menores, 14);

  const usaMacro = aj.usarMacro;
  const cierresMacro = macro.map((v) => v.c);
  const emaRapMacro = usaMacro ? ema(cierresMacro, aj.emaRapida) : [];
  const emaLenMacro = usaMacro ? ema(cierresMacro, aj.emaLenta) : [];
  const indiceMacro = usaMacro ? alinear(menores, macro) : [];

  // El estado: en que direccion hay un setup armado y desde cuando.
  let armadoLargo = -1;
  let armadoCorto = -1;

  for (let i = 1; i < menores.length; i += 1) {
    const v = menores[i]!;
    const vPrev = menores[i - 1]!;

    // Un setup armado caduca: si el precio no confirma en `vigencia` velas, aquella lectura del
    // RSI ya no describe este mercado. Se comprueba ANTES que nada para que caduque igual aunque
    // la vela se descarte luego por falta de datos.
    if (armadoLargo >= 0 && i - armadoLargo > aj.vigencia) armadoLargo = -1;
    if (armadoCorto >= 0 && i - armadoCorto > aj.vigencia) armadoCorto = -1;

    const m = indiceMay[i];
    if (m == null || m < aj.velasPendiente) continue;

    const eRap = emaRapMay[m];
    const eLen = emaLenMay[m];
    const eRapAnt = emaRapMay[m - aj.velasPendiente];
    const rMay = rsiMay[m];
    if (eRap == null || eLen == null || eRapAnt == null || rMay == null) continue;
    const cierreMay = mayores[m]!.c;

    const tendenciaLarga = cierreMay > eRap && eRap > eLen && eRap > eRapAnt
      && rMay > aj.rsiMayorMin && rMay < aj.rsiMayorMax;
    const tendenciaCorta = cierreMay < eRap && eRap < eLen && eRap < eRapAnt
      && rMay < (100 - aj.rsiMayorMin) && rMay > (100 - aj.rsiMayorMax);

    // --- Filtros de V2 -----------------------------------------------------------------------
    let macroLargo = true;
    let macroCorto = true;
    if (usaMacro) {
      const k = indiceMacro[i];
      const hR = k != null ? emaRapMacro[k] : null;
      const hL = k != null ? emaLenMacro[k] : null;
      const hRAnt = k != null && k >= aj.velasPendiente ? emaRapMacro[k - aj.velasPendiente] : null;
      if (k == null || hR == null || hL == null || hRAnt == null) {
        macroLargo = false;
        macroCorto = false;
      } else {
        const cMacro = macro[k]!.c;
        macroLargo = cMacro > hR && hR > hL && hR > hRAnt;
        macroCorto = cMacro < hR && hR < hL && hR < hRAnt;
      }
    }

    const a = adxMay.adx[m];
    const diMas = adxMay.mas[m];
    const diMenos = adxMay.menos[m];
    // Con `adxSubiendoDesde` en cero no se pide que suba, y por eso no se busca el valor
    // anterior: pedirlo seria compararlo consigo mismo y no pasar nunca.
    const pideSubir = aj.adxSubiendoDesde > 0;
    const aAntes = pideSubir && m >= aj.adxSubiendoDesde
      ? adxMay.adx[m - aj.adxSubiendoDesde]
      : null;
    let adxLargo = true;
    let adxCorto = true;
    // Con el umbral a cero y sin pedir que suba, no hay filtro de ADX y no se mira nada: asi el
    // filtro se apaga por su propio parametro y no por la version.
    if (aj.adxMinimo > 0 || pideSubir) {
      if (a == null || diMas == null || diMenos == null || (pideSubir && aAntes == null)) {
        adxLargo = false;
        adxCorto = false;
      } else {
        const fuerte = a > aj.adxMinimo && (!pideSubir || a > aAntes!);
        adxLargo = fuerte && diMas > diMenos;
        adxCorto = fuerte && diMenos > diMas;
      }
    }

    const at = atrMen[i];
    if (at == null || at <= 0) continue;
    // La banda 0-99 no descarta nada, y entonces esto es solo una MEDIDA que se guarda con la
    // señal. Con una banda de verdad, ademas filtra.
    const filtraAtr = aj.atrRelativoMin > 0 || aj.atrRelativoMax < 99;
    const medio = mediaUltimas(atrMen, i, 100);
    const atrRel = medio != null && medio > 0 ? at / medio : null;
    if (filtraAtr) {
      if (atrRel == null) continue;
      if (atrRel < aj.atrRelativoMin || atrRel > aj.atrRelativoMax) {
        // Mercado muerto o roto: ni se arma ni se dispara, y se olvida lo armado.
        armadoLargo = -1;
        armadoCorto = -1;
        continue;
      }
    }

    const rAct = rsiMen[i];
    const rAnt = rsiMen[i - 1];
    if (rAct == null || rAnt == null) continue;

    // --- 2 y 3. GATILLO Y CONFIRMACION DE PRECIO ---------------------------------------------
    //
    // El disparo se comprueba ANTES de armar en esta misma vela: si no, una vela cuyo RSI cae
    // dentro de la zona y a la vez cruza el gatillo se armaria y dispararia de golpe, que es
    // saltarse el orden que define la estrategia.
    const cuerpo = Math.abs(v.c - v.o);
    const cuerpoVale = cuerpo >= at * aj.cuerpoMinimoAtr;

    if (armadoLargo >= 0 && tendenciaLarga && macroLargo && adxLargo) {
      const cruzaArriba = rAnt <= aj.gatillo && rAct > aj.gatillo;
      const precioConfirma = v.c > v.o && v.c > vPrev.h;
      if (cruzaArriba && precioConfirma && cuerpoVale) {
        // El stop va detras del ultimo minimo real, no a una distancia fija: es lo que hace que
        // el riesgo lo defina la estructura y no un numero elegido a dedo.
        let minimo = v.l;
        for (let k = Math.max(0, i - aj.velasSwing); k <= i; k += 1) {
          minimo = Math.min(minimo, menores[k]!.l);
        }
        const stop = minimo - at * aj.colchonAtr;
        const riesgo = v.c - stop;
        if (riesgo > 0 && riesgo <= at * aj.maxStopAtr) {
          out.push({
            i, t: v.t, direccion: "LARGO", entrada: v.c, stop,
            objetivo: v.c + riesgo * aj.objetivoR, rr: aj.objetivoR,
            adx: a ?? null, atrRelativo: atrRel,
          });
        }
        // Disparado es disparado: se desarma aunque el riesgo saliera demasiado ancho. Ese
        // retroceso ya se uso.
        armadoLargo = -1;
      }
    }

    if (armadoCorto >= 0 && tendenciaCorta && macroCorto && adxCorto) {
      const cruzaAbajo = rAnt >= (100 - aj.gatillo) && rAct < (100 - aj.gatillo);
      const precioConfirma = v.c < v.o && v.c < vPrev.l;
      if (cruzaAbajo && precioConfirma && cuerpoVale) {
        let maximo = v.h;
        for (let k = Math.max(0, i - aj.velasSwing); k <= i; k += 1) {
          maximo = Math.max(maximo, menores[k]!.h);
        }
        const stop = maximo + at * aj.colchonAtr;
        const riesgo = stop - v.c;
        if (riesgo > 0 && riesgo <= at * aj.maxStopAtr) {
          out.push({
            i, t: v.t, direccion: "CORTO", entrada: v.c, stop,
            objetivo: v.c - riesgo * aj.objetivoR, rr: aj.objetivoR,
            adx: a ?? null, atrRelativo: atrRel,
          });
        }
        armadoCorto = -1;
      }
    }

    // --- 1. ARMAR ----------------------------------------------------------------------------
    if (tendenciaLarga && macroLargo && adxLargo && rAct >= aj.zonaBaja && rAct <= aj.zonaAlta) {
      armadoLargo = i;
    }
    if (tendenciaCorta && macroCorto && adxCorto
        && rAct >= (100 - aj.zonaAlta) && rAct <= (100 - aj.zonaBaja)) {
      armadoCorto = i;
    }
  }
  return out;
}
