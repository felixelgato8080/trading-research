/**
 * REPLAY: pasa el motor de decision del BOT por la historia, dia a dia.
 *
 *   npm run replay -- --lista monedas.json [--dias=800] [--capital=1000]
 *
 * POR QUE ESTO ES IMPRESCINDIBLE
 * -----------------------------
 * El backtest de la investigacion y el codigo del bot son DOS programas distintos. El primero
 * mide señales sueltas; el segundo lleva posiciones, mueve stops y aplica barreras. Que el
 * primero de PF 1,54 no garantiza que el segundo haga lo mismo: puede haber un fallo en la
 * gestion que no se ve en ningun test unitario.
 *
 * Esto ejecuta el codigo REAL del bot —`decidir()`, el mismo que correria con dinero— sobre la
 * historia, un dia cada vez, sin dejarle ver nada del futuro. Si el resultado se parece al de la
 * investigacion, el bot hace lo que se midio. Si no, hay un fallo y aparece aqui y no operando.
 */
import { readFileSync } from "node:fs";
import { velasBinance } from "../forex/binance";
import { atr } from "../forex/multiTf";
import { volatilidad } from "../forex/rupturas";
import type { Vela } from "../forex/datos";
import {
  decidir, exposicion,
  type Estado, type SeñalEntrada, type Mercado, type Ajustes,
} from "../forex/ordenes";
import { rejillaPorDefecto, repartir } from "../forex/cartera_multi";

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

