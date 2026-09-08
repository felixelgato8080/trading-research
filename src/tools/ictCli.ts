/**
 * La estrategia de barrido + IFVG, medida con sus reglas y con cada ingrediente aislado.
 *
 *   npm run ict -- --lista X.json --cache=V.json [--coste=0.05] [--tf=5m]
 *
 * POR QUE SE AISLA CADA INGREDIENTE
 * ---------------------------------
 * La estrategia junta tres cosas: barrido de liquidez, IFVG y ventana horaria. Si el conjunto
 * sale positivo hay que saber CUAL de las tres lo produce, porque si la ventaja viniera solo del
 * barrido, el IFVG seria decoracion. Y si sale negativo, hay que saber si es que una pieza
 * estropea a las otras.
 *
 * Controles: entradas al azar con el mismo stop y el mismo objetivo, y las mismas ventanas.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import {
  señales, barridos, fvgs, simular, unaPorSesion, enVentana,
  type AjustesIct, type SeñalIct,
} from "../forex/ict";

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
  return (
    `${nombre.padEnd(30)}${String(m.n).padStart(7)}${(m.wr * 100).toFixed(0).padStart(6)}%` +
    `${m.pf.toFixed(2).padStart(7)}${m.exp.toFixed(3).padStart(9)}${m.rr.toFixed(1).padStart(7)}  ${extra}`
  );
}
const CAB =
  `${"variante".padEnd(30)}${"ops".padStart(7)}${"WR".padStart(7)}${"PF".padStart(7)}` +
  `${"exp R".padStart(9)}${"RR".padStart(7)}`;

/** Objetivo y stop equivalentes a los de la estrategia, para que el control sea comparable. */
function señalAzar(
  velas: Vela[], i: number, dir: "LARGO" | "CORTO", a: (number | null)[], rrMedio: number,
): SeñalIct | null {
  const av = a[i];
  if (av == null || !(av > 0)) return null;
  const c = velas[i]!.c;
  const riesgo = av * 1.5;
  return {
    i,
    direccion: dir,
    stop: dir === "LARGO" ? c - riesgo : c + riesgo,
    objetivo: dir === "LARGO" ? c + riesgo * rrMedio : c - riesgo * rrMedio,
    iBarrido: i,
  };
}

