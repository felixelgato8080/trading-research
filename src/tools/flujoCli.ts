/**
 * ¿Aporta algo el FLUJO DE ORDENES? Las cuatro afirmaciones del modelo, medidas.
 *
 *   npm run flujo -- --lista X.json --cache=V.json [--coste=0.05]
 *
 * Se prueba lo que el modelo afirma, cada cosa con su control:
 *
 *   1. ABSORCION: mucho delta y poco recorrido predice el giro. Control: entradas al azar.
 *   2. DIVERGENCIA de CVD: el precio sube sin que el CVD acompañe y el movimiento falla.
 *   3. NODO DE BAJO VOLUMEN como zona de entrada en el retroceso.
 *   4. FILTRO DE DELTA sobre la ruptura que YA funciona: ¿la mejora exigir que el delta
 *      acompañe? Es la pregunta accionable.
 *
 * El coste va DOBLE de lo habitual en las entradas de absorcion porque son operaciones cortas y
 * el peaje pesa mas sobre un stop pequeño.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import type { VelaFlujo } from "../forex/binance";
import { evaluarPorRiesgo, informe } from "../forex/controles";
import { atr } from "../forex/multiTf";
import { volatilidad, simularRuptura } from "../forex/rupturas";
import { simularObjetivo, type SeñalTdfi } from "../forex/tdfi";
import { delta, cvd, absorcion, divergencia, perfil, nodoBajo } from "../forex/flujo";

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
function fila(nombre: string, m: M, extra = ""): string {
  return (
    `${nombre.padEnd(32)}${String(m.n).padStart(8)}${(m.wr * 100).toFixed(0).padStart(6)}%` +
    `${m.pf.toFixed(2).padStart(7)}${m.exp.toFixed(4).padStart(10)}  ${extra}`
  );
}
const CAB =
  `${"variante".padEnd(32)}${"ops".padStart(8)}${"WR".padStart(7)}${"PF".padStart(7)}${"exp R".padStart(10)}`;

async function main(): Promise<void> {
  const costeR = num("coste", 0.05);
  const cache = txt("cache");
  const lista: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--lista") + 1] ?? "", "utf-8"),
  );
  if (!cache || !existsSync(cache)) {
    console.error("Falta --cache con velas de Binance (traen el volumen agresivo)");
    process.exitCode = 1;
    return;
  }
  const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, VelaFlujo[]>;
  const datos = new Map<string, VelaFlujo[]>();
  for (const k of lista) {
    const v = g[k];
    if (v && v.length > 300 && v[0]!.compraAgresiva !== undefined) datos.set(k, v);
  }
  if (datos.size === 0) {
    console.error("La cache no trae volumen agresivo. Redescarga con binance:universo.");
    process.exitCode = 1;
    return;
  }
  const conDelta = [...datos.values()].flat().filter((v) => delta(v) != null).length;
  const total = [...datos.values()].reduce((s, v) => s + v.length, 0);
  console.log(
    `${datos.size} instrumentos · ${total.toLocaleString("es")} velas · ` +
      `${((conDelta / total) * 100).toFixed(0)}% con delta · coste ${(costeR * 100).toFixed(0)}%\n`,
  );

  // ---- 1. ABSORCION -------------------------------------------------------------------
  console.log("1. ABSORCION: mucho delta con poco recorrido, ¿predice el giro?");
  console.log(CAB);
  console.log("-".repeat(64));

  let mejorAbs: { minD: number; maxRec: number; objetivo: number; exp: number } | null = null;
  for (const [minD, maxRec] of [[2, 0.3], [3, 0.3], [3, 0.2], [4, 0.3]] as Array<[number, number]>) {
    for (const objetivo of [2]) {
      const res: number[] = [];
      const ctrl: number[] = [];
      const rnd = azar(7 + minD * 10 + maxRec * 100);
      for (const [, v] of datos) {
        const a = atr(v, 14);
        const señales = absorcion(v, a, 20, minD, maxRec);
        for (const s of señales) {
          const av = a[s.i];
          if (av == null || !(av > 0)) continue;
          const sig: SeñalTdfi = { i: s.i, direccion: s.direccion, riesgo: av * 1.5 };
          const r = simularObjetivo(v, sig, objetivo, costeR * sig.riesgo, 20, true);
          if (r) res.push(r.r);
        }
        // Control: mismas velas, mismo stop, misma cantidad, entrada y direccion al azar.
        for (let k = 0; k < señales.length; k += 1) {
          const i = 50 + Math.floor(rnd() * (v.length - 60));
          const av = a[i];
          if (av == null || !(av > 0)) continue;
          const sig: SeñalTdfi = {
            i, direccion: rnd() < 0.5 ? "LARGO" : "CORTO", riesgo: av * 1.5,
          };
          const r = simularObjetivo(v, sig, objetivo, costeR * sig.riesgo, 20, true);
          if (r) ctrl.push(r.r);
        }
      }
      const m = medir(res);
      console.log(fila(`delta >${minD}x · recorrido <${maxRec}`, m));
      console.log(fila(`  AZAR`, medir(ctrl)));
      if (m.n > 30 && (!mejorAbs || m.exp > mejorAbs.exp)) {
        mejorAbs = { minD, maxRec, objetivo, exp: m.exp };
      }
    }
  }

  // ---- LA BATERIA ENTERA sobre la mejor absorcion -----------------------------------------
  //
  // Arriba solo habia UN control, el de entradas al azar. Faltaban los otros tres: si aporta
  // acertar el LADO, si se sostiene en las dos mitades del calendario, y si depende de un solo
  // instrumento.
  //
  // Sobre la MEJOR de las cuatro combinaciones a proposito: es la que uno se quedaria, o sea la
  // que ya viene elegida por haber mirado los resultados, y por eso es la que hay que apretar.
  if (mejorAbs) {
    const { minD, maxRec, objetivo } = mejorAbs;
    console.log(`\nLA BATERIA ENTERA sobre la mejor: delta >${minD}x · recorrido <${maxRec}`);
    console.log(
      informe(evaluarPorRiesgo(
        new Map([...datos].map(([k, v]) => [k, v as Vela[]])),
        (v) => atr(v, 14),
        (_par, v) => {
          const a = atr(v, 14);
          const out: SeñalTdfi[] = [];
          for (const x of absorcion(v as VelaFlujo[], a, 20, minD, maxRec)) {
            const av = a[x.i];
            if (av == null || !(av > 0)) continue;
            out.push({ i: x.i, direccion: x.direccion, riesgo: av * 1.5 });
          }
          return out;
        },
        objetivo,
        (v, x, objetivoR) => simularObjetivo(v, x, objetivoR, costeR * x.riesgo, 20, true),
      )),
    );
  }

  // ---- 2. DIVERGENCIA DE CVD ----------------------------------------------------------
  console.log("\n2. DIVERGENCIA de CVD: precio que se mueve sin que el flujo acompañe");
  console.log(CAB);
  console.log("-".repeat(64));

  for (const [ventana, umbral] of [[10, 0.5], [10, 0.8], [20, 0.5], [20, 0.8]] as Array<[number, number]>) {
    const res: number[] = [];
    const ctrl: number[] = [];
    const rnd = azar(99 + ventana + umbral * 10);
    for (const [, v] of datos) {
      const a = atr(v, 14);
      const d = divergencia(v, cvd(v), ventana);
      let n = 0;
      for (let i = ventana + 1; i < v.length; i += 1) {
        const hoy = d[i], ayer = d[i - 1];
        if (hoy == null || ayer == null) continue;
        // Cruce del umbral, no estado: si no, un tramo divergente da veinte señales iguales.
        let dir: "LARGO" | "CORTO" | null = null;
        if (ayer <= umbral && hoy > umbral) dir = "CORTO";
        else if (ayer >= -umbral && hoy < -umbral) dir = "LARGO";
        if (!dir) continue;
        const av = a[i];
        if (av == null || !(av > 0)) continue;
        const r = simularObjetivo(v, { i, direccion: dir, riesgo: av * 1.5 }, 2, costeR * av * 1.5, 20, true);
        if (r) { res.push(r.r); n += 1; }
      }
      for (let k = 0; k < n; k += 1) {
        const i = 50 + Math.floor(rnd() * (v.length - 60));
        const av = a[i];
        if (av == null || !(av > 0)) continue;
        const r = simularObjetivo(
          v, { i, direccion: rnd() < 0.5 ? "LARGO" : "CORTO", riesgo: av * 1.5 },
          2, costeR * av * 1.5, 20, true,
        );
        if (r) ctrl.push(r.r);
      }
    }
    console.log(fila(`divergencia ${ventana}v >${umbral}`, medir(res)));
    console.log(fila(`  AZAR`, medir(ctrl)));
  }

  // ---- 3. LA PREGUNTA ACCIONABLE: ¿mejora la ruptura que ya funciona? ------------------
  console.log("\n3. RUPTURA DE VOLATILIDAD con y sin filtro de DELTA");
  console.log(CAB);
  console.log("-".repeat(64));

  // Antes de filtrar hay que saber cuanto vale el delta de verdad. La primera version de esta
  // prueba uso umbrales de 0,1 a 0,3 y solo pasaban 65 de 1.160 señales: en velas diarias de
  // cripto el volumen agresivo esta casi equilibrado aunque el precio se mueva mucho, asi que
  // esos umbrales eran extremos sin querer. Calibrar antes de medir.
  const ratios: number[] = [];
  for (const [, v] of datos) {
    const a = atr(v, 14);
    for (const sig of volatilidad(v, a, 2)) {
      const vela = v[sig.i]!;
      const d = delta(vela);
      if (d != null && vela.v != null && vela.v > 0) {
        ratios.push(sig.direccion === "LARGO" ? d / vela.v : -d / vela.v);
      }
    }
  }
  ratios.sort((x, y) => x - y);
  const pct = (q: number): number => ratios[Math.floor(ratios.length * q)] ?? 0;
  console.log(
    `   Delta relativo A FAVOR en las velas de ruptura: mediana ${pct(0.5).toFixed(3)} · ` +
      `p25 ${pct(0.25).toFixed(3)} · p75 ${pct(0.75).toFixed(3)} · p90 ${pct(0.9).toFixed(3)}`,
  );
  console.log(
    `   ${((ratios.filter((x) => x > 0).length / ratios.length) * 100).toFixed(0)}% de las ` +
      `rupturas ya tienen el delta a favor.
`,
  );

  for (const minDeltaRel of [0, pct(0.25), pct(0.5), pct(0.75)]) {
    const porInstr = new Map<string, number[]>();
    for (const [s, v] of datos) {
      const a = atr(v, 14);
      const rs: number[] = [];
      for (const sig of volatilidad(v, a, 2)) {
        if (minDeltaRel > 0) {
          const vela = v[sig.i]!;
          const d = delta(vela);
          if (d == null || vela.v == null || !(vela.v > 0)) continue;
          const rel = d / vela.v;
          // El delta tiene que ir A FAVOR de la ruptura y con fuerza.
          if (sig.direccion === "LARGO" ? rel < minDeltaRel : rel > -minDeltaRel) continue;
        }
        const av = a[sig.i];
        if (av == null || !(av > 0)) continue;
        const stop = av * 2;
        const r = simularRuptura(v, sig, stop, 2, (costeR * stop) / 2, 0);
        if (r) rs.push(r.r);
      }
      porInstr.set(s, rs);
    }
    const todas = [...porInstr.values()].flat();
    const mejor = [...porInstr.entries()].sort(
      (x, y) => y[1].reduce((k, z) => k + z, 0) - x[1].reduce((k, z) => k + z, 0),
    )[0]?.[0];
    const sm = [...porInstr.entries()].filter(([q]) => q !== mejor).flatMap(([, x]) => x);
    const sinMejor = sm.length ? sm.reduce((s, x) => s + x, 0) / sm.length : 0;
    const enVerde = [...porInstr.values()].filter((l) => l.length > 5 && l.reduce((s, x) => s + x, 0) > 0).length;
    console.log(
      fila(
        minDeltaRel === 0 ? "sin filtro de delta" : `  delta a favor >${minDeltaRel.toFixed(3)}`,
        medir(todas),
        `sin mejor ${sinMejor.toFixed(3)} · ${enVerde}/${porInstr.size}`,
      ),
    );
  }

  // ---- 4. NODO DE BAJO VOLUMEN --------------------------------------------------------
  console.log("\n4. NODO DE BAJO VOLUMEN como zona de entrada tras el impulso");
  console.log(CAB);
  console.log("-".repeat(64));

  for (const tramo of [20, 40]) {
    const res: number[] = [];
    const ctrl: number[] = [];
    const rnd = azar(555 + tramo);
    for (const [, v] of datos) {
      const a = atr(v, 14);
      let n = 0;
      for (const sig of volatilidad(v, a, 2)) {
        const desde = Math.max(0, sig.i - tramo);
        const nodo = nodoBajo(perfil(v, desde, sig.i, 30));
        const av = a[sig.i];
        if (nodo == null || av == null || !(av > 0)) continue;
        // Se espera el retroceso al nodo: se busca la vela que lo toca, sin pasar de 20 velas.
        let entrada = -1;
        for (let j = sig.i + 1; j < Math.min(v.length, sig.i + 21); j += 1) {
          if (v[j]!.l <= nodo && v[j]!.h >= nodo) { entrada = j; break; }
        }
        if (entrada < 0) continue;
        const r = simularObjetivo(
          v, { i: entrada, direccion: sig.direccion, riesgo: av * 1.5 },
          2, costeR * av * 1.5, 20, true,
        );
        if (r) { res.push(r.r); n += 1; }
      }
      for (let k = 0; k < n; k += 1) {
        const i = 50 + Math.floor(rnd() * (v.length - 60));
        const av = a[i];
        if (av == null || !(av > 0)) continue;
        const r = simularObjetivo(
          v, { i, direccion: rnd() < 0.5 ? "LARGO" : "CORTO", riesgo: av * 1.5 },
          2, costeR * av * 1.5, 20, true,
        );
        if (r) ctrl.push(r.r);
      }
    }
    console.log(fila(`retroceso al nodo (${tramo}v)`, medir(res)));
    console.log(fila(`  AZAR`, medir(ctrl)));
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
