/**
 * ¿CUANDO gana el RSI? Año por año, par por par, y que distinguia a las ganadoras.
 *
 *   npm run fx:cuando -- --pares lista.json [--tf=1d]
 *
 * POR QUE
 * -------
 * Todo lo medido hasta ahora era un promedio sobre 15 años y 28 pares. Un promedio plano
 * puede esconder dos cosas distintas:
 *   - que funcionara en una epoca y dejara de funcionar (regimen)
 *   - que funcione siempre bajo una condicion concreta y nunca fuera de ella
 *
 * Las dos son compatibles con "a mi me funcionó" y con "de media no da". Aqui se separan.
 *
 * La segunda parte compara las GANADORAS contra las PERDEDORAS mirando solo lo que se sabia
 * AL ENTRAR. Si alguna caracteristica las separa, ahi hay una condicion utilizable; si
 * ninguna lo hace, es que el resultado no era predecible desde la entrada.
 */
import { readFileSync } from "node:fs";
import { velas, pip, type Vela } from "../forex/datos";
import { rsi, señales, type ReglasRsi } from "../forex/rsi";
import { atr, ema } from "../forex/multiTf";

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Caso {
  par: string;
  año: number;
  r: number;
  /** Lo que se sabia AL ENTRAR, nada mas. */
  rsiEntrada: number;
  /** Volatilidad relativa: ATR dividido por el precio. */
  volRel: number;
  /** Distancia del precio a su EMA200, en multiplos de ATR. Mide "cuan estirado" esta. */
  distEma: number;
  /** Pendiente de la EMA200 en las ultimas 20 velas, normalizada por ATR. */
  pendiente: number;
  direccion: "LARGO" | "CORTO";
}

/**
 * `maxVelas` fuerza el cierre tras N velas.
 *
 * Es lo que permite probar la asimetria largo/corto SIN swap: si la posicion se cierra dentro
 * del mismo dia, el broker no cobra rollover. Y eso separa dos explicaciones que en diario se
 * confunden: si la ventaja de los cortos es del precio, aparece igual; si era carry disfrazado,
 * desaparece.
 */
function simularTrailing(
  v: Vela[],
  i0: number,
  largo: boolean,
  stop: number,
  trailing: number,
  spread: number,
  maxVelas = 0,
): number {
  const entrada = v[i0]!.o + (largo ? spread : -spread);
  let nivel = largo ? entrada - stop : entrada + stop;
  let extremo = entrada;
  let salida: number | null = null;

  for (let j = i0; j < v.length; j += 1) {
    const c = v[j]!;
    if (largo ? c.l <= nivel : c.h >= nivel) {
      salida = nivel;
      break;
    }
    if (maxVelas > 0 && j - i0 >= maxVelas) {
      salida = c.c;
      break;
    }
    if (largo) {
      if (c.h > extremo) extremo = c.h;
      nivel = Math.max(nivel, extremo - stop * trailing);
    } else {
      if (c.l < extremo) extremo = c.l;
      nivel = Math.min(nivel, extremo + stop * trailing);
    }
  }
  if (salida === null) salida = v[v.length - 1]!.c;
  const neta = salida - (largo ? spread : -spread);
  return (largo ? neta - entrada : entrada - neta) / stop;
}

function mediana(v: number[]): number {
  if (!v.length) return 0;
  const o = [...v].sort((a, b) => a - b);
  return o[Math.floor(o.length / 2)]!;
}

/** Compara una caracteristica entre ganadoras y perdedoras. */
function comparar(nombre: string, gana: number[], pierde: number[]): void {
  if (gana.length < 20 || pierde.length < 20) return;
  const mg = mediana(gana);
  const mp = mediana(pierde);
  // Diferencia relativa al rango tipico: si es minima, la caracteristica no separa nada.
  const todos = [...gana, ...pierde].sort((a, b) => a - b);
  const rango = todos[Math.floor(todos.length * 0.9)]! - todos[Math.floor(todos.length * 0.1)]!;
  const sep = rango > 0 ? Math.abs(mg - mp) / rango : 0;
  console.log(
    `  ${nombre.padEnd(22)}gana ${mg.toFixed(3).padStart(9)}   pierde ${mp.toFixed(3).padStart(9)}` +
      `   separacion ${(sep * 100).toFixed(0).padStart(3)}%${sep > 0.15 ? "  <-- MIRAR" : ""}`,
  );
}

