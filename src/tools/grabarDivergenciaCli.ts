/**
 * Graba las divergencias de RSI hacia adelante. Sin dinero, sin ordenes, sin exchange.
 *
 *   npm run grabar:divergencia -- --registro=RUTA.json --modo=video|4h1h|afinado
 *
 * TRES MODOS, PORQUE CONTESTAN PREGUNTAS DISTINTAS
 * -----------------------------------------------
 * `video`: divergencia en 15m y entrada en 5m, objetivo en la liquidez anterior. Fiel a como se
 * cuenta. El histórico dice que esto PIERDE: -0,279R sobre 783 operaciones, y en EURUSD —el par
 * que el video usa— -0,667R con un 9% de acierto. Se graba igual, y a proposito: si el registro
 * sale plano o positivo, significa que MI BACKTEST ESTA ROTO, y eso valdria mas que la
 * estrategia. Es una prueba de falsacion, no una apuesta.
 *
 * `4h1h`: la misma logica en 4h con entrada en 1h. Es lo unico con borde real que encontre:
 * +0,193R sobre 2.250 operaciones, 4,6 sigma sobre el azar, mitades del calendario +0,184 y
 * +0,202. Su problema no es la señal sino el tamaño de posicion: recogerla pedia 109x de
 * exposicion. El registro dira si la señal se sostiene fuera de muestra.
 *
 `afinado`: la MISMA señal, con las tres cosas que salieron de medir — solo los cuatro pares que
 * se mueven lo suficiente para que el spread no se coma el riesgo, colchon del stop a 1 en vez
 * de 0,1, y objetivo fijo en 1,5R en vez de la liquidez anterior. Medido sobre 440 operaciones:
 * 50% de acierto y +0,113R con 1,9 sigma. Es la primera configuracion positiva sobre muestra
 * grande de todo el proyecto, y por eso se graba: para ver si aguanta fuera de muestra.
 *
 * En los tres: regla estricta (el segundo pico del RSI ni se asoma al canal), entrada limitada en
 * el hueco u order block, stop tras la zona con colchon.
 *
 * QUE SABEMOS YA, Y POR QUE SE GRABA IGUAL
 * ---------------------------------------
 * En 15m/5m el histórico da un borde BRUTO de +0,135R (3,5 sigma, 20 de 28 pares, mitades
 * +0,138 y +0,132) que el peaje se come entero: -0,254R con coste. La señal es real; lo que
 * falla es la economia.
 *
 * Se graba de todas formas por dos razones que el histórico no puede cubrir:
 *
 *   1. El coste que use es una SUPOSICION. El spread real, a las horas reales, con los
 *      llenados reales, solo se sabe operando. Si el peaje verdadero es la mitad del que
 *      supuse, la conclusion cambia.
 *   2. Si el backtest tiene un fallo estructural que no he visto —van nueve en este proyecto—
 *      solo aparece comparando el registro contra lo que el backtest predice para las MISMAS
 *      señales.
 *
 * Lo que NO va a contestar: si el borde es de 0,13R, haria falta del orden de 300 operaciones
 * para distinguirlo. El grabador lo dice en cada pasada.
 *
 * EL ESTADO VIVE FUERA DE CUALQUIER CONTENEDOR.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { velas as bajarVelas, type Vela, type Temporalidad } from "../forex/datos";
import { agregar } from "../forex/agregar";
import { rsi } from "../forex/rsi";
import { atr } from "../forex/multiTf";
import { auditar, informeAuditoria } from "../forex/auditor";
import { deForex } from "../forex/auditables";
import {
  señales, type AjustesDivergencia, type AjustesEntrada,
} from "../forex/divergencia";
import type { AjustesSMC } from "../forex/smc";
import {
  registroNuevo, pasada, balance, mismosAjustes, muestraNecesaria,
  VERSION_GRABADOR, type Registro, type Proveedor,
} from "../forex/grabador";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
function num(n: string, d: number): number {
  const m = txt(n);
  if (m === undefined) return d;
  const v = Number(m);
  return Number.isFinite(v) ? v : d;
}

const PARES = [
  "EURUSD=X", "GBPUSD=X", "USDJPY=X", "USDCHF=X", "AUDUSD=X", "USDCAD=X", "NZDUSD=X",
  "EURJPY=X", "EURGBP=X", "GBPJPY=X", "AUDJPY=X", "CADJPY=X",
];

interface Ajustes {
  /** Va DENTRO de los ajustes para que el grabador se niegue a mezclar modos en un registro. */
  modo: string;
  div: AjustesDivergencia;
  ent: AjustesEntrada;
}

