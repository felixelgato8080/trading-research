/**
 * Grabador hacia adelante de la ruptura de volatilidad. Sin dinero, sin ordenes.
 *
 * POR QUE ESTO Y NO OTRO BACKTEST
 * -------------------------------
 * Seis hallazgos de este proyecto tenian backtests limpios y se evaporaron con mas datos. La
 * unica prueba que no puedo contaminar es el tiempo hacia adelante, porque los datos aun no
 * existen cuando se apunta la señal.
 *
 * LO QUE HACE CREIBLE EL REGISTRO (y sin lo cual no vale nada)
 * -----------------------------------------------------------
 *   1. La señal se apunta como PENDIENTE el dia que aparece, cuando el precio de entrada
 *      todavia no existe: la entrada es la apertura del dia siguiente. Asi queda constancia de
 *      que se supo antes, no despues.
 *   2. Un precio ya apuntado NO se reescribe nunca. Si Yahoo revisa una vela vieja, se anota la
 *      discrepancia pero se respeta lo grabado. Reescribir la historia con datos corregidos es
 *      la forma mas facil de fabricar un buen resultado sin darse cuenta.
 *   3. Los ajustes se guardan en el registro. Cambiarlos a mitad invalida la comparacion, asi
 *      que el grabador se niega a seguir si no coinciden.
 *
 * NO se aplica tope de posiciones a proposito: se graban TODAS las señales para tener la mayor
 * muestra posible en pocos meses. El efecto del tope se simula despues con `simularCartera`,
 * que ya esta probado, sobre las operaciones cerradas.
 */
import type { Vela } from "./datos";
import { volatilidad } from "./rupturas";
import { volumenMedio } from "./volumen";
import type { Direccion } from "./rupturas";

export const VERSION_REGISTRO = 1;

export interface AjustesGrabador {
  /** Multiplos de ATR que debe moverse el precio desde la apertura para dar señal. */
  k: number;
  /** Stop inicial en multiplos de ATR. */
  atrStop: number;
  /** Trailing en multiplos del stop. 0 = stop fijo. */
  trailing: number;
  /** Periodo del ATR. */
  periodoAtr: number;
  /** Coste por operacion en fraccion del riesgo, repartido entre entrada y salida. */
  costeR: number;
}

export interface Pendiente {
  instrumento: string;
  direccion: Direccion;
  /** Dia de la vela que dio la señal (YYYY-MM-DD). */
  diaSenal: string;
  /** Momento real en que el grabador lo apunto. Es la prueba de que se supo antes. */
  apuntadoEn: string;
  /** Distancia del stop en precio, congelada con el ATR del dia de la señal. */
  riesgo: number;
  /**
   * Volumen de la vela de la señal dividido por la media de las 20 anteriores.
   *
   * NO filtra nada: solo se OBSERVA y se guarda. Asi, al analizar el registro se pueden evaluar
   * a la vez la version con filtro de volumen y la version sin el, desde la MISMA grabacion y
   * sin esperar otros tres meses. Añadir una observacion no cambia la estrategia ni sus ajustes,
   * asi que no invalida el registro en marcha.
   *
   * null cuando la fuente no da volumen (forex al contado) o no hay historia suficiente.
   */
  volumenRelativo: number | null;
}

export interface Posicion extends Pendiente {
  diaEntrada: string;
  /** Apertura del dia siguiente a la señal. Nunca se reescribe. */
  precioEntrada: number;
  nivelStop: number;
  /** Mejor precio alcanzado a favor, para mover el trailing. */
  extremo: number;
  /** Ultimo dia ya procesado para esta posicion, para no recontar velas. */
  ultimoDia: string;
  /**
   * Si al apuntar la señal el precio de entrada YA se podia conocer.
   *
   * En marcha diaria normal esto es false: la señal se ve al cierre y la apertura del dia
   * siguiente aun no existe. Solo sale true cuando el grabador se ha saltado dias y se pone al
   * dia de golpe. Esas operaciones tienen una auditoria mas debil y hay que poder excluirlas al
   * analizar, porque si no la prueba hacia adelante se contamina con backtest sin avisar.
   */
  entradaConocidaAlApuntar: boolean;
}

