/**
 * RSI de Wilder y señales de sobrecompra/sobreventa.
 *
 * LA TRAMPA CLASICA
 * -----------------
 * El RSI NO usa una media simple de las ganancias y perdidas: usa el suavizado de Wilder, que
 * es una media exponencial con alpha = 1/periodo. Calcularlo con media simple da numeros
 * parecidos pero distintos, y las señales caen en velas diferentes. Es el error mas comun al
 * implementarlo, y produce un backtest que no corresponde a lo que veias en la plataforma.
 *
 * La primera media SI es simple (las primeras `periodo` variaciones); a partir de ahi, Wilder.
 *
 * Todo puro: entran precios, salen numeros. Sin red, sin estado.
 */

/**
 * RSI para cada vela. Las primeras `periodo` posiciones salen null: no hay dato suficiente y
 * rellenarlas con 50 —que es lo que hacen muchas librerias— mete señales falsas al principio
 * de cada serie.
 */
export function rsi(cierres: number[], periodo = 14): (number | null)[] {
  const out: (number | null)[] = new Array(cierres.length).fill(null);
  if (cierres.length <= periodo) return out;

  let sumaGanancias = 0;
  let sumaPerdidas = 0;
  for (let i = 1; i <= periodo; i += 1) {
    const cambio = cierres[i]! - cierres[i - 1]!;
    if (cambio >= 0) sumaGanancias += cambio;
    else sumaPerdidas -= cambio;
  }

  // Primera media: simple sobre las primeras `periodo` variaciones.
  let mediaGanancia = sumaGanancias / periodo;
  let mediaPerdida = sumaPerdidas / periodo;
  out[periodo] = valor(mediaGanancia, mediaPerdida);

  // A partir de aqui, suavizado de Wilder.
  for (let i = periodo + 1; i < cierres.length; i += 1) {
    const cambio = cierres[i]! - cierres[i - 1]!;
    const ganancia = cambio > 0 ? cambio : 0;
    const perdida = cambio < 0 ? -cambio : 0;
    mediaGanancia = (mediaGanancia * (periodo - 1) + ganancia) / periodo;
    mediaPerdida = (mediaPerdida * (periodo - 1) + perdida) / periodo;
    out[i] = valor(mediaGanancia, mediaPerdida);
  }
  return out;
}

function valor(mediaGanancia: number, mediaPerdida: number): number {
  // Sin perdidas el RSI es 100 por definicion; dividir daria infinito.
  if (mediaPerdida === 0) return mediaGanancia === 0 ? 50 : 100;
  const rs = mediaGanancia / mediaPerdida;
  return 100 - 100 / (1 + rs);
}

export type Direccion = "LARGO" | "CORTO";

export interface Señal {
  /** Indice de la vela en la que se decide. */
  i: number;
  direccion: Direccion;
  rsi: number;
}

export interface ReglasRsi {
  periodo: number;
  /** Por debajo de esto, sobreventa: se compra. */
  sobreventa: number;
  /** Por encima de esto, sobrecompra: se vende. */
  sobrecompra: number;
  /**
   * Si true, se entra al CRUZAR de vuelta el umbral (RSI sale de sobreventa hacia arriba).
   * Si false, se entra mientras esté pasado de rosca.
   *
   * No es un detalle: en una tendencia fuerte el RSI puede quedarse bajo 30 durante semanas.
   * Entrar "mientras esté" es comprar toda la caida; entrar "al cruzar" espera a que gire.
   */
  esperarCruce: boolean;
  /** true = solo largos, para probar por separado cada lado. */
  soloLargos?: boolean;
  soloCortos?: boolean;
}

export const REGLAS_RSI: ReglasRsi = {
  periodo: 14,
  sobreventa: 30,
  sobrecompra: 70,
  esperarCruce: true,
};

/**
 * Señales de una serie. Pura.
 *
 * La señal de la vela `i` usa el RSI de la vela `i`, que se conoce a su CIERRE. Quien la
 * ejecute debe entrar en la vela `i+1`, nunca en la `i`: entrar al cierre de la misma vela que
 * genera la señal es mirar el futuro, y es la forma mas comun de fabricar un backtest ganador.
 */
export function señales(cierres: number[], reglas: ReglasRsi = REGLAS_RSI): Señal[] {
  const valores = rsi(cierres, reglas.periodo);
  const out: Señal[] = [];

  for (let i = 1; i < valores.length; i += 1) {
    const hoy = valores[i];
    const ayer = valores[i - 1];
    if (hoy == null || ayer == null) continue;

    let direccion: Direccion | null = null;
    if (reglas.esperarCruce) {
      // Cruce de vuelta: ayer pasado de rosca, hoy ya no.
      if (ayer < reglas.sobreventa && hoy >= reglas.sobreventa) direccion = "LARGO";
      else if (ayer > reglas.sobrecompra && hoy <= reglas.sobrecompra) direccion = "CORTO";
    } else {
      if (hoy < reglas.sobreventa) direccion = "LARGO";
      else if (hoy > reglas.sobrecompra) direccion = "CORTO";
    }

    if (!direccion) continue;
    if (direccion === "LARGO" && reglas.soloCortos) continue;
    if (direccion === "CORTO" && reglas.soloLargos) continue;
    out.push({ i, direccion, rsi: hoy });
  }
  return out;
}

/**
 * Filtra señales por sesion horaria (UTC).
 *
 * Las sesiones no son folclore: la liquidez y el rango cambian mucho entre la sesion asiatica
 * y el solape Londres-Nueva York, y una estrategia de reversion vive precisamente de que el
 * precio vuelva. Se prueba, no se supone.
 */
export function filtrarPorSesion(
  señales: Señal[],
  tiempos: number[],
  desdeHoraUtc: number,
  hastaHoraUtc: number,
): Señal[] {
  return señales.filter((s) => {
    const t = tiempos[s.i];
    if (t == null) return false;
    const h = new Date(t * 1000).getUTCHours();
    // Un rango que cruza medianoche (22 a 6) se trata como union, no como interseccion.
    return desdeHoraUtc <= hastaHoraUtc
      ? h >= desdeHoraUtc && h < hastaHoraUtc
      : h >= desdeHoraUtc || h < hastaHoraUtc;
  });
}