async function main(): Promise<void> {
  const tf = (process.argv.find((a) => a.startsWith("--tf="))?.split("=")[1] ?? "1d") as any;
  const spreadPips = Number(process.argv.find((a) => a.startsWith("--spread="))?.split("=")[1] ?? 1.5);
  const stopPips = Number(process.argv.find((a) => a.startsWith("--stop="))?.split("=")[1] ?? 100);
  const pares: string[] = JSON.parse(
    readFileSync(process.argv[process.argv.indexOf("--pares") + 1] ?? "", "utf-8"),
  );
  // 0 = sin tope. Con tope, la operacion cierra dentro del dia y no paga swap.
  const maxVelas = Number(process.argv.find((a) => a.startsWith("--maxvelas="))?.split("=")[1] ?? 0);
  if (maxVelas) console.log(`cierre forzado a ${maxVelas} velas: sin swap
`);

  const reglas: ReglasRsi = { periodo: 14, sobreventa: 30, sobrecompra: 70, esperarCruce: true };
  const casos: Caso[] = [];

  for (const par of pares) {
    let v: Vela[];
    try {
      v = await velas(par, tf);
    } catch {
      continue;
    }
    await dormir(500);
    if (v.length < 300) continue;

    const cierres = v.map((x) => x.c);
    const valoresRsi = rsi(cierres, reglas.periodo);
    const valoresAtr = atr(v, 14);
    const e200 = ema(cierres, 200);
    const pipTam = pip(par);
    const stop = stopPips * pipTam!;

    for (const s of señales(cierres, reglas)) {
      const i0 = s.i + 1;
      if (i0 >= v.length) continue;
      const a = valoresAtr[s.i];
      const e = e200[s.i];
      const eAnt = e200[Math.max(0, s.i - 20)];
      if (a == null || !(a > 0) || e == null || eAnt == null) continue;

      const r = simularTrailing(v, i0, s.direccion === "LARGO", stop, 2, spreadPips * pipTam!, maxVelas);
      casos.push({
        par,
        año: new Date(v[s.i]!.t * 1000).getUTCFullYear(),
        r,
        rsiEntrada: s.rsi,
        volRel: a / v[s.i]!.c,
        distEma: (v[s.i]!.c - e) / a,
        pendiente: (e - eAnt) / a,
        direccion: s.direccion,
      });
    }
  }

  console.log(`${casos.length} operaciones · ${pares.length} pares · ${tf}\n`);

  // --- 1. año por año ---
  console.log("AÑO POR AÑO");
  console.log(`  ${"año".padEnd(7)}${"ops".padStart(6)}${"gana".padStart(7)}${"R media".padStart(10)}${"PF".padStart(8)}`);
  console.log("  " + "-".repeat(40));
  const años = [...new Set(casos.map((c) => c.año))].sort();
  for (const a of años) {
    const l = casos.filter((c) => c.año === a).map((c) => c.r);
    if (l.length < 20) continue;
    const g = l.filter((x) => x > 0);
    const sumaG = g.reduce((s, x) => s + x, 0);
    const sumaP = -l.filter((x) => x <= 0).reduce((s, x) => s + x, 0);
    console.log(
      `  ${String(a).padEnd(7)}${String(l.length).padStart(6)}` +
        `${((g.length / l.length) * 100).toFixed(0).padStart(6)}%` +
        `${(l.reduce((s, x) => s + x, 0) / l.length).toFixed(3).padStart(10)}` +
        `${(sumaP > 0 ? sumaG / sumaP : 0).toFixed(2).padStart(8)}`,
    );
  }

  // --- 2. par por par ---
  console.log("\nPAR POR PAR (solo los que suman positivo)");
  const porPar = [...new Set(casos.map((c) => c.par))]
    .map((p) => {
      const l = casos.filter((c) => c.par === p).map((c) => c.r);
      return { p, n: l.length, total: l.reduce((s, x) => s + x, 0), media: l.reduce((s, x) => s + x, 0) / (l.length || 1) };
    })
    .filter((x) => x.n >= 20)
    .sort((a, b) => b.media - a.media);
  for (const x of porPar.slice(0, 8)) {
    console.log(`  ${x.p.padEnd(10)}${String(x.n).padStart(5)} ops   R media ${x.media.toFixed(3).padStart(8)}`);
  }
  console.log(`  … ${porPar.filter((x) => x.media > 0).length} de ${porPar.length} pares en positivo`);

  // --- 3. que distinguia a las ganadoras ---
  console.log("\nQUE DISTINGUIA A LAS GANADORAS (solo datos conocidos AL ENTRAR)");
  const gana = casos.filter((c) => c.r > 0);
  const pierde = casos.filter((c) => c.r <= 0);
  console.log(`  ${gana.length} ganadoras vs ${pierde.length} perdedoras\n`);
  comparar("RSI de entrada", gana.map((c) => c.rsiEntrada), pierde.map((c) => c.rsiEntrada));
  comparar("volatilidad (ATR/precio)", gana.map((c) => c.volRel), pierde.map((c) => c.volRel));
  comparar("distancia a EMA200", gana.map((c) => c.distEma), pierde.map((c) => c.distEma));
  comparar("pendiente EMA200", gana.map((c) => c.pendiente), pierde.map((c) => c.pendiente));

  const largos = casos.filter((c) => c.direccion === "LARGO");
  const cortos = casos.filter((c) => c.direccion === "CORTO");
  console.log(
    `\n  largos:  ${largos.length} ops · R media ${(largos.reduce((s, c) => s + c.r, 0) / (largos.length || 1)).toFixed(3)}`,
  );
  console.log(
    `  cortos:  ${cortos.length} ops · R media ${(cortos.reduce((s, c) => s + c.r, 0) / (cortos.length || 1)).toFixed(3)}`,
  );
  console.log(
    "\n  'separacion' = cuanto se alejan las medianas respecto al rango tipico. Por debajo del\n" +
      "  15% la caracteristica no distingue nada y no sirve como filtro.",
  );

  // --- ¿la asimetria largo/corto es estructural o de este regimen? ---
  //
  // Que los cortos ganen y los largos pierdan puede ser una propiedad del RSI... o puede ser
  // simplemente que el dolar subio durante el periodo. Se separa mirando si aguanta en los tres
  // tramos: una propiedad estructural aparece en todos; un regimen, en uno solo.
  console.log("\nLA ASIMETRIA LARGO/CORTO, POR PERIODO");
  console.log(`  ${"periodo".padEnd(14)}${"largos".padStart(20)}${"cortos".padStart(20)}`);
  console.log("  " + "-".repeat(54));
  const tramos: Array<[string, (a: number) => boolean]> = [
    ["2012-2016", (a: number) => a <= 2016],
    ["2017-2021", (a: number) => a >= 2017 && a <= 2021],
    ["2022-2026", (a: number) => a >= 2022],
  ];
  const mm = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0);
  for (const [nombre, dentro] of tramos) {
    const largosT = casos.filter((c) => dentro(c.año) && c.direccion === "LARGO").map((c) => c.r);
    const cortosT = casos.filter((c) => dentro(c.año) && c.direccion === "CORTO").map((c) => c.r);
    console.log(
      `  ${nombre.padEnd(14)}${(mm(largosT).toFixed(3) + " (" + largosT.length + ")").padStart(20)}` +
        `${(mm(cortosT).toFixed(3) + " (" + cortosT.length + ")").padStart(20)}`,
    );
  }

}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
