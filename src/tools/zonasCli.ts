/**
 * La estrategia de estructura + oferta/demanda + filtro de R:R, medida.
 *
 *   npm run zonas -- --lista X.json --cache=V.json [--costebps=10]
 *
 * SE AISLA CADA PASO, porque la estrategia son tres y hay que saber cual aporta:
 *   1. Solo zonas, sin filtro de tendencia ni de R:R.
 *   2. Zonas + tendencia validada (el paso 1 del video).
 *   3. Zonas + tendencia + R:R minimo (la estrategia completa).
 *
 * Y el control de siempre: entradas al azar con el mismo stop y el mismo objetivo. Si la
 * estrategia no le gana, las tres reglas no estan aportando nada.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { evaluar, informe } from "../forex/controles";
import {
  señales, simular, type AjustesZona,
} from "../forex/estructuraValida";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
function num(n: string, d: number): number {
  const m = txt(n);
  if (m === undefined) return d;
  const v = Number(m);
  return Number.isFinite(v) ? v : d;
}

interface M { n: number; wr: number; pf: number; exp: number; rr: number }
function medir(rs: Array<{ r: number; rr: number }>): M {
  if (!rs.length) return { n: 0, wr: 0, pf: 0, exp: 0, rr: 0 };
  const v = rs.map((x) => x.r);
  const g = v.filter((x) => x > 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -v.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  return {
    n: v.length, wr: g.length / v.length, pf: sp > 0 ? sg / sp : 0,
    exp: v.reduce((s, x) => s + x, 0) / v.length,
    rr: rs.reduce((s, x) => s + x.rr, 0) / rs.length,
  };
}
function fila(nombre: string, m: M, extra = ""): string {
  // El equilibrio se saca del R:R CONSEGUIDO, no del pedido: filtrar por R:R >= 2,5 deja pasar
  // operaciones de 4,0 de media, y usar el 2,5 pondria el liston donde no esta.
  const equilibrio = m.rr > 0 ? 1 / (1 + m.rr) : 0;
  return (
    `${nombre.padEnd(30)}${String(m.n).padStart(7)}${(m.wr * 100).toFixed(0).padStart(6)}%` +
    `${(equilibrio * 100).toFixed(0).padStart(9)}%${m.pf.toFixed(2).padStart(7)}` +
    `${m.exp.toFixed(3).padStart(9)}${m.rr.toFixed(1).padStart(6)}  ${extra}`
  );
}
const CAB =
  `${"variante".padEnd(30)}${"ops".padStart(7)}${"WR".padStart(6)}${"equilib".padStart(10)}` +
  `${"PF".padStart(7)}${"exp R".padStart(9)}${"RR".padStart(6)}`;

async function main(): Promise<void> {
  const costeBps = num("costebps", 10);
  const cache = txt("cache");
  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );
  if (!cache || !existsSync(cache)) {
    console.error("Falta --cache");
    process.exitCode = 1;
    return;
  }
  const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
  const datos = new Map<string, Vela[]>();
  for (const k of lista) {
    const v = g[k];
    if (v && v.length > 300) datos.set(k, v);
  }
  const total = [...datos.values()].reduce((s, v) => s + v.length, 0);
  console.log(
    `${datos.size} instrumentos · ${total.toLocaleString("es")} velas · coste ${costeBps} pb\n`,
  );

  // El umbral de impulso NO es universal: en cripto un cuerpo de 1,5 ATR es corriente y en forex
  // casi no existe. Hay que calibrarlo por mercado o la estrategia no llega a dar señales.
  const BASE: AjustesZona = {
    impulso: num("impulso", 1.5), colchon: 0.1, rrMinimo: 0, vigencia: 30,
  };
  console.log(`impulso ${BASE.impulso} ATR de cuerpo
`);

  /** Corre una variante y devuelve resultados y desglose por instrumento. */
  const correr = (aj: AjustesZona, soloTendencia: boolean) => {
    const rs: Array<{ r: number; rr: number }> = [];
    const porInstr = new Map<string, number[]>();
    for (const [s, v] of datos) {
      const a = atr(v, 14);
      const propias: number[] = [];
      const ss = señales(v, a, { ...aj, exigirTendencia: soloTendencia });
      for (const x of ss) {
        const precio = x.entrada;
        const r = simular(v, x, (precio * costeBps) / 10_000, 200);
        if (r) { rs.push({ r: r.r, rr: r.rr }); propias.push(r.r); }
      }
      porInstr.set(s, propias);
    }
    const enVerde = [...porInstr.values()].filter(
      (l) => l.length > 5 && l.reduce((s, x) => s + x, 0) > 0,
    ).length;
    const mejor = [...porInstr.entries()].sort(
      (x, y) => y[1].reduce((k, z) => k + z, 0) - x[1].reduce((k, z) => k + z, 0),
    )[0]?.[0];
    const sm = [...porInstr.entries()].filter(([q]) => q !== mejor).flatMap(([, x]) => x);
    const sinMejor = sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0;
    return { rs, enVerde, total: porInstr.size, sinMejor };
  };

  console.log("PASO A PASO: que aporta cada regla");
  console.log(CAB);
  console.log("-".repeat(80));

  const sinNada = correr(BASE, false);
  console.log(fila("1. solo zonas", medir(sinNada.rs), `sin mejor ${sinNada.sinMejor.toFixed(3)} · ${sinNada.enVerde}/${sinNada.total}`));

  const conTendencia = correr(BASE, true);
  console.log(fila("2. + tendencia validada", medir(conTendencia.rs), `sin mejor ${conTendencia.sinMejor.toFixed(3)} · ${conTendencia.enVerde}/${conTendencia.total}`));

  for (const rrMin of [2, 2.5, 3]) {
    const r = correr({ ...BASE, rrMinimo: rrMin }, true);
    console.log(fila(`3. + R:R >= ${rrMin}`, medir(r.rs), `sin mejor ${r.sinMejor.toFixed(3)} · ${r.enVerde}/${r.total}`));
  }

  // ---- CONTROLES: la bateria compartida ---------------------------------------------------
  //
  // Estaban copiados a mano aqui, con su propio generador de azar y su propio corte de mitades.
  // La logica que decide si un resultado vale no puede vivir en nueve copias: ya divergieron una
  // vez, y la copia rota deducia el extremo valido de la vela de entrada del lado VOLTEADO. Eso
  // daba -0,329R donde la verdad era -0,022R: un control roto hace parecer excelente a una
  // estrategia mediocre, que es la peor forma de equivocarse aqui.
  //
  // Se pierde el control B de antes —la misma señal con el lado echado a suertes—. No es una
  // perdida: era una version a medias del C, que voltea TODAS y es la comparacion pareada.
  console.log("\nCONTROLES de la estrategia completa (tendencia + R:R >= 2,5)");
  console.log(
    informe(evaluar(
      datos,
      (v) => atr(v, 14),
      (_par, v) => señales(v, atr(v, 14), { ...BASE, rrMinimo: 2.5, exigirTendencia: true }),
      (v, x, extremo) => simular(v, x, (x.entrada * costeBps) / 10_000, 200, extremo),
    )),
  );

  console.log(
    "\nLa columna 'equilib' es el acierto necesario para no perder: 1/(1+RR).\n" +
      "Si 'WR' no la supera, la estrategia pierde por mucho que suene bien el R:R.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
