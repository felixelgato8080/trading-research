/**
 * La estrategia de day trading con conceptos de smart money, programada tal como se cuenta.
 *
 * LA CADENA DE DECISION, que es lo unico que el video concreta de verdad
 * ---------------------------------------------------------------------
 *   1. Existe un ORDER BLOCK: la primera vela de las tres que dejan un hueco (FVG).
 *   2. El precio CIERRA al otro lado de ese order block -> cambio de caracter.
 *   3. ...salvo VETO. Dos, y son la unica pieza nueva de todo el metodo.
 *   4. Nace un order block nuevo en la direccion contraria.
 *   5. Orden limitada en ese order block, stop al otro lado.
 *
 * LOS DOS VETOS, Y POR QUE SE MIRAN SOLO HACIA LA IZQUIERDA
 * --------------------------------------------------------
 * El video dice que una rotura no vale si el nivel estaba sobre una bolsa de liquidez, o si
 * habia un hueco sin rellenar por debajo. Y lo ilustra DESPUES: si el precio giro era cambio de
 * caracter, si siguio era un barrido. Una regla que explica los dos resultados no predice
 * ninguno.
 *
 * Aqui los dos vetos se evaluan en el instante de la rotura y SOLO con lo que habia a la
 * izquierda: cuantos minimos previos se apilaban en ese nivel, y si quedaba algun hueco sin
 * rellenar mas alla. Las dos cosas son visibles antes. Asi la regla se puede comprobar, que era
 * la condicion para poder operarla.
 *
 * LO QUE HAY QUE FIJAR, y se fija ANTES de ver ningun resultado
 * ------------------------------------------------------------
 * El video no da un solo numero. Elegir estos despues de ver el resultado seria hacer trampa.
 */
import type { Vela } from "./datos";

export type Lado = "ALCISTA" | "BAJISTA";

export interface Hueco {
  /** Vela central de las tres. */
  i: number;
  /** Antes de esta vela el hueco no se puede saber: se cierra en `i + 1`. */
  conocidoEn: number;
  lado: Lado;
  alto: number;
  bajo: number;
}

/**
 * Huecos de valor razonable (FVG): tres velas donde la primera y la tercera no se tocan.
 *
 * El hueco de la vela `i` NO se conoce hasta que cierra `i + 1`, y ese es el campo `conocidoEn`.
 * Usarlo antes seria leer una vela que aun no existe.
 */
export function huecos(velas: Vela[], minimo: number, atrValores: (number | null)[]): Hueco[] {
  const out: Hueco[] = [];
  for (let i = 1; i < velas.length - 1; i += 1) {
    const a = velas[i - 1]!;
    const c = velas[i + 1]!;
    const escala = atrValores[i];
    if (escala == null || !(escala > 0)) continue;
    if (c.l > a.h && c.l - a.h >= escala * minimo) {
      out.push({ i, conocidoEn: i + 1, lado: "ALCISTA", alto: c.l, bajo: a.h });
    } else if (a.l > c.h && a.l - c.h >= escala * minimo) {
      out.push({ i, conocidoEn: i + 1, lado: "BAJISTA", alto: a.l, bajo: c.h });
    }
  }
  return out;
}

export interface Bloque {
  /** La vela del bloque: la PRIMERA de las tres que dejan el hueco. */
  i: number;
  conocidoEn: number;
  lado: Lado;
  alto: number;
  bajo: number;
  /** Cuanto se alejo el precio del bloque, en ATR. Es la "distancia de empuje". */
  empuje: number;
}

export interface AjustesSMC {
  /** Hueco minimo para contar como ineficiencia, en ATR. */
  minHueco: number;
  /** Empuje minimo del impulso, en ATR. */
  minEmpuje: number;
  /** Velas que un bloque sigue vivo. */
  vigencia: number;
  /** Tras el cambio de caracter, cuantas velas se espera al bloque nuevo. */
  esperaBloque: number;
  /** Colchon del stop mas alla del bloque, en fraccion de su altura. */
  colchon: number;
  /** Objetivo en multiplos del riesgo. */
  objetivoR: number;
  /** Radio para considerar que varios minimos son el mismo nivel, en ATR. */
  radioLiquidez: number;
  /** Minimos previos apilados que hacen sospechosa una rotura. */
  toquesLiquidez: number;
  /** Hasta cuantas velas atras se busca un hueco sin rellenar. */
  memoriaHuecos: number;
  /** Velas a cada lado que confirman un minimo o maximo estructural. */
  confirmacionSwing?: number;
  /** Si false, se opera sin los dos vetos. Existe para medir cuanto aportan. */
  aplicarVetos?: boolean;
}

