/**
 * GRABADOR HACIA ADELANTE, generico. Sin dinero, sin ordenes, sin exchange.
 *
 * POR QUE UNO SOLO Y NO UNO POR ESTRATEGIA
 * ---------------------------------------
 * La disciplina que hace creible un registro son cuatro reglas finas y faciles de romper sin
 * darse cuenta. Tener dos copias de esa logica es la forma segura de que una de las dos se
 * quede atras cuando se corrija un fallo en la otra.
 *
 * LAS CUATRO REGLAS, y sin ellas esto no vale nada
 * -----------------------------------------------
 *   1. La señal se apunta PENDIENTE con entrada, stop y objetivo YA fijados, antes de que el
 *      precio llegue. La entrada es una orden limitada: se sabe de antemano.
 *   2. Un precio apuntado NO se reescribe jamas. Si la fuente revisa una vela vieja se respeta
 *      lo grabado. Reescribir la historia con datos corregidos es la forma mas facil de
 *      fabricar un buen resultado sin darse cuenta.
 *   3. La PRIMERA vez que se ve un instrumento solo se marca por donde va. Si no, el registro
 *      naceria lleno de señales cuya ventana caduco hace meses, y eso no seria una prueba hacia
 *      adelante sino otro backtest disfrazado.
 *   4. Los ajustes se guardan y no pueden cambiar. Cambiarlos a mitad mezcla dos estrategias en
 *      un mismo registro y lo invalida entero.
 *
 * Se graban TODAS las señales, sin tope de posiciones, para juntar muestra cuanto antes. El
 * efecto del tope se simula despues sobre las cerradas, con `simularCartera`, que ya esta
 * probado.
 */
import type { Vela } from "./datos";

export const VERSION_GRABADOR = 2;

/** Lo minimo que el grabador necesita de una señal, venga de la estrategia que venga. */
export interface SeñalGrabable {
  /** Indice en la serie de velas. */
  i: number;
  direccion: "LARGO" | "CORTO";
  entrada: number;
  stop: number;
  objetivo: number;
  /** Multiplo del riesgo que paga el objetivo. Varia por señal cuando el objetivo es un nivel. */
  rr: number;
}

export interface Pendiente {
  par: string;
  direccion: "LARGO" | "CORTO";
  entrada: number;
  stop: number;
  objetivo: number;
  rr: number;
  /** Momento en que se apunto, antes de que el precio llegara. */
  apuntada: string;
  /** Vela de la señal. Nada anterior o igual a esto puede abrirla. */
  tSeñal: number;
  caducaEn: number;
}

export interface Abierta extends Pendiente {
  abierta: string;
  tEntrada: number;
}

export interface Cerrada extends Abierta {
  cerrada: string;
  salida: number;
  r: number;
  motivo: "STOP" | "OBJETIVO";
  /**
   * Vela que cerro la operacion.
   *
   * `cerrada` es cuando el grabador se ENTERO, que no es lo mismo: si estuvo apagado un fin de
   * semana, se entera el lunes de algo que paso el viernes. Sin este campo no se puede comprobar
   * que el precio de salida existiera de verdad, ni que la salida fuera posterior a la entrada.
   *
   * Opcional porque los registros abiertos antes de que existiera no lo tienen, y reescribirlos
   * ahora seria inventar un dato que en su momento no se guardo.
   */
  tSalida?: number;
}

export interface Registro<A> {
  version: number;
  nombre: string;
  inicio: string;
  ultima: string;
  pasadas: number;
  ajustes: A;
  costeBps: number;
  /** Cuantas velas vive una pendiente antes de caducar. */
  vigencia: number;
  pendientes: Pendiente[];
  abiertas: Abierta[];
  cerradas: Cerrada[];
  /** Ultima vela procesada por instrumento. */
  vistoHasta: Record<string, number>;
  discrepancias: string[];
}

export function registroNuevo<A>(
  nombre: string, ahora: string, ajustes: A, costeBps: number, vigencia: number,
): Registro<A> {
  return {
    version: VERSION_GRABADOR, nombre, inicio: ahora, ultima: ahora, pasadas: 0,
    ajustes, costeBps, vigencia,
    pendientes: [], abiertas: [], cerradas: [], vistoHasta: {}, discrepancias: [],
  };
}

