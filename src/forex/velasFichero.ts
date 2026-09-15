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
  /**
   * De que simbolo del broker salio cada par: `{"EURUSD=X": "EURUSD#"}`.
   *
   * Opcional porque los ficheros escritos antes del 14 sep no lo traen.
   */
  simbolos?: Record<string, string>;
  desfase: number;
  sacadas: string;
  tf: Record<string, Record<string, Vela[]>>;
}

/**
 * Una etiqueta corta del GRUPO de simbolos del que salieron las velas.
 *
 * POR QUE HACE FALTA. En la cuenta del 14 sep conviven `EURUSD` (grupo Standard, 2,20 pips de
 * spread) y `EURUSD#` (Ultra Low, 1,30). Las velas son BID, asi que el mismo mercado da dos
 * series distintas segun el grupo, separadas por medio pip constante — sobre un stop de 18 pips,
 * el 3% del riesgo.
 *
 * Va dentro de los ajustes del registro para que el grabador se niegue a continuar uno empezado
 * con el otro grupo. Es exactamente la guarda que impidio mezclar Yahoo con XM.
 *
 * Se resume en el SUFIJO comun en vez de listar los doce nombres: lo que distingue a los grupos
 * es eso, y una etiqueta larga haria ilegible el mensaje de error que la compara.
 */
export function grupoDeSimbolos(datos: VelasDeFichero): string {
  const nombres = Object.entries(datos.simbolos ?? {});
  if (!nombres.length) return "";
  const sufijos = new Set(nombres.map(([par, real]) => {
    const base = par.replace("=X", "");
    return real.startsWith(base) ? real.slice(base.length) : `=${real}`;
  }));
  const lista = [...sufijos].sort();
  // Todos iguales: una etiqueta. Mezclados: se dicen todos, porque entonces el registro esta
  // leyendo de dos grupos a la vez y eso tiene que verse.
  return lista.length === 1 ? (lista[0] || "plano") : lista.map((x) => x || "plano").join("+");
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
    //
    // EL VALOR ABSOLUTO NO SOBRA. Antes esto era `Math.max(0, ...)`, asi que una vela fechada en
    // el FUTURO daba antiguedad 0 y pasaba por fresca. El 15 sep el exportador dedujo mal el
    // desfase del servidor y escribio el fichero 20 horas adelantado; la guarda no vio nada y
    // seis registros apuntaron una señal inventada.
    //
    // Una vela del futuro no es fresca: es tan invalida como una vieja, y por el mismo motivo
    // —su fecha no es la que dice— asi que cuenta igual de antigua.
    antiguedad: Math.abs(ahora - (ultima + paso)),
  };
}
