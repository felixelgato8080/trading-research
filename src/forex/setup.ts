/**
 * La estrategia completa: H1 marca el sesgo, M15 la zona, M5 la entrada.
 *
 * Cada componente se puede ENCENDER Y APAGAR por separado, y eso no es comodidad: es el
 * experimento. Solo apagando el RSI y comparando se puede saber si aporta algo, y lo mismo con
 * el barrido de liquidez, la zona o la ruptura de estructura.
 *
 * La regla de la casa: un indicador es una hipotesis hasta que una comparacion diga otra cosa.
 *
 * Todo puro. Ninguna funcion usa velas posteriores al indice que recibe.
 */
import type { Vela } from "./datos";
import { rsi } from "./rsi";
import { ema, atr } from "./multiTf";
import {
  swings,
  swingsDisponibles,
  barridoLiquidez,
  rupturaEstructura,
  zonasPorVela,
  cercaDeZona,
  type Swing,
} from "./estructura";

export interface Componentes {
  /** Exigir que H1 este alineado (EMA20>EMA50 y precio encima para largos). */
  sesgoH1: boolean;
  /** Exigir que el precio este cerca de una zona relevante. */
  zona: boolean;
  /** Exigir RSI en extremo y recuperandolo. */
  rsi: boolean;
  /** Exigir barrido de liquidez con recuperacion. */
  barrido: boolean;
  /** Exigir ruptura del micro-swing. */
  estructura: boolean;
}

export const TODOS: Componentes = {
  sesgoH1: true,
  zona: true,
  rsi: true,
  barrido: false,
  estructura: true,
};

export interface Parametros {
  periodoRsi: number;
  sobreventa: number;
  sobrecompra: number;
  /** EMAs del sesgo en H1. */
  emaRapida: number;
  emaLenta: number;
  /** Velas a cada lado para confirmar un swing en M5. */
  nSwing: number;
  /** Distancia maxima a una zona, en multiplos de ATR. */
  maxAtrZona: number;
  /** Ventana de velas hacia atras para buscar el barrido. */
  ventanaBarrido: number;
  /**
   * Velas dentro de las que las condiciones previas siguen valiendo.
   *
   * ESTO NO ES UN AJUSTE, ES LA DIFERENCIA ENTRE QUE FUNCIONE O NO. El spec describe una
   * SECUENCIA —pullback, barrido, RSI reclaim, rechazo, ruptura— pero implementada como
   * conjuncion en la misma vela produce CERO operaciones en 2,8 años y 4 pares: exige que dos
   * eventos puntuales coincidan en el mismo minuto. Con ventana, el RSI recupera y la
   * estructura rompe despues, que es como se opera de verdad.
   */
  ventanaSecuencia: number;
}

export const PARAMETROS: Parametros = {
  periodoRsi: 14,
  sobreventa: 30,
  sobrecompra: 70,
  emaRapida: 20,
  emaLenta: 50,
  nSwing: 2,
  maxAtrZona: 0.5,
  ventanaBarrido: 20,
  ventanaSecuencia: 12,
};

export interface SetupDetectado {
  i: number;
  direccion: "LARGO" | "CORTO";
  /** Puntuacion 0-10 segun el spec. */
  puntos: number;
  cumplidas: string[];
  /** ATR en la vela de la señal, para dimensionar el stop. */
  atr: number;
  /** Hora UTC, para el analisis por sesion. */
  hora: number;
}

/**
 * Alinea cada vela de M5 con la ultima vela de H1 ya CERRADA.
 * Repetido de multiTf a proposito para que este modulo sea autonomo y facil de auditar.
 */
function alinearCerradas(chica: Vela[], grande: Vela[]): (number | null)[] {
  const out: (number | null)[] = new Array(chica.length).fill(null);
  if (grande.length < 2) return out;
  const saltos = grande.slice(1).map((v, i) => v.t - grande[i]!.t).sort((a, b) => a - b);
  const dur = saltos[Math.floor(saltos.length / 2)] ?? 3600;
  let j = 0;
  for (let i = 0; i < chica.length; i += 1) {
    while (j + 1 < grande.length && grande[j + 1]!.t + dur <= chica[i]!.t) j += 1;
    out[i] = grande[j]!.t + dur <= chica[i]!.t ? j : null;
  }
  return out;
}

/**
 * Detecta setups sobre M5. Pura.
 *
 * PUNTUACION (spec §10): sesgo H1 +2, zona +2, barrido +2, RSI +1, estructura +2, sesion +1.
 * Los componentes apagados no suman ni exigen nada: asi la puntuacion sigue siendo comparable
 * entre variantes, y "sin RSI" no queda penalizado por no tenerlo.
 */