/**
 * Order blocks: la primera vela de las tres que dejan el hueco.
 *
 * El video lo dice asi — "la primera vela que crea el hueco" — porque la decision que provoco el
 * movimiento se tomo ahi dentro. El empuje se mide hasta el extremo de la tercera vela, que es
 * lo unico conocido cuando el bloque se conoce.
 */
export function bloques(
  velas: Vela[],
  atrValores: (number | null)[],
  aj: AjustesSMC,
): Bloque[] {
  const out: Bloque[] = [];
  for (const h of huecos(velas, aj.minHueco, atrValores)) {
    const base = velas[h.i - 1];
    const fin = velas[h.i + 1];
    const escala = atrValores[h.i];
    if (!base || !fin || escala == null || !(escala > 0)) continue;
    const empuje = h.lado === "ALCISTA"
      ? (fin.h - base.l) / escala
      : (base.h - fin.l) / escala;
    if (empuje < aj.minEmpuje) continue;
    out.push({
      i: h.i - 1, conocidoEn: h.conocidoEn, lado: h.lado,
      alto: base.h, bajo: base.l, empuje,
    });
  }
  return out;
}

/**
 * VETO 1: el nivel roto estaba sobre una bolsa de liquidez.
 *
 * "Bolsa de liquidez" son MINIMOS IGUALES apilados: sitios donde otros entraron y dejaron el
 * stop justo debajo. Se cuentan minimos ESTRUCTURALES, no velas que pasaron cerca.
 *
 * La distincion no es cosmetica. Contando cualquier vela dentro del radio, el veto rechazaba el
 * 96% de las roturas en forex 1h: eso no es un filtro, es un muro, y no puede separar nada.
 *
 * Un minimo de la vela j solo esta confirmado cuando han cerrado `confirmacion` velas a su
 * derecha, asi que solo cuentan los que ya lo estaban antes de la rotura.
 */
export function hayLiquidez(
  velas: Vela[], hasta: number, nivel: number, radio: number,
  minToques: number, memoria: number, confirmacion = 2,
): boolean {
  let toques = 0;
  const desde = Math.max(confirmacion, hasta - memoria);
  for (let i = desde; i + confirmacion <= hasta - 1; i += 1) {
    const v = velas[i]!;
    if (Math.abs(v.l - nivel) > radio && Math.abs(v.h - nivel) > radio) continue;
    let esMin = true;
    let esMax = true;
    // ESTRICTAMENTE menor que sus vecinos. Si los empates contaran, en un tramo lateral todas
    // las velas serian minimo y cualquier rango pareceria una bolsa de liquidez.
    for (let k = i - confirmacion; k <= i + confirmacion; k += 1) {
      if (k === i || k < 0 || k >= velas.length) continue;
      if (velas[k]!.l <= v.l) esMin = false;
      if (velas[k]!.h >= v.h) esMax = false;
    }
    if (esMin || esMax) toques += 1;
  }
  return toques >= minToques;
}

/**
 * VETO 2: quedaba un hueco sin rellenar al otro lado.
 *
 * Si al romper hacia abajo hay un hueco alcista sin rellenar por debajo, el precio puede estar
 * yendo a rellenarlo y no girando. Solo cuentan huecos ya CONOCIDOS antes de la rotura.
 */
export function huecoPendiente(
  velas: Vela[], hs: Hueco[], hasta: number, direccion: Lado, memoria: number,
): boolean {
  const precio = velas[hasta]!.c;
  for (const h of hs) {
    if (h.conocidoEn > hasta) continue;
    if (hasta - h.i > memoria) continue;
    // Un hueco relleno ya no atrae: se mira si el precio paso por el entre medias.
    let relleno = false;
    for (let j = h.conocidoEn; j <= hasta; j += 1) {
      const v = velas[j]!;
      if (v.l <= h.bajo && v.h >= h.alto) { relleno = true; break; }
    }
    if (relleno) continue;
    // Rompiendo hacia abajo, estorba un hueco que queda por DEBAJO del precio.
    if (direccion === "BAJISTA" && h.alto < precio) return true;
    if (direccion === "ALCISTA" && h.bajo > precio) return true;
  }
  return false;
}

