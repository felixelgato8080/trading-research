/**
 * De R a dinero: simulacion de cartera con posiciones simultaneas.
 *
 * POR QUE HACE FALTA
 * ------------------
 * Toda la investigacion hasta aqui mide en R, que es lo correcto para comparar estrategias.
 * Pero R esconde dos cosas que deciden si una estrategia es utilizable:
 *
 *   1. LA AGRUPACION. Un 68% de acierto no significa nada si las 32 señales saltan el mismo dia,
 *      porque entonces no son 32 apuestas independientes sino una sola repetida 32 veces. La
 *      caida maxima real no se parece a la que sale de barajar operaciones sueltas.
 *   2. EL TOPE DE POSICIONES. Con capital finito no se pueden abrir todas. Cuales se quedan
 *      fuera cambia el resultado, y las que se quedan fuera son justo las de los dias de panico,
 *      que es donde esta la ganancia.
 *
 * Todo puro: entra una lista de operaciones con fechas, sale una curva de capital.
 */

export interface Operacion {
  instrumento: string;
  /** Epoch en segundos. */
  tEntrada: number;
  tSalida: number;
  /** Resultado en multiplos del riesgo. */
  r: number;
  /** Opcional: sin ella no se puede limitar la exposicion por lado. */
  direccion?: "LARGO" | "CORTO";
  /**
   * Distancia del stop como FRACCION del precio de entrada. 0,10 = el stop esta un 10% abajo.
   *
   * Sin esto no se puede saber cuanto dinero mueve la posicion. Y sin saberlo, el simulador
   * acepta alegremente posiciones imposibles: con un stop del 0,5% (tipico de 1 hora en un ETF),
   * arriesgar el 1% del capital exige una posicion del 200% del capital. Ocho de esas son 16x de
   * apalancamiento, que ninguna cuenta al contado permite y que ningun broker deja sin garantias.
   */
  stopFraccion?: number;
}

export interface Ajustes {
  capital: number;
  /** Fraccion del capital arriesgada por operacion. 0.01 = 1%. */
  riesgoPct: number;
  /** Tope de posiciones abiertas a la vez. 0 = sin tope. */
  maxPosiciones: number;
  /**
   * Tope de posiciones abiertas EN LA MISMA DIRECCION. 0 = sin tope.
   *
   * Limitar el total no basta cuando los instrumentos estan correlacionados: 8 largos en 8
   * criptos distintas no son 8 apuestas, son una repetida 8 veces, y caen juntas. Este tope es
   * lo unico que convierte "8 posiciones" en algo parecido a diversificacion.
   *
   * Solo actua sobre operaciones que traen `direccion`.
   */
  maxPorDireccion?: number;
  /** Si arriesga un % del capital actual (compuesto) o del inicial (fijo). */
  compuesto: boolean;
  /**
   * OBJETIVO DE VOLATILIDAD. Si se da, el riesgo por operacion deja de ser fijo y se escala:
   *
   *     riesgo = riesgoPct x (objetivoVol / volatilidad reciente)
   *
   * Cuando el mercado se agita, la volatilidad reciente sube y el tamaño baja solo. Es el
   * estandar en managed futures y ataca el problema medido en este proyecto: la caida del 92%
   * en 1h venia de apostar igual de fuerte en los tramos violentos que en los tranquilos.
   *
   * La volatilidad se mide sobre los resultados en R de las ultimas `ventanaVol` operaciones
   * CERRADAS. Solo mira hacia atras: usar la volatilidad del futuro seria hacer trampa.
   */
  objetivoVol?: number;
  /** Operaciones cerradas usadas para medir la volatilidad reciente. Por defecto 30. */
  ventanaVol?: number;
  /**
   * Tope a la EXPOSICION total, en multiplos del capital. 1 = nunca mover mas dinero del que
   * hay. 0 o ausente = sin tope (util para comparar, peligroso para creerselo).
   *
   * Es la restriccion que separa una simulacion de algo ejecutable. Solo actua sobre operaciones
   * que traen `stopFraccion`.
   */
  maxExposicion?: number;
  /**
   * Tope al multiplicador de escala. Sin el, un tramo anormalmente tranquilo dispara el tamaño
   * justo antes de que vuelva la volatilidad, que es como se arruina la gente con esta tecnica.
   */
  maxEscala?: number;
}

