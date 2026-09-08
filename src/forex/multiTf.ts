/**
 * Estrategia RSI multi-temporal: H1 marca la direccion, M15 la zona, M5 la entrada.
 *
 * LA IDEA
 * -------
 * El RSI solo, a 70/30, es casi una moneda al aire: medido a 5 min sobre 9.312 operaciones da
 * 53% de acierto y +0,050R sin costes. Hay borde, pero el spread (0,15R con stop de 20 pips)
 * se lo come tres veces.
 *
 * Asi que la pregunta no es si el RSI sirve, sino si se puede subir ese 53% lo suficiente
 * para que el spread deje de mandar. La estructura de tres temporalidades es la via clasica:
 * no operar contra la tendencia mayor.
 *
 * COMO SE ALINEAN LAS TEMPORALIDADES
 * ----------------------------------
 * Cada vela de M5 mira la ULTIMA vela de M15 y de H1 ya CERRADA. Usar la vela en curso seria
 * mirar el futuro: a las 10:03 no se conoce el cierre de la vela H1 de las 10:00.
 *
 * Todo puro.
 */
import type { Vela } from "./datos";
import { rsi, type Direccion } from "./rsi";

/** Media exponencial. Se usa para la EMA200 de H1 que marca la direccion. */
export function ema(valores: number[], periodo: number): (number | null)[] {
  const out: (number | null)[] = new Array(valores.length).fill(null);
  if (valores.length < periodo) return out;

  let suma = 0;
  for (let i = 0; i < periodo; i += 1) suma += valores[i]!;
  let actual = suma / periodo;
  out[periodo - 1] = actual;

  const k = 2 / (periodo + 1);
  for (let i = periodo; i < valores.length; i += 1) {
    actual = valores[i]! * k + actual * (1 - k);
    out[i] = actual;
  }
  return out;
}

export interface ReglasMulti {
  periodoRsi: number;
  sobreventa: number;
  sobrecompra: number;
  /** Periodo de la EMA de H1 que marca la direccion. 0 = sin filtro de tendencia. */
  emaH1: number;
  /** Si true, M15 tiene que estar en zona extrema. */
  exigirM15: boolean;
}

export const REGLAS_MULTI: ReglasMulti = {
  periodoRsi: 14,
  sobreventa: 30,
  sobrecompra: 70,
  emaH1: 200,
  exigirM15: true,
};

export interface SeñalMulti {
  i: number;
  direccion: Direccion;
  /** El RSI de M5, con el nombre que espera el backtest (compatible con `Señal`). */
  rsi: number;
  rsiM5: number;
  rsiM15: number | null;
  /** true si el precio estaba por encima de la EMA de H1. */
  tendenciaAlcista: boolean | null;
}

/**
 * Para cada vela de `chica`, el indice de la ultima vela de `grande` YA CERRADA.
 *
 * Una vela de `grande` cierra en su `t` + su duracion, y esa duracion se deduce del propio
 * espaciado de la serie. Sin este cuidado se usaria la vela en curso, que es mirar el futuro.
 */
export function alinear(chica: Vela[], grande: Vela[]): (number | null)[] {
  const out: (number | null)[] = new Array(chica.length).fill(null);
  if (grande.length < 2) return out;

  // Duracion tipica de la vela grande, por la mediana de los saltos (robusta a huecos).
  const saltos = grande.slice(1).map((v, i) => v.t - grande[i]!.t).sort((a, b) => a - b);
  const duracion = saltos[Math.floor(saltos.length / 2)] ?? 3600;

  let j = 0;
  for (let i = 0; i < chica.length; i += 1) {
    // Avanzar mientras la siguiente vela grande ya haya CERRADO antes de esta vela chica.
    while (j + 1 < grande.length && grande[j + 1]!.t + duracion <= chica[i]!.t) j += 1;
    out[i] = grande[j]!.t + duracion <= chica[i]!.t ? j : null;
  }
  return out;
}

/**
 * Señales de la estrategia de tres temporalidades. Pura.
 *
 * Entrada larga: H1 alcista → M15 en sobreventa → M5 CRUZA de vuelta hacia arriba.
 * Se exige el cruce y no el simple toque: en tendencia el RSI se queda en zona extrema
 * durante horas, y entrar al tocar es comprar toda la caida.
 */
