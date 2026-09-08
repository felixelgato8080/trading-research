/**
 * ¿MIENTE MI BACKTEST? Contrasta el registro hacia adelante con lo que el backtest predice.
 *
 *   npm run contraste -- --registro=registros/div-video.json [--costebps=0.6]
 *
 * Es la razon de ser de los grabadores. Se descarga el historico de HOY, se vuelve a correr la
 * estrategia sobre el, y se compara operacion a operacion con lo que quedo apuntado en su
 * momento.
 *
 * NO SE COMPARAN PROMEDIOS. Dos series pueden dar la misma esperanza con todas las operaciones
 * distintas, y entonces el promedio coincide por casualidad mientras el simulador esta roto.
 * Hay una prueba que fija justo ese caso.
 *
 * ESCRITO ANTES DE QUE HAYA DATOS QUE MIRAR, a proposito: escribir la herramienta despues de ver
 * el resultado invita a ajustarla hasta que el resultado parezca bueno.
 *
 * QUE ESPERAR MIENTRAS NO HAYA MUESTRA
 * ------------------------------------
 * Con menos de ~30 operaciones cerradas esto no dice nada sobre la esperanza. Pero SI dice algo
 * desde la primera: si una señal grabada aparece hoy con otros precios, eso es un fallo aunque
 * haya una sola.
 */
import { readFileSync, existsSync } from "node:fs";
import { velas as bajarVelas, type Vela, type Temporalidad } from "../forex/datos";
import { agregar } from "../forex/agregar";
import { rsi } from "../forex/rsi";
import { atr } from "../forex/multiTf";
import { simular } from "../forex/estructuraValida";
import {
  señales, type AjustesDivergencia, type AjustesEntrada,
} from "../forex/divergencia";
import { contrastar, veredicto, type Predicha } from "../forex/contraste";
import type { Registro } from "../forex/grabador";

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

interface Ajustes {
  modo: string;
  div: AjustesDivergencia;
  ent: AjustesEntrada;
}

async function main(): Promise<void> {
  const ruta = txt("registro");
  if (!ruta || !existsSync(ruta)) {
    console.error("Falta --registro=RUTA.json");
    process.exitCode = 1;
    return;
  }
  const costeBps = num("costebps", 0.6);
  const maxVelas = num("maxvelas", 200);

  const reg = JSON.parse(readFileSync(ruta, "utf-8")) as Registro<Ajustes>;
  // LOS AJUSTES SALEN DEL REGISTRO, no de aqui. Contrastar con otros parametros compararia dos
  // estrategias distintas y cualquier discrepancia seria culpa mia, no del backtest.
  const { div, ent, modo } = reg.ajustes;

  const pares = Object.keys(reg.vistoHasta);
  const desde = Math.floor(new Date(reg.inicio).getTime() / 1000);
  const hasta = Math.max(...Object.values(reg.vistoHasta), desde);

  console.log(
    `Registro "${reg.nombre}" · modo ${modo} · ${reg.pasadas} pasadas · ` +
      `${reg.cerradas.length} cerradas · ${pares.length} pares`,
  );
  console.log(
    `Ventana: ${new Date(desde * 1000).toISOString().slice(0, 16)} → ` +
      `${new Date(hasta * 1000).toISOString().slice(0, 16)}\n`,
  );
  if (reg.cerradas.length === 0) {
    console.log("Todavia no hay operaciones cerradas: no hay nada que contrastar.");
    return;
  }

  const tfMenor: Temporalidad = modo === "video" ? "5m" : "1h";
  const tfMayor: Temporalidad | null = modo === "video" ? "15m" : null;
  const bloque4h = (t0: number): string => {
    const d = new Date(t0 * 1000);
    return `${d.toISOString().slice(0, 10)}_${Math.floor(d.getUTCHours() / 4)}`;
  };

  const predichas: Predicha[] = [];
  let fallos = 0;
  for (const par of pares) {
    try {
      const men = await bajarVelas(par, tfMenor);
      let may: Vela[];
      if (tfMayor) {
        await dormir(300);
        may = await bajarVelas(par, tfMayor);
      } else {
        may = agregar(men, bloque4h);
      }
      if (may.length < 300 || men.length < 300) { fallos += 1; continue; }

      const r = rsi(may.map((v) => v.c), div.periodoRsi);
      const a = atr(men, 14);
      for (const s of señales(may, r, men, a, div, ent)) {
        const coste = (s.entrada * costeBps) / 10_000;
        const res = simular(men, s, coste, maxVelas);
        if (!res) continue;
        // La misma operacion medida contra el precio PEDIDO, para poder comparar con las que se
        // grabaron cuando el grabador aun no guardaba el llenado real.
        const riesgo = Math.abs(s.entrada - s.stop);
        const largo = s.direccion === "LARGO";
        const rPlaneado = riesgo > 0
          ? ((largo ? res.salida - s.entrada : s.entrada - res.salida) - coste) / riesgo
          : res.r;
        // El grabador apunta `tSeñal` como el momento de la vela de ENTRADA en la temporalidad
        // menor, asi que aqui hay que usar el mismo instante o no emparejaria nada.
        predichas.push({
          par, tSeñal: men[s.i]!.t,
          entrada: s.entrada, stop: s.stop, objetivo: s.objetivo, r: res.r, rPlaneado,
        });
      }
    } catch {
      fallos += 1;
    }
    await dormir(300);
  }
  if (fallos) console.error(`${fallos} par(es) no se pudieron descargar.\n`);

  const c = contrastar(reg.cerradas, predichas, desde, hasta);
  console.log(veredicto(c));

  if (c.emparejadas < 30) {
    console.log(
      `\nCon ${c.emparejadas} operaciones emparejadas, la DIFERENCIA MEDIA no significa nada.\n` +
        "Lo que si vale desde la primera es que una señal grabada aparezca hoy con otros\n" +
        "precios: eso es un fallo aunque haya una sola.",
    );
  }
  // Que el registro y el backtest discrepen en los precios es un fallo, no una curiosidad.
  if (c.preciosDistintos.length || c.resultadosDistintos.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