async function main(): Promise<void> {
  const ruta = txt("registro");
  if (!ruta) {
    console.error("Falta --registro=RUTA.json (ponla FUERA de cualquier contenedor)");
    process.exitCode = 1;
    return;
  }
  const ahora = new Date().toISOString();
  // LOS CUATRO QUE SE MUEVEN. Su ATR de 5m va de 7,7 a 12,1 pips, asi que un spread de 0,6
  // pesa entre el 5% y el 8% del riesgo. En GBPUSD (2,8), NZDUSD (1,8) y AUDUSD (1,5) pesaria
  // el 20-40%, y por eso salen: no es que su señal sea peor, es que ahi no cabe el peaje.
  // CADJPY tiene ATR de 6,2 y aun asi se queda fuera, por lo contrario: su señal no vale
  // (-0,063R el solo, y 0% de acierto en las 5 que lleva grabadas en vivo).
  const AFINADO = ["USDJPY=X", "GBPJPY=X", "EURJPY=X", "AUDJPY=X"];
  const porDefecto = (txt("modo") ?? "video") === "afinado" ? AFINADO : PARES;
  const pares = (txt("pares") ?? porDefecto.join(",")).split(",").filter(Boolean);
  const costeBps = num("costebps", 0.6);
  const modo = txt("modo") ?? "video";
  if (modo !== "video" && modo !== "4h1h" && modo !== "afinado") {
    console.error("--modo tiene que ser 'video' (15m/5m), '4h1h' o 'afinado'");
    process.exitCode = 1;
    return;
  }
  // En 4h1h solo se baja 1h: Yahoo no sirve 4h, asi que se agrega desde el 1h. La apertura es
  // la de la primera vela del bloque y el cierre el de la ultima, que es lo que hace falta.
  const tfMenor: Temporalidad = modo === "4h1h" ? "1h" : "5m";
  const tfMayor: Temporalidad | null = modo === "4h1h" ? null : "15m";
  const bloque4h = (t0: number): string => {
    const d = new Date(t0 * 1000);
    return `${d.toISOString().slice(0, 10)}_${Math.floor(d.getUTCHours() / 4)}`;
  };

  // EL COLCHON DEL STOP, que es lo unico que cambia entre `video` y `afinado`.
  //
  // En `video` va a 0,1 porque es lo que se cuenta. En `afinado` va a 1 porque es lo que se
  // midio: el stop pasa de 5,3 a 9,4 pips y el peaje del spread del 22% al 13% del riesgo. No
  // cambia el R:R —el objetivo se mide en R, asi que se aleja igual— solo el peso del coste.
  const colchon = modo === "afinado" ? 1 : 0.1;

  const zona: AjustesSMC = {
    minHueco: 0.2, minEmpuje: 1, vigencia: 60, esperaBloque: 20, colchon,
    objetivoR: 2, radioLiquidez: 0.5, toquesLiquidez: 3, memoriaHuecos: 50,
  };

  // `video` y `4h1h` graban los ajustes DEL VIDEO, no los que mejor salieron. En 15m/5m el
  // objetivo de liquidez es justamente la peor de las cuatro variantes. Se deja asi a proposito:
  // esos registros existen para comprobar si el backtest miente, y para eso tienen que ser
  // fieles a lo que se cuenta.
  //
  // `afinado` es lo contrario: la configuracion que salio de medir, y que solo cambia tres cosas
  // sobre la del video. Las tres tienen motivo mecanico, no salieron de mirar quien gano:
  //
  //   PARES      solo los que se mueven. El spread es fijo en pips y el stop sale del tamaño de
  //              la zona, asi que en un par con ATR de 1,5 pips el peaje se come el 30% del
  //              riesgo hagas lo que hagas. Medido en vivo: quitar los cuatro pares lentos sube
  //              el acierto del 26% al 48%.
  //   COLCHON 1  el mismo argumento por el otro lado: stop mas ancho, peaje mas pequeño.
  //   OBJETIVO   fijo en 1,5R en vez de la liquidez anterior. El objetivo de liquidez unas veces
  //              queda mas lejos de donde llega el precio y otras corta ganadoras antes de
  //              tiempo; un multiplo del riesgo no tiene ese problema. Y 1,5R es donde la
  //              medida es mas solida: 50% de acierto, +0,113R, 1,9 sigma sobre 440 operaciones.
  //
  // La esperanza es PLANA entre 0,75R y 3R —todos positivos, ninguno distinguible del otro— asi
  // que el objetivo no decide si se gana: decide la forma de la curva. Se elige 1,5R porque con
  // 50% de acierto las rachas malas son cortas, y una estrategia que se abandona en la racha
  // mala tiene esperanza cero por muy buena que sea su aritmetica.
  const ajustes: Ajustes = {
    modo,
    div: {
      periodoRsi: 14, confirmacion: 2, umbralAlto: 70,
      minSeparacion: 3, maxSeparacion: 60, exigirFueraDelCanal: true,
    },
    ent: modo === "afinado"
      ? {
        zona, esperaZona: 40, esperaEntrada: 60, colchon,
        stop: "ZONA", objetivo: "FIJO", objetivoR: 1.5, rrMinimo: 0, minRiesgoAtr: 0.5,
      }
      : {
        zona, esperaZona: 40, esperaEntrada: 60, colchon,
        stop: "ZONA", objetivo: "LIQUIDEZ", objetivoR: 2, rrMinimo: 1, minRiesgoAtr: 0.5,
      },
  };

  let reg: Registro<Ajustes>;
  if (existsSync(ruta)) {
    reg = JSON.parse(readFileSync(ruta, "utf-8")) as Registro<Ajustes>;
    if (reg.version !== VERSION_GRABADOR) {
      console.error(`El registro es version ${reg.version} y este grabador es ${VERSION_GRABADOR}.`);
      process.exitCode = 1;
      return;
    }
    if (!mismosAjustes(reg.ajustes, ajustes) || reg.costeBps !== costeBps) {
      console.error(
        "LOS AJUSTES NO COINCIDEN con los del registro. Cambiarlos a mitad invalida la\n" +
          "comparacion entera: lo grabado hasta ahora seria de otra estrategia. Si de verdad\n" +
          "quieres otros ajustes, empieza un registro nuevo en otro fichero.",
      );
      process.exitCode = 1;
      return;
    }
  } else {
    reg = registroNuevo("divergencia", ahora, ajustes, costeBps, ajustes.ent.esperaEntrada);
    console.log(`Registro nuevo en ${ruta}\n`);
  }

  // ---- Descarga: hacen falta las DOS temporalidades ----------------------------------------
  const menores = new Map<string, Vela[]>();
  const mayores = new Map<string, Vela[]>();
  let fallos = 0;
  let primerFallo = "";
  for (const p of pares) {
    try {
      const men = await bajarVelas(p, tfMenor);
      let may: Vela[];
      if (tfMayor) {
        await dormir(300);
        may = await bajarVelas(p, tfMayor);
      } else {
        may = agregar(men, bloque4h);
      }
      if (may.length > 300 && men.length > 300) {
        mayores.set(p, may);
        menores.set(p, men);
      } else {
        fallos += 1;
        if (!primerFallo) primerFallo = `${p}: ${may.length} mayores, ${men.length} menores`;
      }
    } catch (e) {
      fallos += 1;
      if (!primerFallo) primerFallo = `${p}: ${e instanceof Error ? e.message : String(e)}`;
    }
    await dormir(300);
  }
  if (fallos > 0) console.error(`Primer fallo de descarga → ${primerFallo}`);
  if (menores.size < pares.length / 2) {
    console.error(`Solo ${menores.size} de ${pares.length} descargas. No se toca el registro.`);
    process.exitCode = 1;
    return;
  }

  // El grabador recorre la temporalidad MENOR, que es donde se entra. La mayor entra por la
  // clausura: `señales` ya se encarga de no mirar velas de 5m anteriores al cierre de la de 15m.
  const proveedor: Proveedor = (par, velas5) => {
    const m15 = mayores.get(par);
    if (!m15) return [];
    return señales(
      m15, rsi(m15.map((v) => v.c), ajustes.div.periodoRsi),
      velas5, atr(velas5, 14),
      ajustes.div, ajustes.ent,
    );
  };

  // EL RSI MAYOR EN EL INSTANTE DEL LLENADO, apuntado en cada operacion que se abra.
  //
  // No filtra nada: la estrategia grabada sigue siendo exactamente la misma. Es una MEDIDA que
  // se guarda para poder contestar despues, sobre el registro vivo, una pregunta que aparecio
  // el 12 sep y que en el histórico da esto sobre las 440 operaciones de `afinado`:
  //
  //     RSI mayor AUN sin cruzar 50 al llenarse   249 ops   55%   +0,228R   2,9σ
  //     RSI mayor YA cruzado                      191 ops   43%   -0,068R  -0,8σ
  //
  // Va al reves de lo que se cuenta por ahi —la linea 50 como "confirmacion de momento"— y por
  // eso es creible: esta señal es de VUELTA, asi que si el momento ya giro, la vuelta ya paso y
  // se esta comprando el retroceso de un movimiento hecho. Aguanta las dos mitades del
  // calendario, tres de los cuatro pares (en USDJPY no aparece), las dos direcciones, y sale
  // p=0,027 en permutacion corrigiendo por los tres umbrales que se probaron. No es el retraso
  // del llenado disfrazado: la correlacion entre ambos es 0,028 y el efecto sigue dentro de
  // cada tramo de espera.
  //
  // POR QUE SE APUNTA EN VEZ DE APLICARSE. Cambiar los ajustes invalidaria el registro entero, y
  // la medida de arriba es EN MUESTRA: salio de mirar las mismas 440 operaciones que eligieron
  // esta configuracion. Apuntando el numero, dentro de dos meses la division se hace sobre
  // operaciones que nadie habia visto, emparejadas una a una, sin gastar una muestra nueva.
  const rsiMayores = new Map<string, (number | null)[]>();
  for (const [par, may] of mayores) {
    rsiMayores.set(par, rsi(may.map((v) => v.c), ajustes.div.periodoRsi));
  }
  const marcador = (par: string, tEntrada: number): number | undefined => {
    const may = mayores.get(par);
    const rs = rsiMayores.get(par);
    if (!may || !rs) return undefined;
    // La ultima vela mayor CERRADA antes de la entrada. La que esta en curso no se conoce.
    let j = -1;
    for (let k = 0; k + 1 < may.length; k += 1) {
      if (may[k + 1]!.t <= tEntrada) j = k;
      else break;
    }
    return j >= 0 ? rs[j] ?? undefined : undefined;
  };

  const arranque = reg.pasadas === 0;
  const { registro, resumen } = pasada(reg, menores, proveedor, ahora, marcador);


  if (existsSync(ruta)) copyFileSync(ruta, `${ruta}.bak`);
  writeFileSync(ruta, JSON.stringify(registro, null, 2));

  // ---- Informe -------------------------------------------------------------------------------
  console.log(`GRABADOR DIVERGENCIAS · pasada ${registro.pasadas} · ${ahora.slice(0, 16)}`);
  // El informe se describe a si mismo a partir de los AJUSTES, no de una cadena escrita a mano.
  // Cuando se añadio el modo `afinado`, la version a mano siguio diciendo "4h, entrada en 1h" y
  // "objetivo en la liquidez" sobre un registro de 15m/5m con objetivo fijo. Un informe que
  // describe mal lo que hace es peor que no tenerlo: se lee y se cree.
  console.log(
    `${menores.size} pares · modo ${modo} · divergencia en ` +
      `${tfMayor ?? "4h"}, entrada en ${tfMenor} · coste ${costeBps} pb · ` +
      `colchon ${ajustes.ent.colchon} · objetivo ` +
      `${ajustes.ent.objetivo === "FIJO" ? `fijo ${ajustes.ent.objetivoR}R` : "en la liquidez anterior"}`,
  );
  if (arranque) {
    console.log(
      "\nPRIMERA PASADA: solo se marca por donde va cada par, sin apuntar nada.\n" +
        "El registro cuenta desde ahora hacia adelante, que es lo unico que no se puede\n" +
        "contaminar. A partir de la proxima pasada empieza a apuntar señales.",
    );
  } else {
    console.log(
      `\n${resumen.nuevas} señal(es) nueva(s) · ${resumen.abiertas} abierta(s) · ` +
        `${resumen.cerradas} cerrada(s) · ${resumen.caducadas} caducada(s)`,
    );
  }

  for (const [etq, lista] of [
    ["Esperando entrada", registro.pendientes],
    ["Abiertas", registro.abiertas],
  ] as const) {
    if (!lista.length) continue;
    console.log(`\n${etq} (${lista.length}):`);
    for (const p of lista.slice(0, 8)) {
      console.log(
        `  ${p.par.padEnd(10)}${p.direccion.padEnd(7)}entrada ${p.entrada.toFixed(5)} · ` +
          `stop ${p.stop.toFixed(5)} · objetivo ${p.objetivo.toFixed(5)} · ${p.rr.toFixed(1)}R`,
      );
    }
  }

  const b = balance(registro.cerradas);
  if (b.n > 0) {
    const hacenFalta = muestraNecesaria(b);
    console.log(
      `\nCERRADAS: ${b.n} · acierto ${(b.aciertos * 100).toFixed(0)}% · ` +
        `R:R medio ${b.rrMedio.toFixed(1)} · PF ${b.pf.toFixed(2)} · ` +
        `${b.esperanza.toFixed(3)}R ±${b.error.toFixed(3)}`,
    );
    console.log(
      Number.isFinite(hacenFalta)
        ? `Para distinguir esa esperanza del cero harian falta ~${hacenFalta.toLocaleString("es")}` +
          ` operaciones. Llevas ${b.n}.`
        : "Aun no hay con que estimar nada.",
    );
    // LA LINEA QUE VALE ES LA ESTRICTA. Una operacion apuntada cuando su entrada YA habia
    // ocurrido no falsea ningun precio —la entrada es una orden limitada cuyo nivel sale de la
    // vela de la señal— pero tampoco prueba nada hacia adelante, que es para lo que existe este
    // registro. Se separan en vez de mezclarse.
    const estrictas = registro.cerradas.filter((c) => c.velasDeRetraso === 0);
    const be = balance(estrictas);
    console.log(
      be.n > 0
        ? `   ESTRICTAS: ${be.n} · acierto ${(be.aciertos * 100).toFixed(0)}% · ` +
          `PF ${be.pf.toFixed(2)} · ${be.esperanza.toFixed(3)}R ±${be.error.toFixed(3)}`
        : "   ESTRICTAS: 0. TODAS se apuntaron con velas posteriores ya cerradas, asi que " +
          "de momento esto no es una prueba hacia adelante sino un backtest con retraso.",
    );
    const retrasos = registro.cerradas
      .map((c) => c.velasDeRetraso)
      .filter((x): x is number => x != null);
    if (retrasos.length && be.n < b.n) {
      const medio = retrasos.reduce((x, y) => x + y, 0) / retrasos.length;
      console.log(
        `   Retraso al apuntar: ${medio.toFixed(1)} velas de media, ${Math.max(...retrasos)} la peor.`,
      );
    }
    // LA PREGUNTA ABIERTA, contestada con lo que lleve marcado. Solo cuentan las operaciones
    // que se abrieron despues del 12 sep: las anteriores no tienen `marca` y meterlas como si
    // fueran de un lado seria decidir por ellas.
    const marcadas = registro.cerradas.filter((c) => c.marca != null);
    if (marcadas.length >= 10) {
      const sinCruzar = marcadas.filter((c) =>
        c.direccion === "LARGO" ? c.marca! <= 50 : c.marca! >= 50);
      const cruzado = marcadas.filter((c) => !sinCruzar.includes(c));
      const bs = balance(sinCruzar);
      const bc = balance(cruzado);
      console.log(
        `\n   LA LINEA 50 (fuera de muestra, ${marcadas.length} de ${b.n} con marca):\n` +
          `      RSI mayor SIN cruzar al llenarse: ${bs.n} · ` +
          `${(bs.aciertos * 100).toFixed(0)}% · ${bs.esperanza.toFixed(3)}R ±${bs.error.toFixed(3)}\n` +
          `      RSI mayor YA cruzado:             ${bc.n} · ` +
          `${(bc.aciertos * 100).toFixed(0)}% · ${bc.esperanza.toFixed(3)}R ±${bc.error.toFixed(3)}`,
      );
      console.log(
        "      En el histórico la brecha fue +0,296R a favor de 'sin cruzar'. Haran falta del\n" +
          "      orden de 150 marcadas por lado para que esto diga algo.",
      );
    }
    if (b.n < 100) {
      console.log("Con menos de 100 cerradas este numero es ruido. No decidas nada con el.");
    }
  }

  // ---- LA AUDITORIA. Corre en cada pasada, sobre TODO lo cerrado, no solo lo de hoy. ---------
  //
  // Sobre todo porque un fallo introducido hoy puede volver imposibles operaciones grabadas hace
  // meses, y auditar solo lo nuevo dejaria pasar justo eso. Cuesta milisegundos.
  const auditoria = auditar(registro.cerradas.map(deForex), (p) => menores.get(p));
  console.log(informeAuditoria(auditoria));
  if (auditoria.anomalias.length > 0) {
    console.error(
      "HAY OPERACIONES IMPOSIBLES EN EL REGISTRO. No es una advertencia de estilo: alguno de " +
        "los precios de arriba no existio nunca, asi que el resultado que salga de aqui no vale.",
    );
    process.exitCode = 1;
  }

  console.log(`\nGuardado en ${ruta}. No se ha enviado ninguna orden a ningun sitio.`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
