/**
 * INVARIANTES SOBRE CADA OPERACION. Sin agente, sin criterio, sin opinion.
 *
 * POR QUE UNA INVARIANTE Y NO UN AGENTE QUE REVISE
 * -----------------------------------------------
 * Un agente que "revise las operaciones" depende de que se acuerde de mirar, de que mire lo
 * correcto y de que interprete bien lo que ve. Las tres cosas fallan en silencio. Una invariante
 * no puede olvidarse: corre en cada pasada, no opina, y falla sola.
 *
 * Las de aqui suenan tontas —¿existio ese precio?, ¿la salida fue despues de la entrada?— y tres
 * de los nueve fallos de este proyecto las habrian violado. El hueco de apertura, en concreto:
 * se cobraba el nivel del stop cuando la vela habia ABIERTO ya pasada de el, y a ese nivel no te
 * llena nadie.
 *
 * QUE NO HACE
 * -----------
 * No dice si una estrategia es buena. Dice si los numeros que salen de ella son POSIBLES. Es
 * mucho menos ambicioso y mucho mas util: una estrategia mala con numeros correctos se descarta
 * en un minuto, y una buena con numeros imposibles se puede creer durante meses.
 *
 * SE AUDITA LO GRABADO, NO SOLO LO SIMULADO
 * -----------------------------------------
 * Vale para las dos cosas, pero donde importa es en el registro hacia adelante: un backtest roto
 * se descubre volviendolo a correr, y un registro roto no, porque no hay con que compararlo hasta
 * dentro de meses.
 */
import type { Vela } from "./datos";

export interface OperacionAuditable {
  par: string;
  direccion: "LARGO" | "CORTO";
  entrada: number;
  /** El stop INICIAL, el que fija el riesgo. Si hay trailing, no es el nivel de la salida. */
  stop: number;
  /** Solo si la estrategia tiene objetivo fijo. Con trailing no lo hay. */
  objetivo?: number;
  salida: number;
  /**
   * Si la salida fue ADVERSA (stop o trailing) o a favor (objetivo).
   *
   * No es un detalle: al nivel de salida se llega desde lados opuestos segun cual sea, y la
   * comprobacion del hueco depende de eso. Un largo que sale en el objetivo abre POR DEBAJO de
   * el —viene subiendo— y confundirlo con un hueco haria saltar la alarma en cada ganadora.
   *
   * Obligatorio a proposito: quien grabe una operacion sabe cual de las dos fue, y dejarlo
   * opcional invita a olvidarlo justo donde importa.
   */
  adversa: boolean;
  /**
   * El riesgo con el que se dimensiono, cuando no es simplemente |entrada - stop|.
   *
   * Hace falta porque hay dos convenciones y las dos son defendibles: medir la R contra el
   * riesgo PLANEADO —el que se conocia al mandar la orden, y sobre el que se calculo el tamaño—
   * o contra el que resulta del llenado real. Deducirlo siempre de los precios daba 25 falsas
   * alarmas sobre un backtest correcto, porque un llenado con hueco mejora la entrada y encoge
   * la distancia al stop DESPUES de haber dimensionado la posicion.
   */
  riesgo?: number;
  /** Resultado declarado en multiplos del riesgo, ya con costes. */
  r: number;
  /** Resultado sin costes, si el grabador lo guarda. Es el que tiene que cuadrar exacto. */
  rBruto?: number;
  tSeñal: number;
  tEntrada: number;
  /** Vela en la que se cerro. Opcional: hay registros que no lo apuntaban. */
  tSalida?: number;
}

export type Regla =
  | "SALIDA_IMPOSIBLE"
  | "ENTRADA_IMPOSIBLE"
  | "SALIDA_ANTES_DE_ENTRAR"
  | "SEÑAL_DESPUES_DE_ENTRAR"
  | "STOP_DEL_LADO_MALO"
  | "OBJETIVO_DEL_LADO_MALO"
  | "RIESGO_CERO"
  | "R_NO_CUADRA"
  | "COSTE_NEGATIVO"
  | "HUECO_NO_COBRADO"
  | "SIN_VELAS";

export interface Anomalia {
  par: string;
  tEntrada: number;
  regla: Regla;
  detalle: string;
}

