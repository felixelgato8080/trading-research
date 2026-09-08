/**
 * Familia de ALTO ACIERTO: ¿puede dar PF>1 con ganadoras pequeñas?
 *
 *   npm run reversion -- --lista etf_ok.json [--coste=0.05] [--desde=] [--hasta=] [--cache=f.json]
 *
 * La ruptura da 25% de acierto con ganadoras de 3,6R. Esta es la contraria: 60-80% de acierto
 * con ganadoras chicas. Las dos pueden dar PF>1 y lo que decide es la aritmetica, no la
 * sensacion de acertar mucho.
 *
 * LA PRUEBA QUE DECIDE: EL CONTROL DE DERIVA
 * ------------------------------------------
 * Comprar acciones y soltarlas a los tres dias gana dinero aunque la señal sea una moneda al
 * aire, porque las acciones suben con el tiempo. Por eso se mide una variante que entra TODOS
 * los dias en que el filtro de tendencia es cierto, sin mirar el RSI. Si el RSI no supera a ese
 * control, el RSI no aporta nada y lo unico que se ha medido es el mercado alcista.
 *
 * Es la misma trampa que ya tumbo hallazgos antes en este proyecto.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { velas, type Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { rsi } from "../forex/rsi";
import {
  sma,
  retrocesoEnTendencia,
  huecoBajista,
  simularReversion,
  type SeñalReversion,
} from "../forex/reversion";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(n: string, d: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  if (!m) return d;
  const v = Number(m.split("=")[1]);
  return Number.isFinite(v) ? v : d;
}
function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}

/** Entra todos los dias con tendencia alcista. Es el control, no una estrategia. */
function soloTendencia(velas: Vela[], periodoMedia: number): SeñalReversion[] {
  const cierres = velas.map((v) => v.c);
  const m = sma(cierres, periodoMedia);
  const out: SeñalReversion[] = [];
  for (let i = 0; i < velas.length; i += 1) {
    const mv = m[i];
    if (mv != null && cierres[i]! > mv) out.push({ i, direccion: "LARGO" });
  }
  return out;
}

interface Variante {
  nombre: string;
  señales: (v: Vela[], a: (number | null)[]) => SeñalReversion[];
  atrStop: number;
  maxVelas: number;
  /** Umbral de RSI(2) para salir. 0 = solo sale por cierre sobre el maximo de ayer. */
  salirRsi: number;
  control?: boolean;
}

interface Fila {
  nombre: string; n: number; wr: number; pf: number; exp: number;
  rGana: number; rPierde: number; velas: number;
  sinMejor: number; enVerde: number; total: number;
  expA: number; expB: number; nA: number; nB: number;
  control: boolean;
}

