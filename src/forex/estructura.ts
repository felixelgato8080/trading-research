/**
 * Estructura de mercado: swings, zonas, barridos de liquidez y rupturas.
 *
 * Todo PURO y sin mirar el futuro. Esa es la unica regla que no se negocia aqui: cada funcion
 * recibe el indice de la vela actual y solo puede usar velas anteriores o iguales. Un swing
 * "confirmado" que use velas posteriores convierte cualquier estrategia en ganadora dentro
 * del backtest y en perdedora en vivo.
 *
 * Es el mismo cuidado que ya costo dos conclusiones falsas en este proyecto: el truncamiento
 * de los caminos y la vela superior sin cerrar.
 */
import type { Vela } from "./datos";

/**
 * Un swing high necesita `n` velas a cada lado mas bajas. Por eso solo se puede CONFIRMAR
 * `n` velas despues de que ocurra: en la vela `i` se conocen los swings hasta `i - n`.
 *
 * Devolver el swing en el momento en que ocurre —y no cuando se confirma— es la forma mas
 * comun de mirar el futuro sin darse cuenta.
 */
export interface Swing {
  /** Indice de la vela del extremo. */
  i: number;
  /** Indice a partir del cual se puede USAR sin mirar el futuro. */
  iConfirmado: number;
  precio: number;
  tipo: "ALTO" | "BAJO";
}

export function swings(velas: Vela[], n = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = n; i < velas.length - n; i += 1) {
    const v = velas[i]!;
    let esAlto = true;
    let esBajo = true;
    for (let k = 1; k <= n; k += 1) {
      if (velas[i - k]!.h >= v.h || velas[i + k]!.h >= v.h) esAlto = false;
      if (velas[i - k]!.l <= v.l || velas[i + k]!.l <= v.l) esBajo = false;
    }
    if (esAlto) out.push({ i, iConfirmado: i + n, precio: v.h, tipo: "ALTO" });
    if (esBajo) out.push({ i, iConfirmado: i + n, precio: v.l, tipo: "BAJO" });
  }
  return out;
}

/** Los swings utilizables en la vela `i`: confirmados y no futuros. */
export function swingsDisponibles(ss: Swing[], i: number): Swing[] {
  return ss.filter((s) => s.iConfirmado <= i);
}

/**
 * ¿Hubo barrido de liquidez y recuperacion?
 *
 * LONG: el precio perfora un minimo previo y vuelve a cerrar POR ENCIMA de el. Eso deja
 * atrapados a los que vendieron la ruptura, y es lo que da combustible al giro.
 *
 * Se exige cierre por encima, no solo mecha: una mecha que perfora y cierra debajo no es un
 * barrido, es una ruptura que sigue.
 */
export function barridoLiquidez(
  velas: Vela[],
  i: number,
  ss: Swing[],
  ventana: number,
  direccion: "LARGO" | "CORTO",
): { hubo: boolean; nivel: number | null } {
  const disponibles = swingsDisponibles(ss, i).filter(
    (s) => s.i >= i - ventana && s.i < i && s.tipo === (direccion === "LARGO" ? "BAJO" : "ALTO"),
  );
  if (disponibles.length === 0) return { hubo: false, nivel: null };

  const v = velas[i]!;
  for (const s of disponibles) {
    if (direccion === "LARGO") {
      // Perforo el minimo con la mecha y cerro por encima: barrido y recuperacion.
      if (v.l < s.precio && v.c > s.precio) return { hubo: true, nivel: s.precio };
    } else {
      if (v.h > s.precio && v.c < s.precio) return { hubo: true, nivel: s.precio };
    }
  }
  return { hubo: false, nivel: null };
}

/**
 * ¿Rompio el ultimo micro-swing en la direccion del setup?
 *
 * Es la confirmacion de que la estructura gira, no solo de que el precio reboto. Se usa el
 * ultimo swing CONFIRMADO anterior a `i`.
 */
export function rupturaEstructura(
  velas: Vela[],
  i: number,
  ss: Swing[],
  direccion: "LARGO" | "CORTO",
): boolean {
  const tipo = direccion === "LARGO" ? "ALTO" : "BAJO";
  const previos = swingsDisponibles(ss, i).filter((s) => s.tipo === tipo && s.i < i);
  const ultimo = previos[previos.length - 1];
  if (!ultimo) return false;
  return direccion === "LARGO" ? velas[i]!.c > ultimo.precio : velas[i]!.c < ultimo.precio;
}