export interface Cerrada extends Posicion {
  diaSalida: string;
  precioSalida: number;
  /** Resultado en multiplos del riesgo, ya con costes. */
  r: number;
  /** Sin costes, para poder medir cuanto se lleva el peaje. */
  rBruto: number;
  motivo: "STOP" | "TRAILING";
}

export interface Discrepancia {
  instrumento: string;
  dia: string;
  campo: string;
  grabado: number;
  ahora: number;
}

export interface Registro {
  version: number;
  ajustes: AjustesGrabador;
  /**
   * De donde salen las velas. Se guarda y se comprueba como los ajustes, porque cambiar de
   * fuente a mitad invalida la comparacion igual que cambiar un parametro.
   *
   * Medido el 7 sep: el rango diario de Yahoo es mas estrecho que el de Binance en el 99% de
   * los dias, asi que los stops saltan de menos y el resultado sale optimista. La misma
   * estrategia da 12,8% anual con Yahoo y 6,9% con Binance en el mismo periodo.
   */
  fuente: "yahoo" | "binance";
  /** Primera vez que se ejecuto. Marca el inicio del periodo de prueba. */
  inicio: string;
  ultimaEjecucion: string;
  ejecuciones: number;
  pendientes: Pendiente[];
  abiertas: Posicion[];
  cerradas: Cerrada[];
  discrepancias: Discrepancia[];
}

export function registroVacio(
  ajustes: AjustesGrabador,
  ahora: string,
  fuente: "yahoo" | "binance" = "binance",
): Registro {
  return {
    version: VERSION_REGISTRO,
    ajustes,
    fuente,
    inicio: ahora,
    ultimaEjecucion: ahora,
    ejecuciones: 0,
    pendientes: [],
    abiertas: [],
    cerradas: [],
    discrepancias: [],
  };
}

export const dia = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

/** ATR de Wilder. Copia local para que el grabador no dependa del modulo de multi-temporalidad. */
export function atrWilder(velas: Vela[], periodo: number): (number | null)[] {
  const out: (number | null)[] = new Array(velas.length).fill(null);
  let suma = 0;
  let previo: number | null = null;
  for (let i = 1; i < velas.length; i += 1) {
    const v = velas[i]!;
    const c = velas[i - 1]!.c;
    const tr = Math.max(v.h - v.l, Math.abs(v.h - c), Math.abs(v.l - c));
    if (i <= periodo) {
      suma += tr;
      if (i === periodo) {
        previo = suma / periodo;
        out[i] = previo;
      }
    } else if (previo != null) {
      previo = (previo * (periodo - 1) + tr) / periodo;
      out[i] = previo;
    }
  }
  return out;
}

export interface Avance {
  registro: Registro;
  nuevasPendientes: Pendiente[];
  nuevasAbiertas: Posicion[];
  nuevasCerradas: Cerrada[];
}

/**
 * Avanza el registro con las velas de hoy. Es idempotente: correrlo dos veces el mismo dia no
 * duplica nada ni mueve ningun stop dos veces.
 *
 * `velasPorInstrumento` puede traer menos instrumentos de los que hay abiertos (una descarga
 * fallida). En ese caso esa posicion simplemente no avanza: cerrarla por falta de datos seria
 * inventarse una salida.
 */
