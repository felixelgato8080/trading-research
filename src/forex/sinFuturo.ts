/**
 * COMPROBAR QUE UNA ESTRATEGIA NO MIRA AL FUTURO.
 *
 * POR QUE ESTO EXISTE
 * -------------------
 * De los nueve fallos de medicion encontrados en este proyecto, CINCO fueron look-ahead. Cada uno
 * cambiaba un numero y varios sobrevivieron semanas de revision. Es, con diferencia, la forma mas
 * cara de equivocarse aqui.
 *
 * Y la prueba que los caza es siempre la misma: correr la estrategia sobre un prefijo y comprobar
 * que las señales que produjo siguen ahi, identicas, cuando llegan mas velas. Si una señal cambia
 * o desaparece al conocer el futuro, es que dependia de el.
 *
 * Estaba escrita a mano en 6 de 15 modulos. Los otros nueve —incluida la ruptura de volatilidad,
 * que es la que corre en produccion— no la tenian.
 *
 * LA PROPIEDAD, con precision
 * ---------------------------
 * `señales(velas[0..n])` tiene que ser un SUBCONJUNTO EXACTO de `señales(velas)`. La serie
 * completa puede traer señales nuevas, de velas posteriores; lo que no puede es cambiar ni
 * borrar una que ya se habia emitido.
 *
 * Se comparan todos los campos, no solo el indice: una entrada o un stop que se recalculan al
 * conocer el futuro son igual de graves que una señal que aparece de la nada.
 */
import type { Vela } from "./datos";

/** Lo minimo que se le pide a una señal para poder compararla. */
export interface ConIndice {
  i: number;
}

export interface Violacion {
  /** Vela hasta la que se corto la serie. */
  corte: number;
  /** Indice de la señal afectada. */
  senal: number;
  motivo: "DESAPARECE" | "CAMBIA";
  /** Que decia con el prefijo y que dice con la serie entera. */
  conPrefijo: string;
  conTodo: string;
}

const clave = (s: ConIndice): string =>
  JSON.stringify(s, Object.keys(s as object).sort());

/**
 * Corre la estrategia sobre varios prefijos y devuelve las violaciones encontradas.
 *
 * Devuelve una lista en vez de lanzar para que quien llame decida: en una prueba se afirma que
 * esta vacia, y en una herramienta se puede imprimir el detalle.
 *
 * Los cortes se reparten por la serie en vez de probarlos todos: recorrer las 2.000 velas de
 * cada instrumento multiplicaria el coste por mil sin encontrar nada que estos no encuentren.
 */
export function violaciones<T extends ConIndice>(
  velas: Vela[],
  señales: (v: Vela[]) => T[],
  cortes = 12,
): Violacion[] {
  const out: Violacion[] = [];

  // SE INDEXA POR CONTENIDO, NO POR INDICE DE VELA.
  //
  // La primera version usaba un `Map` con la vela como clave, y varias señales pueden caer en la
  // MISMA vela: dos divergencias distintas pueden entrar a la vez. El mapa se quedaba con la
  // ultima y comparaba objetos que no se correspondian, dando 32 alarmas falsas sobre una
  // estrategia que estaba bien.
  const conocidas = new Set<string>();
  const porVela = new Map<number, string[]>();
  for (const s of señales(velas)) {
    conocidas.add(clave(s));
    porVela.set(s.i, [...(porVela.get(s.i) ?? []), clave(s)]);
  }

  const minimo = Math.min(60, Math.floor(velas.length / 2));
  for (let k = 1; k <= cortes; k += 1) {
    const n = minimo + Math.floor(((velas.length - minimo) * k) / (cortes + 1));
    if (n <= minimo || n >= velas.length) continue;

    for (const s of señales(velas.slice(0, n))) {
      if (conocidas.has(clave(s))) continue;
      const enEsaVela = porVela.get(s.i);
      out.push({
        corte: n, senal: s.i,
        // Si la vela sigue produciendo alguna señal, la de antes CAMBIO; si no, DESAPARECIO.
        motivo: enEsaVela?.length ? "CAMBIA" : "DESAPARECE",
        conPrefijo: clave(s),
        conTodo: enEsaVela?.join(" | ") ?? "(no existe)",
      });
    }
  }
  return out;
}