/**
 * Los ajustes tienen que ser identicos toda la vida del registro.
 *
 * Se compara el objeto entero con las claves ordenadas: cualquier diferencia cuenta. Comparar
 * solo "las que importan" invita a que mañana alguien añada una que importa y se olvide.
 */
export function mismosAjustes(a: unknown, b: unknown): boolean {
  const orden = (x: unknown): string =>
    JSON.stringify(x, (_k, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as object).sort(([p], [q]) => p.localeCompare(q)))
        : v);
  return orden(a) === orden(b);
}

export interface Pasada {
  nuevas: number;
  abiertas: number;
  cerradas: number;
  caducadas: number;
}

/** Devuelve las señales conocidas usando SOLO las velas que se le pasan. */
export type Proveedor = (par: string, velas: Vela[]) => SeñalGrabable[];

/**
 * Una pasada. Pura: entran velas, sale el registro nuevo.
 *
 * EL ORDEN: resolver lo abierto -> apuntar lo nuevo -> abrir y caducar pendientes.
 *
 * Apuntar ANTES de abrir es necesario, no un descuido. Si una pasada cubre mas tiempo que la
 * vigencia —porque el grabador estuvo apagado un fin de semana— una señal apuntada al final
 * naceria ya vencida y se quedaria pendiente para siempre.
 *
 * Y es seguro porque lo que protege del futuro no es el orden sino la guarda explicita: una
 * pendiente solo se abre con una vela POSTERIOR a su señal, y una abierta solo se resuelve con
 * velas posteriores a su entrada. Que el resultado de una señal vieja ya haya ocurrido no es
 * mirar el futuro: es que el futuro ya paso.
 */
export function pasada<A>(
  reg: Registro<A>,
  datos: Map<string, Vela[]>,
  proveedor: Proveedor,
  ahora: string,
): { registro: Registro<A>; resumen: Pasada } {
  const r: Registro<A> = {
    ...reg,
    pendientes: [...reg.pendientes],
    abiertas: [...reg.abiertas],
    cerradas: [...reg.cerradas],
    vistoHasta: { ...reg.vistoHasta },
    discrepancias: [...reg.discrepancias],
  };
  const res: Pasada = { nuevas: 0, abiertas: 0, cerradas: 0, caducadas: 0 };

  for (const [par, velas] of datos) {
    // Solo velas CERRADAS: la ultima esta en curso y sus extremos aun pueden cambiar.
    const hasta = velas.length - 2;
    if (hasta < 30) continue;

    if (r.vistoHasta[par] === undefined) {
      r.vistoHasta[par] = velas[hasta]!.t;
      continue;
    }
    const desde = r.vistoHasta[par]!;

    // ---- 1. Resolver lo que ya estaba abierto ---------------------------------------------
    const siguenAbiertas: Abierta[] = [];
    for (const a of r.abiertas) {
      if (a.par !== par) { siguenAbiertas.push(a); continue; }
      let cerrada: Cerrada | null = null;
      for (let i = 0; i <= hasta; i += 1) {
        const c = velas[i]!;
        if (c.t <= a.tEntrada) continue;
        const largo = a.direccion === "LARGO";
        // El stop gana los empates: no se sabe el orden dentro de la vela.
        if (largo ? c.l <= a.stop : c.h >= a.stop) {
          // EL HUECO. Si la vela ABRIO ya pasada del stop, a ese nivel no llena nadie: la orden
          // se dispara en la apertura, peor. Cobrarse el nivel regala la diferencia entera.
          const salida = largo ? Math.min(a.stop, c.o) : Math.max(a.stop, c.o);
          const riesgo = Math.abs(a.entrada - a.stop);
          const r = riesgo > 0
            ? (largo ? salida - a.entrada : a.entrada - salida) / riesgo
            : -1;
          cerrada = { ...a, cerrada: ahora, tSalida: c.t, salida, r, motivo: "STOP" };
          break;
        }
        if (largo ? c.h >= a.objetivo : c.l <= a.objetivo) {
          // El hueco tambien va en esta direccion, y aqui llena MEJOR: una orden limitada de
          // venta en 120 con el mercado abriendo en 130 se ejecuta en 130. Apuntar 120 seria
          // conservador, pero seria un precio que no existio, y eso es justo lo que la auditoria
          // no puede distinguir de un fallo.
          const salida = largo ? Math.max(a.objetivo, c.o) : Math.min(a.objetivo, c.o);
          const riesgo = Math.abs(a.entrada - a.stop);
          const r = riesgo > 0
            ? (largo ? salida - a.entrada : a.entrada - salida) / riesgo
            : a.rr;
          cerrada = { ...a, cerrada: ahora, tSalida: c.t, salida, r, motivo: "OBJETIVO" };
          break;
        }
      }
      if (cerrada) {
        const riesgo = Math.abs(cerrada.entrada - cerrada.stop);
        const coste = (cerrada.entrada * r.costeBps) / 10_000;
        r.cerradas.push({ ...cerrada, r: cerrada.r - coste / riesgo });
        res.cerradas += 1;
      } else {
        siguenAbiertas.push(a);
      }
    }
    r.abiertas = siguenAbiertas;

    // ---- 2. Apuntar lo nuevo ----------------------------------------------------------------
    const paso = velas[1] && velas[0] ? velas[1]!.t - velas[0]!.t : 3600;
    for (const s of proveedor(par, velas.slice(0, hasta + 1))) {
      const c = velas[s.i];
      if (!c || c.t <= desde) continue;
      const yaEsta =
        r.pendientes.some((x) => x.par === par && x.tSeñal === c.t) ||
        r.abiertas.some((x) => x.par === par && x.tSeñal === c.t) ||
        r.cerradas.some((x) => x.par === par && x.tSeñal === c.t);
      if (yaEsta) continue;
      r.pendientes.push({
        par, direccion: s.direccion, entrada: s.entrada, stop: s.stop, objetivo: s.objetivo,
        rr: s.rr, apuntada: ahora, tSeñal: c.t, caducaEn: c.t + paso * r.vigencia,
      });
      res.nuevas += 1;
    }

    // ---- 3. Abrir lo que el precio haya tocado, y caducar lo que no --------------------------
    const siguenPendientes: Pendiente[] = [];
    for (const p of r.pendientes) {
      if (p.par !== par) { siguenPendientes.push(p); continue; }
      let abierta = false;
      for (let i = 0; i <= hasta; i += 1) {
        const c = velas[i]!;
        if (c.t <= p.tSeñal) continue;
        if (c.t > p.caducaEn) break;
        const largo = p.direccion === "LARGO";
        if (largo ? c.l <= p.entrada : c.h >= p.entrada) {
          r.abiertas.push({ ...p, abierta: ahora, tEntrada: c.t });
          res.abiertas += 1;
          abierta = true;
          break;
        }
      }
      if (abierta) continue;
      if (velas[hasta]!.t > p.caducaEn) { res.caducadas += 1; continue; }
      siguenPendientes.push(p);
    }
    r.pendientes = siguenPendientes;

    r.vistoHasta[par] = velas[hasta]!.t;
  }

  r.pasadas += 1;
  r.ultima = ahora;
  return { registro: r, resumen: res };
}

