/**
 * EL CEREBRO DEL BOT: dado el estado y las señales de hoy, que ordenes hay que dar.
 *
 * Puro a proposito. No habla con ningun exchange, no lee la hora, no tiene estado propio.
 * Entra el estado, salen las ordenes. Asi se puede probar entero sin tocar dinero, que es la
 * unica forma de confiar en algo que va a operar solo.
 *
 * LAS BARRERAS ESTAN AQUI, NO EN LA CAPA DE RED
 * ---------------------------------------------
 * Un limite que vive en el codigo de ejecucion se salta con un reintento o un bug de red. Un
 * limite que vive en la decision no se salta: si la funcion no emite la orden, la orden no
 * existe. Por eso el tope de posiciones, el de experiencia y el freno por perdida diaria estan
 * en esta funcion y no en el cliente HTTP.
 *
 * EL ORDEN IMPORTA: primero se cierra, luego se mueve, y solo al final se abre. Si se abriera
 * antes de cerrar, el tope de posiciones se calcularia sobre un estado que ya no es el real.
 */

export type Direccion = "LARGO" | "CORTO";

export interface Posicion {
  simbolo: string;
  direccion: Direccion;
  /** Precio al que se entro de verdad. */
  entrada: number;
  /** Unidades del activo. */
  unidades: number;
  /** Distancia del stop en precio, congelada en la entrada. Es la R. */
  riesgo: number;
  /** Nivel actual del stop. Solo se mueve a favor. */
  nivelStop: number;
  /** Mejor precio alcanzado a favor, para el trailing. */
  extremo: number;
  /**
   * Dia de la vela que dio la señal y dia en que se lleno la entrada. Solo se guardan para poder
   * auditar despues: nada de la decision depende de ellos.
   *
   * Opcionales porque las posiciones abiertas antes de que existieran no los tienen, y
   * rellenarlos ahora seria inventar una fecha que en su momento no se apunto.
   */
  diaSenal?: string;
  diaEntrada?: string;
}

export interface SeñalEntrada {
  simbolo: string;
  direccion: Direccion;
  /** Distancia del stop propuesta (2 ATR). */
  riesgo: number;
  /** Precio de referencia para calcular el tamaño. */
  precio: number;
  /** Fuerza de la ruptura en ATR. Decide el orden cuando hay mas señales que huecos. */
  fuerza: number;
}

export interface Mercado {
  simbolo: string;
  ultimo: number;
  /** Maximo y minimo desde la ultima revision, para mover el trailing y disparar el stop. */
  maximo: number;
  minimo: number;
}

export interface Ajustes {
  capital: number;
  /** Fraccion del capital arriesgada por operacion. */
  riesgoPct: number;
  maxPosiciones: number;
  /** Trailing en multiplos del riesgo. */
  trailing: number;
  /** Tope de exposicion en multiplos del capital. 1 = sin apalancamiento. */
  maxExposicion: number;
  /**
   * Perdida maxima del dia en fraccion del capital. Alcanzada, no se abre nada mas.
   * Las salidas SIEMPRE siguen permitidas: frenar los cierres seria dejar el riesgo suelto.
   */
  maxPerdidaDiaria: number;
  /** Interruptor manual. Con true no se abre nada, pero se sigue gestionando lo abierto. */
  parado: boolean;
}

export interface Estado {
  posiciones: Posicion[];
  /** Resultado acumulado del dia en fraccion del capital. Negativo si va perdiendo. */
  resultadoDia: number;
}

export type Orden =
  | { tipo: "CERRAR"; simbolo: string; unidades: number; motivo: string }
  | { tipo: "MOVER_STOP"; simbolo: string; nuevoNivel: number; motivo: string }
  | {
      tipo: "ABRIR";
      simbolo: string;
      direccion: Direccion;
      unidades: number;
      nivelStop: number;
      riesgo: number;
      motivo: string;
    };

export interface Decision {
  ordenes: Orden[];
  /** Señales descartadas y por que. Sirve para auditar que el bot no se calla nada. */
  descartadas: Array<{ simbolo: string; motivo: string }>;
  /** Estado que quedaria tras aplicar las ordenes. */
  estadoFinal: Estado;
}

/** Exposicion actual en multiplos del capital. */
export function exposicion(posiciones: Posicion[], capital: number): number {
  if (!(capital > 0)) return 0;
  return posiciones.reduce((s, p) => s + p.unidades * p.entrada, 0) / capital;
}

/**
 * Decide todo lo que hay que hacer en esta revision.
 *
 * `mercados` trae el recorrido desde la ultima vez. Si falta un simbolo, esa posicion NO se
 * toca: sin datos no se puede saber si el stop salto, y cerrarla o moverla a ciegas seria
 * inventarse una decision.
 */
