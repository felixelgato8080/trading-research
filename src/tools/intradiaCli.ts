/**
 * Opciones intradia que faltaban por medir, sobre datos de 1h ya descargados.
 *
 *   npm run intradia -- --lista X.json --cache=V.json [--coste=0.10]
 *
 * Todo se juzga por PROFIT FACTOR (pips ganados contra perdidos), no por acierto. Felix lo
 * repite y tiene razon: un 30% de acierto con ganadoras de 3R bate a un 70% con ganadoras de
 * 0,3R.
 *
 *   1. HORA DEL DIA: la ruptura que ya funciona, ¿rinde igual a las 3 de la mañana que en la
 *      apertura de Nueva York? Es un filtro gratis si la respuesta es no.
 *   2. RANGO DE APERTURA (ORB): la estrategia intradia mas documentada que existe. Estaba
 *      programada y solo se habia probado en forex, donde murio por coste.
 *   3. COMPRESION Y EXPANSION: entrar cuando el rango se estrecha y luego estalla. Es un
 *      disparador distinto al de volatilidad pura y no se habia probado.
 */
import { readFileSync, existsSync } from "node:fs";
import { velas, type Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { volatilidad, rangoApertura, simularRuptura, type SeñalRuptura } from "../forex/rupturas";

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

interface M { n: number; wr: number; pf: number; exp: number }
function medir(rs: number[]): M {
  if (!rs.length) return { n: 0, wr: 0, pf: 0, exp: 0 };
  const g = rs.filter((x) => x > 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  return {
    n: rs.length, wr: g.length / rs.length, pf: sp > 0 ? sg / sp : 0,
    exp: rs.reduce((s, x) => s + x, 0) / rs.length,
  };
}

/**
 * Compresion y expansion: el rango de las ultimas `n` velas es el mas estrecho de las ultimas
 * `m`, y entonces el precio rompe ese rango.
 *
 * Es distinto de la ruptura de volatilidad pura: alli basta con que la vela sea grande; aqui se
 * exige ADEMAS que venga de una zona de calma, que es lo que da continuidad al movimiento.
 */
function compresion(velas: Vela[], n: number, m: number): SeñalRuptura[] {
  const out: SeñalRuptura[] = [];
  const rango = (desde: number, hasta: number): { alto: number; bajo: number } => {
    let alto = -Infinity;
    let bajo = Infinity;
    for (let k = desde; k <= hasta; k += 1) {
      alto = Math.max(alto, velas[k]!.h);
      bajo = Math.min(bajo, velas[k]!.l);
    }
    return { alto, bajo };
  };

  for (let i = m; i < velas.length; i += 1) {
    const { alto, bajo } = rango(i - n, i - 1);
    const ancho = alto - bajo;
    if (!(ancho > 0)) continue;
    // ¿Es el tramo mas estrecho de la ventana larga? Se mira solo hacia atras.
    let esMinimo = true;
    for (let j = i - m; j <= i - n - 1; j += 1) {
      const r = rango(j, j + n - 1);
      if (r.alto - r.bajo < ancho) { esMinimo = false; break; }
    }
    if (!esMinimo) continue;
    const c = velas[i]!.c;
    if (c > alto) out.push({ i, direccion: "LARGO", nivel: alto });
    else if (c < bajo) out.push({ i, direccion: "CORTO", nivel: bajo });
  }
  return out;
}

async function main(): Promise<void> {
  const costeR = num("coste", 0.10);
  const cache = txt("cache");
  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );

  const datos = new Map<string, Vela[]>();
  if (cache && existsSync(cache)) {
    const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
    for (const k of lista) {
      const v = g[k];
      if (v && v.length > 1000) datos.set(k, v);
    }
  } else {
    for (const s of lista) {
      try {
        const v = await velas(s, "1h");
        if (v.length > 1000) datos.set(s, v);
      } catch { /* se salta */ }
      await dormir(400);
    }
  }
  console.log(`${datos.size} instrumentos · 1h · coste ${(costeR * 100).toFixed(0)}% del riesgo\n`);

  const evaluar = (
    gen: (v: Vela[], a: (number | null)[]) => SeñalRuptura[],
    stop: number,
    filtroHora: ((h: number) => boolean) | null,
  ): { m: M; sinMejor: number; enVerde: number; total: number } => {
    const porInstr = new Map<string, number[]>();
    for (const [s, v] of datos) {
      const a = atr(v, 14);
      const rs: number[] = [];
      for (const sig of gen(v, a)) {
        if (filtroHora && !filtroHora(new Date(v[sig.i]!.t * 1000).getUTCHours())) continue;
        const av = a[sig.i];
        if (av == null || !(av > 0)) continue;
        const st = av * stop;
        const r = simularRuptura(v, sig, st, 2, (costeR * st) / 2, 0);
        if (r) rs.push(r.r);
      }
      porInstr.set(s, rs);
    }
    const todas = [...porInstr.values()].flat();
    const mejor = [...porInstr.entries()].sort(
      (x, y) => y[1].reduce((k, z) => k + z, 0) - x[1].reduce((k, z) => k + z, 0),
    )[0]?.[0];
    const sm = [...porInstr.entries()].filter(([q]) => q !== mejor).flatMap(([, x]) => x);
    return {
      m: medir(todas),
      sinMejor: sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0,
      enVerde: [...porInstr.values()].filter((l) => l.length > 20 && l.reduce((s, x) => s + x, 0) > 0).length,
      total: porInstr.size,
    };
  };

  const linea = (nombre: string, r: ReturnType<typeof evaluar>): string =>
    `${nombre.padEnd(28)}${String(r.m.n).padStart(8)}${(r.m.wr * 100).toFixed(0).padStart(6)}%` +
    `${r.m.pf.toFixed(2).padStart(7)}${r.m.exp.toFixed(3).padStart(9)}` +
    `${r.sinMejor.toFixed(3).padStart(11)}${(r.enVerde + "/" + r.total).padStart(10)}`;

  const CAB =
    `${"variante".padEnd(28)}${"ops".padStart(8)}${"WR".padStart(7)}${"PF".padStart(7)}` +
    `${"exp R".padStart(9)}${"sin mejor".padStart(11)}${"en verde".padStart(10)}`;

  // ---- 1. HORA DEL DIA -----------------------------------------------------------------
  console.log("1. ¿IMPORTA LA HORA? (ruptura vol 2 ATR, stop 1.5)");
  console.log(CAB);
  console.log("-".repeat(72));
  const franjas: Array<[string, (h: number) => boolean]> = [
    ["todas las horas", () => true],
    ["Asia (0-7 UTC)", (h) => h >= 0 && h < 7],
    ["Europa (7-13 UTC)", (h) => h >= 7 && h < 13],
    ["apertura NY (13-17)", (h) => h >= 13 && h < 17],
    ["tarde NY (17-22)", (h) => h >= 17 && h < 22],
    ["madrugada (22-24)", (h) => h >= 22],
  ];
  for (const [nombre, f] of franjas) {
    console.log(linea(nombre, evaluar((v, a) => volatilidad(v, a, 2), 1.5, f)));
  }

  // ---- 2. RANGO DE APERTURA ------------------------------------------------------------
  console.log("\n2. RANGO DE APERTURA (ORB): rango de N velas desde la hora H, luego ruptura");
  console.log(CAB);
  console.log("-".repeat(72));
  for (const [h, n] of [[0, 3], [0, 4], [7, 3], [13, 3], [13, 4], [13, 2]] as Array<[number, number]>) {
    for (const stop of [1.5]) {
      console.log(
        linea(`ORB ${h}h · ${n} velas`, evaluar((v) => rangoApertura(v, h, n), stop, null)),
      );
    }
  }

  // ---- 3. COMPRESION Y EXPANSION -------------------------------------------------------
  console.log("\n3. COMPRESION Y EXPANSION: rango mas estrecho de la ventana, y estalla");
  console.log(CAB);
  console.log("-".repeat(72));
  for (const [n, m] of [[6, 24], [6, 48], [12, 48], [12, 96], [24, 96]] as Array<[number, number]>) {
    console.log(
      linea(`compresion ${n} de ${m}`, evaluar((v) => compresion(v, n, m), 1.5, null)),
    );
  }

  console.log("\nReferencia: la ruptura vol 2 ATR sin filtros da PF 1,40 a este coste.");
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
