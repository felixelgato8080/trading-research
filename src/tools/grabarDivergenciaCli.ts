/**
 * Graba las divergencias de RSI hacia adelante. Sin dinero, sin ordenes, sin exchange.
 *
 *   npm run grabar:divergencia -- --registro=RUTA.json --modo=video|4h1h [--costebps=0.6]
 *
 * DOS MODOS, PORQUE CONTESTAN PREGUNTAS DISTINTAS
 * ----------------------------------------------
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
 * En los dos: regla estricta (el segundo pico del RSI ni se asoma al canal), entrada limitada en
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
  const pares = (txt("pares") ?? PARES.join(",")).split(",").filter(Boolean);
  const costeBps = num("costebps", 0.6);
  const modo = txt("modo") ?? "video";
  if (modo !== "video" && modo !== "4h1h") {
    console.error("--modo tiene que ser 'video' (15m/5m) o '4h1h'");
    process.exitCode = 1;
    return;
  }
  // En 4h1h solo se baja 1h: Yahoo no sirve 4h, asi que se agrega desde el 1h. La apertura es
  // la de la primera vela del bloque y el cierre el de la ultima, que es lo que hace falta.
  const tfMenor: Temporalidad = modo === "video" ? "5m" : "1h";
  const tfMayor: Temporalidad | null = modo === "video" ? "15m" : null;
  const bloque4h = (t0: number): string => {
    const d = new Date(t0 * 1000);
    return `${d.toISOString().slice(0, 10)}_${Math.floor(d.getUTCHours() / 4)}`;
  };

  const zona: AjustesSMC = {
    minHueco: 0.2, minEmpuje: 1, vigencia: 60, esperaBloque: 20, colchon: 0.1,
    objetivoR: 2, radioLiquidez: 0.5, toquesLiquidez: 3, memoriaHuecos: 50,
  };
  // LOS MISMOS AJUSTES EN LOS DOS MODOS: solo cambia la temporalidad.
  //
  // Y son los del video, no los que mejor salieron. En 15m/5m el objetivo de liquidez es
  // justamente la PEOR de las cuatro variantes (-0,33R contra -0,25R del objetivo fijo). Se
  // deja asi a proposito: el modo `video` existe para comprobar si el backtest miente, y para
  // eso tiene que ser fiel a lo que se cuenta, no a lo que a mi me sale mejor.
  const ajustes: Ajustes = {
    modo,
    div: {
      periodoRsi: 14, confirmacion: 2, umbralAlto: 70,
      minSeparacion: 3, maxSeparacion: 60, exigirFueraDelCanal: true,
    },
    ent: {
      zona, esperaZona: 40, esperaEntrada: 60, colchon: 0.1,
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

  const arranque = reg.pasadas === 0;
  const { registro, resumen } = pasada(reg, menores, proveedor, ahora);


  if (existsSync(ruta)) copyFileSync(ruta, `${ruta}.bak`);
  writeFileSync(ruta, JSON.stringify(registro, null, 2));

  // ---- Informe -------------------------------------------------------------------------------
  console.log(`GRABADOR DIVERGENCIAS · pasada ${registro.pasadas} · ${ahora.slice(0, 16)}`);
  console.log(
    `${menores.size} pares · modo ${modo} · divergencia en ` +
      `${modo === "video" ? "15m, entrada en 5m" : "4h, entrada en 1h"} · ` +
      `coste ${costeBps} pb · objetivo en la liquidez anterior`,
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