async function main(): Promise<void> {
  const dias = num("dias", 800);
  const capitalInicial = num("capital", 1000);
  const costeBps = num("costebps", 10);
  // Con --multi el bot reparte el riesgo entre las 8 configuraciones de la rejilla en vez de
  // usar una sola. Medido: no elegir da 0,276R contra 0,175R de una fija arbitraria.
  const multi = process.argv.includes("--multi");
  const lista: string[] = JSON.parse(
    readFileSync(txt("lista") ?? "monedas.json", "utf-8"),
  );

  const ajustes: Ajustes = {
    capital: capitalInicial,
    riesgoPct: num("riesgo", 0.01),
    maxPosiciones: num("tope", 8),
    trailing: num("trailing", 2),
    maxExposicion: num("expo", 1),
    maxPerdidaDiaria: num("maxperdida", 0.05),
    parado: false,
  };

  const datos = new Map<string, Vela[]>();
  const atrs = new Map<string, (number | null)[]>();
  for (const s of lista) {
    try {
      const v = await velasBinance(s, "1d", dias + 60);
      if (v.length > 100) {
        datos.set(s, v);
        atrs.set(s, atr(v, 14));
      }
    } catch { /* se salta */ }
    await dormir(250);
  }

  // Calendario comun: las fechas del que mas historia tiene.
  let calendario: number[] = [];
  for (const v of datos.values()) if (v.length > calendario.length) calendario = v.map((x) => x.t);
  const indices = new Map<string, Map<number, number>>();
  for (const [s, v] of datos) {
    const m = new Map<number, number>();
    for (let i = 0; i < v.length; i += 1) m.set(v[i]!.t, i);
    indices.set(s, m);
  }

  // Una configuracion, o las ocho de la rejilla repartiendo el mismo riesgo total.
  const configuraciones = multi
    ? rejillaPorDefecto()
    : [{ nombre: "unica", k: 2, atrStop: 2, trailing: 2, peso: 1 }];
  const reparto = repartir(configuraciones, ajustes.riesgoPct);
  if (multi) {
    ajustes.riesgoPct = [...reparto.values()][0]!;
    ajustes.maxPosiciones = num("tope", 8) * configuraciones.length;
  }

  const desde = Math.max(30, calendario.length - dias);
  console.log(
    `${datos.size} monedas · ${configuraciones.length} config · ` +
      `${calendario.length - desde} dias de replay · ` +
      `capital ${capitalInicial} · riesgo ${(ajustes.riesgoPct * 100).toFixed(1)}% · ` +
      `tope ${ajustes.maxPosiciones} · expo ${ajustes.maxExposicion}x · coste ${costeBps} pb\n`,
  );

  let estado: Estado = { posiciones: [], resultadoDia: 0 };
  let capital = capitalInicial;
  let pico = capital;
  let maxCaida = 0;
  let cerradas = 0;
  let ganadas = 0;
  let sumaR = 0;
  let sumaGana = 0;
  let sumaPierde = 0;
  let maxExpo = 0;
  let rechazadas = 0;
  /**
   * Dinero arriesgado en cada posicion, CONGELADO en la entrada.
   *
   * El tamaño se decide al abrir, asi que usar el capital del cierre haria que una ganadora
   * larga cobrase sobre un capital que aun no existia cuando se abrio. Es la misma regla que
   * ya esta probada en `cartera.ts` y que esta primera version del replay se saltaba.
   */
  const riesgoEnEntrada = new Map<string, number>();
  const curva: number[] = [];

  for (let k = desde; k < calendario.length - 1; k += 1) {
    const t = calendario[k]!;
    const capitalAlAbrir = capital;

    // Mercado del dia: el recorrido de LA VELA k, que es la que se acaba de cerrar.
    const mercados = new Map<string, Mercado>();
    for (const [s, v] of datos) {
      const i = indices.get(s)!.get(t);
      if (i == null) continue;
      const m = { simbolo: s, ultimo: v[i]!.c, maximo: v[i]!.h, minimo: v[i]!.l };
      mercados.set(s, m);
      // Cada configuracion lleva su propia clave, pero el mercado subyacente es el mismo.
      for (const cfg of configuraciones) {
        mercados.set(`${s}@${cfg.nombre}`, { ...m, simbolo: `${s}@${cfg.nombre}` });
      }
    }

    // Señales de esa misma vela. `volatilidad` solo mira velas anteriores para el ATR.
    const señales: SeñalEntrada[] = [];
    for (const cfg of configuraciones) {
      for (const [s, v] of datos) {
        const i = indices.get(s)!.get(t);
        if (i == null || i < 20 || i >= v.length - 1) continue;
        const av = atrs.get(s)![i];
        if (av == null || !(av > 0)) continue;
        const d = volatilidad(v, atrs.get(s)!, cfg.k).find((x) => x.i === i);
        if (!d) continue;
        // La entrada real es la APERTURA del dia siguiente, no el cierre de hoy.
        const siguiente = v[i + 1];
        if (!siguiente) continue;
        señales.push({
          // El simbolo lleva la configuracion pegada: son posiciones distintas aunque el
          // instrumento sea el mismo, y el tope "una por simbolo" no debe confundirlas.
          simbolo: configuraciones.length > 1 ? `${s}@${cfg.nombre}` : s,
          direccion: d.direccion,
          riesgo: av * cfg.atrStop,
          precio: siguiente.o,
          fuerza: Math.abs(v[i]!.c - v[i]!.o) / av,
        });
      }
    }

    const previas = new Map(estado.posiciones.map((x) => [x.simbolo, { ...x }]));
    // El resultado del dia se mide contra el capital con el que se AMANECIO, no contra si mismo.
    // La primera version comparaba `capital` consigo mismo y siempre daba 0, asi que el freno
    // por perdida diaria no llegaba a dispararse nunca.
    const resultadoDia = (capital - capitalAlAbrir) / (capitalAlAbrir || 1);
    const d = decidir({ ...estado, resultadoDia }, señales, mercados, { ...ajustes, capital });

    for (const o of d.ordenes) {
      if (o.tipo !== "CERRAR") continue;
      const prev = previas.get(o.simbolo);
      if (!prev) continue;
      const bruto = prev.direccion === "LARGO"
        ? prev.nivelStop - prev.entrada
        : prev.entrada - prev.nivelStop;
      // Coste de las dos patas, en puntos basicos del precio.
      const coste = ((prev.entrada + prev.nivelStop) / 2) * (costeBps / 10_000);
      const r = (bruto - coste) / prev.riesgo;
      capital += r * (riesgoEnEntrada.get(o.simbolo) ?? capital * ajustes.riesgoPct);
      riesgoEnEntrada.delete(o.simbolo);
      cerradas += 1;
      sumaR += r;
      if (r > 0) { ganadas += 1; sumaGana += r; } else sumaPierde += -r;
    }
    for (const o of d.ordenes) {
      if (o.tipo === "ABRIR") riesgoEnEntrada.set(o.simbolo, capital * ajustes.riesgoPct);
    }
    rechazadas += d.descartadas.filter((x) => x.motivo !== "bot parado").length;
    estado = d.estadoFinal;

    pico = Math.max(pico, capital);
    maxCaida = Math.max(maxCaida, pico > 0 ? (pico - capital) / pico : 0);
    maxExpo = Math.max(maxExpo, exposicion(estado.posiciones, capital));
    curva.push(capital);
  }

  // LAS POSICIONES ABIERTAS AL FINAL CUENTAN. En seguimiento de tendencia las ganadoras se
  // quedan corriendo, asi que las abiertas al cerrar el periodo son sobre todo ganadoras.
  // Ignorarlas subestima el resultado, que es justo lo que hacia la primera version.
  let rFlotante = 0;
  const ultima = calendario[calendario.length - 1]!;
  for (const pos of estado.posiciones) {
    const base = pos.simbolo.split("@")[0]!;
    const i = indices.get(base)?.get(ultima);
    const v = datos.get(base);
    if (i == null || !v) continue;
    const cierre = v[i]!.c;
    const bruto = pos.direccion === "LARGO" ? cierre - pos.entrada : pos.entrada - cierre;
    rFlotante += bruto / pos.riesgo;
  }
  let flotanteDinero = 0;
  for (const pos of estado.posiciones) {
    const base = pos.simbolo.split("@")[0]!;
    const i = indices.get(base)?.get(ultima);
    const v = datos.get(base);
    if (i == null || !v) continue;
    const cierre = v[i]!.c;
    const bruto = pos.direccion === "LARGO" ? cierre - pos.entrada : pos.entrada - cierre;
    flotanteDinero += (bruto / pos.riesgo) *
      (riesgoEnEntrada.get(pos.simbolo) ?? capital * ajustes.riesgoPct);
  }
  const capitalConFlotante = capital + flotanteDinero;

  const anios = (calendario.length - desde) / 365.25;
  const mult = capital / capitalInicial;
  const anual = mult > 0 ? (Math.pow(mult, 1 / anios) - 1) * 100 : -100;
  const multF = capitalConFlotante / capitalInicial;
  const anualF = multF > 0 ? (Math.pow(multF, 1 / anios) - 1) * 100 : -100;

  console.log("RESULTADO DEL BOT (su propio codigo, no el del backtest)");
  console.log("-".repeat(58));
  console.log(`  operaciones cerradas   ${cerradas}`);
  console.log(`  acierto                ${cerradas ? ((ganadas / cerradas) * 100).toFixed(0) : 0}%`);
  console.log(`  PF                     ${(sumaPierde > 0 ? sumaGana / sumaPierde : 0).toFixed(2)}`);
  console.log(`  R por operacion        ${(cerradas ? sumaR / cerradas : 0).toFixed(3)}`);
  console.log(`  capital final          ${capital.toFixed(0)}  (${mult.toFixed(2)}x)`);
  console.log(`  anual                  ${anual.toFixed(1)}%`);
  console.log(`  peor caida             ${(maxCaida * 100).toFixed(0)}%`);
  console.log(`  exposicion maxima      ${maxExpo.toFixed(2)}x`);
  console.log(`  señales rechazadas     ${rechazadas} (por topes)`);
  console.log(`  posiciones abiertas    ${estado.posiciones.length} · ${rFlotante.toFixed(2)}R flotantes`);
  console.log(`  CON las abiertas       ${capitalConFlotante.toFixed(0)} · ${anualF.toFixed(1)}% anual`);
  console.log(
    "\nSi esto se parece a PF 1,54 / 0,297R de la investigacion, el bot ejecuta lo que se midio.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