/**
 * Tolerancia relativa al comparar un precio con el rango de su vela.
 *
 * No es cosmetica: las fuentes redondean cada campo por separado, y un objetivo calculado en
 * doble precision cae a 1e-13 del maximo con toda normalidad. Sin tolerancia, la invariante
 * gritaria en operaciones sanas y se dejaria de leer, que es la unica forma de que no sirva.
 */
const TOL = 1e-9;

const dentro = (v: Vela, precio: number): boolean =>
  precio >= v.l - TOL * Math.abs(v.l) && precio <= v.h + TOL * Math.abs(v.h);

/**
 * Audita una operacion contra las velas que de verdad existieron.
 *
 * `velas` es la serie del instrumento. Si falta la vela de entrada o la de salida no se inventa
 * nada ni se calla: se anota, porque una operacion cuyas velas no existen es exactamente el tipo
 * de cosa que hay que mirar.
 */
export function auditarUna(op: OperacionAuditable, velas: Vela[]): Anomalia[] {
  const out: Anomalia[] = [];
  const anota = (regla: Regla, detalle: string): void => {
    out.push({ par: op.par, tEntrada: op.tEntrada, regla, detalle });
  };
  const largo = op.direccion === "LARGO";
  const riesgo = op.riesgo ?? Math.abs(op.entrada - op.stop);

  // ---- 1. Lo que se comprueba sin mirar el mercado -----------------------------------------
  if (op.tSalida !== undefined && op.tSalida <= op.tEntrada) {
    anota("SALIDA_ANTES_DE_ENTRAR", `salida ${op.tSalida} no es posterior a la entrada ${op.tEntrada}`);
  }
  if (op.tSeñal >= op.tEntrada) {
    anota("SEÑAL_DESPUES_DE_ENTRAR", `señal ${op.tSeñal} no es anterior a la entrada ${op.tEntrada}`);
  }
  if (largo ? op.stop >= op.entrada : op.stop <= op.entrada) {
    anota("STOP_DEL_LADO_MALO", `${op.direccion} con entrada ${op.entrada} y stop ${op.stop}`);
  }
  if (op.objetivo !== undefined && (largo ? op.objetivo <= op.entrada : op.objetivo >= op.entrada)) {
    anota("OBJETIVO_DEL_LADO_MALO", `${op.direccion} con entrada ${op.entrada} y objetivo ${op.objetivo}`);
  }

  // ---- 2. La aritmetica de la R -------------------------------------------------------------
  if (!(riesgo > 0)) {
    // Sin riesgo no hay R: dividir entre cero da Infinity, y un Infinity destruye la media.
    anota("RIESGO_CERO", `entrada y stop coinciden en ${op.entrada}`);
  } else {
    const bruto = (largo ? op.salida - op.entrada : op.entrada - op.salida) / riesgo;
    if (op.rBruto !== undefined && Math.abs(op.rBruto - bruto) > 1e-6) {
      anota(
        "R_NO_CUADRA",
        `rBruto declarado ${op.rBruto.toFixed(6)} y los precios dan ${bruto.toFixed(6)}`,
      );
    }
    // El coste solo puede EMPEORAR el resultado. Una R neta mejor que la bruta es imposible, y
    // es justo lo que pasa cuando se resta el coste con el signo cambiado.
    if (op.r > bruto + 1e-9) {
      anota(
        "COSTE_NEGATIVO",
        `declara ${op.r.toFixed(6)}R neto sobre ${bruto.toFixed(6)}R bruto: el coste suma en vez de restar`,
      );
    }
    // Y un coste de mas de 1R merece mirarse. Casi siempre es un error de contabilidad, pero no
    // siempre: con un stop mas estrecho que el propio spread, el peaje SE COME el riesgo entero
    // y la operacion es real aunque no sea jugable. Medido en divergencias de 5m, pasa en 3 de
    // 776. Se avisa igual, porque una operacion asi no la manda nadie y conviene verla.
    if (op.r < bruto - 1) {
      anota(
        "R_NO_CUADRA",
        `declara ${op.r.toFixed(6)}R sobre ${bruto.toFixed(6)}R bruto: el coste se lleva mas de 1R`,
      );
    }
  }

  // ---- 3. Lo que necesita las velas ---------------------------------------------------------
  if (velas.length === 0) {
    anota("SIN_VELAS", "no hay serie con la que comprobar los precios");
    return out;
  }

  const vEntrada = velas.find((v) => v.t === op.tEntrada);
  if (!vEntrada) {
    anota("ENTRADA_IMPOSIBLE", `no existe vela en ${op.tEntrada}`);
  } else if (!dentro(vEntrada, op.entrada)) {
    anota(
      "ENTRADA_IMPOSIBLE",
      `entrada ${op.entrada} fuera de [${vEntrada.l}, ${vEntrada.h}] de su vela`,
    );
  }

  if (op.tSalida === undefined) return out;
  const vSalida = velas.find((v) => v.t === op.tSalida);
  if (!vSalida) {
    anota("SALIDA_IMPOSIBLE", `no existe vela en ${op.tSalida}`);
    return out;
  }
  if (!dentro(vSalida, op.salida)) {
    anota(
      "SALIDA_IMPOSIBLE",
      `salida ${op.salida} fuera de [${vSalida.l}, ${vSalida.h}] de su vela`,
    );
  }

  // EL HUECO DE APERTURA. Si la vela de salida ABRIO ya pasada del precio al que se dice haber
  // salido, ese precio no llego a existir despues: te llenan en la apertura, peor. Es el fallo
  // que valia el 13,4% del resultado en cripto diario.
  //
  // Solo tiene sentido en las salidas ADVERSAS. A una salida a favor se llega desde el otro lado,
  // y un hueco que se pasa del objetivo llena MEJOR, no peor. Ese caso lo cubre `dentro`: si el
  // precio grabado se lo salto el hueco, es que no existio, y da igual hacia donde.
  //
  // Se compara contra la SALIDA, no contra el stop inicial: con trailing el nivel de salida se
  // ha movido, y comparar con el inicial dejaria pasar justo los casos que importan.
  const abrioPasada = largo ? vSalida.o < op.salida : vSalida.o > op.salida;
  if (op.adversa && abrioPasada) {
    anota(
      "HUECO_NO_COBRADO",
      `la vela abrio en ${vSalida.o} y se cobra la salida en ${op.salida}: ese precio ya no existia`,
    );
  }

  return out;
}

