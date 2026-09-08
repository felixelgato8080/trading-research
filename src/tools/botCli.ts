/**
 * EL BOT. Lee el mercado, decide, y ejecuta — en papel salvo que se le diga lo contrario.
 *
 *   npm run bot -- --estado=RUTA.json --lista=monedas.json [--capital=1000] [--riesgo=0.01]
 *
 * QUE HACE CADA PASADA
 *   1. Descarga las velas diarias de Binance.
 *   2. Actualiza posiciones abiertas: dispara stops y mueve trailings.
 *   3. Detecta rupturas de 2 ATR en la ultima vela CERRADA.
 *   4. Emite ordenes pasandolas por todas las barreras.
 *   5. Guarda el estado y escribe un informe.
 *
 * MODO PAPEL POR DEFECTO, Y NO HAY MODO REAL AQUI
 * ----------------------------------------------
 * Este programa NO envia ordenes a ningun exchange. Imprime lo que haria y lo apunta. Conectar
 * esto a dinero real es una decision de Felix, no algo que deba pasar por descuido al ejecutar
 * un comando. Cuando llegue ese dia, la clave de API vive SOLO en el entorno del servidor y
 * nunca en el repositorio.
 *
 * EL ESTADO VIVE FUERA DE CUALQUIER CONTENEDOR. Ya se perdieron 109.800 creditos de Helius en
 * este proyecto por guardar datos dentro de uno que luego se recreo.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { velasBinance } from "../forex/binance";
import { atr } from "../forex/multiTf";
import { volatilidad } from "../forex/rupturas";
import type { Vela } from "../forex/datos";
import {
  decidir, exposicion,
  type Estado, type Posicion, type SeñalEntrada, type Mercado, type Ajustes, type Orden,
} from "../forex/ordenes";

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
const p = (x: number): string => (x >= 1 ? x.toFixed(4) : x.toExponential(4));

interface Cerrada {
  simbolo: string;
  direccion: "LARGO" | "CORTO";
  entrada: number;
  salida: number;
  r: number;
  abierta: string;
  cerrada: string;
}

interface Guardado {
  version: 1;
  modo: "papel";
  inicio: string;
  ultimaEjecucion: string;
  ejecuciones: number;
  capital: number;
  ajustes: Ajustes;
  estado: Estado;
  cerradas: Cerrada[];
  /** Ultimo dia de vela ya procesado por simbolo, para no contar dos veces. */
  ultimoDia: Record<string, string>;
}