function resumen(rs: number[]): { wr: number; pf: number; exp: number; rGana: number; rPierde: number } {
  const g = rs.filter((x) => x > 0);
  const p = rs.filter((x) => x <= 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -p.reduce((s, x) => s + x, 0);
  return {
    wr: rs.length ? g.length / rs.length : 0,
    pf: sp > 0 ? sg / sp : 0,
    exp: rs.length ? rs.reduce((s, x) => s + x, 0) / rs.length : 0,
    rGana: g.length ? sg / g.length : 0,
    rPierde: p.length ? -sp / p.length : 0,
  };
}

async function main(): Promise<void> {
  const costeR = arg("coste", 0.05);
  const desde = txt("desde");
  const hasta = txt("hasta");
  const cache = txt("cache");
  const tD = desde ? Date.parse(desde) / 1000 : 0;
  const tH = hasta ? Date.parse(hasta) / 1000 : Infinity;

  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );
  console.log(
    `${lista.length} instrumentos · coste ${(costeR * 100).toFixed(1)}% del riesgo · ` +
      `${desde ?? "inicio"} a ${hasta ?? "hoy"}\n`,
  );

  const datos = new Map<string, Vela[]>();
  if (cache && existsSync(cache)) {
    const guardado = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
    for (const k of lista) {
      const v = guardado[k];
      if (!v) continue;
      const f = v.filter((x) => x.t >= tD && x.t <= tH);
      if (f.length > 250) datos.set(k, f);
    }
    console.log(`${datos.size} desde cache\n`);
  } else {
    const crudo: Record<string, Vela[]> = {};
    for (const s of lista) {
      try {
        const v = await velas(s, "1d");
        crudo[s] = v;
        const f = v.filter((x) => x.t >= tD && x.t <= tH);
        if (f.length > 250) datos.set(s, f);
      } catch { /* se salta */ }
      await dormir(400);
    }
    if (cache) writeFileSync(cache, JSON.stringify(crudo));
    console.log(`${datos.size} con datos\n`);
  }

  // El corte de fuera de muestra: la mitad del calendario, no la mitad de las operaciones.
  const todosT = [...datos.values()].flatMap((v) => [v[0]!.t, v[v.length - 1]!.t]);
  const corte = (Math.min(...todosT) + Math.max(...todosT)) / 2;
  const fecha = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
  console.log(`Corte fuera de muestra: ${fecha(corte)}\n`);

  const variantes: Variante[] = [
    { nombre: "CONTROL solo tendencia", señales: (v) => soloTendencia(v, 200), atrStop: 3, maxVelas: 10, salirRsi: 0, control: true },
    { nombre: "CONTROL sin filtro nada", señales: (v) => v.map((_, i) => ({ i, direccion: "LARGO" as const })), atrStop: 3, maxVelas: 10, salirRsi: 0, control: true },
    { nombre: "RSI2<10 en tendencia", señales: (v) => retrocesoEnTendencia(v, 2, 10, 200, true), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI2<5 en tendencia", señales: (v) => retrocesoEnTendencia(v, 2, 5, 200, true), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI2<20 en tendencia", señales: (v) => retrocesoEnTendencia(v, 2, 20, 200, true), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI2<10 SIN tendencia", señales: (v) => retrocesoEnTendencia(v, 2, 10, 200, false), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI4<15 en tendencia", señales: (v) => retrocesoEnTendencia(v, 4, 15, 200, true), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI4<10 en tendencia", señales: (v) => retrocesoEnTendencia(v, 4, 10, 200, true), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI4<20 en tendencia", señales: (v) => retrocesoEnTendencia(v, 4, 20, 200, true), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI3<15 en tendencia", señales: (v) => retrocesoEnTendencia(v, 3, 15, 200, true), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI5<15 en tendencia", señales: (v) => retrocesoEnTendencia(v, 5, 15, 200, true), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI2<10 · media 50", señales: (v) => retrocesoEnTendencia(v, 2, 10, 50, true), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI2<10 · stop 2 ATR", señales: (v) => retrocesoEnTendencia(v, 2, 10, 200, true), atrStop: 2, maxVelas: 10, salirRsi: 0 },
    { nombre: "RSI2<10 · sin tope", señales: (v) => retrocesoEnTendencia(v, 2, 10, 200, true), atrStop: 3, maxVelas: 0, salirRsi: 0 },
    { nombre: "RSI2<10 · salir RSI>70", señales: (v) => retrocesoEnTendencia(v, 2, 10, 200, true), atrStop: 3, maxVelas: 20, salirRsi: 70 },
    { nombre: "hueco 1 ATR en tendencia", señales: (v, a) => huecoBajista(v, a, 1, sma(v.map((x) => x.c), 200)), atrStop: 3, maxVelas: 10, salirRsi: 0 },
    { nombre: "hueco 0.5 ATR en tendencia", señales: (v, a) => huecoBajista(v, a, 0.5, sma(v.map((x) => x.c), 200)), atrStop: 3, maxVelas: 10, salirRsi: 0 },
  ];

  console.log(
    `${"variante".padEnd(28)}${"ops".padStart(7)}${"WR".padStart(6)}${"PF".padStart(7)}` +
      `${"exp R".padStart(9)}${"Rgana".padStart(8)}${"Rpierde".padStart(9)}` +
      `${"dias".padStart(6)}${"1a mitad".padStart(10)}${"2a mitad".padStart(10)}` +
      `${"sin mejor".padStart(11)}${"en verde".padStart(11)}`,
  );
  console.log("-".repeat(122));

  const filas: Fila[] = [];

  for (const va of variantes) {
    const porInstr = new Map<string, number[]>();
    const mitadA: number[] = [];
    const mitadB: number[] = [];
    let sumaVelas = 0;
    let nVelas = 0;

    for (const [s, v] of datos) {
      const a = atr(v, 14);
      const r2 = va.salirRsi > 0 ? rsi(v.map((x) => x.c), 2) : null;
      const rs: number[] = [];
      for (const sig of va.señales(v, a)) {
        const av = a[sig.i];
        if (av == null || !(av > 0)) continue;
        const stop = av * va.atrStop;
        const r = simularReversion(v, sig, stop, (costeR * stop) / 2, va.maxVelas, r2, va.salirRsi);
        if (!r) continue;
        rs.push(r.r);
        sumaVelas += r.velas;
        nVelas += 1;
        (v[sig.i]!.t < corte ? mitadA : mitadB).push(r.r);
      }
      porInstr.set(s, rs);
    }

    const todas = [...porInstr.values()].flat();
    if (todas.length < 100) {
      console.log(`${va.nombre.padEnd(28)}${String(todas.length).padStart(7)}   (muestra corta)`);
      continue;
    }
    const m = resumen(todas);
    const mejor = [...porInstr.entries()].sort(
      (a, b) => b[1].reduce((s, x) => s + x, 0) - a[1].reduce((s, x) => s + x, 0),
    )[0]?.[0];
    const sm = [...porInstr.entries()].filter(([q]) => q !== mejor).flatMap(([, x]) => x);

    const f: Fila = {
      nombre: va.nombre, n: todas.length, ...m,
      velas: nVelas ? sumaVelas / nVelas : 0,
      sinMejor: sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0,
      enVerde: [...porInstr.values()].filter((l) => l.length > 5 && l.reduce((s, x) => s + x, 0) > 0).length,
      total: porInstr.size,
      expA: resumen(mitadA).exp, expB: resumen(mitadB).exp,
      nA: mitadA.length, nB: mitadB.length,
      control: va.control === true,
    };
    filas.push(f);
    console.log(
      `${f.nombre.padEnd(28)}${String(f.n).padStart(7)}${(f.wr * 100).toFixed(0).padStart(5)}%` +
        `${f.pf.toFixed(2).padStart(7)}${f.exp.toFixed(3).padStart(9)}` +
        `${f.rGana.toFixed(2).padStart(8)}${f.rPierde.toFixed(2).padStart(9)}` +
        `${f.velas.toFixed(1).padStart(6)}${f.expA.toFixed(3).padStart(10)}${f.expB.toFixed(3).padStart(10)}` +
        `${f.sinMejor.toFixed(3).padStart(11)}${(f.enVerde + "/" + f.total).padStart(11)}`,
    );
  }

  console.log("-".repeat(122));

  const ctrl = filas.find((f) => f.nombre === "CONTROL solo tendencia");
  if (ctrl) {
    console.log(
      `Control (entrar cada dia con tendencia, sin mirar el RSI): ${ctrl.exp.toFixed(3)}R por operacion.`,
    );
    console.log("Una variante solo aporta algo si SUPERA esta cifra. Lo demas es la subida del mercado.\n");
  }

  const umbral = ctrl ? ctrl.exp : 0;
  const buenas = filas
    .filter((f) => !f.control && f.sinMejor > 0 && f.expA > 0 && f.expB > 0 && f.exp > umbral)
    .sort((a, b) => b.exp - a.exp);

  if (buenas.length === 0) {
    console.log(
      "Ninguna variante pasa las tres pruebas a la vez (sin su mejor instrumento, las dos mitades, y el control).",
    );
  } else {
    console.log("Pasan las tres pruebas Y superan al control:");
    for (const f of buenas) {
      console.log(
        `  ${f.nombre.padEnd(28)} PF ${f.pf.toFixed(2)} · ${f.exp.toFixed(3)}R (control ${umbral.toFixed(3)}) · ` +
          `WR ${(f.wr * 100).toFixed(0)}% · mitades ${f.expA.toFixed(3)}/${f.expB.toFixed(3)} · ` +
          `${f.enVerde}/${f.total} instrumentos · ${f.n} ops`,
      );
    }
  }
  console.log(`\nCombinaciones probadas: ${variantes.length} (2 son controles).`);
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
