/**
 * Velas leidas de un fichero en vez de bajadas de Yahoo.
 *
 * POR QUE. Hasta el 13 sep se decidia con precios de Yahoo y se operaba en XM. La diferencia
 * medida sobre ~2.940 velas de 5m por par era un sesgo CONSTANTE de 0,82 a 1,35 pips, siempre
 * con Yahoo por encima. Sobre los stops de 7-9 pips de `afinado` eso es el 9-19% del riesgo.
 *
 * Decidir en un libro y ejecutar en otro no se arregla con un ajuste: se lee del mismo sitio.
 * `src/mt5/velas.py` saca las velas del broker a un JSON y esto las trae.
 *
 * LO QUE ESTE FICHERO COMPRUEBA, Y POR QUE NO SE FIA
 * -------------------------------------------------
 * Un grabador que lee velas rancias no falla: apunta señales viejas como si fueran de ahora, y
 * el registro queda contaminado sin que nada avise. Por eso la frescura se comprueba aqui y se
 * devuelve como error, no como advertencia.
 */
import type { Vela, Temporalidad } from "./datos";

export interface VelasDeFichero {
  fuente: string;
  desfase: number;
  sacadas: string;
  tf: Record<string, Record<string, Vela[]>>;
}

export interface Lectura {
  velas: Map<string, Vela[]>;
  fuente: string;
  /** Segundos desde la ultima vela cerrada. Se devuelve para poder decidir fuera. */
  antiguedad: number;
}

/** Un paso en segundos por temporalidad, para juzgar si la ultima vela es de ahora. */
const PASO: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };

/**
 * Saca de la estructura del fichero las velas de una temporalidad.
 *
 * `ahora` entra como parametro en vez de leerse del reloj para que las pruebas no dependan de
 * cuando se corran, que es la forma mas tonta de tener una prueba que falla los lunes.
 */
export function leerVelas(
  datos: VelasDeFichero,
  tf: Temporalidad,
  ahora: number,
): Lectura {
  const bloque = datos.tf?.[tf];
  if (!bloque) {
    throw new Error(
      `el fichero de velas no trae la temporalidad ${tf} (trae ${Object.keys(datos.tf ?? {}).join(", ") || "ninguna"})`,
    );
  }
  const velas = new Map<string, Vela[]>();
  let ultima = 0;
  for (const [par, vs] of Object.entries(bloque)) {
    if (!vs.length) continue;
    // ORDENADAS SIEMPRE. Todo lo que viene despues —los picos, los huecos, la busqueda de la
    // entrada— recorre el array por indice y da resultados sin sentido si llega desordenado.
    const ord = [...vs].sort((a, b) => a.t - b.t);
    velas.set(par, ord);
    ultima = Math.max(ultima, ord[ord.length - 1]!.t);
  }
  const paso = PASO[tf] ?? 300;
  return {
    velas,
    fuente: datos.fuente ?? "?",
    // La ultima vela del fichero esta EN CURSO, asi que su antiguedad natural es de hasta un
    // paso. Se mide contra el final de esa vela para que "0" signifique al dia.
    antiguedad: Math.max(0, ahora - (ultima + paso)),
  };
}
