/**
 * La estrategia de smart money del video, medida.
 *
 *   npm run smc -- --lista X.json --cache=V.json [--costebps=3] [--maxvelas=24] [--objetivo=2]
 *
 * LO QUE SE QUIERE SABER, en este orden
 * -------------------------------------
 *   1. ¿Aportan algo los DOS VETOS? Es la unica pieza nueva del metodo. Se mide comparando las
 *      roturas que pasan el veto contra las que el veto rechaza. Si el veto sirve, las
 *      rechazadas tienen que ir PEOR. Si van igual, el veto es decoracion.
 *   2. ¿Le gana al azar con el mismo perfil de stop y objetivo?
 *   3. ¿Aporta acertar el LADO, o serviria igual al reves?
 *   4. ¿Aguanta las dos mitades del calendario?
 *
 * Y una pregunta propia del video: dice tomar parciales y apuntar lejos, pero tambien CERRAR
 * DENTRO DEL DIA. En este proyecto ya se midio que el resultado de esta familia vive en la cola
 * y que un techo la corta, asi que se mide con las dos ataduras.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { atr } from "../forex/multiTf";
import { simular, type SeñalZona } from "../forex/estructuraValida";
import {
  huecos, bloques, roturas, señales, type AjustesSMC,
} from "../forex/smc";

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

interface M { n: number; wr: number; pf: number; exp: number; et: number }
function medir(rs: number[]): M {
  if (!rs.length) return { n: 0, wr: 0, pf: 0, exp: 0, et: 0 };
  const g = rs.filter((x) => x > 0);
  const sg = g.reduce((s, x) => s + x, 0);
  const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  const exp = rs.reduce((s, x) => s + x, 0) / rs.length;
  const va = rs.length > 1
    ? rs.reduce((s, x) => s + (x - exp) ** 2, 0) / (rs.length - 1)
    : 0;
  return {
    n: rs.length, wr: g.length / rs.length, pf: sp > 0 ? sg / sp : 0, exp,
    et: Math.sqrt(va / rs.length),
  };
}
function fila(nombre: string, m: M, extra = ""): string {
  return (
    `${nombre.padEnd(32)}${String(m.n).padStart(6)}${(m.wr * 100).toFixed(0).padStart(6)}%` +
    `${m.pf.toFixed(2).padStart(7)}${m.exp.toFixed(3).padStart(9)}` +
    ` ±${m.et.toFixed(3)}  ${extra}`
  );
}
const CAB =
  `${"variante".padEnd(32)}${"ops".padStart(6)}${"WR".padStart(6)}${"PF".padStart(7)}` +
  `${"exp R".padStart(9)}  error`;

async function main(): Promise<void> {
  const cache = txt("cache");
  const listaRuta = process.argv[process.argv.indexOf("--lista") + 1] ?? txt("lista") ?? "";
  if (!cache || !existsSync(cache) || !existsSync(listaRuta)) {
    console.error("Hacen falta --lista RUTA.json y --cache=RUTA.json");
    process.exitCode = 1;
    return;
  }
  const costeBps = num("costebps", 3);
  const maxVelas = num("maxvelas", 24);
  // FILTRO DE SESION. Esto es day trading: se opera Londres y Nueva York. Medir tambien las
  // señales de madrugada mete horas donde el movimiento es ruido y el spread el doble, y no es
  // cuando nadie operaria esto.
  const horas = (txt("horas") ?? "").split("-").map(Number);
  const desdeH = horas.length === 2 && Number.isFinite(horas[0]!) ? horas[0]! : -1;
  const hastaH = horas.length === 2 && Number.isFinite(horas[1]!) ? horas[1]! : -1;
  const enSesion = (t0: number): boolean => {
    if (desdeH < 0) return true;
    const h = new Date(t0 * 1000).getUTCHours();
    return h >= desdeH && h < hastaH;
  };

  // LOS NUMEROS SE FIJAN AQUI, ANTES DE VER NINGUN RESULTADO. El video no da ninguno, y
  // elegirlos despues de mirar el resultado seria escoger el que sale bien.
  const AJ: AjustesSMC = {
    minHueco: num("minhueco", 0.2),
    minEmpuje: num("empuje", 1.5),
    vigencia: num("vigencia", 60),
    esperaBloque: num("espera", 20),
    colchon: num("colchon", 0.1),
    objetivoR: num("objetivo", 2),
    radioLiquidez: num("radio", 0.5),
    toquesLiquidez: num("toques", 3),
    memoriaHuecos: num("memoria", 50),
  };

  const lista: string[] = JSON.parse(readFileSync(listaRuta, "utf-8"));
  const g = JSON.parse(readFileSync(cache, "utf-8")) as Record<string, Vela[]>;
  const datos = new Map<string, Vela[]>();
  for (const k of lista) {
    const v = g[k];
    if (v && v.length > 300) datos.set(k, v);
  }
  const totalVelas = [...datos.values()].reduce((s, v) => s + v.length, 0);
  console.log(
    `${datos.size} instrumentos · ${totalVelas.toLocaleString("es")} velas · ` +
      `coste ${costeBps} pb · objetivo ${AJ.objetivoR}R · tope ${maxVelas} velas\n`,
  );

  const correr = (aj: AjustesSMC) => {
    const rs: number[] = [];
    const porInstr = new Map<string, number[]>();
    for (const [s, v] of datos) {
      const a = atr(v, 14);
      const propias: number[] = [];
      for (const x of señales(v, a, aj)) {
        if (!enSesion(v[x.i]!.t)) continue;
        const r = simular(v, x, (x.entrada * costeBps) / 10_000, maxVelas);
        if (r) { rs.push(r.r); propias.push(r.r); }
      }
      porInstr.set(s, propias);
    }
    const verde = [...porInstr.values()].filter(
      (l) => l.length > 3 && l.reduce((s, x) => s + x, 0) > 0,
    ).length;
    return { rs, verde, total: porInstr.size };
  };

  console.log("PASO A PASO");
  console.log(CAB);
  console.log("-".repeat(78));

  const sinVetos = correr({ ...AJ, aplicarVetos: false });
  console.log(fila("1. sin vetos", medir(sinVetos.rs), `${sinVetos.verde}/${sinVetos.total} verde`));

  const conVetos = correr(AJ);
  console.log(fila("2. + los dos vetos", medir(conVetos.rs), `${conVetos.verde}/${conVetos.total} verde`));

  // ---- LO QUE EL VETO RECHAZA: la prueba directa de si el veto sirve ----------------------
  //
  // No basta con que la version con vetos vaya mejor: con menos operaciones cualquier cosa
  // puede parecer mejor por azar. Lo que decide es si lo RECHAZADO va peor que lo aceptado.
  const rechazadas: number[] = [];
  const porMotivo = new Map<string, number[]>();
  for (const [, v] of datos) {
    const a = atr(v, 14);
    const hs = huecos(v, AJ.minHueco, a);
    const bs = bloques(v, a, AJ);
    for (const r of roturas(v, bs, hs, a, AJ)) {
      if (!r.vetada) continue;
      // Se simula la operacion que el veto impidio, con las mismas reglas.
      const nuevo = bs.find(
        (b) => b.lado === r.direccion && b.conocidoEn > r.i && b.conocidoEn - r.i <= AJ.esperaBloque,
      );
      if (!nuevo) continue;
      const altura = nuevo.alto - nuevo.bajo;
      if (!(altura > 0)) continue;
      const largo = r.direccion === "ALCISTA";
      const entrada = largo ? nuevo.alto : nuevo.bajo;
      const stop = largo ? nuevo.bajo - altura * AJ.colchon : nuevo.alto + altura * AJ.colchon;
      const riesgo = Math.abs(entrada - stop);
      if (!(riesgo > 0)) continue;
      for (
        let j = nuevo.conocidoEn + 1;
        j < Math.min(v.length, nuevo.conocidoEn + 1 + AJ.vigencia);
        j += 1
      ) {
        const c = v[j]!;
        if (largo ? c.l > entrada : c.h < entrada) continue;
        // El mismo filtro de sesion que las aceptadas, o la comparacion no vale nada.
        if (!enSesion(c.t)) break;
        const s: SeñalZona = {
          i: j, direccion: largo ? "LARGO" : "CORTO", entrada, stop,
          objetivo: largo ? entrada + riesgo * AJ.objetivoR : entrada - riesgo * AJ.objetivoR,
          rr: AJ.objetivoR,
        };
        const res = simular(v, s, (entrada * costeBps) / 10_000, maxVelas);
        if (res) {
          rechazadas.push(res.r);
          const l = porMotivo.get(r.motivoVeto!) ?? [];
          l.push(res.r);
          porMotivo.set(r.motivoVeto!, l);
        }
        break;
      }
    }
  }
  console.log(fila("   lo que el VETO RECHAZO", medir(rechazadas), "tiene que ir PEOR que la 2"));
  for (const [motivo, l] of porMotivo) {
    console.log(fila(`     por ${motivo.toLowerCase()}`, medir(l)));
  }

  // ---- Controles ---------------------------------------------------------------------------
  const mBase = medir(conVetos.rs);
  const rnd = azar(20260907);
  const ctrl: number[] = [];
  const porCoin = Math.max(1, Math.round((mBase.n / Math.max(1, datos.size)) * 20));
  for (const [, v] of datos) {
    const a = atr(v, 14);
    for (let k = 0; k < porCoin; k += 1) {
      const i = 50 + Math.floor(rnd() * Math.max(1, v.length - 250));
      const av = a[i];
      if (av == null || !(av > 0)) continue;
      if (!enSesion(v[i]!.t)) continue;
      const largo = rnd() < 0.5;
      const entrada = v[i]!.c;
      const riesgo = av * 1.5;
      const s: SeñalZona = {
        i, direccion: largo ? "LARGO" : "CORTO", entrada,
        stop: largo ? entrada - riesgo : entrada + riesgo,
        objetivo: largo ? entrada + riesgo * AJ.objetivoR : entrada - riesgo * AJ.objetivoR,
        rr: AJ.objetivoR,
      };
      const r = simular(v, s, (entrada * costeBps) / 10_000, maxVelas, "NINGUNO");
      if (r) ctrl.push(r.r);
    }
  }
  console.log(fila("   AZAR mismo perfil", medir(ctrl)));

  const alReves: number[] = [];
  for (const [, v] of datos) {
    const a = atr(v, 14);
    for (const x of señales(v, a, AJ)) {
      if (!enSesion(v[x.i]!.t)) continue;
      const largo = x.direccion === "CORTO";
      const riesgo = Math.abs(x.entrada - x.stop);
      const s: SeñalZona = {
        i: x.i, direccion: largo ? "LARGO" : "CORTO", entrada: x.entrada,
        stop: largo ? x.entrada - riesgo : x.entrada + riesgo,
        objetivo: largo ? x.entrada + riesgo * AJ.objetivoR : x.entrada - riesgo * AJ.objetivoR,
        rr: AJ.objetivoR,
      };
      // El extremo valido de la vela de entrada lo fija el viaje del precio, que es el de la
      // señal ORIGINAL. Deducirlo del lado volteado mataria el control con un extremo ya pasado.
      const r = simular(
        v, s, (x.entrada * costeBps) / 10_000, maxVelas,
        x.direccion === "LARGO" ? "MINIMO" : "MAXIMO",
      );
      if (r) alReves.push(r.r);
    }
  }
  console.log(fila("   MISMA SEÑAL AL REVES", medir(alReves)));

  // ---- Las dos mitades ----------------------------------------------------------------------
  const tiempos = [...datos.values()].flat().map((x) => x.t).sort((a, b) => a - b);
  const corte = tiempos[Math.floor(tiempos.length / 2)] ?? 0;
  const mitades: number[][] = [[], []];
  for (const [, v] of datos) {
    const a = atr(v, 14);
    for (const x of señales(v, a, AJ)) {
      if (!enSesion(v[x.i]!.t)) continue;
      const r = simular(v, x, (x.entrada * costeBps) / 10_000, maxVelas);
      if (r) mitades[v[x.i]!.t < corte ? 0 : 1]!.push(r.r);
    }
  }
  const f = (n: number) => new Date(n * 1000).toISOString().slice(0, 7);
  console.log(fila(`   1a mitad (hasta ${f(corte)})`, medir(mitades[0]!)));
  console.log(fila(`   2a mitad (desde ${f(corte)})`, medir(mitades[1]!)));

  const eq = 1 / (1 + AJ.objetivoR);
  console.log(
    `\nAcierto necesario para no perder con objetivo ${AJ.objetivoR}R: ${(eq * 100).toFixed(0)}%.\n` +
      "El veto solo sirve si lo que RECHAZA va peor que lo que deja pasar. Que la version con\n" +
      "vetos salga mejor no basta: con menos operaciones cualquier cosa lo parece.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
