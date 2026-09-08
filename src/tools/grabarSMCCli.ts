/**
 * Graba las señales SMC hacia adelante. Sin dinero, sin ordenes, sin exchange.
 *
 *   npm run grabar:smc -- --registro=RUTA.json [--pares=EURUSD=X,GBPUSD=X] [--costebps=1]
 *
 * POR QUE ESTO EXISTE, si el historico ya dijo que no
 * ---------------------------------------------------
 * El historico contesta "¿hay borde?" y ya lo contesto: +0,018R brutos sobre 11.916
 * operaciones. Mas datos viejos no van a afinar eso.
 *
 * Lo que NO puede contestar es si el backtest tiene algun fallo estructural que no hemos visto.
 * En este proyecto se han encontrado nueve, y varios sobrevivieron a semanas de revision. La
 * unica prueba que no se puede contaminar es apuntar la señal antes de que el resultado exista.
 *
 * Y hay una cosa que solo se aprende grabando: cuanto se separa el precio grabado del que de
 * verdad habria salido. Eso es lo que decide si un borde de 0,018R vale algo o no.
 *
 * EL ESTADO VIVE FUERA DE CUALQUIER CONTENEDOR. Ya se perdieron 109.800 creditos de Helius en
 * este proyecto por guardar datos dentro de uno que luego se recreo.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { velas as bajarVelas } from "../forex/datos";
import type { Vela } from "../forex/datos";
import type { AjustesSMC } from "../forex/smc";
import { atr as atrDe } from "../forex/multiTf";
import { señales } from "../forex/smc";
import { auditar, informeAuditoria } from "../forex/auditor";
import { deForex } from "../forex/auditables";
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

// Todos los pares que hay, no solo los majors: con impulso de 3 ATR las señales escasean
// (~144 al año entre los 28) y hace falta toda la muestra que se pueda juntar.
const PARES = [
  "EURUSD=X", "GBPUSD=X", "USDJPY=X", "USDCHF=X", "AUDUSD=X", "USDCAD=X", "NZDUSD=X",
  "EURJPY=X", "EURGBP=X", "EURCHF=X", "EURAUD=X", "EURCAD=X", "GBPJPY=X", "GBPCHF=X",
  "GBPAUD=X", "GBPCAD=X", "AUDJPY=X", "AUDNZD=X", "AUDCAD=X", "AUDCHF=X", "CADJPY=X",
  "CADCHF=X", "CHFJPY=X", "NZDJPY=X", "NZDCAD=X", "NZDCHF=X",
];

async function main(): Promise<void> {
  const ruta = txt("registro");
  if (!ruta) {
    console.error("Falta --registro=RUTA.json (ponla FUERA de cualquier contenedor)");
    process.exitCode = 1;
    return;
  }
  const ahora = new Date().toISOString();
  const pares = (txt("pares") ?? PARES.join(",")).split(",").filter(Boolean);
  const costeBps = num("costebps", 1);

  // LA CONFIGURACION QUE SE GRABA, y por que esta y no otra.
  //
  // Salio de barrer el espacio entero, no de elegirla a ojo. Tres cosas apuntaban al mismo
  // sitio: impulso exigente, stop mas ancho y objetivo lejano. En esa region —y solo en esa—
  // los dos vetos empiezan a separar: dejan pasar +0,069R y rechazan -0,106R.
  //
  // NO ESTA DEMOSTRADA. Con 404 operaciones da 0,8 sigma sobre cero y 2,0 sobre el azar, y se
  // encontro probando ~25 configuraciones, asi que parte de eso es la busqueda misma. Por eso
  // se graba hacia adelante en vez de darla por buena: es la unica prueba que no puedo haber
  // contaminado eligiendo.
  //
  // El impulso va a 2,5 y no a 3 a proposito: triplica las señales a cambio de un candidato algo
  // mas flojo. Con 3 ATR harian falta ocho meses para 100 operaciones y eso es demasiado tiempo
  // sin saber nada. Se decidio ANTES de que el registro tuviera nada dentro.
  const ajustes: AjustesSMC = {
    minHueco: 0.2, minEmpuje: 2.5, vigencia: 60, esperaBloque: 20, colchon: 0.5,
    objetivoR: 3, radioLiquidez: 0.5, toquesLiquidez: 3, memoriaHuecos: 50,
  };

  let reg: Registro<AjustesSMC>;
  if (existsSync(ruta)) {
    reg = JSON.parse(readFileSync(ruta, "utf-8")) as Registro<AjustesSMC>;
    if (reg.version !== VERSION_GRABADOR) {
      console.error(`El registro es version ${reg.version} y este grabador es ${VERSION_GRABADOR}.`);
      process.exitCode = 1;
      return;
    }
    if (!mismosAjustes(reg.ajustes, ajustes)) {
      console.error(
        "LOS AJUSTES NO COINCIDEN con los del registro. Cambiarlos a mitad invalida la\n" +
          "comparacion entera: lo grabado hasta ahora seria de otra estrategia. Si de verdad\n" +
          "quieres otros ajustes, empieza un registro nuevo en otro fichero.",
      );
      process.exitCode = 1;
      return;
    }
    if (reg.costeBps !== costeBps) {
      console.error(`El registro se abrio con ${reg.costeBps} pb de coste y ahora pides ${costeBps}.`);
      process.exitCode = 1;
      return;
    }
  } else {
    reg = registroNuevo("smc", ahora, ajustes, costeBps, ajustes.vigencia);
    console.log(`Registro nuevo en ${ruta}\n`);
  }

  // ---- Descarga ---------------------------------------------------------------------------
  const datos = new Map<string, Vela[]>();
  const atrs = new Map<string, (number | null)[]>();
  let fallos = 0;
  let primerFallo = "";
  for (const p of pares) {
    try {
      const v = await bajarVelas(p, "1h");
      if (v.length > 60) {
        datos.set(p, v);
        atrs.set(p, atrDe(v, 14));
      } else {
        fallos += 1;
        if (!primerFallo) primerFallo = `${p}: solo ${v.length} velas`;
      }
    } catch (e) {
      fallos += 1;
      if (!primerFallo) primerFallo = `${p}: ${e instanceof Error ? e.message : String(e)}`;
    }
    await dormir(300);
  }
  if (fallos > 0) console.error(`Primer fallo de descarga → ${primerFallo}`);
  if (datos.size < pares.length / 2) {
    console.error(`Solo ${datos.size} de ${pares.length} descargas. No se toca el registro.`);
    process.exitCode = 1;
    return;
  }

  const arranque = reg.pasadas === 0;
  // La estrategia entra como funcion: el grabador no sabe de SMC ni de divergencias.
  const proveedor: Proveedor = (par, velas) =>
    señales(velas, atrs.get(par) ?? [], ajustes).map((x) => ({ ...x, rr: ajustes.objetivoR }));
  const { registro, resumen } = pasada(reg, datos, proveedor, ahora);


  if (existsSync(ruta)) copyFileSync(ruta, `${ruta}.bak`);
  writeFileSync(ruta, JSON.stringify(registro, null, 2));

  // ---- Informe ------------------------------------------------------------------------------
  console.log(`GRABADOR SMC · pasada ${registro.pasadas} · ${ahora.slice(0, 16)}`);
  console.log(`${datos.size} pares en 1h · coste ${costeBps} pb · objetivo ${ajustes.objetivoR}R`);
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

  if (registro.pendientes.length) {
    console.log(`\nEsperando entrada (${registro.pendientes.length}):`);
    for (const p of registro.pendientes.slice(0, 10)) {
      console.log(
        `  ${p.par.padEnd(10)}${p.direccion.padEnd(7)}entrada ${p.entrada.toFixed(5)} · ` +
          `stop ${p.stop.toFixed(5)} · objetivo ${p.objetivo.toFixed(5)}`,
      );
    }
  }
  if (registro.abiertas.length) {
    console.log(`\nAbiertas (${registro.abiertas.length}):`);
    for (const a of registro.abiertas.slice(0, 10)) {
      console.log(
        `  ${a.par.padEnd(10)}${a.direccion.padEnd(7)}desde ${a.abierta.slice(0, 10)} · ` +
          `entrada ${a.entrada.toFixed(5)}`,
      );
    }
  }

  const b = balance(registro.cerradas);
  if (b.n > 0) {
    const hacenFalta = muestraNecesaria(b);
    console.log(
      `\nCERRADAS: ${b.n} · acierto ${(b.aciertos * 100).toFixed(0)}% · PF ${b.pf.toFixed(2)} · ` +
        `${b.esperanza.toFixed(3)}R ±${b.error.toFixed(3)}`,
    );
    console.log(
      Number.isFinite(hacenFalta)
        ? `Para distinguir esa esperanza del cero harian falta ~${hacenFalta.toLocaleString("es")} ` +
          `operaciones. Llevas ${b.n}.`
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
    if (b.n < 100) {
      console.log("Con menos de 100 cerradas, este numero es ruido. No decidas nada con el.");
    }
  }

  // ---- LA AUDITORIA. Corre en cada pasada, sobre TODO lo cerrado, no solo lo de hoy. ---------
  //
  // Sobre todo porque un fallo introducido hoy puede volver imposibles operaciones grabadas hace
  // meses, y auditar solo lo nuevo dejaria pasar justo eso. Cuesta milisegundos.
  const auditoria = auditar(registro.cerradas.map(deForex), (p) => datos.get(p));
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
