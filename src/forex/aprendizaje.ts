/**
 * ¿SIRVE QUE UN AGENTE SE AUTOOPTIMICE? Las dos preguntas que lo deciden.
 *
 * LA PROMESA
 * ----------
 * "Un agente que revisa sus operaciones cada semana, forma una hipotesis de por que salieron
 * asi, cambia UNA variable y repite, se vuelve mas rentable con el tiempo."
 *
 * Suena razonable. Es el metodo cientifico. Pero tiene dos supuestos que hay que comprobar:
 *
 *   1. Que la muestra de cada revision baste para distinguir señal de ruido.
 *   2. Que el parametro que fue mejor en el pasado reciente siga siendo mejor despues.
 *
 * Si el primero falla, el agente esta aprendiendo de ruido y cada "mejora" es una moneda al
 * aire. Si falla el segundo, aprender bien del pasado tampoco sirve.
 *
 * Este modulo mide el primero de forma exacta; el segundo se mide con datos en `adaptativoCli`.
 */

export interface Distribucion {
  /** Fraccion de operaciones ganadoras. */
  acierto: number;
  /** R media de las ganadoras. */
  rGana: number;
  /** R media de las perdedoras, en positivo. */
  rPierde: number;
}

/** Esperanza en R de una distribucion de resultados. */
export function esperanza(d: Distribucion): number {
  return d.acierto * d.rGana - (1 - d.acierto) * d.rPierde;
}

/**
 * Desviacion tipica del resultado por operacion.
 *
 * Se calcula con el modelo de dos puntos (ganadora media y perdedora media). Subestima la real,
 * porque en seguimiento de tendencia las ganadoras tienen una cola larga y la dispersion
 * verdadera es MAYOR. Es decir: los tamaños de muestra que salen de aqui son un MINIMO.
 */
export function desviacion(d: Distribucion): number {
  const mu = esperanza(d);
  const varianza =
    d.acierto * (d.rGana - mu) ** 2 + (1 - d.acierto) * (-d.rPierde - mu) ** 2;
  return Math.sqrt(varianza);
}

/**
 * Cuantas operaciones hacen falta para distinguir dos esperanzas que difieren en `diferencia`.
 *
 * Se compara la media observada contra la real, exigiendo que la diferencia supere `sigmas`
 * errores estandar. Con sigmas = 2 se acierta aproximadamente el 95% de las veces.
 *
 *     n = (sigmas * sd / diferencia)^2
 *
 * No es un detalle academico: si un agente revisa 3 operaciones a la semana y hace falta un
 * millar para distinguir nada, ese agente no esta aprendiendo, esta reaccionando al ruido.
 */
export function muestraNecesaria(sd: number, diferencia: number, sigmas = 2): number {
  if (!(diferencia > 0) || !(sd > 0)) return Infinity;
  return Math.ceil((sigmas * sd / diferencia) ** 2);
}

/**
 * Probabilidad de que una variante PEOR parezca mejor en una muestra de `n` operaciones.
 *
 * Es el riesgo real del agente: adoptar un cambio que empeora porque en 20 operaciones salio
 * bien. Se aproxima con la normal, que a estos tamaños ya vale.
 */
export function riesgoDeConfundirse(sd: number, diferencia: number, n: number): number {
  if (!(n > 0) || !(sd > 0)) return 0.5;
  const z = diferencia / (sd / Math.sqrt(n));
  return 1 - normal(z);
}

/** Funcion de distribucion normal acumulada, por la aproximacion de Abramowitz y Stegun. */
export function normal(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (1.330274429 * t ** 4 - 1.821255978 * t ** 3 + 1.781477937 * t ** 2
    - 0.356563782 * t + 0.319381530);
  return z > 0 ? 1 - p : p;
}

/**
 * Cuantas operaciones ve una revision, dada la frecuencia de la estrategia.
 *
 * `operacionesAño` es del universo entero, no por instrumento.
 */
export function operacionesPorRevision(operacionesAño: number, diasEntreRevisiones: number): number {
  return (operacionesAño / 365.25) * diasEntreRevisiones;
}