export function detectar(
  m5: Vela[],
  h1: Vela[],
  comp: Componentes = TODOS,
  par: Parametros = PARAMETROS,
): SetupDetectado[] {
  const cierres5 = m5.map((v) => v.c);
  const rsi5 = rsi(cierres5, par.periodoRsi);
  const atr5 = atr(m5, 14);
  const ss = swings(m5, par.nSwing);
  const zonas = zonasPorVela(m5);

  const cierresH1 = h1.map((v) => v.c);
  const emaR = ema(cierresH1, par.emaRapida);
  const emaL = ema(cierresH1, par.emaLenta);
  const aH1 = alinearCerradas(m5, h1);

  const out: SetupDetectado[] = [];

  for (let i = 1; i < m5.length; i += 1) {
    const a = atr5[i];
    if (a == null || !(a > 0)) continue;

    for (const direccion of ["LARGO", "CORTO"] as const) {
      const cumplidas: string[] = [];
      let puntos = 0;

      // --- sesgo H1 (+2) ---
      if (comp.sesgoH1) {
        const j = aH1[i];
        if (j == null) continue;
        const r = emaR[j];
        const l = emaL[j];
        if (r == null || l == null) continue;
        const alcista = h1[j]!.c > r && r > l;
        const bajista = h1[j]!.c < r && r < l;
        if (direccion === "LARGO" && !alcista) continue;
        if (direccion === "CORTO" && !bajista) continue;
        puntos += 2;
        cumplidas.push("sesgo H1");
      }

      // --- RSI recuperado en las ultimas `ventanaSecuencia` velas (+1) ---
      //
      // Se mira hacia atras, no solo la vela actual: el RSI recupera primero y la estructura
      // rompe despues. Exigir las dos a la vez da cero operaciones.
      if (comp.rsi) {
        let hubo = false;
        for (let k = Math.max(1, i - par.ventanaSecuencia); k <= i; k += 1) {
          const hoy = rsi5[k];
          const ayer = rsi5[k - 1];
          if (hoy == null || ayer == null) continue;
          if (direccion === "LARGO" && ayer < par.sobreventa && hoy >= par.sobreventa) hubo = true;
          if (direccion === "CORTO" && ayer > par.sobrecompra && hoy <= par.sobrecompra) hubo = true;
          if (hubo) break;
        }
        if (!hubo) continue;
        puntos += 1;
        cumplidas.push("RSI reclaim");
      }

      // --- zona relevante, tocada en las ultimas `ventanaSecuencia` velas (+2) ---
      //
      // El pullback llega a la zona y DESPUES rompe; exigir que la ruptura ocurra dentro de la
      // zona es contradictorio, porque romper es justo alejarse de ella.
      if (comp.zona) {
        const niveles = swingsDisponibles(ss, i)
          .filter((s: Swing) => s.i >= i - 100)
          .map((s) => s.precio);
        let mejorCuantas = 0;
        for (let k = Math.max(0, i - par.ventanaSecuencia); k <= i; k += 1) {
          const z = cercaDeZona(m5[k]!.c, zonas[k]!, niveles, a, par.maxAtrZona);
          if (z.cuantas > mejorCuantas) mejorCuantas = z.cuantas;
        }
        if (mejorCuantas === 0) continue;
        puntos += 2;
        cumplidas.push(`zona x${mejorCuantas}`);
      }

      // --- barrido de liquidez en las ultimas `ventanaSecuencia` velas (+2) ---
      if (comp.barrido) {
        let hubo = false;
        for (let k = Math.max(0, i - par.ventanaSecuencia); k <= i; k += 1) {
          if (barridoLiquidez(m5, k, ss, par.ventanaBarrido, direccion).hubo) {
            hubo = true;
            break;
          }
        }
        if (!hubo) continue;
        puntos += 2;
        cumplidas.push("barrido");
      }

      // --- ruptura de estructura (+2) ---
      if (comp.estructura) {
        if (!rupturaEstructura(m5, i, ss, direccion)) continue;
        puntos += 2;
        cumplidas.push("ruptura");
      }

      // --- sesion (+1): Londres o Nueva York ---
      const hora = new Date(m5[i]!.t * 1000).getUTCHours();
      if (hora >= 7 && hora < 22) {
        puntos += 1;
        cumplidas.push("sesion");
      }

      out.push({ i, direccion, puntos, cumplidas, atr: a, hora });
    }
  }
  return out;
}
