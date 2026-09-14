/**
 * TODO LO QUE ESTA VIVO, EN UNA PANTALLA.
 *
 *   npm run estado -- --bot=RUTA.json      lo mira todo y baja los precios de lo abierto
 *   npm run estado -- --rapido            sin bajar precios (no calcula el flotante)
 *
 * Los tres grabadores de forex viven en `registros/` dentro del repositorio. El estado del bot
 * de cripto vive FUERA a proposito, asi que su ruta se pasa a mano.
 *
 * POR QUE EXISTE
 * --------------
 * El estado real vivia repartido en tres ficheros JSON dentro del repositorio, uno mas fuera, y
 * un log de la tarea programada. Mirarlo obligaba a abrir cinco cosas o a preguntarme, y una
 * prueba hacia adelante que hay que preguntar para ver es una prueba que no se mira.
 *
 * NO CALCULA NADA NUEVO. Lee lo grabado y lo enseña. Cualquier numero que salga aqui tiene que
 * poder rastrearse hasta una linea de un registro.
 *
 * LOS NUMEROS VAN CON SU CONTEXTO, siempre. Seis operaciones cerradas con +1,58R de media es
 * exactamente lo que se ve por azar cuando la esperanza de verdad es -0,32R, asi que enseñar el
 * +1,58 solo seria enseñar media verdad.
 */
import { readFileSync, existsSync } from "node:fs";
import axios from "axios";
import { velas } from "../forex/datos";
import { balance, type Registro, type Abierta } from "../forex/grabador";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
const rapido = process.argv.includes("--rapido");

const hace = (iso: string): string => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 90) return `hace ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `hace ${h} h` : `hace ${Math.round(h / 24)} dias`;
};

const cifra = (x: number): string => (x >= 1 ? x.toFixed(4) : x.toExponential(3));
const conSigno = (r: number): string => `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;

/** Regla de la casa: un numero de muestra corta no se enseña sin decir que no vale. */
export function avisoMuestra(n: number, esperanzaBacktest: number): string {
  if (n === 0) return "";
  if (n < 30) {
    return `      con ${n} operaciones esto es ruido. El backtest predice ${esperanzaBacktest.toFixed(2)}R por operacion.`;
  }
  if (n < 100) return `      ${n} operaciones siguen siendo pocas para decidir nada.`;
  return "";
}

// ---------------------------------------------------------------------------------------------
// LOS GRABADORES DE FOREX
// ---------------------------------------------------------------------------------------------

interface Ficha {
  nombre: string;
  ruta: string;
  /** Lo que el backtest predice por operacion, para no leer el registro a solas. */
  esperanza: number;
}