export interface Rotura {
  /** Vela en la que se confirma la rotura. */
  i: number;
  /** Hacia donde pasa el control. */
  direccion: Lado;
  /** El bloque que se rompio. */
  bloque: Bloque;
  vetada: boolean;
  motivoVeto: "LIQUIDEZ" | "HUECO" | null;
}

/**
 * Cambios de caracter: el precio CIERRA al otro lado de un order block vivo.
 *
 * Cerrar, no pinchar con la mecha. Y el bloque tiene que estar ya conocido y no caducado.
 */
export function roturas(
  velas: Vela[], bs: Bloque[], hs: Hueco[], atrValores: (number | null)[], aj: AjustesSMC,
): Rotura[] {
  const out: Rotura[] = [];
  const gastados = new Set<Bloque>();
  for (let i = 1; i < velas.length; i += 1) {
    const v = velas[i]!;
    const escala = atrValores[i];
    if (escala == null || !(escala > 0)) continue;
    for (const b of bs) {
      if (gastados.has(b) || b.conocidoEn > i || i - b.i > aj.vigencia) continue;
      const rompeAbajo = b.lado === "ALCISTA" && v.c < b.bajo;
      const rompeArriba = b.lado === "BAJISTA" && v.c > b.alto;
      if (!rompeAbajo && !rompeArriba) continue;
      gastados.add(b);
      const direccion: Lado = rompeAbajo ? "BAJISTA" : "ALCISTA";
      const nivel = rompeAbajo ? b.bajo : b.alto;

      let motivoVeto: Rotura["motivoVeto"] = null;
      if (aj.aplicarVetos !== false) {
        if (hayLiquidez(
          velas, i, nivel, escala * aj.radioLiquidez, aj.toquesLiquidez, aj.memoriaHuecos,
          aj.confirmacionSwing ?? 2,
        )) {
          motivoVeto = "LIQUIDEZ";
        } else if (huecoPendiente(velas, hs, i, direccion, aj.memoriaHuecos)) {
          motivoVeto = "HUECO";
        }
      }
      out.push({ i, direccion, bloque: b, vetada: motivoVeto !== null, motivoVeto });
    }
  }
  return out;
}

export interface SeñalSMC {
  i: number;
  direccion: "LARGO" | "CORTO";
  entrada: number;
  stop: number;
  objetivo: number;
  rr: number;
}

/**
 * Las señales: tras una rotura no vetada, el primer bloque nuevo en la direccion nueva, y
 * entrada limitada cuando el precio vuelve a el.
 *
 * Cada rotura da como mucho una operacion. Reentrar en el mismo bloque diez veces inflaria la
 * muestra con la misma decision repetida.
 */
export function señales(
  velas: Vela[], atrValores: (number | null)[], aj: AjustesSMC,
): SeñalSMC[] {
  const hs = huecos(velas, aj.minHueco, atrValores);
  const bs = bloques(velas, atrValores, aj);
  const out: SeñalSMC[] = [];

  for (const r of roturas(velas, bs, hs, atrValores, aj)) {
    if (r.vetada) continue;
    // El bloque nuevo tiene que nacer DESPUES de la rotura y en la direccion nueva.
    const nuevo = bs.find(
      (b) => b.lado === r.direccion && b.conocidoEn > r.i && b.conocidoEn - r.i <= aj.esperaBloque,
    );
    if (!nuevo) continue;

    const altura = nuevo.alto - nuevo.bajo;
    if (!(altura > 0)) continue;
    const largo = r.direccion === "ALCISTA";
    const entrada = largo ? nuevo.alto : nuevo.bajo;
    const stop = largo
      ? nuevo.bajo - altura * aj.colchon
      : nuevo.alto + altura * aj.colchon;
    const riesgo = Math.abs(entrada - stop);
    if (!(riesgo > 0)) continue;
    const objetivo = largo ? entrada + riesgo * aj.objetivoR : entrada - riesgo * aj.objetivoR;

    // La vuelta al bloque, desde que el bloque se conoce.
    for (
      let j = nuevo.conocidoEn + 1;
      j < Math.min(velas.length, nuevo.conocidoEn + 1 + aj.vigencia);
      j += 1
    ) {
      const v = velas[j]!;
      const toca = largo ? v.l <= entrada : v.h >= entrada;
      if (!toca) continue;
      out.push({
        i: j, direccion: largo ? "LARGO" : "CORTO", entrada, stop, objetivo, rr: aj.objetivoR,
      });
      break;
    }
  }
  return out;
}