export interface ResultadoCartera {
  capitalFinal: number;
  /** Caida maxima desde el pico, en fraccion del pico. */
  maxCaida: number;
  aceptadas: number;
  /** Señales que no cupieron por el tope. */
  rechazadas: number;
  maxSimultaneas: number;
  /**
   * Exposicion maxima alcanzada, en multiplos del capital. 1 = se llego a mover justo el dinero
   * disponible. Por encima de 1 hace falta apalancamiento, y por encima de 3-4 no existe cuenta
   * minorista que lo permita.
   */
  maxExposicion: number;
  /** Señales rechazadas por no caber en la exposicion permitida. */
  rechazadasPorExposicion: number;
  /** Media de posiciones abiertas ponderada por operacion aceptada. */
  mediaSimultaneas: number;
  curva: Array<{ t: number; capital: number }>;
  /** Peor variacion de capital en un solo dia, en fraccion. */
  peorDia: number;
}

interface Abierta {
  tSalida: number;
  r: number;
  riesgo: number;
  direccion?: "LARGO" | "CORTO";
  /** Dinero que mueve la posicion. */
  nocional: number;
}

/**
 * Recorre las operaciones en orden de calendario abriendo y cerrando posiciones.
 *
 * El riesgo en dinero se congela EN LA ENTRADA: es lo que pasa de verdad, porque el tamaño se
 * decide al abrir. Usar el capital del cierre haria que las ganadoras parecieran mas grandes de
 * lo que fueron.
 */