async function forex(f: Ficha): Promise<void> {
  if (!existsSync(f.ruta)) {
    console.log(`\n${f.nombre}\n  (sin registro en ${f.ruta})`);
    return;
  }
  const reg = JSON.parse(readFileSync(f.ruta, "utf-8")) as Registro<unknown>;
  console.log(`\n${f.nombre} · pasada ${reg.pasadas} · ${hace(reg.ultima)}`);

  if (reg.abiertas.length === 0 && reg.pendientes.length === 0) {
    console.log("  nada abierto");
  }

  let flotante = 0;
  for (const a of reg.abiertas as Abierta[]) {
    let ahora: number | null = null;
    if (!rapido) {
      try {
        const v = await velas(a.par, "5m");
        ahora = v[v.length - 1]?.c ?? null;
        await new Promise((r) => setTimeout(r, 350));
      } catch { ahora = null; }
    }
    const riesgo = Math.abs(a.entrada - a.stop);
    const r = ahora == null
      ? null
      : (a.direccion === "LARGO" ? ahora - a.entrada : a.entrada - ahora) / riesgo;
    if (r != null) flotante += r;
    const camino = ahora == null ? "" : (() => {
      const c = a.direccion === "LARGO"
        ? (ahora! - a.stop) / (a.objetivo - a.stop)
        : (a.stop - ahora!) / (a.stop - a.objetivo);
      return `  ${(c * 100).toFixed(0)}% al objetivo`;
    })();
    console.log(
      `  ABIERTA   ${a.par.padEnd(10)}${a.direccion.padEnd(6)}` +
        `${a.entrada.toFixed(5)}${ahora == null ? "" : ` -> ${ahora.toFixed(5)}`}` +
        `${r == null ? "" : `  ${conSigno(r).padStart(8)}`}${camino}`,
    );
  }
  for (const p of reg.pendientes) {
    console.log(
      `  PENDIENTE ${p.par.padEnd(10)}${p.direccion.padEnd(6)}entrada ${p.entrada.toFixed(5)}`,
    );
  }
  if (reg.abiertas.length > 1 && !rapido) {
    console.log(`            flotante de las ${reg.abiertas.length}: ${conSigno(flotante)}`);
  }

  const b = balance(reg.cerradas);
  if (b.n === 0) {
    console.log("  CERRADAS  0");
    return;
  }
  const estrictas = reg.cerradas.filter((c) => c.velasDeRetraso === 0);
  const be = balance(estrictas);
  console.log(
    `  CERRADAS  ${b.n} · acierto ${(b.aciertos * 100).toFixed(0)}% · ` +
      `${b.esperanza.toFixed(3)}R ±${b.error.toFixed(3)}`,
  );
  console.log(
    be.n > 0
      ? `            de las que se apuntaron ANTES: ${be.n} · ${be.esperanza.toFixed(3)}R`
      : "            ninguna se apunto antes de que su entrada existiera todavia",
  );
  const av = avisoMuestra(b.n, f.esperanza);
  if (av) console.log(av);

  // EL RETRASO AL APUNTAR es la salud de todo esto. Cero significa que la señal se apunto
  // cuando su vela era la ultima cerrada y lo que vino despues no existia; cualquier otra cosa
  // significa que se apunto tarde, y entonces no es una prueba hacia adelante sino un backtest.
  const ultimas = [...reg.pendientes, ...reg.abiertas, ...reg.cerradas]
    .filter((x) => x.velasDeRetraso !== undefined)
    .sort((x, y) => Date.parse(y.apuntada) - Date.parse(x.apuntada))
    .slice(0, 5)
    .map((x) => x.velasDeRetraso!);
  if (ultimas.length) {
    console.log(
      `            retraso al apuntar, ultimas ${ultimas.length}: ${ultimas.join(", ")} velas` +
        `${ultimas.every((x) => x <= 1) ? "  (al dia)" : ""}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// EL BOT DE CRIPTO
// ---------------------------------------------------------------------------------------------

interface Posicion {
  simbolo: string; direccion: "LARGO" | "CORTO"; entrada: number;
  riesgo: number; nivelStop: number; unidades: number;
}
interface Guardado {
  ultimaEjecucion: string; ejecuciones: number; capital: number;
  estado: { posiciones: Posicion[] };
  cerradas: Array<{ r: number; simbolo: string }>;
  ultimoDia: Record<string, string>;
}

async function bot(ruta: string | undefined): Promise<void> {
  if (!ruta) {
    console.log(
      "\nBOT CRIPTO\n  (pasa --bot=RUTA.json para verlo: su estado vive FUERA del repositorio\n" +
        "   a proposito, y la ruta se escribe a mano para que quede a la vista donde esta)",
    );
    return;
  }
  if (!existsSync(ruta)) {
    console.log(`\nBOT CRIPTO\n  (sin estado en ${ruta})`);
    return;
  }
  const g = JSON.parse(readFileSync(ruta, "utf-8")) as Guardado;
  const monedas = Object.keys(g.ultimoDia).length;
  console.log(
    `\nBOT CRIPTO · ${monedas} monedas · ejecucion ${g.ejecuciones} · ${hace(g.ultimaEjecucion)}`,
  );

  let precios = new Map<string, number>();
  if (!rapido && g.estado.posiciones.length > 0) {
    try {
      const { data } = await axios.get("https://api.binance.com/api/v3/ticker/price", {
        timeout: 15_000,
      });
      precios = new Map(
        (data as Array<{ symbol: string; price: string }>).map((x) => [x.symbol, Number(x.price)]),
      );
    } catch { /* sin precios, se enseña sin flotante */ }
  }

  if (g.estado.posiciones.length === 0) console.log("  nada abierto");
  let expuesto = 0;
  for (const p of g.estado.posiciones) {
    const ahora = precios.get(p.simbolo);
    const r = ahora == null
      ? null
      : (p.direccion === "LARGO" ? ahora - p.entrada : p.entrada - ahora) / p.riesgo;
    expuesto += (ahora ?? p.entrada) * p.unidades;
    // SI EL PRECIO YA ESTA PASADO DEL STOP, la operacion esta resuelta aunque figure abierta:
    // el bot solo actua sobre velas diarias CERRADAS, asi que la apuntara en el proximo cierre.
    // Y la apuntara al precio del hueco, no al del momento, asi que el flotante de arriba no es
    // lo que va a salir. Decirlo evita leer una perdida peor —o mejor— de la que sera.
    const roto = ahora != null &&
      (p.direccion === "LARGO" ? ahora < p.nivelStop : ahora > p.nivelStop);
    console.log(
      `  ${roto ? "CERRANDO " : "ABIERTA  "} ${p.simbolo.padEnd(11)}${p.direccion.padEnd(6)}${cifra(p.entrada)}` +
        `${ahora == null ? "" : ` -> ${cifra(ahora)}`}` +
        `${r == null ? "" : `  ${conSigno(r).padStart(8)}`}  stop ${cifra(p.nivelStop)}`,
    );
    if (roto) {
      console.log(
        `            el precio ya paso del stop: se apuntara en el proximo cierre diario, ` +
          "al precio del hueco",
      );
    }
  }
  if (g.estado.posiciones.length > 0) {
    console.log(
      `            exposicion ${(expuesto / g.capital).toFixed(2)}x sobre ${g.capital}$ de capital`,
    );
  }

  const rs = g.cerradas.map((c) => c.r);
  if (rs.length === 0) {
    console.log("  CERRADAS  0");
    return;
  }
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  console.log(
    `  CERRADAS  ${rs.length} · ${m.toFixed(3)}R de media · ` +
      `acierto ${((rs.filter((x) => x > 0).length / rs.length) * 100).toFixed(0)}%`,
  );
  const av = avisoMuestra(rs.length, 0.22);
  if (av) console.log(av);
}

// ---------------------------------------------------------------------------------------------

/**
 * LA CUENTA DEMO Y EL COSTE REAL, que ya no viven en los registros.
 *
 * Desde el 13 sep hay un ejecutor que pone ordenes de verdad en MT5 y un medidor de spread. Los
 * dos escriben su propio JSON FUERA del repositorio, y sin esto habria que abrirlos a mano, que
 * es exactamente por lo que existe este panel.
 *
 * LO QUE SE ENSEÑA AQUI NO ES "COMO VAMOS": es de donde sale la diferencia entre lo grabado y lo
 * ejecutado. El desliz y el spread por franja son lo que el backtest no puede saber.
 */
function ejecutor(ruta: string): void {
  if (!existsSync(ruta)) {
    console.log("\n\nCUENTA DEMO (MT5)\n   sin fichero de estado: todavia no ha puesto ninguna orden.");
    return;
  }
  const e = JSON.parse(readFileSync(ruta, "utf-8")) as {
    puestas?: Record<string, { descartada?: string }>;
    rechazadas?: Array<{ peaje: number; spread_pips: number; stop_pips: number }>;
    llenados?: Array<{ ident: string; desliz_pips: number; par: string }>;
    historial?: Array<{ par: string; beneficio: number; comision?: number; swap?: number }>;
  };
  const lls = e.llenados ?? [];
  const hist = e.historial ?? [];
  const puestas = Object.values(e.puestas ?? {});
  // EL MOTIVO IMPORTA MAS QUE EL NUMERO. "Llegamos tarde" y "decidimos no operar" son cosas
  // opuestas: la primera es un fallo nuestro, la segunda es el filtro haciendo su trabajo.
  // Meterlas en el mismo saco me hizo leer mal el primer dia de datos reales: di por hecho que
  // el ejecutor habia llegado tarde a dos señales cuando en realidad las habia rechazado a
  // proposito, y las dos resultaron perdedoras.
  const descartadas = puestas.filter((x) => x.descartada);
  const porPeaje = descartadas.filter((x) => (x.descartada ?? "").startsWith("peaje")).length;
  const porPrecio = descartadas.length - porPeaje;

  console.log("\n\nCUENTA DEMO (MT5)");
  console.log(
    `   ordenes puestas ${puestas.length - descartadas.length}` +
      ` · rechazadas por peaje ${porPeaje} · llegamos tarde ${porPrecio}`,
  );
  const rech = e.rechazadas ?? [];
  if (rech.length) {
    const pj = rech.map((x) => x.peaje).sort((a, b) => a - b);
    console.log(
      `   al rechazar, el spread se llevaba: mediana ` +
        `${(pj[Math.floor(pj.length / 2)]! * 100).toFixed(0)}% del riesgo · ` +
        `peor ${(pj[pj.length - 1]! * 100).toFixed(0)}%`,
    );
  }
  if (lls.length) {
    const ds = lls.map((x) => x.desliz_pips).sort((a, b) => a - b);
    const peores = ds.filter((x) => x > 0).length;
    console.log(
      `   LLENADOS ${lls.length} · desliz mediana ${ds[Math.floor(ds.length / 2)]!.toFixed(2)}p · ` +
        `medio ${(ds.reduce((a, b) => a + b, 0) / ds.length).toFixed(2)}p · peor ${ds.at(-1)!.toFixed(2)}p`,
    );
    // Una limitada NO deberia llenar peor que su precio. Si pasa, hay algo que entender.
    if (peores) console.log(`   ${peores} llenaron PEOR que el limite pedido. Eso no deberia pasar.`);
  }
  if (hist.length) {
    const suma = hist.reduce((a, h) => a + h.beneficio, 0);
    const verdes = hist.filter((h) => h.beneficio > 0).length;
    const costes = hist.reduce((a, h) => a + (h.comision ?? 0) + (h.swap ?? 0), 0);
    console.log(
      `   CERRADAS ${hist.length} · ${verdes} en verde (${((verdes / hist.length) * 100).toFixed(0)}%) · ` +
        `${suma >= 0 ? "+" : ""}${suma.toFixed(2)} USD` +
        (costes ? ` · comisiones y swaps ${costes.toFixed(2)}` : ""),
    );
  } else {
    console.log("   ninguna cerrada todavia.");
  }
}

function spread(ruta: string): void {
  if (!existsSync(ruta)) {
    console.log("\nSPREAD REAL (MT5)\n   sin muestras. El medidor solo graba con el mercado abierto.");
    return;
  }
  const r = JSON.parse(readFileSync(ruta, "utf-8")) as {
    muestras?: Array<{ par: string; t: number; pips: number }>;
  };
  const ms = r.muestras ?? [];
  if (!ms.length) { console.log("\nSPREAD REAL (MT5)\n   0 muestras."); return; }
  const horas = new Set(ms.map((m) => Math.floor(m.t / 3600))).size;
  const enFranja = (desde: number, hasta: number) => ms
    .filter((m) => {
      const h = new Date(m.t * 1000).getUTCHours();
      return desde > hasta ? (h >= desde || h < hasta) : (h >= desde && h < hasta);
    })
    .map((m) => m.pips)
    .sort((a, b) => a - b);
  const med = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)]! : 0);
  const p90 = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length * 0.9)]! : 0);
  // LA FRANJA QUE DECIDE: 21-07 UTC concentra el 39% de las operaciones y el 78% del resultado.
  const noche = enFranja(21, 7);
  const dia = enFranja(7, 21);
  console.log(`\nSPREAD REAL (MT5) · ${ms.length} muestras · ${horas} horas distintas`);
  if (noche.length) {
    console.log(`   noche 21-07 UTC: mediana ${med(noche).toFixed(2)}p · p90 ${p90(noche).toFixed(2)}p   (${noche.length})`);
  }
  if (dia.length) {
    console.log(`   dia   07-21 UTC: mediana ${med(dia).toFixed(2)}p · p90 ${p90(dia).toFixed(2)}p   (${dia.length})`);
  }
  console.log("   el tope de la franja nocturna son ~2,4 pips de ida y vuelta: por encima, no paga");
  if (horas < 48) {
    console.log(`   Con ${horas} horas medidas no se cubre ni el solape ni Asia. Sirve con una semana.`);
  }
}

async function main(): Promise<void> {
  console.log(`ESTADO · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC` +
    `${rapido ? " · modo rapido, sin precios" : ""}`);

  await bot(txt("bot"));

  // LOS QUE EJECUTAN VAN PRIMERO. Desde el 13 sep lo que llega a la cuenta demo sale de los
  // registros de XM, que leen las velas del broker; los de Yahoo siguen en papel y sirven de
  // comparacion, pero mirarlos primero invita a sacar conclusiones de lo que no se esta
  // operando.
  const fichas: Ficha[] = [
    { nombre: "XM colchon 2 (4 pares) · EJECUTA", ruta: "registros/div-xm2.json", esperanza: 0.18 },
    { nombre: "XM colchon 1 (4 pares) · solo papel", ruta: "registros/div-xm.json", esperanza: 0.17 },
    { nombre: "XM video (12 pares) · EJECUTA", ruta: "registros/div-xm-video.json", esperanza: 0.41 },
    { nombre: "yahoo video · solo papel", ruta: "registros/div-video.json", esperanza: 0.41 },
    { nombre: "yahoo afinado · solo papel", ruta: "registros/div-afinado.json", esperanza: 0.1 },
    { nombre: "DIVERGENCIAS 4h/1h", ruta: "registros/div-4h1h.json", esperanza: 0.19 },
    { nombre: "SMC (1h)", ruta: "registros/registro-smc.json", esperanza: 0.04 },
  ];
  for (const f of fichas) await forex(f);

  ejecutor(txt("estado") ?? "C:/Users/fseal/Desktop/registro-cripto/ejecutor.json");
  spread(txt("spread") ?? "C:/Users/fseal/Desktop/registro-cripto/spread-mt5.json");

  console.log(
    "\nLos grabadores no envian ordenes. El ejecutor SI, y solo a la cuenta DEMO: comprueba\n" +
    "que lo es antes de cada orden, y no hay bandera para desactivar esa comprobacion.",
  );
}

// Solo corre cuando se le llama como programa. Sin esta guarda, importar `avisoMuestra` desde
// una prueba lanzaria el panel entero y se pondria a bajar precios.
if (process.argv[1]?.includes("estadoCli")) {
  main().catch((e) => {
    console.error("Error:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