/**
 * Una serie de velas deterministica para las pruebas.
 *
 * Camino aleatorio con semilla: da tendencias, huecos, mechas y laterales sin que nadie los haya
 * elegido. Un escenario escrito a mano solo prueba los casos que a uno se le ocurrieron, y el
 * look-ahead suele esconderse justo en los que no.
 */
export function serieDePrueba(n: number, semilla = 12345): Vela[] {
  let s = semilla >>> 0;
  const rnd = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const out: Vela[] = [];
  let precio = 100;
  for (let i = 0; i < n; i += 1) {
    // CON HUECOS. La primera version abria siempre en el cierre anterior, asi que las
    // estrategias de hueco no encontraban NADA y sus pruebas pasaban sin probar nada.
    const hueco = rnd() < 0.08 ? (rnd() - 0.5) * 4 : 0;
    const o = Math.max(1, precio + hueco);
    // Una cola gorda de vez en cuando: los fallos de look-ahead se ven en las velas grandes.
    const salto = (rnd() - 0.5) * (rnd() < 0.05 ? 8 : 1.5);
    const c = Math.max(1, o + salto);
    const mecha = rnd() * 0.8;
    out.push({
      t: i * 3600,
      o,
      h: Math.max(o, c) + mecha,
      l: Math.max(0.5, Math.min(o, c) - mecha),
      c,
      v: 1000 + Math.floor(rnd() * 9000),
    });
    precio = c;
  }
  return out;
}

/**
 * La comprobacion DURA: cada señal tiene que sobrevivir a cortar la serie en su propia vela.
 *
 * POR QUE HACE FALTA ADEMAS DE `violaciones`
 * -----------------------------------------
 * El test de prefijos caza las señales que CAMBIAN al llegar mas datos. No caza una estrategia
 * que lea siempre una vela por delante, porque al cortar la serie esa vela sigue estando ahi:
 * el resultado es identico con prefijo y con todo, y aun asi es tramposa.
 *
 * Esto lo cierra: si la señal de la vela `i` se decidio de verdad con lo que habia hasta `i`,
 * tiene que seguir apareciendo cuando la serie termina EXACTAMENTE en `i`.
 *
 * CUANDO NO SE PUEDE USAR
 * -----------------------
 * Solo vale si el indice de la señal es la vela de DECISION. Hay estrategias cuyo indice es la
 * vela donde se FORMA algo que no se sabe hasta despues —un hueco de tres velas se conoce al
 * cerrar la tercera, no la del medio— y ahi esta comprobacion daria una alarma falsa. Esas
 * llevan su propio campo (`conocidoEn`) y se comprueban con `violaciones`.
 */
export function violacionesEstrictas<T extends ConIndice>(
  velas: Vela[],
  señales: (v: Vela[]) => T[],
  maximo = 25,
): Violacion[] {
  const out: Violacion[] = [];
  const todas = señales(velas);
  // Se reparten por la serie en vez de coger las primeras: las primeras suelen caer donde los
  // indicadores aun no tienen datos y no prueban gran cosa.
  const paso = Math.max(1, Math.floor(todas.length / maximo));
  for (let k = 0; k < todas.length; k += paso) {
    const s = todas[k]!;
    if (s.i < 2 || s.i >= velas.length) continue;
    // Por contenido, no por indice: en una misma vela puede haber mas de una señal.
    const recortada = señales(velas.slice(0, s.i + 1));
    if (recortada.some((x) => clave(x) === clave(s))) continue;
    const enEsaVela = recortada.filter((x) => x.i === s.i).map(clave);
    out.push({
      corte: s.i + 1, senal: s.i,
      motivo: enEsaVela.length ? "CAMBIA" : "DESAPARECE",
      conPrefijo: enEsaVela.join(" | ") || "(no existe)",
      conTodo: clave(s),
    });
  }
  return out;
}
