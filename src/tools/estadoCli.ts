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

async function main(): Promise<void> {
  console.log(`ESTADO · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC` +
    `${rapido ? " · modo rapido, sin precios" : ""}`);

  await bot(txt("bot"));

  const fichas: Ficha[] = [
    { nombre: "DIVERGENCIAS video (15m/5m)", ruta: "registros/div-video.json", esperanza: -0.32 },
    { nombre: "DIVERGENCIAS 4h/1h", ruta: "registros/div-4h1h.json", esperanza: 0.19 },
    { nombre: "SMC (1h)", ruta: "registros/registro-smc.json", esperanza: 0.04 },
  ];
  for (const f of fichas) await forex(f);

  console.log(
    "\nNada de esto envia ordenes a ningun sitio. No hay codigo para hacerlo en el repositorio.",
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
