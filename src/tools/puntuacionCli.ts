/**
 * ¿SIRVE DE ALGO PUNTUAR LAS CONFLUENCIAS?
 *
 *   npm run puntuacion -- --lista L.json --mayor=X.json --menor=Y.json [--costebps=0.6]
 *
 * Todos los metodos de esta familia proponen lo mismo: sumar puntos por confluencias y operar
 * solo por encima de un umbral. Aqui se comprueba, y hay tres formas de que sea falso:
 *
 *   1. La esperanza no CRECE con el score. Si un setup de 9 rinde como uno de 5, puntuar no
 *      ordena nada y el umbral solo recorta muestra.
 *   2. Un factor concreto no separa: los que lo tienen rinden igual que los que no.
 *   3. La pendiente existe pero es ruido: con pocas operaciones por cubo, cualquier orden
 *      aparece por azar. Por eso va el error tipico en cada fila.
 *
 * SE MIDE CADA FACTOR CONTRA SU PROPIA AUSENCIA, que es lo que decide. Que los setups con
 * barrido ganen dinero no dice nada si los que no lo tienen ganan lo mismo.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Vela } from "../forex/datos";
import { rsi } from "../forex/rsi";
import { atr } from "../forex/multiTf";
import { simular } from "../forex/estructuraValida";
import {
  señales, divergencias, type AjustesDivergencia, type AjustesEntrada,
} from "../forex/divergencia";
import type { AjustesSMC } from "../forex/smc";
import { factores, puntuar, PESOS, type Factores } from "../forex/puntuacion";

function txt(n: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
}
function num(n: string, d: number): number {
  const m = txt(n);
  if (m === undefined) return d;
  const v = Number(m);
  return Number.isFinite(v) ? v : d;
}

interface Op { r: number; score: number; f: Factores }
interface M { n: number; wr: number; exp: number; et: number; pf: number }
function medir(ops: Op[]): M {
  if (!ops.length) return { n: 0, wr: 0, exp: 0, et: 0, pf: 0 };
  const rs = ops.map((o) => o.r);
  const g = rs.filter((x) => x > 0);
  const sp = -rs.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
  const exp = rs.reduce((s, x) => s + x, 0) / rs.length;
  const va = rs.length > 1
    ? rs.reduce((s, x) => s + (x - exp) ** 2, 0) / (rs.length - 1) : 0;
  return {
    n: rs.length, wr: g.length / rs.length, exp, et: Math.sqrt(va / rs.length),
    pf: sp > 0 ? g.reduce((s, x) => s + x, 0) / sp : 0,
  };
}
const fila = (nombre: string, m: M, extra = ""): string =>
  `${nombre.padEnd(30)}${String(m.n).padStart(6)}${(m.wr * 100).toFixed(0).padStart(5)}%` +
  `${m.pf.toFixed(2).padStart(7)}${m.exp.toFixed(3).padStart(9)}±${m.et.toFixed(3)}  ${extra}`;
const CAB =
  `${"".padEnd(30)}${"ops".padStart(6)}${"WR".padStart(6)}${"PF".padStart(7)}${"exp R".padStart(9)}`;

async function main(): Promise<void> {
  const mayorRuta = txt("mayor");
  const menorRuta = txt("menor");
  const listaRuta = process.argv[process.argv.indexOf("--lista") + 1] ?? txt("lista") ?? "";
  if (!mayorRuta || !menorRuta || !existsSync(mayorRuta) || !existsSync(menorRuta)
      || !existsSync(listaRuta)) {
    console.error("Hacen falta --lista L.json --mayor=X.json --menor=Y.json");
    process.exitCode = 1;
    return;
  }
  const costeBps = num("costebps", 0.6);
  const maxVelas = num("maxvelas", 200);

  const lista: string[] = JSON.parse(readFileSync(listaRuta, "utf-8"));
  const gm = JSON.parse(readFileSync(mayorRuta, "utf-8")) as Record<string, Vela[]>;
  const gn = JSON.parse(readFileSync(menorRuta, "utf-8")) as Record<string, Vela[]>;

  const DIV: AjustesDivergencia = {
    periodoRsi: 14, confirmacion: 2, umbralAlto: 70,
    minSeparacion: 3, maxSeparacion: 60,
    // SIN exigirla: la divergencia limpia pasa a ser un FACTOR que puntua, no un requisito.
    // Si fuera requisito no se podria medir cuanto aporta.
    exigirFueraDelCanal: false,
  };
  const zona: AjustesSMC = {
    minHueco: 0.2, minEmpuje: 1, vigencia: 60, esperaBloque: 20, colchon: 0.1,
    objetivoR: 2, radioLiquidez: 0.5, toquesLiquidez: 3, memoriaHuecos: 50,
  };
  const ENT: AjustesEntrada = {
    zona, esperaZona: 40, esperaEntrada: 60, colchon: 0.1,
    stop: "ZONA", objetivo: "LIQUIDEZ", objetivoR: 2, rrMinimo: 1, minRiesgoAtr: 0.5,
  };

  const ops: Op[] = [];
  for (const s of lista) {
    const may = gm[s];
    const men = gn[s];
    if (!may || !men || may.length < 300 || men.length < 300) continue;
    const r = rsi(may.map((v) => v.c), DIV.periodoRsi);
    const aMay = atr(may, 14);
    const aMen = atr(men, 14);
    const ds = divergencias(may, r, DIV);
    const ss = señales(may, r, men, aMen, DIV, ENT);

    // Cada señal se casa con su divergencia: la ultima confirmada antes de la entrada.
    const pasoMayor = may.length > 1 ? may[1]!.t - may[0]!.t : 900;
    for (const x of ss) {
      const tEntrada = men[x.i]!.t;
      const d = [...ds].reverse().find(
        (q) => may[q.i] != null && may[q.i]!.t + pasoMayor <= tEntrada,
      );
      if (!d) continue;
      const res = simular(men, x, (x.entrada * costeBps) / 10_000, maxVelas);
      if (!res) continue;
      const f = factores(may, aMay, d, x.rr, tEntrada);
      ops.push({ r: res.r, score: puntuar(f), f });
    }
  }

  if (ops.length < 50) {
    console.log(`Solo ${ops.length} operaciones. No hay con que medir.`);
    return;
  }
  console.log(`${ops.length} operaciones · coste ${costeBps} pb\n`);

  // ---- 1. ¿CRECE LA ESPERANZA CON EL SCORE? -------------------------------------------------
  console.log("POR SCORE (si puntuar sirve, esto tiene que subir de forma ordenada)");
  console.log(CAB);
  console.log("-".repeat(72));
  const cubos = new Map<number, Op[]>();
  for (const o of ops) {
    const k = Math.min(10, Math.max(0, o.score));
    cubos.set(k, [...(cubos.get(k) ?? []), o]);
  }
  for (const k of [...cubos.keys()].sort((a, b) => a - b)) {
    console.log(fila(`score ${k}`, medir(cubos.get(k)!)));
  }

  console.log("\nPOR UMBRAL (operar solo con score >= X)");
  console.log(CAB);
  console.log("-".repeat(72));
  for (const u of [0, 4, 5, 6, 7, 8, 9]) {
    const arriba = ops.filter((o) => o.score >= u);
    if (arriba.length < 20) continue;
    console.log(fila(`>= ${u}`, medir(arriba), `${((arriba.length / ops.length) * 100).toFixed(0)}% de las señales`));
  }

  // ---- 2. CADA FACTOR CONTRA SU AUSENCIA ----------------------------------------------------
  //
  // Es la prueba que decide. Que los setups con barrido ganen no dice nada si los que no lo
  // tienen ganan lo mismo: entonces el barrido no separa, solo acompaña.
  console.log("\nCADA FACTOR CONTRA SU AUSENCIA (la diferencia es lo que aporta)");
  console.log(
    `${"factor".padEnd(20)}${"con".padStart(8)}${"exp".padStart(9)}` +
      `${"sin".padStart(8)}${"exp".padStart(9)}${"diferencia".padStart(14)}`,
  );
  console.log("-".repeat(72));
  for (const k of Object.keys(PESOS) as Array<keyof typeof PESOS>) {
    const con = medir(ops.filter((o) => o.f[k]));
    const sin = medir(ops.filter((o) => !o.f[k]));
    if (con.n < 20 || sin.n < 20) {
      console.log(`${k.padEnd(20)}${String(con.n).padStart(8)}${"".padStart(9)}` +
        `${String(sin.n).padStart(8)}${"".padStart(9)}${"muestra corta".padStart(14)}`);
      continue;
    }
    const dif = con.exp - sin.exp;
    const etDif = Math.sqrt(con.et ** 2 + sin.et ** 2);
    console.log(
      `${k.padEnd(20)}${String(con.n).padStart(8)}${con.exp.toFixed(3).padStart(9)}` +
        `${String(sin.n).padStart(8)}${sin.exp.toFixed(3).padStart(9)}` +
        `${dif.toFixed(3).padStart(9)}±${etDif.toFixed(3)}` +
        `${Math.abs(dif) > 2 * etDif ? "  <-- separa" : ""}`,
    );
  }

  console.log(
    "\nUn factor solo aporta si la diferencia supera dos veces su error. Y puntuar solo sirve si\n" +
      "la esperanza sube de forma ORDENADA con el score: si el cubo de 9 rinde como el de 5, el\n" +
      "umbral no selecciona calidad, solo recorta la muestra.",
  );
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
