/**
 * DIVERSIFICAR PARAMETROS en vez de elegir uno.
 *
 * DE DONDE SALE ESTO
 * ------------------
 * Medido el 7 sep comparando un agente que se reoptimiza contra las alternativas:
 *
 *   configuracion fija arbitraria   0,175R
 *   elegir al azar cada mes         0,182R
 *   agente que se reoptimiza        0,256R a 0,335R
 *   NO ELEGIR: todas a la vez       0,276R a 0,283R
 *   oraculo (la mejor a posteriori) 0,283R
 *
 * O sea: repartir entre todas las configuraciones captura casi toda la ventaja disponible sin
 * tener que predecir nada, y bate por mucho a fijar una al azar. Es mas sencillo que un agente
 * que aprende y da un resultado parecido.
 *
 * LO QUE NO ES
 * ------------
 * Esto NO es "poner mas dinero". El riesgo total por operacion se mantiene: se reparte entre las
 * configuraciones activas. Si se repartiera sin dividir, seria multiplicar la apuesta por doce y
 * llamarlo diversificacion.
 */

export interface Configuracion {
  nombre: string;
  /** Multiplos de ATR que debe moverse el precio para dar señal. */
  k: number;
  /** Stop en multiplos de ATR. */
  atrStop: number;
  /** Trailing en multiplos del stop. */
  trailing: number;
  /** Peso dentro de la cartera. Se normaliza, asi que no hace falta que sumen 1. */
  peso: number;
}

/**
 * Reparte el riesgo total entre las configuraciones, proporcional a su peso.
 *
 * Devuelve la fraccion del capital que arriesga CADA configuracion. La suma es exactamente
 * `riesgoTotal`: diversificar no puede aumentar el riesgo, solo repartirlo.
 */
export function repartir(
  configuraciones: Configuracion[],
  riesgoTotal: number,
): Map<string, number> {
  const out = new Map<string, number>();
  const suma = configuraciones.reduce((s, c) => s + Math.max(0, c.peso), 0);
  if (!(suma > 0) || !(riesgoTotal > 0)) {
    for (const c of configuraciones) out.set(c.nombre, 0);
    return out;
  }
  for (const c of configuraciones) {
    out.set(c.nombre, (riesgoTotal * Math.max(0, c.peso)) / suma);
  }
  return out;
}

/**
 * Rejilla por defecto: el vecindario que salio positivo en las 18 variantes probadas.
 *
 * Se excluye a proposito `k = 1`, que en el barrido daba PF 6-8 pero con el 95% del resultado en
 * un solo instrumento: es una operacion que cabalgo un movimiento de 300x, no una ventaja.
 */
export function rejillaPorDefecto(): Configuracion[] {
  const out: Configuracion[] = [];
  for (const k of [1.5, 2, 2.5, 3]) {
    for (const atrStop of [2, 3]) {
      out.push({ nombre: `vol${k}_stop${atrStop}`, k, atrStop, trailing: 2, peso: 1 });
    }
  }
  return out;
}

export interface Version {
  /** Numero de version, creciente. */
  version: number;
  /** Momento en que se aplico. */
  fecha: string;
  configuraciones: Configuracion[];
  /** Que cambio respecto a la anterior, en una frase. */
  cambio: string;
  /** Que se esperaba que pasara. Sirve para poder contrastarlo despues. */
  hipotesis: string;
}

/**
 * Aplica un cambio guardando la version anterior.
 *
 * UNA SOLA VARIABLE POR CICLO, que es la unica parte del metodo cientifico que se puede imponer
 * en codigo: si cambias tres cosas y mejora, no sabes cual fue.
 *
 * Se comprueba de verdad, comparando las configuraciones campo a campo. Un comentario que diga
 * "solo una variable" no impide cambiar tres.
 */
export function cambiosEntre(antes: Configuracion[], despues: Configuracion[]): string[] {
  const cambios: string[] = [];
  const porNombre = new Map(antes.map((c) => [c.nombre, c]));
  for (const d of despues) {
    const a = porNombre.get(d.nombre);
    if (!a) {
      cambios.push(`${d.nombre}: añadida`);
      continue;
    }
    for (const campo of ["k", "atrStop", "trailing", "peso"] as const) {
      if (a[campo] !== d[campo]) {
        cambios.push(`${d.nombre}.${campo}: ${a[campo]} → ${d[campo]}`);
      }
    }
  }
  const nombresDespues = new Set(despues.map((c) => c.nombre));
  for (const a of antes) if (!nombresDespues.has(a.nombre)) cambios.push(`${a.nombre}: quitada`);
  return cambios;
}

export interface ResultadoCambio {
  aceptado: boolean;
  motivo: string;
  cambios: string[];
}

/**
 * Decide si un cambio propuesto se puede aplicar.
 *
 * Rechaza el cambio de mas de una variable, y rechaza tambien el cambio basado en muy pocas
 * operaciones. Ese segundo guardarrail es el que falta en casi todos los agentes que se
 * autooptimizan: medido aqui, hacen falta ~412 operaciones para distinguir una diferencia de
 * 0,15R, asi que revisar cada 5 es reaccionar al ruido.
 */
export function validarCambio(
  antes: Configuracion[],
  despues: Configuracion[],
  operacionesObservadas: number,
  minimoOperaciones: number,
): ResultadoCambio {
  const cambios = cambiosEntre(antes, despues);
  if (cambios.length === 0) {
    return { aceptado: false, motivo: "no cambia nada", cambios };
  }
  if (cambios.length > 1) {
    return {
      aceptado: false,
      motivo: `cambia ${cambios.length} variables; solo se permite una por ciclo`,
      cambios,
    };
  }
  if (operacionesObservadas < minimoOperaciones) {
    return {
      aceptado: false,
      motivo:
        `solo ${operacionesObservadas} operaciones observadas, hacen falta ${minimoOperaciones}` +
        " para que el cambio no sea ruido",
      cambios,
    };
  }
  return { aceptado: true, motivo: "cambio valido", cambios };
}