export function avanzar(
  registro: Registro,
  velasPorInstrumento: Map<string, Vela[]>,
  ahora: string,
): Avance {
  const aj = registro.ajustes;
  const nuevasPendientes: Pendiente[] = [];
  const nuevasAbiertas: Posicion[] = [];
  const nuevasCerradas: Cerrada[] = [];
  const discrepancias: Discrepancia[] = [...registro.discrepancias];

  const abiertas = registro.abiertas.map((p) => ({ ...p }));
  const cerradas = [...registro.cerradas];
  let pendientes = registro.pendientes.map((p) => ({ ...p }));

  /**
   * Convierte las pendientes que ya tienen apertura conocida. Devuelve las que siguen esperando.
   *
   * `conocidaAlApuntar` distingue los dos casos: false cuando la pendiente venia de una
   * ejecucion anterior (marcha normal), true cuando se apunto en esta misma ejecucion porque el
   * grabador se ha puesto al dia.
   */
  const convertir = (lista: Pendiente[], conocidaAlApuntar: boolean): Pendiente[] => {
    const esperan: Pendiente[] = [];
    for (const pend of lista) {
      const velas = velasPorInstrumento.get(pend.instrumento);
      if (!velas) {
        esperan.push(pend);
        continue;
      }
      const iSenal = velas.findIndex((v) => dia(v.t) === pend.diaSenal);
      const entrada = iSenal >= 0 ? velas[iSenal + 1] : undefined;
      if (!entrada) {
        esperan.push(pend);
        continue;
      }
      // Una sola posicion por instrumento: no se puede estar dos veces en la misma moneda.
      if (abiertas.some((a) => a.instrumento === pend.instrumento)) continue;

      const largo = pend.direccion === "LARGO";
      const pos: Posicion = {
        ...pend,
        diaEntrada: dia(entrada.t),
        precioEntrada: entrada.o,
        nivelStop: largo ? entrada.o - pend.riesgo : entrada.o + pend.riesgo,
        extremo: entrada.o,
        // Se marca el dia de la SEÑAL, no el de entrada, para que la propia vela de entrada se
        // procese en el paso de avance: si el precio abre y ese mismo dia toca el stop, hay que
        // verlo. El backtest lo comprueba y el grabador tiene que hacer lo mismo.
        ultimoDia: pend.diaSenal,
        entradaConocidaAlApuntar: conocidaAlApuntar,
      };
      abiertas.push(pos);
      nuevasAbiertas.push(pos);
    }
    return esperan;
  };

  // ---- 2. Convertir las pendientes que venian de ejecuciones anteriores ------------------
  pendientes = convertir(pendientes, false);

  // ---- 3. Detectar señales nuevas -------------------------------------------------------
  const reciennacidas: Pendiente[] = [];
  for (const [instrumento, velas] of velasPorInstrumento) {
    if (velas.length < aj.periodoAtr + 2) continue;
    // Ya dentro de esta moneda: la señal no apila, se descarta.
    if (abiertas.some((p) => p.instrumento === instrumento)) continue;
    if (pendientes.some((p) => p.instrumento === instrumento)) continue;

    const a = atrWilder(velas, aj.periodoAtr);
    const vMedio = volumenMedio(velas, 20);
    for (const s of volatilidad(velas, a, aj.k)) {
      const v = velas[s.i]!;
      const d = dia(v.t);
      // Solo señales posteriores al arranque: lo anterior es backtest, no grabacion.
      if (d < registro.inicio.slice(0, 10)) continue;
      if (cerradas.some((p) => p.instrumento === instrumento && p.diaSenal === d)) continue;
      if (reciennacidas.some((p) => p.instrumento === instrumento)) continue;

      const av = a[s.i];
      if (av == null || !(av > 0)) continue;

      const vol = velas[s.i]!.v;
      const m = vMedio[s.i];
      const pend: Pendiente = {
        instrumento,
        direccion: s.direccion,
        diaSenal: d,
        apuntadoEn: ahora,
        riesgo: av * aj.atrStop,
        volumenRelativo: vol != null && vol > 0 && m != null && m > 0 ? vol / m : null,
      };
      reciennacidas.push(pend);
      nuevasPendientes.push(pend);
    }
  }

  // ---- 3b. Las recien nacidas cuya apertura YA existe se abren en esta misma pasada ------
  pendientes = [...pendientes, ...convertir(reciennacidas, true)];

  // ---- 4. Avanzar TODAS las posiciones, incluidas las abiertas en esta misma pasada ------
  for (let i = abiertas.length - 1; i >= 0; i -= 1) {
    const p = abiertas[i]!;
    const velas = velasPorInstrumento.get(p.instrumento);
    if (!velas || velas.length === 0) continue;

    const largo = p.direccion === "LARGO";
    let cerrada: Cerrada | null = null;

    for (const v of velas) {
      const d = dia(v.t);
      if (d <= p.ultimoDia) continue;

      // El stop primero: si en la vela se tocan stop y extremo, no sabemos el orden intravela.
      if (largo ? v.l <= p.nivelStop : v.h >= p.nivelStop) {
        const bruto = (largo ? p.nivelStop - p.precioEntrada : p.precioEntrada - p.nivelStop) / p.riesgo;
        cerrada = {
          ...p,
          ultimoDia: d,
          diaSalida: d,
          precioSalida: p.nivelStop,
          rBruto: bruto,
          r: bruto - aj.costeR,
          motivo: p.nivelStop === (largo ? p.precioEntrada - p.riesgo : p.precioEntrada + p.riesgo)
            ? "STOP"
            : "TRAILING",
        };
        break;
      }

      if (largo) {
        if (v.h > p.extremo) p.extremo = v.h;
        if (aj.trailing > 0) {
          p.nivelStop = Math.max(p.nivelStop, p.extremo - p.riesgo * aj.trailing);
        }
      } else {
        if (v.l < p.extremo) p.extremo = v.l;
        if (aj.trailing > 0) {
          p.nivelStop = Math.min(p.nivelStop, p.extremo + p.riesgo * aj.trailing);
        }
      }
      p.ultimoDia = d;
    }

    if (cerrada) {
      cerradas.push(cerrada);
      nuevasCerradas.push(cerrada);
      abiertas.splice(i, 1);
    }
  }


  // ---- 5. Comprobar que la historia grabada no ha cambiado bajo los pies -----------------
  for (const c of [...abiertas, ...cerradas]) {
    const velas = velasPorInstrumento.get(c.instrumento);
    if (!velas) continue;
    const v = velas.find((x) => dia(x.t) === c.diaEntrada);
    if (v && Math.abs(v.o - c.precioEntrada) > Math.abs(c.precioEntrada) * 1e-6) {
      const ya = discrepancias.some(
        (d) => d.instrumento === c.instrumento && d.dia === c.diaEntrada && d.campo === "apertura",
      );
      if (!ya) {
        discrepancias.push({
          instrumento: c.instrumento,
          dia: c.diaEntrada,
          campo: "apertura",
          grabado: c.precioEntrada,
          ahora: v.o,
        });
      }
    }
  }

  return {
    registro: {
      ...registro,
      ultimaEjecucion: ahora,
      ejecuciones: registro.ejecuciones + 1,
      pendientes,
      abiertas,
      cerradas,
      discrepancias,
    },
    nuevasPendientes,
    nuevasAbiertas,
    nuevasCerradas,
  };
}

export interface Resumen {
  n: number;
  wr: number;
  pf: number;
  exp: number;
  peaje: number;
}

/** Resumen de las cerradas. `peaje` dice que fraccion de la ganancia bruta se lleva el coste. */
export function resumir(cerradas: Cerrada[]): Resumen {
  if (cerradas.length === 0) return { n: 0, wr: 0, pf: 0, exp: 0, peaje: 0 };
  const rs = cerradas.map((c) => c.r);
  const g = rs.filter((x) => x > 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  const bruto = cerradas.reduce((s, c) => s + c.rBruto, 0);
  const neto = rs.reduce((s, x) => s + x, 0);
  return {
    n: rs.length,
    wr: g.length / rs.length,
    pf: sp > 0 ? sg / sp : 0,
    exp: neto / rs.length,
    peaje: bruto !== 0 ? (bruto - neto) / Math.abs(bruto) : 0,
  };
}