export function decidir(
  estado: Estado,
  señales: SeñalEntrada[],
  mercados: Map<string, Mercado>,
  aj: Ajustes,
): Decision {
  const ordenes: Orden[] = [];
  const descartadas: Array<{ simbolo: string; motivo: string }> = [];
  let posiciones = estado.posiciones.map((p) => ({ ...p }));

  // ---- 1. CERRAR lo que ha tocado su stop -----------------------------------------------
  const siguen: Posicion[] = [];
  for (const p of posiciones) {
    const m = mercados.get(p.simbolo);
    if (!m) {
      siguen.push(p);
      continue;
    }
    const tocado = p.direccion === "LARGO" ? m.minimo <= p.nivelStop : m.maximo >= p.nivelStop;
    if (tocado) {
      ordenes.push({
        tipo: "CERRAR",
        simbolo: p.simbolo,
        unidades: p.unidades,
        motivo: `stop tocado en ${p.nivelStop}`,
      });
    } else {
      siguen.push(p);
    }
  }
  posiciones = siguen;

  // ---- 2. MOVER el trailing, solo a favor ----------------------------------------------
  for (const p of posiciones) {
    const m = mercados.get(p.simbolo);
    if (!m || !(aj.trailing > 0)) continue;
    const largo = p.direccion === "LARGO";
    const nuevoExtremo = largo ? Math.max(p.extremo, m.maximo) : Math.min(p.extremo, m.minimo);
    const propuesto = largo
      ? nuevoExtremo - p.riesgo * aj.trailing
      : nuevoExtremo + p.riesgo * aj.trailing;
    // El stop NUNCA retrocede. Sin esta guarda, una vela contraria aflojaria la proteccion.
    const nuevo = largo ? Math.max(p.nivelStop, propuesto) : Math.min(p.nivelStop, propuesto);
    p.extremo = nuevoExtremo;
    if (nuevo !== p.nivelStop) {
      p.nivelStop = nuevo;
      ordenes.push({
        tipo: "MOVER_STOP",
        simbolo: p.simbolo,
        nuevoNivel: nuevo,
        motivo: `trailing a ${aj.trailing}x`,
      });
    }
  }

  // ---- 3. ABRIR, si las barreras lo permiten -------------------------------------------
  // Se ordenan por fuerza ANTES de mirar los huecos: la prioridad se fija por regla, no por
  // el orden en que llegaron las señales.
  const candidatas = [...señales].sort((a, b) => b.fuerza - a.fuerza);

  for (const s of candidatas) {
    if (aj.parado) {
      descartadas.push({ simbolo: s.simbolo, motivo: "bot parado" });
      continue;
    }
    if (estado.resultadoDia <= -aj.maxPerdidaDiaria) {
      descartadas.push({ simbolo: s.simbolo, motivo: "tope de perdida diaria alcanzado" });
      continue;
    }
    if (posiciones.length >= aj.maxPosiciones) {
      descartadas.push({ simbolo: s.simbolo, motivo: "tope de posiciones" });
      continue;
    }
    // Una sola posicion por simbolo: doblar la misma apuesta no es diversificar.
    if (posiciones.some((p) => p.simbolo === s.simbolo)) {
      descartadas.push({ simbolo: s.simbolo, motivo: "ya hay posicion abierta" });
      continue;
    }
    if (!(s.riesgo > 0) || !(s.precio > 0)) {
      descartadas.push({ simbolo: s.simbolo, motivo: "riesgo o precio invalidos" });
      continue;
    }

    const unidades = (aj.capital * aj.riesgoPct) / s.riesgo;
    const nocional = unidades * s.precio;
    const expoActual = exposicion(posiciones, aj.capital);
    if (expoActual + nocional / aj.capital > aj.maxExposicion) {
      descartadas.push({ simbolo: s.simbolo, motivo: "no cabe en la exposicion permitida" });
      continue;
    }

    const largo = s.direccion === "LARGO";
    const nivelStop = largo ? s.precio - s.riesgo : s.precio + s.riesgo;
    ordenes.push({
      tipo: "ABRIR",
      simbolo: s.simbolo,
      direccion: s.direccion,
      unidades,
      nivelStop,
      riesgo: s.riesgo,
      motivo: `ruptura de ${s.fuerza.toFixed(1)} ATR`,
    });
    posiciones.push({
      simbolo: s.simbolo,
      direccion: s.direccion,
      entrada: s.precio,
      unidades,
      riesgo: s.riesgo,
      nivelStop,
      extremo: s.precio,
    });
  }

  return { ordenes, descartadas, estadoFinal: { ...estado, posiciones } };
}
