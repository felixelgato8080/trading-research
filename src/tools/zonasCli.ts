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
import {
  señales, simular, type AjustesZona, type SeñalZona,
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
function azar(semilla: number): () => number {
  let s = semilla >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
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

  // ---- CONTROLES -----------------------------------------------------------------------
  //
  // Uno solo no basta. El de entradas al azar dice si las reglas encuentran algo que no este
  // ya en la forma del pago (stop corto, objetivo lejano, cripto con colas gordas). El de
  // direccion volteada dice si acertar EL LADO aporta: mismas entradas, mismo riesgo, misma
  // distancia al objetivo, pero la mitad de las veces al reves.
  const completa = correr({ ...BASE, rrMinimo: 2.5 }, true);
  const mComp = medir(completa.rs);

  // Control A: entradas al azar. Con muchas repeticiones, porque con 300 operaciones el error
  // tipico es +-0,12R y eso es mas grande que la diferencia que se quiere medir.
  const rnd = azar(20260907);
  const ctrl: Array<{ r: number; rr: number }> = [];
  const porCoin = Math.max(1, Math.round((mComp.n / datos.size) * 20));
  for (const [, v] of datos) {
    const a = atr(v, 14);
    for (let k = 0; k < porCoin; k += 1) {
      const i = 50 + Math.floor(rnd() * (v.length - 250));
      const av = a[i];
      if (av == null || !(av > 0)) continue;
      const largo = rnd() < 0.5;
      const entrada = v[i]!.c;
      const riesgo = av * 1.5;
      const s: SeñalZona = {
        i, direccion: largo ? "LARGO" : "CORTO", entrada,
        stop: largo ? entrada - riesgo : entrada + riesgo,
        objetivo: largo ? entrada + riesgo * mComp.rr : entrada - riesgo * mComp.rr,
        rr: mComp.rr,
      };
      const r = simular(v, s, (entrada * costeBps) / 10_000, 200, "NINGUNO");
      if (r) ctrl.push({ r: r.r, rr: r.rr });
    }
  }
  console.log(fila("   A- azar mismo perfil", medir(ctrl)));

  // Control B: las mismas señales, con la direccion echada a suertes.
  const volteado: Array<{ r: number; rr: number }> = [];
  const rnd2 = azar(11111);
  for (const [, v] of datos) {
    for (const x of señales(v, atr(v, 14), { ...BASE, rrMinimo: 2.5 })) {
      const largo = rnd2() < 0.5;
      const riesgo = Math.abs(x.entrada - x.stop);
      const dist = Math.abs(x.objetivo - x.entrada);
      const s: SeñalZona = {
        i: x.i, direccion: largo ? "LARGO" : "CORTO", entrada: x.entrada,
        stop: largo ? x.entrada - riesgo : x.entrada + riesgo,
        objetivo: largo ? x.entrada + dist : x.entrada - dist,
        rr: x.rr,
      };
      // El extremo valido lo fija el viaje del precio, que es el de la señal ORIGINAL.
      // Deducirlo del lado volteado seria matar el control con un extremo ya pasado.
      const r = simular(
        v, s, (x.entrada * costeBps) / 10_000, 200,
        x.direccion === "LARGO" ? "MINIMO" : "MAXIMO",
      );
      if (r) volteado.push({ r: r.r, rr: r.rr });
    }
  }
  console.log(fila("   B- misma señal, lado al azar", medir(volteado)));

  // Control C: TODAS volteadas. Es la comparacion pareada: mismas barras, mismo riesgo, misma
  // distancia al objetivo, lado opuesto. Si acertar el lado no aporta, esto tiene que empatar.
  const contrario: Array<{ r: number; rr: number }> = [];
  for (const [, v] of datos) {
    for (const x of señales(v, atr(v, 14), { ...BASE, rrMinimo: 2.5 })) {
      const largo = x.direccion === "CORTO";
      const riesgo = Math.abs(x.entrada - x.stop);
      const dist = Math.abs(x.objetivo - x.entrada);
      const s: SeñalZona = {
        i: x.i, direccion: largo ? "LARGO" : "CORTO", entrada: x.entrada,
        stop: largo ? x.entrada - riesgo : x.entrada + riesgo,
        objetivo: largo ? x.entrada + dist : x.entrada - dist,
        rr: x.rr,
      };
      const r = simular(
        v, s, (x.entrada * costeBps) / 10_000, 200,
        x.direccion === "LARGO" ? "MINIMO" : "MAXIMO",
      );
      if (r) contrario.push({ r: r.r, rr: r.rr });
    }
  }
  console.log(fila("   C- misma señal AL REVES", medir(contrario)));

  // ---- ESTABILIDAD: las dos mitades del calendario ---------------------------------------
  const tiempos = [...datos.values()].flat().map((x) => x.t).sort((a, b) => a - b);
  const corte = tiempos[Math.floor(tiempos.length / 2)]!;
  const mitades: Array<Array<{ r: number; rr: number }>> = [[], []];
  for (const [, v] of datos) {
    for (const x of señales(v, atr(v, 14), { ...BASE, rrMinimo: 2.5 })) {
      const r = simular(v, x, (x.entrada * costeBps) / 10_000, 200);
      if (r) mitades[v[x.i]!.t < corte ? 0 : 1]!.push({ r: r.r, rr: r.rr });
    }
  }
  const f = (n: number) => new Date(n * 1000).toISOString().slice(0, 7);
  console.log(
    `\n   1a mitad (hasta ${f(corte)})`.padEnd(33) +
      fila("", medir(mitades[0]!)).trimStart(),
  );
  console.log(
    `   2a mitad (desde ${f(corte)})`.padEnd(32) +
      fila("", medir(mitades[1]!)).trimStart(),
  );

  // Error tipico, para no leer como diferencia lo que es ruido.
  const et = (rs: Array<{ r: number }>): number => {
    if (rs.length < 2) return 0;
    const m = rs.reduce((s, x) => s + x.r, 0) / rs.length;
    const va = rs.reduce((s, x) => s + (x.r - m) ** 2, 0) / (rs.length - 1);
    return Math.sqrt(va / rs.length);
  };
  console.log(
    `\nError tipico de la esperanza: estrategia +-${et(completa.rs).toFixed(3)}R  ` +
      `A +-${et(ctrl).toFixed(3)}R  B +-${et(volteado).toFixed(3)}R`,
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