export interface Auditoria {
  operaciones: number;
  anomalias: Anomalia[];
  /** Cuantas de cada regla: distingue de un vistazo un caso suelto de un patron. */
  porRegla: Record<string, number>;
}

export function auditar(
  ops: OperacionAuditable[],
  velasDe: (par: string) => Vela[] | undefined,
): Auditoria {
  const anomalias: Anomalia[] = [];
  for (const op of ops) anomalias.push(...auditarUna(op, velasDe(op.par) ?? []));
  const porRegla: Record<string, number> = {};
  for (const a of anomalias) porRegla[a.regla] = (porRegla[a.regla] ?? 0) + 1;
  return { operaciones: ops.length, anomalias, porRegla };
}

/**
 * El informe.
 *
 * Cuando todo esta bien dice UNA linea. Un aviso que sale largo cada vez deja de leerse, y una
 * invariante que no se lee es una invariante que no existe.
 */
export function informeAuditoria(a: Auditoria): string {
  if (a.anomalias.length === 0) {
    return `AUDITORIA · ${a.operaciones} operaciones · todos los precios son posibles.`;
  }
  const l = [`AUDITORIA · ${a.operaciones} operaciones · ${a.anomalias.length} ANOMALIAS`];
  for (const [regla, n] of Object.entries(a.porRegla).sort((x, y) => y[1] - x[1])) {
    l.push(`   ${regla.padEnd(24)}${String(n).padStart(5)}`);
  }
  l.push("");
  for (const x of a.anomalias.slice(0, 10)) {
    const cuando = new Date(x.tEntrada * 1000).toISOString().slice(0, 16);
    l.push(`   ${x.par.padEnd(12)}${cuando}  ${x.regla}: ${x.detalle}`);
  }
  if (a.anomalias.length > 10) l.push(`   ... y ${a.anomalias.length - 10} mas`);
  return l.join("\n");
}