export interface ResultadoParcial {
  r: number;
  motivo: "STOP" | "PARCIAL_Y_STOP" | "PARCIAL_Y_OBJETIVO" | "OBJETIVO" | "TIEMPO";
  /** Recorrido neto en precio, con signo. Para poder contarlo en pips. */
  precio: number;
}

/**
 * Simula con SALIDA PARCIAL, que es lo que el video propone y no habiamos probado.
 *
 *   - Se cierra `fraccion` de la posicion al llegar a `rParcial`.
 *   - El stop del resto se mueve a la entrada (a partir de ahi no se puede perder).
 *   - El resto corre hasta `rObjetivo`.
 *
 * POR QUE PUEDE CAMBIAR ALGO
 * --------------------------
 * No cambia la direccion de ninguna operacion, cambia la FORMA del pago: sube mucho el acierto
 * (cualquier operacion que toque 1R ya cierra en verde una parte) a cambio de recortar la cola.
 * Como el acierto era justo lo que se pedia, hay que medirlo en vez de suponerlo.
 *
 * Convenciones de siempre: el stop gana los empates, y en la vela de entrada solo vale el
 * extremo hacia el que iba el precio al llenarse.
 */
export function simularParcial(
  velas: Vela[],
  s: SeñalSMC,
  coste: number,
  maxVelas: number,
  fraccion: number,
  rParcial: number,
  rObjetivo: number,
): ResultadoParcial | null {
  const largo = s.direccion === "LARGO";
  const riesgo = Math.abs(s.entrada - s.stop);
  if (!(riesgo > 0)) return null;

  const nivelParcial = largo ? s.entrada + riesgo * rParcial : s.entrada - riesgo * rParcial;
  const nivelObjetivo = largo ? s.entrada + riesgo * rObjetivo : s.entrada - riesgo * rObjetivo;
  let stop = s.stop;
  let cobrado = 0;
  let cerradoParcial = false;

  for (let j = s.i; j < velas.length; j += 1) {
    const v = velas[j]!;
    const primera = j === s.i;
    // En la vela de entrada solo vale el extremo del viaje: para un largo que se llena cayendo,
    // el minimo. El maximo de esa vela ya habia ocurrido.
    const usaMin = !primera || largo;
    const usaMax = !primera || !largo;

    const tocaStop = largo ? usaMin && v.l <= stop : usaMax && v.h >= stop;
    if (tocaStop) {
      const restoR = (largo ? stop - s.entrada : s.entrada - stop) / riesgo;
      const r = cobrado + (1 - (cerradoParcial ? fraccion : 0)) * restoR - coste / riesgo;
      return {
        r, motivo: cerradoParcial ? "PARCIAL_Y_STOP" : "STOP",
        precio: r * riesgo,
      };
    }
    if (!cerradoParcial) {
      const tocaParcial = largo ? usaMax && v.h >= nivelParcial : usaMin && v.l <= nivelParcial;
      if (tocaParcial) {
        cobrado = fraccion * rParcial;
        cerradoParcial = true;
        stop = s.entrada;   // el resto ya no puede perder
      }
    }
    const tocaObjetivo = largo ? usaMax && v.h >= nivelObjetivo : usaMin && v.l <= nivelObjetivo;
    if (tocaObjetivo && cerradoParcial) {
      const r = cobrado + (1 - fraccion) * rObjetivo - coste / riesgo;
      return { r, motivo: "PARCIAL_Y_OBJETIVO", precio: r * riesgo };
    }
    if (tocaObjetivo && !cerradoParcial) {
      const r = rObjetivo - coste / riesgo;
      return { r, motivo: "OBJETIVO", precio: r * riesgo };
    }
    if (maxVelas > 0 && j - s.i >= maxVelas) {
      const restoR = (largo ? v.c - s.entrada : s.entrada - v.c) / riesgo;
      const r = cobrado + (1 - (cerradoParcial ? fraccion : 0)) * restoR - coste / riesgo;
      return { r, motivo: "TIEMPO", precio: r * riesgo };
    }
  }
  return null;
}