async function main(): Promise<void> {
  const costeR = num("coste", 0.05);
  // Coste en puntos basicos del PRECIO. Con stops de 0,18% del precio, cobrar 0,05R eran
  // 0,009% cuando lo real en Binance es 0,10%: once veces menos de lo que cuesta.
  const costeBps = num("costebps", 0);
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
    if (v && v.length > 500) datos.set(k, v);
  }
  /** Coste de una pata: en puntos basicos del precio si se pide, si no fraccion del riesgo. */
  const costeDe = (precio: number, riesgo: number): number =>
    costeBps > 0 ? (precio * costeBps) / 10_000 / 2 : costeR * riesgo;

  const total = [...datos.values()].reduce((s, v) => s + v.length, 0);
  const primera = [...datos.values()][0] ?? [];
  const dias = primera.length
    ? (primera[primera.length - 1]!.t - primera[0]!.t) / 86400
    : 0;
  console.log(
    `${datos.size} instrumentos · ${total.toLocaleString("es")} velas · ` +
      `${dias.toFixed(0)} dias · coste ${(costeR * 100).toFixed(0)}% del riesgo\n`,
  );

  // Ventanas en UTC. Nueva York abre 9:30 ET = 13:30 UTC (14:30 en horario de verano; se usa
  // 13:30-15:00 como aproximacion, y la asiatica 00:00-01:30 UTC = 20:00 ET del dia anterior).
  const VENTANAS: Array<[string, number, number]> = [
    ["NY AM (13.5-15 UTC)", 13.5, 15],
    ["Asia (0-1.5 UTC)", 0, 1.5],
    ["sin filtro horario", 0, 24],
  ];

  const BASE: AjustesIct = {
    swing: 20, ventanaIfvg: 12, minFvg: 0.0005, desdeH: 0, hastaH: 24, colchon: 0.1,
  };

  // ---- 1. LA ESTRATEGIA COMPLETA, por ventana ------------------------------------------
  console.log("1. ESTRATEGIA COMPLETA (barrido + IFVG + una por sesion)");
  console.log(CAB);
  console.log("-".repeat(74));

  let rrGlobal = 2;
  for (const [nombre, d, h] of VENTANAS) {
    const res: Array<{ r: number; rr: number }> = [];
    const ctrl: Array<{ r: number; rr: number }> = [];
    const rnd = azar(31 + d * 10);
    for (const [, v] of datos) {
      const a = atr(v, 14);
      const ss = unaPorSesion(v, señales(v, { ...BASE, desdeH: d, hastaH: h }));
      for (const s of ss) {
        const r = simular(v, s, costeDe(v[s.i]!.c, Math.abs(v[s.i]!.c - s.stop)), 100);
        if (r) res.push({ r: r.r, rr: r.rr });
      }
      for (let k = 0; k < ss.length; k += 1) {
        let i = 50 + Math.floor(rnd() * (v.length - 150));
        // El control tiene que caer en la MISMA ventana horaria, o compara otra cosa.
        let intentos = 0;
        while (!enVentana(v[i]!.t, d, h) && intentos < 200) {
          i = 50 + Math.floor(rnd() * (v.length - 150));
          intentos += 1;
        }
        const falsa = señalAzar(v, i, rnd() < 0.5 ? "LARGO" : "CORTO", a, rrGlobal);
        if (!falsa) continue;
        const r = simular(v, falsa, costeDe(v[i]!.c, Math.abs(v[i]!.c - falsa.stop)), 100);
        if (r) ctrl.push({ r: r.r, rr: r.rr });
      }
    }
    const m = medir(res);
    if (nombre.startsWith("sin filtro") && m.rr > 0) rrGlobal = m.rr;
    console.log(fila(nombre, m));
    console.log(fila(`  AZAR misma ventana`, medir(ctrl)));
  }

  // ---- 2. CADA INGREDIENTE POR SEPARADO ------------------------------------------------
  console.log("\n2. ¿QUE INGREDIENTE APORTA? (sin filtro horario, todas las señales)");
  console.log(CAB);
  console.log("-".repeat(74));

  // (a) Solo barrido: entrar en el cierre del barrido, mismo stop y objetivo.
  {
    const res: Array<{ r: number; rr: number }> = [];
    for (const [, v] of datos) {
      for (const b of barridos(v, BASE.swing)) {
        const largo = b.direccion === "LARGO";
        const c = v[b.i]!.c;
        const riesgo = Math.abs(c - b.extremo);
        if (!(riesgo > 0)) continue;
        let objetivo = largo ? -Infinity : Infinity;
        for (let k = Math.max(0, b.i - BASE.swing); k < b.i; k += 1) {
          objetivo = largo ? Math.max(objetivo, v[k]!.h) : Math.min(objetivo, v[k]!.l);
        }
        if (!Number.isFinite(objetivo)) continue;
        if (largo ? objetivo <= c : objetivo >= c) continue;
        const s: SeñalIct = {
          i: b.i, direccion: b.direccion, iBarrido: b.i, objetivo,
          stop: largo ? b.extremo - riesgo * BASE.colchon : b.extremo + riesgo * BASE.colchon,
        };
        const r = simular(v, s, costeDe(c, riesgo), 100);
        if (r) res.push({ r: r.r, rr: r.rr });
      }
    }
    console.log(fila("solo BARRIDO", medir(res)));
  }

  // (b) Solo IFVG: entrar al invalidarse un hueco, sin exigir barrido previo.
  {
    const res: Array<{ r: number; rr: number }> = [];
    for (const [, v] of datos) {
      const a = atr(v, 14);
      const huecos = fvgs(v, BASE.minFvg);
      for (const f of huecos) {
        for (let j = f.i + 1; j <= Math.min(v.length - 1, f.i + BASE.ventanaIfvg); j += 1) {
          const alcista = f.direccion === "ALCISTA";
          // Un hueco alcista invalidado (cierre por debajo) da CORTO, y al reves.
          const invalidado = alcista ? v[j]!.c < f.bajo : v[j]!.c > f.alto;
          if (!invalidado) continue;
          const dir = alcista ? "CORTO" : "LARGO";
          const falsa = señalAzar(v, j, dir, a, rrGlobal);
          if (falsa) {
            const r = simular(v, falsa, costeDe(v[j]!.c, Math.abs(v[j]!.c - falsa.stop)), 100);
            if (r) res.push({ r: r.r, rr: r.rr });
          }
          break;
        }
      }
    }
    console.log(fila("solo IFVG", medir(res)));
  }

  // (c) Los dos juntos, que es la estrategia sin el filtro horario ni el tope diario.
  {
    const res: Array<{ r: number; rr: number }> = [];
    for (const [, v] of datos) {
      for (const s of señales(v, BASE)) {
        const r = simular(v, s, costeDe(v[s.i]!.c, Math.abs(v[s.i]!.c - s.stop)), 100);
        if (r) res.push({ r: r.r, rr: r.rr });
      }
    }
    console.log(fila("BARRIDO + IFVG", medir(res)));
  }

  // ---- 3. VECINDARIO DE PARAMETROS -----------------------------------------------------
  console.log("\n3. VECINDARIO: ¿es una familia o un punto afortunado?");
  console.log(CAB);
  console.log("-".repeat(74));
  for (const swing of [10, 20, 40]) {
    for (const ventana of [6, 12, 24]) {
      const res: Array<{ r: number; rr: number }> = [];
      const porInstr = new Map<string, number[]>();
      for (const [nombre, v] of datos) {
        const propias: number[] = [];
        for (const s of señales(v, { ...BASE, swing, ventanaIfvg: ventana })) {
          const r = simular(v, s, costeDe(v[s.i]!.c, Math.abs(v[s.i]!.c - s.stop)), 100);
          if (r) { res.push({ r: r.r, rr: r.rr }); propias.push(r.r); }
        }
        porInstr.set(nombre, propias);
      }
      const enVerde = [...porInstr.values()].filter(
        (l) => l.length > 10 && l.reduce((s, x) => s + x, 0) > 0,
      ).length;
      console.log(
        fila(`swing ${swing} · ventana ${ventana}`, medir(res), `${enVerde}/${porInstr.size} en verde`),
      );
    }
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