async function main(): Promise<void> {
  const ruta = txt("estado");
  if (!ruta) {
    console.error("Falta --estado=RUTA.json (ponla FUERA de cualquier contenedor)");
    process.exitCode = 1;
    return;
  }
  const ahora = new Date().toISOString();
  const capital = num("capital", 1000);

  const ajustes: Ajustes = {
    capital,
    riesgoPct: num("riesgo", 0.01),
    maxPosiciones: num("tope", 8),
    trailing: num("trailing", 2),
    maxExposicion: num("expo", 1),
    maxPerdidaDiaria: num("maxperdida", 0.05),
    parado: process.argv.includes("--parar"),
  };

  let g: Guardado;
  if (existsSync(ruta)) {
    g = JSON.parse(readFileSync(ruta, "utf-8")) as Guardado;
    g.ajustes = { ...ajustes, capital: g.capital };
  } else {
    g = {
      version: 1, modo: "papel", inicio: ahora, ultimaEjecucion: ahora, ejecuciones: 0,
      capital, ajustes, estado: { posiciones: [], resultadoDia: 0 },
      cerradas: [], ultimoDia: {},
    };
    console.log(`Estado nuevo en ${ruta} · MODO PAPEL · capital ${capital}\n`);
  }

  const lista: string[] = JSON.parse(
    readFileSync(txt("lista") ?? "monedas.json", "utf-8"),
  );

  // ---- Descarga -------------------------------------------------------------------------
  const datos = new Map<string, Vela[]>();
  let fallos = 0;
  // El motivo del PRIMER fallo se guarda y se imprime. Tragarse los errores hizo que un
  // despliegue dijera solo "0 de 30 descargas" sin decir por que, y eso no es depurable.
  let primerFallo = "";
  for (const s of lista) {
    try {
      const v = await velasBinance(s, "1d", 200);
      if (v.length > 40) {
        datos.set(s, v);
      } else {
        fallos += 1;
        if (!primerFallo) primerFallo = `${s}: solo ${v.length} velas`;
      }
    } catch (e) {
      fallos += 1;
      if (!primerFallo) {
        const err = e as { response?: { status?: number; data?: unknown }; message?: string };
        primerFallo = err.response?.status
          ? `${s}: HTTP ${err.response.status} · ${JSON.stringify(err.response.data).slice(0, 200)}`
          : `${s}: ${err.message ?? String(e)}`;
      }
    }
    await dormir(250);
  }
  if (fallos > 0) console.error(`Primer fallo de descarga → ${primerFallo}`);
  if (datos.size < lista.length / 2) {
    console.error(`Solo ${datos.size} de ${lista.length} descargas. No se toca el estado.`);
    process.exitCode = 1;
    return;
  }

  // ---- Mercados: recorrido de las velas NUEVAS de cada simbolo --------------------------
  const mercados = new Map<string, Mercado>();
  const dia = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
  for (const [s, v] of datos) {
    const desde = g.ultimoDia[s];
    let maximo = -Infinity, minimo = Infinity, ultimo = 0;
    // Solo velas CERRADAS: la ultima esta en curso.
    for (let i = 0; i < v.length - 1; i += 1) {
      const d = dia(v[i]!.t);
      if (desde && d <= desde) continue;
      maximo = Math.max(maximo, v[i]!.h);
      minimo = Math.min(minimo, v[i]!.l);
      ultimo = v[i]!.c;
    }
    if (Number.isFinite(maximo) && Number.isFinite(minimo)) {
      mercados.set(s, { simbolo: s, ultimo, maximo, minimo });
    }
  }

  // ---- Señales de la ultima vela cerrada ------------------------------------------------
  const señales: SeñalEntrada[] = [];
  for (const [s, v] of datos) {
    const i = v.length - 2;
    if (i < 20) continue;
    if (g.ultimoDia[s] && dia(v[i]!.t) <= g.ultimoDia[s]!) continue;
    const a = atr(v, 14);
    const av = a[i];
    if (av == null || !(av > 0)) continue;
    const d = volatilidad(v, a, 2).find((x) => x.i === i);
    if (!d) continue;
    señales.push({
      simbolo: s,
      direccion: d.direccion,
      riesgo: av * 2,
      precio: v[i]!.c,
      fuerza: Math.abs(v[i]!.c - v[i]!.o) / av,
    });
  }

  // ---- Decision --------------------------------------------------------------------------
  const antes = new Map(g.estado.posiciones.map((x) => [x.simbolo, { ...x }]));
  const d = decidir(g.estado, señales, mercados, g.ajustes);

  // Las cerradas se apuntan con su resultado en R, que es como se mide todo el proyecto.
  for (const o of d.ordenes) {
    if (o.tipo !== "CERRAR") continue;
    const previa = antes.get(o.simbolo);
    if (!previa) continue;
    const salida = previa.nivelStop;
    const bruto = previa.direccion === "LARGO"
      ? salida - previa.entrada
      : previa.entrada - salida;
    g.cerradas.push({
      simbolo: o.simbolo, direccion: previa.direccion, entrada: previa.entrada,
      salida, r: bruto / previa.riesgo,
      abierta: "", cerrada: ahora.slice(0, 10),
    });
  }

  g.estado = d.estadoFinal;
  g.ejecuciones += 1;
  g.ultimaEjecucion = ahora;
  for (const [s, v] of datos) g.ultimoDia[s] = dia(v[v.length - 2]!.t);

  if (existsSync(ruta)) copyFileSync(ruta, `${ruta}.bak`);
  writeFileSync(ruta, JSON.stringify(g, null, 2));

  // ---- Informe ---------------------------------------------------------------------------
  console.log(`BOT · MODO PAPEL · ejecucion ${g.ejecuciones} · ${ahora.slice(0, 16)}`);
  console.log(
    `capital ${g.capital} · riesgo ${(g.ajustes.riesgoPct * 100).toFixed(1)}% · ` +
      `tope ${g.ajustes.maxPosiciones} · expo max ${g.ajustes.maxExposicion}x` +
      `${g.ajustes.parado ? " · PARADO" : ""}`,
  );
  console.log(`${datos.size} monedas${fallos ? ` · ${fallos} fallaron` : ""}\n`);

  const dibuja = (o: Orden): string => {
    if (o.tipo === "ABRIR") {
      return `  ABRIR   ${o.simbolo.padEnd(12)}${o.direccion.padEnd(7)}` +
        `${o.unidades.toPrecision(4).padStart(12)} u · stop ${p(o.nivelStop)}  (${o.motivo})`;
    }
    if (o.tipo === "CERRAR") {
      return `  CERRAR  ${o.simbolo.padEnd(12)}${o.unidades.toPrecision(4).padStart(19)} u  (${o.motivo})`;
    }
    return `  STOP →  ${o.simbolo.padEnd(12)}${p(o.nuevoNivel).padStart(19)}  (${o.motivo})`;
  };

  if (d.ordenes.length === 0) console.log("Sin ordenes.");
  else {
    console.log(`${d.ordenes.length} orden(es):`);
    for (const o of d.ordenes) console.log(dibuja(o));
  }

  if (d.descartadas.length) {
    console.log(`\nDescartadas: ${d.descartadas.map((x) => `${x.simbolo} (${x.motivo})`).join(", ")}`);
  }

  const expo = exposicion(g.estado.posiciones, g.capital);
  console.log(
    `\nAbiertas: ${g.estado.posiciones.length}/${g.ajustes.maxPosiciones} · ` +
      `exposicion ${expo.toFixed(2)}x`,
  );
  for (const pos of g.estado.posiciones) {
    const m = mercados.get(pos.simbolo);
    const flot = m
      ? (pos.direccion === "LARGO" ? m.ultimo - pos.entrada : pos.entrada - m.ultimo) / pos.riesgo
      : 0;
    console.log(
      `  ${pos.simbolo.padEnd(12)}${pos.direccion.padEnd(7)}entrada ${p(pos.entrada)} · ` +
        `stop ${p(pos.nivelStop)} · ${flot >= 0 ? "+" : ""}${flot.toFixed(2)}R flotante`,
    );
  }

  if (g.cerradas.length) {
    const rs = g.cerradas.map((c) => c.r);
    const gan = rs.filter((x) => x > 0);
    const sg = gan.reduce((s, x) => s + x, 0);
    const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
    console.log(
      `\nCerradas: ${rs.length} · acierto ${((gan.length / rs.length) * 100).toFixed(0)}% · ` +
        `PF ${(sp > 0 ? sg / sp : 0).toFixed(2)} · ` +
        `${(rs.reduce((s, x) => s + x, 0)).toFixed(2)}R acumulados`,
    );
    for (const c of g.cerradas.slice(-5)) {
      console.log(`  ${c.cerrada}  ${c.simbolo.padEnd(12)}${(c.r >= 0 ? "+" : "") + c.r.toFixed(2)}R`);
    }
  }

  console.log(`\nGuardado en ${ruta}. NO se ha enviado ninguna orden a ningun exchange.`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