export interface Balance {
  n: number;
  aciertos: number;
  pf: number;
  esperanza: number;
  error: number;
  rrMedio: number;
}

export function balance(cerradas: Cerrada[]): Balance {
  const rs = cerradas.map((c) => c.r);
  if (!rs.length) {
    return { n: 0, aciertos: 0, pf: 0, esperanza: 0, error: 0, rrMedio: 0 };
  }
  const g = rs.filter((x) => x > 0);
  const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  const esperanza = rs.reduce((s, x) => s + x, 0) / rs.length;
  const va = rs.length > 1
    ? rs.reduce((s, x) => s + (x - esperanza) ** 2, 0) / (rs.length - 1)
    : 0;
  return {
    n: rs.length,
    aciertos: g.length / rs.length,
    pf: sp > 0 ? g.reduce((s, x) => s + x, 0) / sp : 0,
    esperanza,
    error: Math.sqrt(va / rs.length),
    rrMedio: cerradas.reduce((s, c) => s + c.rr, 0) / cerradas.length,
  };
}

/**
 * Cuantas operaciones harian falta para distinguir esta esperanza del cero.
 *
 * Existe para no engañarse con el registro: con 20 cerradas cualquier numero es ruido, y
 * conviene tenerlo delante cada vez que se mira.
 */
export function muestraNecesaria(b: Balance, sigmas = 2): number {
  if (b.n < 2 || b.esperanza === 0) return Infinity;
  const sd = b.error * Math.sqrt(b.n);
  return Math.ceil(((sigmas * sd) / Math.abs(b.esperanza)) ** 2);
}