export function simularCartera(ops: Operacion[], a: Ajustes): ResultadoCartera {
  const pend = [...ops].sort((x, y) => x.tEntrada - y.tEntrada);
  const abiertas: Abierta[] = [];
  const curva: Array<{ t: number; capital: number }> = [];

  let capital = a.capital;
  let pico = a.capital;
  let maxCaida = 0;
  let peorDia = 0;
  let aceptadas = 0;
  let rechazadas = 0;
  let maxSim = 0;
  let sumaSim = 0;
  let maxExpo = 0;
  let rechazadasPorExpo = 0;
  let i = 0;

  // Historial de resultados cerrados, para medir la volatilidad reciente.
  const cerradosR: number[] = [];
  const ventana = a.ventanaVol ?? 30;
  const maxEscala = a.maxEscala ?? 3;

  /** Desviacion tipica de las ultimas operaciones cerradas. */
  const volReciente = (): number | null => {
    if (cerradosR.length < Math.max(10, ventana / 3)) return null;
    const ult = cerradosR.slice(-ventana);
    const media = ult.reduce((x, y) => x + y, 0) / ult.length;
    const varianza = ult.reduce((x, y) => x + (y - media) ** 2, 0) / ult.length;
    return Math.sqrt(varianza);
  };

  /** Multiplicador de tamaño. 1 mientras no haya historial suficiente. */
  const escala = (): number => {
    if (!a.objetivoVol || !(a.objetivoVol > 0)) return 1;
    const v = volReciente();
    if (v == null || !(v > 0)) return 1;
    return Math.min(maxEscala, a.objetivoVol / v);
  };

  const cerrar = (t: number): void => {
    const antes = capital;
    for (let k = abiertas.length - 1; k >= 0; k -= 1) {
      const p = abiertas[k]!;
      if (p.tSalida > t) continue;
      capital += p.r * p.riesgo;
      cerradosR.push(p.r);
      abiertas.splice(k, 1);
    }
    // La ruina es absorbente: sin dinero no se sigue operando. Sin este suelo, el capital pasa
    // a negativo y el interes compuesto sobre un negativo devuelve cifras sin sentido, que es
    // justo lo que hace que una cartera reventada parezca que "se recupera".
    if (capital < 0) capital = 0;
    if (capital !== antes) {
      curva.push({ t, capital });
      pico = Math.max(pico, capital);
      maxCaida = Math.max(maxCaida, pico > 0 ? (pico - capital) / pico : 0);
      peorDia = Math.min(peorDia, antes > 0 ? (capital - antes) / antes : 0);
    }
  };

  while (i < pend.length || abiertas.length > 0) {
    const proxEntrada = i < pend.length ? pend[i]!.tEntrada : Infinity;
    const proxSalida = abiertas.length
      ? abiertas.reduce((m, p) => Math.min(m, p.tSalida), Infinity)
      : Infinity;

    // Los cierres van primero cuando empatan: el dinero de una posicion que cierra hoy esta
    // disponible para la que abre hoy. Al reves seria inventarse capital.
    if (proxSalida <= proxEntrada) {
      cerrar(proxSalida);
      continue;
    }

    const op = pend[i]!;
    i += 1;
    if (capital <= 0) {
      rechazadas += 1;
      continue;
    }
    if (a.maxPosiciones > 0 && abiertas.length >= a.maxPosiciones) {
      rechazadas += 1;
      continue;
    }
    if (a.maxPorDireccion && a.maxPorDireccion > 0 && op.direccion) {
      const mismas = abiertas.filter((p) => p.direccion === op.direccion).length;
      if (mismas >= a.maxPorDireccion) {
        rechazadas += 1;
        continue;
      }
    }

    const base = a.compuesto ? capital : a.capital;
    const riesgo = base * a.riesgoPct * escala();
    // El dinero que mueve la posicion sale de dividir el riesgo entre la distancia al stop.
    const nocional = op.stopFraccion && op.stopFraccion > 0 ? riesgo / op.stopFraccion : 0;

    if (a.maxExposicion && a.maxExposicion > 0 && nocional > 0) {
      const abierta = abiertas.reduce((x, p) => x + p.nocional, 0);
      if (abierta + nocional > capital * a.maxExposicion) {
        rechazadas += 1;
        rechazadasPorExpo += 1;
        continue;
      }
    }

    abiertas.push({ tSalida: op.tSalida, r: op.r, riesgo, direccion: op.direccion, nocional });
    const expoAhora = abiertas.reduce((x, p) => x + p.nocional, 0);
    if (capital > 0) maxExpo = Math.max(maxExpo, expoAhora / capital);
    aceptadas += 1;
    sumaSim += abiertas.length;
    maxSim = Math.max(maxSim, abiertas.length);
  }

  return {
    capitalFinal: capital,
    maxCaida,
    aceptadas,
    rechazadas,
    maxSimultaneas: maxSim,
    maxExposicion: maxExpo,
    rechazadasPorExposicion: rechazadasPorExpo,
    mediaSimultaneas: aceptadas ? sumaSim / aceptadas : 0,
    curva,
    peorDia,
  };
}

/**
 * Agrupa por dia de entrada y devuelve la media de R de cada dia.
 *
 * Es la muestra HONESTA cuando las señales se agrupan: si 20 ETFs disparan el mismo dia, eso es
 * una observacion, no veinte. Un 68% de acierto sobre 1.492 operaciones puede ser un 55% sobre
 * 200 dias, y esa segunda cifra es la que manda.
 */
export function porDia(ops: Operacion[]): Array<{ dia: string; r: number; n: number }> {
  const m = new Map<string, number[]>();
  for (const o of ops) {
    const d = new Date(o.tEntrada * 1000).toISOString().slice(0, 10);
    const l = m.get(d);
    if (l) l.push(o.r);
    else m.set(d, [o.r]);
  }
  return [...m.entries()]
    .map(([dia, l]) => ({ dia, r: l.reduce((s, x) => s + x, 0) / l.length, n: l.length }))
    .sort((x, y) => x.dia.localeCompare(y.dia));
}