export function señalesMulti(
  m5: Vela[],
  m15: Vela[],
  h1: Vela[],
  reglas: ReglasMulti = REGLAS_MULTI,
): SeñalMulti[] {
  const rsi5 = rsi(m5.map((v) => v.c), reglas.periodoRsi);
  const rsi15 = rsi(m15.map((v) => v.c), reglas.periodoRsi);
  const emaH1 = reglas.emaH1 > 0 ? ema(h1.map((v) => v.c), reglas.emaH1) : [];

  const aM15 = alinear(m5, m15);
  const aH1 = alinear(m5, h1);

  const out: SeñalMulti[] = [];
  for (let i = 1; i < m5.length; i += 1) {
    const hoy = rsi5[i];
    const ayer = rsi5[i - 1];
    if (hoy == null || ayer == null) continue;

    const cruzaArriba = ayer < reglas.sobreventa && hoy >= reglas.sobreventa;
    const cruzaAbajo = ayer > reglas.sobrecompra && hoy <= reglas.sobrecompra;
    if (!cruzaArriba && !cruzaAbajo) continue;
    const direccion: Direccion = cruzaArriba ? "LARGO" : "CORTO";

    // --- confirmacion de M15 ---
    const j15 = aM15[i];
    const r15 = j15 != null ? (rsi15[j15] ?? null) : null;
    if (reglas.exigirM15) {
      if (r15 === null) continue;
      if (direccion === "LARGO" && r15 >= reglas.sobreventa + 10) continue;
      if (direccion === "CORTO" && r15 <= reglas.sobrecompra - 10) continue;
    }

    // --- filtro de tendencia de H1 ---
    let alcista: boolean | null = null;
    if (reglas.emaH1 > 0) {
      const jH1 = aH1[i];
      const e = jH1 != null ? (emaH1[jH1] ?? null) : null;
      if (e === null || jH1 == null) continue;
      alcista = h1[jH1]!.c > e;
      // No operar contra la tendencia mayor: es lo que aporta la estructura de tres marcos.
      if (direccion === "LARGO" && !alcista) continue;
      if (direccion === "CORTO" && alcista) continue;
    }

    out.push({ i, direccion, rsi: hoy, rsiM5: hoy, rsiM15: r15, tendenciaAlcista: alcista });
  }
  return out;
}

/**
 * ATR de Wilder. Mide la volatilidad reciente en unidades de precio.
 *
 * POR QUE IMPORTA AQUI
 * Un stop de 20 pips es enorme en la sesion asiatica y ridiculo en el solape Londres-NY. Un
 * stop en multiplos de ATR se adapta solo, y la investigacion de 2026 lo señala como uno de
 * los pocos elementos que se repiten en los sistemas que aguantan.
 *
 * El rango verdadero incluye el hueco contra el cierre anterior, no solo max-min de la vela:
 * ignorarlo subestima la volatilidad justo en las velas que mas importan.
 */
export function atr(velas: Vela[], periodo = 14): (number | null)[] {
  const out: (number | null)[] = new Array(velas.length).fill(null);
  if (velas.length <= periodo) return out;

  const tr: number[] = [0];
  for (let i = 1; i < velas.length; i += 1) {
    const v = velas[i]!;
    const cierreAnterior = velas[i - 1]!.c;
    tr.push(Math.max(v.h - v.l, Math.abs(v.h - cierreAnterior), Math.abs(v.l - cierreAnterior)));
  }

  let suma = 0;
  for (let i = 1; i <= periodo; i += 1) suma += tr[i]!;
  let actual = suma / periodo;
  out[periodo] = actual;

  // Suavizado de Wilder, igual que el RSI.
  for (let i = periodo + 1; i < velas.length; i += 1) {
    actual = (actual * (periodo - 1) + tr[i]!) / periodo;
    out[i] = actual;
  }
  return out;
}

/**
 * ¿Esta el precio por encima de su EMA en la MISMA temporalidad?
 *
 * Es un filtro de tendencia mucho mas rapido que una EMA200 en H1, y es el que describen los
 * ejemplos de 2026 (EMA20 + RSI en M5). Merecen probarse por separado: no son el mismo filtro
 * ni excluyen las mismas operaciones.
 */
export function filtroEmaPropia(
  velas: Vela[],
  periodo: number,
): (boolean | null)[] {
  const e = ema(velas.map((v) => v.c), periodo);
  return e.map((x, i) => (x == null ? null : velas[i]!.c > x));
}