/**
 * Zonas de referencia del dia anterior y de la sesion asiatica.
 *
 * Se calculan con velas CERRADAS del periodo ya terminado. El maximo del dia de hoy no se
 * conoce hasta que el dia acaba, asi que usarlo seria mirar el futuro.
 */
export interface Zonas {
  diaPrevioAlto: number | null;
  diaPrevioBajo: number | null;
  asiaAlto: number | null;
  asiaBajo: number | null;
}

/** Sesion asiatica en UTC: 00:00 a 07:00. */
function esAsia(t: number): boolean {
  const h = new Date(t * 1000).getUTCHours();
  return h < 7;
}

function dia(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

/**
 * Zonas para cada vela, usando SOLO informacion de dias/sesiones ya cerrados.
 * Se recorre una vez y se arrastra el estado: O(n).
 */
export function zonasPorVela(velas: Vela[]): Zonas[] {
  const out: Zonas[] = new Array(velas.length);
  let diaActual = velas.length ? dia(velas[0]!.t) : "";
  let altoHoy = -Infinity;
  let bajoHoy = Infinity;
  let altoAsiaHoy = -Infinity;
  let bajoAsiaHoy = Infinity;
  // Lo del dia anterior, ya cerrado y por tanto utilizable.
  let zona: Zonas = { diaPrevioAlto: null, diaPrevioBajo: null, asiaAlto: null, asiaBajo: null };
  let asiaCerrada = false;

  for (let i = 0; i < velas.length; i += 1) {
    const v = velas[i]!;
    const d = dia(v.t);

    if (d !== diaActual) {
      // Cambio de dia: lo de ayer pasa a ser utilizable.
      zona = {
        diaPrevioAlto: Number.isFinite(altoHoy) ? altoHoy : null,
        diaPrevioBajo: Number.isFinite(bajoHoy) ? bajoHoy : null,
        asiaAlto: null,
        asiaBajo: null,
      };
      diaActual = d;
      altoHoy = -Infinity;
      bajoHoy = Infinity;
      altoAsiaHoy = -Infinity;
      bajoAsiaHoy = Infinity;
      asiaCerrada = false;
    }

    // La sesion asiatica de HOY solo se puede usar una vez que ha terminado.
    if (!esAsia(v.t) && !asiaCerrada && Number.isFinite(altoAsiaHoy)) {
      zona = { ...zona, asiaAlto: altoAsiaHoy, asiaBajo: bajoAsiaHoy };
      asiaCerrada = true;
    }

    out[i] = zona;

    // Se actualiza DESPUES de asignar: la vela actual no puede formar parte de su propia zona.
    altoHoy = Math.max(altoHoy, v.h);
    bajoHoy = Math.min(bajoHoy, v.l);
    if (esAsia(v.t)) {
      altoAsiaHoy = Math.max(altoAsiaHoy, v.h);
      bajoAsiaHoy = Math.min(bajoAsiaHoy, v.l);
    }
  }
  return out;
}

/**
 * ¿Esta el precio CERCA de alguna zona relevante? Distancia en multiplos de ATR.
 *
 * Se mide en ATR y no en pips para que el criterio signifique lo mismo en EURUSD que en GBPJPY:
 * 10 pips son mucho en uno y nada en el otro.
 */
export function cercaDeZona(
  precio: number,
  z: Zonas,
  swingsCerca: number[],
  atrActual: number,
  maxAtr = 0.5,
): { cerca: boolean; cuantas: number } {
  if (!(atrActual > 0)) return { cerca: false, cuantas: 0 };
  const niveles = [z.diaPrevioAlto, z.diaPrevioBajo, z.asiaAlto, z.asiaBajo, ...swingsCerca].filter(
    (x): x is number => x != null && x > 0,
  );
  const cuantas = niveles.filter((n) => Math.abs(precio - n) / atrActual <= maxAtr).length;
  return { cerca: cuantas > 0, cuantas };
}
